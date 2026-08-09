# gridients

Converts pasted recipe text into a Cooking for Engineers–style assembly
grid: ingredients are rows, operations are columns, rowspan reflects how
many ingredients a step combines, and the whole thing reads left to
right as an assembly sequence.

Personal tool. One or two users, a few conversions a week, unlisted URL,
no login gate — security by obscurity is an accepted tradeoff here.
Optimize for clarity over scale — there is no traffic to engineer for.

## Layout

```
index.html             Vite entry — loads src/main.jsx as a module
src/App.jsx            entire client app + pipeline (~1200 lines, single file by design)
src/main.jsx           React root
server/index.js        Express: routes, static serving, SPA fallback
server/messages.js     Anthropic Messages proxy
server/fetchPage.js    URL fetch proxy with SSRF guards
server/activity.js     Usage logging (counts/outcomes only) — see Logging below
```

Frontend and API are the same origin — Express serves `dist/` and
`/api/*`. That is why there is no CORS configuration anywhere, and why
there is no separate Cloudflare Worker despite an early draft of one.

## Pipeline (all in src/App.jsx)

1. `normalizeChars` — NFKC, folds vulgar fractions and nbsp. Deterministic.
2. `numberLines` — every line gets an index so the model cites rather than retypes.
3. **Pass 1a** `STEP_PROMPT` — segment directions into steps.
4. **Pass 1b** `INGREDIENT_PROMPT` — extract ingredients, cross-referenced
   against the finalized steps. Windowed into parallel bounded calls for
   large recipes (see token budget below).
5. **Pass 1c** `ADDITIONS_PROMPT` — reconciliation for ingredients that
   appear only in the directions and were missed by a bounded window.
6. **Pass 2** `STRUCTURE_PROMPT` — build the nested preparation tree.
7. `layoutTree` → `buildGrid` → `exportHTML` — **purely deterministic, no
   model involvement.** Keep it that way.

Between every model call and the data it produces sits verification:
`verifySteps` / `verifyIngredients` check that each claim traces back to
its cited source lines by word coverage. The model is allowed to
rewrite; nothing it writes is taken on trust. Failed verification feeds
the specific errors back for one correction attempt, then throws.

## Invariants — do not "clean these up"

- **`server/messages.js` rebuilds the Anthropic payload from an
  allowlist.** It does not forward the client's body. Forwarding would
  make this an unmetered Anthropic account with arbitrary model choice
  for anyone hitting the URL. Only `system`, `messages`, and
  `max_tokens` cross, and `max_tokens` is clamped.
- **Never set `NODE_ENV=production` on Railway.** Nixpacks would then
  skip devDependencies, which removes vite and breaks the build.
- **`server/fetchPage.js` resolves hostnames and checks resulting IPs**
  rather than string-matching the hostname, and follows redirects
  manually so every hop is re-validated. A string check passes
  `evil.example.com` when it resolves to `10.0.0.5`; `redirect: "follow"`
  lets hop two land anywhere.
- **`asAssistantTurn` guards against empty content.** A truncated turn
  can produce an empty string, and the API rejects empty message
  content — so a retry meant to recover would fail with its own 400.
- **On truncation, the retry does not feed the truncated text back in**
  (`callWithinBudget`). Re-presenting garbled output as the model's own
  prior turn primes it to continue the repetition loop rather than break
  out.
- **Divided ingredients get one cell each.** Structural splitting is a
  requirement of the chart format, not a UX preference.
- **The layout renderer stays deterministic.** No model calls below
  `layoutTree`.

## Logging

Rudimentary usage/outcome tracking, not analytics: landing page hits,
URL-fetch success/failure, and conversion success/failure by input mode
(URL vs. paste) with a coarse failure stage and kind. **Never recipe
content** — `src/App.jsx`'s `classifyError` sorts thrown errors into a
kind by matching fixed substrings baked into the pipeline's own error
messages, never by forwarding the message itself, since verification
errors can quote ingredient/step text.

