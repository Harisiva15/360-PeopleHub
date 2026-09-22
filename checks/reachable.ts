/**
 * Every live server method is reachable from a screen.
 *
 * The failure this catches has happened repeatedly here: a method is written,
 * routed, probed against the real database, and then nothing ever calls it.
 * It passes every other check — the contract is satisfied, the types line up,
 * the probe goes green — and the feature does not exist as far as anyone using
 * the app is concerned. Six of the ATS's writes sat like that for weeks: the
 * pipeline could be read, filtered and charted, and nothing could be put into
 * it.
 *
 * A method counts as reachable when some file under `src/modules` or
 * `src/shell` names it as
 * `.<service>.<method>(`. That is how the hooks in each module's `data.ts` call
 * the service, so it finds the call whether a screen uses it directly or
 * through a hook.
 *
 * Anything genuinely not meant to be called from a screen goes in `ALLOWED`
 * with a reason. The list is the point: it is a short, checkable statement of
 * what is built but not yet usable, and it only shrinks. It now holds nothing
 * but plumbing — every server method a person could want is reachable — so a
 * new entry here means a feature was left half-finished.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHttpServices } from '../src/services/http';
import { mockServices } from '../src/services/mock';

/**
 * Live methods with no screen behind them, and why.
 *
 * Two kinds live here. The first is plumbing a screen would never name.
 * The second is work that is finished on the server and unfinished in the app
 * — each of those is a missing feature, stated rather than forgotten.
 */
const ALLOWED: Record<string, string> = {
  /* plumbing */
  'employees.visible': 'called through services/people.ts, which every module shares',
  'employees.byIds': 'called through services/people.ts to resolve a directory in bulk',

};

const files: string[] = [];
const walk = (dir: string) => readdirSync(dir).forEach((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) walk(p);
  else if (/\.tsx?$/.test(f)) files.push(p);
});
walk('src/modules');
/*
 * The shell counts too. It is not a module, but it is a screen: the sidebar
 * pills come from approvals.navBadges, and scanning only src/modules reported
 * that as built-and-unreachable while it was rendering on every route change.
 */
walk('src/shell');
/*
 * And the auth layer. Signing in is not a screen and it does call a service:
 * AuthContext stamps the last sign-in when Supabase reports SIGNED_IN, and
 * leaving it out reported that method as built-and-unreachable while it was
 * running on every login.
 */
walk('src/auth');
const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');

const mock = mockServices as unknown as Record<string, Record<string, unknown>>;
const live = createHttpServices(mockServices) as unknown as Record<string, Record<string, unknown>>;

let failed = 0;
const unreachable: string[] = [];
let liveCount = 0;

for (const svc of Object.keys(mock).sort()) {
  for (const k of Object.keys(mock[svc]!)) {
    if (live[svc]![k] === mock[svc]![k]) continue;
    liveCount += 1;
    if (src.includes(`.${svc}.${k}(`)) continue;
    unreachable.push(`${svc}.${k}`);
  }
}

for (const name of unreachable) {
  if (!ALLOWED[name]) {
    failed += 1;
    console.error(`  FAIL  ${name} is live on the server and no screen calls it`);
  }
}

/* A reason that has outlived its method is a reason nobody will notice is stale. */
for (const name of Object.keys(ALLOWED)) {
  if (!unreachable.includes(name)) {
    failed += 1;
    console.error(`  FAIL  ${name} is listed as unreachable but something calls it — drop the entry`);
  }
}

const reachable = liveCount - unreachable.length;
console.log(`\n${reachable} of ${liveCount} live methods are reachable from a screen`);
console.log(`${unreachable.length} are not, each with a stated reason:`);
for (const name of unreachable.sort()) {
  console.log(`  ${name.padEnd(34)} ${ALLOWED[name] ?? '??'}`);
}

console.log(failed
  ? `\n${failed} problem(s)`
  : '\nnothing is built and unreachable by accident');
process.exit(failed ? 1 : 0);
