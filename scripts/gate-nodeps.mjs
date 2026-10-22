/**
 * Run the whole gate as the Pages workflow sees it: without the server's
 * dependencies.
 *
 *   npm run gate:nodeps
 *
 * ## Why this exists
 *
 * The Pages deploy broke three times in one day, each time for the same
 * reason: a check invoked from the *root* gate needed something that only
 * `server/package.json` installs. `check:photo` did it twice — first on `tsx`,
 * then on `pg` — and `check:servertypes` did it again on `tsc`. Every one of
 * them passed locally, because a developer machine has both trees installed,
 * and failed in CI, where the frontend job installs only the frontend's.
 *
 * Writing the rule down did not work. I wrote it in f50b590's commit message
 * and then broke it in the same session. So this makes the rule executable:
 * hide `server/node_modules`, run `check:all`, and put it back.
 *
 * A root check may then do either of two acceptable things — pass, or skip
 * with a reason, which `check:all` now reports separately. Failing is the bug.
 *
 * ## Why it is not a `check:` script
 *
 * `scripts/check-all.mjs` builds its list from every `check` and `check:*`
 * script in package.json. Naming this one `check:nodeps` would put it in that
 * list, and it would run `check:all`, which would run it again. It is a
 * deliberate pre-push step instead, and the thing it runs is the gate itself.
 *
 * ## What it costs, and the one risk
 *
 * A second full `check:all`, so roughly double the gate's wall time. That is
 * the price of catching this class before CI rather than after a failed
 * deploy.
 *
 * The risk is the rename: while this runs, `server/node_modules` is not where
 * anything expects it. Do not run a server suite alongside it. If the process
 * is killed mid-run the directory stays renamed, so the next run restores it
 * before doing anything else and says so.
 */

import { existsSync, renameSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

/**
 * In quick mode, only the root checks that reach into the server.
 *
 * Derived from what each script actually runs rather than listed, because a
 * list is a thing to forget: `check:servertypes` was added to the gate months
 * after the other four and would not have been on it. Anything naming
 * `--prefix server` or a path under `server/` is a candidate for this failure
 * and nothing else can be.
 *
 * The full run is still the honest one — a root check could reach the server
 * tree by some route this pattern does not see — which is why the full gate
 * stays and this is the cheap one for every push.
 */
const delegating = () => {
  const { scripts = {} } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return Object.keys(scripts)
    .filter((k) => k === 'check' || k.startsWith('check:'))
    .filter((k) => !['check:all', 'check:chain'].includes(k))
    /*
     * Any mention of the word, not just `--prefix server` or a `server/` path.
     * The first version of this matched those two and selected four checks —
     * missing `check:servertypes`, whose command is `node
     * checks/server-types.mjs`, which is the exact regression this gate exists
     * to catch. A wrapper hides the dependency inside a file, so the script
     * name is all there is to go on.
     *
     * Over-matching costs a second or two of gate time; under-matching costs a
     * failed deploy, which is what happened three times.
     */
    .filter((k) => /server/i.test(scripts[k]));
};
const live = join(root, 'server', 'node_modules');
const parked = join(root, 'server', 'node_modules.gate-hidden');

const restore = () => {
  if (existsSync(parked) && !existsSync(live)) {
    renameSync(parked, live);
    return true;
  }
  return false;
};

/* Self-heal first: a previous run may have been interrupted. */
if (restore()) {
  console.log("  note: a previous run left the server's dependencies parked; restored.");
}

if (!existsSync(live)) {
  console.error('');
  console.error("  REFUSED: server/node_modules is not here, so there is nothing to hide.");
  console.error('  Run `npm ci` in server/ first — this gate is about proving the root');
  console.error('  checks survive without it, which means it has to exist to be removed.');
  console.error('');
  process.exit(2);
}

const only = QUICK ? delegating() : [];
if (QUICK && !only.length) {
  console.error('  REFUSED: no root check appears to reach the server, which cannot be right.');
  console.error('  The pattern in `delegating()` has stopped matching; fix it rather than');
  console.error('  trusting a gate that checks nothing.');
  process.exit(2);
}

console.log('');
console.log(QUICK
  ? `  hiding server/node_modules and running the ${only.length} checks that reach it:\n    ${only.join(', ')}`
  : '  hiding server/node_modules and running check:all, as the Pages job sees it');
console.log('');

renameSync(live, parked);

/* Put it back whatever happens, including on Ctrl-C. */
let code = 1;
const finish = (status) => {
  const back = restore();
  console.log('');
  console.log(`  server/node_modules ${back ? 'restored' : 'was already in place'}`);
  if (status === 0) {
    console.log(only.length
      ? `  the ${only.length} server-facing checks survive without the server tree`
      : '  the gate passes without the server tree — no root check depends on it');
  } else {
    console.error('');
    console.error('  FAIL: a root check needs something only server/package.json installs.');
    console.error('  Look for the failing suite above. It must either work with the');
    console.error('  frontend tree alone, or detect the absence and skip with a reason —');
    console.error('  see checks/server-types.mjs for the pattern.');
  }
  console.log('');
  process.exit(status);
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => finish(130));

try {
  const cmd = only.length ? `npm run check:all -- ${only.join(' ')}` : 'npm run check:all';
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root });
  code = r.status ?? 1;
} finally {
  /* finish() exits, so this runs only if spawnSync threw. */
  if (code !== 0) restore();
}
finish(code);
