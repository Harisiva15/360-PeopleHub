/**
 * The calendar resolver reads the employee's work schedule.
 *
 * Phase 2h-B made one place answer "is this a working day" and answered it from a
 * hard-coded Monday-to-Friday rule, because there was no schedule table. 2h-C
 * added one, 2h-D made it writable, and this is the phase where the resolver reads
 * it. The callers did not change, which was the point of putting the rule in one
 * place to begin with.
 *
 * ## What is worth holding
 *
 * **The schedule is resolved per date, never "the current one".** Somebody who
 * moved from five days to six in July must have May answered by the five-day
 * pattern and August by the six-day one. Reading the current assignment for a
 * whole range is the obvious shortcut and it silently rewrites history every time
 * anybody's schedule changes. Assertions 30-40 hold the per-date join, including
 * across a leave range that straddles the change.
 *
 * **A holiday never outranks a day off.** A holiday on somebody's week off stays
 * WEEKLY_OFF — the holiday gave them nothing. The count is the same either way, so
 * the order only ever decides the reason, and 2h-B's reason is preserved.
 *
 * **There is no silent default.** An employee nobody has assigned a pattern is
 * answered by the Monday-to-Friday rule and the verdict says `schedule: null`. The
 * fallback is the constant rule, deliberately *not* the tenant's editable
 * `DEFAULT_MF` row — see assertions 49-54 for why that distinction is load-bearing.
 *
 * **Employment bounds the calendar.** Before somebody joined, or after they left,
 * there is no day to be expected on. 2h-B reported those dates as WORKING because
 * it had no notion of a person at all.
 *
 * **One query for a year.** Assertion 70 counts the statements a 365-day range
 * costs. It is one.
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
  console.log('\nSKIPPED: no database, and a calendar needs one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const cal = await import('../src/modules/calendar/service.ts');
const sched = await import('../src/modules/schedules/service.ts');
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
  ok(label, e !== null, 'the call succeeded');
  if (e) ok('    in the service\'s own words', expect.test(e.message), `${e.name}: ${e.message}`);
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
         (SELECT count(*)::int FROM holiday) h,
         (SELECT count(*)::int FROM shift) s,
         (SELECT count(*)::int FROM employee_schedule) es`)).rows[0];
const before = await census();

/*
 * Fixed dates, so a weekday assertion cannot depend on the day the suite runs.
 * The ISODOW assertions below prove the weekday rather than trusting this comment.
 */
const MON = '2026-10-05';
const TUE = '2026-10-06';
const WED = '2026-10-07';
const THU = '2026-10-08';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const SUN = '2026-10-11';

/** Index a week of verdicts by date, so an assertion can name the day it means. */
const byDate = (verdicts) => new Map(verdicts.map((v) => [v.date, v]));

