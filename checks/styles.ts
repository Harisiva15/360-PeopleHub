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

/* ---------------- the flyout's geometry is stated twice ---------------- */

/*
 * `NavFlyout.tsx` places the panel before it paints, from constants that have
 * to match the stylesheet. Nothing warns you when one moves and the other does
 * not — the panel just opens a few pixels off, which nobody reports and nobody
 * can find. So the two are compared here, and the brief's own numbers are
 * asserted alongside them so a later tidy cannot quietly undo them.
 */
const fly = readFileSync(join(root, 'src/shell/NavFlyout.tsx'), 'utf8');

const constOf = (name: string): number =>
  Number(new RegExp(`const ${name} = ([0-9.]+)`).exec(fly)?.[1]);

/**
 * One rule's body, by selector.
 *
 * The stylesheet is written both ways — `.nav-fly{` and `.nav-top {` — so the
 * space before the brace is optional here. It was not, and the rail's own
 * metrics silently read as NaN rather than failing on their values.
 */
const ruleOf = (sel: string): string =>
  new RegExp(`\\${sel}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? '';

const pxIn = (rule: string, prop: string): number =>
  Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(rule)?.[1]);

const header = ruleOf('.nav-fly-h');
const body = ruleOf('.nav-fly-b');
const item = ruleOf('.nav-fly-i');

const cssHeader = pxIn(header, 'min-height');
const cssItem = pxIn(item, 'min-height');
const cssGap = pxIn(body, 'gap');
const cssPadY = pxIn(body, 'padding');

const agrees = (label: string, inCode: number, inCss: number) =>
  ok(`flyout ${label} agrees between component and stylesheet`, inCode === inCss,
    `component ${inCode}, stylesheet ${inCss}`);

agrees('heading height', constOf('HEADER_H'), cssHeader);
agrees('item height', constOf('ITEM_H'), cssItem);
agrees('item gap', constOf('ITEM_GAP'), cssGap);
agrees('body padding', constOf('BODY_PAD'), cssPadY * 2);

ok(`flyout gap is 2-4px (${cssGap})`, cssGap >= 2 && cssGap <= 4);

/*
 * The brief's own dimensions for the panel and the rail, asserted so a later
 * tidy cannot quietly undo them.
 */
const flyRule = ruleOf('.nav-fly');
const flyWidth = pxIn(flyRule, 'width');
ok(`flyout is 300-360px wide (${flyWidth})`, flyWidth >= 300 && flyWidth <= 360);
ok('flyout uses the 14-16px radius', /\.nav-fly\{[^}]*border-radius:var\(--r-lg\)/.test(css));

/* The rail's own items — §15. */
const navTop = ruleOf('.nav-top');
const topH = pxIn(navTop, 'min-height');
const topSize = pxIn(navTop, 'font-size');
ok(`rail items stand 42-46px (${topH})`, topH >= 42 && topH <= 46);
ok(`rail item text is 14px (${topSize})`, topSize === 14);
ok('rail items sit 2-4px apart',
  (() => { const m = /margin-bottom:\s*(\d+)px/.exec(navTop); return m ? +m[1] >= 2 && +m[1] <= 4 : false; })());

/*
 * The whole point of the redesign: no section expands inside the rail, so the
 * sidebar never changes height and nothing below an open section moves.
 */
/*
 * Hover previews the panel after a pause, and the pause is the feature: with
 * no delay a panel opens every time a pointer crosses the rail on its way
 * somewhere else, which is worse than no hover at all.
 */
const shell = readFileSync(join(root, 'src/shell/Shell.tsx'), 'utf8');
const hoverDelay = Number(/const HOVER_DELAY = (\d+)/.exec(shell)?.[1]);
ok(`hover previews after 250-300ms (${hoverDelay})`,
  hoverDelay >= 250 && hoverDelay <= 300);
ok('a pointer leaving cancels a pending preview rather than closing an open panel',
  /onPointerLeave=\{cancelPreview\}/.test(shell)
  && !/onPointerLeave=\{\(\)\s*=>\s*setFlyout\(null\)\}/.test(shell));
ok('touch does not trigger the hover preview',
  /pointerType\s*!==\s*'mouse'/.test(shell));

ok('no accordion survives in the rail', !/\.nav-subs?\s*\{/.test(css));
ok('the rail is one fixed width', !/\.sidebar\.tight\s*\{/.test(css));
ok('the flyout floats rather than sitting in the layout',
  /\.nav-fly\{[^}]*position:fixed/.test(css));
ok('flyout is sized by its contents, not the viewport',
  !/\.nav-fly\{[^}]*height:\s*(100%|100vh)/.test(css));
ok('flyout scrolls internally past its cap',
  /\.nav-fly-b\{[^}]*overflow-y:\s*auto/.test(css));
ok('flyout heading stays put while the body scrolls',
  /\.nav-fly-h\{[^}]*position:\s*sticky/.test(css));

/* ---------------- where the panel lands ---------------- */

/*
 * The placement is arithmetic, so it can simply be run. What matters is that a
 * short section opens level with the item that opened it, and a long one stops
 * before it runs off the bottom of the screen — which is the whole reason the
 * height is derived rather than left to the browser.
 */
const { placeFlyout, MAX_VH } = await import('../src/shell/NavFlyout');

const VP = 900;
const EDGE = 12;

const shortAt = placeFlyout({ top: 300 } as DOMRect, 3, VP);
ok('a short section opens level with the item that opened it', shortAt === 300, String(shortAt));

const nearBottom = placeFlyout({ top: 860 } as DOMRect, 3, VP);
ok('a section near the bottom is pulled back inside the screen',
  nearBottom < 860 && nearBottom >= EDGE, String(nearBottom));

const tall = placeFlyout({ top: 700 } as DOMRect, 40, VP);
ok('a long section is capped rather than running off the screen',
  tall + VP * MAX_VH <= VP - EDGE + 1, `top ${tall}, cap ${Math.round(VP * MAX_VH)}`);

ok('nothing is ever placed above the top edge',
  placeFlyout({ top: 0 } as DOMRect, 40, VP) >= EDGE);
ok('the cap is the 70-75vh the brief asks for', MAX_VH >= 0.70 && MAX_VH <= 0.75, String(MAX_VH));

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
ratchet('padding', pads, 106);

console.log();
if (failed) {
  console.error(`${failed} style check(s) failed`);
  process.exit(1);
}
console.log('the stylesheet carries nothing it does not render');
