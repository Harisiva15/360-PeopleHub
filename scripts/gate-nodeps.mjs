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

import { existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

console.log('');
console.log("  hiding server/node_modules and running check:all, as the Pages job sees it");
console.log('');

renameSync(live, parked);

/* Put it back whatever happens, including on Ctrl-C. */
let code = 1;
const finish = (status) => {
  const back = restore();
  console.log('');
  console.log(`  server/node_modules ${back ? 'restored' : 'was already in place'}`);
  if (status === 0) {
    console.log('  the gate passes without the server tree — no root check depends on it');
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
  const r = spawnSync('npm run check:all', { shell: true, stdio: 'inherit', cwd: root });
  code = r.status ?? 1;
} finally {
  /* finish() exits, so this runs only if spawnSync threw. */
  if (code !== 0) restore();
}
finish(code);
