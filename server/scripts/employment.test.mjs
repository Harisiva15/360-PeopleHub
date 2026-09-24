/**
 * Employment history is written, and it is the history the lifecycle reads.
 *
 * `employment_record` has been in the schema since 0003 and was written by
 * nothing. Three derived lifecycle stages depended on it and none could fire:
 * Promotion and Transfer read the last quarter's moves, and the probation
 * branch ends when a `probation_confirmed` row appears. With an empty table a
 * promotion made through User Management changed a column, wrote an audit
 * line, and left no trace an HR system would recognise.
 *
 * So the assertions here are about the database, not the response. The service
 * returning a plausible object proves nothing when the question is whether a
 * row exists; several of these read `employment_record` directly with the
 * migration connection, precisely so a service bug cannot mark its own work.
 *
 * Runs in a scratch tenant, dropped at the end. The live tenant is never
 * addressed — no historical record is invented for anybody real, because there
 * is no source from which an accurate one could be reconstructed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

/* ------------------------------------------------------------------ *
 * 1. The mapping, without a database
 * ------------------------------------------------------------------ */

const { reasonForChange } = await import('../src/modules/people/employment.ts');

console.log('\nwhich changes are employment history\n');

const terms = (o = {}) => ({
  departmentId: 'd1', siteId: 's1', designation: 'Engineer', managerId: 'm1', ...o,
});

ok('an unchanged record is not history',
  reasonForChange(terms(), terms()) === null);
ok('a department move is a transfer',
  reasonForChange(terms(), terms({ departmentId: 'd2' })) === 'transfer');
ok('a site move is a transfer',
  reasonForChange(terms(), terms({ siteId: 's2' })) === 'transfer');
ok('a designation change is a role change',
  reasonForChange(terms(), terms({ designation: 'Senior Engineer' })) === 'role_change');
ok('a reporting-line change is a role change',
  reasonForChange(terms(), terms({ managerId: 'm2' })) === 'role_change');
ok('a move that also changes the title is still a transfer',
  reasonForChange(terms(), terms({ departmentId: 'd2', designation: 'X' })) === 'transfer',
  'the department is the larger fact; the lifecycle stage reads it that way');
ok('nothing here ever guesses "promotion"',
  reasonForChange(terms(), terms({ designation: 'Director' })) !== 'promotion',
  'deciding a new title is a promotion is a judgement about grade and pay that '
  + 'this product does not capture — it would put Promotion on a renamed job');

