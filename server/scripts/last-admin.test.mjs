/**
 * The last administrator cannot be removed, by either door.
 *
 * ## Why both halves
 *
 * A tenant with no active administrator cannot reach its own settings, cannot
 * create a login, and cannot give anybody the role back. There is no way out
 * from inside the application; the fix is a database session somebody has to be
 * talked through on the phone.
 *
 * Two acts lead there, and they are guarded in two different places:
 *
 *   deactivation — `setUserStatus` refuses to take the last administrator out
 *                  of service. This half counted.
 *   demotion     — `updateUser` changes the role. This half only ever asked
 *                  "is this me", so two administrators could take each other's
 *                  role away and arrive at the same locked-out tenant.
 *
 * No database trigger backs either one. The service guard is the whole
 * safeguard, which is the reason to test it rather than assume it.
 *
 * ## Both vocabularies
 *
 * The count reads `tenant_membership.role`, a column value the normaliser never
 * sees. During expand the column may hold `admin` or `company_admin`, so the
 * guard asks for both — and so does this suite, with one administrator spelled
 * each way. Asking for one name would count zero the moment step B ran, and the
 * guard would pass silently with the last administrator removable.
 *
 * Step C narrows the lists to `company_admin`, and these fixtures with them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and the last-administrator guard needs one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const users = await import('../src/modules/users/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `${NL}        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
const refused = async (label, fn, expect) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the call succeeded — the last administrator was removable');
  if (e) {
    ok('    in words a screen can show', expect.test(e.message), `${e.name}: ${e.message}`);
  }
  return e;
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(
  `SELECT (SELECT count(*)::int FROM tenant) t,
          (SELECT count(*)::int FROM tenant_membership) m,
          (SELECT count(*)::int FROM auth.users) u`)).rows[0];
const before = await census();

let fatal = null;
try {

await withScratchTenant(db, async (ctx) => {
  /*
   * The scratch tenant's own membership is `invited`, not `active`, because
   * `tenant_membership_user_once_usable` wants a user_id for anything further
   * along and these suites never talk to Supabase.
   *
   * That turns out to be exactly the caller this suite needs. The demotion
   * count is only reachable when the caller is *not* the account being
   * demoted — otherwise the self clause fires first — and the caller must be
   * an administrator to call `updateUser` at all. An administrator whose own
   * membership is not active satisfies both: they may act, and they are not in
   * the count. It is also a real situation, which is the better reason to use
   * it: an invited administrator, or one whose membership was deactivated
   * while their token still says company_admin.
   */
  const A = {
    role: 'company_admin', hasReports: false,
    tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };

  /* dept and site arrive as codes; entity and shift as ids. */
  const deptId = (await db.query(
    'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
    [ctx.tenant, ctx.dept])).rows[0].id;
  const siteId = (await db.query(
    'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
    [ctx.tenant, ctx.site])).rows[0].id;

  const employee = async (name) => (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     VALUES ($1, $2, $3, $4, 'active', 'employee', $5, $6, $7, $8, CURRENT_DATE)
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name,
      `zz-lastadmin-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      deptId, siteId, ctx.entityId, ctx.shiftId])).rows[0].id;

  /**
   * An active membership, spelled as given.
   *
   * The guard counts only *active* memberships, so an invited row would not
   * exercise it. That means creating the `auth.users` rows the other suites
   * deliberately avoid — plain rows in a local table here, not Supabase
   * accounts; only `id` is required, and they are removed at the end.
   */
  const authUsers = [];
  const membershipFor = async (employeeId, role) => {
    const userId = (await db.query(
      'INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id')).rows[0].id;
    authUsers.push(userId);
    return (await db.query(
      `INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [ctx.tenant, userId, role, employeeId])).rows[0].id;
  };

  const roleOf = async (id) => (await db.query(
    'SELECT role FROM tenant_membership WHERE id = $1', [id])).rows[0]?.role;
  const statusOf = async (id) => (await db.query(
    'SELECT status FROM tenant_membership WHERE id = $1', [id])).rows[0]?.status;
  const activeAdmins = async () => (await db.query(
    `SELECT count(*)::int n FROM tenant_membership
      WHERE tenant_id = $1 AND role = ANY($2) AND status = 'active'`,
    [ctx.tenant, ['company_admin']])).rows[0].n;

  console.log(`${NL}the demotion half${NL}`);

  ok('the scratch tenant starts with no administrator in service',
    (await activeAdmins()) === 0, `found ${await activeAdmins()}`);

  const oneEmp = await employee('ZZ Admin One');
  const one = await membershipFor(oneEmp, 'company_admin');
  const twoEmp = await employee('ZZ Admin Two');
  const two = await membershipFor(twoEmp, 'company_admin');
  ok('  two are created for this suite', (await activeAdmins()) === 2,
    `found ${await activeAdmins()}`);

  await users.updateUser(A, one, { role: 'employee' });
  ok('with two administrators, one may be demoted', (await roleOf(one)) === 'employee',
    `role is now ${await roleOf(one)}`);
  ok('  leaving one', (await activeAdmins()) === 1, `found ${await activeAdmins()}`);

  await refused('the last administrator cannot be demoted',
    () => users.updateUser(A, two, { role: 'employee' }),
    /last (active )?administrator/i);
  ok('  and the role is unchanged', (await roleOf(two)) === 'company_admin',
    `role is now ${await roleOf(two)}`);

  console.log(`${NL}the deactivation half${NL}`);

  await refused('the last administrator cannot be taken out of service',
    () => users.setUserStatus(A, two, 'Inactive'),
    /last (active )?administrator/i);
  ok('  and the membership is still active', (await statusOf(two)) === 'active',
    `status is now ${await statusOf(two)}`);

  console.log(`${NL}the old spelling cannot be written at all${NL}`);

  /*
   * What stood here, and why this replaces it.
   *
   * Until step C a membership could legally hold 'admin', and the block here
   * proved the guard counted it: with the only *other* administrator spelled
   * the old way, demoting the new-spelled one had to be allowed, because
   * `ADMIN_ROLES` asking for 'company_admin' alone would have counted zero and
   * refused. That refusal would have looked like the guard working while
   * hiding the real fault — the last administrator removable, because the
   * count could not see the row that was holding the door.
   *
   * 0060 narrowed the CHECK constraints, so that row cannot exist and the
   * scenario cannot be built. The invariant itself is covered above, in the
   * only vocabulary there now is.
   *
   * What is left worth asserting is the *premise*. "There is one spelling" is
   * now load-bearing for both halves of this suite, and the thing that makes
   * it true is the database, not everybody who writes a role remembering to.
   * So these four prove the constraint refuses the old value on insert and on
   * update, in both columns that hold a role. If a later migration widens
   * those constraints again — the way 0056 widened them for expand — these
   * fail loudly, instead of the two halves above quietly stopping covering a
   * case that had become possible again.
   */
  const refusedByCheck = async (label, sql, params, constraint) => {
    try {
      await db.query(sql, params);
      ok(label, false, 'the write was accepted');
    } catch (err) {
      /*
       * The code matters as much as the failure. A typo in a column name also
       * throws, and would pass a test that only asked whether something went
       * wrong — 23514 is check_violation, and naming the constraint says which
       * one did the refusing.
       */
      ok(label, err?.code === '23514' && err?.constraint === constraint,
        `${err?.code ?? '?'} ${err?.constraint ?? '?'}: ${String(err?.message ?? '').slice(0, 70)}`);
    }
  };

  const probeUser = (await db.query(
    'INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id')).rows[0].id;
  authUsers.push(probeUser);
  const probeEmp = await employee('ZZ Constraint Probe');

  await refusedByCheck(
    "tenant_membership.role refuses 'admin' on insert",
    `INSERT INTO tenant_membership (tenant_id, user_id, role, employee_id, status)
     VALUES ($1, $2, 'admin', $3, 'active')`,
    [ctx.tenant, probeUser, probeEmp],
    'tenant_membership_role_check');

  await refusedByCheck(
    '  and on update, which is the way a demotion would write it',
    "UPDATE tenant_membership SET role = 'admin' WHERE id = $1",
    [two],
    'tenant_membership_role_check');

  await refusedByCheck(
    "employee.app_role refuses 'admin' on insert",
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     VALUES ($1, 'ZZPRB1', 'ZZ Constraint Probe Two', 'zz-probe-two@360.technology',
             'active', 'admin', $2, $3, $4, $5, CURRENT_DATE)`,
    [ctx.tenant, deptId, siteId, ctx.entityId, ctx.shiftId],
    'employee_app_role_check');

  await refusedByCheck(
    '  and on update',
    "UPDATE employee SET app_role = 'admin' WHERE id = $1",
    [probeEmp],
    'employee_app_role_check');

  /* None of those wrote anything, so the one administrator is still the one. */
  ok('  and none of that changed who is an administrator',
    (await activeAdmins()) === 1, `found ${await activeAdmins()}`);

  console.log(`${NL}and nobody demotes themselves${NL}`);

  /* A second administrator, so the self clause is what refuses, not the count. */
  const selfEmp = await employee('ZZ Self Admin');
  const self = await membershipFor(selfEmp, 'company_admin');
  const S = {
    role: 'company_admin', hasReports: false,
    tenantId: ctx.tenant, employeeId: selfEmp, userId: null,
  };
  ok('with two administrators in service', (await activeAdmins()) === 2,
    `found ${await activeAdmins()}`);

  await refused('an administrator cannot remove their own role',
    () => users.updateUser(S, self, { role: 'employee' }),
    /your own administrator role/i);
  ok('  so the self clause refuses before the count is reached',
    (await roleOf(self)) === 'company_admin', `role is ${await roleOf(self)}`);

  /*
   * The tenant delete takes the memberships with it, but auth.users sits
   * outside the tenant and its cascade runs the other way, so these go by hand.
   */
  for (const id of authUsers) {
    await db.query('DELETE FROM auth.users WHERE id = $1', [id]);
  }
});

} catch (e) {
  fatal = e;
}

console.log(`${NL}the database is as it was${NL}`);
const after = await census();
ok('tenants', after.t === before.t, `${before.t} -> ${after.t}`);
ok('memberships', after.m === before.m, `${before.m} -> ${after.m}`);
ok('auth users', after.u === before.u, `${before.u} -> ${after.u}`);

const swept = await sweepScratchTenants(db);
ok('no scratch tenant remains', swept.length === 0, `${swept.join(', ')} left`);

await db.end();

if (fatal) {
  console.error(`${NL}the run did not finish: ${fatal.message}`);
  console.error(fatal.stack);
  process.exit(1);
}
console.log('');
if (failed) { console.error(`${failed} problem(s)${NL}`); process.exit(1); }
console.log(`the last administrator cannot be demoted or deactivated, under either name${NL}`);
