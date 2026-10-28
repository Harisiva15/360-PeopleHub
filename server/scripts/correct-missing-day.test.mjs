/**
 * Correcting a day that was never recorded, and correcting one across a move.
 *
 * ## The day with no row
 *
 * `raiseRegularisation` read the attendance row and refused when there was
 * none: "no attendance record for that day". True, and useless — the whole
 * reason for the request is that nothing was recorded. Somebody who forgot a
 * day entirely, or whose punch was refused outside the shift window and so
 * left no row at all, had nothing to correct and no way to say so.
 *
 * `regularisableDays` had the matching hole on the read side. It selected
 * `FROM attendance`, so "days worth regularising" meant "rows worth
 * regularising", and the screen builds its date list from it — a day with no
 * row could not be chosen, and was refused if it was. Between them, the most
 * ordinary correction in the product was unreachable from either end.
 *
 * Both survived because **the demo does the opposite**: its
 * `raiseRegularisation` calls `ensure(empId, date, 'A')`, which creates the
 * row. So the screen worked against the demo and failed against the server,
 * which is the one divergence that hides a bug rather than revealing it.
 *
 * ## The hours get stored in the wrong zone across a move
 *
 * The regularisation's `requested_in` / `requested_out` were built with
 * `JOIN shift sh ON sh.id = e.shift_id` — the employee's *current* shift. Every
 * other read uses `COALESCE(a.shift_id, e.shift_id)`, the shift the day was
 * measured against. The two differ exactly when somebody has been moved since,
 * and then the correction takes the times a person typed while looking at a day
 * rendered in its own zone and stores them in the zone of a roster they are on
 * now. India to New York is a 10½ hour error, on the request meant to fix the
 * day. Assertions 9 to 11 are that case.
 */

