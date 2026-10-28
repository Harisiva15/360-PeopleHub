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
 *
 * ## Why it still renames
 *
 * The obvious improvement is not to move anything — run the checks with a
 * module resolver that cannot see `server/node_modules` — and it does not
 * work here. A `module.register()` resolve hook covers Node's own ESM
 * resolution and nothing else: most of these checks run under `vite-node`,
 * which resolves through Vite and reads the filesystem directly, and a CJS
 * `require('pg')` from server source goes through `Module._resolveFilename`,
 * which the hook never sees. Either gap lets through the exact regression
 * this gate exists to catch, which is worse than renaming, because the gate
 * would then be green and wrong.
 *
 * The approach that would work is a throwaway copy of the working tree with
 * the root `node_modules` linked in and no `server/node_modules` at all.
 * That is a bigger change than this one and it is not written yet.
 *
 * ## Restoring, which is the part that bit
 *
 * `renameSync` back failed twice on an OneDrive-synced checkout: the parked
 * directory comes back carrying `ReadOnly` and a reparse point, and the
 * rename loses to whatever OneDrive is doing to it, with EPERM. The gate then
 * exited on an uncaught exception and left the server tree named
 * `node_modules.gate-hidden` — which breaks every server command until
 * somebody notices, and is not what a gate should do to a working tree.
 *
 * So: clear the attribute, retry with a pause, say exactly how to recover if
 * it still cannot, and treat a failed restore as a failure of the run however
 * well the checks went.
 */

import { existsSync, renameSync, readFileSync, chmodSync, statSync } from 'node:fs';
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

/** How to put it back by hand, printed whenever this script cannot. */
const recovery = () => [
  '',
  '  Recover it by hand before running anything else in server/:',
  '',
  process.platform === 'win32'
    ? `    powershell -Command "$p='${parked}'; $i=Get-Item $p -Force;`
      + ' $i.Attributes = $i.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly);'
      + ` [IO.Directory]::Move('${parked}', '${live}')"`
    : `    mv "${parked}" "${live}"`,
  '',
  '  If that still refuses, the directory is intact and can be copied instead:',
  '',
  process.platform === 'win32'
    ? `    robocopy "${parked}" "${live}" /E /NFL /NDL /NJH /NJS & rmdir /s /q "${parked}"`
    : `    cp -a "${parked}/." "${live}/" && rm -rf "${parked}"`,
  '',
  '  Or, if you would rather not care which copy is which:',
  '',
  process.platform === 'win32'
    ? `    rmdir /s /q "${parked}" & npm ci --prefix "${join(root, 'server')}"`
    : `    rm -rf "${parked}" && npm ci --prefix "${join(root, 'server')}"`,
  '',
].join('\n');

/**
 * Put the parked tree back, with retries.
 *
 * Returns `'restored'`, `'nothing'` (there was nothing parked) or `'failed'`.
 *
 * The retries are not superstition. On this checkout the parked directory
 * comes back with `ReadOnly` set and a reparse point attached, and a rename
 * that fails with EPERM succeeds a second or two later once OneDrive has
 * finished with it — so the loop clears the attribute, then waits and tries
 * again, for about twenty seconds in total.
 */
const restore = () => {
  if (!existsSync(parked)) return 'nothing';
  if (existsSync(live)) return 'failed';

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      /* Windows carries the read-only bit on the directory itself, and it is
         enough on its own to refuse the rename. */
      try { chmodSync(parked, statSync(parked).mode | 0o200); } catch { /* best effort */ }
      renameSync(parked, live);
      return 'restored';
    } catch {
      /* Busy-wait rather than async: this runs from `finish()` and from a
         signal handler, neither of which can await. */
      const until = Date.now() + 1800;
      while (Date.now() < until) { /* wait for whatever holds it to let go */ }
    }
  }
  return 'failed';
};

/* Self-heal first: a previous run may have been interrupted. */
const healed = restore();
if (healed === 'restored') {
  console.log("  note: a previous run left the server's dependencies parked; restored.");
}
if (healed === 'failed') {
  console.error('');
  console.error('  REFUSED: both server/node_modules and server/node_modules.gate-hidden');
  console.error('  exist, so a previous run was interrupted and this cannot tell which');
  console.error('  tree is the real one. Renaming either would be a guess.');
  console.error('');
  console.error('  Look at both and keep the complete one — the parked copy is almost');
  console.error('  always it, and a stub left behind by a half-finished restore holds');
  console.error('  little more than `.bin`:');
  console.error('');
  console.error(`    ${parked}`);
  console.error(`    ${live}`);
  console.error(recovery());
  process.exit(2);
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
  console.log(`  server/node_modules ${
    back === 'restored' ? 'restored' : back === 'nothing' ? 'was already in place' : 'COULD NOT BE RESTORED'}`);

  /*
   * A run that leaves the working tree broken is a failed run, however well
   * the checks went. Reporting "the gate passes" over a server tree that is
   * no longer called `node_modules` is how this went unnoticed twice.
   */
  if (back === 'failed') {
    console.error('');
    console.error('  FAIL: the checks finished but server/node_modules is still parked.');
    console.error('  Nothing in server/ will run until it is back.');
    console.error(recovery());
    process.exit(status === 0 ? 3 : status);
  }

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
