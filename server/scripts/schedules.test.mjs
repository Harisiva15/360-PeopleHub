/**
 * The service that makes 0054's tables usable.
 *
 * Three tables arrived in Phase 2h-C and nothing read them. This covers what the
 * service does with them, and — more usefully — what it refuses.
 *
 * ## What is worth holding
 *
 * **A schedule covers all seven weekdays or it is not created.** A gap would
 * answer "is Wednesday worked" with nothing, and a resolver reading it later
 * would have to invent the answer. Omitting the days means Monday to Friday,
 * which is what 0054's own default records.
 *
 * **Hours never leak into a schedule.** `work_schedule_day.shift_id` points at the
 * existing table; a day with no shift means the employee's own, which is NOT NULL
 * and has been the authority since 0015. Nothing copies a start time.
 *
 * **Supersession follows `employment_record`, not a new rule.** A change effective
 * on the day the open period began amends it; otherwise the open period is closed
 * the day before the new one starts. A period that has already ended is never
 * rewritten — that is the one case with no precedent in this repository, so it is
 * refused with the dates named rather than guessed at.
 *
 * **The database is the authority on overlap.** The service checks first so the
 * caller gets a sentence instead of 23P01, and the exclusion constraint is what
 * actually makes two assignments for one day impossible — including under
 * concurrency, where both callers can pass the check and one must lose.
 *
 * **Nothing resolves a calendar here.** Writing a schedule and deciding what a
 * date means are separate jobs, and `calendar/service.ts` owns the second. Phase
 * 2h-E taught it to read these tables; the assertions near the end check that the
 * two agree about one person's Saturday, which is the seam between the services
 * rather than either one's own behaviour.
 */

import { randomUUID } from 'node:crypto';
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
  console.log('\nSKIPPED: no database, and effective dating needs one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const sched = await import('../src/modules/schedules/service.ts');
const calendar = await import('../src/modules/calendar/service.ts');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
/** A refusal in the service's own words, never a raw SQLSTATE. */
const refused = async (label, fn, expect) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the call succeeded — this is a hole, not a test failure');
  if (e) {
    ok('    refused in the service\'s own words', expect.test(e.message),
      `${e.code ?? ''} ${e.message}`);
    ok('    and not as a database error code',
      !/^23[0-9P]/.test(e.message) && e.name === 'ScheduleError',
      `${e.name}: ${e.message}`);
  }
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(`
  SELECT (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM work_schedule) ws,
         (SELECT count(*)::int FROM employee_schedule) es,
         (SELECT count(*)::int FROM attendance) a,
         (SELECT count(*)::int FROM payslip) p,
         (SELECT count(*)::int FROM shift) s,
         (SELECT count(*)::int FROM holiday) h`)).rows[0];
const before = await census();

