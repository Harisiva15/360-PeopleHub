/**
 * Bring the `caller(role)` fixture factories to the current vocabulary.
 *
 * ## Why a second sweep
 *
 * `sweep-fixtures.mjs` matched `role: 'admin'` and converted 88 Caller literals.
 * Six suites do not write the literal: they have a factory —
 *
 *     const caller = (role, employeeId) =>
 *       ({ role, tenantId: ctx.tenant, employeeId, userId: null });
 *
 * — and pass the value at the call site as `caller('admin', id)`. The first
 * sweep could not see those, so they still hand the policy an old role. The
 * policy fails closed on a value it does not recognise, which is correct and is
 * why the failures looked like real refusals: `check:profile` reported that an
 * administrator could not read their own record.
 *
 * `role: 'employee'` call sites already work, which is why only the admin and
 * manager assertions failed. That is worth noticing — a fixture sweep that
 * leaves some values valid produces a half-failing suite rather than an
 * obviously broken one.
 *
 * ## The mapping, as approved
 *
 *     'admin'     ->  'company_admin', hasReports stays false
 *     'manager'   ->  'employee',      hasReports becomes true
 *     'employee'  ->  'employee',      hasReports stays false
 *
 * `hasReports` is appended as the factory's last parameter, defaulting to
 * false, so only the manager call sites gain an argument.
 *
 * No expectation is touched: this changes what the fixtures *are*, never what
 * the suites assert about them.
 *
 * Idempotent.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const NL = String.fromCharCode(10);
const DIR = 'scripts';

let touched = 0;
let sites = 0;

for (const name of readdirSync(DIR)) {
  if (!name.endsWith('.test.mjs')) continue;
  const file = `${DIR}/${name}`;
  let s = readFileSync(file, 'utf8');
  const before = s;

  /* Only suites that call the factory with an old value. */
  if (!/caller\('(?:admin|manager)'/.test(s)) continue;

  /*
   * Give the factory a hasReports parameter and put it in the object it
   * returns. Two shapes appear: `(role)` and `(role, employeeId)`.
   */
  s = s.replace(
    /const caller = \((role)\) =>/,
    'const caller = ($1, hasReports = false) =>',
  );
  s = s.replace(
    /const caller = \((role, employeeId)\) =>/,
    'const caller = ($1, hasReports = false) =>',
  );
  s = s.replace(
    /\(\{ role, tenantId: ([\w.]+), employeeId(,? ?[\w.]*) ?,? ?userId: null \}\)/g,
    (whole) => (whole.includes('hasReports') ? whole : whole.replace('{ role,', '{ role, hasReports,')),
  );
  /* The single-line form some suites use. */
  s = s.replace(
    /\{ role, tenantId: ([\w.]+), employeeId: ([\w.]+), userId: null \}/g,
    (whole) => (whole.includes('hasReports') ? whole : whole.replace('{ role,', '{ role, hasReports,')),
  );

  /* admin -> company_admin, in place. */
  s = s.split("caller('admin'").join("caller('company_admin'");

  /*
   * manager -> employee with reports. The flag is the last argument, so it goes
   * after whatever the call already passes.
   */
  s = s.replace(/caller\('manager'\)/g, "caller('employee', true)");
  s = s.replace(/caller\('manager', ([^),]+)\)/g, "caller('employee', $1, true)");

  sites += (before.match(/caller\('(?:admin|manager)'/g) ?? []).length;

  if (s === before) continue;
  writeFileSync(file, s);
  touched += 1;
  console.log(`  ${name}`);
}

console.log(`${NL}${touched} suite(s), ${sites} call site(s)`);

/* Anything left is a shape this did not know about, and must be looked at. */
const left = [];
for (const name of readdirSync(DIR)) {
  /* Not itself: the mapping above is written out in its own documentation. */
  if (!name.endsWith('.mjs') || name === 'sweep-caller-factories.mjs') continue;
  const s = readFileSync(`${DIR}/${name}`, 'utf8');
  for (const m of s.matchAll(/caller\('(admin|manager)'/g)) left.push(`${name}: ${m[0]}`);
}
if (left.length) {
  console.error(`${NL}still on the old vocabulary:`);
  for (const l of left) console.error(`  ${l}`);
  process.exit(1);
}
console.log('no caller factory passes an old role value');
