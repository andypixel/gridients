import React, { useState, useMemo, useRef, useEffect } from "react";

/* ================================================================== *
 * PRE-PASS (deterministic, lossless)
 * NFKC folds vulgar fractions and non-breaking spaces. Then the text
 * is numbered by line so the model can point at things instead of
 * retyping them.
 * ================================================================== */

function normalizeChars(text) {
  return text
    .normalize("NFKC")
    .replace(/[\u2044\u2215]/g, "/")
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ");
}

function numberLines(text) {
  return normalizeChars(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/* ================================================================== *
 * URL ACQUISITION (deterministic, browser-only)
 *
 * This doesn't feed the model anything new — it just gives the
 * existing pipeline pasted-text-shaped input from a page instead of
 * the clipboard. Two paths:
 *
 * 1. Most recipe sites embed schema.org/Recipe as JSON-LD for SEO.
 *    When present, it's already clean, itemized data — reading it
 *    sidesteps the whole messy-paste problem this app exists to
 *    solve. Preferred whenever it's there.
 * 2. If it isn't, fall back to the page's plain text and hand that
 *    to the same pipeline that already handles messy pastes — it's
 *    noisier (nav, related posts, comments) but the analysis pass's
 *    furniture-dropping was built for exactly this.
 *
 * Fetching goes through /api/fetch on our own server. A direct
 * browser fetch() to an arbitrary site fails for most
 * of the web — recipe sites generally don't set CORS headers for
 * arbitrary origins, and this is unrelated to anything the app can
 * fix client-side. A real deployment would fetch server-side (a
 * Worker route, say) where CORS doesn't apply; here, failure is
 * caught and surfaced as an explanation rather than a stack trace.
 * ================================================================== */

function flattenInstructions(instr, depth = 0) {
  if (!instr || depth > 4) return [];
  if (typeof instr === "string") return instr.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(instr)) return instr.flatMap((i) => flattenInstructions(i, depth + 1));
  if (typeof instr === "object") {
    if (instr.itemListElement) return flattenInstructions(instr.itemListElement, depth + 1);
    if (instr.text) return flattenInstructions(instr.text, depth + 1);
    if (instr.name) return flattenInstructions(instr.name, depth + 1);
  }
  return [];
}

function findRecipeNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object") {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    if (types.some((t) => typeof t === "string" && t.toLowerCase() === "recipe")) return node;
    for (const key of Object.keys(node)) {
      const found = findRecipeNode(node[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/* Returns {title, ingredients, steps} or null if no usable Recipe
 * JSON-LD is present. */
function extractJsonLdRecipe(doc) {
  const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
  for (const s of scripts) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
    const recipe = findRecipeNode(data);
    if (!recipe) continue;
    const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : recipe.ingredients || [])
      .map((s) => String(s).trim()).filter(Boolean);
    const steps = flattenInstructions(recipe.recipeInstructions).filter(Boolean);
    if (ingredients.length >= 2 && steps.length >= 1) {
      return { title: String(recipe.name || "").trim(), ingredients, steps };
    }
  }
  return null;
}

/* Fallback: flatten the page's visible text. textContent works on a
 * detached document (no layout needed, unlike innerText); block-level
 * closing tags are given a newline first so paragraphs don't run
 * together into one word. */
function extractVisibleText(doc) {
  const clone = doc.cloneNode(true);
  clone.querySelectorAll("script,style,noscript,svg,iframe,template,nav,footer,form,button,header").forEach((el) => el.remove());
  const html = (clone.body ? clone.body.innerHTML : clone.innerHTML) || "";
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "$&\n");
  const decoder = doc.createElement("div");
  decoder.innerHTML = withBreaks;
  return (decoder.textContent || "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

function buildPastedText({ title, ingredients, steps }) {
  const parts = [];
  if (title) parts.push(title, "");
  parts.push(...ingredients, "", "Instructions", ...steps);
  return parts.join("\n");
}

async function fetchRecipeFromUrl(rawUrl) {
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  let res;
  try {
    res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { credentials: "same-origin" });
  } catch {
    throw new Error("Couldn't reach the server to fetch that page. Check your connection and try again, or paste the recipe text instead.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `That page couldn't be fetched (${res.status}). Check the URL, or paste the recipe text instead.`);
  }
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const structured = extractJsonLdRecipe(doc);
  if (structured) return { text: buildPastedText(structured), method: "the page's structured recipe data" };

  const text = extractVisibleText(doc);
  if (!text || text.length < 40) throw new Error("Fetched the page but couldn't find any readable recipe content on it. Try pasting the text instead.");
  return { text, method: "the page's plain text (no structured recipe data found, so this may need more cleanup than usual)" };
}


/* ================================================================== *
 * PASS 1 — holistic analysis, split into two smaller-output calls
 *
 * The sandbox's max_tokens is fixed at 1000. A single call producing
 * every ingredient AND every step AND cross-referencing both is the
 * thing that ran out of room on larger recipes. Splitting it in two
 * keeps each response small without giving up the holistic read:
 * both calls still see the FULL numbered text as input (input tokens
 * aren't the constraint) — only the output each is asked to produce
 * gets narrower.
 *
 * 1a. STEPS       — segment the directions, drop furniture, light edits.
 * 1b. INGREDIENTS — given the finalized steps, cross-reference,
 *     split divided ingredients, add anything missing, order them.
 * ================================================================== */

const STEP_PROMPT = `You segment recipe directions copied out of a web page, numbered by line. Page furniture and broken line wrapping are often mixed in.

Output JSON only — no prose, no markdown fences. Be terse.

{
  "title": string,
  "steps": [ { "n": int, "src": [int], "edit": string } ],
  "corrections": [ { "kind": "join"|"drop"|"normalize", "what": string, "why": string } ],
  "issues": [ string ]
}

- Read the ingredient list too, briefly — it tells you where the directions start.
- Drop page furniture: nutrition panels, unit toggles, ad slots, ratings, share controls, section headings.
- Rejoin lines broken apart by copying: a stranded step number belongs with its step; a sentence split mid-clause belongs together.
- "edit" is set only when the joined src lines need light repair — a missing space after a period, doubled punctuation, a stray bullet. Otherwise "".
- Never invent a step or reorder the directions. Every step must trace to the src lines you cite.
- Keep "what"/"why" under 8 words each. Omit corrections/issues you don't need — empty arrays are fine.`;

const INGREDIENT_PROMPT = `You extract and validate the ingredient list of a recipe, cross-referenced against its already-segmented directions. Output JSON only — no prose, no markdown fences. Be terse.

{
  "ingredients": [
    {
      "id": string,        // short unique slug
      "quantity": string,  // "12-15", "1/2 cup", "" when none given
      "item": string,      // the ingredient plus list-side prep: "onion, finely chopped"
      "note": string,      // "optional", "anaheim also work", "" when none
      "src": [int],        // input line numbers this came from
      "usedIn": [int],     // step numbers (from the directions given) that use it
      "split": boolean     // true if this is one portion of a divided ingredient
    }
  ],
  "corrections": [ { "kind": "split"|"reorder"|"add"|"normalize", "what": string, "why": string } ],
  "issues": [ string ]
}

- Rejoin ingredient lines broken apart by copying: a line holding only a number, or only a unit, belongs with the line that follows it.
- SPLIT any ingredient the directions use at more than one moment — the chart gives each ingredient one cell, so a divided ingredient becomes separate entries whose quantities add back to the original. Give each a distinguishing note, set "split": true, point both at the same src, record it in corrections.
- If the directions use something absent from the list, add it with empty quantity, src pointing at the step line, correction kind "add".
- If an ingredient is never used, keep it, set "usedIn": [], say so in issues.
- Order ingredients to follow the directions: things combined together sit adjacent, earlier uses first.
- Where the list and directions disagree on an amount, keep the list's figure, note the disagreement in issues.
- Never invent an ingredient or a quantity. Every entry must trace to the src lines you cite. Never convert units or re-scale.
- Keep "note" under 5 words, "what"/"why" under 8 words each. Omit corrections/issues you don't need.`;

const ADDITIONS_PROMPT = `You check an already-extracted recipe ingredient list against its directions for anything the directions use that the list is missing. Output JSON only — no prose, no markdown fences. Be terse.

{
  "ingredients": [
    { "id": string, "quantity": string, "item": string, "note": string, "src": [int], "usedIn": [int], "split": boolean }
  ],
  "corrections": [ { "kind": "add", "what": string, "why": string } ],
  "issues": [ string ]
}

- Only include something here if the directions reference it and it is NOT already covered by the extracted list you're given. Do not repeat anything already covered, even worded differently.
- If nothing is missing, return empty arrays for everything — that is the common case.
- New entries: "quantity" is usually "" since the amount wasn't in the original list; "src" points at the step line that mentions it; correction kind is "add".
- Never invent something the directions don't actually mention. Keep "note"/"what"/"why" under 8 words each.`;

const TERSER = "Your previous reply was cut off for length. Try again, shorter: drop \"corrections\", \"issues\", and \"asides\" entirely if needed, shorten every \"note\"/\"what\"/\"why\" to 3 words or fewer, and drop \"edit\" strings unless a line is genuinely broken. The full data — ingredients, steps, src line numbers, and the tree — must still all be there; only the commentary shrinks.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Output-token budget for a single call. The sandbox pinned this at
 * 1000, which is why the ingredient pass is windowed at all. The
 * server clamps whatever is sent here to MAX_OUTPUT_TOKENS, so this
 * is a request, not a guarantee. See INGREDIENT_LINES_PER_CALL —
 * raising this without raising that leaves the windowing doing
 * work it no longer needs to do. */
const MAX_TOKENS = 4000;

async function callModel(system, messages, retriesLeft = 3) {
  const res = await fetch("/api/messages", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: MAX_TOKENS, system, messages }),
  });
  if (res.status === 429 && retriesLeft > 0) {
    await sleep(1200 * (4 - retriesLeft) + 600); // 1.8s, 3s, 4.2s
    return callModel(system, messages, retriesLeft - 1);
  }
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch { /* body wasn't JSON */ }
    const note = res.status === 429 ? " The model is rate-limited right now; that usually clears within a minute." : "";
    throw new Error(`The model call failed (${res.status})${detail ? `: ${detail}` : "."}${note}`);
  }
  const data = await res.json();
  const text = data.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { text, truncated: data.stop_reason === "max_tokens" };
}

