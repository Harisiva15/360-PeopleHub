/**
 * A day punched into and never out of, and what the product says about it.
 *
 * ## Why this is not a column
 *
 * A forgotten punch out leaves `status = 'P'`, `punch_in` set, `punch_out`
 * null and `worked_minutes = 0`. Both readings of that row are wrong: payroll
 * sees a present day that earned nothing, and anything that "fixes" it by
 * marking the day absent puts a false `A` against somebody who came to work.
 * It is neither — it is a day whose hours are unknown.
 *
 * `MISSING_PUNCH_OUT` derives exactly that from the row and its shift, so:
 *
 *   * nothing runs on a schedule, and there is no sweep to fail silently;
 *   * there is no stored flag to disagree with the row after a shift's hours
 *     are edited;
 *   * the day stops being reported the moment it is closed or corrected.
 *
 * ## And why the shift has to be the row's
 *
 * `PROJECTION` joined `shift` on the *employee's* shift, so moving somebody
 * from the IST shift to the US shift re-rendered every punch they had ever
 * made into New York time — a 09:30 IST arrival would read as 23:00 the
 * previous day, with no edit to the history that changed. Assertions 9 and 10
 * move an employee between shifts and require the old rows to stay put.
 */

import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and an unclosed day is a row in one.\n');
  process.exit(0);
}

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');
const {
  punchIn, punchOut, attendanceForDay, unclosedDays,
} = await import('../src/modules/attendance/service.ts');
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

