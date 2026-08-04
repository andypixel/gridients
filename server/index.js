import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";

import { requireAuth, isAuthed, login, logout } from "./auth.js";
import { handleMessages } from "./messages.js";
import { handleFetchPage } from "./fetchPage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "..", "dist");

/* Fail at boot rather than at 2am mid-recipe. A missing key here is
 * always a misconfigured deploy, never a runtime condition.
 * ANTHROPIC_API_KEY is exempt under ANTHROPIC_AUTH_MODE=oauth (local-dev-only
 * — see server/messages.js), where the ant CLI supplies credentials instead. */
const requiredEnvVars = ["APP_PASSWORD", "SESSION_SECRET"];
if (process.env.ANTHROPIC_AUTH_MODE !== "oauth") requiredEnvVars.push("ANTHROPIC_API_KEY");
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = express();
app.set("trust proxy", 1); // Railway terminates TLS upstream; without this, secure cookies misbehave
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/session", (req, res) => res.json({ authed: isAuthed(req) }));
app.post("/api/login", login);
app.post("/api/logout", logout);

app.post("/api/messages", requireAuth, handleMessages);
app.get("/api/fetch", requireAuth, handleFetchPage);

app.use(express.static(dist));
// SPA fallback: anything not matched above and not under /api gets index.html
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`recipe-grid listening on :${port}`));