/* The API rejects any message whose content is empty, which a
 * truncated turn can produce. Guard before it goes back in as an
 * assistant turn, or a retry meant to recover fails with its own 400. */
function asAssistantTurn(text) {
  return { role: "assistant", content: text && text.trim() ? text : "(no output)" };
}

/* Runs one call; if it gets cut off, retries without feeding the
 * truncated text back in. A cutoff is sometimes genuinely too much
 * data for the budget, but it can also be the model getting stuck in
 * a repetition loop — re-presenting that same garbled text as its
 * own prior turn tends to prime it to keep repeating rather than
 * break out, so the retry starts clean instead. */
async function callWithinBudget(system, messages) {
  const first = await callModel(system, messages);
  if (!first.truncated) return first.text;

  const terser = [...messages, { role: "user", content: TERSER }];
  const second = await callModel(system, terser);
  if (!second.truncated) return second.text;

  // Still cut off — try once more with the original request, unmodified.
  // If the first cutoff was a one-off stall rather than a real size
  // problem, a plain retry often clears it.
  const third = await callModel(system, messages);
  if (!third.truncated) return third.text;

  throw new Error("The response was cut off repeatedly. This is sometimes a one-off glitch — try converting again. If it keeps happening on this recipe, try a shorter one or split it into two conversions.");
}

function extractJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in the response.");
  return JSON.parse(text.slice(start, end + 1));
}

/* ------------------------------------------------------------------ *
 * Verification: every claim must trace back to the cited lines.
 * This is what replaces "the model never emits text" — the model may
 * now rewrite, but nothing it writes is taken on trust.
 * ------------------------------------------------------------------ */

const words = (s) => (String(s || "").toLowerCase().match(/[a-z]{4,}/g) || []);

function coverage(text, hay) {
  const t = words(text);
  if (!t.length) return 1;
  return t.filter((w) => hay.includes(w)).length / t.length;
}

function verifySteps(a, lines) {
  const errors = [];
  const warnings = [];
  const srcText = (src) => (Array.isArray(src) ? src : []).map((i) => lines[i] || "").join(" ").toLowerCase();

  if (!Array.isArray(a.steps) || !a.steps.length) return { errors: ["No steps were returned."], warnings };

  a.steps.forEach((st, i) => {
    const bad = (st.src || []).filter((n) => !Number.isInteger(n) || n < 0 || n >= lines.length);
    if (!Array.isArray(st.src) || !st.src.length) errors.push(`Step ${i + 1} cites no source line.`);
    else if (bad.length) errors.push(`Step ${i + 1} cites line ${bad[0]}, which does not exist.`);
    else if (st.edit && coverage(st.edit, srcText(st.src)) < 0.7) {
      // The src line itself is legitimately cited — this isn't
      // fabrication, just a rewrite that drifted further than a light
      // touch. stepText() already falls back to the raw source text
      // whenever "edit" is empty, so the safe move is to discard the
      // drifted rewrite rather than fail the whole pass over it.
      warnings.push(`Step ${i + 1}'s rewrite drifted from its source line; used the original wording instead.`);
      st.edit = "";
    }
  });

  return { errors, warnings };
}

/* Structural checks only — grounding, ids, required fields. Used both
 * per-chunk (where an empty or partial ingredient list is expected
 * and fine) and as the base for the full-recipe check below. */
function verifyIngredientsCore(a, lines) {
  const errors = [];
  const warnings = [];
  const srcText = (src) => (Array.isArray(src) ? src : []).map((i) => lines[i] || "").join(" ").toLowerCase();

  if (!Array.isArray(a.ingredients)) return { errors: ["No ingredients array was returned."], warnings };

  const ids = new Set();
  a.ingredients.forEach((ing, i) => {
    const label = ing.item || ing.id || `#${i}`;
    if (!ing.id || ids.has(ing.id)) errors.push(`Ingredient "${label}" has a missing or duplicate id.`);
    ids.add(ing.id);

    const bad = (ing.src || []).filter((n) => !Number.isInteger(n) || n < 0 || n >= lines.length);
    if (!Array.isArray(ing.src) || !ing.src.length) errors.push(`Ingredient "${label}" cites no source line.`);
    else if (bad.length) errors.push(`Ingredient "${label}" cites line ${bad[0]}, which does not exist.`);
    else {
      const hay = srcText(ing.src);
      if (coverage(ing.item, hay) < 0.5) {
        errors.push(`Ingredient "${label}" does not appear in the lines it cites (${ing.src.join(", ")}).`);
      }
      if (!ing.split) {
        const nums = String(ing.quantity || "").match(/\d+/g) || [];
        const missing = nums.filter((n) => !hay.includes(n));
        if (missing.length) warnings.push(`Quantity "${ing.quantity}" for ${label} is not in the source line.`);
      }
    }

    if (!ing.item || !String(ing.item).trim()) errors.push(`Ingredient #${i} has no name.`);
    if (Array.isArray(ing.usedIn) && !ing.usedIn.length) warnings.push(`${label} is never used by any step.`);
    if (!ing.quantity) warnings.push(`${label} has no quantity.`);
  });

  return { errors, warnings };
}

