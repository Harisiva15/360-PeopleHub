/**
 * Production-shaped data for the local cluster.
 *
 *   MIGRATE_DATABASE_URL=postgresql://...@127.0.0.1:55432/peoplehub
 *     node db/manual/seed-local.mjs
 *
 * ## Why a seed at all
 *
 * The end-to-end programme needs a local stack that behaves like the live one:
 * people at three sites in two countries, a real reporting line, somebody with
 * no work schedule, kit issued to some of them and not others, leave both
 * waiting and decided. The local database had one employee, so every screen
 * read as empty — and an empty screen cannot be wrong.
 *
 * It is shaped on production rather than invented: five employees across CHN,
 * BLR and NJ, and the four role situations that exist — company_admin,
 * hr_admin, an employee who has reports and is therefore a manager, and
 * employees who are not.
 *
 * ## It used to leave somebody without a work schedule
 *
 * Deliberately, to keep the Monday–Friday fallback case in the local database,
 * because two people in production have no assignment. That did not survive
 * contact with `work-schedule.test.mjs`, which backfills assignments across
 * the live tenant and then asserts the count is unchanged: the backfill filled
 * the hole and the census failed, for a reason with nothing to do with what
 * the suite was testing.
 *
 * A deliberate gap cannot live in a tenant that other suites write to. The
 * fallback is asserted in `scripts/schedule-fallback.test.mjs` instead, where
 * the unassigned employee exists inside a scratch tenant for exactly as long
 * as the assertion needs and nothing else can close the hole first.
 *
 * ## Local only, with no way to say otherwise
 *
 * Every other script in this directory takes `--production` with a matching
 * host. This one takes no such flag and has no code path that reaches a remote
 * database: it writes employees, attendance and leave, which is exactly what
 * must never happen to the live tenant. The guard is the absence of the
 * option, not a prompt somebody can answer wrongly.
 *
 * ## Idempotent
 *
 * Re-running changes nothing: employees are matched on `code`, assets on
 * `tag`, and schedules, attendance and leave on the natural key of what they
 * describe. Run it after a restore, or when a suite has left the tenant short
 * of something.
 */

import { createRequire } from 'node:module';

const pg = createRequire(new URL('../../package.json', import.meta.url))('pg');

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('  set MIGRATE_DATABASE_URL'); process.exit(2); }

const host = /@([^/]+)\//.exec(url)?.[1] ?? '?';
if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
  console.error('');
  console.error(`  REFUSED: ${host} is not local. This script writes employees,`);
  console.error('  attendance and leave, so it has no remote mode at all.');
  console.error('');
  process.exit(1);
}

const db = new pg.Client({ connectionString: url, ssl: false });
await db.connect();

