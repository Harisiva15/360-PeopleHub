/**
 * Somebody with no work schedule still has working days.
 *
 * `classifyRange` falls back to Monday-to-Friday when no `employee_schedule`
 * assignment covers a date, and reports `schedule: null` so the fallback
 * is visible rather than silent — a caller can tell a scheduled Monday from an
 * assumed one. Two people in the live tenant have no assignment, so this is
 * not a hypothetical branch: it decides their attendance, their leave day
 * counts and what the roster shows.
 *
 *   node --experimental-strip-types scripts/schedule-fallback.test.mjs
 *
 * ## Why this is a scratch tenant and not the seed
 *
 * `db/manual/seed-local.mjs` used to leave one employee unassigned on purpose,
 * to keep this case in the local database. That did not survive contact with
 * `work-schedule.test.mjs`, which runs a backfill over the live tenant and
 * then asserts the assignment count is unchanged: the backfill filled the
 * hole, the census caught it, and the suite failed for a reason that had
 * nothing to do with what it was testing.
 *
 * The lesson is that a deliberate gap cannot live in a tenant other suites
 * write to. Here the employee is created without an assignment, classified,
 * and taken away with the tenant — so the gap exists for exactly as long as
 * the assertion needs it, and nothing else can close it first.
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

/* Nothing above the skip, for the reason photo.test.mjs records. */
const { default: pg } = await import('pg');
const { withScratchTenant } = await import('./lib/scratch-tenant.mjs');
const { withTenantReadOnly } = await import('../src/tenancy/context.ts');
const { classifyRange } = await import('../src/modules/calendar/service.ts');

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();

/*
 * A fixed week, Monday to Sunday, in a year the fixture's employee is already
 * employed for. Fixed so no assertion here can be made to fail by waiting,
 * which is the trap the scratch-tenant fixture's own header records.
 */
const FROM = '2026-06-01';
const TO = '2026-06-07';
const expectedWorking = (iso) => {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
};

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    /* Sanity: the week really is a Monday-to-Sunday run of seven days. */
    ok('1. the fixed week starts on a Monday and ends on a Sunday',
      new Date(`${FROM}T00:00:00Z`).getUTCDay() === 1
      && new Date(`${TO}T00:00:00Z`).getUTCDay() === 0);

    const dept = (await admin.query(
      'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.dept])).rows[0].id;
    const site = (await admin.query(
      'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.site])).rows[0].id;

    const unscheduled = (await admin.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role, employment_type,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency, ctc)
       VALUES ($1, 'ZZ900', 'ZZ No Schedule', $2::citext, 'active', 'employee', 'permanent',
               $3, $4, $5, $6, DATE '2021-04-01', 'INR', 600000)
       RETURNING id`,
      [ctx.tenant, `zz-no-schedule-${Date.now().toString(36)}@360.technology`,
        dept, site, ctx.entityId, ctx.shiftId])).rows[0].id;

    const assignments = (await admin.query(
      'SELECT count(*)::int AS n FROM employee_schedule WHERE employee_id = $1',
      [unscheduled])).rows[0].n;
    ok('2. the employee has no schedule assignment', assignments === 0, `${assignments} found`);

    const caller = {
      tenantId: ctx.tenant,
      userId: null,
      employeeId: unscheduled,
      role: 'employee',
      hasReports: false,
    };

    const days = await withTenantReadOnly(caller,
      (db) => classifyRange(db, unscheduled, FROM, TO));

    ok('3. the week classifies as seven days', days.length === 7, `${days.length} returned`);

    /*
     * The signal that makes the fallback honest. If this ever comes back
     * non-null for an unassigned person, the fallback has stopped announcing
     * itself and a caller can no longer tell an assumed Monday from a real
     * one — which is the whole reason the field exists.
     */
    const codes = [...new Set(days.map((d) => d.schedule))];
    ok('4. every day reports schedule null, so the fallback is visible',
      days.every((d) => d.schedule === null), JSON.stringify(codes));

    const wrong = days.filter((d) => d.workingDay !== expectedWorking(d.date));
    ok('5. Monday to Friday are working days and the weekend is not',
      wrong.length === 0,
      wrong.map((d) => `${d.date} workingDay=${d.workingDay}`).join(', '));

    ok('6.  which is five working days in the week',
      days.filter((d) => d.workingDay).length === 5,
      `${days.filter((d) => d.workingDay).length}`);

    /*
     * And the other half of the contract: once a schedule does cover the
     * date, it is named. Without this, assertion 4 would also pass if
     * `schedule` were hard-wired to null for everybody.
     */
    const mf = (await admin.query(
      `INSERT INTO work_schedule (tenant_id, code, name, active)
       VALUES ($1, 'ZZMF', 'ZZ Monday-Friday', true) RETURNING id`, [ctx.tenant])).rows[0].id;
    for (const dow of [1, 2, 3, 4, 5, 6, 7]) {
      await admin.query(
        `INSERT INTO work_schedule_day (tenant_id, work_schedule_id, day_of_week, working)
         VALUES ($1, $2, $3, $4)`, [ctx.tenant, mf, dow, dow <= 5]);
    }
    await admin.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, work_schedule_id, valid_from)
       VALUES ($1, $2, $3, DATE '2021-04-01')`, [ctx.tenant, unscheduled, mf]);

    const after = await withTenantReadOnly(caller,
      (db) => classifyRange(db, unscheduled, FROM, TO));

    ok('7. with an assignment, the schedule is named rather than assumed',
      after.every((d) => d.schedule === 'ZZMF'),
      JSON.stringify([...new Set(after.map((d) => d.schedule))]));

    ok('8.  and it still works out to the same five days',
      after.filter((d) => d.workingDay).length === 5,
      `${after.filter((d) => d.workingDay).length}`);
  });
} catch (e) {
  fatal = e;
} finally {
  await admin.end();
}

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`no schedule means Monday to Friday, and it says so${NL}`);
process.exit(0);