/* ------------------------------------------------------------------ *
 * 2. Against a database
 * ------------------------------------------------------------------ */

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED the live half: no database.\n');
  process.exit(failed ? 1 : 0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { setAuthAdmin } = await import('../src/auth/adminApi.ts');
const users = await import('../src/modules/users/service.ts');
const lifecycle = await import('../src/modules/lifecycle/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

setAuthAdmin({ inviteToSetPassword: () => Promise.resolve({ kind: 'invited' }) });

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const liveBefore = (await db.query(`
  SELECT (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM employment_record) h,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];

await sweepScratchTenants(db);

let fatal = null;
try {
await withScratchTenant(db, async (ctx) => {
  const ADMIN = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const tag = Math.random().toString(36).slice(2, 7);

  const history = async (empId) => (await db.query(
    `SELECT reason, valid_from::text AS valid_from, valid_to::text AS valid_to,
            designation, department_id, manager_id, site_id, recorded_by
       FROM employment_record WHERE employee_id = $1
      ORDER BY valid_from, recorded_at`, [empId])).rows;

  /*
   * Hired sixty days ago, not today.
   *
   * A change on the day the open record began amends it rather than opening a
   * new one — see `recordEmployment`. That is right, and it means an employee
   * created and moved within the same run would exercise the amendment path
   * every time and the supersede path never. Backdating makes these the real
   * case: somebody who has been here a while and moves today.
   */
  const daysAgo = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const make = async (name, extra = {}) => {
    const a = await users.createUser(ADMIN, {
      name, email: `zz-emp-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      dept: ctx.dept, site: ctx.site, designation: 'ZZ Engineer', role: 'employee',
      joinedOn: daysAgo(60), ...extra,
    });
    const empId = (await db.query(
      'SELECT employee_id FROM tenant_membership WHERE id = $1', [a.id])).rows[0].employee_id;
    return { account: a, empId };
  };

  /* ---------------- A. creation ---------------- */

  console.log('\nA. creating somebody opens their employment record\n');

  const { account: acct, empId } = await make(`ZZ Hist ${tag}`);
  const h0 = await history(empId);
  ok('one record exists', h0.length === 1, `${h0.length} found`);
  ok('  its reason is hire', h0[0]?.reason === 'hire', h0[0]?.reason);
  ok('  it is open', h0[0]?.valid_to === null, h0[0]?.valid_to);
  ok('  it carries the designation they were hired into',
    h0[0]?.designation === 'ZZ Engineer', h0[0]?.designation);
  ok('  and their department', h0[0]?.department_id !== null);
  ok('  recorded by the administrator who created them',
    h0[0]?.recorded_by === ctx.adminEmployeeId);
  ok('  dated from the joining date, not from today',
    h0[0]?.valid_from === daysAgo(60), h0[0]?.valid_from);

  /* ---------------- B. manager change ---------------- */

  console.log('\nB. a reporting-line change is recorded\n');

  const { empId: bossId } = await make(`ZZ Boss ${tag}`, { role: 'manager' });
  await users.updateUser(ADMIN, acct.id, { managerId: bossId });

  const h1 = await history(empId);
  ok('a second record is opened', h1.length === 2, `${h1.length} found`);
  ok('  the first is closed', h1[0]?.valid_to !== null, h1[0]?.valid_to);
  ok('  and they meet without overlapping',
    h1[0]?.valid_to < h1[1]?.valid_from, `${h1[0]?.valid_to} then ${h1[1]?.valid_from}`);
  ok('  the new one is a role change', h1[1]?.reason === 'role_change', h1[1]?.reason);
  ok('  naming the new manager', h1[1]?.manager_id === bossId);
  ok('  and the employee row agrees',
    (await db.query('SELECT manager_id FROM employee WHERE id = $1', [empId]))
      .rows[0].manager_id === bossId);

  /* ---------------- C. department change ---------------- */

  /*
   * A fresh person for each transition.
   *
   * Every change in this run happens today, so a second change to the same
   * employee amends the record the first one opened rather than superseding
   * it. That is the intended behaviour and is asserted below on its own — but
   * it means each transition needs somebody whose open record began before
   * today if it is to exercise the supersede path.
   */
  console.log('\nC. a department move is recorded as a transfer\n');

  await db.query(
    `INSERT INTO department (tenant_id, code, name, active)
     VALUES ($1, 'ZZOPS', 'ZZ Operations', true)`, [ctx.tenant]);

  const { account: mover, empId: moverId } = await make(`ZZ Mover ${tag}`);
  await users.updateUser(ADMIN, mover.id, { dept: 'ZZOPS' });

  const h2 = await history(moverId);
  const opsId = (await db.query(
    "SELECT id FROM department WHERE code = 'ZZOPS'")).rows[0].id;
  ok('a second record is opened', h2.length === 2, `${h2.length} found`);
  ok('  its reason is transfer', h2[1]?.reason === 'transfer', h2[1]?.reason);
  ok('  carrying the new department', h2[1]?.department_id === opsId);
  ok('  and the one before it kept the old department',
    h2[0]?.department_id !== opsId && h2[0]?.valid_to !== null);

  /* ---------------- D. designation change ---------------- */

  console.log('\nD. a title change is recorded\n');

  const { account: titled, empId: titledId } = await make(`ZZ Titled ${tag}`);
  await users.updateUser(ADMIN, titled.id, { designation: 'ZZ Senior Engineer' });

  const h3 = await history(titledId);
  ok('a second record is opened', h3.length === 2, `${h3.length} found`);
  ok('  as a role change, not a promotion', h3[1]?.reason === 'role_change', h3[1]?.reason);
  ok('  carrying the new title', h3[1]?.designation === 'ZZ Senior Engineer');

  console.log('\n   and an edit that is not employment history writes nothing\n');

  const { account: quiet, empId: quietId } = await make(`ZZ Quiet ${tag}`);
  await users.updateUser(ADMIN, quiet.id, { phone: '9999999999' });
  ok('a phone number opens no record', (await history(quietId)).length === 1);
  await users.updateUser(ADMIN, quiet.id, { name: `ZZ Quiet ${tag} Renamed` });
  ok('nor does a rename', (await history(quietId)).length === 1);
  await users.updateUser(ADMIN, quiet.id, { email: `zz-renamed-${tag}@360.technology` });
  ok('nor does an email change', (await history(quietId)).length === 1);

  /* ---------------- same-day amendment ---------------- */

  console.log('\n   two changes on one day amend rather than stack\n');

  /*
   * The record opened above began today, so a second change today amends it.
   * The alternative would be a slice from today to today, or a valid_to before
   * its own valid_from, which the table's CHECK forbids.
   */
  const before = await history(moverId);
  await users.updateUser(ADMIN, mover.id, { designation: 'ZZ Staff Engineer' });
  const after = await history(moverId);
  ok('the record count does not grow', after.length === before.length,
    `${before.length} then ${after.length}`);
  ok('  exactly one record is still open',
    after.filter((r) => r.valid_to === null).length === 1);
  ok('  and it carries the latest title',
    after.at(-1)?.designation === 'ZZ Staff Engineer', after.at(-1)?.designation);
  ok('  with no zero-length or inverted slice',
    after.every((r) => r.valid_to === null || r.valid_to >= r.valid_from));

  /* ---------------- the lifecycle reads it ---------------- */

  console.log('\nthe lifecycle timeline is this history\n');

  const detail = await lifecycle.getLifecycle(ADMIN, moverId);
  ok('the timeline is not empty', (detail?.events.length ?? 0) === 2,
    `${detail?.events.length} events`);
  ok('  newest first', detail.events[0].on >= detail.events[1].on);
  ok('  the oldest is the hire', detail.events.at(-1).type === 'hire');
  ok('  each carries the title it moved to', detail.events[0].to === 'ZZ Staff Engineer',
    detail.events[0].to);
  ok('  and the one before it is what it moved from',
    detail.events[0].from === detail.events[1].to);

  const stage = await lifecycle.listLifecycle(ADMIN, {});
  const mine = stage.find((r) => r.subject.id === moverId);
  ok('the stage derivation now sees a recent move',
    ['Transfer', 'Promotion'].includes(mine?.standing.stage ?? ''),
    `stage was ${mine?.standing.stage} — with no history this could only ever be Joined or Active`);

  /* ---------------- E. exit ---------------- */

  console.log('\nE. leaving closes the record rather than opening one\n');

  const { empId: leaverId } = await make(`ZZ Leaver ${tag}`);
  const lwd = '2026-09-30';
  await db.query(
    `INSERT INTO exit_record (tenant_id, employee_id, kind, resigned_on,
                              notice_days, last_working_day, status)
     VALUES ($1, $2, 'resignation', CURRENT_DATE, 30, $3::date, 'in_clearance')`,
    [ctx.tenant, leaverId, lwd]);
  await db.query("UPDATE employee SET status = 'exited', left_on = $2 WHERE id = $1",
    [leaverId, lwd]);
  const { closeEmployment } = await import('../src/modules/people/employment.ts');
  await db.query("SELECT set_config('app.tenant_id', $1, false)", [ctx.tenant]);
  await closeEmployment(db, leaverId, lwd, ctx.adminEmployeeId);

  const hx = await history(leaverId);
  ok('no new record is opened', hx.length === 1, `${hx.length} found`);
  ok('  the existing one is closed on the last working day',
    hx[0]?.valid_to === lwd, hx[0]?.valid_to);
  ok('  so nothing answers as their current terms',
    hx.filter((r) => r.valid_to === null).length === 0);

  /* ---------------- 7. negative and authorization ---------------- */

  console.log('\nwhat is refused\n');

  const badEmp = await attempt(() => users.updateUser(
    ADMIN, '00000000-0000-0000-0000-000000000000', { designation: 'ZZ X' }));
  ok('an unknown account is refused', badEmp !== null);
  ok('  as not-found', badEmp?.code === 'not_found', badEmp?.code);

  const badDept = await attempt(() => users.updateUser(ADMIN, mover.id, { dept: 'ZZNOSUCH' }));
  ok('an unknown department is refused', badDept !== null);
  ok('  as invalid, not a database error',
    badDept?.code === 'invalid' && !/syntax|constraint/i.test(badDept.message),
    `${badDept?.code} ${badDept?.message}`);

  const badMgr = await attempt(() => users.updateUser(
    ADMIN, mover.id, { managerId: '00000000-0000-0000-0000-000000000000' }));
  ok('an unknown manager is refused', badMgr !== null,
    'without a check this reaches the foreign key and returns a raw 23503');

  console.log('\n  and neither leaves a partial change\n');

  const afterFailures = await history(moverId);
  ok('no record was opened by a refused edit', afterFailures.length === 2,
    `${afterFailures.length} found — a refusal must roll back the history too`);
  const desig = (await db.query(
    'SELECT designation FROM employee WHERE id = $1', [moverId])).rows[0];
  ok('  and the employee row is unchanged', desig.designation === 'ZZ Staff Engineer',
    desig.designation);

  console.log('\nauthorization\n');

  const EMP = { role: 'employee', tenantId: ctx.tenant, employeeId: empId, userId: null };
  const MGR = { role: 'manager', tenantId: ctx.tenant, employeeId: bossId, userId: null };

  const byEmployee = await attempt(() => users.updateUser(EMP, acct.id, { designation: 'ZZ Boss' }));
  ok('an employee cannot change their own designation', byEmployee !== null);
  ok('  refused as forbidden', byEmployee?.code === 'forbidden', byEmployee?.code);

  const { empId: strangerId, account: stranger } = await make(`ZZ Stranger ${tag}`);
  const byManager = await attempt(() => users.updateUser(
    MGR, stranger.id, { designation: 'ZZ Whatever' }));
  ok('a manager cannot change somebody outside their line', byManager !== null,
    'the manager scope is a SQL predicate, not a screen');

  const okByManager = await attempt(() => users.updateUser(
    MGR, acct.id, { designation: 'ZZ Lead Engineer' }));
  ok('but may change their own report', okByManager === null,
    okByManager?.message);
  const h5 = await history(empId);
  ok('  and that is recorded against them',
    h5.at(-1)?.designation === 'ZZ Lead Engineer', h5.at(-1)?.designation);
  ok('  naming the manager as the recorder', h5.at(-1)?.recorded_by === bossId);

  ok('nothing was written for the stranger',
    (await history(strangerId)).length === 1,
    'only their hire record should exist');
});
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the run stopped: ${e.message}`);
}

/* ------------------------------------------------------------------ *
 * 12. production safety
 * ------------------------------------------------------------------ */

console.log('\nthe live tenant was never written to\n');

const liveAfter = (await db.query(`
  SELECT (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM employment_record) h,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];

