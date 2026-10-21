/**
 * Run a check with a deadline that cannot be outlived.
 *
 *   node checks/lib/deadline.mjs <seconds> <command> [args...]
 *
 * ## Why this is not a `setTimeout` inside the check
 *
 * Two of the frontend suites already arm a 90s watchdog, and both still hung:
 * six `vite-node` processes sat alive for four days and had to be killed by
 * hand. The reason is ordering. A watchdog written in the check file is armed
 * by the check file, which runs only after every import above it has resolved
 * — in these suites, after `../src/App`, `../src/modules` and `loadAllRoutes()`
 * have all come back. A hang in resolving or transforming those modules
 * happens *before* the timer exists, so the timer never fires and the process
 * waits forever.
 *
 * A deadline has to live in a process that is already running when the hang
 * starts, which means the parent. This wrapper is armed before Node has loaded
 * so much as vite-node, so it covers the whole run: resolution, transform,
 * module evaluation and the test body alike.
 *
 * ## What it costs
 *
 * A hung check is worse than a failing one. It holds the native Rolldown
 * binding open, so the next `npm ci` fails on a locked file and — because npm
 * empties `node_modules` before it discovers it cannot finish — can leave the
 * tree half-removed. That is the failure this file exists to prevent, so it
 * errs towards killing: a generous deadline, and a kill of the whole process
 * tree rather than the immediate child.
 *
 * The in-file watchdogs stay. They fire earlier and say far more about *what*
 * stalled, so the useful outcome is that they report first and this one never
 * speaks. It is the backstop for the cases they structurally cannot see.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [seconds, ...command] = process.argv.slice(2);
const limit = Number(seconds);

if (!Number.isFinite(limit) || limit <= 0 || !command.length) {
  console.error('usage: node checks/lib/deadline.mjs <seconds> <command> [args...]');
  process.exit(2);
}

/*
 * Both commands this is ever given are Node, so neither needs a shell — and
 * not having one matters twice over. `spawn` with `shell: true` concatenates
 * its arguments instead of escaping them, which Node now warns about
 * (DEP0190); and the pid it hands back is the shell's, so a kill signals the
 * shell and leaves the Node process underneath holding the file locks this
 * file exists to release.
 *
 * `vite-node` on Windows is a `.cmd`, which `spawn` refuses outright without a
 * shell, so it is invoked the way checks/demo-mode.mjs invokes it: this node
 * binary, running vite-node's own entry point.
 */
const here = dirname(fileURLToPath(import.meta.url));
const viteNodeCli = join(here, '..', '..', 'node_modules', 'vite-node', 'dist', 'cli.mjs');

const [file, args] = command[0] === 'vite-node'
  ? [process.execPath, [viteNodeCli, ...command.slice(1)]]
  : command[0] === 'node'
    ? [process.execPath, command.slice(1)]
    : [command[0], command.slice(1)];

const child = spawn(file, args, { stdio: 'inherit' });

/*
 * A check can have children of its own — `check:sourcevis` runs `check:gate`
 * as a real subprocess, on purpose — and killing only the one we spawned
 * orphans those, still holding the binding. `/t` takes the whole tree, which
 * is the point of killing at all.
 */
const killTree = () => {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
};

const timer = setTimeout(() => {
  console.error('');
  console.error(`FAIL  ${command.join(' ')}`);
  console.error(`      killed after ${limit}s — it was still running with nothing to report.`);
  console.error('      A hang this late is usually module resolution or transform, which is');
  console.error("      before the suite's own watchdog is armed. Run the command directly to see");
  console.error('      where it stops.');
  killTree();
  /* Give taskkill a moment to land, then leave regardless. */
  setTimeout(() => process.exit(1), 2_000);
}, limit * 1_000);

/* Ctrl-C has to take the child with it, or we recreate the problem by hand. */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearTimeout(timer); killTree(); process.exit(130); });
}

child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`FAIL  could not start ${command[0]}: ${e.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  process.exit(signal ? 1 : (code ?? 1));
});