/* Per-chunk and additions-reconciliation calls: a short or empty
 * ingredient list is a valid answer, so only structural checks apply. */
const verifyIngredientsChunk = verifyIngredientsCore;
const verifyIngredientsAdditions = verifyIngredientsCore;

/* Full-recipe check: also requires at least two ingredients overall
 * and flags input lines no ingredient accounts for. */
function verifyIngredients(a, lines) {
  if (!Array.isArray(a.ingredients) || a.ingredients.length < 2) return { errors: ["Fewer than two ingredients were returned."], warnings: [] };
  const core = verifyIngredientsCore(a, lines);
  if (core.errors.length) return core;

  const whole = lines.join(" ").toLowerCase();
  const claimed = new Set();
  a.ingredients.forEach((x) => (x.src || []).forEach((n) => claimed.add(n)));
  const unclaimed = lines
    .map((l, i) => i)
    .filter((i) => !claimed.has(i) && words(lines[i]).length > 2 && coverage(lines[i], whole) > 0);
  const warnings = [...core.warnings];
  if (unclaimed.length > 6) warnings.push(`${unclaimed.length} input lines were not used by any ingredient.`);
  return { errors: [], warnings };
}

/* Groups a sorted list of line indices into windows of at most `size`,
 * each described by its first and last index — the window an
 * extraction call is restricted to. */
function chunkRanges(indices, size) {
  const out = [];
  for (let i = 0; i < indices.length; i += size) {
    const slice = indices.slice(i, i + size);
    out.push({ start: slice[0], end: slice[slice.length - 1] });
  }
  return out;
}

/* Merging chunk results can produce id collisions (two chunks both
 * picking "salt"); keep every entry, just make the ids unique. */
function dedupeIds(list) {
  const seen = new Map();
  return list.map((ing) => {
    const base = ing.id || "ingredient";
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? ing : { ...ing, id: `${base}-${n}` };
  });
}

function stepText(st, lines) {
  if (st.edit && st.edit.trim()) return st.edit.trim();
  return (st.src || []).map((i) => lines[i] || "").join(" ").replace(/\s+/g, " ").trim();
}

function composeIngredient(ing) {
  const base = [ing.quantity, ing.item].filter((s) => s && String(s).trim()).join(" ").replace(/\s+/g, " ").trim();
  const note = String(ing.note || "").trim().replace(/^\((.*)\)$/, "$1");
  return note ? `${base} (${note})` : base;
}


/* Generic "call, parse, verify, retry once with the errors" loop,
 * shared by the steps call and the ingredients call. `label` names
 * the pass for error messages; `verify` returns {errors, warnings}. */
async function callAndVerify(system, body, verify, lines, onStatus, label) {
  const messages = [{ role: "user", content: body }];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    onStatus(attempt === 0 ? `Reading the ${label}` : `Correcting the ${label}`);
    const raw = await callWithinBudget(system, messages);

    let parsed;
    try {
      parsed = extractJSON(raw);
    } catch {
      if (attempt === 1) throw new Error(`The ${label} pass did not return usable JSON.`);
      messages.push(asAssistantTurn(raw), { role: "user", content: "That was not valid JSON. Return only the JSON object." });
      continue;
    }

    const { errors, warnings } = verify(parsed, lines);
    if (!errors.length) return { ...parsed, warnings };
    if (attempt === 1) {
      const err = new Error(`The ${label} failed verification twice.`);
      err.details = errors;
      throw err;
    }
    messages.push(
      asAssistantTurn(raw),
      { role: "user", content: `That ${label} failed verification:\n${errors.map((e) => `- ${e}`).join("\n")}\nReturn corrected JSON only.` }
    );
  }
  throw new Error(`${label} failed.`);
}

/* How many raw non-direction lines one ingredient-extraction call is
 * trusted to handle without risking truncation. Above this, the work
 * is split into windows so no single call's output can grow past the
 * sandbox's fixed max_tokens. */
const INGREDIENT_LINES_PER_CALL = 12;
const SINGLE_CALL_CEILING = 16;

async function analyze(lines, onStatus) {
  const numbered = lines.map((l, i) => `${i}. ${l}`).join("\n");

  const stepResult = await callAndVerify(STEP_PROMPT, numbered, verifySteps, lines, onStatus, "directions");
  const stepList = stepResult.steps.map((s, i) => `${s.n ?? i + 1}. ${stepText(s, lines)}`).join("\n");
  const base = `Numbered input lines:\n${numbered}\n\nFinalized directions (cross-reference against these):\n${stepList}`;

  // Lines the directions already claim aren't ingredient-list territory;
  // whatever's left is what the ingredient calls need to cover.
  const directionLines = new Set();
  stepResult.steps.forEach((s) => (s.src || []).forEach((n) => directionLines.add(n)));
  const candidateLines = lines.map((_, i) => i).filter((i) => !directionLines.has(i));

  let chunkResults;
  let windowed = false;

  if (candidateLines.length <= SINGLE_CALL_CEILING) {
    chunkResults = [await callAndVerify(INGREDIENT_PROMPT, base, verifyIngredients, lines, onStatus, "ingredients")];
  } else {
    // Run these one at a time. The sandbox's rate limit is on concurrent
    // requests, not total volume, so firing all the windows at once (as
    // Promise.all did) trips it even though each call individually is
    // well within budget.
    windowed = true;
    const windows = chunkRanges(candidateLines, INGREDIENT_LINES_PER_CALL);
    chunkResults = [];
    for (let i = 0; i < windows.length; i += 1) {
      const w = windows[i];
      const body = `${base}\n\nFor this call only: emit ONLY ingredients whose earliest src line is between ${w.start} and ${w.end} inclusive. Ignore everything outside that range, even if it looks like an ingredient. Do not add anything missing from the list — that is handled separately.`;
      chunkResults.push(await callAndVerify(INGREDIENT_PROMPT, body, verifyIngredientsChunk, lines, onStatus, `ingredients (part ${i + 1}/${windows.length})`));
    }
  }

  let ingredients = dedupeIds(chunkResults.flatMap((r) => r.ingredients));
  let corrections = chunkResults.flatMap((r) => r.corrections || []);
  let issues = chunkResults.flatMap((r) => r.issues || []);
  let warnings = chunkResults.flatMap((r) => r.warnings || []);

  if (windowed) {
    onStatus("Checking for missing ingredients");
    const already = ingredients.map((e) => `- ${e.item}`).join("\n") || "(none extracted yet)";
    const addBody = `${base}\n\nAlready extracted ingredients (do not repeat these):\n${already}`;
    const added = await callAndVerify(ADDITIONS_PROMPT, addBody, verifyIngredientsAdditions, lines, onStatus, "missing ingredients");
    ingredients = dedupeIds([...ingredients, ...(added.ingredients || [])]);
    corrections = [...corrections, ...(added.corrections || [])];
    issues = [...issues, ...(added.issues || [])];
    warnings = [...warnings, ...(added.warnings || [])];
  }

  // One last check across the merged, full ingredient list — errors
  // here (vs. per-chunk) aren't worth another round trip, so they're
  // surfaced as warnings rather than triggering a retry.
  const finalCheck = verifyIngredients({ ingredients }, lines);
  warnings = [...warnings, ...finalCheck.errors, ...finalCheck.warnings];

  return {
    title: stepResult.title || "",
    steps: stepResult.steps,
    ingredients,
    corrections: [...(stepResult.corrections || []), ...corrections],
    issues: [...(stepResult.issues || []), ...issues],
    warnings: [...(stepResult.warnings || []), ...warnings],
  };
}

