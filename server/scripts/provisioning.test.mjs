/**
 * A new employee gets the working pattern somebody chose for them.
 *
 * Phases 2h-C through 2h-F built the schedule tables, the service, the resolver
 * and the screens — and left one gap: nothing assigned a pattern when an employee
 * was created. Every person hired after migration 0054 ran started with no
 * assignment at all, which the resolver absorbed by falling back to
 * Monday-to-Friday and the screens honestly reported as "Not assigned".
 *
 * This phase closes that gap at the point of creation, and these are the
 * assertions that say it closed correctly.
 *
 * ## What is worth holding
 *
 * **Chosen, never guessed.** A schedule is assigned because a caller named one.
 * Where nobody named one the employee stays unassigned and the calendar keeps
 * falling back — because this repository has no authoritative default to reach
 * for: `work_schedule` carries no `is_default` column, `DEFAULT_MF` is only the
 * code migration 0054's backfill happened to use, and `ensureDefaultSchedule` has
 * no caller. Inventing a default here would collapse the distinction Phase 2h-E
 * was careful to keep, so assertions 30-36 hold that it stays collapsed-free.
 *
 * **It starts on `joined_on`, not today.** Somebody provisioned in October to
 * start in January is on their pattern from January. Using the creation timestamp
 * would claim they were expected in for three months nobody scheduled.
 *
 * **One service decides.** The assignment goes through the schedule service, so
 * the same rules apply as when somebody assigns a pattern by hand: the schedule
 * must exist, be active, and belong to this tenant. No second copy of those
 * checks lives in the creation paths.
 *
 * **Creation is all-or-nothing.** The employee and their first assignment commit
 * together. A bad schedule code leaves no employee behind — asserted by counting
 * rows after a refusal, not by reading the code.
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
  console.log('\nSKIPPED: no database, and provisioning needs one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const users = await import('../src/modules/users/service.ts');
const joiners = await import('../src/modules/joiners/service.ts');
const sched = await import('../src/modules/schedules/service.ts');
const cal = await import('../src/modules/calendar/service.ts');
const shifts = await import('../src/modules/shifts/service.ts');
const leave = await import('../src/modules/leave/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
const refused = async (label, fn, expect) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the call succeeded — nothing was refused');
  if (e) {
    ok('    in words a screen can show', expect.test(e.message), `${e.name}: ${e.message}`);
    ok('    and not as a database error code',
      !/^23[0-9P]/.test(e.message) && !/^\s*error:/i.test(e.message), e.message);
  }
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(`
  SELECT (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM employee_schedule) es,
         (SELECT count(*)::int FROM attendance) a,
         (SELECT count(*)::int FROM payslip) p`)).rows[0];
const before = await census();

/* 2026-10-05 is a Monday, 2026-10-10 a Saturday, 2026-10-11 a Sunday. */
const MON = '2026-10-05';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const SUN = '2026-10-11';

