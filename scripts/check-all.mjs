/*
 * Run every check suite, then say what failed.
 *
 * It replaced a chain of `npm run a && npm run b && ...`, which had two faults.
 *
 * It stopped at the first failure. One stale fixture in the first suite meant
 * the other fifty never ran, so the report was "something is broken" rather
 * than "these four things are broken" - and the only way to see the rest was to
 * fix the first one and run the lot again.
 *
 * And the list was written by hand, so a suite could exist and never run.
 * `check:shape` did exactly that: defined, wired to checks/api-shape.ts, absent
 * from the chain. The same thing had already happened in CI with ten of
 * twenty-four database suites. The list is derived now: every `check` and
 * `check:*` script except this one, in the order the chain had them, with
 * anything the chain omitted appended and called out.
 *
 * Exit code is 1 if any suite failed, so it is still usable as a gate.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = pkg.scripts ?? {};

/* `check:chain` is the old hand-written order, kept only so this can read it. */
const META = new Set(['check:all', 'check:chain']);
const defined = Object.keys(scripts)
  .filter((k) => (k === 'check' || k.startsWith('check:')) && !META.has(k));

/* The order the old chain used, so output stays comparable run to run. */
const chain = [...String(scripts['check:chain'] ?? '').matchAll(/npm run (check(?::[a-z:]+)?)/g)]
  .map((m) => m[1])
  .filter((k) => !META.has(k));

const ordered = [...chain.filter((k) => defined.includes(k))];
const appended = defined.filter((k) => !ordered.includes(k));
ordered.push(...appended);

if (appended.length) {
  console.log(`note: ${appended.length} suite(s) defined but absent from the chain, running anyway: ${appended.join(', ')}`);
  console.log('');
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const run = only.length ? ordered.filter((k) => only.includes(k)) : ordered;

const failed = [];
const passed = [];
const started = Date.now();

for (const name of run) {
  const t0 = Date.now();
  process.stdout.write(`\n── ${name} ──\n`);
  const r = spawnSync('npm', ['run', '--silent', name], {
    stdio: 'inherit',
    shell: true,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status === 0) passed.push({ name, secs });
  else failed.push({ name, secs, code: r.status ?? -1 });
}

const total = ((Date.now() - started) / 1000).toFixed(0);

console.log('');
console.log('─'.repeat(64));
console.log(`${passed.length} passed, ${failed.length} failed, ${run.length} run in ${total}s`);

if (failed.length) {
  console.log('');
  console.log('failed:');
  for (const f of failed) console.log(`  ${f.name}  (exit ${f.code}, ${f.secs}s)`);
  console.log('');
  console.log('Scroll up for each suite\'s own output, under its heading.');
  process.exit(1);
}

console.log('every suite green');
process.exit(0);
