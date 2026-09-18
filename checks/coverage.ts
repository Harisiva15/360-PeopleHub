/**
 * What the server backs, and which screens a configured build may therefore show.
 *
 * Two questions that keep getting confused:
 *
 *   1. How much of each *service* does the API back? `liveMethodCount()` gives
 *      one number for the whole app, which hides the shape of the work — a
 *      service at 0% is a different problem from one at 80%.
 *
 *   2. Which *modules* is it honest to show in a configured build? That is
 *      `LIVE_MODULES` in `src/state/rbac.ts`, and it is hand-maintained, which
 *      means it drifts: three services went live in one sitting and their
 *      screens stayed hidden because nobody remembered the list. The reverse
 *      drift is worse — a module listed there whose service is still the mock
 *      renders invented data against a real company's login.
 *
 * So the second half derives the answer instead of trusting the list: for each
 * module, find the services its files call, and check every one of those is
 * backed. Then compare that against `LIVE_MODULES` and fail on either mismatch.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mockServices } from '../src/services/mock';
import { createHttpServices } from '../src/services/http';
import { LIVE_MODULES } from '../src/state/rbac';

const merged = createHttpServices(mockServices);

/* ---------- part one: per-service coverage ---------- */

interface Row { name: string; total: number; live: number; missing: string[] }
const rows: Row[] = [];

for (const name of Object.keys(mockServices).sort()) {
  const mock = (mockServices as Record<string, Record<string, unknown>>)[name];
  const live = (merged as Record<string, Record<string, unknown>>)[name];
  if (!mock || !live) continue;

  const methods = Object.keys(mock).filter((k) => typeof mock[k] === 'function');
  /* A method is backed when the merge replaced it — identity is the test. */
  const missing = methods.filter((k) => mock[k] === live[k]);
  rows.push({ name, total: methods.length, live: methods.length - missing.length, missing });
}

const bar = (r: Row) => {
  const n = r.total ? Math.round((r.live / r.total) * 20) : 0;
  return '#'.repeat(n) + '.'.repeat(20 - n);
};

const show = (title: string, list: Row[], withDetail: boolean) => {
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const r of list) {
    console.log(`  ${r.name.padEnd(13)} ${bar(r)}  ${String(r.live).padStart(2)}/${String(r.total).padEnd(2)}`
      + (withDetail && r.missing.length <= 8 ? `   ${r.missing.join(', ')}` : ''));
  }
};

const byProgress = (a: Row, b: Row) =>
  (b.live / b.total) - (a.live / a.total) || a.name.localeCompare(b.name);

show('fully on the server', rows.filter((r) => r.live === r.total).sort(byProgress), false);
show('partly on the server', rows.filter((r) => r.live > 0 && r.live < r.total).sort(byProgress), true);
show('entirely on the mock', rows.filter((r) => r.live === 0).sort(byProgress), false);

const total = rows.reduce((a, r) => a + r.total, 0);
const live = rows.reduce((a, r) => a + r.live, 0);

/* ---------- part two: which modules that makes honest to show ---------- */

/** Every real `<service>.<method>` pair, so a lookalike cannot be mistaken for one. */
const METHODS = new Set<string>();
for (const name of Object.keys(mockServices)) {
  const svc = (mockServices as Record<string, Record<string, unknown>>)[name]!;
  for (const k of Object.keys(svc)) {
    if (typeof svc[k] === 'function') METHODS.add(`${name}.${k}`);
  }
}

/*
 * Backed *per method*, not per service. The coarser test — every service a
 * module touches must be wholly live — condemns a dozen honest screens because
 * they call employees.active() and employees.profile() happens to be mock.
 * What matters is whether the methods a module actually calls are backed.
 */
const backed = new Set<string>();
for (const r of rows) {
  const mock = (mockServices as Record<string, Record<string, unknown>>)[r.name]!;
  for (const k of Object.keys(mock)) {
    if (typeof mock[k] === 'function' && !r.missing.includes(k)) backed.add(`${r.name}.${k}`);
  }
}

/** Every file under one module directory. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...filesIn(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const MODULES = join('src', 'modules');
const moduleDirs = readdirSync(MODULES)
  .filter((d) => statSync(join(MODULES, d)).isDirectory());

/**
 * Which service methods a module's own files call, as `.<service>.<method>(`.
 *
 * A call wrapped in `unbacked(...)` does not count: that helper already returns
 * an empty result in a configured build precisely so an unmapped panel shows
 * nothing rather than invented rows. Counting it would condemn the dashboard
 * for a panel it has already dealt with.
 */
function callsIn(dir: string): Set<string> {
  const used = new Set<string>();
  for (const file of filesIn(join(MODULES, dir))) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('unbacked(')) continue;
      for (const m of line.matchAll(/\.(\w+)\.(\w+)\(/g)) {
        /*
         * The method has to exist on that service. Without this, `s.benefits.map(...)`
         * over a salary structure's benefit lines reads as a call to
         * BenefitsService.map — a service call that was never made, on a
         * method that does not exist.
         */
        if (METHODS.has(`${m[1]}.${m[2]}`)) used.add(`${m[1]}.${m[2]}`);
      }
    }
  }
  return used;
}

/*
 * A module with no service calls of its own — a pure composite, or one that
 * only renders reference data — is left to the hand-maintained list, because
 * nothing here can tell whether it is honest to show.
 */
const derived = new Map<string, { ready: boolean; on: string[]; mock: string[] }>();
for (const dir of moduleDirs) {
  const used = [...callsIn(dir)].sort();
  if (!used.length) continue;
  const mockOnly = used.filter((c) => !backed.has(c));
  derived.set(dir, { ready: mockOnly.length === 0, on: used, mock: mockOnly });
}

let failed = 0;

const shouldShow = [...derived.entries()].filter(([, v]) => v.ready).map(([k]) => k);
const shouldHide = [...derived.entries()].filter(([, v]) => !v.ready).map(([k]) => k);

/* Listed but still resting on a mock — renders invented data in a real build. */
const dangerous = shouldHide.filter((m) => LIVE_MODULES.has(m));
/* Backed but hidden — work that exists and nobody can reach. */
const stranded = shouldShow.filter((m) => !LIVE_MODULES.has(m));

if (dangerous.length) {
  failed += 1;
  console.log('\nLISTED IN LIVE_MODULES BUT NOT FULLY BACKED');
  for (const m of dangerous) {
    const mk = derived.get(m)!.mock;
    console.log(`  ${m.padEnd(13)} still on the mock: ${mk.slice(0, 5).join(', ')}`
      + (mk.length > 5 ? ` and ${mk.length - 5} more` : ''));
  }
  console.log('  These render invented data against a real login. Remove them or finish the service.');
}

if (stranded.length) {
  failed += 1;
  console.log('\nFULLY BACKED BUT HIDDEN FROM A CONFIGURED BUILD');
  for (const m of stranded) {
    console.log(`  ${m.padEnd(13)} all ${derived.get(m)!.on.length} of its calls are backed`);
  }
  console.log('  Add them to LIVE_MODULES in src/state/rbac.ts, or say here why not.');
}

console.log(`\n${live} of ${total} methods across ${rows.length} services (${Math.round((live / total) * 100)}%)`);
console.log(`${LIVE_MODULES.size} modules shown in a configured build, `
  + `${shouldHide.length} held back by a service that is still mock`);

if (failed) {
  console.error('\nLIVE_MODULES disagrees with what the server actually backs');
  process.exit(1);
}
console.log('LIVE_MODULES matches what the server backs');
