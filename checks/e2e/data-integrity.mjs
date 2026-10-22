/**
 * Is the data true? Nine questions asked of a live tenant, read-only.
 *
 *   MIGRATE_DATABASE_URL=… node checks/e2e/data-integrity.mjs
 *
 * ## Read-only by construction, not by promise
 *
 * Every statement runs inside `BEGIN; SET TRANSACTION READ ONLY;`, so the
 * database refuses a write rather than this file remembering not to attempt
 * one. A bug in a query here is then a failed statement, not a changed row.
 * There is no `--production` switch and no write path to gate: the only thing
 * it can do is ask.
 *
 * ## What it is for
 *
 * The suites under `server/scripts/` prove the *code* enforces its rules, with
 * scratch tenants it builds and tears down. None of them look at what the real
 * tenant actually holds, and the two can disagree: a rule added after the data
 * was written is not retroactive, and a rule enforced only in the service is
 * silent about rows written by a migration, a backfill or a manual fix.
 *
 * So each question here is one a careful person would ask before letting staff
 * in, and the ones that matter are the ones about agreement between two places
 * that must say the same thing — `tenant_membership.role` and
 * `employee.app_role`, a payslip's total and its own lines, a tenant's rows and
 * another tenant's.
 *
 * Shapes are introspected rather than assumed where I have been wrong about
 * them before; a question that cannot be asked says so instead of passing.
 */

import { createRequire } from 'node:module';

/*
 * `pg` belongs to the server's dependencies, and this file sits in the root
 * tree where it cannot be resolved — the same trap that broke the Pages deploy
 * three times. It is resolved from `server/` explicitly, and its absence is a
 * skip with a reason rather than a crash, so this stays safe to run from
 * anywhere including a frontend-only checkout.
 */
let pg;
try {
  pg = createRequire(new URL('../../server/package.json', import.meta.url))('pg');
} catch {
  console.log("SKIPPED: the server's dependencies are not installed, so there is no"
    + ' postgres client to ask with. Run `npm ci` in server/ first.');
  process.exit(0);
}

