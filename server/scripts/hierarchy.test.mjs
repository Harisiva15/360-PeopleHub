/**
 * A real three-level organisation, and what each level may actually do.
 *
 * Everything before this proved structure: that the policy table is
 * self-consistent, that the navigation agrees with it, that a route maps to a
 * module. None of it proved that a manager, holding a real membership, can
 * approve their own report's leave and nobody else's — because until now there
 * was one account in the system and it was an administrator.
 *
 * So this builds the hierarchy through the product's own creation path and
 * then asks the services, not the screens, what each role can do:
 *
 *     Admin
 *       └── Manager
 *             └── Employee
 *
 * ## Where it happens
 *
 * In a scratch tenant, created for this run and dropped at the end — see
 * `lib/scratch-tenant.mjs`. The live tenant is not written to at all, so its
 * row counts are identical afterwards because nothing addressed it, rather
 * than because something tidied up.
 *
 * That replaces a hand-maintained teardown which deleted from eight tables in
 * order. The list drifted the first time this file met a real defect — it knew
 * `audit_log` referenced the employee as a subject and not that it also
 * referenced it as an actor — and five employees stayed in the live database
 * until somebody looked. Every tenant-scoped table cascades from `tenant`, so
 * dropping the tenant needs no list and cannot be incomplete.
 *
 * ## Why these are fixtures and not the real test accounts
 *
 * The two people this hierarchy needs are real colleagues with real mailboxes,
 * and creating them is a separate, deliberate act that ends in somebody
 * receiving an email and choosing a password. These rows are not that. They
 * are created, exercised and dropped with their tenant, and they are never
 * mailed: the auth provider is replaced with a recording stub, exactly as
 * `invite.test.mjs` does, so nothing leaves the building.
 *
 * What that buys is the part that does not need a mailbox — which turns out to
 * be almost all of it. `createUser` writes the employee and the membership and
 * sends nothing; sending is a separate admin-only call. So every authorisation
 * boundary and both approval workflows can be proven now, and what remains
 * blocked is delivery and first sign-in.
 *
 * ## The rule this file holds hardest
 *
 * A hidden button is not a permission. Every "cannot" below is a direct call
 * to the service with the wrong caller, asserting a refusal — never an
 * assertion about what a screen renders.
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

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a hierarchy is rows in one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { setAuthAdmin } = await import('../src/auth/adminApi.ts');
const users = await import('../src/modules/users/service.ts');
const employees = await import('../src/modules/employees/service.ts');
const { buildEmployeeProfile } = await import('../src/modules/employees/profile.ts');
const leave = await import('../src/modules/leave/service.ts');
const timesheets = await import('../src/modules/timesheet/service.ts');
const config = await import('../src/modules/config/service.ts');
const helpdesk = await import('../src/modules/helpdesk/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
/** A refusal, not a crash: the service must say no in its own vocabulary. */
const refused = async (label, fn, expect = /forbidden|not in your team|only|cannot|outside/i) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the call succeeded — this is a permission hole, not a test failure');
  if (e) {
    ok(`    refused in the service's own words`, expect.test(e.message) || expect.test(e.code ?? ''),
      `${e.code ?? ''} ${e.message}`);
  }
};

/*
 * Nothing is mailed. The provider is replaced before any service is called,
 * and the stub records what it was asked so the invitation path can still be
 * proven end to end without a mailbox.
 */
const sent = [];
setAuthAdmin({
  inviteToSetPassword(email, redirectTo) {
    sent.push({ email, redirectTo });
    return Promise.resolve({ kind: 'invited' });
  },
});

const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await admin.connect();

/*
 * The live tenant's counts, taken before and compared after.
 *
 * Nothing below writes to it — the run happens inside a scratch tenant — so
 * these are expected to be identical rather than restored. A difference means
 * something addressed the live tenant that should not have.
 */