/* ================================================================== *
 * PASS 2 — structure
 * Input is now clean: ingredients already split, ordered and named.
 * ================================================================== */

const STRUCTURE_PROMPT = `You turn an analyzed recipe into a nested preparation tree. Output JSON only — no prose, no markdown fences.

{
  "prep": string[],
  "asides": [ { "text": string, "anchor": string } ],
  "tree": Node
}

Node = an integer (index of an ingredient) | { "op": string, "id"?: string, "children": Node[] }

- "prep" holds setup that involves NO listed ingredient at all: preheating, greasing pans, bringing water to a boil. Under 8 words each. May be empty.
- "asides" holds a step involving NO listed ingredient at all that DOES have a specific moment it must be ready by: "heat the skillet while prepping the rest", "let the dough rest 10 min before shaping". "anchor" is the "id" of the op node it must be ready by. Under 8 words each. May be empty. Don't use this for setup with no particular timing — that's "prep".
- The test for "prep"/"asides" is only ever "does this step name or touch a listed ingredient?" — never whether the recipe's own wording sounds like an aside. A step like "fry the egg, set aside" NAMES the egg, so it is never "prep" or "asides" no matter that it literally says "set aside" — it is a tree node instead (see the next rule), full stop. Never emit both a tree node and a prep/aside entry for the same action.
- "id" on an op node is optional — set it only when an aside needs to anchor to that exact node. Omit it everywhere else.
- Every ingredient index appears exactly once in the tree. The list has already been split so that no ingredient is used twice.
- "op" is a terse imperative label, 1-6 words: "melt", "mix", "fold in", "simmer 1 hr", "bake 350F 30-40 min". Carry over temperature and time when the step gives them.
- Each op node's children are exactly what is combined at that moment: ingredients entering directly, plus any sub-preparation already assembled.
- The root op is the final action.
- Child order sets the row order of the chart, so ingredients combined in the same step must be adjacent.
- Merge instructions describing one physical action; split an instruction that assembles two independent sub-preparations.
- An ingredient prepared apart and stirred in late — a roux, a slurry, a garnish, a fried egg set aside for topping — is its own subtree joined at the step where it meets the rest.`;

function validateTree(tree, count, asides) {
  const errors = [];
  const found = [];
  const ids = new Map();
  (function walk(node, depth) {
    if (depth > 25) { errors.push("Tree is nested more than 25 levels deep."); return; }
    if (typeof node === "number") {
      if (!Number.isInteger(node) || node < 0 || node >= count) errors.push(`Ingredient index ${node} is out of range (0-${count - 1}).`);
      else found.push(node);
      return;
    }
    if (!node || typeof node !== "object" || typeof node.op !== "string" || !node.op.trim()) {
      errors.push("A step is missing its op label."); return;
    }
    if (node.id !== undefined) {
      if (typeof node.id !== "string" || !node.id.trim()) errors.push(`Step "${node.op}" has an invalid id.`);
      else if (ids.has(node.id)) errors.push(`Id "${node.id}" is used more than once.`);
      else ids.set(node.id, true);
    }
    if (!Array.isArray(node.children) || node.children.length === 0) {
      errors.push(`Step "${node.op}" has no inputs.`); return;
    }
    node.children.forEach((c) => walk(c, depth + 1));
  })(tree, 0);

  const seen = new Set();
  found.forEach((i) => {
    if (seen.has(i)) errors.push(`Ingredient index ${i} is used more than once.`);
    seen.add(i);
  });
  for (let i = 0; i < count; i += 1) if (!seen.has(i)) errors.push(`Ingredient index ${i} never appears in the tree.`);

  if (asides !== undefined && !Array.isArray(asides)) {
    errors.push(`"asides" must be an array.`);
  } else {
    (asides || []).forEach((a, i) => {
      if (!a || typeof a.text !== "string" || !a.text.trim()) errors.push(`Aside #${i + 1} has no text.`);
      if (!a || typeof a.anchor !== "string" || !a.anchor.trim()) errors.push(`Aside #${i + 1} has no anchor.`);
      else if (!ids.has(a.anchor)) errors.push(`Aside #${i + 1} anchors to id "${a.anchor}", which is not defined in the tree.`);
    });
  }
  return errors;
}