const NL = String.fromCharCode(10);
let failed = 0;
let skipped = 0;

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  console.error('  set MIGRATE_DATABASE_URL to the tenant to inspect');
  process.exit(2);
}
const host = (/@([^/]+)\//.exec(url)?.[1] ?? '?').replace(/:.*/, '');

const db = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: false },
});
await db.connect();
await db.query('BEGIN');
await db.query('SET TRANSACTION READ ONLY');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const has = async (table, column) => (await q(
  `SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column])).length > 0;
const table = async (name) => (await q(
  `SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name=$1`, [name])).length > 0;

const pass = (label) => console.log(`  PASS  ${label}`);
const fail = (label, rows) => {
  failed += 1;
  console.log(`  FAIL  ${label}`);
  for (const r of rows.slice(0, 8)) console.log(`          ${JSON.stringify(r)}`);
  if (rows.length > 8) console.log(`          … and ${rows.length - 8} more`);
};
const skip = (label, why) => { skipped += 1; console.log(`  SKIP  ${label} — ${why}`); };
/** Passes when the query returns nothing; the rows are the counter-examples. */
const none = async (label, sql, params = []) => {
  const rows = await q(sql, params);
  if (rows.length) fail(label, rows); else pass(label);
};

console.log(`${NL}reading ${host}, in a read-only transaction${NL}`);

/* ------------------------------------------------------------------ 1 */
console.log('1. roles agree with themselves');

await none('   membership role matches employee app_role',
  `SELECT e.code, tm.role AS membership_role, e.app_role
     FROM tenant_membership tm JOIN employee e ON e.id = tm.employee_id
    WHERE tm.role <> e.app_role`);

const admins = await q(
  `SELECT e.code FROM tenant_membership tm JOIN employee e ON e.id = tm.employee_id
    WHERE tm.role = 'company_admin' AND tm.status = 'active'`);
if (admins.length) pass(`   at least one active company_admin (${admins.map((a) => a.code).join(', ')})`);
else fail('   at least one active company_admin', [{ found: 0 }]);

/* ------------------------------------------------------------------ 2 */
console.log(`${NL}2. nothing points at a row that is not there`);

await none('   employee.site_id resolves',
  'SELECT e.code FROM employee e WHERE e.site_id IS NOT NULL'
  + ' AND NOT EXISTS (SELECT 1 FROM site s WHERE s.id = e.site_id)');
await none('   employee.department_id resolves',
  'SELECT e.code FROM employee e WHERE e.department_id IS NOT NULL'
  + ' AND NOT EXISTS (SELECT 1 FROM department d WHERE d.id = e.department_id)');
await none('   employee.manager_id resolves',
  'SELECT e.code FROM employee e WHERE e.manager_id IS NOT NULL'
  + ' AND NOT EXISTS (SELECT 1 FROM employee m WHERE m.id = e.manager_id)');
if (await has('employee', 'photo_document_id')) {
  await none('   employee.photo_document_id resolves',
    'SELECT e.code FROM employee e WHERE e.photo_document_id IS NOT NULL'
    + ' AND NOT EXISTS (SELECT 1 FROM document d WHERE d.id = e.photo_document_id)');
} else skip('   employee.photo_document_id resolves', '0059 not applied here');
if (await has('legal_entity', 'logo_document_id')) {
  await none('   legal_entity.logo_document_id resolves',
    'SELECT le.code FROM legal_entity le WHERE le.logo_document_id IS NOT NULL'
    + ' AND NOT EXISTS (SELECT 1 FROM document d WHERE d.id = le.logo_document_id)');
} else skip('   legal_entity.logo_document_id resolves', '0061 not applied here');
await none('   timesheet_entry.project_id resolves',
  'SELECT te.id FROM timesheet_entry te WHERE te.project_id IS NOT NULL'
  + ' AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = te.project_id)');
if (await table('leave_request') && await has('leave_request', 'leave_type_id')) {
  await none('   leave_request.leave_type_id resolves',
    'SELECT lr.id FROM leave_request lr WHERE lr.leave_type_id IS NOT NULL'
    + ' AND NOT EXISTS (SELECT 1 FROM leave_type lt WHERE lt.id = lr.leave_type_id)');
} else skip('   leave_request.leave_type_id resolves', 'column not present');
if (await has('document_request', 'document_id')) {
  await none('   document_request.document_id resolves',
    'SELECT dr.id FROM document_request dr WHERE dr.document_id IS NOT NULL'
    + ' AND NOT EXISTS (SELECT 1 FROM document d WHERE d.id = dr.document_id)');
} else skip('   document_request.document_id resolves', 'column not present');

/* ------------------------------------------------------------------ 3 */
console.log(`${NL}3. no row reaches into another tenant`);

/*
 * Every pair below is joined on the child's foreign key alone, then checked for
 * a tenant mismatch. The composite foreign keys make most of these impossible,
 * which is the point: a pair that *can* disagree is one where the constraint is
 * single-column and the invariant lives in code.
 */
const pairs = [
  ['employee', 'site_id', 'site'],
  ['employee', 'department_id', 'department'],
  ['employee', 'legal_entity_id', 'legal_entity'],
  ['employee', 'manager_id', 'employee'],
  ['holiday', 'site_id', 'site'],
  ['payslip', 'employee_id', 'employee'],
  ['payslip', 'pay_run_id', 'pay_run'],
  ['payslip_line', 'payslip_id', 'payslip'],
  ['timesheet_entry', 'project_id', 'project'],
  ['tenant_membership', 'employee_id', 'employee'],
  ['leave_balance', 'employee_id', 'employee'],
];
for (const [child, fk, parent] of pairs) {
  if (!(await table(child)) || !(await has(child, fk)) || !(await has(child, 'tenant_id'))) {
    skip(`   ${child}.${fk} stays inside its tenant`, 'table or column not present');
    continue;
  }
  // eslint-disable-next-line no-await-in-loop
  await none(`   ${child}.${fk} stays inside its tenant`,
    `SELECT c.id FROM ${child} c JOIN ${parent} p ON p.id = c.${fk}
      WHERE c.tenant_id <> p.tenant_id`);
}

/* ------------------------------------------------------------------ 4 */
console.log(`${NL}4. every active employee is set up`);

await none('   has a site', "SELECT code FROM employee WHERE status = 'active' AND site_id IS NULL");
await none('   has a joining date', "SELECT code FROM employee WHERE status = 'active' AND joined_on IS NULL");

const lbCols = await q(
  `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='leave_balance'`);
const lbType = lbCols.map((r) => r.column_name).find((c) => /leave_type|type_id|leave_type_id/.test(c));
if (!lbType) {
  skip('   has a balance for every active leave type', 'cannot find the leave-type column on leave_balance');
} else {
  await none('   has a balance for every active leave type',
    `SELECT e.code, lt.code AS leave_type
       FROM employee e
       CROSS JOIN leave_type lt
      WHERE e.status = 'active' AND lt.active
        AND NOT EXISTS (SELECT 1 FROM leave_balance lb
                         WHERE lb.employee_id = e.id AND lb.${lbType} = lt.id)`);
}

const noSchedule = await q(
  `SELECT e.code FROM employee e
    WHERE e.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM employee_schedule es WHERE es.employee_id = e.id)`);
if (noSchedule.length) {
  console.log(`  NOTE  ${noSchedule.length} active employee(s) have no schedule and use the`
    + ` Monday-to-Friday fallback: ${noSchedule.map((r) => r.code).join(', ')}`);
} else pass('   has a work schedule assigned');

/* ------------------------------------------------------------------ 5 */
console.log(`${NL}5. holidays`);

const want = { CHN: 42, BLR: 40, WFH: 42, CLIENT: 42, NJ: 18 };
const got = Object.fromEntries((await q(
  `SELECT s.code, count(*)::int n FROM holiday h JOIN site s ON s.id = h.site_id
    GROUP BY s.code`)).map((r) => [r.code, r.n]));
const wrong = Object.entries(want).filter(([k, v]) => (got[k] ?? 0) !== v)
  .map(([k, v]) => ({ site: k, expected: v, found: got[k] ?? 0 }));
if (wrong.length) fail('   per-site counts', wrong);
else pass(`   per-site counts (${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(' ')})`);

const tenantWide = await q('SELECT count(*)::int n FROM holiday WHERE site_id IS NULL');
console.log(`  NOTE  ${tenantWide[0].n} holiday(s) apply to all locations`);

await none('   no two fixed holidays share a date at one site',
  `SELECT coalesce(s.code,'ALL') AS site, h.observed_on::text AS date, count(*)::int AS n
     FROM holiday h LEFT JOIN site s ON s.id = h.site_id
    WHERE h.optional = false
    GROUP BY 1, 2 HAVING count(*) > 1`);

/* ------------------------------------------------------------------ 6 */
console.log(`${NL}6. payroll adds up`);

await none('   gross equals the sum of its earning lines',
  `SELECT e.code, p.gross,
          (SELECT coalesce(sum(amount),0) FROM payslip_line l
            WHERE l.payslip_id = p.id AND l.kind='earning') AS sum_earnings
     FROM payslip p JOIN employee e ON e.id = p.employee_id
    WHERE p.gross <> (SELECT coalesce(sum(amount),0) FROM payslip_line l
                       WHERE l.payslip_id = p.id AND l.kind='earning')`);
await none('   net equals gross minus deductions plus reimbursements',
  `SELECT e.code, p.gross, p.total_deductions, p.reimbursements, p.net_pay
     FROM payslip p JOIN employee e ON e.id = p.employee_id
    WHERE p.net_pay <> p.gross - p.total_deductions + coalesce(p.reimbursements, 0)`);
await none('   deduction lines sum to total_deductions',
  `SELECT e.code, p.total_deductions,
          (SELECT coalesce(sum(amount),0) FROM payslip_line l
            WHERE l.payslip_id = p.id AND l.kind='deduction') AS sum_deductions
     FROM payslip p JOIN employee e ON e.id = p.employee_id
    WHERE p.total_deductions <> (SELECT coalesce(sum(amount),0) FROM payslip_line l
                                  WHERE l.payslip_id = p.id AND l.kind='deduction')`);

const noStructure = await q(
  `SELECT e.code, e.full_name FROM employee e
    WHERE e.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM salary_structure ss WHERE ss.employee_id = e.id)
    ORDER BY e.code`);
if (noStructure.length) {
  console.log(`  NOTE  ${noStructure.length} active employee(s) have no salary structure, so no`
    + ` payslip can be generated for them: ${noStructure.map((r) => r.code).join(', ')}`);
} else pass('   every active employee has a salary structure');

/* ------------------------------------------------------------------ 7 */
console.log(`${NL}7. invitations`);

if (await has('tenant_membership', 'must_change_password')) {
  await none("   every 'invited' membership must change its password",
    `SELECT coalesce(e.code, tm.id::text) AS who, tm.status, tm.must_change_password
       FROM tenant_membership tm LEFT JOIN employee e ON e.id = tm.employee_id
      WHERE tm.status = 'invited' AND tm.must_change_password IS NOT TRUE`);
} else skip("   every 'invited' membership must change its password", 'column not present');

/* ------------------------------------------------------------------ 8 */
console.log(`${NL}8. leave types say what they mean`);

const lop = await q("SELECT code, name, paid, annual_quota FROM leave_type WHERE code = 'LOP'");
if (!lop.length) skip('   LOP is unpaid', 'no LOP leave type');
else if (lop[0].paid === true) {
  fail('   LOP is unpaid', [{ ...lop[0], note: 'Loss of Pay is marked paid' }]);
} else pass('   LOP is unpaid');

await none('   no paid type has a zero quota while being selectable',
  `SELECT code, name, paid, annual_quota FROM leave_type
    WHERE active AND paid AND annual_quota = 0 AND code NOT IN ('CO','LOP')`);

/* ------------------------------------------------------------------ 9 */
console.log(`${NL}9. the audit trail caught the things that matter`);

const roleChanges = await q(
  "SELECT count(*)::int n FROM audit_log WHERE action = 'role_changed'");
const membershipRoles = await q('SELECT count(*)::int n FROM tenant_membership');
console.log(`  NOTE  ${roleChanges[0].n} role_changed audit row(s) for ${membershipRoles[0].n} membership(s)`);
if (roleChanges[0].n > 0) pass('   role changes are audited');
else fail('   role changes are audited', [{ role_changed_rows: 0 }]);

const cats = await q(
  `SELECT category, count(*)::int n FROM audit_log GROUP BY category ORDER BY n DESC`);
console.log(`  NOTE  audit categories: ${cats.map((r) => `${r.category}=${r.n}`).join('  ')}`);

await db.query('ROLLBACK');
await db.end();

console.log('');
console.log(`  ${failed} failed, ${skipped} skipped`);
console.log('');
process.exit(failed ? 1 : 0);