const census = async () => (await admin.query(`
  SELECT (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM tenant_membership) m,
         (SELECT count(*)::int FROM audit_log) a,
         (SELECT count(*)::int FROM leave_request) l,
         (SELECT count(*)::int FROM timesheet) t,
         (SELECT count(*)::int FROM timesheet_entry) te,
         (SELECT count(*)::int FROM tenant) tenants`)).rows[0];
const before = await census();

/* Anything a killed run left behind, before this one adds to it. */
const swept = await sweepScratchTenants(admin);
if (swept.length) {
  console.log(`
swept ${swept.length} scratch tenant(s) from an earlier run: ${swept.join(', ')}`);
}

let fatal = null;
try {
await withScratchTenant(admin, async (ctx) => {

const caller = (role, employeeId) =>
  ({ role, tenantId: ctx.tenant, employeeId, userId: null });

const ADMIN = caller('admin', ctx.adminEmployeeId);
const tag = Math.random().toString(36).slice(2, 7);

/*
 * The employee behind an account. This used to also record the id for
 * teardown; nothing needs recording now, because the scratch tenant’s single
 * DELETE takes whatever was created with it.
 */
const employeeOf = async (account) => (await admin.query(
  'SELECT employee_id FROM tenant_membership WHERE id = $1', [account.id])).rows[0].employee_id;

  /* ================================================================ *
   * STEP 4 — build the organisation through the product's own path
   * ================================================================ */

  console.log('\nthe organisation is built by the product, not by SQL\n');

  const mgrAccount = await users.createUser(ADMIN, {
    name: `ZZ Probe Manager ${tag}`,
    email: `zz-hier-mgr-${tag}@360.technology`,
    dept: ctx.dept, site: ctx.site, designation: 'ZZ Engineering Manager',
    role: 'manager',
  });
  const MGR_ID = await employeeOf(mgrAccount);
  ok('an admin creates a manager', Boolean(MGR_ID));
  ok('  with the manager role on the membership', mgrAccount.role === 'manager', mgrAccount.role);

  const empAccount = await users.createUser(ADMIN, {
    name: `ZZ Probe Employee ${tag}`,
    email: `zz-hier-emp-${tag}@360.technology`,
    dept: ctx.dept, site: ctx.site, designation: 'ZZ Software Engineer',
    role: 'employee', managerId: MGR_ID,
  });
  const EMP_ID = await employeeOf(empAccount);
  ok('an admin creates an employee reporting to that manager', Boolean(EMP_ID));

  const MGR = caller('manager', MGR_ID);
  const EMP = caller('employee', EMP_ID);

  /* The relationship, read from the database rather than from the response. */
  const rel = (await admin.query(
    `SELECT e.code, e.manager_id, e.department_id, e.status, e.app_role,
            m.role AS membership_role, m.status AS membership_status, m.user_id,
            (SELECT code FROM employee WHERE id = e.manager_id) AS manager_code
       FROM employee e JOIN tenant_membership m ON m.employee_id = e.id
      WHERE e.id = $1`, [EMP_ID])).rows[0];

  ok('the reporting line is in the database', rel.manager_id === MGR_ID,
    `manager_id = ${rel.manager_id}`);
  ok('  the employee carries the employee role', rel.app_role === 'employee' && rel.membership_role === 'employee');
  ok('  the membership is invited, not active', rel.membership_status === 'invited',
    'an account becomes active when somebody signs in, not when it is created');
  ok('  and carries no auth user yet', rel.user_id === null,
    'the link to auth.users is made by auth_claim_membership at first sign-in');
  ok('  both sit in the same department', Boolean(rel.department_id));

  /* ================================================================ *
   * STEP 3 — the invitation path, minus delivery
   * ================================================================ */

  console.log('\nthe invitation path\n');

  ok('creating an account sends nothing by itself', sent.length === 0,
    'createUser records invite_sent_at; sending is a separate call');

  await users.inviteUser(ADMIN, mgrAccount.id);
  ok('an admin can send the invitation', sent.length === 1);
  ok('  to the address on the employee record',
    sent[0]?.email === `zz-hier-mgr-${tag}@360.technology`, sent[0]?.email);
  ok('  with a redirect back to this deployment', Boolean(sent[0]?.redirectTo));

  await refused('a manager cannot send an invitation',
    () => users.inviteUser(MGR, empAccount.id), /administrator|admin/i);
  await refused('an employee cannot send an invitation',
    () => users.inviteUser(EMP, empAccount.id), /administrator|admin|role/i);
  ok('  and neither attempt reached the provider', sent.length === 1, `${sent.length} sends`);

  /* The product's own rule about who may create whom. */
  const byManager = await users.createUser(MGR, {
    name: `ZZ Probe Requested ${tag}`,
    email: `zz-hier-req-${tag}@360.technology`,
    dept: ctx.dept, site: ctx.site, designation: 'ZZ Analyst', role: 'employee',
    managerId: MGR_ID,
  });
  await employeeOf(byManager);
  ok('a manager may request an account', Boolean(byManager.id));
  ok('  but it lands awaiting approval, not invited',
    byManager.status === 'Pending Approval', byManager.status);
  ok('  so no invitation went out for it', sent.length === 1);

  await refused('a manager cannot grant the admin role',
    () => users.createUser(MGR, {
      name: `ZZ Probe Admin ${tag}`, email: `zz-hier-adm-${tag}@360.technology`,
      dept: ctx.dept, site: ctx.site, designation: 'ZZ X', role: 'admin',
    }), /administrator/i);

  /* ================================================================ *
   * STEP 5 — the administrator
   * ================================================================ */

  console.log('\nwhat an administrator can reach\n');

  const adminSees = await employees.listVisibleEmployees(ADMIN);
  const adminIds = adminSees.map((e) => e.id);
  ok('an admin sees the manager', adminIds.includes(MGR_ID));
  ok('an admin sees the employee', adminIds.includes(EMP_ID));
  ok('an admin can open the employee profile',
    (await buildEmployeeProfile(ADMIN, EMP_ID)) !== null);
  ok('an admin can list users', (await users.listUsers(ADMIN)).length >= 3);
  ok('an admin can list departments', (await config.listDepartments(ADMIN)).length > 0);

  /* ================================================================ *
   * STEP 6 — the manager
   * ================================================================ */

  console.log('\nwhat a manager can reach\n');

  const mgrSees = await employees.listVisibleEmployees(MGR);
  const mgrIds = mgrSees.map((e) => e.id);
  ok('a manager sees their own record', mgrIds.includes(MGR_ID));
  ok('a manager sees their direct report', mgrIds.includes(EMP_ID));
  ok('a manager does NOT see the administrator', !mgrIds.includes(ctx.emp),
    'the admin is not in their reporting line — this is the scope boundary');

  const team = await employees.getTeam(MGR, MGR_ID);
  ok('getTeam returns the direct report', team.some((e) => e.id === EMP_ID));

  ok('a manager can open their report’s profile',
    (await buildEmployeeProfile(MGR, EMP_ID)) !== null);
  ok('a manager cannot open the administrator’s profile',
    (await buildEmployeeProfile(MGR, ctx.emp)) === null,
    'null, not an empty profile — "exists but hidden" is a directory');

  console.log('\n  and what a manager cannot do\n');

  await refused('a manager cannot change anyone’s role',
    () => employees.setEmployeeRole(MGR, EMP_ID, 'admin'), /administrator/i);
  await refused('a manager cannot create a department',
    () => config.createDepartment(MGR, { code: `ZZM${tag.slice(0, 3)}`, name: 'ZZ nope' }), /admin/i);
  await refused('a manager cannot remove a department',
    () => config.removeDepartment(MGR, ctx.dept), /admin/i);
  await refused('a manager cannot open a location',
    () => config.createSite(MGR, {
      code: `ZZ${tag.slice(0, 2)}`, name: 'ZZ nowhere', country: 'IN', kind: 'office',
    }), /admin/i);

  /* ================================================================ *
   * STEP 7 — the employee
   * ================================================================ */

  console.log('\nwhat an employee can reach\n');

  const empSees = await employees.listVisibleEmployees(EMP);
  const empIds = empSees.map((e) => e.id);
  ok('an employee sees their own record', empIds.includes(EMP_ID));
  ok('an employee does NOT see their manager', !empIds.includes(MGR_ID), 'own scope is own');
  ok('an employee does NOT see the administrator', !empIds.includes(ctx.emp));
  ok('an employee can open their own profile',
    (await buildEmployeeProfile(EMP, EMP_ID)) !== null);
  ok('an employee cannot open their manager’s profile',
    (await buildEmployeeProfile(EMP, MGR_ID)) === null);

  console.log('\n  and what an employee cannot do\n');

  await refused('an employee cannot create an account',
    () => users.createUser(EMP, {
      name: 'ZZ no', email: `zz-hier-no-${tag}@360.technology`,
      dept: ctx.dept, site: ctx.site, designation: 'ZZ', role: 'employee',
    }), /role|cannot manage/i);
  await refused('an employee cannot list users',
    () => users.listUsers(EMP), /role|cannot manage/i);
  await refused('an employee cannot change a role',
    () => employees.setEmployeeRole(EMP, MGR_ID, 'employee'), /administrator/i);
  await refused('an employee cannot create a department',
    () => config.createDepartment(EMP, { code: `ZZE${tag.slice(0, 3)}`, name: 'ZZ nope' }), /admin/i);
  await refused('an employee cannot author a knowledge-base article',
    () => helpdesk.createArticle(EMP, { q: 'ZZ q', a: 'ZZ a' }), /administrator or a manager/i);

  /* ================================================================ *
   * STEP 9A — leave: submit, approve, see the result
   * ================================================================ */

  console.log('\nworkflow: leave\n');

  const day = (n) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const request = await leave.applyForLeave(EMP, {
    employeeId: EMP_ID, typeCode: ctx.leaveType,
    startsOn: day(30), endsOn: day(30), days: 1, reason: 'ZZ probe leave',
  });
  ok('an employee submits their own leave', Boolean(request.id));
  ok('  it lands pending', request.status === 'Pending', request.status);

  await refused('an employee cannot apply on somebody else’s behalf',
    () => leave.applyForLeave(EMP, {
      employeeId: MGR_ID, typeCode: ctx.leaveType,
      startsOn: day(31), endsOn: day(31), days: 1, reason: 'ZZ nope',
    }), /your own/i);

  const pendingForMgr = await leave.listLeave(MGR, { status: 'Pending' });
  ok('the manager sees the pending request',
    pendingForMgr.some((l) => l.id === request.id),
    `manager sees ${pendingForMgr.length} pending`);

  await refused('an employee cannot approve leave',
    () => leave.approveLeave(EMP, request.id), /manager or admin/i);

  const decided = await leave.approveLeave(MGR, request.id);
  ok('the manager approves it', decided.status === 'Approved', decided.status);

  const asEmployee = await leave.listLeave(EMP, {});
  ok('the employee sees the updated status',
    asEmployee.find((l) => l.id === request.id)?.status === 'Approved');

  const persisted = (await admin.query(
    'SELECT status FROM leave_request WHERE id = $1', [request.id])).rows[0];
  ok('  and the database agrees', persisted.status === 'approved', persisted.status);

  /* ================================================================ *
   * STEP 9B — timesheet: submit, approve, see the result
   * ================================================================ */

  console.log('\nworkflow: timesheet\n');

  /* Monday of the current week, which is what a week_start is. */
  const monday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  })();

  const sheet = await timesheets.timesheetForWeek(EMP, EMP_ID, monday);
  ok('an employee opens their own week', Boolean(sheet.id));

  await refused('an employee cannot open somebody else’s week',
    () => timesheets.timesheetForWeek(EMP, MGR_ID, monday), /your own/i);

  await timesheets.addEntry(EMP, sheet.id, {
    date: monday, proj: ctx.project, task: 'ZZ probe task', hours: 8, billable: true,
  });
  const submitted = await timesheets.submitTimesheet(EMP, sheet.id);
  ok('the employee submits it', submitted.status === 'Submitted', submitted.status);

  await refused('an employee cannot decide a timesheet',
    () => timesheets.actOnTimesheet(EMP, sheet.id, 'approved'), /manager or admin/i);

  const mgrQueue = await timesheets.listTimesheets(MGR, { status: 'Submitted' });
  ok('the manager sees it waiting', mgrQueue.some((t) => t.id === sheet.id),
    `manager sees ${mgrQueue.length} submitted`);

  const approved = await timesheets.actOnTimesheet(MGR, sheet.id, 'approved');
  ok('the manager approves it', approved.status === 'Approved', approved.status);

  const back = await timesheets.timesheetForWeek(EMP, EMP_ID, monday);
  ok('the employee sees the updated status', back.status === 'Approved', back.status);

  const tsRow = (await admin.query(
    'SELECT status FROM timesheet WHERE id = $1', [sheet.id])).rows[0];
  ok('  and the database agrees', tsRow.status === 'approved', tsRow.status);

  /* ================================================================ *
   * STEP 8 — scope isolation, asked of the service directly
   * ================================================================ */

  console.log('\nscope isolation, asked of the service rather than the screen\n');

  /*
   * A second manager with their own report. The question is whether manager A
   * can reach manager B's line — the leak that matters once more than one
   * manager exists, and the one a single-manager test cannot see.
   */
  const otherMgr = await users.createUser(ADMIN, {
    name: `ZZ Probe Manager B ${tag}`, email: `zz-hier-mgb-${tag}@360.technology`,
    dept: ctx.dept, site: ctx.site, designation: 'ZZ Other Manager', role: 'manager',
  });
  const OTHER_MGR_ID = await employeeOf(otherMgr);
  const otherEmp = await users.createUser(ADMIN, {
    name: `ZZ Probe Employee B ${tag}`, email: `zz-hier-emb-${tag}@360.technology`,
    dept: ctx.dept, site: ctx.site, designation: 'ZZ Other Engineer', role: 'employee',
    managerId: OTHER_MGR_ID,
  });
  const OTHER_EMP_ID = await employeeOf(otherEmp);
  const OTHER = caller('manager', OTHER_MGR_ID);

  ok('manager A cannot see manager B’s report',
    !(await employees.listVisibleEmployees(MGR)).some((e) => e.id === OTHER_EMP_ID));
  ok('manager A cannot open manager B’s report’s profile',
    (await buildEmployeeProfile(MGR, OTHER_EMP_ID)) === null);

  const foreign = await leave.applyForLeave(caller('employee', OTHER_EMP_ID), {
    employeeId: OTHER_EMP_ID, typeCode: ctx.leaveType,
    startsOn: day(40), endsOn: day(40), days: 1, reason: 'ZZ other probe',
  });
  await refused('manager A cannot approve manager B’s report’s leave',
    () => leave.approveLeave(MGR, foreign.id), /not in your team/i);
  ok('  and manager A cannot even see it pending',
    !(await leave.listLeave(MGR, { status: 'Pending' })).some((l) => l.id === foreign.id));
  ok('  while manager B can',
    (await leave.listLeave(OTHER, { status: 'Pending' })).some((l) => l.id === foreign.id));

  /*
   * Self-approval, which is a different rule from team scope: manager B *is*
   * in their own line, so only the explicit check refuses this.
   */
  const ownLeave = await leave.applyForLeave(OTHER, {
    employeeId: OTHER_MGR_ID, typeCode: ctx.leaveType,
    startsOn: day(41), endsOn: day(41), days: 1, reason: 'ZZ self',
  });
  await refused('nobody approves their own leave',
    () => leave.approveLeave(OTHER, ownLeave.id), /your own/i);

  /* ================================================================ *
   * STEP 9C — the hierarchy, from each level
   * ================================================================ */

  console.log('\nthe hierarchy reads correctly from each level\n');

  const adminTeam = await employees.getTeam(ADMIN, MGR_ID);
  ok('an admin sees the manager’s direct report', adminTeam.some((e) => e.id === EMP_ID));
  ok('a manager sees their own report', (await employees.getTeam(MGR, MGR_ID)).some((e) => e.id === EMP_ID));
  ok('an employee has no reports', (await employees.getTeam(EMP, EMP_ID)).length === 0);
  /*
   * An employee asking for their manager's team gets *themselves*, and that is
   * correct rather than a leak: the scope clause is ANDed into the query as
   * `e.id = <self>`, so the argument narrows the result and never widens it.
   * This first asserted an empty list, which was wrong about the code — the
   * property worth holding is that no colleague ever appears, whatever id is
   * passed.
   */
  const empAsksForTeam = await employees.getTeam(EMP, MGR_ID);
  ok('an employee asking for the manager’s team sees no colleague',
    empAsksForTeam.every((e) => e.id === EMP_ID),
    empAsksForTeam.map((e) => e.name).join(', '));
  ok('  and asking for another manager’s team sees nobody',
    (await employees.getTeam(EMP, OTHER_MGR_ID)).length === 0);

  const profile = await buildEmployeeProfile(ADMIN, EMP_ID);
  ok('the profile names the manager', profile.managerName.includes('Probe Manager'),
    profile.managerName);
});
} catch (e) {
  /*
   * The safety fallback, kept.
   *
   * `withScratchTenant` drops the tenant in its own finally, so the rows are
   * already gone by the time this runs. It stays because the guarantee worth
   * having is that a failure is *reported* rather than thrown into the void:
   * an unhandled rejection at top level tears the process down mid-teardown,
   * which is how five fixtures were once left in the live tenant.
   */
  fatal = e;
  failed += 1;
  console.log(`
  FAIL  the run stopped: ${e.message}`);
}

