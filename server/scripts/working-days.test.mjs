/**
 * How many days of leave is this, and who decides?
 *
 * Until this phase the browser decided. `src/modules/leave/index.tsx` counted the
 * days with `if (isWeekend(d) || HOLIDAY_MAP[ymd(d)]) excluded++`, sent the number,
 * and `applyForLeave` stored it after checking only `days > 0`. So a request naming
 * two dates could claim a hundred days, and approval would debit a hundred from the
 * balance. That is the hole assertion 20 closes.
 *
 * The weekend rule was hard-coded in three places and the holiday list was a 2026
 * Tamil Nadu calendar compiled into the bundle, while the `holiday` table — the one
 * thing a tenant can actually edit — took no part in any of it.
 *
 * ## What this suite holds
 *
 * **The resolver is the only answer.** Monday to Friday working, Saturday and
 * Sunday off — the same rule the product already applied, written down once. No
 * schedule table exists yet and this phase deliberately does not add one, so the
 * rule is unchanged; what changes is that there is one copy of it, on the server.
 *
 * **Optional holidays stay working days.** `HOLIDAY_MAP` is built with
 * `if (!h.opt)`, the calendar screen labels the two kinds "Fixed" and "Optional",
 * the policy line reads "any 2 per calendar year", and `holiday_one_per_day` is a
 * unique index `WHERE optional = false`. Four places agree, so treating an optional
 * holiday as non-working would hand everybody free days and quietly shrink their
 * leave deduction.
 *
 * **A site holiday reaches only that site.** 0002 documents `holiday.site_id` as
 * "Null means the whole tenant; otherwise a location-specific holiday", and the
 * unique index keys on `COALESCE(site_id, …)` so one date can carry both. The
 * service had never read the column.
 *
 * **The weekday is decided in SQL.** `EXTRACT(ISODOW …)` over `generate_series`
 * treats the values as calendar dates. `new Date('2026-10-04').getDay()` is Sunday
 * in Chennai and Saturday in Los Angeles, and a leave count must not depend on
 * where the server runs.
 *
 * Nothing is materialised: no attendance row is written, no status is set.
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
  console.log('\nSKIPPED: no database, and the weekday is decided in SQL.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const calendar = await import('../src/modules/calendar/service.ts');
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
  ok(label, e !== null, 'the call succeeded — this is a hole, not a test failure');
  if (e) {
    ok('    refused in the service\'s own words',
      expect.test(e.message) || expect.test(e.code ?? ''), `${e.code ?? ''} ${e.message}`);
  }
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(`
  SELECT (SELECT count(*)::int FROM holiday) h,
         (SELECT count(*)::int FROM leave_request) lr,
         (SELECT count(*)::int FROM attendance) a,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM shift) s`)).rows[0];
const before = await census();

/*
 * Fixed dates, so a weekday assertion cannot depend on the day the suite runs.
 * 2026-10-05 is a Monday and 2026-10-11 a Sunday — verified by the ISODOW
 * assertions below rather than asserted from a comment.
 */
const MON = '2026-10-05';
const TUE = '2026-10-06';
const THU = '2026-10-08';
const FRI = '2026-10-09';
const SAT = '2026-10-10';
const SUN = '2026-10-11';
const NEXT_MON = '2026-10-12';

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * No migration: the holiday table is exactly what 0002 created
 * ------------------------------------------------------------------ */

console.log('\nthis phase added no schema\n');

