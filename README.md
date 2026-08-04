# recipe-grid

Recipe text → Cooking for Engineers–style assembly grid.

One Railway service does everything: Express serves the built frontend
and exposes three API routes on the same origin. Same origin means no
CORS anywhere, and no separate Worker deploy.

```
index.html            Vite entry
src/App.jsx           the whole app (ported from the artifact, ~unchanged)
src/LoginGate.jsx     password screen
src/main.jsx          React root
server/index.js       Express: routes + static + SPA fallback
server/auth.js        shared password → signed cookie
server/messages.js    Anthropic proxy (allowlist, clamp, backoff, daily cap)
server/fetchPage.js   URL fetch proxy (SSRF guards)
```

## Local dev

```bash
cp .env.example .env      # fill in ANTHROPIC_API_KEY, APP_PASSWORD, SESSION_SECRET
npm install
npm run dev               # API on :3000, client on :5173 (proxies /api → :3000)
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open http://localhost:5173. Keep `COOKIE_SECURE=false` locally — dev is
plain http, and a `Secure` cookie would never be stored.

## Deploy to Railway

1. Push to GitHub, then **New Project → Deploy from GitHub repo** in the
   same Railway project you already have. A second service in an
   existing project shares your $5 usage credit rather than adding a
   subscription.
2. Under **Variables**, set:
   - `ANTHROPIC_API_KEY`
   - `APP_PASSWORD`
   - `SESSION_SECRET`

   Leave `COOKIE_SECURE` unset. **Do not set `NODE_ENV=production`** —
   Nixpacks would then skip devDependencies, vite wouldn't install, and
   the build would fail.
3. **Settings → Networking → Generate Domain.**
4. Optional, and worth it here: **Settings → enable app sleeping.** At
   twice-a-week usage this drops consumption to near zero in exchange
   for a few seconds of cold start on first request.

`railway.json` already pins the build command, start command, and a
health check at `/api/health`.

## What the server enforces

- **Every `/api` route requires the session cookie.** `LoginGate` decides
  what to render; the server decides what's permitted. Bypassing the
  component in devtools yields a UI whose every button 401s.
- **The Messages payload is rebuilt server-side from an allowlist.**
  Only `system`, `messages`, and `max_tokens` cross over, and
  `max_tokens` is clamped to `MAX_OUTPUT_TOKENS`. Forwarding the client's
  body verbatim would hand anyone with a cookie an unmetered Anthropic
  account with their choice of model.
- **Retries with jittered exponential backoff** on 429/529/5xx, honoring
  `retry-after`. The client's own 429 retry still sits on top as a
  second layer.
- **A daily call cap** (`DAILY_CALL_LIMIT`, default 300). In-memory and
  per-process, so it resets on deploy — it's a blast-radius limit for a
  leaked cookie or a runaway loop, not a quota system.
- **SSRF guards on `/api/fetch`**: http/https only, hostnames resolved
  and checked against private ranges (including cloud metadata at
  169.254.169.254), redirects followed manually so every hop is
  re-validated, 15s timeout, 3 MB cap, HTML content-type required.

## Knobs

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | |
| `MAX_OUTPUT_TOKENS` | `8000` | Server-side ceiling |
| `DAILY_CALL_LIMIT` | `300` | Model calls per UTC day |
| `COOKIE_SECURE` | secure on | Set `false` for local http |

`MAX_TOKENS` in `src/App.jsx` (currently 4000) is what the client asks
for. Note that `INGREDIENT_LINES_PER_CALL = 12` exists solely because
the sandbox pinned output at 1000 tokens; it should go up substantially
now, but that's a pipeline change, not a deployment one.