const NL = String.fromCharCode(10);
let problems = 0;
const check = (label, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `   ${detail}`}`);
  if (!ok) problems += 1;
};

/* --- the tenant, which must be unambiguous ------------------------------- */

const tenants = (await db.query(
  "SELECT id, display_name FROM tenant WHERE slug NOT LIKE 'zz-scratch-%'")).rows;
if (tenants.length !== 1) {
  console.error(`  REFUSED: expected one live tenant, found ${tenants.length}`);
  process.exit(1);
}
const T = tenants[0].id;

console.log('');
console.log(`  target : ${host}`);
console.log(`  tenant : ${tenants[0].display_name}`);
console.log('');

const idOf = async (table, code) => (await db.query(
  `SELECT id FROM ${table} WHERE tenant_id = $1 AND code = $2`, [T, code])).rows[0]?.id ?? null;

/* --- the people ---------------------------------------------------------- */

/*
 * Ordered so a manager exists before the people who report to them. VHM005
 * sits at New Jersey on the US shift and is paid in dollars, because a tenant
 * with two currencies is the case that catches a hard-coded rupee.
 */
const PEOPLE = [
  { code: 'VHM002', name: 'Prem Kumar',        role: 'hr_admin', site: 'BLR', dept: 'HR',    shift: 'IN', mgr: 'VHM001', ctc: 1800000, cur: 'INR', title: 'HR Manager' },
  { code: 'VHM003', name: 'Lakshmi Narayanan', role: 'employee', site: 'CHN', dept: 'ENG',   shift: 'IN', mgr: 'VHM001', ctc: 2400000, cur: 'INR', title: 'Engineering Lead' },
  { code: 'VHM004', name: 'Arun Prakash',      role: 'employee', site: 'CHN', dept: 'ENG',   shift: 'IN', mgr: 'VHM003', ctc:  900000, cur: 'INR', title: 'Software Engineer' },
  { code: 'VHM005', name: 'Daniel Reed',       role: 'employee', site: 'NJ',  dept: 'SALES', shift: 'US', mgr: 'VHM003', ctc:   95000, cur: 'USD', title: 'Account Executive' },
];

const entity = await idOf('legal_entity', 'IN01');

try {
  await db.query('BEGIN');

  let added = 0;
  for (const p of PEOPLE) {
    if (await idOf('employee', p.code)) continue;
    await db.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role, employment_type,
          department_id, site_id, legal_entity_id, shift_id, manager_id,
          joined_on, currency, ctc, designation, on_probation, notice_days)
       VALUES ($1, $2, $3, $4::citext, 'active', $5, 'permanent',
               $6, $7, $8, $9, $10, DATE '2021-04-01', $11, $12, $13, false, 60)`,
      [T, p.code, p.name, `${p.code.toLowerCase()}@local.test`, p.role,
        await idOf('department', p.dept), await idOf('site', p.site), entity,
        await idOf('shift', p.shift), p.mgr ? await idOf('employee', p.mgr) : null,
        p.cur, p.ctc, p.title]);
    added += 1;
  }

  /*
   * A membership per person. `invited` with a null user_id, for the reason
   * scratch-tenant.mjs records: any status beyond it requires an auth user,
   * and creating one means talking to Supabase.
   */
  for (const p of PEOPLE) {
    await db.query(
      `INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status)
       SELECT $1, NULL, $2, $3, 'invited'
        WHERE NOT EXISTS (SELECT 1 FROM tenant_membership
                           WHERE tenant_id = $1 AND employee_id = $3)`,
      [T, p.role, await idOf('employee', p.code)]);
  }

  /* --- schedules, for everybody ------------------------------------------ */

  const mf = await idOf('work_schedule', 'DEFAULT_MF');
  for (const code of ['VHM001', 'VHM002', 'VHM003', 'VHM004', 'VHM005']) {
    const emp = await idOf('employee', code);
    if (!emp) continue;
    await db.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, work_schedule_id, valid_from)
       SELECT $1, $2, $3, DATE '2021-04-01'
        WHERE NOT EXISTS (SELECT 1 FROM employee_schedule
                           WHERE tenant_id = $1 AND employee_id = $2)`,
      [T, emp, mf]);
  }

  /* --- kit --------------------------------------------------------------- */

  const ASSETS = [
    { tag: 'VHM-LAP-1001', cat: 'LAPTOP',  model: 'MacBook Pro 14 M3',  to: 'VHM003', site: 'CHN', cost: 185000 },
    { tag: 'VHM-LAP-1002', cat: 'LAPTOP',  model: 'ThinkPad T14 Gen 4', to: 'VHM004', site: 'CHN', cost: 92000 },
    { tag: 'VHM-MON-2001', cat: 'DISPLAY', model: 'Dell U2722D 27in',   to: null,     site: 'CHN', cost: 28000 },
    { tag: 'VHM-MOB-3001', cat: 'MOBILE',  model: 'iPhone 14 128GB',    to: 'VHM005', site: 'NJ',  cost: 799 },
  ];
  for (const a of ASSETS) {
    const held = a.to ? await idOf('employee', a.to) : null;
    await db.query(
      `INSERT INTO asset (tenant_id, tag, category_id, model, status, employee_id,
                          assigned_on, site_id, purchase_cost, currency, purchased_on, condition)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, DATE '2024-06-01', 'good'
        WHERE NOT EXISTS (SELECT 1 FROM asset WHERE tenant_id = $1 AND tag = $2)`,
      [T, a.tag, await idOf('asset_category', a.cat), a.model,
        held ? 'assigned' : 'in_stock', held, held ? '2024-06-15' : null,
        await idOf('site', a.site), a.cost, a.site === 'NJ' ? 'USD' : 'INR']);
  }

  /* --- attendance: the last ten working days that are not holidays ------- */

  const holidays = new Set((await db.query(
    'SELECT observed_on::text AS d FROM holiday WHERE tenant_id = $1', [T])).rows.map((r) => r.d));
  const days = [];
  for (let back = 1; days.length < 10 && back < 40; back += 1) {
    const d = new Date(Date.UTC(2026, 9, 22) - back * 86400000);
    const dow = d.getUTCDay();
    const iso = d.toISOString().slice(0, 10);
    if (dow === 0 || dow === 6 || holidays.has(iso)) continue;
    days.push(iso);
  }
  const chn = await idOf('site', 'CHN');
  for (const code of ['VHM003', 'VHM004']) {
    const emp = await idOf('employee', code);
    for (const d of days) {
      await db.query(
        `INSERT INTO attendance (tenant_id, employee_id, work_date, status,
                                 punch_in, punch_out, worked_minutes, source, site_id)
         SELECT $1, $2, $3::date, 'P', ($3 || ' 09:35+05:30')::timestamptz,
                ($3 || ' 18:40+05:30')::timestamptz, 485, 'web', $4
          WHERE NOT EXISTS (SELECT 1 FROM attendance
                             WHERE tenant_id = $1 AND employee_id = $2 AND work_date = $3::date)`,
        [T, emp, d, chn]);
    }
  }

  /* --- leave: one waiting, one decided ----------------------------------- */

  const v1 = await idOf('employee', 'VHM001');
  const v3 = await idOf('employee', 'VHM003');
  const v4 = await idOf('employee', 'VHM004');

  await db.query(
    `INSERT INTO leave_request (tenant_id, employee_id, leave_type_id, starts_on, ends_on,
                                days, reason, status)
     SELECT $1, $2, $3, DATE '2026-11-12', DATE '2026-11-13', 2, 'Family function', 'pending'
      WHERE NOT EXISTS (SELECT 1 FROM leave_request
                         WHERE tenant_id = $1 AND employee_id = $2
                           AND starts_on = DATE '2026-11-12')`,
    [T, v4, await idOf('leave_type', 'CL')]);

  await db.query(
    `INSERT INTO leave_request (tenant_id, employee_id, leave_type_id, starts_on, ends_on,
                                days, reason, status, approver_id, acted_on)
     SELECT $1, $2, $3, DATE '2026-10-09', DATE '2026-10-09', 1, 'Medical appointment',
            'approved', $4, DATE '2026-10-07'
      WHERE NOT EXISTS (SELECT 1 FROM leave_request
                         WHERE tenant_id = $1 AND employee_id = $2
                           AND starts_on = DATE '2026-10-09')`,
    [T, v3, await idOf('leave_type', 'EL'), v1]);

  /* --- the LOP flag, so local says what production now says -------------- */

  const lop = await db.query(
    "UPDATE leave_type SET paid = false WHERE tenant_id = $1 AND code = 'LOP' AND paid IS TRUE", [T]);

  /* --- assertions -------------------------------------------------------- */

  const one = async (sql) => (await db.query(sql, [T])).rows[0];

  console.log(`  added ${added} employee(s); LOP flag ${lop.rowCount ? 'corrected' : 'already right'}`);
  console.log(`${NL}  assertions:`);

  const emps = await one('SELECT count(*)::int n FROM employee WHERE tenant_id = $1');
  check('five employees', emps.n === 5, `${emps.n}`);

  const sites = await one(`SELECT count(DISTINCT s.code)::int n, string_agg(DISTINCT s.code, ' ') codes
                             FROM employee e JOIN site s ON s.id = e.site_id
                            WHERE e.tenant_id = $1`);
  check('across three sites', sites.n === 3, `${sites.n}: ${sites.codes}`);

  const roles = await one(`SELECT string_agg(DISTINCT app_role, ' ') r
                             FROM employee WHERE tenant_id = $1`);
  check('three roles held', (roles.r ?? '').split(' ').sort().join(' ')
    === 'company_admin employee hr_admin', String(roles.r));

  const reports = await one(`SELECT count(*)::int n FROM employee
                              WHERE tenant_id = $1 AND manager_id = (
                                SELECT id FROM employee WHERE tenant_id = $1 AND code = 'VHM003')`);
  check('VHM003 has reports, so is a manager', reports.n === 2, `${reports.n}`);

  const noSched = await one(`SELECT string_agg(e.code, ' ') c FROM employee e
                              WHERE e.tenant_id = $1 AND NOT EXISTS (
                                SELECT 1 FROM employee_schedule s WHERE s.employee_id = e.id)`);
  check('everybody has a work schedule', noSched.c === null, `without one: ${noSched.c}`);

  const lt = await one(`SELECT count(*)::int n,
                          bool_and(CASE WHEN code = 'LOP' THEN NOT paid ELSE paid END) ok
                          FROM leave_type WHERE tenant_id = $1`);
  check('seven leave types, only LOP unpaid', lt.n === 7 && lt.ok === true, `${lt.n}, paid=${lt.ok}`);

  const hol = await one('SELECT count(*)::int n FROM holiday WHERE tenant_id = $1');
  check('184 holidays', hol.n === 184, `${hol.n}`);

  const ast = await one(`SELECT count(*)::int n, count(employee_id)::int held
                           FROM asset WHERE tenant_id = $1`);
  check('four assets, three issued', ast.n === 4 && ast.held === 3, `${ast.n}, ${ast.held} issued`);

  const att = await one('SELECT count(*)::int n FROM attendance WHERE tenant_id = $1');
  check('twenty attendance rows', att.n === 20, `${att.n}`);

  const lr = await one(`SELECT count(*)::int n, count(*) FILTER (WHERE status = 'pending')::int p
                          FROM leave_request WHERE tenant_id = $1`);
  check('two leave requests, one waiting', lr.n === 2 && lr.p === 1, `${lr.n}, ${lr.p} pending`);

  if (problems) throw new Error(`${problems} assertion(s) failed`);

  await db.query('COMMIT');
  console.log(`${NL}  COMMITTED`);
} catch (e) {
  try { await db.query('ROLLBACK'); } catch { /* nothing open */ }
  console.error(`${NL}  ROLLED BACK: ${e.message}${NL}`);
  await db.end();
  process.exit(1);
}

const roster = (await db.query(
  `SELECT e.code, e.full_name, e.app_role, s.code AS site, m.code AS mgr,
          (SELECT count(*)::int FROM employee r WHERE r.manager_id = e.id) AS reports,
          (SELECT count(*)::int FROM employee_schedule x WHERE x.employee_id = e.id) AS sched
     FROM employee e
     LEFT JOIN site s ON s.id = e.site_id
     LEFT JOIN employee m ON m.id = e.manager_id
    WHERE e.tenant_id = $1 ORDER BY e.code`, [T])).rows;

console.log('');
console.log('  code    site    role            mgr      reports  schedule');
for (const r of roster) {
  console.log('  ' + r.code.padEnd(8) + String(r.site ?? '-').padEnd(8)
    + r.app_role.padEnd(16) + String(r.mgr ?? '-').padEnd(9)
    + String(r.reports).padEnd(9) + (r.sched ? 'yes' : 'NONE — unexpected, see the assertions'));
}
console.log('');
await db.end();
