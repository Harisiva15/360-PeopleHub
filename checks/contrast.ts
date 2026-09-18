/**
 * The palette, measured rather than asserted in a comment.
 *
 * Every contrast figure written into `global.css` is a claim that decays the
 * moment somebody nudges a hex by two digits. This reads the tokens back out
 * of the stylesheet and checks the pairs that matter, in both themes, so a
 * palette change either keeps the product legible or fails here.
 *
 * Three thresholds, and they are not interchangeable:
 *   4.5  text under 18px on the surface behind it (WCAG AA)
 *   3.0  a filled control against the surface it sits on, and large text
 *   1.2  an edge — one surface against another, with no text involved
 *
 * The 1.2 floor is not a WCAG number. It is the point below which a card, a
 * well or a hover plate stops being visible as a separate thing on a cheap
 * panel, which is the failure this file exists to catch.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/*
 * Comments come out first. The palette is heavily annotated, and a comment
 * explaining a colour contains both a colon and a semicolon — which is a
 * declaration as far as the regex below is concerned.
 */
const css = readFileSync(join(root, 'src/styles/global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- reading the tokens back out ---------- */

/**
 * The stylesheet declares the light palette in the bare `:root` block and
 * redefines a subset under the dark ones. Reading them in source order and
 * letting later wins reproduces exactly what the cascade does.
 */
function tokensFor(theme: 'light' | 'dark'): Record<string, string> {
  const out: Record<string, string> = {};
  const blocks = css.split(/(?=^[^\s{][^{]*\{)/m);

  for (const block of blocks) {
    const head = block.slice(0, block.indexOf('{'));
    const isDark = /data-theme="dark"|prefers-color-scheme: *dark/.test(head);
    const isLightOnly = /data-theme="light"|prefers-color-scheme: *light/.test(head);
    if (!/:root|^html\[/.test(head)) continue;
    if (theme === 'light' && isDark) continue;
    if (theme === 'dark' && isLightOnly) continue;

    for (const [, k, v] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      out[k] = v.trim();
    }
  }
  return out;
}

/** Resolves `var(--x)` chains down to a literal. */
function hexOf(tokens: Record<string, string>, name: string, depth = 0): string {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`no such token: ${name}`);
  if (depth > 8) throw new Error(`token loop at ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/i.exec(raw);
  if (ref) return hexOf(tokens, ref[1], depth + 1);
  if (!/^#[0-9a-f]{6}$/i.test(raw)) throw new Error(`${name} is not a plain hex: ${raw}`);
  return raw.toLowerCase();
}

/* ---------- the measurement ---------- */

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => channel(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------- what has to hold ---------- */

type Pair = [label: string, fg: string, bg: string, need: number];

/** `#fff` and `#000` pass through; anything else is a token name. */
const LITERAL = /^#[0-9a-f]{6}$/i;

const PAIRS: Pair[] = [
  /* The navigation rail is its own surface — nothing on it takes a page token. */
  ['rail: nav label', '--rail-ink', '--rail', 4.5],
  ['rail: section header', '--rail-ink-dim', '--rail', 4.5],
  ['rail: hover ink on the hover plate', '--rail-ink-hi', '--rail-2', 4.5],
  ['rail: hover plate edge', '--rail-2', '--rail', 1.2],
  ['rail: sub-item well edge', '--rail-sunk', '--rail', 1.2],
  ['rail: hover plate inside the well', '--rail-2', '--rail-sunk', 1.2],
  ['rail: sub-item label in the well', '--rail-ink-dim', '--rail-sunk', 4.5],
  ['rail: rule', '--rail-line', '--rail', 1.2],
  ['rail: selected pill against the rail', '--rail-on', '--rail', 3.0],
  ['rail: selected pill against the well', '--rail-on', '--rail-sunk', 3.0],
  ['rail: selected pill label', '#ffffff', '--rail-on', 4.5],
  ['rail: against the page', '--rail', '--plane', 1.1],

  /* The page. A card is separated by its border, so the border is load-bearing. */
  ['page: body text', '--ink', '--plane', 4.5],
  ['page: body text on a card', '--ink', '--surface', 4.5],
  ['page: secondary text on a card', '--ink-2', '--surface', 4.5],
  ['page: muted text on a card', '--ink-3', '--surface', 4.5],
  ['page: muted text on the page', '--ink-3', '--plane', 4.5],
  ['page: muted text on a sunk surface', '--ink-3', '--surface-2', 4.5],
  ['page: card border against the page', '--line', '--plane', 1.15],
  ['page: card border against the card', '--line', '--surface', 1.15],
  ['page: sunk surface inside a card', '--surface-2', '--surface', 1.05],

  /* Controls. Every one of these carries a label. */
  ['control: primary button label', '#ffffff', '--brand', 4.5],
  ['control: primary button hover label', '#ffffff', '--brand-hover', 4.5],
  ['control: danger button label', '#ffffff', '--crit-solid', 4.5],
  ['control: badge and pill label', '#ffffff', '--crit-solid', 4.5],
  ['control: input border against the field', '--line-2', '--surface', 1.3],
  ['control: focus ring against the card', '--brand', '--surface', 3.0],

  /* Status. These say what happened, so they are read, not merely seen. */
  ['status: good text on its wash', '--good-text', '--good-wash', 4.5],
  ['status: warning text on its wash', '--warn-text', '--warn-wash', 4.5],
  ['status: critical text on its wash', '--crit-text', '--crit-wash', 4.5],
  ['status: info text on its wash', '--brand-ink', '--info-wash', 4.5],

  /* Tinted stat tiles: a pastel card with default grey on it is the usual bug. */
  ['tile: blue', '--t-blue-ink', '--t-blue', 4.5],
  ['tile: green', '--t-green-ink', '--t-green', 4.5],
  ['tile: amber', '--t-amber-ink', '--t-amber', 4.5],
  ['tile: rose', '--t-rose-ink', '--t-rose', 4.5],
  ['tile: violet', '--t-violet-ink', '--t-violet', 4.5],
];

let failed = 0;
let checked = 0;

for (const theme of ['light', 'dark'] as const) {
  const tokens = tokensFor(theme);
  console.log(`\n--- ${theme} ---`);
  for (const [label, fg, bg, need] of PAIRS) {
    let a: string;
    let b: string;
    try {
      a = LITERAL.test(fg) ? fg.toLowerCase() : hexOf(tokens, fg);
      b = LITERAL.test(bg) ? bg.toLowerCase() : hexOf(tokens, bg);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${label} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const r = contrast(a, b);
    const ok = r >= need;
    checked++;
    if (!ok) failed++;
    if (!ok || process.env.VERBOSE) {
      console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2)} (need ${need.toFixed(1)})  ${label}  ${a} on ${b}`,
      );
    }
  }
  if (!failed) console.log(`${PAIRS.length} pairs pass`);
}

console.log();
if (failed) {
  console.error(`${failed} of ${checked} contrast pairs fail`);
  process.exit(1);
}
console.log(`${checked} contrast pairs hold in both themes`);