- Client calls `POST /api/track` (fire-and-forget, see `track()` in
  `src/App.jsx`) after a URL fetch and after a full conversion.
  `server/index.js` validates the body against a small allowlist before
  logging — same rationale as the Anthropic payload allowlist above.
- The landing page hit itself is logged server-side, in `GET /`
  (registered ahead of `express.static`, which otherwise serves
  `dist/index.html` for `/` on its own before any handler after it
  runs) — not by the client, so one less thing that can fail to fire.
- `server/activity.js` appends one JSON line per event to
  `data/activity.log` (gitignored, local disk — **resets on every
  Railway redeploy**, no volume is configured) and also `console.log`s
  it, so `railway logs` shows activity without needing the stats page.
- **Local/dev sessions are dropped, not logged as a separate category.**
  `isLocalIp` filters loopback addresses (`npm run dev`'s vite proxy and
  `npm start` hit from the same machine both arrive as `127.0.0.1`/`::1`).
  Everything that reaches the log is a real visitor.
- `GET /api/stats?key=...` renders a plain-HTML summary (counts,
  failure breakdowns, and a by-IP table — the mechanism for telling your
  own usage apart from a friend's). Gated by `STATS_KEY`; both a missing
  key and a wrong one return a bare 404, since the summary includes
  visitor IPs.

## Token budget — known open item

`INGREDIENT_LINES_PER_CALL = 12` and `SINGLE_CALL_CEILING = 16` exist
solely because the original Claude.ai artifact sandbox pinned
`max_tokens` at 1000. Production now allows far more (`MAX_TOKENS = 4000`
client-side, `MAX_OUTPUT_TOKENS = 8000` server ceiling), so these
thresholds are doing work they no longer need to do and should rise
substantially.

This is deliberately not yet changed: the migration should first be
verified to produce output identical to the artifact, so any regression
has exactly one possible cause. Do not raise these as an incidental
part of another change.

The windowing machinery itself should stay even after the thresholds
rise — it remains a genuine fallback for an unusually large recipe.

## Environment

Required: `ANTHROPIC_API_KEY` (unless `ANTHROPIC_AUTH_MODE=oauth`). The
server exits at boot if it's missing — a missing key is always a
misconfigured deploy, never a runtime condition.

Optional: `ANTHROPIC_MODEL`, `MAX_OUTPUT_TOKENS`, `DAILY_CALL_LIMIT`,
`PORT`, `ANTHROPIC_AUTH_MODE`, `STATS_KEY` (see Logging below — leave
unset to keep `/api/stats` disabled).

**`ANTHROPIC_AUTH_MODE=oauth` is local-dev-only.** When set,
`server/messages.js` authenticates via the `ant` CLI
(`ant auth print-credentials --access-token`, sent as
`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`) instead of
`ANTHROPIC_API_KEY` — dev/testing usage then draws from whatever Claude
subscription `ant auth login` is signed into, separate from the metered
key the deployed app uses. Requires the `ant` CLI installed and logged
in. **Never set this in Railway** — production always authenticates
with `ANTHROPIC_API_KEY`, and the boot check still requires it whenever
this var is unset.

Never commit `.env`. Never log request bodies from `/api/messages` —
they contain full recipe text and prompts; token counts and stop reasons
are the useful part and are what's logged from that endpoint. See
Logging below for the separate, deliberately content-free usage log.

## Commands

```bash
npm run dev     # API :3000 + vite :5173 (proxies /api → :3000)
npm run build   # vite build → dist/
npm start       # production: Express serves dist/ and /api/*
```

## Deploy

Railway, one service, Nixpacks. `railway.json` pins build command, start
command, and a `/api/health` check. App sleeping is appropriate at this
usage level.

## Roadmap

1. ~~Hosting stack~~ — decided: Railway, single service, same origin.
2. ~~Migrate off single-JSX artifact~~ — done.
3. **Verify parity with the artifact, then raise the token thresholds.** ← next
4. CI: build check on PR, deploy on merge to main.