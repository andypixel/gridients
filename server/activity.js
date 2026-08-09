/* Rudimentary usage logging: counts and outcomes only, never recipe
 * content. Every event is a small allowlisted shape (see index.js's
 * /api/track validation) appended as one JSON line — both to a local
 * file (read back by /api/stats to build the summary) and to
 * console.log (so `railway logs` shows activity in real time without
 * needing to hit the stats page).
 *
 * The log file lives on the container's local disk. No volume is
 * configured, so it resets on every redeploy — acceptable for a
 * personal tool used a few times a week; see CLAUDE.md. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "data");
const LOG_FILE = path.join(LOG_DIR, "activity.log");

/* Local dev (npm run dev's vite proxy, or npm start hit from the same
 * machine) always arrives as loopback. Filtering it out here means
 * every other IP in the log is a real visitor. */
export function isLocalIp(ip) {
  if (!ip) return true;
  const v = ip.replace(/^::ffff:/, "");
  return v === "127.0.0.1" || v === "::1" || v === "localhost";
}

export function clientIp(req) {
  return req.ip;
}

export function logEvent(fields) {
  const event = { ts: new Date().toISOString(), ...fields };
  const line = JSON.stringify(event);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) {
    console.error(`[activity] failed to persist event: ${e.message}`);
  }
  console.log(`[activity] ${line}`);
}

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function summarize() {
  const events = readEvents();

  const summary = {
    totalEvents: events.length,
    since: events[0]?.ts || null,
    until: events[events.length - 1]?.ts || null,
    pageviews: { total: 0 },
    urlFetch: { success: 0, failure: 0, byKind: {} },
    convert: {
      url: { success: 0, failure: 0 },
      paste: { success: 0, failure: 0 },
      byStage: {},
      byKind: {},
    },
    byIp: {},
  };

  for (const e of events) {
    const ip = e.ip || "unknown";
    if (!summary.byIp[ip]) summary.byIp[ip] = { pageviews: 0, urlFetch: 0, convert: 0, lastSeen: e.ts };
    const ipStats = summary.byIp[ip];
    ipStats.lastSeen = e.ts;

    if (e.type === "pageview") {
      summary.pageviews.total += 1;
      ipStats.pageviews += 1;
    } else if (e.type === "url_fetch") {
      if (e.outcome === "success" || e.outcome === "failure") summary.urlFetch[e.outcome] += 1;
      ipStats.urlFetch += 1;
      if (e.outcome === "failure" && e.kind) {
        summary.urlFetch.byKind[e.kind] = (summary.urlFetch.byKind[e.kind] || 0) + 1;
      }
    } else if (e.type === "convert") {
      const bucket = summary.convert[e.mode];
      if (bucket && (e.outcome === "success" || e.outcome === "failure")) bucket[e.outcome] += 1;
      ipStats.convert += 1;
      if (e.outcome === "failure") {
        if (e.stage) summary.convert.byStage[e.stage] = (summary.convert.byStage[e.stage] || 0) + 1;
        if (e.kind) summary.convert.byKind[e.kind] = (summary.convert.byKind[e.kind] || 0) + 1;
      }
    }
  }

  return summary;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function countTable(rows, headers) {
  if (!rows.length) return "<p class=\"muted\">none</p>";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderStatsHtml(summary) {
  const ipRows = Object.entries(summary.byIp)
    .sort((a, b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen))
    .map(([ip, s]) => [ip, s.pageviews, s.urlFetch, s.convert, s.lastSeen]);

  const kindRows = (byKind) => Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n]);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>gridients activity</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 2rem; color: #222; }
  h1 { font-size: 1.1rem; }
  h2 { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid #ccc; padding-bottom: .25rem; }
  table { border-collapse: collapse; margin: .5rem 0 1rem; }
  th, td { border: 1px solid #ccc; padding: .3rem .6rem; text-align: left; }
  th { background: #f4f4f4; }
  .muted { color: #888; }
  .stat { display: inline-block; margin-right: 2rem; }
  .stat b { font-size: 1.3rem; display: block; }
</style>
</head>
<body>
<h1>gridients activity</h1>
<p class="muted">${summary.totalEvents} events logged, ${summary.since ? `${esc(summary.since)} → ${esc(summary.until)}` : "no data yet"}. Local/dev sessions omitted.</p>

<h2>Landing page hits</h2>
<div class="stat"><b>${summary.pageviews.total}</b>total</div>

<h2>URL fetch</h2>
<div class="stat"><b>${summary.urlFetch.success}</b>success</div>
<div class="stat"><b>${summary.urlFetch.failure}</b>failure</div>
${countTable(kindRows(summary.urlFetch.byKind), ["failure kind", "count"])}

<h2>Conversions</h2>
<div class="stat"><b>${summary.convert.url.success}</b>URL success</div>
<div class="stat"><b>${summary.convert.url.failure}</b>URL failure</div>
<div class="stat"><b>${summary.convert.paste.success}</b>paste success</div>
<div class="stat"><b>${summary.convert.paste.failure}</b>paste failure</div>
${countTable(kindRows(summary.convert.byStage), ["failed at stage", "count"])}
${countTable(kindRows(summary.convert.byKind), ["failure kind", "count"])}

<h2>By IP</h2>
${countTable(ipRows, ["ip", "pageviews", "url fetches", "conversions", "last seen"])}
</body>
</html>`;
}