async function structure(ingredients, steps, onStatus) {
  const messages = [{
    role: "user",
    content: `Ingredients (use these indices):\n${ingredients.map((l, i) => `${i}. ${l}`).join("\n")}\n\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  }];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    onStatus(attempt === 0 ? "Working out the structure" : "Fixing the structure");
    const raw = await callWithinBudget(STRUCTURE_PROMPT, messages);

    let parsed;
    try {
      parsed = extractJSON(raw);
    } catch {
      if (attempt === 1) throw new Error("The structure pass did not return usable JSON.");
      messages.push(asAssistantTurn(raw), { role: "user", content: "That was not valid JSON. Return only the JSON object." });
      continue;
    }

    const errors = validateTree(parsed.tree, ingredients.length, parsed.asides);
    if (!errors.length) return parsed;
    if (attempt === 1) {
      const err = new Error("The tree failed validation twice.");
      err.details = errors;
      throw err;
    }
    messages.push(
      asAssistantTurn(raw),
      { role: "user", content: `That tree failed validation:\n${errors.map((e) => `- ${e}`).join("\n")}\nReturn corrected JSON only.` }
    );
  }
  throw new Error("Structuring failed.");
}

/* ================================================================== *
 * PASS 3 — pure layout, no model
 * ================================================================== */

export function layoutTree(tree) {
  const leaves = [];
  const cells = [];
  const idToCol = new Map();
  let nextCol = 0;
  function walk(node) {
    if (typeof node === "number") {
      const row = leaves.length;
      leaves.push(node);
      return { start: row, end: row };
    }
    let start = Infinity;
    let end = -Infinity;
    node.children.forEach((c) => {
      const r = walk(c);
      start = Math.min(start, r.start);
      end = Math.max(end, r.end);
    });
    cells.push({ op: node.op, row: start, rowSpan: end - start + 1, col: nextCol, colSpan: 1 });
    if (node.id) idToCol.set(node.id, nextCol);
    nextCol += 1;
    return { start, end };
  }
  walk(tree);
  return { leaves, cells, cols: nextCol, rows: leaves.length, idToCol };
}

export function fillGaps(cells, rows, cols) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(false));
  cells.forEach((c) => { for (let r = c.row; r < c.row + c.rowSpan; r += 1) grid[r][c.col] = true; });
  const blanks = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (grid[r][c]) continue;
      let w = 0;
      while (c + w < cols && !grid[r][c + w]) w += 1;
      let h = 1;
      let canGrow = true;
      while (r + h < rows && canGrow) {
        for (let k = 0; k < w; k += 1) if (grid[r + h][c + k]) { canGrow = false; break; }
        if (canGrow) h += 1;
      }
      for (let i = 0; i < h; i += 1) for (let k = 0; k < w; k += 1) grid[r + i][c + k] = true;
      blanks.push({ blank: true, row: r, col: c, rowSpan: h, colSpan: w });
      c += w - 1;
    }
  }
  return blanks;
}

/* An ingredient attached directly to a node (a raw index) only enters
 * the chart at THAT node's own column — the latest point in its
 * branch, since a node's column is assigned after all its children
 * are done. A sibling that's itself a nested op resolves earlier, at
 * its own (necessarily lower) column. So within any one node's
 * children, a raw ingredient must never be ordered ahead of a nested
 * sub-op sibling — doing so puts a late-entering ingredient above
 * early-entering ones, producing a blank run at the top of its row
 * that has nothing to do with real prep order. This holds for any
 * tree, so it's enforced here rather than relied on from the prompt:
 * nested sub-ops keep their given relative order, raw ingredients
 * move after all of them, also keeping their given relative order. */
export function orderForEntry(node) {
  if (typeof node === "number") return node;
  const children = node.children.map(orderForEntry);
  const subops = children.filter((c) => typeof c !== "number");
  const raw = children.filter((c) => typeof c === "number");
  return { ...node, children: [...subops, ...raw] };
}

export function buildGrid(tree, asides) {
  const { leaves, cells, cols, rows, idToCol } = layoutTree(orderForEntry(tree));
  const all = [...cells, ...fillGaps(cells, rows, cols)];
  const byRow = Array.from({ length: rows }, () => []);
  all.forEach((c) => byRow[c.row].push(c));
  byRow.forEach((r) => r.sort((a, b) => a.col - b.col));
  const resolvedAsides = (asides || [])
    .map((a) => ({ text: a.text, col: idToCol.get(a.anchor) }))
    .filter((a) => Number.isInteger(a.col))
    .sort((a, b) => a.col - b.col);
  return { leaves, byRow, cols, rows, asides: resolvedAsides };
}

/* ================================================================== *
 * Export
 * ================================================================== */

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function exportHTML(grid, ingredients, prep, title) {
  const b = "border:1px solid #000;";
  const pad = "padding:5px 8px;";
  const width = grid.cols + 1;
  const rows = (prep || []).map((p) => `<tr><td colspan="${width}" style="${b}${pad}text-align:center;">${esc(p)}</td></tr>`);
  (grid.asides || []).forEach((a) => {
    const span = a.col + 2;
    const fill = width - span;
    const filler = fill > 0 ? `<td colspan="${fill}" style="${b}"></td>` : "";
    rows.push(`<tr><td colspan="${span}" style="${b}${pad}text-align:right;font-style:italic;border-left:3px solid #C9A576;">${esc(a.text)}</td>${filler}</tr>`);
  });
  grid.byRow.forEach((cells, r) => {
    const ing = `<td style="${b}${pad}">${esc(ingredients[grid.leaves[r]])}</td>`;
    const rest = cells.map((c) => c.blank
      ? `<td rowspan="${c.rowSpan}" colspan="${c.colSpan}" style="${b}"></td>`
      : `<td rowspan="${c.rowSpan}" colspan="${c.colSpan}" style="${b}${pad}text-align:center;vertical-align:middle;">${esc(c.op)}</td>`).join("");
    rows.push(`<tr>${ing}${rest}</tr>`);
  });
  return `<table style="border-collapse:collapse;font:14px Arial,Helvetica,sans-serif;">
<caption style="caption-side:top;text-align:left;font-weight:bold;padding-bottom:6px;">${esc(title)}</caption>
${rows.join("\n")}
</table>`;
}

/* ================================================================== *
 * Samples
 * ================================================================== */

/* ================================================================== *
 * UI
 * ================================================================== */

const KIND_LABEL = { join: "joined", split: "split", reorder: "reordered", add: "added", drop: "dropped", normalize: "tidied" };

/* The chart itself — the one deterministic, model-free render. Exported
 * so the /styleguide route can show the exact same markup against fixture
 * data instead of a hand-copied duplicate that could drift out of sync. */
export function GridTable({ title, activeLabels, grid, prep }) {
  return (
    <>
      <div className="rg-block">
        <span>{title || "Untitled"}</span>
        <span>{activeLabels.length} ingredients</span>
        <span>{grid.cols} steps</span>
      </div>

      <div className="rg-scroll">
        <table className="rg-table">
          <tbody>
            {(prep || []).map((p, i) => (
              <tr key={`p${i}`}><td className="rg-prep" colSpan={grid.cols + 1}>{p}</td></tr>
            ))}
            {(grid.asides || []).map((a, i) => {
              const span = a.col + 2;
              const fill = grid.cols + 1 - span;
              return (
                <tr key={`a${i}`}>
                  <td className="rg-prep rg-aside" colSpan={span}>{a.text}</td>
                  {fill > 0 && <td className="rg-gap" colSpan={fill} />}
                </tr>
              );
            })}
            {grid.byRow.map((cells, r) => (
              <tr key={r}>
                <td className="rg-ingcell">{activeLabels[grid.leaves[r]]}</td>
                {cells.map((c, i) => c.blank
                  ? <td key={i} className="rg-gap" rowSpan={c.rowSpan} colSpan={c.colSpan} />
                  : <td key={i} className="rg-op" rowSpan={c.rowSpan} colSpan={c.colSpan} style={{ animationDelay: `${c.col * 55}ms` }}>{c.op}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function RecipeGridConverter() {
  const [mode, setMode] = useState("url");
  const [text, setText] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [urlFetching, setUrlFetching] = useState(false);
  const [urlError, setUrlError] = useState(null);
  const [fetchedFrom, setFetchedFrom] = useState(null);
  const [urlTextLoaded, setUrlTextLoaded] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [labels, setLabels] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [tree, setTree] = useState(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState(null);
  const [showJSON, setShowJSON] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);
  const [copied, setCopied] = useState("");
  const [screen, setScreen] = useState("input");
  const [view, setView] = useState("grid");
  const [reviewOpen, setReviewOpen] = useState(false);
  const exportRef = useRef("");

  useEffect(() => {
    setAnalysis(null); setLabels([]); setRemoved([]); setTree(null); setError(null);
  }, [text]);

  const lines = useMemo(() => numberLines(text), [text]);
  const active = useMemo(
    () => (analysis ? analysis.ingredients.map((ing, i) => ({ ing, i })).filter(({ i }) => !removed.includes(i)) : []),
    [analysis, removed]
  );
  const activeLabels = active.map(({ i }) => labels[i]);
  const grid = useMemo(() => (tree ? buildGrid(tree.tree, tree.asides) : null), [tree]);
  const stale = tree && tree.count !== active.length;
  const stepTexts = useMemo(() => (analysis ? analysis.steps.map((s) => stepText(s, lines)) : []), [analysis, lines]);
  const reviewCount = analysis
    ? (analysis.corrections || []).length + (analysis.issues || []).length + (analysis.warnings || []).length
    : 0;

  if (grid && !stale) exportRef.current = exportHTML(grid, activeLabels, tree.prep, analysis.title);

  async function fetchUrl() {
    if (!urlInput.trim()) return;
    setUrlError(null); setUrlFetching(true); setFetchedFrom(null);
    try {
      const { text: fetched, method } = await fetchRecipeFromUrl(urlInput.trim());
      setText(fetched);
      setFetchedFrom({ url: urlInput.trim(), method });
      setUrlTextLoaded(true);
    } catch (e) {
      setUrlError(e.message);
    } finally {
      setUrlFetching(false);
    }
  }

  async function run() {
    setScreen("result"); setView("grid"); setReviewOpen(false);
    setError(null); setAnalysis(null); setLabels([]); setRemoved([]); setTree(null); setStatus("Starting");
    try {
      const a = await analyze(lines, setStatus);
      const composed = a.ingredients.map(composeIngredient);
      setAnalysis(a); setLabels(composed); setRemoved([]);
      const steps = a.steps.map((s) => stepText(s, lines));
      const t = await structure(composed, steps, setStatus);
      setTree({ ...t, count: composed.length });
    } catch (e) {
      setError({ message: e.message, details: e.details });
    } finally { setStatus(""); }
  }

  async function redraw() {
    setError(null); setStatus("Working out the structure");
    try {
      const steps = analysis.steps.map((s) => stepText(s, lines));
      const t = await structure(activeLabels, steps, setStatus);
      setTree({ ...t, count: activeLabels.length });
    } catch (e) {
      setError({ message: e.message, details: e.details });
    } finally { setStatus(""); }
  }

  function editLabel(i, v) { const next = [...labels]; next[i] = v; setLabels(next); }
  function toggleRemoved(i) { setRemoved((r) => (r.includes(i) ? r.filter((x) => x !== i) : [...r, i])); }
  function newRecipe() {
    setScreen("input");
    setMode("url");
    setText("");
    setUrlInput("");
    setUrlFetching(false);
    setUrlError(null);
    setFetchedFrom(null);
    setUrlTextLoaded(false);
    setAnalysis(null);
    setLabels([]);
    setRemoved([]);
    setTree(null);
    setStatus("");
    setError(null);
    setShowJSON(false);
    setShowPrompts(false);
    setCopied("");
    setView("grid");
    setReviewOpen(false);
    exportRef.current = "";
  }

  function copy(label, value) {
    navigator.clipboard.writeText(value).then(
      () => { setCopied(label); setTimeout(() => setCopied(""), 1600); },
      () => setCopied("failed")
    );
  }

  const busy = !!status;

  return (
    <div className="rg graph-paper">
      <style>{CSS}</style>

      {screen === "input" && (
        <div className="rg-input-shell">
          <header className="rg-head">
            <img className="rg-mark" src="/logo/mark.png" alt="" />
            <div className="rg-head-text">
              <img className="rg-wordmark" src="/logo/wordmark.png" alt="gridients" />
              <span className="rg-eyebrow">Recipe → assembly diagram</span>
            </div>
          </header>
          <p className="rg-sub">
            When copy/pasting a recipe, be sure to include the dish title, ingredients and directions, and remove any unrelated text. The more complete the input, the better the output.
          </p>

          <section className="rg-panel">
            <div className="rg-tabs">
              <button type="button" className={mode === "paste" ? "rg-tab rg-tab-active" : "rg-tab"} onClick={() => setMode("paste")}>Paste text</button>
              <button type="button" className={mode === "url" ? "rg-tab rg-tab-active" : "rg-tab"} onClick={() => setMode("url")}>From a URL</button>
            </div>

            {mode === "paste" && (
              <div className="rg-bar">
                <label className="rg-label" htmlFor="rg-src">Recipe text</label>
              </div>
            )}

            {mode === "url" && (
              <div className="rg-urlrow">
                <input
                  className="rg-urlinput"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") fetchUrl(); }}
                  placeholder="https://example.com/some-recipe"
                  spellCheck={false}
                />
                <button className="rg-fetch" onClick={fetchUrl} disabled={urlFetching || !urlInput.trim()}>
                  {urlFetching ? "Fetching…" : "Fetch"}
                </button>
              </div>
            )}

            {mode === "url" && urlError && (
              <p className="rg-urlerror">{urlError}</p>
            )}

            {fetchedFrom && (
              <p className="rg-fetched">
                Pulled from <strong>{fetchedFrom.method}</strong> at {fetchedFrom.url} — review below before converting.
              </p>
            )}

            {(mode === "paste" || urlTextLoaded) && (
              <textarea
                id="rg-src"
                className="rg-textarea"
                value={text}
                onChange={(e) => { setText(e.target.value); setFetchedFrom(null); }}
                spellCheck={false}
              />
            )}

            <button className="rg-go" onClick={run} disabled={busy || lines.length < 4 || (mode === "url" && !urlTextLoaded)}>
              {busy ? `${status}…` : analysis ? "Start over" : "Convert recipe"}
            </button>
          </section>
        </div>
      )}

      {screen === "result" && (
        <div className="rg-result-shell">
          <div className="rg-topbar">
            <img className="rg-mark" src="/logo/mark.png" alt="gridients" />
            <span className="rg-topbar-title">
              {analysis ? (analysis.title || "Untitled") : busy ? "Converting…" : error ? "Couldn't convert" : ""}
            </span>

            {analysis && !busy && (
              <div className="rg-viewtabs">
                <button type="button" className={view === "grid" ? "rg-viewtab rg-viewtab-active" : "rg-viewtab"} onClick={() => setView("grid")}>Grid</button>
                <button type="button" className={view === "linear" ? "rg-viewtab rg-viewtab-active" : "rg-viewtab"} onClick={() => setView("linear")}>Linear</button>
                <button type="button" className={view === "original" ? "rg-viewtab rg-viewtab-active" : "rg-viewtab"} onClick={() => setView("original")}>Original</button>
              </div>
            )}

            {analysis && !busy && (
              <button type="button" className="rg-review-toggle" onClick={() => setReviewOpen((v) => !v)}>
                Review &amp; fix
                {reviewCount > 0 && <em className={stale ? "rg-tag rg-tag-warn" : "rg-tag"}>{reviewCount}</em>}
              </button>
            )}

            {analysis && !busy && (
              <button type="button" className="rg-print" onClick={() => window.print()}>Print</button>
            )}

            <button type="button" className="rg-newrecipe" onClick={newRecipe}>New recipe</button>
          </div>

          <div className="rg-content">
            {busy && <div className="rg-busy"><p>{status}…</p></div>}

            {error && (
              <div className="rg-error">
                <strong>{error.message}</strong>
                {error.details && <ul>{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
              </div>
            )}

            {analysis && !busy && (
              <>
                {reviewOpen && (
                  <div className="rg-review">
                    {(analysis.corrections || []).length > 0 && (
                      <div className="rg-notes">
                        <span className="rg-label">Corrections applied</span>
                        <ul>
                          {analysis.corrections.map((c, i) => (
                            <li key={i}>
                              <em className={`rg-tag rg-kind-${c.kind}`}>{KIND_LABEL[c.kind] || c.kind}</em>
                              <span><strong>{c.what}</strong> — {c.why}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {((analysis.issues || []).length > 0 || (analysis.warnings || []).length > 0) && (
                      <div className="rg-notes rg-flagged">
                        <span className="rg-label">Left for you to judge</span>
                        <ul>
                          {[...(analysis.issues || []), ...(analysis.warnings || [])].map((s, i) => <li key={i}><span>{s}</span></li>)}
                        </ul>
                      </div>
                    )}

                    <div className="rg-bar">
                      <span className="rg-label">Ingredients as understood</span>
                      <span className="rg-count">{active.length} of {analysis.ingredients.length}</span>
                    </div>
                    <p className="rg-hint">Edit any row; the chart follows. Removing one needs a redraw.</p>

                    <ol className="rg-ings">
                      {analysis.ingredients.map((ing, i) => {
                        const gone = removed.includes(i);
                        return (
                          <li key={ing.id || i} className={gone ? "rg-gone" : ""}>
                            <input value={labels[i] || ""} onChange={(e) => editLabel(i, e.target.value)} disabled={gone} />
                            <span className="rg-tags">
                              {ing.split && <em className="rg-tag rg-tag-split">split</em>}
                              {Array.isArray(ing.usedIn) && ing.usedIn.length === 0 && <em className="rg-tag rg-tag-warn">unused</em>}
                              {Array.isArray(ing.usedIn) && ing.usedIn.length > 0 && <em className="rg-tag">→{ing.usedIn.join(",")}</em>}
                            </span>
                            <button type="button" onClick={() => toggleRemoved(i)} title={gone ? "Restore" : "Remove"}>{gone ? "+" : "×"}</button>
                          </li>
                        );
                      })}
                    </ol>

                    {stale && (
                      <button className="rg-go rg-redraw" onClick={redraw} disabled={busy || active.length < 2}>
                        {busy ? `${status}…` : "Redraw the diagram"}
                      </button>
                    )}

                    {grid && !stale && (
                      <div className="rg-review-dev">
                        <span className="rg-label">Developer</span>
                        <div className="rg-actions">
                          <button onClick={() => copy("html", exportRef.current)}>{copied === "html" ? "Copied" : "Copy table HTML"}</button>
                          <button onClick={() => setShowJSON((v) => !v)}>{showJSON ? "Hide data" : "Show data"}</button>
                          <button onClick={() => setShowPrompts((v) => !v)}>{showPrompts ? "Hide prompts" : "Show prompts"}</button>
                        </div>
                        {showJSON && <pre className="rg-pre">{JSON.stringify({ analysis, tree }, null, 2)}</pre>}
                        {showPrompts && <pre className="rg-pre">{`PASS 1a — STEPS\n\n${STEP_PROMPT}\n\n\nPASS 1b — INGREDIENTS\n\n${INGREDIENT_PROMPT}\n\n\nPASS 1c — MISSING INGREDIENTS (large recipes only)\n\n${ADDITIONS_PROMPT}\n\n\nPASS 2 — STRUCTURE\n\n${STRUCTURE_PROMPT}`}</pre>}
                      </div>
                    )}
                  </div>
                )}

                {stale && <p className="rg-stale">The ingredient list changed. Redraw to rebuild the chart.</p>}

                {view === "grid" && grid && !stale && (
                  <GridTable title={analysis.title} activeLabels={activeLabels} grid={grid} prep={tree.prep} />
                )}

                {view === "linear" && (
                  <div className="rg-linear">
                    <h2>{analysis.title || "Untitled"}</h2>
                    <h3>Ingredients</h3>
                    <ul>
                      {activeLabels.map((label, i) => <li key={i}>{label}</li>)}
                    </ul>
                    <h3>Directions</h3>
                    <ol>
                      {stepTexts.map((s, i) => <li key={i}>{s.replace(/^\s*\d+[.)]\s*/, "")}</li>)}
                    </ol>
                  </div>
                )}

                {view === "original" && (
                  <pre className="rg-original">{text}</pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export const CSS = `
html, body, #root { height: 100%; margin: 0; }

.rg {
  color: var(--ink);
  font: 15px/1.5 var(--font-serif);
  height: 100%;
}
.rg *, .rg *::before, .rg *::after { box-sizing: border-box; }
.rg button:focus-visible, .rg textarea:focus-visible, .rg input:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }

.rg-eyebrow, .rg-label, .rg-count, .rg-block, .rg-op, .rg-actions button,
.rg-go, .rg-tag, .rg-ings button,
.rg-topbar-title, .rg-viewtab, .rg-review-toggle, .rg-print, .rg-newrecipe,
.rg-tab, .rg-urlinput, .rg-fetch, .rg-textarea, .rg-original, .rg-pre, .rg-linear h3, .rg-prep {
  font-family: var(--font-mono);
}

.rg-input-shell { max-width: 640px; margin: 0 auto; padding: 28px 24px 40px; }

.rg-head { max-width: 66ch; margin-bottom: 26px; display: flex; align-items: center; gap: 14px; }
.rg-head .rg-mark { width: 46px; height: auto; flex-shrink: 0; }
.rg-head .rg-wordmark { height: 28px; width: auto; }
.rg-head-text { display: flex; flex-direction: column; }
.rg-eyebrow { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-dim); }
.rg-sub { margin: 10px 0 20px; color: var(--ink); font-size: 16px; font-weight: 300; max-width: 66ch; }

.rg-panel { background: var(--paper); border: var(--border-width) solid var(--rule); padding: 16px; }
.rg-label { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-dim); }
.rg-hint { font-size: 12px; color: var(--ink-dim); margin: 4px 0 0; }
.rg-bar { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-top: 20px; }
.rg-bar:first-child { margin-top: 0; }
.rg-count { font-size: 11px; color: var(--ink); }