{
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'holiday' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
  ok('1. holiday still has exactly its six columns',
    cols.join(',') === 'id,tenant_id,observed_on,name,optional,site_id', cols.join(','));

  /*
   * This asserted the schedule tables did not exist, which was true when 2h-B
   * shipped and is exactly what 2h-C then added. The assertion earned its keep by
   * failing the moment the schema arrived — so it was inverted rather than
   * deleted, to guard that the tables existed and this resolver did not yet read
   * them.
   *
   * It then earned its keep a second time, in exactly the same way: Phase 2h-E
   * taught the resolver to read them, and this assertion went red the moment it
   * did. Inverted again rather than deleted. What it now holds is the thing that
   * matters from here on — the resolver reads the schedule *and* still decides the
   * weekday as a calendar date, so neither half can be lost without this failing.
   */
  const scheduleTables = (await db.query(
    `SELECT count(*)::int n FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('work_schedule', 'work_schedule_day', 'employee_schedule')`
  )).rows[0].n;
  ok('2. the schedule tables exist, as of migration 0054', scheduleTables === 3,
    String(scheduleTables));

  /*
   * Comments stripped first. The resolver's own doc comment names `work_schedule`
   * to say what will change later, and matching that would pass this assertion on
   * prose — which is how three earlier checks in this repository fooled themselves.
   */
  const resolverSrc = readFileSync(
    join(here, '..', 'src', 'modules', 'calendar', 'service.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('    and as of 2h-E this resolver reads them',
    /employee_schedule/.test(resolverSrc) && /work_schedule_day/.test(resolverSrc),
    'the hard-coded week was the whole thing 0054 existed to replace');
  ok('    resolving the assignment covering each date, not the current one',
    /daterange\(es\.valid_from, es\.valid_to, '\[\]'\) @> span\.day/.test(resolverSrc),
    'reading the current assignment for a range silently rewrites history');
  ok('    while still deciding the weekday as a calendar date',
    /EXTRACT\(ISODOW FROM/.test(resolverSrc) && !/getDay\(\)/.test(resolverSrc),
    'the timezone property 2h-B established survives the schedule join');
  ok('    and keeping Monday-to-Friday only as the no-assignment fallback',
    /Number\(r\.isodow\) <= 5/.test(resolverSrc),
    'nobody is assigned a schedule on creation, so the fallback is load-bearing');

  const idx = (await db.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'holiday_one_per_day'")).rows[0];
  ok('3. the one-per-day index still keys on the site and excludes optional rows',
    /COALESCE\(site_id/.test(idx?.indexdef ?? '') && /optional = false/.test(idx?.indexdef ?? ''),
    idx?.indexdef);
}

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const EMP = {
    role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };

  const verdict = async (date) => {
    const [v] = await calendar.workingDaysFor(A, ctx.adminEmployeeId, date, date);
    return v;
  };
  const count = async (from, to) =>
    (await calendar.workingDaysFor(A, ctx.adminEmployeeId, from, to))
      .filter((d) => d.workingDay).length;

  /* ---------------------------------------------------------------- *
   * The weekday, decided in SQL
   * ---------------------------------------------------------------- */

  console.log('\nMonday to Friday is working; Saturday and Sunday are not\n');

  ok('4. Monday is a working day', (await verdict(MON)).workingDay === true);
  ok('    reported as WORKING', (await verdict(MON)).reason === 'WORKING');
  ok('5. Tuesday is a working day', (await verdict(TUE)).workingDay === true);
  ok('6. Thursday is a working day', (await verdict(THU)).workingDay === true);
  ok('7. Friday is a working day', (await verdict(FRI)).workingDay === true);
  ok('8. Saturday is not', (await verdict(SAT)).workingDay === false);
  ok('    reported as WEEKLY_OFF', (await verdict(SAT)).reason === 'WEEKLY_OFF');
  ok('9. Sunday is not', (await verdict(SUN)).workingDay === false);
  ok('    reported as WEEKLY_OFF', (await verdict(SUN)).reason === 'WEEKLY_OFF');
  ok('10. a verdict carries the date it is about', (await verdict(MON)).date === MON);

  console.log('\na range counts only the working days in it\n');

  ok('11. Monday to Friday is five', (await count(MON, FRI)) === 5,
    String(await count(MON, FRI)));
  ok('12. Saturday to Sunday is none', (await count(SAT, SUN)) === 0,
    String(await count(SAT, SUN)));
  ok('13. Friday to Monday is two', (await count(FRI, NEXT_MON)) === 2,
    String(await count(FRI, NEXT_MON)));
  ok('14. Monday to the next Monday is six', (await count(MON, NEXT_MON)) === 6,
    String(await count(MON, NEXT_MON)));
  ok('15. one Monday is one', (await count(MON, MON)) === 1);
  ok('    and the range is inclusive at both ends',
    (await calendar.workingDaysFor(A, ctx.adminEmployeeId, MON, NEXT_MON)).length === 8);

  await refused('16. a reversed range is refused',
    () => calendar.workingDaysFor(A, ctx.adminEmployeeId, FRI, MON),
    /cannot be before/);
  await refused('    and so is a date that is not a date',
    () => calendar.workingDaysFor(A, ctx.adminEmployeeId, '5 Oct', MON), /YYYY-MM-DD/);

  /* ---------------------------------------------------------------- *
   * Holidays, from the table
   * ---------------------------------------------------------------- */

  console.log('\na mandatory holiday closes the office; an optional one does not\n');

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional)
     VALUES ($1, $2, 'ZZ Tenant Holiday', false)`, [ctx.tenant, TUE]);

  const tue = await verdict(TUE);
  ok('17. a tenant-wide holiday is not a working day', tue.workingDay === false);
  ok('    reported as HOLIDAY', tue.reason === 'HOLIDAY', tue.reason);
  ok('    and names itself', tue.holiday === 'ZZ Tenant Holiday', String(tue.holiday));
  ok('18. the week it falls in loses a day', (await count(MON, FRI)) === 4,
    String(await count(MON, FRI)));
  ok('19. a normal weekday beside it is still working',
    (await verdict(THU)).workingDay === true);

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional)
     VALUES ($1, $2, 'ZZ Optional Holiday', true)`, [ctx.tenant, THU]);

  const thu = await verdict(THU);
  ok('20. an optional holiday is still a working day', thu.workingDay === true,
    'the product treats these as days an employee may choose to take as leave');
  ok('    reported as WORKING', thu.reason === 'WORKING', thu.reason);
  ok('21. and the week count is unchanged by it', (await count(MON, FRI)) === 4,
    String(await count(MON, FRI)));

  /* A holiday landing on a Saturday changes nothing, and says so honestly. */
  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional)
     VALUES ($1, $2, 'ZZ Saturday Holiday', false)`, [ctx.tenant, SAT]);
  ok('22. a holiday on a Saturday is still the week off it already was',
    (await verdict(SAT)).reason === 'WEEKLY_OFF');
  ok('    and does not double-count', (await count(MON, SUN)) === 4,
    String(await count(MON, SUN)));

  /* ---------------------------------------------------------------- *
   * Site-specific holidays
   * ---------------------------------------------------------------- */

  console.log('\na site holiday reaches that site and no other\n');

  const otherSite = (await db.query(
    `INSERT INTO site (tenant_id, code, name, country, timezone, active)
     VALUES ($1, 'ZZOTHER', 'ZZ Other Site', 'IN', 'Asia/Kolkata', true)
     RETURNING id`, [ctx.tenant])).rows[0].id;
  const ourSite = (await db.query(
    'SELECT site_id FROM employee WHERE id = $1', [ctx.adminEmployeeId])).rows[0].site_id;
  ok('23. the probe employee has a site', Boolean(ourSite));
  ok('    and it is not the one just created', ourSite !== otherSite);

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional, site_id)
     VALUES ($1, $2, 'ZZ Other Site Only', false, $3)`, [ctx.tenant, FRI, otherSite]);
  ok('24. a holiday for another site does not close our day',
    (await verdict(FRI)).workingDay === true,
    '0002: "Null means the whole tenant; otherwise a location-specific holiday"');

  await db.query(
    `INSERT INTO holiday (tenant_id, observed_on, name, optional, site_id)
     VALUES ($1, $2, 'ZZ Our Site Only', false, $3)`, [ctx.tenant, NEXT_MON, ourSite]);
  const ourDay = await verdict(NEXT_MON);
  ok('25. a holiday for our site does', ourDay.workingDay === false);
  ok('    and names itself', ourDay.holiday === 'ZZ Our Site Only', String(ourDay.holiday));

  /* ---------------------------------------------------------------- *
   * Who may read a calendar
   * ---------------------------------------------------------------- */

  console.log('\nreading a calendar\n');

  ok('26. an employee reads their own',
    (await calendar.workingDaysFor(EMP, ctx.adminEmployeeId, MON, MON)).length === 1);
  await refused('27. an id that is not an employee here is not found',
    () => calendar.workingDaysFor(
      A, '00000000-0000-0000-0000-0000000000ff', MON, MON),
    /no such employee/);
  /* The role rule itself is asserted below, once there is a real second person. */

  /* ---------------------------------------------------------------- *
   * Leave: the server's count, not the caller's
   * ---------------------------------------------------------------- */

  console.log('\nthe stored leave day count is the server\'s\n');

  const apply = (over) => leave.applyForLeave(A, {
    employeeId: ctx.adminEmployeeId, typeCode: ctx.leaveType, reason: 'ZZ probe', ...over,
  });

  const week = await apply({ startsOn: MON, endsOn: FRI });
  ok('28. Monday to Friday with one holiday in it stores four days',
    Number(week.days) === 4, String(week.days));
  ok('    and lands pending', week.status === 'Pending');

  /*
   * A second person, because an admin cannot approve their own leave — a rule that
   * predates this phase — and the debit is the half of the security case that
   * matters. Their leave is what gets approved and cancelled below.
   */
  const reportId = (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id,
                           manager_id, joined_on)
     SELECT $1, $2, 'ZZ Calendar Report', $3, 'active', 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT site_id FROM employee WHERE id = $4),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT shift_id FROM employee WHERE id = $4),
            $4, '2026-01-01'
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `zz-cal-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      ctx.adminEmployeeId])).rows[0].id;
  await db.query(
    `INSERT INTO leave_balance (tenant_id, employee_id, leave_type_id, year_start, quota)
     SELECT $1, $2, t.id, '2026-04-01', 24 FROM leave_type t
      WHERE t.tenant_id = $1 AND t.code = $3`, [ctx.tenant, reportId, ctx.leaveType]);

  /*
   * The security case. Two dates, a hundred days claimed. The stored figure has to
   * be the calendar's, or approval would debit a hundred days from the balance.
   */
  const tampered = await leave.applyForLeave(A, {
    employeeId: reportId, typeCode: ctx.leaveType, reason: 'ZZ tampered',
    startsOn: '2026-10-19', endsOn: '2026-10-20', days: 100,
  });
  ok('29. a request claiming 100 days over two dates stores two',
    Number(tampered.days) === 2, `stored ${tampered.days}`);
  ok('    which is what the database holds, not just what came back',
    Number((await db.query(
      'SELECT days FROM leave_request WHERE id = $1', [tampered.id])).rows[0].days) === 2);

  const alsoTampered = await apply({ startsOn: '2026-10-26', endsOn: '2026-10-26', days: 0.5 });
  ok('30. a whole day claimed as half still stores one',
    Number(alsoTampered.days) === 1, String(alsoTampered.days));

  const negative = await apply({ startsOn: '2026-11-02', endsOn: '2026-11-03', days: -5 });
  ok('31. a negative claim cannot shrink a request either',
    Number(negative.days) === 2, String(negative.days));

  /* The role rule, now that there is a real second person to ask about. */
  await refused('32. an employee cannot read a colleague\'s calendar',
    () => calendar.workingDaysFor(
      { role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null },
      reportId, MON, MON),
    /only read your own/);
  ok('33. but a manager may read their own line',
    (await calendar.workingDaysFor(
      { role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null },
      reportId, MON, MON)).length === 1,
    'the report\'s manager is the scratch admin');

  console.log('\nhalf days keep their meaning\n');

  const half = await apply({
    startsOn: '2026-11-09', endsOn: '2026-11-09', half: 'First Half',
  });
  ok('32. a half day on a working day stores 0.5', Number(half.days) === 0.5,
    String(half.days));
  ok('    and keeps which half', half.half === 'First Half', String(half.half));

  const second = await apply({
    startsOn: '2026-11-10', endsOn: '2026-11-10', half: 'Second Half',
  });
  ok('33. the second half is preserved too', second.half === 'Second Half'
    && Number(second.days) === 0.5);

  await refused('34. half of a range is refused',
    () => apply({ startsOn: '2026-11-16', endsOn: '2026-11-17', half: 'First Half' }),
    /a half day is a single day/);

  await refused('35. a half day on a Saturday is refused, not stored as 0.5',
    () => apply({ startsOn: SAT, endsOn: SAT, half: 'First Half' }),
    /no leave to take/);

  console.log('\na range with nothing in it is refused\n');

  await refused('36. a weekend-only request is refused',
    () => apply({ startsOn: '2026-11-21', endsOn: '2026-11-22' }), /all week off/);
  await refused('37. and so is a single Sunday',
    () => apply({ startsOn: SUN, endsOn: SUN }), /no leave to take/);
  ok('38. nothing was stored for either',
    Number((await db.query(
      `SELECT count(*)::int n FROM leave_request
        WHERE employee_id = $1 AND starts_on IN ('2026-11-21', $2)`,
      [ctx.adminEmployeeId, SUN])).rows[0].n) === 0);

  console.log('\nthe rules that were already there still hold\n');

  await refused('39. overlapping dates are still refused',
    () => apply({ startsOn: MON, endsOn: MON }), /already have/);
  await refused('40. an unknown leave type is still refused',
    () => apply({ startsOn: '2026-11-30', endsOn: '2026-11-30', typeCode: 'ZZNOPE' }),
    /no such leave type/);
  await refused('41. an employee still cannot apply for somebody else',
    () => leave.applyForLeave(
      { ...EMP, employeeId: ctx.adminEmployeeId },
      {
        employeeId: '00000000-0000-0000-0000-0000000000ff',
        typeCode: ctx.leaveType, startsOn: MON, endsOn: MON, reason: 'ZZ nope',
      }), /your own/);

  /* Approval still debits, and it debits the server's figure. */
  const usedNow = async () => Number((await db.query(
    `SELECT b.used::float8 AS used FROM leave_balance b
       JOIN leave_type t ON t.id = b.leave_type_id
      WHERE b.employee_id = $1 AND t.code = $2`,
    [reportId, ctx.leaveType])).rows[0]?.used ?? 0);
  const usedBefore = await usedNow();

  const approved = await leave.approveLeave(A, tampered.id);
  ok('42. approval still works', approved.status === 'Approved');
  ok('43. and debits the authoritative two days, not the claimed hundred',
    Number((await db.query(
      `SELECT sum(days)::float8 AS d FROM leave_ledger
        WHERE leave_request_id = $1`, [tampered.id])).rows[0].d) === -2,
    'the ledger is what a balance is rebuilt from');
  ok('    the balance moved by those same two days',
    (await usedNow()) - usedBefore === 2,
    `used went from ${usedBefore} to ${await usedNow()}`);

  const cancelled = await leave.cancelLeave(A, tampered.id);
  ok('44. cancellation still works', cancelled.status === 'Cancelled');
  ok('45. and credits back exactly what was debited',
    Number((await db.query(
      `SELECT sum(days)::float8 AS d FROM leave_ledger
        WHERE leave_request_id = $1`, [tampered.id])).rows[0].d) === 0,
    'two out and two back leaves nothing');

  /* ---------------------------------------------------------------- *
   * Nothing was materialised
   * ---------------------------------------------------------------- */

  console.log('\nno attendance was created by any of this\n');

  ok('46. the scratch tenant still has no attendance rows',
    (await db.query('SELECT count(*)::int n FROM attendance WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n === 0,
    'expected-day materialisation belongs to a later phase');
  ok('47. and no absent, week-off or holiday status was written anywhere',
    (await db.query(
      "SELECT count(*)::int n FROM attendance WHERE status IN ('A', 'O', 'H')"))
      .rows[0].n === 0);

  /* ---------------------------------------------------------------- *
   * Tenant isolation
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (other) => {
    const B = {
      role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
    };

    console.log('\nanother tenant\'s holidays are not ours\n');

    ok('48. our holiday does not close their Tuesday',
      (await calendar.workingDaysFor(B, other.adminEmployeeId, TUE, TUE))[0].workingDay === true,
      'row level security is the boundary');
    ok('49. and their count for the week is the full five',
      (await calendar.workingDaysFor(B, other.adminEmployeeId, MON, FRI))
        .filter((d) => d.workingDay).length === 5);
    await refused('50. and they cannot read our employee\'s calendar',
      () => calendar.workingDaysFor(B, ctx.adminEmployeeId, MON, MON), /no such employee/);
  });
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`holidays ${after.h}`, after.h === before.h, `was ${before.h}`);
ok(`leave requests ${after.lr}`, after.lr === before.lr, `was ${before.lr}`);
ok(`attendance rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok(`shifts ${after.s}`, after.s === before.s, `was ${before.s}`);
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
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
  console.error(`${failed} working-day checks failed`);
  process.exit(1);
}
console.log('the server decides how many days of leave a request is');