import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a correction is a row in one.\n');
  process.exit(0);
}

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');
const {
  raiseRegularisation, regularisableDays, attendanceForDay, punchIn, punchOut,
  AttendanceError,
} = await import('../src/modules/attendance/service.ts');
const { setEmployeeShift } = await import('../src/modules/shifts/service.ts');
const { closePool } = await import('../src/db/pool.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();
await sweepScratchTenants(admin);

/* Mondays and Tuesdays in the past, so no assertion depends on the day it runs. */
const GONE = '2026-10-19';
const ALSO_GONE = '2026-10-20';

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const dept = (await admin.query(
      'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.dept])).rows[0].id;
    const site = (await admin.query(
      'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.site])).rows[0].id;
    const entity = (await admin.query(
      'SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1', [ctx.tenant])).rows[0].id;

    const shiftOf = async (code, starts, ends, tz) => (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          grace_minutes, break_minutes, region)
       VALUES ($1, $2, $2, $3::time, $4::time, $5, true, 10, 60, 'US') RETURNING id`,
      [ctx.tenant, code, starts, ends, tz])).rows[0].id;

    const inShift = (await admin.query(
      'SELECT id FROM shift WHERE tenant_id = $1 AND code = $2', [ctx.tenant, 'IN'])).rows[0].id;
    await shiftOf('ZZNY', '09:00', '18:00', 'America/New_York');

    let n = 0;
    const hire = async () => {
      n += 1;
      const code = `ZZC${n}`;
      return (await admin.query(
        `INSERT INTO employee
           (tenant_id, code, full_name, work_email, status, app_role, employment_type,
            department_id, site_id, legal_entity_id, shift_id, manager_id, joined_on,
            currency, ctc)
         VALUES ($1, $2, $2, $3::citext, 'active', 'employee', 'permanent',
                 $4, $5, $6, $7, $8, DATE '2021-04-01', 'INR', 900000)
         RETURNING id`,
        [ctx.tenant, code, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
          dept, site, entity, inShift, ctx.adminEmployeeId])).rows[0].id;
    };

    const selfCaller = (employeeId) => ({
      role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId, userId: null,
    });
    const adminCaller = {
      role: 'company_admin', hasReports: false, tenantId: ctx.tenant,
      employeeId: ctx.adminEmployeeId, userId: null,
    };

    /* ---------------------------------------------------------------- *
     * A day that was never recorded
     * ---------------------------------------------------------------- */

    console.log('\na day nobody recorded can still be corrected\n');

    const forgot = await hire();
    const me = selfCaller(forgot);

    const none = await attendanceForDay(me, forgot, GONE);
    ok('1. the day starts with no attendance row at all', none === null, JSON.stringify(none));

    const raised = await refused(() =>
      raiseRegularisation(me, forgot, GONE, '09:30', '18:30', 'Forgot to punch in'));
    ok('2. the correction is accepted rather than refused as "no record"',
      raised === null, `${raised?.code}: ${raised?.message}`);

    const day = await attendanceForDay(me, forgot, GONE);
    ok('3. and a row now exists for exactly that date',
      day?.date === GONE, String(day?.date));
    ok('    marked absent, which is what the day was',
      day?.status === 'A', String(day?.status));
    ok('    with no punches invented for it',
      !day?.inT && !day?.outT && day?.mins === 0,
      `in=${day?.inT} out=${day?.outT} mins=${day?.mins}`);
    ok('    recorded as a system row, not as a punch from a device',
      day?.src === 'system', String(day?.src));
    ok('4. and the request is on it, pending',
      day?.reg?.status === 'Pending' && day?.reg?.inT === '09:30',
      JSON.stringify(day?.reg));

    /*
     * The guards. A date in the future is not a correction, and neither is one
     * outside the person's employment — and without these, a typo writes a row
     * that every report and every pay run then has to reckon with, one per
     * mistake, for ever.
     */
    const ahead = await refused(() => raiseRegularisation(
      me, forgot, '2099-01-04', '09:30', '18:30', 'Forgot'));
    ok('5. a day that has not happened is refused',
      ahead instanceof AttendanceError && /has not happened/.test(ahead.message),
      `${ahead?.code}: ${ahead?.message}`);
    const before = await refused(() => raiseRegularisation(
      me, forgot, '2019-05-06', '09:30', '18:30', 'Forgot'));
    ok('    and so is one before they joined',
      before instanceof AttendanceError && /outside this person/.test(before.message),
      `${before?.code}: ${before?.message}`);
    ok('    neither of which left a row behind',
      (await admin.query(
        'SELECT count(*)::int n FROM attendance WHERE employee_id = $1', [forgot]))
        .rows[0].n === 1);

    /* ---------------------------------------------------------------- *
     * And the screen can find such a day to offer it
     * ---------------------------------------------------------------- */

    console.log('\nand the list the screen builds its dates from offers it\n');

    const other = await hire();
    const them = selfCaller(other);
    const offered = await regularisableDays(them, other, '2026-10-12');
    const dates = offered.map((r) => r.date);

    ok('6. a working day with no row is offered for correction',
      dates.includes(GONE) && dates.includes(ALSO_GONE),
      JSON.stringify(dates.slice(0, 8)));
    ok('    newest first, as the screen renders them',
      dates.join(',') === [...dates].sort((a, b) => b.localeCompare(a)).join(','),
      JSON.stringify(dates.slice(0, 5)));
    ok('7. today is not offered, because it is not over',
      !dates.includes((await admin.query('SELECT current_date::text AS d')).rows[0].d),
      JSON.stringify(dates.slice(0, 3)));

    /*
     * A Sunday. Not a day with attendance missing — nobody was expected — and
     * `classifyMany` is what knows that, which is why it decides rather than a
     * weekday test written here for the second time.
     */
    ok('8. a weekly off is not offered as a day needing correction',
      !dates.includes('2026-10-18'), JSON.stringify(dates));

    /* ---------------------------------------------------------------- *
     * Correcting a day worked before a shift move
     * ---------------------------------------------------------------- */

    console.log('\nand a correction across a move uses the day\'s own hours\n');

    const moved = await hire();
    const theirs = selfCaller(moved);

    /* A day worked on the India shift: 10:00 IST is 04:30Z. */
    await punchIn(theirs, moved, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: '2026-10-21T04:30:00.000Z',
    });
    await punchOut(theirs, moved, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: '2026-10-21T13:00:00.000Z',
    });

    /* Then moved to New York hours, as somebody would be after the fact. */
    await setEmployeeShift(adminCaller, moved, 'ZZNY');
    ok('9. the employee is now on the New York roster',
      (await admin.query(
        'SELECT sh.code FROM employee e JOIN shift sh ON sh.id = e.shift_id WHERE e.id = $1',
        [moved])).rows[0].code === 'ZZNY');

    await raiseRegularisation(theirs, moved, '2026-10-21', '10:00', '18:30', 'Wrong hours');

    /*
     * 10:00 on 21 October in Asia/Kolkata is 04:30Z. In America/New_York it
     * would be 14:00Z — the number the old `e.shift_id` join produced, and the
     * reason this assertion is on the stored instant rather than on what the
     * screen renders.
     */
    const stored = (await admin.query(
      `SELECT to_char(requested_in AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS in_utc
         FROM regularisation WHERE employee_id = $1`, [moved])).rows[0];
    ok('10. the typed hours are stored in the day\'s own zone, not the new one',
      stored?.in_utc === '2026-10-21 04:30',
      `${stored?.in_utc} — 14:00 would mean New York was used for an India day`);

    const back = await attendanceForDay(theirs, moved, '2026-10-21');
    ok('11. and the day still reads in the zone it was worked in',
      back?.inT === '10:00' && back?.tz === 'Asia/Kolkata',
      `${back?.inT} / ${back?.tz}`);
  });
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the suite did not finish: ${e?.message ?? e}`);
  if (e?.stack) console.log(e.stack.split('\n').slice(1, 5).join('\n'));
} finally {
  await admin.end();
  await closePool();
}

console.log(`\n${failed
  ? `${failed} FAILED`
  : 'a day nobody recorded can be corrected, in the hours it was actually worked'}\n`);
process.exit(failed ? 1 : 0);
