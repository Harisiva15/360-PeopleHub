/*
 * Update the test fixtures' Caller constructions to the current vocabulary.
 *
 * These build a Caller directly, so `callerFromToken` and its normaliser are
 * never involved: an old value reaches the policy unchanged, fails closed, and
 * the suite fails with a refusal that looks like a bug in the code under test
 * rather than a stale fixture. `check:provisioning` said "only an admin may add
 * a work schedule" while being run as what it thought was an admin.
 *
 *     role: 'admin'    ->  role: 'company_admin', hasReports: false
 *     role: 'manager'  ->  role: 'employee',      hasReports: true
 *     role: 'employee' ->  role: 'employee',      hasReports: false
 *
 * `manager` becoming an employee with reports is the whole model: the layer is
 * a fact about the reporting tree, and a fixture that wants a manager has to
 * say so by carrying reports rather than by naming a role.
 *
 * Idempotent: a fixture that already has hasReports is left alone.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const DIR = 'scripts';

const MAP = {
  admin: { role: 'company_admin', hasReports: 'false' },
  manager: { role: 'employee', hasReports: 'true' },
  employee: { role: 'employee', hasReports: 'false' },
};

let touched = 0;
let sites = 0;

for (const name of readdirSync(DIR)) {
  if (!/\.(mjs|ts)$/.test(name)) continue;
  const file = `${DIR}/${name}`;
  let s = readFileSync(file, 'utf8');
  const before = s;

  s = s.split(NL).map((line) => {
    const m = line.match(/role: '(admin|manager|employee)'/);
    if (!m) return line;
    /* Already carries the layer, so it has been done. */
    if (line.includes('hasReports')) return line;
    const to = MAP[m[1]];
    sites += 1;
    return line.replace(
      /role: '(admin|manager|employee)'/,
      `role: '${to.role}', hasReports: ${to.hasReports}`,
    );
  }).join(NL);

  if (s === before) continue;
  writeFileSync(file, s);
  touched += 1;
  console.log(`  ${name}`);
}

console.log(`${NL}${touched} file(s), ${sites} fixture(s)`);