/* 09:00 and 18:00 New York on 20 October 2026, which is EDT. */
const DAY = '2026-10-20';
const NEXT = '2026-10-21';
const IN_AT = '2026-10-20T13:00:00.000Z';
const NEXT_IN_AT = '2026-10-21T13:00:00.000Z';

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
                          grace_minutes, break_minutes)
       VALUES ($1, $2, $2, $3::time, $4::time, $5, true, 10, 60) RETURNING id`,
      [ctx.tenant, code, starts, ends, tz])).rows[0].id;

    const usShift = await shiftOf('ZZUS', '09:00', '18:00', 'America/New_York');
    const inShift = await shiftOf('ZZIN', '09:30', '18:30', 'Asia/Kolkata');

    let n = 0;
    const hire = async (shiftId, managerId = null) => {
      n += 1;
      const code = `ZZU${n}`;
      return (await admin.query(
        `INSERT INTO employee
           (tenant_id, code, full_name, work_email, status, app_role, employment_type,
            department_id, site_id, legal_entity_id, shift_id, manager_id, joined_on,
            currency, ctc)
         VALUES ($1, $2, $2, $3::citext, 'active', 'employee', 'permanent',
                 $4, $5, $6, $7, $8, DATE '2021-04-01', 'USD', 90000)
         RETURNING id`,
        [ctx.tenant, code, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
          dept, site, entity, shiftId, managerId])).rows[0].id;
    };

    const selfCaller = (employeeId) => ({
      role: 'employee', hasReports: false, tenantId: ctx.tenant, employeeId, userId: null,
    });
    const adminCaller = {
      role: 'company_admin', hasReports: false, tenantId: ctx.tenant,
      employeeId: ctx.adminEmployeeId, userId: null,
    };

    /* ---------------------------------------------------------------- *
     * The forgotten punch out
     * ---------------------------------------------------------------- */

    console.log('\na day punched into and never out of\n');

    const forgot = await hire(usShift);
    const me = selfCaller(forgot);

    await punchIn(me, forgot, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: IN_AT,
    });

    const day = await attendanceForDay(me, forgot, DAY);
    ok('1. the day is still present, not absent', day?.status === 'P', String(day?.status));
    ok('    with a punch in and no punch out',
      Boolean(day?.inT) && !day?.outT, `in=${day?.inT} out=${day?.outT}`);
    ok('2. and it says the hours are unknown rather than zero',
      day?.missingPunchOut === true, String(day?.missingPunchOut));
    ok('    which is not the same as the stored worked_minutes, still 0',
      day?.mins === 0, String(day?.mins));

    /*
     * The rule the whole thing turns on: forgetting to punch out yesterday
     * must not stop anybody working today. A refusal here is somebody unable
     * to record a day they worked.
     */
    const nextDay = await refused(() => punchIn(me, forgot, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: NEXT_IN_AT,
    }));
    ok('3. the next day\'s punch in is allowed, not refused',
      nextDay === null, `${nextDay?.code}: ${nextDay?.message}`);

    /*
     * Both days, newest first — and that is the right answer, not a bug in
     * the query. Assertion 3 punched in on the 21st and did not punch out of
     * that either, so there are now two forgotten days. The first draft of
     * this assertion wanted exactly one and was simply wrong about what it
     * had set up.
     */
    const mine = await unclosedDays(me);
    ok('4. both open days are reported, newest first',
      mine.length === 2 && mine[0]?.date === NEXT && mine[1]?.date === DAY,
      JSON.stringify(mine.map((u) => u.date)));
    ok('    in the shift\'s own zone, so 09:00 not 18:30',
      mine.every((u) => u.inT === '09:00' && u.tz === 'America/New_York'),
      JSON.stringify(mine.map((u) => [u.inT, u.tz])));
    ok('    and each says how long it has been open',
      mine.every((u) => Number(u.daysOpen) >= 1)
        && Number(mine[1].daysOpen) > Number(mine[0].daysOpen),
      JSON.stringify(mine.map((u) => u.daysOpen)));

    /* ---------------------------------------------------------------- *
     * What is not an unclosed day
     * ---------------------------------------------------------------- */

    console.log('\nand what is not one\n');

    const closed = await hire(usShift);
    const them = selfCaller(closed);
    await punchIn(them, closed, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: IN_AT,
    });
    await punchOut(them, closed, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: '2026-10-20T22:00:00.000Z',
    });
    ok('5. a day that was closed is not reported',
      (await unclosedDays(them)).length === 0,
      JSON.stringify(await unclosedDays(them)));

    const absent = await hire(usShift);
    await admin.query(
      `INSERT INTO attendance (tenant_id, employee_id, work_date, status, shift_id)
       VALUES ($1, $2, DATE '2026-10-19', 'A', $3)`,
      [ctx.tenant, absent, usShift]);
    ok('6. an absence has nothing to close, so it is not reported',
      (await unclosedDays(selfCaller(absent))).length === 0);

    /*
     * A punch whose window has not closed yet is open, not forgotten. Written
     * directly rather than punched, because the point is the read predicate
     * and a future instant is the only way to be certainly inside a window
     * whatever time this suite runs at.
     */
    const working = await hire(usShift);
    await admin.query(
      `INSERT INTO attendance (tenant_id, employee_id, work_date, status, shift_id, punch_in)
       VALUES ($1, $2, (now() + interval '2 days')::date, 'P', $3, now() + interval '2 days')`,
      [ctx.tenant, working, usShift]);
    ok('7. a shift still running is not a forgotten punch out',
      (await unclosedDays(selfCaller(working))).length === 0,
      JSON.stringify(await unclosedDays(selfCaller(working))));

    /* ---------------------------------------------------------------- *
     * Who sees it
     * ---------------------------------------------------------------- */

    console.log('\nwho sees it\n');

    ok('8. an employee sees only their own',
      (await unclosedDays(selfCaller(closed))).every((u) => u.empId === closed));

    const all = await unclosedDays(adminCaller);
    ok('    while an administrator sees the team\'s',
      all.some((u) => u.empId === forgot), JSON.stringify(all.map((u) => u.empCode)));
    ok('    named, so the queue is readable',
      all.every((u) => u.empCode && u.empName),
      JSON.stringify(all.map((u) => [u.empCode, u.empName])));

    /* ---------------------------------------------------------------- *
     * The row's shift, not the employee's
     * ---------------------------------------------------------------- */

    console.log('\nhistory stays in the zone it was measured in\n');

    const moved = await hire(usShift);
    const movedMe = selfCaller(moved);
    await punchIn(movedMe, moved, {
      site: ctx.site, lat: null, lng: null, src: 'web', at: IN_AT,
    });
    const before = await attendanceForDay(movedMe, moved, DAY);
    ok('9. punched in at 09:00 New York', before?.inT === '09:00', String(before?.inT));

    await admin.query('UPDATE employee SET shift_id = $2 WHERE id = $1', [moved, inShift]);

    const after = await attendanceForDay(movedMe, moved, DAY);
    ok('10. and it still reads 09:00 after a move to the IST shift',
      after?.inT === '09:00', `${after?.inT} (${after?.tz})`);
    ok('    because the row carries the shift it was measured against',
      after?.tz === 'America/New_York', String(after?.tz));
    ok('    and the open day is still reported in that zone',
      (await unclosedDays(movedMe))[0]?.tz === 'America/New_York',
      String((await unclosedDays(movedMe))[0]?.tz));
  });
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the suite threw: ${e?.message ?? e}`);
  if (e?.stack) console.log(e.stack.split('\n').slice(1, 4).join('\n'));
} finally {
  await admin.end();
  await closePool();
}

console.log(`\n${failed ? `${failed} FAILED` : 'an unclosed day is read, not swept, and history keeps its zone'}\n`);
process.exit(failed ? 1 : 0);
