/**
 * Run a check in demo mode, whatever the developer's `.env.local` says.
 *
 * Some checks render the whole app for every route and every role. That only
 * means anything against the in-memory dataset: in API mode there is no
 * identity until the server supplies one, `AuthGate` renders nothing while it
 * is in flight, and a render-everything check has nothing to render.
 *
 * Which mode a check got used to depend on whether the person running it
 * happened to have a `.env.local`. CI has none — the file is git-ignored — so
 * `check:routes` ran in demo mode there and in API mode on a developer's
 * machine, and the two disagreed the moment the identity stopped being seeded
 * from `src/data`. A check that passes in CI and fails locally for a reason
 * neither mentions is worse than one that simply fails.
 *
 * So the mode is stated rather than inherited. Vite gives variables already
 * present in `process.env` the highest priority, above every `.env` file, so
 * emptying the three here is enough to settle it.
 *
 * `spawn` with an explicit `env` rather than a shell prefix, because
 * `VITE_API_URL= npx …` is bash syntax and npm scripts run through cmd.exe on
 * Windows, where it is a syntax error rather than an empty variable.
 *
 * And this node binary running vite-node's own entry rather than `npx`: on
 * Windows `npx` is a `.cmd`, which `spawn` refuses with EINVAL unless a shell
 * is involved, and bringing a shell back brings the quoting problem with it.
 *
 *   node checks/demo-mode.mjs checks/routes.tsx
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('usage: node checks/demo-mode.mjs <check file>');
  process.exit(2);
}

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'vite-node',
  'dist', 'cli.mjs');

const child = spawn(
  process.execPath,
  [cli, target, ...process.argv.slice(3)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      /* The three that decide demo versus product. Empty, not deleted: an
         absent key and an empty one are the same to `Boolean(BASE)`, and
         writing them out says which ones matter. */
      VITE_API_URL: '',
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
    },
  },
);

child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
child.on('error', (e) => { console.error(e.message); process.exit(1); });
