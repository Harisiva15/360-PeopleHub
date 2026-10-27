/**
 * Which day a punch belongs to, when the shift is measured somewhere else.
 *
 *   node --experimental-strip-types scripts/shift-instance.test.mjs
 *
 * A team in Chennai works 09:00–18:00 America/New_York. In IST that is
 * 18:30–03:30 until 1 November 2026 and 19:30–04:30 after it, so the shift
 * crosses midnight *in the browser's zone* and not in its own.
 *
 * `shiftInstanceAt` answers in the shift's zone: a punch belongs to the
 * instance whose window (start − 2h … end + 4h) contains it, and the work
 * date is that instance's start date. The assertions below are the cases that
 * were broken, plus the ones that must not break.
 *
 * Every instant is written as a UTC `Z` literal on purpose. Writing them in
 * IST or ET would bake an offset into the test and the DST cases would stop
 * meaning anything.
 */

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

const { assertLocalDatabase } = await import('./local-only.mjs');
if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('SKIPPED: set MIGRATE_DATABASE_URL and DATABASE_URL to a local database.');
  process.exit(0);
}
assertLocalDatabase();

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';

const { default: pg } = await import('pg');
const { withScratchTenant } = await import('./lib/scratch-tenant.mjs');
const { withTenantReadOnly } = await import('../src/tenancy/context.ts');
const { shiftInstanceAt } = await import('../src/modules/attendance/service.ts');

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();

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

    /* The shift under test, and one that genuinely crosses midnight in its
       own zone, so the same arithmetic is proven both ways. */
    const shiftOf = async (code, name, starts, ends, tz) => (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          grace_minutes, break_minutes)
       VALUES ($1, $2, $3, $4::time, $5::time, $6, true, 10, 60) RETURNING id`,
      [ctx.tenant, code, name, starts, ends, tz])).rows[0].id;

    const usShift = await shiftOf('ZZUS', 'ZZ US Hours', '09:00', '18:00', 'America/New_York');
    const nightShift = await shiftOf('ZZNT', 'ZZ Night', '22:00', '06:00', 'Asia/Kolkata');

    const hire = async (code, shiftId) => (await admin.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role, employment_type,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency, ctc)
       VALUES ($1, $2, $2, $3::citext, 'active', 'employee', 'permanent',
               $4, $5, $6, $7, DATE '2021-04-01', 'INR', 600000)
       RETURNING id`,
      [ctx.tenant, code, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
        dept, site, ctx.entityId, shiftId])).rows[0].id;

    const prem = await hire('ZZ700', usShift);
    const nightly = await hire('ZZ701', nightShift);

    const caller = {
      tenantId: ctx.tenant, userId: null, employeeId: prem,
      role: 'company_admin', hasReports: false,
    };

    const at = async (empId, instant) => withTenantReadOnly(
      { ...caller, employeeId: empId },
      (db) => shiftInstanceAt(db, empId, instant));

    /* ---------------------------------------------------------------- *
     * 1. one shift, two IST calendar days, one work_date
     * ---------------------------------------------------------------- */

    console.log('a shift that crosses midnight in IST and not in its own zone\n');

    /* Mon 26 Oct 2026: 09:00 ET = 13:00 UTC = 18:30 IST. */
    const inMon = await at(prem, '2026-10-26T13:00:00Z');
    /* Tue 27 Oct 03:30 IST = 22:00 UTC on the 26th = 18:00 ET Monday. */
    const outTue = await at(prem, '2026-10-26T22:00:00Z');

    ok('1. the punch in belongs to Monday 26 October',
      inMon?.workDate === '2026-10-26', JSON.stringify(inMon));
    ok('2. the punch out nine hours later belongs to the same Monday',
      outTue?.workDate === '2026-10-26', JSON.stringify(outTue));
    ok('3.  which is one shift, not two days',
      inMon?.workDate === outTue?.workDate);
    ok('4.  and it reports the zone it measured in',
      inMon?.timezone === 'America/New_York', String(inMon?.timezone));

    /* ---------------------------------------------------------------- *
     * 2. the window, which is what the button obeys
     * ---------------------------------------------------------------- */

    console.log('\nthe window is start − 2h to end + 4h, in the shift\'s zone\n');

    ok('5. two hours before the start is inside',
      (await at(prem, '2026-10-26T11:00:00Z'))?.workDate === '2026-10-26');
    ok('6.  a minute before that is outside',
      (await at(prem, '2026-10-26T10:59:00Z')) === null);
    ok('7. four hours after the end is inside',
      (await at(prem, '2026-10-27T02:00:00Z'))?.workDate === '2026-10-26');
    ok('8.  a minute later is outside',
      (await at(prem, '2026-10-27T02:01:00Z')) === null);
    ok('9. the middle of the Chennai working day is outside it entirely',
      (await at(prem, '2026-10-26T06:00:00Z')) === null,
      '11:30 IST is nobody\'s US shift');

    /* ---------------------------------------------------------------- *
     * 3. DST, both sides of 1 November 2026
     * ---------------------------------------------------------------- */

    console.log('\nUS DST ends on 1 November 2026: same ET hours, IST moves\n');

    /* Fri 30 Oct, EDT: 09:00 ET = 13:00 UTC. */
    ok('10. before the switch, 13:00 UTC is the 09:00 start',
      (await at(prem, '2026-10-30T13:00:00Z'))?.shiftStartLocal === '2026-10-30 09:00',
      JSON.stringify(await at(prem, '2026-10-30T13:00:00Z')));
    /* Mon 2 Nov, EST: 09:00 ET = 14:00 UTC. */
    ok('11. after it, the same shift starts at 14:00 UTC',
      (await at(prem, '2026-11-02T14:00:00Z'))?.shiftStartLocal === '2026-11-02 09:00',
      JSON.stringify(await at(prem, '2026-11-02T14:00:00Z')));
    ok('12.  and 13:00 UTC on 2 November is an hour early, still inside the window',
      (await at(prem, '2026-11-02T13:00:00Z'))?.workDate === '2026-11-02');

    /*
     * The switch weekend itself. ET Saturday 31 October and Sunday
     * 1 November are weekend days in the shift's zone — `classifyRange`
     * decides that from the work date, so what matters here is that each
     * instant lands on the ET date it belongs to and no date is skipped or
     * doubled.
     */
    const across = [];
    for (const d of ['2026-10-29', '2026-10-30', '2026-10-31']) {
      across.push((await at(prem, `${d}T13:00:00Z`))?.workDate);
    }
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) {
      across.push((await at(prem, `${d}T14:00:00Z`))?.workDate);
    }
    ok('13. the switch week has one instance per ET date, in order',
      across.join(',') === '2026-10-29,2026-10-30,2026-10-31,2026-11-01,2026-11-02,2026-11-03',
      across.join(','));

    /* ---------------------------------------------------------------- *
     * 4. a shift that really does cross midnight in its own zone
     * ---------------------------------------------------------------- */

    console.log('\nand a 22:00–06:00 Asia/Kolkata shift, which crosses its own midnight\n');

    /* Mon 26 Oct 22:00 IST = 16:30 UTC. */
    ok('14. the punch in belongs to Monday',
      (await at(nightly, '2026-10-26T16:30:00Z'))?.workDate === '2026-10-26',
      JSON.stringify(await at(nightly, '2026-10-26T16:30:00Z')));
    /* Tue 27 Oct 06:00 IST = 00:30 UTC. */
    ok('15. the punch out after midnight belongs to the same Monday',
      (await at(nightly, '2026-10-27T00:30:00Z'))?.workDate === '2026-10-26',
      JSON.stringify(await at(nightly, '2026-10-27T00:30:00Z')));
    /* Tue 27 Oct 10:00 IST = 04:30 UTC — four hours after the 06:00 end. */
    ok('16.  and end + 4h is still Monday\'s instance',
      (await at(nightly, '2026-10-27T04:30:00Z'))?.workDate === '2026-10-26');
    /* Tue 27 Oct 20:00 IST = 14:30 UTC — two hours before Tuesday's 22:00. */
    ok('17.  while Tuesday evening opens Tuesday\'s',
      (await at(nightly, '2026-10-27T14:30:00Z'))?.workDate === '2026-10-27');

    /* ---------------------------------------------------------------- *
     * 5. the ordinary case must not have changed
     * ---------------------------------------------------------------- */

    console.log('\nand the shift that does not travel at all\n');

    const inShift = (await admin.query(
      'SELECT id FROM shift WHERE tenant_id = $1 AND code = $2', [ctx.tenant, 'IN'])).rows[0];
    if (inShift) {
      const local = await hire('ZZ702', inShift.id);
      /* 09:30 IST = 04:00 UTC on the same date. */
      ok('18. an India shift punched in India keeps the IST date',
        (await at(local, '2026-10-26T04:00:00Z'))?.workDate === '2026-10-26',
        JSON.stringify(await at(local, '2026-10-26T04:00:00Z')));
    } else {
      ok('18. an India shift punched in India keeps the IST date', false,
        'the scratch tenant has no IN shift');
    }
  });
} catch (e) {
  fatal = e;
} finally {
  await admin.end();
}

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a punch belongs to the shift instance that contains it${NL}`);
process.exit(0);