.rg-tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: var(--border-width) solid var(--rule); }
.rg-tab {
  background: none; border: 0; padding: 8px 4px; margin-right: 18px;
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--ink-dim); cursor: pointer; border-bottom: 2px solid transparent; position: relative; bottom: -1px;
}
.rg-tab-active { color: var(--ink); border-bottom-color: var(--ink); }

.rg-urlrow { display: flex; gap: 7px; }
.rg-urlinput {
  flex: 1; min-width: 0; padding: 9px 10px; border: var(--border-width) solid var(--rule); background: var(--paper); color: var(--ink);
  font-size: 13px; border-radius: var(--radius);
}
.rg-fetch {
  padding: 9px 14px; background: var(--ink); color: var(--paper); border: 0; border-radius: var(--radius);
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase; cursor: pointer; white-space: nowrap;
}
.rg-fetch:disabled { background: var(--rule); cursor: not-allowed; }
.rg-urlerror { font-size: 12.5px; color: var(--correction); margin: 8px 0 0; }
.rg-fetched { font-size: 12px; color: var(--ink-dim); margin: 9px 0 0; }
.rg-fetched strong { color: var(--ink); font-weight: 600; }

.rg-textarea {
  width: 100%; height: 165px; margin-top: 7px; padding: 10px;
  border: var(--border-width) solid var(--rule); background: var(--paper); color: var(--ink); border-radius: var(--radius);
  font-size: 13px; line-height: 1.55; resize: vertical;
}

