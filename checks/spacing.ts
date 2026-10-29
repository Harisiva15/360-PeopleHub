/**
 * Spacing written as a number rather than taken from the scale.
 *
 * ## What this refuses, and what it deliberately does not
 *
 * `--sp-1` to `--sp-5` in `global.css` are the spacing scale: 6, 10, 16, 22,
 * 32. An inline `style={{ padding: 12 }}` is off it, and the alignment probe
 * reports every rendered instance of one — which is how a single line in a
 * screen became four figures of findings.
 *
 * This is a **ratchet, not a target.** It fails when the count goes *up*, and
 * the baseline comes down as screens are touched. Demanding all 451 be fixed
 * first would mean one enormous change to eighty-one files, reviewed by nobody,
 * for a visual result nobody asked for. Refusing the four hundred and
 * fifty-second gets the same place without that change existing.
 *
 * It reads the scale out of `global.css` rather than restating it, so the two
 * cannot drift. If somebody adds a step, this check knows.
 *
 * ## Why it looks at source and not at the stylesheet
 *
 * `check:styles` already ratchets the *stylesheet's* distinct `padding` and
 * `gap` values. This is the other half: spacing written in TSX, as an inline
 * style attribute, which never appears in a stylesheet and so was unmeasured.
 * That is where all 451 live — the stylesheet itself is on-scale.
 *
 * ## The scale's own limits, which this check does not pretend to settle
 *
 * 6px is the smallest step, and 67 of the 451 are 2, 3 or 4px — a chart's label
 * offset, a badge's optical nudge. Those are not layout spacing and snapping
 * them to 6 would make the design worse, not more consistent. So the ratchet
 * counts them without claiming they are wrong; whether the scale needs a fine
 * step below 6 is a design decision and is recorded as one in the report this
 * prints, not decided here.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

/* ---------------- the scale, read from the stylesheet ---------------- */

const css = readFileSync('src/styles/global.css', 'utf8');

/*
 * Every `--sp-N: Mpx` declaration, however they are packed onto a line. Zero is
 * always on the scale: "no spacing" is not a magic number.
 */
const scale = new Set<number>([0]);
for (const m of css.matchAll(/--sp-[\w-]+\s*:\s*([0-9]+(?:\.[0-9]+)?)px/g)) {
  scale.add(Number(m[1]));
}

ok('the spacing scale is defined in global.css', scale.size > 1,
  'no --sp-* custom properties found, so there is nothing to measure against');

const steps = [...scale].sort((a, b) => a - b);
console.log(`  note  scale: ${steps.join('/')}`);

/* ---------------- the files, including ones not yet committed ---------------- */

/*
 * Tracked files *and* new ones that are not ignored.
 *
 * `git ls-files` alone is what several checks in this repo use, and it has bitten
 * us: a new screen that has not been `git add`ed is invisible, so the check runs
 * green locally and fails in CI after the commit — or worse, passes both and the
 * values are simply never counted. `--others --exclude-standard` is the second
 * half, and makes a local run and a CI run agree.
 */
const listed = (args: string) => {
  try {
    return execSync(`git ls-files ${args}`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const files = [...new Set([
  ...listed('"src/*.tsx" "src/**/*.tsx" "src/*.ts" "src/**/*.ts"'),
  ...listed('--others --exclude-standard "src/*.tsx" "src/**/*.tsx" "src/*.ts" "src/**/*.ts"'),
])].sort();

ok('there are source files to read', files.length > 0, `found ${files.length}`);

/* ---------------- the scan ---------------- */

/*
 * A spacing key in an object literal and the pixel values in it. `padding`,
 * `margin`, `gap` and their long forms — `paddingTop`, `marginInlineStart`,
 * `rowGap`. A bare number in a JSX style object is pixels, so it counts too.
 *
 * Whole-file, not line by line, because a `style={{ ... }}` spanning four lines
 * is the common shape and a line-based scan misses it — which is how the first
 * count of this came out at 68 instead of 451.
 */
const DECL = /\b(margin|padding|gap|rowGap|columnGap)([A-Za-z]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([0-9.]+))/g;

interface Hit { file: string; line: number; key: string; value: string; off: number[] }

const hits: Hit[] = [];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(DECL)) {
    const quoted = m[3] ?? m[4] ?? m[5];
    const bare = m[6];
    const value = quoted ?? bare ?? '';
    const nums = quoted !== undefined
      ? [...quoted.matchAll(/([0-9]+(?:\.[0-9]+)?)px/g)].map((x) => Number(x[1]))
      : bare !== undefined ? [Number(bare)] : [];
    const off = nums.filter((n) => !scale.has(n));
    if (!off.length) continue;
    hits.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      key: m[1]! + m[2]!,
      value,
      off,
    });
  }
}

/* ---------------- the report ---------------- */

const SHARED = /^src\/components\//;
const shared = hits.filter((h) => SHARED.test(h.file));

const byValue = new Map<number, number>();
for (const h of hits) for (const n of h.off) byValue.set(n, (byValue.get(n) ?? 0) + 1);

const fine = [...byValue.entries()]
  .filter(([n]) => n > 0 && n < steps[1]!)
  .reduce((a, [, c]) => a + c, 0);

console.log(`  note  ${hits.length} off-scale declaration(s) in ${
  new Set(hits.map((h) => h.file)).size} file(s)`);
console.log(`  note  ${shared.length} in src/components, ${
  hits.length - shared.length} in module screens`);
console.log(`  note  ${fine} are finer than the scale's smallest step (${
  steps[1]}px) — optical, not layout`);

/* ---------------- the ratchets ---------------- */

/*
 * Two numbers, because they decay at different speeds and for different
 * reasons. The shared components are few and worth holding at zero-ish; the
 * module screens are the long tail and come down as each screen is next
 * touched. One combined cap would let a new one in a shared component hide
 * behind a fix in a screen.
 */
const TOTAL_CAP = 446;
/*
 * Two, and both deliberate: a 4px gap between an HBar's label and its bar, and
 * a 2px offset under a donut's centre figure. Neither is layout spacing and the
 * scale's smallest step is 6px, so snapping them would change the drawing to
 * satisfy a rule about boxes. They are counted, not excused — if a fine step is
 * ever added to the scale they stop being off it.
 */
const SHARED_CAP = 2;

const ratchet = (label: string, got: number, cap: number) => {
  ok(`${label} stays within ${cap}`, got <= cap,
    got > cap
      ? `now ${got}. A new off-scale spacing value was added. Use a --sp step, `
        + 'or if the design genuinely needs a value the scale does not have, add '
        + 'the step to global.css and raise this cap in the same change.'
      : `now ${got}`);
  if (got < cap) {
    console.log(`  note  ${label} is ${cap - got} below its cap — `
      + `lower it to ${got} in checks/spacing.ts so the ground is held`);
  }
};

ratchet('off-scale spacing in source', hits.length, TOTAL_CAP);
ratchet('off-scale spacing in shared components', shared.length, SHARED_CAP);

/* The worst offenders, so the next person touching one knows. */
if (hits.length) {
  const byFile = new Map<string, number>();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
  console.log('\n  the screens carrying the most, for when they are next touched:');
  [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .forEach(([f, n]) => console.log(`    ${String(n).padStart(3)}  ${f}`));
}

if (shared.length) {
  console.log('\n  and every one in a shared component, which reaches every screen:');
  shared.forEach((h) => console.log(`    ${h.file}:${h.line}  ${h.key}: ${h.value}`));
}

console.log();
if (failed) {
  console.error(`${failed} spacing check(s) failed`);
  process.exit(1);
}
console.log('spacing comes from the scale, and no new value was invented');
