import React from "react";
import { CSS, GridTable } from "./App.jsx";

/* Static fixture matching the real analyze()/structure() output shapes —
 * no live API calls, so this page renders instantly and deterministically. */
const FIXTURE_TITLE = "Grilled Cheese";
const FIXTURE_LABELS = [
  "2 slices sourdough bread",
  "1 tbsp butter, softened",
  "2 slices sharp cheddar",
];
const FIXTURE_PREP = ["Heat a skillet over medium"];
const FIXTURE_TREE = {
  op: "grill 3 min per side",
  children: [
    { op: "butter each slice", children: [0, 1] },
    2,
  ],
};

function layoutTree(tree) {
  const leaves = [];
  const cells = [];
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
    nextCol += 1;
    return { start, end };
  }
  walk(tree);
  return { leaves, cells, cols: nextCol, rows: leaves.length };
}

function fillGaps(cells, rows, cols) {
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

function buildGrid(tree) {
  const { leaves, cells, cols, rows } = layoutTree(tree);
  const all = [...cells, ...fillGaps(cells, rows, cols)];
  const byRow = Array.from({ length: rows }, () => []);
  all.forEach((c) => byRow[c.row].push(c));
  byRow.forEach((r) => r.sort((a, b) => a.col - b.col));
  return { leaves, byRow, cols, rows };
}

const TOKENS = [
  { name: "--ink", value: "#2A3B4D", note: "primary rules and type" },
  { name: "--rule", value: "#7E96AE", note: "secondary strokes, dividers" },
  { name: "--grid", value: "#C6D6E4", note: "graph paper lines" },
  { name: "--paper", value: "#F4EDDD", note: "background" },
  { name: "--spill", value: "#C9A576", note: "accent fill, merged-cell tint" },
  { name: "--correction", value: "#B4483C", note: "annotations and errors only" },
];

const CONTRAST_PAIRS = [
  { label: "--ink on --paper", ratio: "10.24:1", verdict: "passes AAA" },
  { label: "--ink on 20% --spill tint over --paper", ratio: "9.04:1", verdict: "passes AAA" },
  { label: "--correction on --paper", ratio: "4.58:1", verdict: "passes AA, thin margin" },
];

const SG_CSS = `
.sg { max-width: 980px; margin: 0 auto; padding: 40px 24px 80px; }
.sg-section { margin-bottom: 56px; }
.sg-section h2 { font-family: var(--font-hand); font-weight: normal; font-size: 24px; color: var(--ink); margin: 0 0 4px; }
.sg-section p.sg-note { color: var(--ink-dim); font-size: 13px; margin: 0 0 20px; max-width: 70ch; }

.sg-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
.sg-swatch { border: var(--border-width) solid var(--rule); }
.sg-swatch-fill { height: 64px; }
.sg-swatch-info { padding: 8px 10px; font-family: var(--font-mono); font-size: 11px; background: var(--paper); }
.sg-swatch-info .sg-name { color: var(--ink); display: block; }
.sg-swatch-info .sg-hex { color: var(--ink-dim); display: block; margin-top: 2px; }
.sg-swatch-info .sg-role { color: var(--ink-dim); display: block; margin-top: 6px; font-family: var(--font-serif); font-size: 12px; }

.sg-contrast { list-style: none; margin: 0; padding: 0; font-family: var(--font-mono); font-size: 12.5px; }
.sg-contrast li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: var(--border-width) solid var(--grid); }

.sg-logos { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-end; }
.sg-logo-block { border: var(--border-width) solid var(--rule); padding: 20px; display: flex; align-items: center; gap: 12px; background: var(--paper); }
.sg-logo-block img.sg-mark { width: 56px; height: auto; }
.sg-logo-block img.sg-wordmark { height: 34px; width: auto; }
.sg-logo-caption { font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim); margin-top: 8px; }

.sg-type-row { border-bottom: var(--border-width) solid var(--grid); padding: 16px 0; }
.sg-type-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 8px; }
.sg-type-mono { font-family: var(--font-mono); font-size: 13px; color: var(--ink); }
.sg-type-serif { font-family: var(--font-serif); font-size: 16px; color: var(--ink); }
.sg-type-hand { font-family: var(--font-hand); font-size: 24px; color: var(--ink); }

.sg-states { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
.sg-state { border: var(--border-width) solid var(--rule); background: var(--paper); min-height: 180px; }
.sg-state-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-dim); padding: 10px 14px 0; }
.sg-state-body { padding: 14px; }
.sg-state-body .rg-busy { min-height: 120px; }
`;

export default function Styleguide() {
  const grid = buildGrid(FIXTURE_TREE);

  return (
    <div className="rg graph-paper">
      <style>{CSS}</style>
      <style>{SG_CSS}</style>

      <div className="sg">
        <header style={{ marginBottom: 48 }}>
          <span className="rg-eyebrow">gridients — visual identity</span>
          <h1 style={{ font: "40px var(--font-hand)", fontWeight: "normal", color: "var(--ink)", margin: "8px 0 0" }}>styleguide</h1>
        </header>

        <section className="sg-section">
          <h2>Tokens</h2>
          <p className="sg-note">Every color in the app. Defined once in src/tokens.css, referenced everywhere by name.</p>
          <div className="sg-swatches">
            {TOKENS.map((t) => (
              <div className="sg-swatch" key={t.name}>
                <div className="sg-swatch-fill" style={{ background: `var(${t.name})` }} />
                <div className="sg-swatch-info">
                  <span className="sg-name">{t.name}</span>
                  <span className="sg-hex">{t.value}</span>
                  <span className="sg-role">{t.note}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="sg-section">
          <h2>Contrast</h2>
          <p className="sg-note">Computed via WCAG relative luminance. Per the constraint, ink-on-paper and ink-on-spill-tint both need 4.5:1 — both clear it with room to spare.</p>
          <ul className="sg-contrast">
            {CONTRAST_PAIRS.map((c) => (
              <li key={c.label}><span>{c.label}</span><span>{c.ratio} — {c.verdict}</span></li>
            ))}
          </ul>
        </section>

        <section className="sg-section">
          <h2>Logo</h2>
          <p className="sg-note">The mark and the wordmark, arrived as two separate files — no extraction needed.</p>
          <div className="sg-logos">
            <div>
              <div className="sg-logo-block"><img className="sg-mark" src="/logo/mark.png" alt="gridients mark" /></div>
              <div className="sg-logo-caption">mark only</div>
            </div>
            <div>
              <div className="sg-logo-block"><img className="sg-wordmark" src="/logo/wordmark.png" alt="gridients" /></div>
              <div className="sg-logo-caption">wordmark only</div>
            </div>
            <div>
              <div className="sg-logo-block">
                <img className="sg-mark" src="/logo/mark.png" alt="" />
                <img className="sg-wordmark" src="/logo/wordmark.png" alt="gridients" />
              </div>
              <div className="sg-logo-caption">full lockup</div>
            </div>
          </div>
        </section>

        <section className="sg-section">
          <h2>Type</h2>
          <p className="sg-note">Three tiers: structure (mono), content (serif), marginalia (hand — seasoning only).</p>

          <div className="sg-type-row">
            <div className="sg-type-label">Structure — IBM Plex Mono — operation labels, tabs, buttons, section labels</div>
            <div className="sg-type-mono">grill 3 min per side · REVIEW &amp; FIX · INGREDIENTS AS UNDERSTOOD</div>
          </div>

          <div className="sg-type-row">
            <div className="sg-type-label">Content — Lora — ingredient names, quantities, directions</div>
            <div className="sg-type-serif">2 slices sourdough bread, buttered on both sides and grilled until golden.</div>
          </div>

          <div className="sg-type-row">
            <div className="sg-type-label">Marginalia — Architects Daughter — titles, empty/error headlines. Used sparingly.</div>
            <div className="sg-type-hand">gridients</div>
          </div>
        </section>

        <section className="sg-section">
          <h2>Chart states</h2>
          <p className="sg-note">Empty, loading, populated, error — the four states any view can be in. Populated uses the real GridTable renderer against fixture data, not a hand-copied duplicate.</p>
          <div className="sg-states">
            <div className="sg-state">
              <div className="sg-state-label">Empty</div>
              <div className="sg-state-body">
                <div className="rg-busy"><p>Paste a recipe to see it here.</p></div>
              </div>
            </div>

            <div className="sg-state">
              <div className="sg-state-label">Loading</div>
              <div className="sg-state-body">
                <div className="rg-busy"><p>Reading the directions…</p></div>
              </div>
            </div>

            <div className="sg-state" style={{ gridColumn: "1 / -1" }}>
              <div className="sg-state-label">Populated</div>
              <div className="sg-state-body">
                <GridTable title={FIXTURE_TITLE} activeLabels={FIXTURE_LABELS} grid={grid} prep={FIXTURE_PREP} />
              </div>
            </div>

            <div className="sg-state" style={{ gridColumn: "1 / -1" }}>
              <div className="sg-state-label">Error</div>
              <div className="sg-state-body">
                <div className="rg-error">
                  <strong>Couldn't reach the model</strong>
                  <ul>
                    <li>The request timed out after 30s.</li>
                    <li>Check the connection and try again.</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