.rg-go {
  width: 100%; margin-top: 14px; padding: 11px; background: var(--ink); color: var(--paper); border: 0; border-radius: var(--radius);
  font-size: 12px; letter-spacing: .1em; text-transform: uppercase; cursor: pointer; font-family: var(--font-mono);
}
.rg-go:disabled { background: var(--rule); cursor: not-allowed; }
.rg-redraw { background: var(--correction); }

.rg-ings { list-style: none; margin: 9px 0 0; padding: 0; max-height: 300px; overflow-y: auto; border: var(--border-width) solid var(--rule); background: var(--paper); }
.rg-ings li { display: flex; align-items: center; gap: 4px; border-bottom: var(--border-width) solid var(--grid); padding-right: 2px; }
.rg-ings input { flex: 1; min-width: 0; border: 0; background: none; padding: 6px 8px; font-family: var(--font-serif); font-size: 13px; color: inherit; }
.rg-ings input:disabled { color: var(--rule); text-decoration: line-through; }
.rg-ings button { border: 0; background: none; color: var(--rule); cursor: pointer; font-size: 13px; padding: 0 6px; }
.rg-gone input { text-decoration: line-through; }

.rg-tags { display: flex; gap: 3px; flex-shrink: 0; }
.rg-tag { font-size: 8.5px; letter-spacing: .07em; text-transform: uppercase; font-style: normal; padding: 2px 5px; background: color-mix(in srgb, var(--spill) 25%, var(--paper)); color: var(--ink); white-space: nowrap; border-radius: var(--radius); }
.rg-tag-split { background: color-mix(in srgb, var(--spill) 50%, var(--paper)); color: var(--ink); }
.rg-tag-warn { background: var(--correction); color: var(--paper); }
.rg-kind-join, .rg-kind-split, .rg-kind-reorder, .rg-kind-add, .rg-kind-drop, .rg-kind-normalize {
  background: color-mix(in srgb, var(--spill) 25%, var(--paper)); color: var(--ink);
}

