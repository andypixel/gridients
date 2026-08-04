import crypto from "node:crypto";

/* A single shared password, exchanged for a stateless signed cookie.
 * No user table, no session store — with two users and one secret
 * there is nothing to store. The cookie is an HMAC over an expiry
 * timestamp, so the server can validate it without remembering it. */

const COOKIE = "rg_session";
const TTL_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sign(expiresAt) {
  const mac = crypto.createHmac("sha256", secret()).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${mac}`;
}

function valid(token) {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const [expiresAt, mac] = token.split(".");
  if (!/^\d+$/.test(expiresAt) || Number(expiresAt) < Date.now()) return false;
  const expected = crypto.createHmac("sha256", secret()).update(expiresAt).digest("hex");
  // Both sides are fixed-length hex, so timingSafeEqual won't throw on length.
  if (mac.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

/* Compare against the configured password without leaking its length
 * or matched-prefix through timing. Hashing both sides first gives
 * equal-length inputs for free. */
function passwordMatches(supplied) {
  const real = process.env.APP_PASSWORD;
  if (!real) throw new Error("APP_PASSWORD is not set");
  const a = crypto.createHash("sha256").update(String(supplied ?? "")).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function isAuthed(req) {
  return valid(readCookie(req));
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "Not signed in." });
}

export function login(req, res) {
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).json({ error: "That password isn't right." });
  }
  const expiresAt = Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(COOKIE, sign(expiresAt), {
    httpOnly: true,
    sameSite: "lax",
    // Deliberately NOT keyed off NODE_ENV: setting NODE_ENV=production
    // in Railway would make the build skip devDependencies and vite
    // would vanish. Opt out explicitly for local http instead.
    secure: process.env.COOKIE_SECURE !== "false",
    maxAge: TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  });
  res.json({ ok: true });
}

export function logout(_req, res) {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}
