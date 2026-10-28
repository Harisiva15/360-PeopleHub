/**
 * Spacing that does not come from the scale, read from the stylesheet.
 *
 * The DOM half of this check (in `probe.ts`) can only see inline styles. Every
 * other one-off is a declaration in `global.css`, and the stylesheet is where
 * it has to be fixed — so this reads the source rather than the render.
 *
 * The scale is `--sp-1: 6px` through `--sp-5: 32px`. A declaration is a finding
 * when it hard-codes a px value for margin, padding or gap that is not on that
 * scale and is not one of the values a layout legitimately needs outside it:
 * `0`, and 1–2px, which are hairlines and optical nudges rather than spacing
 * decisions.
 *
 * Output is grouped by value, because that is how it gets fixed: every `9px`
 * gap in the file is one decision made eleven times, and the question to
 * answer is "is this --sp-2 or is it --sp-1", once.
 *
 *   node audit/alignment/tokens.mjs
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCALE = { 6: '--sp-1', 10: '--sp-2', 16: '--sp-3', 22: '--sp-4', 32: '--sp-5' };
/** Allowed off-scale: nothing, and hairlines. */
const FREE = [0, 1, 2];

const STYLES = 'src/styles';
const PROP = /(^|[;{\s])(margin|padding|gap|row-gap|column-gap)(-top|-right|-bottom|-left|-block|-inline)?\s*:\s*([^;}]+)/g;

/** Which shared component a selector belongs to, so findings group by owner. */
const OWNERS = [
  [/\.tbl-wrap/, 'TableWrap (ui.tsx)'],
  [/\.tbl\b/, 'Table (ui.tsx)'],
  [/\.tabs\b/, 'Tabs (ui.tsx)'],
  [/\.toolbar\b/, 'toolbar (global.css)'],
  [/\.field\b/, 'field (global.css)'],
  [/\.card-h\b/, 'Card header (ui.tsx)'],
  [/\.card-b\b/, 'Card body (ui.tsx)'],
  [/\.card\b/, 'Card (ui.tsx)'],
  [/\.kv\b/, 'KV (ui.tsx)'],
  [/\.seg\b/, 'Seg (ui.tsx)'],
  [/\.pager\b/, 'Pager (ui.tsx)'],
  [/\.badge\b/, 'Badge (ui.tsx)'],
  [/\.tile\b/, 'Tile (ui.tsx)'],
  [/\.empty\b/, 'EmptyState (ui.tsx)'],
  [/\.retry\b/, 'RetryNotice (ui.tsx)'],
  [/\.banner\b/, 'Banner (ui.tsx)'],
  [/\.modal|\.drawer/, 'Layer (Layer.tsx)'],
  [/\.topbar/, 'TopBar (shell)'],
  [/\.nav\b|\.nav-/, 'Menu (Menu.tsx)'],
  [/\.btn\b/, 'button (global.css)'],
  [/\.row\b/, 'row (global.css)'],
  [/\.grid\b/, 'grid (global.css)'],
];

const ownerOf = (selector) => {
  for (const [re, name] of OWNERS) if (re.test(selector)) return name;
  return 'page or one-off selector';
};

/**
 * Walk a stylesheet declaration by declaration, keeping the selector each one
 * sits under and the line it is on. A real parser would be better; this file
 * is hand-written CSS with one rule per line in most places, and the selector
 * is whatever last preceded a `{`.
 */
function scan(path, text) {
  const out = [];
  const lines = text.split('\n');
  let selector = '?';
  let depth = 0;

  lines.forEach((line, i) => {
    /* An at-rule block (a media query) does not change the selector. */
    const open = line.indexOf('{');
    if (open !== -1 && !/^\s*@/.test(line)) {
      const head = line.slice(0, open).trim();
      if (head) selector = head.replace(/\s+/g, ' ');
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

    PROP.lastIndex = 0;
    let m;
    while ((m = PROP.exec(line)) !== null) {
      const prop = m[2] + (m[3] || '');
      const value = m[4].trim();
      /* A token, a keyword or a calc is the right answer, not a finding. */
      if (/var\(|calc\(|auto|inherit|initial|unset|%|em\b|rem\b/.test(value)) continue;
      const pxs = value.match(/-?\d+(?:\.\d+)?px/g);
      if (!pxs) continue;
      for (const px of pxs) {
        const n = Math.abs(parseFloat(px));
        if (FREE.includes(n) || SCALE[n]) continue;
        out.push({
          file: path, line: i + 1, selector, prop, value, px: n,
          nearest: nearestToken(n), owner: ownerOf(selector),
        });
      }
    }
  });
  return out;
}

const nearestToken = (n) => {
  const keys = Object.keys(SCALE).map(Number);
  const best = keys.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
  return `${SCALE[best]} (${best}px)`;
};

const files = readdirSync(STYLES).filter((f) => f.endsWith('.css'));
const all = files.flatMap((f) => scan(`${STYLES}/${f}`, readFileSync(join(STYLES, f), 'utf8')));

const byValue = new Map();
for (const f of all) {
  const list = byValue.get(f.px) || [];
  list.push(f);
  byValue.set(f.px, list);
}

const byOwner = new Map();
for (const f of all) {
  const list = byOwner.get(f.owner) || [];
  list.push(f);
  byOwner.set(f.owner, list);
}

console.log(`\n${all.length} off-scale spacing declarations in ${files.length} stylesheets\n`);
console.log('by value:');
[...byValue.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([px, list]) => {
  console.log(`  ${String(px).padStart(5)}px  ×${String(list.length).padStart(3)}  → ${nearestToken(px)}`);
});
console.log('\nby component:');
[...byOwner.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([owner, list]) => {
  console.log(`  ${String(list.length).padStart(3)}  ${owner}`);
});

mkdirSync('alignment-audit/_findings', { recursive: true });
writeFileSync('alignment-audit/_findings/css-tokens.json', JSON.stringify(all, null, 2));
console.log('\nwritten: alignment-audit/_findings/css-tokens.json');
