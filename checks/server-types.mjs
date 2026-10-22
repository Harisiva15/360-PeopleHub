/**
 * The server's typecheck, run from the root gate where that is possible.
 *
 * `npm --prefix server run typecheck` needs the server's own dependencies,
 * because `tsc` is one of them. The Pages workflow installs the frontend's and
 * not the server's, so wiring that command straight into `check:all` failed
 * the deploy — the third time this exact shape has bitten: `check:photo` broke
 * it twice, on `tsx` and then on `pg`.
 *
 * So this looks before it leaps and skips when the compiler is not installed,
 * which the runner now reports as a skip rather than a pass. Nothing is lost
 * by skipping here: the server chain ends with the same `typecheck`, and the
 * Server checks workflow installs what it needs and runs it on every push that
 * touches `server/**`.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = join(root, 'server', 'node_modules', 'typescript', 'package.json');

if (!existsSync(compiler)) {
  console.log("SKIPPED: the server's dependencies are not installed here, so there is no"
    + ' tsc to run. The server chain and the Server checks workflow both run it.');
  process.exit(0);
}

/* One string, no shell-arg concatenation warning. See checks/lib/deadline.mjs. */
const child = spawn('npm --prefix server run --silent typecheck', {
  shell: true, stdio: 'inherit', cwd: root,
});
child.on('exit', (code) => process.exit(code ?? 1));