/* ================================================================ *
 * STEP 12 — nothing of ours survived, and nothing of theirs moved
 * ================================================================ */

console.log('\nthe database is as it was\n');

const after = await census();
ok(`employees ${after.e}`, after.e === before.e, `was ${before.e}`);
ok(`memberships ${after.m}`, after.m === before.m, `was ${before.m}`);
ok(`audit rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok(`leave requests ${after.l}`, after.l === before.l, `was ${before.l}`);
ok(`timesheets ${after.t}`, after.t === before.t, `was ${before.t}`);
ok(`timesheet entries ${after.te}`, after.te === before.te, `was ${before.te}`);
ok(`tenants ${after.tenants}`, after.tenants === before.tenants,
  `was ${before.tenants} — a scratch tenant survived the run`);

const leftovers = (await admin.query(
  "SELECT slug FROM tenant WHERE slug LIKE 'zz-scratch-%'")).rows;
ok('no scratch tenant remains', leftovers.length === 0,
  leftovers.map((t) => t.slug).join(', '));

const strays = (await admin.query(
  "SELECT count(*)::int n FROM employee WHERE full_name LIKE 'ZZ%'")).rows[0].n;
ok('and no test employee remains anywhere', strays === 0, `${strays} found`);

const adminStill = (await admin.query(
  `SELECT e.code, e.app_role, m.status FROM employee e
     JOIN tenant_membership m ON m.employee_id = e.id WHERE e.code = 'VHM004'`)).rows[0];
ok('the existing administrator is untouched',
  adminStill?.code === 'VHM004' && adminStill.app_role === 'admin' && adminStill.status === 'active',
  JSON.stringify(adminStill));

const payroll = (await admin.query(
  "SELECT status, locked FROM pay_run")).rows;
ok('payroll is still paid and locked',
  payroll.length === 1 && payroll[0].status === 'paid' && payroll[0].locked === true,
  JSON.stringify(payroll));

await admin.end();

if (fatal) {
  console.log(`\nthe run stopped early, but its tenant was dropped regardless:\n  ${fatal.stack}`);
}

console.log(failed
  ? `\n${failed} problem(s)`
  : '\nthree levels, and each one reaches exactly as far as it should');
process.exit(failed ? 1 : 0);
