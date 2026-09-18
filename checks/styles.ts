/**
 * The stylesheet, kept honest.
 *
 * Two things rot in a stylesheet that nobody notices until the interface looks
 * untidy and no one can say why.
 *
 * **Rules for markup that no longer exists.** Harmless until one of them
 * outranks a live rule. That is not hypothetical here: a leftover `.nav a`
 * block sat at specificity 0-1-1 and beat both `.nav-top` and `.nav-sub`
 * (0-1-0) on every property they shared, so sidebar sub-items were drawn at
 * the parent's size and links stood 2px taller than buttons beside them.
 * Nobody wrote that; it accumulated.
 *
 * **Values invented at the call site.** A radius scale is only a scale while
 * everything uses it. This file counts the raw ones and fails once they
 * outnumber what the scale can explain.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = join(root, 'src/styles/global.css');
const css = readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + detail}`);
};

/* ---------------- classes nothing renders ---------------- */

const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => /\.tsx?$/.test(f));

const rendered = new Set<string>();
for (const rel of files) {
  const s = readFileSync(join(root, rel), 'utf8');
  for (const m of s.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const blob = m[1] ?? m[2] ?? '';
    for (const w of blob.matchAll(/[a-zA-Z][\w-]*/g)) rendered.add(w[0]);
    for (const w of blob.matchAll(/'([^']*)'/g)) {
      for (const t of w[1].split(/\s+/)) if (t) rendered.add(t);
    }
  }
  for (const m of s.matchAll(/\bid="([^"]+)"/g)) rendered.add(m[1]);
  /* Tooltip builds its element in JS rather than JSX. */
  for (const m of s.matchAll(/\.className\s*=\s*'([^']+)'/g)) rendered.add(m[1]);
}

/**
 * Names assembled at runtime, which no scan of the source can see whole:
 * `'b-' + kind`, `'t-' + tone`, `'grid g' + cols`, a modal's size, an
 * attendance status code used as a class.
 */
const COMPOSED = new Set([
  'b-good', 'b-warn', 'b-crit', 'b-info', 'b-mute',
  't-blue', 't-green', 't-amber', 't-rose', 't-violet',
  'g4', 'g5', 'narrow', 'wide', 'start', 'end', 'up', 'down', 'drag',
  'lg', 'xl', 'sr', 'acc', 'good', 'info', 'note', 'money',
  'A', 'H', 'L', 'O', 'P', 'W',
]);

const defined = new Set<string>();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);

const dead = [...defined].filter((c) => !rendered.has(c) && !COMPOSED.has(c)).sort();
ok(
  `${defined.size} classes defined, every one of them rendered`,
  dead.length === 0,
  `never rendered: ${dead.join(' ')}`,
);

/* ---------------- values off the scale ---------------- */

const raw = [...css.matchAll(/border-radius:\s*([^;}]+)/g)]
  .map((m) => m[1]!.trim())
  .filter((v) => /^\d+px$/.test(v));

/*
 * A handful of literals are deliberate: 3px and 4px on markers a few pixels
 * across, where the nearest step would round the corner away entirely.
 */
const ALLOWED_RAW = new Set(['3px', '4px', '18px']);
const offScale = raw.filter((v) => !ALLOWED_RAW.has(v));
ok(
  'every single-value border-radius comes from the scale',
  offScale.length === 0,
  `off the scale: ${[...new Set(offScale)].join(', ')}`,
);

/* ---------------- the spread, as information ---------------- */

const spread = (label: string, re: RegExp) => {
  const vals = new Set([...css.matchAll(re)].map((m) => m[1]!.trim()));
  console.log(`  note  ${label}: ${vals.size} distinct`);
  return vals.size;
};

spread('border-radius', /border-radius:\s*([^;}]+)/g);
const sizes = spread('font-size', /font-size:\s*([^;}]+)/g);
const gaps = spread('gap', /(?<!row-|column-)\bgap:\s*([^;}]+)/g);
const pads = spread('padding', /(?<!-)\bpadding:\s*([^;}]+)/g);

/*
 * Ratchets, not targets. They fail on a *new* value being invented rather than
 * demanding the existing spread be tidied first — so the number comes down as
 * screens are touched, and never goes up by accident.
 */
const ratchet = (label: string, got: number, cap: number) =>
  ok(`${label} stays within ${cap} distinct values`, got <= cap, `now ${got}`);

ratchet('font-size', sizes, 31);
ratchet('gap', gaps, 28);
ratchet('padding', pads, 102);

console.log();
if (failed) {
  console.error(`${failed} style check(s) failed`);
  process.exit(1);
}
console.log('the stylesheet carries nothing it does not render');