let fatal = null;
try {

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };

  /** An employee of this tenant, with the lifecycle dates the test needs. */
  const person = async (name, joinedOn, { leftOn = null, status = 'active', siteId } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                             department_id, site_id, legal_entity_id, shift_id,
                             manager_id, joined_on, left_on)
       SELECT $1, $2, $3, $4, $7, 'employee',
              (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
              COALESCE($8::uuid, (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1)),
              (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'),
              $5, $6::date, $9::date
       RETURNING id`,
      [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name,
        `zz-${Math.random().toString(36).slice(2, 10)}@360.technology`,
        ctx.adminEmployeeId, joinedOn, status, siteId ?? null, leftOn]);
    return rows[0].id;
  };

  /* ---------------------------------------------------------------- *
   * The patterns this tenant works
   * ---------------------------------------------------------------- */

  console.log('\nthe weekdays these dates actually are\n');

  ok('1. the fixed dates are the weekdays the suite assumes', await (async () => {
    const dows = (await db.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, EXTRACT(ISODOW FROM d)::int AS n
         FROM generate_series($1::date, $2::date, interval '1 day') d`, [MON, SUN])).rows;
    return dows.map((r) => r.n).join(',') === '1,2,3,4,5,6,7';
  })(), 'if this fails every weekday assertion below is meaningless');

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
   * A. The default five-day pattern
   * ---------------------------------------------------------------- */

  console.log('\nA. a five-day pattern\n');

  const mf = await person('ZZ Five Day', '2020-01-01');
  await sched.assignEmployeeSchedule(A, mf, { scheduleCode: 'ZZMF', validFrom: '2020-01-01' });
  const mfWeek = byDate(await cal.workingDaysFor(A, mf, MON, SUN));

  ok('2. Monday works', mfWeek.get(MON).workingDay === true);
  ok('3. Friday works', mfWeek.get(FRI).workingDay === true);
  ok('4. Saturday is off', mfWeek.get(SAT).workingDay === false
    && mfWeek.get(SAT).reason === 'WEEKLY_OFF', mfWeek.get(SAT).reason);
  ok('5. Sunday is off', mfWeek.get(SUN).workingDay === false
    && mfWeek.get(SUN).reason === 'WEEKLY_OFF', mfWeek.get(SUN).reason);
  ok('6. five working days in the week',
    [...mfWeek.values()].filter((v) => v.workingDay).length === 5);
  ok('7. and every verdict names the schedule that decided it',
    [...mfWeek.values()].every((v) => v.schedule === 'ZZMF'),
    JSON.stringify([...mfWeek.values()].map((v) => v.schedule)));

  /* ---------------------------------------------------------------- *
   * B. Six days
   * ---------------------------------------------------------------- */

  console.log('\nB. a six-day pattern — the thing the hard-coded rule could not say\n');

  const msat = await person('ZZ Six Day', '2020-01-01');
  await sched.assignEmployeeSchedule(A, msat, { scheduleCode: 'ZZMSAT', validFrom: '2020-01-01' });
  const msatWeek = byDate(await cal.workingDaysFor(A, msat, MON, SUN));

  ok('8. Monday through Saturday all work',
    [MON, TUE, WED, THU, FRI, SAT].every((d) => msatWeek.get(d).workingDay === true),
    JSON.stringify([MON, TUE, WED, THU, FRI, SAT].map((d) => msatWeek.get(d).workingDay)));
  ok('9. Saturday works and is not reported as a week off',
    msatWeek.get(SAT).reason === 'WORKING', msatWeek.get(SAT).reason);
  ok('10. Sunday is still off', msatWeek.get(SUN).reason === 'WEEKLY_OFF');
  ok('11. six working days in the week',
    [...msatWeek.values()].filter((v) => v.workingDay).length === 6);
  ok('12. and the same Saturday is off for the five-day employee',
    mfWeek.get(SAT).workingDay === false,
    'one date, two employees, two answers — which is the whole point of this phase');

  /* ---------------------------------------------------------------- *
   * C. Sunday to Thursday
   * ---------------------------------------------------------------- */

  console.log('\nC. Sunday to Thursday\n');

  const gulf = await person('ZZ Gulf Week', '2020-01-01');
  await sched.assignEmployeeSchedule(A, gulf, {
    scheduleCode: 'ZZSUNTHU', validFrom: '2020-01-01',
  });
  const gulfWeek = byDate(await cal.workingDaysFor(A, gulf, MON, SUN));

  ok('13. Sunday works', gulfWeek.get(SUN).workingDay === true
    && gulfWeek.get(SUN).reason === 'WORKING', gulfWeek.get(SUN).reason);
  ok('14. Monday through Thursday work',
    [MON, TUE, WED, THU].every((d) => gulfWeek.get(d).workingDay === true));
  ok('15. Friday is off', gulfWeek.get(FRI).workingDay === false
    && gulfWeek.get(FRI).reason === 'WEEKLY_OFF', gulfWeek.get(FRI).reason);
  ok('16. Saturday is off', gulfWeek.get(SAT).workingDay === false);
  ok('17. five working days, on different days',
    [...gulfWeek.values()].filter((v) => v.workingDay).length === 5);

  /* ---------------------------------------------------------------- *
   * D. A weekday on a different shift
   * ---------------------------------------------------------------- */

  console.log('\nD. a weekday that runs a different shift\n');

  await db.query(
    `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone)
     VALUES ($1, 'ZZLATE', 'ZZ Late', '13:00', '22:00', 'Asia/Kolkata')`, [ctx.tenant]);
  await sched.setWorkScheduleDay(A, 'ZZMF', { dayOfWeek: 3, working: true, shiftCode: 'ZZLATE' });

  const shifted = byDate(await cal.workingDaysFor(A, mf, MON, SUN));
  ok('18. Monday runs the employee\'s own shift', shifted.get(MON).shift === 'IN',
    shifted.get(MON).shift);
  ok('19. Tuesday runs the employee\'s own shift', shifted.get(TUE).shift === 'IN');
  ok('20. Wednesday runs the shift the schedule names', shifted.get(WED).shift === 'ZZLATE',
    shifted.get(WED).shift);
  ok('21. and Wednesday is still a working day', shifted.get(WED).workingDay === true);
  ok('22. a day nobody works names no shift', shifted.get(SAT).shift === null);
  ok('23. the employee\'s own shift_id was not touched',
    (await db.query('SELECT s.code FROM employee e JOIN shift s ON s.id = e.shift_id '
      + 'WHERE e.id = $1', [mf])).rows[0].code === 'IN',
    'a schedule points at a shift; it never writes employee.shift_id');
  ok('24. and no hour was copied out of the shift onto the schedule',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('work_schedule', 'work_schedule_day')
          AND (column_name LIKE '%start%' OR column_name LIKE '%end%'
            OR column_name LIKE '%timezone%')`)).rows[0].n === 0);

  await sched.setWorkScheduleDay(A, 'ZZMF', { dayOfWeek: 3, working: true, shiftCode: null });

  /* ---------------------------------------------------------------- *
   * E, F, M. Effective dating
   * ---------------------------------------------------------------- */

  console.log('\nE/F/M. the pattern that applied on the date, not the one that applies now\n');

  const moved = await person('ZZ Changed Pattern', '2020-01-01');
  await sched.assignEmployeeSchedule(A, moved, {
    scheduleCode: 'ZZMF', validFrom: '2026-01-01', validTo: '2026-10-15',
  });
  await sched.assignEmployeeSchedule(A, moved, {
    scheduleCode: 'ZZMSAT', validFrom: '2026-10-16',
  });

  const before15 = byDate(await cal.workingDaysFor(A, moved, '2026-10-05', '2026-10-11'));
  ok('25. a Saturday before the change is off', before15.get(SAT).workingDay === false,
    'the five-day pattern applied then');
  ok('    decided by the old schedule', before15.get(SAT).schedule === 'ZZMF',
    before15.get(SAT).schedule);

  const after15 = byDate(await cal.workingDaysFor(A, moved, '2026-10-17', '2026-10-18'));
  ok('26. a Saturday after the change works',
    after15.get('2026-10-17').workingDay === true,
    `${after15.get('2026-10-17').reason} / ${after15.get('2026-10-17').schedule}`);
  ok('    decided by the new schedule', after15.get('2026-10-17').schedule === 'ZZMSAT');

  /* The boundary §13-F names: valid_to is inclusive. */
  const edge = byDate(await cal.workingDaysFor(A, moved, '2026-10-15', '2026-10-16'));
  ok('27. 15 October — the inclusive valid_to — uses the old schedule',
    edge.get('2026-10-15').schedule === 'ZZMF', edge.get('2026-10-15').schedule);
  ok('28. 16 October uses the new one',
    edge.get('2026-10-16').schedule === 'ZZMSAT', edge.get('2026-10-16').schedule);
  ok('29. and neither date fell through to the fallback',
    edge.get('2026-10-15').schedule !== null && edge.get('2026-10-16').schedule !== null,
    'an off-by-one on the inclusive bound would leave a day unscheduled');

  /* §13-M: the historical answer must not be the current one. */
  const may = await cal.workingDaysFor(A, moved, '2026-05-02', '2026-05-02');
  ok('30. a Saturday in May resolves against May\'s assignment',
    may[0].schedule === 'ZZMF' && may[0].workingDay === false,
    `${may[0].schedule} / ${may[0].workingDay}`);
  ok('31. even though the current assignment is the six-day one',
    (await sched.employeeScheduleOn(A, moved, '2026-12-01')).scheduleCode === 'ZZMSAT',
    'reading the current schedule for a past date is the bug this holds against');

  const spanning = await cal.workingDaysFor(A, moved, '2026-10-12', '2026-10-18');
  ok('32. one range crossing the change counts each side under its own pattern',
    spanning.filter((v) => v.workingDay).length === 6,
    JSON.stringify(spanning.map((v) => [v.date, v.workingDay, v.schedule])));
  ok('    Saturday the 17th works and the 10th did not',
    byDate(spanning).get('2026-10-17').workingDay === true
    && before15.get(SAT).workingDay === false);

  /* ---------------------------------------------------------------- *
   * G, H, I, J. Holidays
   * ---------------------------------------------------------------- */

  console.log('\nG/H/I/J. holidays, and what they do not outrank\n');

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional) VALUES
       ($1, $2, 'ZZ Mandatory Thursday', false),
       ($1, $3, 'ZZ Mandatory Saturday', false),
       ($1, $4, 'ZZ Optional Tuesday', true)`, [ctx.tenant, THU, SAT, TUE]);

  const hol = byDate(await cal.workingDaysFor(A, mf, MON, SUN));

  ok('33. a mandatory holiday on a working day is a holiday',
    hol.get(THU).reason === 'HOLIDAY' && hol.get(THU).workingDay === false, hol.get(THU).reason);
  ok('    and carries its name', hol.get(THU).holiday === 'ZZ Mandatory Thursday',
    hol.get(THU).holiday);
  ok('34. a mandatory holiday on a week off stays a week off',
    hol.get(SAT).reason === 'WEEKLY_OFF', hol.get(SAT).reason);
  ok('    which is what 2h-B reported, and the holiday gave them nothing',
    hol.get(SAT).workingDay === false);
  ok('35. an optional holiday remains a working day',
    hol.get(TUE).reason === 'WORKING' && hol.get(TUE).workingDay === true, hol.get(TUE).reason);
  ok('36. so the five-day week now holds four working days',
    [...hol.values()].filter((v) => v.workingDay).length === 4,
    'Thursday closed; the optional Tuesday did not');

  /* The same Saturday holiday, for somebody who works Saturdays. */
  const holMsat = byDate(await cal.workingDaysFor(A, msat, MON, SUN));
  ok('37. that Saturday holiday closes the office for the six-day employee',
    holMsat.get(SAT).reason === 'HOLIDAY', holMsat.get(SAT).reason);
  ok('    so the schedule decides whether a holiday is even reachable',
    hol.get(SAT).reason === 'WEEKLY_OFF' && holMsat.get(SAT).reason === 'HOLIDAY',
    'one holiday, two employees, two reasons — both non-working');

  /* §13-J: a site-specific holiday. */
  const otherSite = (await db.query(
    `INSERT INTO site (tenant_id, code, name, country, timezone, active)
     VALUES ($1, 'ZZCHE', 'ZZ Chennai', 'IN', 'Asia/Kolkata', true) RETURNING id`,
    [ctx.tenant])).rows[0].id;
  const atOther = await person('ZZ Other Site', '2020-01-01', { siteId: otherSite });
  await sched.assignEmployeeSchedule(A, atOther, { scheduleCode: 'ZZMF', validFrom: '2020-01-01' });
  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional, site_id)
     VALUES ($1, $2, 'ZZ Chennai Only', false, $3)`, [ctx.tenant, WED, otherSite]);

  const siteWeek = byDate(await cal.workingDaysFor(A, atOther, MON, SUN));
  ok('38. a site holiday closes the office for somebody at that site',
    siteWeek.get(WED).reason === 'HOLIDAY'
    && siteWeek.get(WED).holiday === 'ZZ Chennai Only', siteWeek.get(WED).reason);
  const stillWorking = byDate(await cal.workingDaysFor(A, mf, MON, SUN));
  ok('39. and nobody else sees it',
    stillWorking.get(WED).reason === 'WORKING', stillWorking.get(WED).reason);

  /* ---------------------------------------------------------------- *
   * K. No schedule at all
   * ---------------------------------------------------------------- */

  console.log('\nK. an employee nobody has put on a pattern\n');

  const unassigned = await person('ZZ No Schedule', '2020-01-01');
  ok('40. they genuinely have no assignment',
    (await sched.employeeSchedules(A, unassigned)).length === 0);

  const un = byDate(await cal.workingDaysFor(A, unassigned, MON, SUN));
  ok('41. the Monday-to-Friday fallback answers for them',
    [...un.values()].filter((v) => v.workingDay).length === 4,
    'four, not five — the mandatory Thursday holiday still applies');
  ok('42. Saturday and Sunday are off',
    un.get(SAT).reason === 'WEEKLY_OFF' && un.get(SUN).reason === 'WEEKLY_OFF');
  ok('43. and every verdict says no schedule decided it',
    [...un.values()].every((v) => v.schedule === null),
    JSON.stringify([...un.values()].map((v) => v.schedule)));
  ok('44. so the fallback is reported, not silent',
    un.get(MON).schedule === null && un.get(MON).workingDay === true,
    'a caller can tell a scheduled Monday from an assumed one');
  ok('45. holidays still apply to them', un.get(THU).reason === 'HOLIDAY');
  ok('46. and their own shift still resolves', un.get(MON).shift === 'IN', un.get(MON).shift);

  /*
   * The distinction that makes the fallback safe: it is the constant rule, not
   * the tenant's editable DEFAULT_MF row. Editing that row must not move anybody
   * nobody assigned to it.
   */
  const def = await sched.ensureDefaultSchedule(A);
  await sched.setWorkScheduleDay(A, def.code, { dayOfWeek: 6, working: true });
  const afterEdit = byDate(await cal.workingDaysFor(A, unassigned, MON, SUN));
  ok('47. making DEFAULT_MF a six-day pattern does not give them a working Saturday',
    afterEdit.get(SAT).workingDay === false, afterEdit.get(SAT).reason);
  ok('    because the fallback is the rule, not that row',
    afterEdit.get(SAT).schedule === null,
    'reaching for DEFAULT_MF would make a tenant edit silently move unassigned people');
  await sched.setWorkScheduleDay(A, def.code, { dayOfWeek: 6, working: false });

  /* And a date before the only assignment begins is the same case. */
  const late = await person('ZZ Late Assignment', '2020-01-01');
  await sched.assignEmployeeSchedule(A, late, { scheduleCode: 'ZZMSAT', validFrom: '2026-11-01' });
  const gap = byDate(await cal.workingDaysFor(A, late, MON, SUN));
  ok('48. a date before an employee\'s first assignment falls back too',
    gap.get(SAT).workingDay === false && gap.get(SAT).schedule === null,
    `${gap.get(SAT).schedule}`);
  ok('    while a date inside it does not',
    (await cal.workingDaysFor(A, late, '2026-11-07', '2026-11-07'))[0].schedule === 'ZZMSAT');

  /* ---------------------------------------------------------------- *
   * L. Employment bounds
   * ---------------------------------------------------------------- */

  console.log('\nL. before somebody joined, and after they left\n');

  const joiner = await person('ZZ Joined Midweek', WED);
  await sched.assignEmployeeSchedule(A, joiner, { scheduleCode: 'ZZMF', validFrom: WED });
  const jw = byDate(await cal.workingDaysFor(A, joiner, MON, SUN));
  ok('49. Monday before they joined is not a working day',
    jw.get(MON).workingDay === false && jw.get(MON).reason === 'NOT_EMPLOYED', jw.get(MON).reason);
  ok('50. the day they joined is', jw.get(WED).workingDay === true, jw.get(WED).reason);
  ok('51. a not-employed day names no schedule and no holiday',
    jw.get(MON).schedule === null && jw.get(MON).holiday === null && jw.get(MON).shift === null);

  /*
   * Assigned while employed, then exited — which is the order it happens in, and
   * the order 2h-D requires: it refuses to put somebody who has already left onto
   * a schedule.
   */
  const leaver = await person('ZZ Left On Wednesday', '2020-01-01');
  await sched.assignEmployeeSchedule(A, leaver, {
    scheduleCode: 'ZZMF', validFrom: '2020-01-01', validTo: WED,
  });
  await db.query(
    "UPDATE employee SET status = 'exited', left_on = $2 WHERE id = $1", [leaver, WED]);
  const lw = byDate(await cal.workingDaysFor(A, leaver, MON, SUN));
  ok('52. dates through left_on resolve against the schedule',
    lw.get(MON).workingDay === true && lw.get(MON).schedule === 'ZZMF',
    `${lw.get(MON).reason} / ${lw.get(MON).schedule}`);
  ok('    including the last working day itself',
    lw.get(WED).schedule === 'ZZMF', lw.get(WED).schedule);
  ok('53. the day after they left is not a working day',
    lw.get(THU).reason === 'NOT_EMPLOYED', lw.get(THU).reason);
  ok('    and Friday is not either', lw.get(FRI).reason === 'NOT_EMPLOYED');
  ok('54. so nothing reports them as actively scheduled after they left',
    [THU, FRI, SAT, SUN].every((d) => lw.get(d).workingDay === false
      && lw.get(d).schedule === null));

  /*
   * An exited employee with no recorded leaving date cannot be bounded, and
   * nothing here invents one. 0054 left them unassigned for exactly this reason
   * and §6 of this phase says not to infer a date from anything else.
   */
  const vague = await person('ZZ Exited No Date', '2020-01-01', { status: 'exited' });
  const vw = byDate(await cal.workingDaysFor(A, vague, MON, SUN));
  ok('55. an exited employee with no left_on is not bounded',
    vw.get(MON).reason !== 'NOT_EMPLOYED', vw.get(MON).reason);
  ok('    they fall back, as they did before this phase',
    vw.get(MON).schedule === null && vw.get(SAT).workingDay === false,
    'inferring an exit date from status alone would rewrite their history');

  /* ---------------------------------------------------------------- *
   * Regression: the backfilled employee behaves exactly as in 2h-B
   * ---------------------------------------------------------------- */

  console.log('\n2h-B behaviour is preserved for anybody on the default pattern\n');

  const normal = await person('ZZ Ordinary', '2020-01-01');
  await sched.assignEmployeeSchedule(A, normal, {
    scheduleCode: def.code, validFrom: '2020-01-01',
  });
  const nw = byDate(await cal.workingDaysFor(A, normal, MON, SUN));
  ok('56. Monday to Friday work, Saturday and Sunday do not',
    [MON, TUE, WED, FRI].every((d) => nw.get(d).workingDay === true)
    && nw.get(SAT).workingDay === false && nw.get(SUN).workingDay === false,
    JSON.stringify([...nw.values()].map((v) => [v.date, v.workingDay])));
  ok('57. the mandatory holiday closes Thursday', nw.get(THU).reason === 'HOLIDAY');
  ok('58. the optional one does not close Tuesday', nw.get(TUE).reason === 'WORKING');
  ok('59. four working days, which is what 2h-B counted',
    [...nw.values()].filter((v) => v.workingDay).length === 4);
  ok('60. and the same range for the unassigned employee counts the same',
    [...un.values()].filter((v) => v.workingDay).length === 4,
    'assigned to the default or assigned to nothing, the answer matches 2h-B');

  /* ---------------------------------------------------------------- *
   * N, O. Leave
   * ---------------------------------------------------------------- */

  console.log('\nN/O. leave consumes the resolver, so schedules reach it for free\n');

  const balance = async (empId) => db.query(
    `INSERT INTO leave_balance (tenant_id, employee_id, leave_type_id, year_start, quota)
     SELECT $1, $2, t.id, '2026-04-01', 24 FROM leave_type t
      WHERE t.tenant_id = $1 AND t.code = $3`, [ctx.tenant, empId, ctx.leaveType]);
  const apply = (empId, body) => leave.applyForLeave(A, {
    employeeId: empId, typeCode: ctx.leaveType, reason: 'ZZ test', ...body,
  });

  await balance(mf); await balance(msat); await balance(gulf); await balance(moved);

  /*
   * Friday to Monday, counted three ways from schedule data alone. Nothing in
   * the code names these numbers; they come out of the patterns above.
   */
  const fri = '2026-11-06';
  const mon = '2026-11-09';
  const mfReq = await apply(mf, { startsOn: fri, endsOn: mon });
  ok('61. a five-day employee takes two days over Friday to Monday',
    Number(mfReq.days) === 2, String(mfReq.days));
  const msatReq = await apply(msat, { startsOn: fri, endsOn: mon });
  ok('62. a six-day employee takes three', Number(msatReq.days) === 3, String(msatReq.days));
  const gulfReq = await apply(gulf, { startsOn: '2026-11-08', endsOn: mon });
  ok('63. a Sunday-to-Thursday employee takes two over Sunday to Monday',
    Number(gulfReq.days) === 2, String(gulfReq.days));
  ok('    and their Sunday is one of them',
    (await cal.workingDaysFor(A, gulf, '2026-11-08', '2026-11-08'))[0].workingDay === true);

  /* §13-N: a range crossing the schedule change. */
  const crossing = await apply(moved, { startsOn: '2026-10-12', endsOn: '2026-10-18' });
  ok('64. a leave range crossing the change counts six days',
    Number(crossing.days) === 6, String(crossing.days));
  ok('    which is five from the old pattern and one more Saturday from the new',
    (await cal.workingDaysFor(A, moved, '2026-10-12', '2026-10-18'))
      .filter((v) => v.workingDay).length === 6);

  /* §13-O: half days unchanged. */
  const halfDay = await apply(mf, {
    startsOn: '2026-11-16', endsOn: '2026-11-16', half: 'First Half',
  });
  ok('65. a half day is still half a day', Number(halfDay.days) === 0.5, String(halfDay.days));
  ok('    on a working day', halfDay.status === 'Pending');
  await refused('66. and half of a day nobody works is still refused',
    () => apply(mf, { startsOn: '2026-11-21', endsOn: '2026-11-21', half: 'First Half' }),
    /no leave to take/);
  await refused('67. a Saturday is still refused for the five-day employee',
    () => apply(mf, { startsOn: '2026-11-21', endsOn: '2026-11-22' }), /all week off/);
  ok('68. but the six-day employee may take that same Saturday',
    Number((await apply(msat, { startsOn: '2026-11-21', endsOn: '2026-11-21' })).days) === 1,
    'the refusal is the schedule\'s, not the calendar\'s');

  const outside = await person('ZZ Not Yet Joined', '2027-01-01');
  await balance(outside);
  await refused('69. leave outside somebody\'s employment is refused, and says so',
    () => apply(outside, { startsOn: MON, endsOn: TUE }),
    /outside this person's employment/);

  ok('70. a client-sent day count is still ignored',
    Number((await apply(mf, {
      startsOn: '2026-11-23', endsOn: '2026-11-24', days: 100,
    })).days) === 2,
    'the 2h-B security property survives this phase');

  /* ---------------------------------------------------------------- *
   * Performance: one statement for a year
   * ---------------------------------------------------------------- */

  console.log('\none query, however long the range\n');

  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', ctx.tenant]);
  let calls = 0;
  const counting = {
    query: (sql, params) => { calls += 1; return db.query(sql, params); },
  };
  const year = await cal.classifyRange(counting, mf, '2026-01-01', '2026-12-31');
  ok('71. a 365-day range costs one statement', calls === 1, `${calls} queries`);
  ok('    and returns a verdict for every date', year.length === 365, String(year.length));
  ok('72. a range beyond the cap is refused before the database is asked', await (async () => {
    calls = 0;
    const e = await attempt(() => cal.classifyRange(counting, mf, '2026-01-01', '2027-12-31'));
    return e !== null && /at most 400 days/.test(e.message) && calls === 0;
  })(), 'the generate_series never runs');
  await db.query('SELECT set_config($1, $2, false)', ['app.tenant_id', '']);

  /* ---------------------------------------------------------------- *
   * Nothing was materialised
   * ---------------------------------------------------------------- */

  ok('73. no attendance row was created',
    (await db.query('SELECT count(*)::int n FROM attendance WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === 0);
  ok('74. and no payslip', (await db.query(
    'SELECT count(*)::int n FROM payslip WHERE tenant_id = $1', [ctx.tenant])).rows[0].n === 0);

  /* ---------------------------------------------------------------- *
   * P. Tenant isolation
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (o) => {
    const B = {
      role: 'admin', tenantId: o.tenant, employeeId: o.adminEmployeeId, userId: null,
    };

    console.log('\nP. nothing reaches across a tenant\n');

    await refused('75. another tenant cannot read our employee\'s calendar',
      () => cal.workingDaysFor(B, mf, MON, SUN), /no such employee/);
    await refused('    nor the six-day one\'s',
      () => cal.workingDaysFor(B, msat, MON, SUN), /no such employee/);

    const theirs = await cal.workingDaysFor(B, o.adminEmployeeId, MON, SUN);
    ok('76. their own employee sees none of our schedules',
      theirs.every((v) => v.schedule === null),
      JSON.stringify(theirs.map((v) => v.schedule)));
    ok('77. and none of our holidays',
      theirs.every((v) => v.holiday === null),
      'our mandatory Thursday and site holiday are not theirs to see');
    ok('78. they fall back to Monday to Friday',
      theirs.filter((v) => v.workingDay).length === 5, String(theirs.filter((v) => v.workingDay).length));

    /*
     * The sharper case: their own employee, put on their own schedule with the
     * same code as ours. The join must find theirs.
     */
    await sched.createWorkSchedule(B, {
      code: 'ZZMF', name: 'ZZ Theirs',
      days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, working: dayOfWeek === 1 })),
    });
    await sched.assignEmployeeSchedule(B, o.adminEmployeeId, {
      scheduleCode: 'ZZMF', validFrom: '2020-01-01',
    });
    const mine = await cal.workingDaysFor(B, o.adminEmployeeId, MON, SUN);
    ok('79. a schedule code shared with another tenant resolves to their own',
      mine.filter((v) => v.workingDay).length === 1,
      JSON.stringify(mine.map((v) => [v.date, v.workingDay])));
    ok('    and our five-day employee is unaffected',
      (await cal.workingDaysFor(A, mf, MON, SUN)).filter((v) => v.workingDay).length === 4);
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
ok(`payslips ${after.p}`, after.p === before.p, `was ${before.p}`);
ok(`holidays ${after.h}`, after.h === before.h, `was ${before.h}`);
ok(`shifts ${after.s}`, after.s === before.s, `was ${before.s}`);
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
  console.error(`${failed} calendar schedule checks failed`);
  process.exit(1);
}
console.log('the calendar answers from the pattern each person was actually on');
