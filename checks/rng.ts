/**
 * Probabilities that are always true.
 *
 * `chance(p)` is `rnd() < p`, where `rnd()` returns 0–1. So `chance(30)` does
 * not mean thirty percent — it means always, silently, with no error and no
 * visible symptom beyond a book that is subtly uniform.
 *
 * This is not hypothetical. A seeded sign-in history was written with
 * `chance(30)` for the second factor, `chance(12)` for an away address,
 * `chance(55)` for a matching sign-out and `chance(35)` for an idle timeout.
 * Every one of them was always true, so every sign-in in the book came from a
 * mobile device on an away address, every session ended, and every ending was
 * an inactivity timeout. Nothing failed. The book simply stopped containing
 * the variety the screens were built to show, and the bug surfaced only when a
 * security figure derived from it read exactly 100%.
 *
 * A percentage where a fraction belongs is an easy slip and an invisible one.
 * This makes it loud.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const files = execSync('git ls-files src', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.tsx?$/.test(f));

/* Every chance() call with a literal argument, and where it is. */
const calls: { file: string; line: number; arg: number; text: string }[] = [];
for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8');
  src.split('\n').forEach((line, i) => {
    // A numeric literal only. `chance(reach)` and `chance(appetite)` pass a
    // variable, whose value this cannot see and does not guess at.
    for (const m of line.matchAll(/\bchance\(\s*(\d+(?:\.\d+)?)\s*\)/g)) {
      calls.push({ file: rel, line: i + 1, arg: Number(m[1]), text: line.trim() });
    }
  });
}

console.log('\nseeded probabilities\n');

/*
 * Vacuity guard. If the pattern stops matching — chance() renamed, calls moved
 * behind a helper — this file would otherwise print a clean pass over nothing,
 * which is the exact failure mode it exists to catch elsewhere.
 */
ok(`found ${calls.length} literal chance() calls to check`, calls.length >= 20,
  'Fewer than expected. The pattern has stopped matching and this check is blind.');

const always = calls.filter((c) => c.arg >= 1);
ok('no probability is always true', always.length === 0,
  always.map((c) => `${c.file}:${c.line}  chance(${c.arg}) — always true. `
    + `Did you mean chance(${c.arg / 100})?\n            ${c.text}`).join('\n        '));

const never = calls.filter((c) => c.arg === 0);
ok('no probability is always false', never.length === 0,
  never.map((c) => `${c.file}:${c.line}  chance(0) — the branch is dead.`).join('\n        '));

/*
 * A book where everything is near-certain has the same problem in a milder
 * form: the rare case the screen exists to handle never appears. Reported
 * rather than failed, because a genuinely near-universal fact is legitimate.
 */
const high = calls.filter((c) => c.arg >= 0.97 && c.arg < 1);
if (high.length) {
  console.log(`\n  note  ${high.length} probability(ies) at or above 0.97:`);
  for (const c of high) console.log(`        ${c.file}:${c.line}  chance(${c.arg})`);
}

console.log(`\n${failed ? `${failed} FAILED` : 'every seeded probability is a fraction'}\n`);
process.exit(failed ? 1 : 0);
