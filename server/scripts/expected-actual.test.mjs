/**
 * Expected and actual, proven against a real database.
 *
 * Phase 2h-H's one sentence: **a scheduled working day with no attendance row is
 * not an absence.** `A` is a status something writes on purpose; a missing row is
 * missing information. These assertions hold that the two reads stay two reads,
 * and — more importantly — that nothing in the display path writes.
 *
 * ## Why this suite exists when the phase added no server code
 *
 * It did not need to. `classifyMany` has answered the expected side since 2h-E and
 * `listAttendance` has answered the actual side since 0004, both as scoped bulk
 * range reads. The phase composed them in the browser, so what needs proving on
 * the server is that the two answers are independent, that reading them changes
 * nothing, and that neither one starts inventing the other.
 *
 * So most of this is a characterisation suite rather than a red-before-green one,
 * and the ratchets that matter are the write-safety counts near the end: they fail
 * the day somebody decides a missing record should become an `A`.
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
  console.log('\nSKIPPED: no database, and attendance needs one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const cal = await import('../src/modules/calendar/service.ts');
const sched = await import('../src/modules/schedules/service.ts');
const shifts = await import('../src/modules/shifts/service.ts');
const att = await import('../src/modules/attendance/service.ts');
const tenancy = await import('../src/tenancy/context.ts');
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
  if (e) ok('    in words a screen can show', expect.test(e.message), `${e.name}: ${e.message}`);
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(`
  SELECT (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM attendance) a,
         (SELECT count(*)::int FROM payslip) p,
         (SELECT count(*)::int FROM employee_schedule) es`)).rows[0];
const before = await census();

/* 2026-10-05 Monday … 2026-10-11 Sunday. Proven below, not assumed. */
const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';
const THU = '2026-10-08';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const SUN = '2026-10-11';

const byDate = (list) => new Map(list.map((x) => [x.date, x]));