ok(`employees ${liveAfter.e}`, liveAfter.e === liveBefore.e, `was ${liveBefore.e}`);
ok(`employment records ${liveAfter.h}`, liveAfter.h === liveBefore.h,
  `was ${liveBefore.h} — no history was invented for anybody real`);
ok(`tenants ${liveAfter.t}`, liveAfter.t === liveBefore.t, `was ${liveBefore.t}`);
ok(`audit rows ${liveAfter.a}`, liveAfter.a === liveBefore.a, `was ${liveBefore.a}`);
ok('no scratch tenant remains',
  (await db.query("SELECT count(*)::int n FROM tenant WHERE slug LIKE 'zz-scratch-%'"))
    .rows[0].n === 0);

const adminRow = (await db.query(
  "SELECT app_role, status FROM employee WHERE code = 'VHM004'")).rows[0];
ok('the existing administrator is untouched',
  adminRow?.app_role === 'admin' && adminRow.status === 'active', JSON.stringify(adminRow));

const pay = (await db.query('SELECT status, locked FROM pay_run')).rows[0];
ok('payroll is still paid and locked',
  pay?.status === 'paid' && pay.locked === true, JSON.stringify(pay));

await db.end();

if (fatal) console.log(`\nstopped early; its tenant was dropped regardless:\n  ${fatal.stack}`);

console.log(failed
  ? `\n${failed} problem(s)`
  : '\nemployment history is written where employment changes, and nowhere else');
process.exit(failed ? 1 : 0);
