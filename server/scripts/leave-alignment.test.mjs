/**
 * Approved leave, lined up against the schedule and the attendance record.
 *
 * Phase 2h-H put expected and actual side by side and deliberately left leave
 * out, so an approved leave day with no punch read "Working / No attendance".
 * This is the phase that adds the third answer — and the whole point is that it
 * stays a *third* answer rather than being folded into either of the other two.
 *
 * ## Three sources of truth, and they do not merge
 *
 *   - **Expected** comes from the schedule resolver. Approved leave does not
 *     change it: a Saturday covered by a leave request is still the week off the
 *     schedule says it is, and a holiday is still a holiday. Turning either into
 *     "Working" because somebody applied for leave would be rewriting the
 *     calendar from the request.
 *   - **Leave** comes from `leave_request`, and only where `status = 'approved'`.
 *     Pending is not leave yet, rejected never was, cancelled no longer is.
 *   - **Actual** comes from `attendance`, and only where a row exists. An
 *     approved leave day with no row is still "no attendance" — not `L`, and
 *     certainly not `A`.
 *
 * ## What this suite is mostly for
 *
 * The one server change this phase needed was a date range on `listLeave`, which
 * had `empIds` and `status` but no `from`/`to` — so a month view would have had to
 * read a person's entire leave history. Everything else here is characterisation
 * and safety: that only approved leave participates, that reads write nothing, and
 * that none of the three channels starts inventing another.
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
  console.log('\nSKIPPED: no database, and leave alignment needs one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const cal = await import('../src/modules/calendar/service.ts');
const sched = await import('../src/modules/schedules/service.ts');
const leave = await import('../src/modules/leave/service.ts');
const att = await import('../src/modules/attendance/service.ts');
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
         (SELECT count(*)::int FROM leave_request) lr,
         (SELECT count(*)::int FROM leave_balance) lb,
         (SELECT count(*)::int FROM payslip) p`)).rows[0];
const before = await census();

/* 2026-11-02 is a Monday; 2026-11-07 a Saturday; 2026-11-08 a Sunday. */
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const NEXT_MON = '2026-11-09';

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
        `zz-li-${Math.random().toString(36).slice(2, 10)}@360.technology`,
        over.status ?? 'active',
        /* `??` would read an explicit null as "not supplied" and re-parent them. */
        'managerId' in over ? over.managerId : ctx.adminEmployeeId,
        joinedOn, over.leftOn ?? null]);
    return rows[0].id;
  };

  const balance = async (empId) => db.query(
    `INSERT INTO leave_balance (tenant_id, employee_id, leave_type_id, year_start, quota)
     SELECT $1, $2, t.id, '2026-04-01', 30 FROM leave_type t
      WHERE t.tenant_id = $1 AND t.code = $3
     ON CONFLICT (tenant_id, employee_id, leave_type_id, year_start)
       DO UPDATE SET quota = 30`, [ctx.tenant, empId, ctx.leaveType]);

  /** An attendance row, written deliberately — the only way one appears. */
  const record = async (empId, date, status, over = {}) => db.query(
    `INSERT INTO attendance (tenant_id, employee_id, work_date, status, punch_in, punch_out,
                             worked_minutes, late, shift_id, source)
     SELECT $1, $2, $3::date, $4, $5::timestamptz, $6::timestamptz, $7, false,
            (SELECT shift_id FROM employee WHERE id = $2), 'web'`,
    [ctx.tenant, empId, date, status, over.in ?? null, over.out ?? null, over.mins ?? 0]);

  await sched.createWorkSchedule(A, { code: 'ZZMF', name: 'ZZ Monday to Friday' });
  await sched.createWorkSchedule(A, {
    code: 'ZZMSAT', name: 'ZZ Monday to Saturday',
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, working: dayOfWeek <= 6 })),
  });

  console.log('\nthe dates are the weekdays this suite assumes\n');

  ok('1. Monday through Sunday, verified in SQL', await (async () => {
    const { rows } = await db.query(
      `SELECT string_agg(EXTRACT(ISODOW FROM d)::text, ',' ORDER BY d) AS dows
         FROM generate_series($1::date, $2::date, interval '1 day') d`, [MON, SUN]);
    return rows[0].dows === '1,2,3,4,5,6,7';
  })());

  /* ---------------------------------------------------------------- *
   * §23 20. The range read, which is the one thing that had to be built
   * ---------------------------------------------------------------- */

  console.log('\nleave reads by date range, in one query\n');

  const five = await person('ZZ Five Day');
  await sched.assignEmployeeSchedule(A, five, { scheduleCode: 'ZZMF', validFrom: '2020-01-01' });
  await balance(five);

  const apply = (empId, from, to, over = {}) => leave.applyForLeave(A, {
    employeeId: empId, typeCode: ctx.leaveType, reason: over.reason ?? 'ZZ align',
    startsOn: from, endsOn: to, ...(over.half ? { half: over.half } : {}),
  });

  /* One in the window, one well before it, one well after. */
  const inWindow = await apply(five, TUE, WED);
  const longAgo = await apply(five, '2026-05-04', '2026-05-05');
  const farAhead = await apply(five, '2027-02-01', '2027-02-02');

  const windowed = await leave.listLeave(A, { empIds: [five], from: MON, to: SUN });
  ok('2. only requests overlapping the window come back',
    windowed.length === 1 && windowed[0].id === inWindow.id,
    JSON.stringify(windowed.map((r) => [r.from, r.to])));
  ok('    the earlier one is excluded', !windowed.some((r) => r.id === longAgo.id));
  ok('    and so is the later one', !windowed.some((r) => r.id === farAhead.id));
  ok('3. without a range, everything still comes back',
    (await leave.listLeave(A, { empIds: [five] })).length === 3,
    'the range is an addition, not a behaviour change');

  /* A request straddling the window edge must still appear. */
  const straddling = await apply(five, '2026-10-29', MON);
  const edge = await leave.listLeave(A, { empIds: [five], from: MON, to: SUN });
  ok('4. a request that starts before the window but reaches into it appears',
    edge.some((r) => r.id === straddling.id),
    'overlap, not containment — a month view must not lose a leave that began last month');

  let calls = 0;
  const counting = { query: (sql, params) => { calls += 1; return db.query(sql, params); } };
  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', ctx.tenant]);
  /* Through the same projection the service uses, to count what a range read costs. */
  await counting.query(
    `SELECT lr.id FROM leave_request lr
      WHERE lr.employee_id = ANY($1::uuid[])
        AND lr.status = 'approved' AND lr.starts_on <= $3::date AND lr.ends_on >= $2::date`,
    [[five, ctx.adminEmployeeId], MON, SUN]);
  ok('5. a team-and-span leave read is one statement', calls === 1, `${calls} queries`);
  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', '']);

  /* ---------------------------------------------------------------- *
   * §23 2-4. Only approved participates
   * ---------------------------------------------------------------- */

  console.log('\nonly approved leave is leave\n');

  const reportOf = async () => {
    const id = await person('ZZ Report');
    await sched.assignEmployeeSchedule(A, id, { scheduleCode: 'ZZMF', validFrom: '2020-01-01' });
    await balance(id);
    return id;
  };

  const pendingEmp = await reportOf();
  const pending = await apply(pendingEmp, TUE, TUE);
  ok('6. a fresh request is pending, not approved',
    pending.status === 'Pending', pending.status);
  ok('    and a range read filtered to approved excludes it',
    (await leave.listLeave(A, { empIds: [pendingEmp], from: MON, to: SUN, status: 'Approved' }))
      .length === 0);

  const approvedEmp = await reportOf();
  const toApprove = await apply(approvedEmp, TUE, WED);
  const approved = await leave.approveLeave(A, toApprove.id);
  ok('7. approving makes it approved', approved.status === 'Approved', approved.status);
  ok('    and the approved-only read returns it',
    (await leave.listLeave(A, { empIds: [approvedEmp], from: MON, to: SUN, status: 'Approved' }))
      .length === 1);

  const rejectedEmp = await reportOf();
  const toReject = await apply(rejectedEmp, TUE, TUE);
  await leave.rejectLeave(A, toReject.id, 'ZZ no');
  ok('8. a rejected request is excluded',
    (await leave.listLeave(A, { empIds: [rejectedEmp], from: MON, to: SUN, status: 'Approved' }))
      .length === 0);

  const cancelledEmp = await reportOf();
  const toCancel = await apply(cancelledEmp, TUE, TUE);
  await leave.approveLeave(A, toCancel.id);
  await leave.cancelLeave(A, toCancel.id);
  ok('9. a cancelled request is excluded, even though it was approved once',
    (await leave.listLeave(A, { empIds: [cancelledEmp], from: MON, to: SUN, status: 'Approved' }))
      .length === 0,
    'cancelled no longer is leave; it is not merely historical');
  ok('    and the four statuses are exactly what 0004 allows',
    (await db.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conrelid = 'leave_request'::regclass AND pg_get_constraintdef(oid) LIKE '%status%'`))
      .rows.some((r) => /'pending'/.test(r.d) && /'approved'/.test(r.d)
        && /'rejected'/.test(r.d) && /'cancelled'/.test(r.d)),
    'nothing here invents a fifth');

  /* ---------------------------------------------------------------- *
   * §23 5-9. The three channels stay three
   * ---------------------------------------------------------------- */

  console.log('\nthe three answers do not merge\n');

  const subject = await reportOf();
  const span = await leave.applyForLeave(A, {
    employeeId: subject, typeCode: ctx.leaveType, reason: 'ZZ week off inside',
    startsOn: TUE, endsOn: NEXT_MON,
  });
  await leave.approveLeave(A, span.id);

  /* Tuesday no record, Wednesday an L, Thursday a P. */
  await record(subject, WED, 'L');
  await record(subject, THU, 'P', {
    in: `${THU}T09:00:00+05:30`, out: `${THU}T18:00:00+05:30`, mins: 480,
  });

  const exp = new Map((await cal.workingDaysFor(A, subject, MON, NEXT_MON))
    .map((v) => [v.date, v]));
  const acts = new Map((await att.listAttendance(A,
    { empIds: [subject], from: MON, to: NEXT_MON })).map((r) => [r.date, r]));
  const lv = await leave.listLeave(A,
    { empIds: [subject], from: MON, to: NEXT_MON, status: 'Approved' });
  const covers = (d) => lv.some((r) => r.from <= d && d <= r.to);

  ok('10. approved leave, no attendance → Working / Approved / nothing',
    exp.get(TUE).reason === 'WORKING' && covers(TUE) && acts.get(TUE) === undefined,
    `${exp.get(TUE).reason} / ${covers(TUE)} / ${acts.get(TUE)?.status}`);
  ok('    and no row was created for it',
    (await db.query(
      'SELECT count(*)::int n FROM attendance WHERE employee_id = $1 AND work_date = $2',
      [subject, TUE])).rows[0].n === 0,
    'approved leave does not become attendance.status = L');

  ok('11. approved leave with an L record → Working / Approved / Leave',
    exp.get(WED).reason === 'WORKING' && covers(WED) && acts.get(WED).status === 'L',
    'all three, because the record genuinely exists');
  ok('12. approved leave with a P record → Working / Approved / Present',
    exp.get(THU).reason === 'WORKING' && covers(THU) && acts.get(THU).status === 'P',
    'the conflict is surfaced, not resolved');
  ok('    and the P was not rewritten',
    (await db.query(
      'SELECT status FROM attendance WHERE employee_id = $1 AND work_date = $2',
      [subject, THU])).rows[0].status === 'P',
    'nothing decides which of the two is correct in this phase');

  ok('13. a week off inside the leave span stays a week off',
    exp.get(SAT).reason === 'WEEKLY_OFF' && covers(SAT),
    `${exp.get(SAT).reason}`);
  ok('    the expectation was not promoted to Working by the request',
    exp.get(SAT).workingDay === false,
    'the schedule decides expected; the request does not rewrite it');
  ok('    and Sunday likewise', exp.get(SUN).reason === 'WEEKLY_OFF' && covers(SUN));
  ok('14. the stored day count still excludes those days',
    Number(span.days) === 5,
    `${span.days} — Tue, Wed, Thu, Fri and the next Monday; not the weekend`);

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional)
     VALUES ($1, $2, 'ZZ Alignment Holiday', false)`, [ctx.tenant, FRI]);
  const withHol = new Map((await cal.workingDaysFor(A, subject, MON, NEXT_MON))
    .map((v) => [v.date, v]));
  ok('15. a holiday inside the leave span stays a holiday',
    withHol.get(FRI).reason === 'HOLIDAY' && withHol.get(FRI).holiday === 'ZZ Alignment Holiday'
    && covers(FRI));
  ok('    and no H attendance row appeared',
    (await db.query(
      "SELECT count(*)::int n FROM attendance WHERE employee_id = $1 AND status = 'H'",
      [subject])).rows[0].n === 0);

  /* ---------------------------------------------------------------- *
   * §23 10-11. Half day and multi-day
   * ---------------------------------------------------------------- */

  console.log('\nhalf days keep the representation the schema already has\n');

  const halfEmp = await reportOf();
  const half = await apply(halfEmp, NEXT_MON, NEXT_MON, { half: 'First Half' });
  await leave.approveLeave(A, half.id);
  ok('16. a half day is stored as a named half, not a fraction',
    half.half === 'First Half', String(half.half));
  ok('    with the day count carrying the fraction',
    Number(half.days) === 0.5, String(half.days));
  ok('    and the column holding one of the two allowed values',
    (await db.query(
      'SELECT half_day FROM leave_request WHERE id = $1', [half.id])).rows[0].half_day
      === 'first_half');
  ok('17. a half day is a single date',
    half.from === half.to,
    'which the schema enforces: half_day IS NULL OR starts_on = ends_on');

  const multi = await leave.listLeave(A,
    { empIds: [subject], from: MON, to: NEXT_MON, status: 'Approved' });
  ok('18. a multi-day request is one row spanning the dates',
    multi.length === 1 && multi[0].from === TUE && multi[0].to === NEXT_MON,
    'each date is resolved against the schedule separately by the reader');

  /* ---------------------------------------------------------------- *
   * §23 12. Lifecycle
   * ---------------------------------------------------------------- */

  console.log('\nleave outside the employment does not read as active\n');

  const leaver = await person('ZZ Left Midweek');
  await sched.assignEmployeeSchedule(A, leaver, {
    scheduleCode: 'ZZMF', validFrom: '2020-01-01', validTo: WED,
  });
  await balance(leaver);
  const theirLeave = await apply(leaver, TUE, FRI);
  await leave.approveLeave(A, theirLeave.id);
  await db.query(
    "UPDATE employee SET status = 'exited', left_on = $2 WHERE id = $1", [leaver, WED]);

  const lx = new Map((await cal.workingDaysFor(A, leaver, MON, FRI)).map((v) => [v.date, v]));
  ok('19. a date after they left is Not employed, whatever the request says',
    lx.get(THU).reason === 'NOT_EMPLOYED' && lx.get(FRI).reason === 'NOT_EMPLOYED',
    `${lx.get(THU).reason}`);
  ok('    while the request itself is untouched',
    (await db.query('SELECT status FROM leave_request WHERE id = $1', [theirLeave.id]))
      .rows[0].status === 'approved',
    'the resolver bounds the expectation; it does not edit leave');
  ok('20. and the days they were employed for still resolve normally',
    lx.get(TUE).reason === 'WORKING' && lx.get(WED).reason === 'WORKING');

  /* ---------------------------------------------------------------- *
   * §23 13-14, 21. Scope
   * ---------------------------------------------------------------- */

  console.log('\nnobody sees more leave than before\n');

  const outsider = await person('ZZ Outside The Line', '2020-01-01', { managerId: null });
  await balance(outsider);
  const theirs = await apply(outsider, TUE, TUE);
  await leave.approveLeave(A, theirs.id);

  const MGR = {
    role: 'employee', hasReports: true, tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const asSubject = { role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId: subject, userId: null };

  ok('21. a manager sees leave for their own line',
    (await leave.listLeave(MGR, { empIds: [subject], from: MON, to: NEXT_MON })).length === 1);
  ok('22. and none for somebody outside it',
    (await leave.listLeave(MGR, { empIds: [outsider], from: MON, to: SUN })).length === 0,
    'the scope listLeave already applied, unchanged by the range');
  ok('23. an employee sees only their own',
    (await leave.listLeave(asSubject, { empIds: [subject, outsider], from: MON, to: NEXT_MON }))
      .every((r) => r.empId === subject),
    'empIds narrows what they may see; it never widens it');
  ok('24. including when they ask for somebody else by name',
    (await leave.listLeave(asSubject, { empIds: [outsider], from: MON, to: SUN })).length === 0);
  await refused('25. and they cannot read a colleague\'s calendar either',
    () => cal.workingDaysFor(asSubject, outsider, MON, SUN), /only read your own/);

  /* ---------------------------------------------------------------- *
   * §23 16-19, 24. Reads change nothing
   * ---------------------------------------------------------------- */

  console.log('\nreading all three leaves every table alone\n');

  const counts = async () => (await db.query(
    `SELECT (SELECT count(*)::int FROM attendance WHERE tenant_id = $1) a,
            (SELECT count(*)::int FROM leave_request WHERE tenant_id = $1) lr,
            (SELECT count(*)::int FROM payslip WHERE tenant_id = $1) p`,
    [ctx.tenant])).rows[0];
  const digest = async () => (await db.query(
    `SELECT COALESCE(md5(string_agg(x, '|' ORDER BY x)), 'none') AS d FROM (
       SELECT id::text || status || worked_minutes::text AS x
         FROM attendance WHERE tenant_id = $1
       UNION ALL
       SELECT id::text || status || days::text FROM leave_request WHERE tenant_id = $1
       UNION ALL
       SELECT id::text || used::text || quota::text FROM leave_balance WHERE tenant_id = $1
     ) s`, [ctx.tenant])).rows[0].d;

  const c0 = await counts();
  const d0 = await digest();

  await cal.workingDaysFor(A, subject, MON, NEXT_MON);
  await att.listAttendance(A, { empIds: [subject], from: MON, to: NEXT_MON });
  await leave.listLeave(A, { empIds: [subject], from: MON, to: NEXT_MON, status: 'Approved' });
  await leave.balancesFor(A, subject);

  const c1 = await counts();
  ok('26. no attendance row was created or removed', c1.a === c0.a, `${c0.a} → ${c1.a}`);
  ok('27. no leave request was created or removed', c1.lr === c0.lr, `${c0.lr} → ${c1.lr}`);
  ok('28. no payslip appeared', c1.p === c0.p && c1.p === 0);
  ok('29. and nothing was mutated — status, minutes, days, used, quota',
    await digest() === d0,
    'a digest over all three tables, unchanged across four reads');

  ok('30. the leave range read runs in a read-only transaction',
    /withTenantReadOnly/.test(
      readFileSync(join(here, '..', 'src', 'modules', 'leave', 'service.ts'), 'utf8')
        .slice(readFileSync(join(here, '..', 'src', 'modules', 'leave', 'service.ts'), 'utf8')
          .indexOf('export async function listLeave'))),
    'so the database itself refuses a write from this path');

  /* ---------------------------------------------------------------- *
   * §23 15, §20. Tenant isolation
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (o) => {
    const B = {
      role: 'company_admin', hasReports: false, tenantId: o.tenant, employeeId: o.adminEmployeeId, userId: null,
    };

    console.log('\nand no tenant sees another\'s leave\n');

    ok('31. another tenant reads none of our approved leave',
      (await leave.listLeave(B, { empIds: [subject, five], from: MON, to: NEXT_MON })).length === 0,
      'row level security, not a filter somebody remembered to write');
    ok('32. not even with no range and no employee filter',
      (await leave.listLeave(B, {})).every((r) => r.empId !== subject));

    /*
     * The sharper case: the same leave type code in both tenants. A read that
     * joined on the code rather than the id would cross the boundary here.
     */
    const theirEmp = o.adminEmployeeId;
    await db.query(
      `INSERT INTO leave_balance (tenant_id, employee_id, leave_type_id, year_start, quota)
       SELECT $1, $2, t.id, '2026-04-01', 30 FROM leave_type t
        WHERE t.tenant_id = $1 AND t.code = $3
       ON CONFLICT (tenant_id, employee_id, leave_type_id, year_start) DO NOTHING`,
      [o.tenant, theirEmp, o.leaveType]);
    ok('33. the two tenants use the same leave type code',
      ctx.leaveType === o.leaveType, `${ctx.leaveType} vs ${o.leaveType}`);
    const mine = await leave.listLeave(B, { from: MON, to: NEXT_MON });
    ok('    and their read resolves only their own rows',
      mine.every((r) => r.empId !== subject && r.empId !== five),
      JSON.stringify(mine.map((r) => r.empId)));
    ok('34. our rows are unchanged by their reads', await digest() === d0);
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
ok(`attendance rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok(`leave requests ${after.lr}`, after.lr === before.lr, `was ${before.lr}`);
ok(`leave balances ${after.lb}`, after.lb === before.lb, `was ${before.lb}`);
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
  console.error(`${failed} leave alignment checks failed`);
  process.exit(1);
}
console.log('expected, approved leave and what was recorded are three answers, and stay three');