let fatal = null;
try {

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'company_admin', hasReports: false, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };

  const person = async (name, joinedOn = '2020-01-01', over = {}) => {
    const { rows } = await db.query(
      `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                             department_id, site_id, legal_entity_id, shift_id,
                             manager_id, joined_on, left_on)
       SELECT $1, $2, $3, $4, $5, 'employee',
              (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'),
              $6, $7::date, $8::date
       RETURNING id`,
      [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name,
        `zz-ea-${Math.random().toString(36).slice(2, 10)}@360.technology`,
        over.status ?? 'active', over.managerId ?? ctx.adminEmployeeId,
        joinedOn, over.leftOn ?? null]);
    return rows[0].id;
  };

  /** A real attendance row, written deliberately — which is the only way one appears. */
  const record = async (empId, date, status, over = {}) => db.query(
    `INSERT INTO attendance (tenant_id, employee_id, work_date, status, punch_in, punch_out,
                             worked_minutes, late, shift_id, source)
     SELECT $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, $8,
            (SELECT shift_id FROM employee WHERE id = $2), 'web'`,
    [ctx.tenant, empId, date, status,
      over.in ?? null, over.out ?? null, over.mins ?? 0, over.late ?? false]);

  console.log('\nthe dates are the weekdays this suite assumes\n');

  ok('1. Monday through Sunday, verified in SQL', await (async () => {
    const { rows } = await db.query(
      `SELECT string_agg(EXTRACT(ISODOW FROM d)::text, ',' ORDER BY d) AS dows
         FROM generate_series($1::date, $2::date, interval '1 day') d`, [MON, SUN]);
    return rows[0].dows === '1,2,3,4,5,6,7';
  })());

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

  /* ---------------------------------------------------------------- *
   * §24 1-6. The six combinations
   * ---------------------------------------------------------------- */

  console.log('\nexpected and actual are two independent answers\n');

  const five = await person('ZZ Five Day');
  await sched.assignEmployeeSchedule(A, five, { scheduleCode: 'ZZMF', validFrom: '2020-01-01' });

  /* Monday present, Tuesday late, Wednesday absent. Nothing else recorded. */
  await record(five, MON, 'P', { in: `${MON}T09:02:00+05:30`, out: `${MON}T18:04:00+05:30`, mins: 480 });
  await record(five, TUE, 'P', { in: `${TUE}T10:20:00+05:30`, out: `${TUE}T19:00:00+05:30`, mins: 460, late: true });
  await record(five, WED, 'A');

  const expected = byDate(await cal.workingDaysFor(A, five, MON, SUN));
  const actual = byDate(await att.listAttendance(A, { empIds: [five], from: MON, to: SUN }));

  ok('2. working day with a record → Working / Present',
    expected.get(MON).reason === 'WORKING' && actual.get(MON).status === 'P',
    `${expected.get(MON).reason} / ${actual.get(MON)?.status}`);
  ok('3. working day with a late record → Working / Present, late',
    expected.get(TUE).reason === 'WORKING' && actual.get(TUE).late === true,
    'late is a property of the record, not a seventh status');
  ok('4. working day with an absent record → Working / Absent',
    expected.get(WED).reason === 'WORKING' && actual.get(WED).status === 'A',
    'an A on screen traces to an A in the table');

  ok('5. working day with NO record → Working / nothing at all',
    expected.get(THU).reason === 'WORKING' && actual.get(THU) === undefined,
    `${expected.get(THU).reason} / ${JSON.stringify(actual.get(THU))}`);
  ok('    and the resolver did not invent an absence for it',
    expected.get(THU).workingDay === true && !('status' in expected.get(THU)),
    'the expected side carries no attendance status, by construction');
  ok('    nor did the attendance read invent a row',
    (await db.query(
      'SELECT count(*)::int n FROM attendance WHERE employee_id = $1 AND work_date = $2',
      [five, THU])).rows[0].n === 0,
    'the single most important assertion in this phase');

  ok('6. weekly off with no record → Weekly off / nothing',
    expected.get(SAT).reason === 'WEEKLY_OFF' && actual.get(SAT) === undefined);
  ok('    and no O row was written for it',
    (await db.query(
      "SELECT count(*)::int n FROM attendance WHERE employee_id = $1 AND status = 'O'",
      [five])).rows[0].n === 0,
    'a week off is an expectation; O is a record somebody wrote');

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional)
     VALUES ($1, $2, 'ZZ Diwali', false)`, [ctx.tenant, FRI]);
  const withHol = byDate(await cal.workingDaysFor(A, five, MON, SUN));
  ok('7. holiday with no record → Holiday (named) / nothing',
    withHol.get(FRI).reason === 'HOLIDAY' && withHol.get(FRI).holiday === 'ZZ Diwali'
    && actual.get(FRI) === undefined);
  ok('    and no H row was written',
    (await db.query(
      "SELECT count(*)::int n FROM attendance WHERE employee_id = $1 AND status = 'H'",
      [five])).rows[0].n === 0);

  const joiner = await person('ZZ Joined Wednesday', WED);
  await sched.assignEmployeeSchedule(A, joiner, { scheduleCode: 'ZZMF', validFrom: WED });
  const jw = byDate(await cal.workingDaysFor(A, joiner, MON, SUN));
  ok('8. before joining → Not employed / nothing',
    jw.get(MON).reason === 'NOT_EMPLOYED'
    && (await att.listAttendance(A, { empIds: [joiner], from: MON, to: MON })).length === 0);
  ok('    and that is not an absence either', jw.get(MON).workingDay === false);

  /* ---------------------------------------------------------------- *
   * §24 7-9. The schedule decides what "expected" means
   * ---------------------------------------------------------------- */

  console.log('\nwhat is expected follows the pattern, not the calendar\n');

  const six = await person('ZZ Six Day');
  await sched.assignEmployeeSchedule(A, six, { scheduleCode: 'ZZMSAT', validFrom: '2020-01-01' });
  const sixWeek = byDate(await cal.workingDaysFor(A, six, MON, SUN));
  ok('9. a Monday-to-Saturday hire expects Saturday',
    sixWeek.get(SAT).reason === 'WORKING', sixWeek.get(SAT).reason);
  ok('    while the five-day hire does not, on the same date',
    expected.get(SAT).reason === 'WEEKLY_OFF',
    'one date, two expectations — and neither produces a record');

  const gulf = await person('ZZ Gulf Week');
  await sched.assignEmployeeSchedule(A, gulf, { scheduleCode: 'ZZSUNTHU', validFrom: '2020-01-01' });
  const gulfWeek = byDate(await cal.workingDaysFor(A, gulf, MON, SUN));
  ok('10. a Sunday-to-Thursday hire expects Sunday',
    gulfWeek.get(SUN).reason === 'WORKING', gulfWeek.get(SUN).reason);
  ok('    and rests Friday and Saturday',
    gulfWeek.get(FRI).workingDay === false && gulfWeek.get(SAT).workingDay === false,
    'Friday is a holiday for the five-day hire and a week off for this one');

  await db.query(
    `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone)
     VALUES ($1, 'ZZNIGHT', 'ZZ Night', '21:00', '23:30', 'Asia/Kolkata')`, [ctx.tenant]);
  await sched.setWorkScheduleDay(A, 'ZZMSAT', { dayOfWeek: 3, working: true, shiftCode: 'ZZNIGHT' });
  const shifted = byDate(await cal.workingDaysFor(A, six, MON, SUN));
  ok('11. the expected shift is the schedule day\'s where it names one',
    shifted.get(WED).shift === 'ZZNIGHT', String(shifted.get(WED).shift));
  ok('    and the employee\'s own on every other day',
    shifted.get(MON).shift === 'IN', String(shifted.get(MON).shift));
  ok('12. a day nobody is expected in names no shift',
    shifted.get(SUN).shift === null, String(shifted.get(SUN).shift));
  ok('13. and the employee\'s own shift_id was not rewritten',
    (await db.query('SELECT s.code FROM employee e JOIN shift s ON s.id = e.shift_id '
      + 'WHERE e.id = $1', [six])).rows[0].code === 'IN');

  /* ---------------------------------------------------------------- *
   * §25. Reading changes nothing
   * ---------------------------------------------------------------- */

  console.log('\nevery read leaves the table exactly as it was\n');

  const rows = async () => (await db.query(
    'SELECT count(*)::int n FROM attendance WHERE tenant_id = $1', [ctx.tenant])).rows[0].n;
  const digest = async () => (await db.query(
    `SELECT COALESCE(md5(string_agg(
       id::text || status || COALESCE(worked_minutes::text, '') || late::text,
       '|' ORDER BY id)), 'none') AS d
       FROM attendance WHERE tenant_id = $1`, [ctx.tenant])).rows[0].d;

  const n0 = await rows();
  const d0 = await digest();
  ok('14. there are attendance rows to protect', n0 === 3, String(n0));

  const everyone = [five, six, gulf, joiner];
  await cal.workingDaysFor(A, five, MON, SUN);
  await shifts.rosterFor(A, everyone, MON, 7);
  await att.listAttendance(A, { empIds: everyone, from: MON, to: SUN });
  await sched.employeeSchedules(A, five);

  ok('15. the calendar read inserted nothing', await rows() === n0, `${n0} → ${await rows()}`);
  ok('16. the roster read inserted nothing', await rows() === n0);
  ok('17. the attendance read inserted nothing', await rows() === n0);
  ok('18. and nothing existing was updated or deleted',
    await digest() === d0,
    'status, minutes and late flag are all unchanged on every row');

  /*
   * Stronger than the counts above, and found by trying to break them: the read
   * paths run inside `withTenantReadOnly`, which issues `SET TRANSACTION READ
   * ONLY`. Teaching the roster to fill in a week-off row does not produce a wrong
   * answer — PostgreSQL refuses the statement outright. The guarantee is the
   * database's, not a convention somebody has to remember.
   */
  const writeFromRead = await attempt(() => tenancy.withTenantReadOnly(A, async (rdb) => {
    await rdb.query(
      `INSERT INTO attendance (employee_id, work_date, status)
       VALUES ($1, $2::date, 'A')`, [five, THU]);
  }));
  ok('18a. a read-path transaction cannot write attendance at all',
    writeFromRead !== null && /read-only transaction/.test(writeFromRead.message),
    String(writeFromRead?.message));
  ok('    which is how the calendar and the rota are read',
    /SET TRANSACTION READ ONLY/.test(
      readFileSync(join(here, '..', 'src', 'tenancy', 'context.ts'), 'utf8'))
    && /withTenantReadOnly/.test(
      readFileSync(join(here, '..', 'src', 'modules', 'shifts', 'service.ts'), 'utf8'))
    && /withTenantReadOnly/.test(
      readFileSync(join(here, '..', 'src', 'modules', 'calendar', 'service.ts'), 'utf8')));
  ok('    and the attempt left nothing behind', await rows() === n0);

  ok('19. no row was created for the working day that has none',
    (await db.query(
      'SELECT count(*)::int n FROM attendance WHERE employee_id = $1 AND work_date = $2',
      [five, THU])).rows[0].n === 0,
    'after four separate reads of that exact date');
  ok('20. and nobody was given an absence',
    (await db.query(
      "SELECT count(*)::int n FROM attendance WHERE tenant_id = $1 AND status = 'A'",
      [ctx.tenant])).rows[0].n === 1,
    'the one that was written deliberately, and no more');

  /* ---------------------------------------------------------------- *
   * The roster carries both, in one query
   * ---------------------------------------------------------------- */

  console.log('\nthe rota answers for the whole team at once\n');

  const rota = await shifts.rosterFor(A, everyone, MON, 7);
  ok('21. every employee and every date comes back',
    Object.keys(rota).length === 4 && Object.keys(rota[five]).length === 7);
  ok('22. the rota carries the expectation, not a status',
    rota[five][THU].expected === 'WORKING' && !('status' in rota[five][THU]),
    JSON.stringify(rota[five][THU]));
  ok('23. and the six-day hire works the Saturday the five-day one does not',
    rota[six][SAT].expected === 'WORKING' && rota[five][SAT].expected === 'WEEKLY_OFF');

  let calls = 0;
  const counting = { query: (sql, params) => { calls += 1; return db.query(sql, params); } };
  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', ctx.tenant]);
  await cal.classifyMany(counting, everyone, MON, SUN);
  ok('24. four employees across a week cost one statement', calls === 1, `${calls} queries`);
  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', '']);

  ok('25. and the attendance side is one range read, not one per person',
    (await att.listAttendance(A, { empIds: everyone, from: MON, to: SUN })).length === 3,
    'all three rows, for four people, in a single call');

  /* ---------------------------------------------------------------- *
   * §24 13-14. Scope is unchanged
   * ---------------------------------------------------------------- */

  console.log('\nnobody can see or change more than before\n');

  const outsider = await person('ZZ Outside The Line', '2020-01-01', { managerId: null });
  const MGR = {
    role: 'employee', hasReports: true, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const asFive = { role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: five, userId: null };

  ok('26. a manager sees attendance for their own line',
    (await att.listAttendance(MGR, { empIds: [five], from: MON, to: SUN })).length === 3);
  ok('27. and none for somebody outside it',
    (await att.listAttendance(MGR, { empIds: [outsider], from: MON, to: SUN })).length === 0,
    'the scope listAttendance already applied, unchanged');
  ok('28. an employee sees only their own',
    (await att.listAttendance(asFive, { empIds: [five, six], from: MON, to: SUN }))
      .every((r) => r.empId === five),
    'empIds narrows what they can see; it never widens it');
  await refused('29. and cannot read somebody else\'s calendar',
    () => cal.workingDaysFor(asFive, six, MON, SUN), /only read your own/);
  await refused('30. nor assign themselves a schedule',
    () => sched.assignEmployeeSchedule(asFive, five, {
      scheduleCode: 'ZZMSAT', validFrom: '2027-01-01',
    }), /only a manager or admin/);
  ok('31. this phase added no attendance write method',
    typeof att.punchIn === 'function' && typeof att.punchOut === 'function'
    && !('markAbsent' in att) && !('generateAttendance' in att)
    && !('materialiseExpected' in att),
    Object.keys(att).filter((k) => /absent|generate|materialise/i.test(k)).join(','));

  /* ---------------------------------------------------------------- *
   * §24 15. Cross-tenant
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (o) => {
    const B = {
      role: 'company_admin', hasReports: false, tenantId: o.tenant, employeeId: o.adminEmployeeId, userId: null,
    };

    console.log('\nand nothing reaches across a tenant\n');

    ok('32. another tenant reads none of our attendance',
      (await att.listAttendance(B, { empIds: everyone, from: MON, to: SUN })).length === 0,
      'row level security, not a filter we remembered to write');
    await refused('33. nor our employee\'s calendar',
      () => cal.workingDaysFor(B, five, MON, SUN), /no such employee/);
    ok('34. nor our rota',
      Object.keys(await shifts.rosterFor(B, everyone, MON, 7)).length === 0);
    ok('35. and our rows are untouched by their reads',
      await digest() === d0);
  });

  ok('36. no payslip was produced by any of this',
    (await db.query('SELECT count(*)::int n FROM payslip WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === 0);
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
ok(`attendance rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok(`payslips ${after.p}`, after.p === before.p, `was ${before.p}`);
ok(`schedule assignments ${after.es}`, after.es === before.es, `was ${before.es}`);
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
  console.error(`${failed} expected-vs-actual checks failed`);
  process.exit(1);
}
console.log('what was expected and what happened are two answers, and reading them writes nothing');
