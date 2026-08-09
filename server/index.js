import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { handleMessages } from "./messages.js";
import { handleFetchPage } from "./fetchPage.js";
import { clientIp, isLocalIp, logEvent, renderStatsHtml, summarize } from "./activity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");

/* Fail at boot rather than at 2am mid-recipe. A missing key here is
 * always a misconfigured deploy, never a runtime condition.
 * ANTHROPIC_API_KEY is exempt under ANTHROPIC_AUTH_MODE=oauth (local-dev-only
 * — see server/messages.js), where the ant CLI supplies credentials instead. */
const requiredEnvVars = [];
if (process.env.ANTHROPIC_AUTH_MODE !== "oauth") requiredEnvVars.push("ANTHROPIC_API_KEY");
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.set("trust proxy", 1); // Railway terminates TLS upstream
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/messages", handleMessages);
app.get("/api/fetch", handleFetchPage);

/* Usage/outcome logging only — never recipe content. The client
 * reports one of these allowlisted shapes after a URL fetch or a full
 * conversion; see src/App.jsx's track()/classifyError(). Local/dev
 * hits are dropped rather than logged, so everything in the log is a
 * real visitor. */
const TRACK_TYPES = new Set(["url_fetch", "convert"]);
const TRACK_MODES = new Set(["url", "paste"]);
const TRACK_OUTCOMES = new Set(["success", "failure"]);
const TRACK_STAGES = new Set(["analysis", "structure"]);
const KIND_RE = /^[a-z0-9_]{1,40}$/;

app.post("/api/track", (req, res) => {
  const ip = clientIp(req);
  if (isLocalIp(ip)) return res.status(204).end();

  const { type, mode, outcome, stage, kind } = req.body || {};
  if (!TRACK_TYPES.has(type) || !TRACK_OUTCOMES.has(outcome)) return res.status(400).end();
  if (type === "convert" && !TRACK_MODES.has(mode)) return res.status(400).end();
  if (outcome === "failure") {
    if (type === "convert" && !TRACK_STAGES.has(stage)) return res.status(400).end();
    if (kind !== undefined && !KIND_RE.test(kind)) return res.status(400).end();
  }

  const event = { type, ip, outcome };
  if (type === "convert") event.mode = mode;
  if (outcome === "failure") {
    if (type === "convert") event.stage = stage;
    if (kind !== undefined) event.kind = kind;
  }
  logEvent(event);
  res.status(204).end();
});

/* Gated by a shared-secret query param rather than left open, since the
 * summary includes visitor IP addresses. Returns 404 (not 401/403) for
 * both "no key configured" and "wrong key" so the endpoint's existence
 * isn't distinguishable from any other 404. */
const STATS_KEY = process.env.STATS_KEY;
app.get("/api/stats", (req, res) => {
  if (!STATS_KEY || req.query.key !== STATS_KEY) return res.status(404).end();
  res.type("html").send(renderStatsHtml(summarize()));
});

// Landing page hit. Registered ahead of express.static, which would
// otherwise serve dist/index.html for "/" itself (its default "index"
// behavior for directory requests) before this ever ran.
app.get("/", (req, res) => {
  const ip = clientIp(req);
  if (!isLocalIp(ip)) logEvent({ type: "pageview", ip });
  res.sendFile(path.join(dist, "index.html"));
});

app.use(express.static(dist));
// SPA fallback: anything not matched above and not under /api gets index.html
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`recipe-grid listening on :${port}`));