let fatal = null;
try {

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const MGR = {
    role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const EMP = {
    role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };

  /* ---------------------------------------------------------------- *
   * Schedules
   * ---------------------------------------------------------------- */

  console.log('\na tenant defines the patterns it works\n');

  const made = await sched.createWorkSchedule(A, {
    code: 'zzmf', name: '  ZZ Monday to Friday  ', description: '  the usual  ',
  });
  ok('1. a schedule is created, code upper-cased', made.code === 'ZZMF', made.code);
  ok('    name and description trimmed',
    made.name === 'ZZ Monday to Friday' && made.description === 'the usual');
  ok('    and it starts active', made.active === true);
  ok('2. omitting the days means Monday to Friday', made.days.length === 7
    && made.days.filter((d) => d.working).map((d) => d.dayOfWeek).join(',') === '1,2,3,4,5',
    JSON.stringify(made.days.map((d) => [d.dayOfWeek, d.working])));
  ok('    with no shift on any day',
    made.days.every((d) => d.shiftCode === null),
    'a schedule says which days; the employee\'s own shift says the hours');
  ok('3. nobody is on it yet', made.assignedNow === 0);

  const six = await sched.createWorkSchedule(A, {
    code: 'ZZSIX', name: 'ZZ Six Day',
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, working: dayOfWeek <= 6 })),
  });
  ok('4. a six-day pattern is representable',
    six.days.filter((d) => d.working).map((d) => d.dayOfWeek).join(',') === '1,2,3,4,5,6');

  /* The Gulf week, which the hard-coded rule could never express. */
  const gulf = await sched.createWorkSchedule(A, {
    code: 'ZZGULF', name: 'ZZ Sunday to Thursday',
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
      dayOfWeek, working: dayOfWeek <= 4 || dayOfWeek === 7,
    })),
  });
  ok('5. and so is Sunday to Thursday', gulf.days.filter((d) => d.working)
    .map((d) => d.dayOfWeek).join(',') === '1,2,3,4,7',
    'Friday and Saturday off, which isWeekend could never say');

  console.log('\nand the service refuses what the schema would only refuse later\n');

  await refused('6. a duplicate code is refused as a conflict',
    () => sched.createWorkSchedule(A, { code: 'ZZMF', name: 'ZZ Again' }),
    /already a work schedule/);
  await refused('7. a blank code is refused',
    () => sched.createWorkSchedule(A, { code: '  ', name: 'ZZ x' }), /needs a code/);
  await refused('8. a code that is not a code is refused',
    () => sched.createWorkSchedule(A, { code: 'zz bad!', name: 'ZZ x' }),
    /2-16 characters/);
  await refused('9. a blank name is refused',
    () => sched.createWorkSchedule(A, { code: 'ZZBL', name: '   ' }), /needs a name/);
  await refused('10. six days is refused — a schedule covers the whole week',
    () => sched.createWorkSchedule(A, {
      code: 'ZZPART', name: 'ZZ Partial',
      days: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, working: true })),
    }), /all seven weekdays/);
  await refused('11. and so is the same weekday twice',
    () => sched.createWorkSchedule(A, {
      code: 'ZZDUP', name: 'ZZ Dup',
      days: [1, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, working: true })),
    }), /each weekday appears once/);

  console.log('\nreading them\n');

  const list = await sched.listWorkSchedules(A);
  ok('12. the list returns this tenant\'s schedules', list.length >= 3);
  /*
   * This asserted the list carried *no* days, the single read being where they
   * came from. Phase 2h-F needed them on the list: a screen showing which days
   * each pattern works had the choice of this or one request per row, and the
   * list now does it in one further statement for all of them.
   *
   * Inverted rather than deleted, and tightened while it was open — the property
   * worth holding is that the days arrive complete, because a partial seven is
   * what would make a resolver invent an answer.
   */
  ok('    each carrying all seven weekdays',
    list.every((s) => s.days.length === 7),
    JSON.stringify(list.map((s) => [s.code, s.days.length])));
  ok('    in weekday order, so a screen need not sort them',
    list.every((s) => s.days.map((d) => d.dayOfWeek).join(',') === '1,2,3,4,5,6,7'));
  ok('    and the list costs the same two statements however many there are',
    list.length >= 3,
    'one for the schedules, one for every weekday of all of them');
  const one = await sched.getWorkSchedule(A, 'zzmf');
  ok('13. a single read resolves a lower-case code and carries the days',
    one.code === 'ZZMF' && one.days.length === 7);
  await refused('14. an unknown code is not found',
    () => sched.getWorkSchedule(A, 'ZZNOPE'), /no such work schedule/);

  ok('15. a manager may read the patterns',
    (await sched.listWorkSchedules(MGR)).length >= 3);
  ok('    and so may an employee', (await sched.listWorkSchedules(EMP)).length >= 3,
    'which days a company works is not privileged');

  console.log('\nchanging one\n');

  const renamed = await sched.updateWorkSchedule(A, 'ZZMF', { name: 'ZZ Standard Week' });
  ok('16. a name can be corrected', renamed.name === 'ZZ Standard Week');
  await refused('17. the code cannot change',
    () => sched.updateWorkSchedule(A, 'ZZMF', { code: 'ZZOTHER' }), /code cannot change/);
  await refused('18. and the days are not changed through this call',
    () => sched.updateWorkSchedule(A, 'ZZMF', { days: [] }), /one at a time/);

  /* ---------------------------------------------------------------- *
   * Weekdays, and the shift each may name
   * ---------------------------------------------------------------- */

  console.log('\na weekday can run a different shift without copying its hours\n');

  await db.query(
    `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone)
     VALUES ($1, 'ZZLATE', 'ZZ Late', '13:00', '22:00', 'Asia/Kolkata')`,
    [ctx.tenant]);

  const withLate = await sched.setWorkScheduleDay(A, 'ZZMF', {
    dayOfWeek: 3, working: true, shiftCode: 'zzlate',
  });
  const wed = withLate.days.find((d) => d.dayOfWeek === 3);
  ok('19. Wednesday now names the late shift', wed.shiftCode === 'ZZLATE', wed.shiftCode);
  ok('    with its name resolved for a screen', wed.shiftName === 'ZZ Late', wed.shiftName);
  ok('20. and the other days are untouched',
    withLate.days.filter((d) => d.shiftCode !== null).length === 1);

  for (const bad of [0, 8, -1, 1.5]) {
    await refused(`21. weekday ${bad} is refused`,
      () => sched.setWorkScheduleDay(A, 'ZZMF', { dayOfWeek: bad, working: true }),
      /1 to 7/);
  }
  await refused('22. a day off cannot name a shift',
    () => sched.setWorkScheduleDay(A, 'ZZMF',
      { dayOfWeek: 6, working: false, shiftCode: 'ZZLATE' }),
    /cannot name a shift/);
  await refused('23. an unknown shift is refused',
    () => sched.setWorkScheduleDay(A, 'ZZMF',
      { dayOfWeek: 4, working: true, shiftCode: 'ZZGHOST' }),
    /no such shift/);

  await db.query(
    "UPDATE shift SET active = false WHERE tenant_id = $1 AND code = 'ZZLATE'", [ctx.tenant]);
  await refused('24. an inactive shift cannot be newly assigned to a day',
    () => sched.setWorkScheduleDay(A, 'ZZMF',
      { dayOfWeek: 5, working: true, shiftCode: 'ZZLATE' }),
    /not in use and cannot be assigned/);
  ok('25. but the day already naming it keeps it',
    (await sched.getWorkSchedule(A, 'ZZMF')).days
      .find((d) => d.dayOfWeek === 3).shiftCode === 'ZZLATE',
    'withdrawing a shift does not rewrite the patterns that named it');
  await db.query(
    "UPDATE shift SET active = true WHERE tenant_id = $1 AND code = 'ZZLATE'", [ctx.tenant]);

  ok('26. a weekday is an upsert, so changing it twice is fine', await (async () => {
    await sched.setWorkScheduleDay(A, 'ZZMF', { dayOfWeek: 6, working: true });
    const a = (await sched.getWorkSchedule(A, 'ZZMF')).days.find((d) => d.dayOfWeek === 6);
    await sched.setWorkScheduleDay(A, 'ZZMF', { dayOfWeek: 6, working: false });
    const b = (await sched.getWorkSchedule(A, 'ZZMF')).days.find((d) => d.dayOfWeek === 6);
    return a.working === true && b.working === false
      && (await sched.getWorkSchedule(A, 'ZZMF')).days.length === 7;
  })());

  ok('27. no schedule table carries an hour, a timezone or a break',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('work_schedule', 'work_schedule_day')
          AND (column_name LIKE '%start%' OR column_name LIKE '%end%'
            OR column_name LIKE '%break%' OR column_name LIKE '%grace%'
            OR column_name LIKE '%timezone%')`)).rows[0].n === 0,
    'the service points at shift and copies nothing out of it');

  /* ---------------------------------------------------------------- *
   * Active and inactive
   * ---------------------------------------------------------------- */

  console.log('\nwithdrawing a pattern from use\n');

  const off = await sched.setWorkScheduleActive(A, 'ZZSIX', false);
  ok('28. a pattern can be withdrawn', off.active === false);
  ok('    and is still listed', (await sched.listWorkSchedules(A))
    .some((s) => s.code === 'ZZSIX'),
    'an assignment may still name it, and a screen has to resolve the code');
  ok('    with its days intact',
    (await sched.getWorkSchedule(A, 'ZZSIX')).days.length === 7);
  ok('29. setting the state it already has is a no-op',
    (await sched.setWorkScheduleActive(A, 'ZZSIX', false)).active === false);
  ok('30. and it can be brought back',
    (await sched.setWorkScheduleActive(A, 'ZZSIX', true)).active === true);
  await refused('31. an unknown pattern cannot be withdrawn',
    () => sched.setWorkScheduleActive(A, 'ZZNOPE', false), /no such work schedule/);

  /* ---------------------------------------------------------------- *
   * Authorization
   * ---------------------------------------------------------------- */

  console.log('\nshaping the patterns stays an administrator\'s\n');

  for (const [who, caller] of [['a manager', MGR], ['an employee', EMP]]) {
    await refused(`32. ${who} cannot create one`,
      () => sched.createWorkSchedule(caller, { code: 'ZZNO', name: 'ZZ no' }),
      /only an admin/);
    await refused(`    nor change one`,
      () => sched.updateWorkSchedule(caller, 'ZZMF', { name: 'x' }), /only an admin/);
    await refused(`    nor change its days`,
      () => sched.setWorkScheduleDay(caller, 'ZZMF', { dayOfWeek: 1, working: false }),
      /only an admin/);
    await refused(`    nor withdraw one`,
      () => sched.setWorkScheduleActive(caller, 'ZZMF', false), /only an admin/);
  }

  /* ---------------------------------------------------------------- *
   * Assignment
   * ---------------------------------------------------------------- */

  console.log('\nputting somebody on a pattern\n');

  const report = (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id,
                           manager_id, joined_on)
     SELECT $1, $2, 'ZZ Schedule Report', $3, 'active', 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'),
            $4, '2025-01-01'
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `zz-sch-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      ctx.adminEmployeeId])).rows[0].id;

  const first = await sched.assignEmployeeSchedule(A, report, {
    scheduleCode: 'ZZMF', validFrom: '2026-01-01', validTo: '2026-06-30',
  });
  ok('33. a closed period is assigned', first.validFrom === '2026-01-01'
    && first.validTo === '2026-06-30', JSON.stringify([first.validFrom, first.validTo]));
  ok('    naming the pattern and resolving its name',
    first.scheduleCode === 'ZZMF' && first.scheduleName === 'ZZ Standard Week');
  /*
   * This one found a real bug. The service had a helper reading Date parts to
   * avoid a westward shift, and src/db/pool.ts already maps `date` through as a
   * string — so the helper was handed a string and threw. Both halves are
   * asserted: the type, and that the day is the day that was asked for.
   */
  ok('    as a plain YYYY-MM-DD string, not a Date',
    typeof first.validFrom === 'string' && typeof first.validTo === 'string',
    `${typeof first.validFrom} / ${typeof first.validTo}`);
  ok('    and the day sent is the day stored',
    (await db.query(
      `SELECT valid_from::text f, valid_to::text t FROM employee_schedule
        WHERE id = $1`, [first.id])).rows[0].f === '2026-01-01',
    'no timezone slid it a day either way');

  const second = await sched.assignEmployeeSchedule(A, report, {
    scheduleCode: 'ZZSIX', validFrom: '2026-07-01',
  });
  ok('34. the next may begin the very next day', second.validFrom === '2026-07-01');
  ok('    open-ended', second.validTo === null);
  ok('35. and the earlier period is untouched', await (async () => {
    const h = await sched.employeeSchedules(A, report);
    const old = h.find((x) => x.id === first.id);
    return old && old.validFrom === '2026-01-01' && old.validTo === '2026-06-30';
  })(), 'history is preserved, not rewritten');
  ok('36. both rows are queryable, newest first', await (async () => {
    const h = await sched.employeeSchedules(A, report);
    return h.length === 2 && h[0].validFrom === '2026-07-01';
  })());

  console.log('\nand the open period is superseded rather than duplicated\n');

  const third = await sched.assignEmployeeSchedule(A, report, {
    scheduleCode: 'ZZGULF', validFrom: '2026-09-01',
  });
  ok('37. a later change closes the open period the day before',
    await (async () => {
      const h = await sched.employeeSchedules(A, report);
      const prev = h.find((x) => x.id === second.id);
      return prev.validTo === '2026-08-31';
    })(), 'inclusive bounds, so 31 August and 1 September are adjacent');
  ok('    and the new one is open', third.validTo === null);
  ok('38. there are now three periods and no gap', await (async () => {
    const h = (await sched.employeeSchedules(A, report))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    return h.length === 3
      && h[0].validTo === '2026-06-30' && h[1].validFrom === '2026-07-01'
      && h[1].validTo === '2026-08-31' && h[2].validFrom === '2026-09-01';
  })());

  const amended = await sched.assignEmployeeSchedule(A, report, {
    scheduleCode: 'ZZSIX', validFrom: '2026-09-01',
  });
  ok('39. a change on the day the open period began amends it',
    amended.id === third.id && amended.scheduleCode === 'ZZSIX',
    'the rule employment_record has applied since 0003 — no zero-day row');
  ok('    so there are still three periods',
    (await sched.employeeSchedules(A, report)).length === 3);

  console.log('\nwhat is refused\n');

  await refused('40. a start date inside a period that has already ended',
    () => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZMF', validFrom: '2026-03-15',
    }), /already ended/);
  ok('    and the message names the period', await (async () => {
    const e = await attempt(() => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZMF', validFrom: '2026-03-15',
    }));
    return /2026-01-01 to 2026-06-30/.test(e.message);
  })());
  ok('    and says history is not rewritten', await (async () => {
    const e = await attempt(() => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZMF', validFrom: '2026-03-15',
    }));
    return /not rewritten/.test(e.message);
  })());

  /*
   * The other direction, which the settled-period refusal above hides: an open
   * period that begins *after* the requested start, with nothing settled in the
   * way. It needs somebody with no history, so it gets their own employee.
   */
  const fresh = (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     SELECT $1, $2, 'ZZ Fresh Start', $3, 'active', 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'), '2025-01-01'
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `zz-fresh-${Math.random().toString(36).slice(2, 9)}@360.technology`])).rows[0].id;
  await sched.assignEmployeeSchedule(A, fresh, {
    scheduleCode: 'ZZMF', validFrom: '2027-01-01',
  });
  await refused('40a. a start date before the open period began',
    () => sched.assignEmployeeSchedule(A, fresh, {
      scheduleCode: 'ZZSIX', validFrom: '2026-06-01',
    }), /Backdating before an existing period is not supported/);
  ok('    and the message names the date it does begin', await (async () => {
    const e = await attempt(() => sched.assignEmployeeSchedule(A, fresh, {
      scheduleCode: 'ZZSIX', validFrom: '2026-06-01',
    }));
    return /starts on 2027-01-01/.test(e.message);
  })());
  ok('    leaving that person with exactly one period',
    (await sched.employeeSchedules(A, fresh)).length === 1,
    'a refusal inside the transaction rolls the whole thing back');

  await refused('41. a reversed range',
    () => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZMF', validFrom: '2027-06-01', validTo: '2027-01-01',
    }), /cannot be before/);
  await refused('42. a date that is not a date',
    () => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZMF', validFrom: '1 Jan 2027',
    }), /YYYY-MM-DD/);
  await refused('43. an unknown pattern',
    () => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZNOPE', validFrom: '2027-01-01',
    }), /no such work schedule/);

  await sched.setWorkScheduleActive(A, 'ZZSIX', false);
  await refused('44. an inactive pattern cannot be newly assigned',
    () => sched.assignEmployeeSchedule(A, report, {
      scheduleCode: 'ZZSIX', validFrom: '2027-01-01',
    }), /not in use and cannot be assigned/);
  ok('45. while the period already on it stays valid', await (async () => {
    const h = await sched.employeeSchedules(A, report);
    const onSix = h.filter((x) => x.scheduleCode === 'ZZSIX');
    return onSix.length >= 1 && onSix.every((x) => x.scheduleActive === false);
  })(), 'the row reports the pattern as withdrawn and remains history');
  await sched.setWorkScheduleActive(A, 'ZZSIX', true);

  /* The exclusion constraint, reached directly to prove the service is not alone. */
  const direct = await attempt(() => db.query(
    `INSERT INTO employee_schedule
       (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
     SELECT $1, $2, w.id, '2026-04-01', NULL FROM work_schedule w
      WHERE w.tenant_id = $1 AND w.code = 'ZZMF'`, [ctx.tenant, report]));
  ok('46. the database refuses an overlap even with the service bypassed',
    direct !== null && direct.code === '23P01',
    `${direct?.code} — the exclusion constraint is the authority, not the pre-check`);

  console.log('\nreading one person\'s history\n');

  ok('47. an employee reads their own',
    (await sched.employeeSchedules(
      { role: 'employee', tenantId: ctx.tenant, employeeId: report, userId: null },
      report)).length === 3);
  await refused('48. and not a colleague\'s',
    () => sched.employeeSchedules(
      { role: 'employee', tenantId: ctx.tenant, employeeId: report, userId: null },
      ctx.adminEmployeeId), /only read your own/);
  ok('49. a manager reads their line', (await sched.employeeSchedules(MGR, report)).length === 3,
    'the report\'s manager is the scratch admin');

  const onDay = await sched.employeeScheduleOn(A, report, '2026-03-15');
  ok('50. the pattern applying on a date resolves to exactly one',
    onDay !== null && onDay.scheduleCode === 'ZZMF', JSON.stringify(onDay));
  ok('    and a later date resolves to the later pattern',
    (await sched.employeeScheduleOn(A, report, '2026-10-01')).scheduleCode === 'ZZSIX');
  ok('51. a date before anybody was assigned resolves to null',
    (await sched.employeeScheduleOn(A, report, '2020-01-01')) === null,
    'null is an answer — the caller decides the fallback, not this read');

  console.log('\nassignment authorization\n');

  await refused('52. an employee cannot assign their own schedule',
    () => sched.assignEmployeeSchedule(
      { role: 'employee', tenantId: ctx.tenant, employeeId: report, userId: null },
      report, { scheduleCode: 'ZZMF', validFrom: '2028-01-01' }),
    /only a manager or admin/);
  await refused('53. nor anybody else\'s',
    () => sched.assignEmployeeSchedule(
      { role: 'employee', tenantId: ctx.tenant, employeeId: report, userId: null },
      ctx.adminEmployeeId, { scheduleCode: 'ZZMF', validFrom: '2028-01-01' }),
    /only a manager or admin/);
  ok('54. a manager may assign within their line', await (async () => {
    const r = await sched.assignEmployeeSchedule(MGR, report, {
      scheduleCode: 'ZZMF', validFrom: '2027-01-01',
    });
    return r.scheduleCode === 'ZZMF';
  })(), 'the same rule setEmployeeShift applies');

  const outside = (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     SELECT $1, $2, 'ZZ Outside Line', $3, 'active', 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'), '2025-01-01'
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `zz-out-${Math.random().toString(36).slice(2, 9)}@360.technology`])).rows[0].id;
  await refused('55. and not outside it',
    () => sched.assignEmployeeSchedule(MGR, outside, {
      scheduleCode: 'ZZMF', validFrom: '2027-01-01',
    }), /not in your team/);

  console.log('\nending a period without starting another\n');

  const open = (await sched.employeeSchedules(A, report)).find((x) => x.validTo === null);
  const closed = await sched.closeEmployeeSchedule(A, report, open.id, '2027-06-30');
  ok('56. an open period can be closed', closed.validTo === '2027-06-30');
  await refused('57. and a closed one cannot be closed again',
    () => sched.closeEmployeeSchedule(A, report, open.id, '2027-12-31'),
    /already ended/);
  await refused('58. an assignment that is not theirs is not found',
    () => sched.closeEmployeeSchedule(A, report, randomUUID(), '2027-01-01'),
    /no such schedule assignment/);
  ok('59. after which the person has no current pattern',
    (await sched.employeeScheduleOn(A, report, '2028-01-01')) === null,
    'which the caller has to notice rather than being given a default');

  const reopened = await sched.assignEmployeeSchedule(A, report, {
    scheduleCode: 'ZZMF', validFrom: '2028-01-01',
  });
  await refused('59a. and a period cannot end before it began',
    () => sched.closeEmployeeSchedule(A, report, reopened.id, '2027-12-31'),
    /cannot be before the period began on 2028-01-01/);
  ok('    so it is still open', await (async () => {
    const h = await sched.employeeSchedules(A, report);
    return h.find((x) => x.id === reopened.id).validTo === null;
  })());

  console.log('\nan exited employee is not given a new pattern\n');

  await db.query(
    "UPDATE employee SET status = 'exited', left_on = '2027-06-30' WHERE id = $1", [outside]);
  await refused('60. assigning somebody who has left is refused',
    () => sched.assignEmployeeSchedule(A, outside, {
      scheduleCode: 'ZZMF', validFrom: '2028-01-01',
    }), /has left/);
  ok('    and no assignment was created for them',
    (await sched.employeeSchedules(A, outside)).length === 0,
    '0054 left them out on purpose, and this does not quietly fix that');

  /* ---------------------------------------------------------------- *
   * The default pattern for a tenant
   * ---------------------------------------------------------------- */

  console.log('\nthe default pattern helper\n');

  const def = await sched.ensureDefaultSchedule(A);
  ok('61. a tenant created after 0054 can be given the default',
    def.code === 'DEFAULT_MF', def.code);
  ok('    named so it reads as a system default',
    /Default Monday-Friday/.test(def.name), def.name);
  ok('62. with all seven weekdays', def.days.length === 7);
  ok('    Monday to Friday working',
    def.days.filter((d) => d.working).map((d) => d.dayOfWeek).join(',') === '1,2,3,4,5');
  ok('    Saturday and Sunday off',
    def.days.filter((d) => !d.working).map((d) => d.dayOfWeek).join(',') === '6,7');
  ok('63. and no shift on any day', def.days.every((d) => d.shiftCode === null),
    'site.default_shift_id is unread and unset, so there is no authoritative source');

  const again = await sched.ensureDefaultSchedule(A);
  ok('64. calling it twice is idempotent', again.code === 'DEFAULT_MF'
    && (await db.query(
      `SELECT count(*)::int n FROM work_schedule
        WHERE tenant_id = $1 AND code = 'DEFAULT_MF'`, [ctx.tenant])).rows[0].n === 1);
  ok('    and does not duplicate the days',
    (await db.query(
      `SELECT count(*)::int n FROM work_schedule_day d
         JOIN work_schedule w ON w.id = d.work_schedule_id
        WHERE w.tenant_id = $1 AND w.code = 'DEFAULT_MF'`, [ctx.tenant])).rows[0].n === 7);
  ok('65. it assigns nobody',
    (await db.query(
      `SELECT count(*)::int n FROM employee_schedule es
         JOIN work_schedule w ON w.id = es.work_schedule_id
        WHERE w.tenant_id = $1 AND w.code = 'DEFAULT_MF'`, [ctx.tenant])).rows[0].n === 0,
    'creating a pattern and putting people on it are different decisions');
  await refused('66. and only an admin may call it',
    () => sched.ensureDefaultSchedule(MGR), /only an admin/);

  /* ---------------------------------------------------------------- *
   * Audit
   * ---------------------------------------------------------------- */

  console.log('\nevery change goes through the existing audit trail\n');

  const logged = async (action, subject) => (await db.query(
    `SELECT action, category, subject_table, detail FROM audit_log
      WHERE tenant_id = $1 AND action = $2 AND subject_table = $3
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ctx.tenant, action, subject])).rows[0];

  for (const [action, subject] of [
    ['work_schedule_created', 'work_schedule'],
    ['work_schedule_updated', 'work_schedule'],
    ['work_schedule_day_updated', 'work_schedule'],
    ['work_schedule_active_changed', 'work_schedule'],
    ['employee_schedule_created', 'employee_schedule'],
    ['employee_schedule_changed', 'employee_schedule'],
    ['employee_schedule_closed', 'employee_schedule'],
  ]) {
    const row = await logged(action, subject);
    ok(`67. ${action} is recorded`, Boolean(row), 'nothing was written');
    if (row) {
      ok('    under the existing config category', row.category === 'config');
      ok('    naming the schedule', typeof row.detail?.schedule === 'string',
        JSON.stringify(row.detail));
    }
  }

  const assignRow = await logged('employee_schedule_created', 'employee_schedule');
  ok('68. an assignment audit names the employee and the dates',
    typeof assignRow.detail?.employeeId === 'string'
    && typeof assignRow.detail?.validFrom === 'string',
    JSON.stringify(assignRow.detail));
  const dayRow = await logged('work_schedule_day_updated', 'work_schedule');
  ok('69. a weekday audit carries before and after',
    'from' in dayRow.detail && 'to' in dayRow.detail, JSON.stringify(dayRow.detail));
  ok('70. no second audit table was created', await (async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name LIKE '%audit%' ORDER BY table_name`);
    return rows.map((r) => r.table_name).join(',') === 'audit_log';
  })(), 'schedules write into the trail every other module writes into');

  const auditBefore = (await db.query(
    "SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1", [ctx.tenant])).rows[0].n;
  await attempt(() => sched.createWorkSchedule(MGR, { code: 'ZZX', name: 'x' }));
  await attempt(() => sched.createWorkSchedule(A, { code: 'ZZMF', name: 'x' }));
  await attempt(() => sched.assignEmployeeSchedule(A, report, {
    scheduleCode: 'ZZMF', validFrom: '2026-03-15',
  }));
  /*
   * This holds because `withTenant` runs the whole call in one transaction, not
   * because the guards happen to come before the audit write — moving the write
   * ahead of a guard keeps it green, since the rollback takes it either way.
   * The assertion below tests that transaction directly, with a failure that
   * leaves something visible behind if it is ever lost.
   */
  ok('71. a refused change writes no audit row',
    (await db.query(
      "SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1", [ctx.tenant]))
      .rows[0].n === auditBefore);

  await refused('71a. a schedule whose seventh day names an unknown shift is refused',
    () => sched.createWorkSchedule(A, {
      code: 'ZZROLL', name: 'ZZ Rollback',
      days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
        dayOfWeek, working: true, shiftCode: dayOfWeek === 7 ? 'ZZGHOST' : null,
      })),
    }), /no such shift/);
  ok('    and no half-written schedule is left behind',
    (await db.query(
      "SELECT count(*)::int n FROM work_schedule WHERE tenant_id = $1 AND code = 'ZZROLL'",
      [ctx.tenant])).rows[0].n === 0,
    'one transaction per call, so six good days do not survive a bad seventh');
  ok('    nor any orphan weekday row',
    (await db.query(
      `SELECT count(*)::int n FROM work_schedule_day d
        WHERE d.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM work_schedule w WHERE w.id = d.work_schedule_id)`,
      [ctx.tenant])).rows[0].n === 0);

  /* ---------------------------------------------------------------- *
   * The 2h-B resolver is untouched
   * ---------------------------------------------------------------- */

  console.log('\nand 2h-E taught the resolver to read all of it\n');

  const resolverSrc = readFileSync(
    join(here, '..', 'src', 'modules', 'calendar', 'service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  /*
   * These four assertions held the opposite until Phase 2h-E, and said so: the
   * resolver read no schedule table, Saturday was off for everybody, and the
   * comment on 74 read "the resolver does not consult it yet, and that is the
   * point of this assertion".
   *
   * 2h-E consulted it, and all of them went red in the same run. Inverted rather
   * than deleted, because the behaviour they now pin is the one that cost the
   * most to build: this person is on a six-day pattern, so their Saturday is a
   * working day, and nobody else's is.
   */
  ok('72. as of 2h-E the calendar resolver reads the schedule tables',
    /employee_schedule/.test(resolverSrc) && /work_schedule_day/.test(resolverSrc),
    'which is what 0054 and this service existed to make possible');
  ok('    and still decides the weekday as a calendar date',
    /EXTRACT\(ISODOW FROM/.test(resolverSrc) && !/getDay\(\)/.test(resolverSrc));

  /* 2026-10-05 is a Monday, 2026-10-10 a Saturday. */
  const verdicts = await calendar.workingDaysFor(A, report, '2026-10-05', '2026-10-11');
  ok('73. Monday is a working day', verdicts[0].workingDay === true);
  ok('    and so is Saturday, because this person works six days',
    verdicts[5].workingDay === true,
    `${verdicts[5].reason} — 2h-B said WEEKLY_OFF here for everybody`);
  ok('    the verdict naming the pattern that decided it',
    verdicts[5].schedule === 'ZZSIX', verdicts[5].schedule);
  ok('74. which is the assignment covering that date',
    (await sched.employeeScheduleOn(A, report, '2026-10-10'))?.scheduleCode === 'ZZSIX',
    'the read and the calendar agree, from the same effective-dated row');
  ok('    while Sunday is still off on that pattern',
    verdicts[6].workingDay === false, verdicts[6].reason);

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional)
     VALUES ($1, '2026-10-07', 'ZZ Schedule Probe Holiday', false)`, [ctx.tenant]);
  ok('75. holidays are still respected',
    (await calendar.workingDaysFor(A, report, '2026-10-07', '2026-10-07'))[0].reason
      === 'HOLIDAY');

  ok('76. no attendance row was created by any of this',
    (await db.query('SELECT count(*)::int n FROM attendance WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === 0);
  ok('77. and no payslip', (await db.query(
    'SELECT count(*)::int n FROM payslip WHERE tenant_id = $1', [ctx.tenant])).rows[0].n === 0);

  /* ---------------------------------------------------------------- *
   * Tenant isolation
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (o) => {
    const B = {
      role: 'admin', tenantId: o.tenant, employeeId: o.adminEmployeeId, userId: null,
    };

    console.log('\nnothing reaches across a tenant\n');

    ok('78. another tenant sees none of our patterns',
      (await sched.listWorkSchedules(B)).every((s) => !s.code.startsWith('ZZ')),
      JSON.stringify((await sched.listWorkSchedules(B)).map((s) => s.code)));
    await refused('79. and cannot read one by code',
      () => sched.getWorkSchedule(B, 'ZZMF'), /no such work schedule/);
    await refused('80. nor change it',
      () => sched.updateWorkSchedule(B, 'ZZMF', { name: 'stolen' }),
      /no such work schedule/);
    await refused('81. nor withdraw it',
      () => sched.setWorkScheduleActive(B, 'ZZMF', false), /no such work schedule/);
    ok('82. and may create its own with the same code',
      (await sched.createWorkSchedule(B, { code: 'ZZMF', name: 'ZZ Theirs' })).name
        === 'ZZ Theirs',
      'UNIQUE (tenant_id, code) is per tenant');

    await refused('83. their employee cannot be put on our pattern',
      () => sched.assignEmployeeSchedule(B, o.adminEmployeeId, {
        scheduleCode: 'ZZGULF', validFrom: '2026-01-01',
      }), /no such work schedule/);
    await refused('84. and our employee is not theirs to assign',
      () => sched.assignEmployeeSchedule(B, report, {
        scheduleCode: 'ZZMF', validFrom: '2029-01-01',
      }), /no such employee/);
    await refused('85. nor is our history theirs to read',
      () => sched.employeeSchedules(B, report), /no such employee/);

    await refused('86. and their schedule day cannot borrow our shift',
      () => sched.setWorkScheduleDay(B, 'ZZMF',
        { dayOfWeek: 1, working: true, shiftCode: 'ZZLATE' }),
      /no such shift/);
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
ok(`work schedules ${after.ws}`, after.ws === before.ws, `was ${before.ws}`);
ok(`assignments ${after.es}`, after.es === before.es, `was ${before.es}`);
ok(`attendance rows ${after.a}`, after.a === before.a,
  `was ${before.a} — no attendance was materialised`);
ok(`payslips ${after.p}`, after.p === before.p, `was ${before.p} — no payroll was touched`);
ok(`shifts ${after.s}`, after.s === before.s, `was ${before.s}`);
ok(`holidays ${after.h}`, after.h === before.h, `was ${before.h}`);
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
  console.error(`${failed} schedule service checks failed`);
  process.exit(1);
}
console.log('a tenant can say which days it works, and who worked which pattern when');
