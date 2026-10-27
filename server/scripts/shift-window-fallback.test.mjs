/**
 * There is always a window to measure a punch against.
 *
 * ## Why this exists
 *
 * `employee.shift_id` is `NOT NULL`, so "an employee with no shift" is not a
 * state this database can hold, and the first version of this reasoning was
 * wrong about that. What it *can* hold is a shift with no hours:
 * `shift.starts_at` and `shift.ends_at` are both nullable, which is how a
 * flexible shift is recorded. A null in either makes every interval in the
 * attribution query null, so no window contains the punch, so the punch is
 * refused — for a reason the employee can neither see nor fix, which becomes
 * their manager's nightly correction.
 *
 * So `EFFECTIVE_SHIFT` resolves a window through five levels, and each level
 * is a *whole* window rather than a column: taking the start from one shift
 * and the zone from another would invent a window nobody defined.
 *
 * Levels 2 to 5 cannot be reached by any employee in production today. They
 * are tested one at a time anyway, because "cannot happen" is exactly how the
 * flexible-shift hole got there.
 *
 * ## How each level is reached
 *
 * One instant, `2026-10-26T15:00:00Z`, sits inside all five candidate windows,
 * so a level that fails to resolve shows up as null rather than as a window
 * that merely happens not to contain the punch. Each level is then identified
 * by the zone *and* the start time it comes back with, which no other level
 * shares.
 */

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

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

/** The one instant, inside every candidate window. */
const WHEN = '2026-10-26T15:00:00Z';

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

    const shiftOf = async (code, starts, ends, tz, region = null) => (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          grace_minutes, break_minutes, region)
       VALUES ($1, $2, $2, $3::time, $4::time, $5, true, 10, 60, $6) RETURNING id`,
      [ctx.tenant, code, starts, ends, tz, region])).rows[0].id;

    /* The shift with no hours. This is the reachable way in. */
    const flexible = (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          is_flexible, grace_minutes, break_minutes)
       VALUES ($1, 'ZZFLEX', 'ZZ Flexible', NULL, NULL, 'Asia/Kolkata', true,
               true, 10, 60) RETURNING id`,
      [ctx.tenant])).rows[0].id;

    const ownShift = await shiftOf('ZZOWN', '09:00', '18:00', 'America/New_York');
    const siteDefault = await shiftOf('ZZDEF', '08:00', '16:00', 'Europe/London');
    const regional = await shiftOf('ZZRGN', '10:00', '19:00', 'Asia/Dubai', 'IN');

    const hire = async (code, shiftId) => (await admin.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role, employment_type,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency, ctc)
       VALUES ($1, $2, $2, $3::citext, 'active', 'employee', 'permanent',
               $4, $5, $6, $7, DATE '2021-04-01', 'INR', 600000)
       RETURNING id`,
      [ctx.tenant, code, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
        dept, site, ctx.entityId, shiftId])).rows[0].id;

    const withWindow = await hire('ZZ800', ownShift);
    const noWindow = await hire('ZZ801', flexible);

    const caller = {
      tenantId: ctx.tenant, userId: null, employeeId: withWindow,
      role: 'company_admin', hasReports: false,
    };
    const at = async (empId) => withTenantReadOnly(
      { ...caller, employeeId: empId },
      (db) => shiftInstanceAt(db, empId, WHEN));

    /* The time half of `shiftStartLocal`, which identifies the window used. */
    const startTime = (r) => (r ? String(r.shiftStartLocal).slice(11) : null);

    /* ------------------------------------------------------------------ *
     * 1. the employee's own shift, when it has hours
     * ------------------------------------------------------------------ */
    console.log(`the employee's own shift, when it has hours${NL}`);
    {
      const r = await at(withWindow);
      ok('1. a window is resolved', r !== null);
      ok('2.  from their own shift', r?.timezone === 'America/New_York', r?.timezone);
      ok('3.  starting at its own time', startTime(r) === '09:00', startTime(r));
    }

    /* ------------------------------------------------------------------ *
     * 2. a flexible shift falls through to the site's default
     * ------------------------------------------------------------------ */
    console.log(`${NL}a shift with no hours, and a site that names a default${NL}`);
    await admin.query('UPDATE site SET default_shift_id = $2 WHERE id = $1',
      [site, siteDefault]);
    {
      const r = await at(noWindow);
      ok('4. a shift with no hours does not refuse the punch', r !== null,
        'null here is what produced a refusal nobody could act on');
      ok('5.  the site default supplies the window', r?.timezone === 'Europe/London',
        r?.timezone);
      ok('6.  whole, not blended with the flexible shift', startTime(r) === '08:00',
        `${startTime(r)} — a per-column COALESCE would take IST from the flexible shift`);
    }

    /* ------------------------------------------------------------------ *
     * 3. no site default: a shift whose region is the site's country
     * ------------------------------------------------------------------ */
    console.log(`${NL}no site default, but a shift for the site's country${NL}`);
    await admin.query('UPDATE site SET default_shift_id = NULL WHERE id = $1', [site]);
    {
      const r = await at(noWindow);
      ok('7. the regional shift supplies the window', r?.timezone === 'Asia/Dubai',
        r?.timezone);
      ok('8.  with its own hours', startTime(r) === '10:00', startTime(r));
    }

    /* ------------------------------------------------------------------ *
     * 4. nothing to inherit: 09:00-18:00 in the site's own zone
     * ------------------------------------------------------------------ */
    console.log(`${NL}nothing to inherit, so nine to six in the site's zone${NL}`);
    await admin.query('UPDATE shift SET region = NULL WHERE id = $1', [regional]);
    await admin.query(`UPDATE site SET timezone = 'Europe/Berlin' WHERE id = $1`, [site]);
    {
      const r = await at(noWindow);
      ok('9. the punch is still attributed', r !== null);
      ok('10.  in the site\'s zone', r?.timezone === 'Europe/Berlin', r?.timezone);
      ok('11.  from 09:00', startTime(r) === '09:00', startTime(r));
    }

    /* ------------------------------------------------------------------ *
     * 5. no site at all — site_id is nullable
     * ------------------------------------------------------------------ */
    console.log(`${NL}and an employee with no site at all${NL}`);
    await admin.query('UPDATE employee SET site_id = NULL WHERE id = $1', [noWindow]);
    {
      const r = await at(noWindow);
      ok('12. still attributed rather than refused', r !== null,
        'site_id is nullable, so this is reachable without any data being wrong');
      ok('13.  in IST', r?.timezone === 'Asia/Kolkata', r?.timezone);
      ok('14.  from 09:00', startTime(r) === '09:00', startTime(r));
    }

    /* ------------------------------------------------------------------ *
     * 6. and the rule that matters: no configuration refuses a punch
     * ------------------------------------------------------------------ */
    console.log(`${NL}no arrangement of missing configuration refuses a punch${NL}`);
    {
      /* Everything stripped at once: no hours, no site, no default, no
         regional shift. The worst case the schema permits. */
      const r = await at(noWindow);
      ok('15. the worst case the schema allows still resolves', r !== null);
      ok('16.  and names a work date', Boolean(r?.workDate), String(r?.workDate));
      ok('17.  and a zone to label it with', Boolean(r?.timezone), String(r?.timezone));
    }
  });
} catch (e) {
  fatal = e;
}

await admin.end();

if (fatal) {
  console.error(`${NL}the suite could not run: ${fatal.message}${NL}`);
  process.exit(1);
}

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`there is always a window, so no punch is refused for want of one${NL}`);
process.exit(0);
