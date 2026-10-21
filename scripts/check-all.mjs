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
 *
 * ## A skip is not a pass
 *
 * It used to count one as a pass, and that is how a broken suite reached CI.
 * `check:photo` needs a database, so locally it printed SKIPPED and exited 0;
 * the summary said "61 passed, every suite green"; and the thing that was
 * actually broken — it could not start without `tsx`, which the Pages workflow
 * does not install — was on a path a skipping run never reaches. The gate was
 * green and the deploy failed ten minutes later.
 *
 * So a skip is now its own outcome, counted and named. It does not fail the
 * gate, because skipping is legitimate: the frontend checks have no database
 * and are not meant to. What it does is stop a green line from claiming
 * coverage that was never exercised.
 *
 * A suite that skips only part of itself is listed here too — `check:roles`
 * runs its static half and skips the runtime half without a database, and
 * that half is no more exercised than a whole suite would be. The line the
 * suite printed is shown next to it, and says which case it is.
 *
 * Detecting it needs the suite's output, which is why the child's streams are
 * piped and written through rather than inherited: a 90-second suite must
 * still print as it goes, and buffering until it exits would have made this
 * change cost more than it is worth.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

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
const skipped = [];
const started = Date.now();

/*
 * One command string rather than a command and an argument array: with
 * `shell: true` the two are concatenated anyway, and passing them separately
 * earns a deprecation warning (DEP0190) on every one of sixty-one suites. The
 * names come from our own package.json keys.
 */
const runSuite = (name) => new Promise((resolve) => {
  const child = spawn(`npm run --silent ${name}`, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
  let text = '';
  const tee = (src, dst) => src.on('data', (chunk) => {
    const s = chunk.toString();
    text += s;
    dst.write(s);
  });
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);
  child.on('error', (e) => resolve({ code: -1, text: `${text}\n${e.message}` }));
  child.on('close', (code) => resolve({ code: code ?? -1, text }));
});

for (const name of run) {
  const t0 = Date.now();
  process.stdout.write(`\n── ${name} ──\n`);
  // eslint-disable-next-line no-await-in-loop
  const { code, text } = await runSuite(name);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  /* The suite's own words for what it left out, so the summary can quote it. */
  const why = text.split(/\r?\n/).find((l) => /\bSKIPPED\b/.test(l))?.trim();
  if (code !== 0) failed.push({ name, secs, code });
  else if (why) skipped.push({ name, secs, why });
  else passed.push({ name, secs });
}

const total = ((Date.now() - started) / 1000).toFixed(0);

console.log('');
console.log('─'.repeat(64));
console.log(`${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed, `
  + `${run.length} run in ${total}s`);

if (skipped.length) {
  console.log('');
  console.log('skipped, in whole or in part — not evidence of anything:');
  for (const s of skipped) console.log(`  ${s.name.padEnd(26)} ${s.why}`);
}

if (failed.length) {
  console.log('');
  console.log('failed:');
  for (const f of failed) console.log(`  ${f.name}  (exit ${f.code}, ${f.secs}s)`);
  console.log('');
  console.log('Scroll up for each suite\'s own output, under its heading.');
  process.exit(1);
}

console.log('');
console.log(skipped.length
  ? `no suite failed, and ${skipped.length} did not run in full`
  : 'every suite green');
process.exit(0);
