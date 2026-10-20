/*
 * Put the local-only guard into every database-backed suite.
 *
 * The suites write — employees, invitations, schedules, payroll runs — and read
 * MIGRATE_DATABASE_URL, which pointed at production. The guard has to be in
 * each one rather than in a shared connect helper, because there is no shared
 * connect helper: each suite opens its own client.
 *
 * Tools are left alone deliberately. migrate.mjs, seed.mjs, retention.mjs and
 * the verify/inspect scripts are meant to be able to reach production, and
 * migrate.mjs has its own explicit --production path.
 *
 * Idempotent.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const DIR = 'scripts';

/* Scripts that may legitimately address production. */
const TOOLS = new Set([
  'migrate.mjs', 'seed.mjs', 'retention.mjs', 'inspect.mjs', 'check-tls.mjs',
  'ci-bootstrap.mjs', 'verify-backfill.mjs', 'verify-isolation.mjs',
  'local-only.mjs', 'local-only.test.mjs', 'add-local-guard.mjs',
  'sweep-roles.mjs', 'sweep-fixtures.mjs', 'sql-role-sweep.mjs',
]);

let touched = 0;
const skipped = [];

for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.mjs') || TOOLS.has(name)) continue;
  const file = `${DIR}/${name}`;
  let s = readFileSync(file, 'utf8');

  if (!/MIGRATE_DATABASE_URL|DATABASE_URL/.test(s)) continue;
  if (s.includes('assertLocalDatabase')) { skipped.push(name); continue; }

  const lines = s.split(NL);

  /*
   * After the last import, so the guard runs before any top-level connect but
   * after loadEnv has been pulled in. Suites vary too much to place it by
   * matching their connect call.
   */
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('import ') || lines[i].startsWith('const { ') ) at = i;
    if (/^(const|let|await|if|function|async function)/.test(lines[i]) && at >= 0 && i > at + 2) break;
  }
  if (at < 0) { skipped.push(`${name} (no import found)`); continue; }

  lines.splice(at + 1, 0,
    '',
    "import { assertLocalDatabase } from './local-only.mjs';",
    '',
    '/* This suite writes. It refuses anything but a local database. */',
    'assertLocalDatabase();');

  writeFileSync(file, lines.join(NL));
  touched += 1;
  console.log(`  ${name}`);
}

console.log(`${NL}${touched} suite(s) guarded`);
if (skipped.length) console.log(`already guarded or skipped: ${skipped.join(', ')}`);