.rg-result-shell { height: 100dvh; display: flex; flex-direction: column; }

.rg-topbar {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 14px 20px; border-bottom: var(--border-width) solid var(--rule); background: var(--paper); flex-shrink: 0;
}
.rg-topbar .rg-mark { width: 22px; height: auto; flex-shrink: 0; }
.rg-topbar-title { font-size: 12px; color: var(--ink-dim); letter-spacing: .04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.rg-viewtabs { display: flex; gap: 6px; }
.rg-viewtab {
  background: none; border: var(--border-width) solid var(--rule); padding: 8px 16px; border-radius: var(--radius);
  font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim); cursor: pointer;
}
.rg-viewtab-active { background: var(--ink); border-color: var(--ink); color: var(--paper); }

.rg-review-toggle {
  display: flex; align-items: center; gap: 6px;
  background: none; border: var(--border-width) solid var(--rule); padding: 7px 12px; border-radius: var(--radius);
  font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink); cursor: pointer;
}

.rg-print {
  margin-left: auto; background: none; border: var(--border-width) solid var(--rule); color: var(--ink);
  font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; cursor: pointer; padding: 7px 12px; border-radius: var(--radius);
}

.rg-newrecipe {
  background: none; border: 0; color: var(--ink-dim);
  font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; cursor: pointer; padding: 7px 4px;
}

.rg-content { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px; }

.rg-busy { display: flex; align-items: center; justify-content: center; min-height: 50vh; color: var(--ink-dim); font: 20px var(--font-hand); }
.rg-busy p { margin: 0; }
.rg-error { border-left: var(--border-width-accent) solid var(--correction); padding: 10px 0 10px 12px; margin-bottom: 16px; }
.rg-error strong { display: block; margin-bottom: 4px; font: 20px var(--font-hand); font-weight: normal; color: var(--correction); }
.rg-error ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; color: var(--ink-dim); }

.rg-review { background: var(--paper); border: var(--border-width) solid var(--rule); padding: 16px; margin-bottom: 18px; }
.rg-review-dev { border-top: var(--border-width) solid var(--rule); margin-top: 16px; padding-top: 12px; }

.rg-linear { max-width: 70ch; }
.rg-linear h2 { font: 26px var(--font-hand); font-weight: normal; margin: 0 0 14px; color: var(--ink); }
.rg-linear h3 { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-dim); margin: 18px 0 8px; }
.rg-linear h3:first-of-type { margin-top: 0; }
.rg-linear ul, .rg-linear ol { margin: 0; padding-left: 22px; font-size: 14px; line-height: 1.6; }

.rg-original {
  max-width: 70ch; font-size: 13px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  background: var(--paper); border: var(--border-width) solid var(--rule); padding: 14px 16px; margin: 0;
}

.rg-notes { margin-bottom: 16px; }
.rg-notes ul { list-style: none; margin: 7px 0 0; padding: 0; }
.rg-notes li { display: flex; gap: 8px; align-items: baseline; font-size: 13px; padding: 4px 0; border-bottom: var(--border-width) solid var(--grid); }
.rg-notes li:last-child { border-bottom: 0; }
.rg-notes strong { font-weight: 600; }
.rg-flagged li { color: var(--correction); }

.rg-stale { font-size: 12.5px; color: var(--correction); margin: 0 0 14px; }

.rg-block { display: flex; flex-wrap: wrap; border: var(--border-width) solid var(--rule); border-bottom: 0; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
.rg-block span { padding: 6px 10px; border-right: var(--border-width) solid var(--rule); }
.rg-block span:first-child { color: var(--ink); font-weight: 700; letter-spacing: .06em; }
.rg-block span:last-child { border-right: 0; }

.rg-scroll { overflow-x: auto; }
.rg-table { border-collapse: collapse; background: var(--paper); width: 100%; }
.rg-table td { border: var(--border-width) solid var(--rule); }
.rg-ingcell { padding: 6px 9px; font-size: 14px; font-family: var(--font-serif); }
.rg-prep { padding: 6px 9px; text-align: center; font-size: 13px; }
.rg-gap { background: repeating-linear-gradient(135deg, transparent, transparent 7px, var(--grid) 7px, var(--grid) 8px); }
.rg-aside { font-family: var(--font-hand); font-size: 16px; text-align: right; }
.rg-table td.rg-aside { border-left: var(--border-width-accent) solid var(--spill); }
.rg-op {
  padding: 6px 10px; text-align: center; vertical-align: middle;
  font-size: 11.5px; background: color-mix(in srgb, var(--spill) 20%, var(--paper)); color: var(--ink);
  animation: rg-in .34s ease-out backwards;
}
.rg-ingcell:hover, .rg-op:hover { background: var(--grid); }
@keyframes rg-in { from { opacity: 0; transform: translateX(-7px); } }
@media (prefers-reduced-motion: reduce) { .rg-op { animation: none; } }

.rg-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.rg-actions button { background: none; border: var(--border-width) solid var(--rule); padding: 6px 11px; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; cursor: pointer; color: var(--ink); border-radius: var(--radius); }

.rg-pre { margin: 12px 0 0; padding: 11px; background: var(--paper); border: var(--border-width) solid var(--rule); font-size: 11.5px; line-height: 1.5; max-height: 320px; overflow: auto; white-space: pre-wrap; }

@media (max-width: 899px) {
  .rg-topbar { padding: 10px 14px; }
  .rg-content { padding: 14px 16px; }
  .rg-viewtab, .rg-review-toggle, .rg-print, .rg-newrecipe { min-height: 44px; }
}

@media (max-width: 599px) {
  .rg-input-shell { padding: 20px 16px 32px; }
  .rg-topbar { flex-direction: column; align-items: stretch; gap: 8px; }
  .rg-topbar-title { order: 1; text-align: center; white-space: normal; }
  .rg-print { order: 2; margin-left: 0; align-self: center; }
  .rg-newrecipe { order: 3; align-self: center; }
  .rg-viewtabs { order: 4; width: 100%; }
  .rg-viewtab { flex: 1; padding: 10px 4px; }
  .rg-review-toggle { order: 5; justify-content: center; }
  .rg-content { padding: 14px; }
  .rg-linear, .rg-original { max-width: 100%; }
}
`;
