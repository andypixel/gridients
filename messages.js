/* Proxy for the Anthropic Messages API.
 *
 * The request body is REBUILT here from an allowlist rather than
 * forwarded. Forwarding whatever the client sent would make this an
 * unmetered Anthropic account for anyone holding a session cookie —
 * they could swap in any model, any max_tokens, any tool config.
 * Only system/messages/max_tokens cross the boundary, and max_tokens
 * is clamped. */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 8000);
const DAILY_CALL_LIMIT = Number(process.env.DAILY_CALL_LIMIT || 300);

/* Blast-radius limit, not a fairness mechanism. In-memory and
 * per-process, so it resets on deploy and on wake from sleep —
 * which is fine for its actual job: capping the damage if the
 * session cookie ever leaks or a loop in the client runs away. */
let day = new Date().toISOString().slice(0, 10);
let callsToday = 0;

function underDailyCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    callsToday = 0;
  }
  return callsToday < DAILY_CALL_LIMIT;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validate(body) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  for (const m of body.messages) {
    if (m?.role !== "user" && m?.role !== "assistant") return "each message needs role user or assistant";
    if (typeof m.content !== "string" || !m.content.trim()) return "each message needs non-empty string content";
  }
  if (body.system != null && typeof body.system !== "string") return "system must be a string";
  return null;
}

/* Retries on the statuses that are genuinely transient: 429 (rate
 * limit), 529 (Anthropic overloaded), and 5xx. Honors retry-after
 * when the API sends one, since a guessed backoff that undershoots
 * just burns another attempt. */
async function callAnthropic(payload, attempt = 0) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
  if (retryable && attempt < 4) {
    const header = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(header) && header > 0
      ? header * 1000
      : Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 400; // jitter: two windows shouldn't retry in lockstep
    await sleep(backoff);
    return callAnthropic(payload, attempt + 1);
  }
  return res;
}

export async function handleMessages(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY is not configured on the server." } });
  }
  if (!underDailyCap()) {
    return res.status(429).json({
      error: { message: `Daily cap of ${DAILY_CALL_LIMIT} model calls reached. It resets at UTC midnight.` },
    });
  }

  const problem = validate(req.body);
  if (problem) return res.status(400).json({ error: { message: problem } });

  const requested = Number(req.body.max_tokens) || MAX_OUTPUT_TOKENS;
  const payload = {
    model: MODEL,
    max_tokens: Math.max(256, Math.min(requested, MAX_OUTPUT_TOKENS)),
    messages: req.body.messages,
  };
  if (req.body.system) payload.system = req.body.system;

  callsToday++;

  let upstream;
  try {
    upstream = await callAnthropic(payload);
  } catch (e) {
    return res.status(502).json({ error: { message: `Couldn't reach the Anthropic API: ${e.message}` } });
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    // Pass the upstream status through so the client's own 429 handling
    // still sees a 429, but never echo anything that could carry key material.
    return res.status(upstream.status).json({
      error: { message: data?.error?.message || `Anthropic returned ${upstream.status}.` },
    });
  }

  // Only what the client actually reads. usage is handy in the server log.
  console.log(`[messages] in=${data.usage?.input_tokens} out=${data.usage?.output_tokens} stop=${data.stop_reason} (${callsToday}/${DAILY_CALL_LIMIT} today)`);
  res.json({ content: data.content, stop_reason: data.stop_reason });
}