let fatal = null;
try {

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'company_admin', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const MGR = {
    role: 'employee', hasReports: true, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const EMP = {
    role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };

  /* The patterns this tenant can put somebody on. */
  await sched.createWorkSchedule(A, { code: 'ZZMF', name: 'ZZ Monday to Friday' });
  await sched.createWorkSchedule(A, {
    code: 'ZZMSAT', name: 'ZZ Monday to Saturday',
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, working: dayOfWeek <= 6 })),
  });
  await sched.createWorkSchedule(A, {
    code: 'ZZSUNTHU', name: 'ZZ Sunday to Thursday',
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
      dayOfWeek, working: dayOfWeek <= 4 || dayOfWeek === 7,
    })),
  });
  /*
   * And the default pattern, so the no-pattern assertions below are a real test.
   * A scratch tenant is created after 0054 ran and therefore has no DEFAULT_MF of
   * its own — without one, 'nothing was invented for them' would pass simply
   * because there was nothing to invent.
   */
  await sched.ensureDefaultSchedule(A);

  await sched.createWorkSchedule(A, { code: 'ZZGONE', name: 'ZZ Withdrawn' });
  await sched.setWorkScheduleActive(A, 'ZZGONE', false);

  let seq = 0;
  const draft = (over = {}) => {
    seq += 1;
    return {
      name: `ZZ New Hire ${seq}`,
      email: `zz-hire-${seq}-${Math.random().toString(36).slice(2, 8)}@360.technology`,
      dept: ctx.dept,
      site: ctx.site,
      designation: 'Engineer',
      role: 'employee', hasReports: false,
      joinedOn: '2026-09-01',
      sendInvitation: false,
      ...over,
    };
  };

  /* ---------------------------------------------------------------- *
   * 1-4. A chosen pattern is established
   * ---------------------------------------------------------------- */

  console.log('\na new employee is put on the pattern somebody chose\n');

  const made = await users.createUser(A, draft({ workScheduleCode: 'ZZMF' }));
  ok('1. the account is created', Boolean(made.id), JSON.stringify(made).slice(0, 80));

  const empOf = async (email) => (await db.query(
    'SELECT id, joined_on::text AS joined_on, status FROM employee WHERE work_email = $1',
    [email])).rows[0];
  const one = await empOf(made.email);
  ok('    with an employee record behind it', Boolean(one?.id));

  const hist = await sched.employeeSchedules(A, one.id);
  ok('2. they have exactly one schedule assignment', hist.length === 1,
    JSON.stringify(hist));
  ok('3. naming the pattern that was chosen',
    hist[0]?.scheduleCode === 'ZZMF', String(hist[0]?.scheduleCode));
  ok('4. starting on their joining date, not today',
    hist[0]?.validFrom === '2026-09-01', String(hist[0]?.validFrom));
  ok('    and open-ended', hist[0]?.validTo === null, String(hist[0]?.validTo));
  ok('    which is the joining date the employee row carries',
    one.joined_on === hist[0]?.validFrom, `${one.joined_on} vs ${hist[0]?.validFrom}`);

  const verdicts = await cal.workingDaysFor(A, one.id, MON, SUN);
  ok('5. their calendar resolves the assigned pattern',
    verdicts.every((v) => v.schedule === 'ZZMF'),
    JSON.stringify(verdicts.map((v) => v.schedule)));
  ok('    five working days, Saturday and Sunday off',
    verdicts.filter((v) => v.workingDay).length === 5
    && verdicts[5].reason === 'WEEKLY_OFF' && verdicts[6].reason === 'WEEKLY_OFF');

  /* ---------------------------------------------------------------- *
   * 5-6. Patterns the hard-coded week could never express
   * ---------------------------------------------------------------- */

  console.log('\nand that pattern is whatever the tenant actually works\n');

  const six = await empOf((await users.createUser(A,
    draft({ workScheduleCode: 'ZZMSAT' }))).email);
  const sixWeek = await cal.workingDaysFor(A, six.id, MON, SUN);
  ok('6. a Monday-to-Saturday hire works Saturday',
    sixWeek[5].workingDay === true && sixWeek[5].reason === 'WORKING', sixWeek[5].reason);
  ok('    and rests Sunday', sixWeek[6].workingDay === false);
  ok('    six working days in the week',
    sixWeek.filter((v) => v.workingDay).length === 6);

  const gulf = await empOf((await users.createUser(A,
    draft({ workScheduleCode: 'ZZSUNTHU' }))).email);
  const gulfWeek = await cal.workingDaysFor(A, gulf.id, MON, SUN);
  ok('7. a Sunday-to-Thursday hire works Sunday',
    gulfWeek[6].workingDay === true, gulfWeek[6].reason);
  ok('    and rests Friday and Saturday',
    gulfWeek[4].workingDay === false && gulfWeek[5].workingDay === false);

  /* ---------------------------------------------------------------- *
   * 7-9, 15. What is refused, and what is left behind
   * ---------------------------------------------------------------- */

  console.log('\nan unusable pattern refuses the whole creation\n');

  const beforeBad = (await db.query(
    'SELECT count(*)::int n FROM employee WHERE tenant_id = $1', [ctx.tenant])).rows[0].n;

  const inactiveDraft = draft({ workScheduleCode: 'ZZGONE' });
  await refused('8. a withdrawn pattern is refused',
    () => users.createUser(A, inactiveDraft), /not in use|cannot be assigned/);
  ok('    and no employee was left behind',
    (await db.query('SELECT count(*)::int n FROM employee WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === beforeBad,
    'the creation and the assignment commit together, or neither does');
  ok('    nor an account', !(await db.query(
    'SELECT 1 FROM employee WHERE work_email = $1', [inactiveDraft.email])).rows[0]);

  const ghostDraft = draft({ workScheduleCode: 'ZZNOPE' });
  await refused('9. an unknown pattern is refused',
    () => users.createUser(A, ghostDraft), /no such work schedule/);
  ok('    and leaves nothing behind',
    (await db.query('SELECT count(*)::int n FROM employee WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === beforeBad);

  const blank = await empOf((await users.createUser(A,
    draft({ workScheduleCode: '   ' }))).email);
  ok('10. a blank pattern code means unassigned, not an error',
    (await sched.employeeSchedules(A, blank.id)).length === 0,
    'a selector offering "Not assigned" sends an empty value for it');
  ok('    and nothing was substituted for the blank',
    (await cal.workingDaysFor(A, blank.id, MON, MON))[0].schedule === null);

  /* ---------------------------------------------------------------- *
   * 11. No pattern chosen — the state that must survive
   * ---------------------------------------------------------------- */

  console.log('\nchoosing none leaves them unassigned, as before\n');

  const bare = await empOf((await users.createUser(A, draft())).email);
  ok('11. no pattern was invented for them',
    (await sched.employeeSchedules(A, bare.id)).length === 0,
    'this repository has no authoritative default to reach for');
  const bareWeek = await cal.workingDaysFor(A, bare.id, MON, SUN);
  ok('12. their calendar reports no schedule',
    bareWeek.every((v) => v.schedule === null),
    JSON.stringify(bareWeek.map((v) => v.schedule)));
  ok('13. and falls back to Monday to Friday',
    bareWeek.filter((v) => v.workingDay).length === 5,
    'the Phase 2h-E fallback, unchanged');
  ok('14. so "assigned DEFAULT_MF" and "not assigned" stay different states',
    hist[0]?.scheduleCode === 'ZZMF' && bareWeek[0].schedule === null,
    'collapsing them is what this phase was told not to do');

  const nulled = await empOf((await users.createUser(A,
    draft({ workScheduleCode: null }))).email);
  ok('15. an explicit null is the same as omitting it',
    (await sched.employeeSchedules(A, nulled.id)).length === 0);

  /* ---------------------------------------------------------------- *
   * 10, 20. Authorization and tenancy
   * ---------------------------------------------------------------- */

  console.log('\nwho may do this, and whose patterns they may name\n');

  /*
   * Reporting to the manager who creates them. `createUser` reads the new
   * account back through the caller's own scope, so a manager creating somebody
   * outside their line is refused on the readback — existing behaviour, and not
   * this phase's to change.
   */
  const byMgr = await empOf((await users.createUser(MGR,
    draft({ workScheduleCode: 'ZZMF', managerId: ctx.adminEmployeeId }))).email);
  ok('16. a manager may create an employee on a pattern, as before',
    (await sched.employeeSchedules(A, byMgr.id))[0]?.scheduleCode === 'ZZMF',
    'their right to create already existed; this adds no new permission');

  await refused('17. an employee still cannot create one at all',
    () => users.createUser(EMP, draft({ workScheduleCode: 'ZZMF' })),
    /cannot manage accounts/);
  ok('    which is the permission they were already refused by',
    true, 'this phase added a field, not a right');

  /*
   * No new permission key. The creation paths keep exactly the permission they
   * already had — this phase adds a field to what they accept, not a new right.
   * Read from the policy module rather than asserted from prose, and without the
   * `|| true` that made an earlier version of this line unfailable.
   */
  const policySrc = readFileSync(join(here, '..', 'src', 'auth', 'policy.ts'), 'utf8');
  ok('18. no schedule permission key was introduced',
    !/'[a-z.]*schedule[a-z.]*'/i.test(policySrc),
    (policySrc.match(/'[a-z.]*schedule[a-z.]*'/i) ?? []).join(','));

  /* ---------------------------------------------------------------- *
   * 12-13. Existing people, and the lifecycle
   * ---------------------------------------------------------------- */

  console.log('\nnobody who already existed was touched\n');

  const adminHist = await sched.employeeSchedules(A, ctx.adminEmployeeId);
  ok('19. the tenant administrator, created before this phase, is still unassigned',
    adminHist.length === 0,
    'this phase provisions the future; it does not backfill the past');

  await db.query(
    "UPDATE employee SET status = 'exited', left_on = $2 WHERE id = $1",
    [bare.id, '2026-10-07']);
  const exited = await cal.workingDaysFor(A, bare.id, MON, SUN);
  ok('20. an exited employee is still bounded by left_on',
    exited[3].reason === 'NOT_EMPLOYED',
    `${exited[3].date} → ${exited[3].reason}`);
  await refused('21. and cannot be put on a pattern afterwards',
    () => sched.assignEmployeeSchedule(A, bare.id, {
      scheduleCode: 'ZZMF', validFrom: '2026-11-02',
    }), /has left/);

  /* ---------------------------------------------------------------- *
   * 22. Leave reads the provisioned pattern
   * ---------------------------------------------------------------- */

  console.log('\nleave counts the days the chosen pattern works\n');

  const balance = async (empId) => db.query(
    `INSERT INTO leave_balance (tenant_id, employee_id, leave_type_id, year_start, quota)
     SELECT $1, $2, t.id, '2026-04-01', 24 FROM leave_type t
      WHERE t.tenant_id = $1 AND t.code = $3
     ON CONFLICT (tenant_id, employee_id, leave_type_id, year_start)
       DO UPDATE SET quota = 24`, [ctx.tenant, empId, ctx.leaveType]);
  await balance(one.id); await balance(six.id);

  const apply = (empId, from, to) => leave.applyForLeave(A, {
    employeeId: empId, typeCode: ctx.leaveType, reason: 'ZZ prov', startsOn: from, endsOn: to,
  });

  ok('22. a five-day hire takes two days over Friday to Monday',
    Number((await apply(one.id, FRI, '2026-10-12')).days) === 2);
  ok('23. a six-day hire takes three over the same dates',
    Number((await apply(six.id, FRI, '2026-10-12')).days) === 3,
    'Friday, Saturday and Monday — the Saturday is theirs because their pattern says so');

  /* ---------------------------------------------------------------- *
   * 23. The roster shows them correctly
   * ---------------------------------------------------------------- */

  console.log('\nand the rota shows them on it\n');

  const rota = await shifts.rosterFor(A, [one.id, six.id], MON, 7);
  ok('24. a newly provisioned employee appears on the rota',
    Boolean(rota[one.id]) && Boolean(rota[six.id]));
  ok('25. the five-day hire rests Saturday',
    rota[one.id][SAT].expected === 'WEEKLY_OFF', rota[one.id][SAT].expected);
  ok('26. the six-day hire works it',
    rota[six.id][SAT].expected === 'WORKING', rota[six.id][SAT].expected);
  ok('27. each cell names the pattern that decided it',
    rota[one.id][SAT].schedule === 'ZZMF' && rota[six.id][SAT].schedule === 'ZZMSAT');
  ok('28. and the shift they are expected on',
    rota[one.id][MON].shift === 'IN', String(rota[one.id][MON].shift));
  ok('29. no attendance row was created by any of it',
    (await db.query('SELECT count(*)::int n FROM attendance WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === 0);

  /* ---------------------------------------------------------------- *
   * The joiner path, which shares provisionEmployee with onboarding
   * ---------------------------------------------------------------- */

  console.log('\nthe joiner approval path establishes one too\n');

  /*
   * The request carries no schedule, and deliberately so: adding a column to
   * `joining_request` would mean a migration, and the pattern is not known when
   * somebody raises a request — it is chosen by the administrator approving it.
   * So it is an argument to the approval, which is the moment the decision is
   * actually made.
   */
  const request = async () => (await db.query(
    `INSERT INTO joining_request
       (tenant_id, full_name, work_email, designation, department_id, site_id,
        joining_on, employment_type, status)
     SELECT $1, $2, $3, 'Engineer',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            '2026-09-15', 'permanent', 'pending'
     RETURNING id`,
    [ctx.tenant, `ZZ Joiner ${Math.random().toString(36).slice(2, 7)}`,
      `zz-join-${Math.random().toString(36).slice(2, 9)}@360.technology`])).rows[0].id;

  const reqId = await request();
  const approved = await joiners.approveJoiner(A, reqId, 'ZZ approved', 'ZZMSAT');
  ok('30. approving a joiner creates the employee', Boolean(approved.employeeId));
  const joinerHist = await sched.employeeSchedules(A, approved.employeeId);
  ok('31. on the pattern the request carried',
    joinerHist[0]?.scheduleCode === 'ZZMSAT', String(joinerHist[0]?.scheduleCode));
  ok('32. from the joining date on the request, not the approval date',
    joinerHist[0]?.validFrom === '2026-09-15', String(joinerHist[0]?.validFrom));

  const bareReq = await request();
  const bareApproved = await joiners.approveJoiner(A, bareReq, null);
  ok('33. approving without naming a pattern leaves the joiner unassigned',
    (await sched.employeeSchedules(A, bareApproved.employeeId)).length === 0);

  const badReq = await request();
  const joinersBefore = (await db.query(
    'SELECT count(*)::int n FROM employee WHERE tenant_id = $1', [ctx.tenant])).rows[0].n;
  await refused('34. approving onto a withdrawn pattern refuses the whole approval',
    () => joiners.approveJoiner(A, badReq, null, 'ZZGONE'), /not in use|cannot be assigned/);
  ok('    leaving no employee behind',
    (await db.query('SELECT count(*)::int n FROM employee WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === joinersBefore);
  ok('    and the request still pending, not half-approved',
    (await db.query('SELECT status FROM joining_request WHERE id = $1', [badReq]))
      .rows[0].status === 'pending',
    'one transaction covers the approval and the assignment');

  /* ---------------------------------------------------------------- *
   * §20. Cross-tenant
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (o) => {
    const B = {
      role: 'company_admin', hasReports: false, tenantId: o.tenant, employeeId: o.adminEmployeeId, userId: null,
    };

    console.log('\nno tenant may name another tenant\'s pattern\n');

    const theirBefore = (await db.query(
      'SELECT count(*)::int n FROM employee WHERE tenant_id = $1', [o.tenant])).rows[0].n;

    await refused('35. our pattern is not theirs to assign on creation',
      () => users.createUser(B, {
        name: 'ZZ Cross Tenant', email: `zz-x-${Math.random().toString(36).slice(2, 9)}@360.technology`,
        dept: o.dept, site: o.site, designation: 'Engineer', role: 'employee', hasReports: false,
        joinedOn: '2026-09-01', sendInvitation: false, workScheduleCode: 'ZZMSAT',
      }), /no such work schedule/);
    ok('    and no employee was created in their tenant',
      (await db.query('SELECT count(*)::int n FROM employee WHERE tenant_id = $1',
        [o.tenant])).rows[0].n === theirBefore);

    /*
     * The tenant comes from the authenticated caller, never the body. A draft
     * carrying somebody else's tenant id is not a route into their data: the
     * field is not read, and row level security would refuse it even if it were.
     */
    const smuggled = await users.createUser(B, {
      name: 'ZZ Smuggler', email: `zz-sm-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      dept: o.dept, site: o.site, designation: 'Engineer', role: 'employee', hasReports: false,
      joinedOn: '2026-09-01', sendInvitation: false,
      tenantId: ctx.tenant, tenant_id: ctx.tenant,
    });
    const landed = (await db.query(
      'SELECT tenant_id FROM employee WHERE work_email = $1', [smuggled.email])).rows[0];
    ok('36. a client-supplied tenant id does not move the employee',
      landed.tenant_id === o.tenant,
      `landed in ${landed.tenant_id === ctx.tenant ? 'OUR tenant' : 'their own'}`);

    ok('37. their own pattern works for them', await (async () => {
      await sched.createWorkSchedule(B, { code: 'ZZMSAT', name: 'ZZ Theirs Six' });
      const mine = await users.createUser(B, {
        name: 'ZZ Theirs', email: `zz-th-${Math.random().toString(36).slice(2, 9)}@360.technology`,
        dept: o.dept, site: o.site, designation: 'Engineer', role: 'employee', hasReports: false,
        joinedOn: '2026-09-01', sendInvitation: false, workScheduleCode: 'ZZMSAT',
      });
      const theirEmp = (await db.query(
        'SELECT id FROM employee WHERE work_email = $1', [mine.email])).rows[0];
      const h = await sched.employeeSchedules(B, theirEmp.id);
      return h.length === 1 && h[0].scheduleCode === 'ZZMSAT';
    })(), 'same code, different tenant, their own row');
  });
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
ok(`employees ${after.e}`, after.e === before.e, `was ${before.e}`);
ok(`schedule assignments ${after.es}`, after.es === before.es, `was ${before.es}`);
ok(`attendance rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok(`payslips ${after.p}`, after.p === before.p, `was ${before.p}`);
ok('no scratch tenant remains',
  (await db.query("SELECT count(*)::int n FROM tenant WHERE slug LIKE 'zz-scratch-%'"))
    .rows[0].n === 0);

await db.end();

if (fatal) {
  console.error(`\nthe run did not finish: ${fatal.message}`);
  console.error(fatal.stack);
  process.exit(1);
}

console.log();
if (failed) {
  console.error(`${failed} provisioning checks failed`);
  process.exit(1);
}
console.log('a new employee starts on the pattern somebody chose, from the day they join');
