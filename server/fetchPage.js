import dns from "node:dns/promises";
import net from "node:net";

/* Server-side fetch of a recipe page. CORS was never the server's
 * problem, so this just works — the value here is the guarding.
 *
 * Ported from the Worker draft, with one change: the hostname string
 * check is replaced by resolving the host and testing the resulting
 * IPs. A string check passes evil.example.com straight through when
 * it resolves to 10.0.0.5. Redirects are followed manually so every
 * hop gets the same treatment; redirect: "follow" would let hop two
 * land anywhere it liked. */

const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

const UA = "Mozilla/5.0 (compatible; RecipeGridBot/1.0)";

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||           // link-local, incl. cloud metadata at 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      a >= 224                              // multicast and reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
    // ::ffff:10.0.0.1 — IPv4 wearing an IPv6 hat
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIP(mapped[1]);
  }
  return false;
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) throw new Error("That address isn't allowed.");
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Couldn't resolve that hostname.");
  }
  if (records.some((r) => isPrivateIP(r.address))) {
    throw new Error("That host resolves to a private address, which isn't allowed.");
  }
}

function parseTarget(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a valid URL.");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http and https URLs are supported.");
  return parsed;
}

export async function handleFetchPage(req, res) {
  const raw = req.query.url;
  if (!raw) return res.status(400).type("text/plain").send("Missing url parameter.");

  let current;
  try {
    current = parseTarget(raw);
  } catch (e) {
    return res.status(400).type("text/plain").send(e.message);
  }

  let upstream;
  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) {
      return res.status(502).type("text/plain").send("That page redirected too many times.");
    }
    try {
      await assertPublicHost(current.hostname);
    } catch (e) {
      return res.status(400).type("text/plain").send(e.message);
    }

    try {
      upstream = await fetch(current.toString(), {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const why = e.name === "TimeoutError" ? "took too long to respond" : `couldn't be reached (${e.message})`;
      return res.status(502).type("text/plain").send(`That page ${why}.`);
    }

    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location")) {
      try {
        current = parseTarget(new URL(upstream.headers.get("location"), current).toString());
      } catch (e) {
        return res.status(502).type("text/plain").send(`That page redirected somewhere invalid: ${e.message}`);
      }
      continue;
    }
    break;
  }

  if (!upstream.ok) {
    return res.status(502).type("text/plain")
      .send(`That page returned an error (${upstream.status}). Check the URL, or paste the recipe text instead.`);
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    return res.status(415).type("text/plain").send("That URL isn't an HTML page.");
  }

  const html = await upstream.text();
  res.type("text/html; charset=utf-8").send(html.length > MAX_BYTES ? html.slice(0, MAX_BYTES) : html);
}
