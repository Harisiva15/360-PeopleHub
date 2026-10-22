/**
 * A holiday belongs to a location, and the right people get it.
 *
 * The column has existed since 0002 and nothing ever set it, so every holiday
 * was tenant-wide: Chennai, Bengaluru and New Jersey shared one calendar,
 * which is wrong in both directions — Republic Day is not a holiday in New
 * Jersey, and Thanksgiving is not one in Chennai.
 *
 * The *read* side was already right, and that is the part worth protecting
 * here. `classifyRange` resolves a person's holidays as `site_id IS NULL OR
 * site_id = their site`, preferring the site row where a date carries both,
 * and leave counts its days through the same resolver. So the assertions that
 * matter are not "the insert stored a uuid" but "the person at Chennai gets
 * Chennai's day off and the person at Bengaluru does not".
 *
 * The uniqueness rule is the other half: `holiday_one_per_day` is unique on
 * `(tenant_id, observed_on, COALESCE(site_id, sentinel))` and only `WHERE
 * optional = false`. That is a deliberate shape rather than an accident, so it
 * is pinned: one fixed holiday per date per location, "all locations" counting
 * as its own slot, and optional rows exempt.
 *
 *   node --experimental-strip-types scripts/holidays.test.mjs
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
const { addHoliday, listHolidays } = await import('../src/modules/config/service.ts');
const { classifyRange } = await import('../src/modules/calendar/service.ts');

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();

const refused = async (label, fn, rx) => {
  try {
    await fn();
    ok(label, false, 'it was allowed');
  } catch (e) {
    ok(label, rx.test(e?.message ?? ''), `${e?.constructor?.name}: ${e?.message}`);
  }
};

let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const caller = {
      tenantId: ctx.tenant,
      userId: null,
      employeeId: ctx.adminEmployeeId,
      role: 'company_admin',
      hasReports: false,
    };

    /* The scratch tenant has one site; per-location needs two to mean anything. */
    const siteA = (await admin.query(
      'SELECT id, name FROM site WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.site])).rows[0];
    const siteB = (await admin.query(
      `INSERT INTO site (tenant_id, code, name, country, timezone, active)
       VALUES ($1, 'ZZB', 'ZZ Second Office', 'IN', 'Asia/Kolkata', true)
       RETURNING id, name`, [ctx.tenant])).rows[0];

    /* Somebody at each, so the resolver has two different answers to give. */
    const personAt = async (code, siteId) => (await admin.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency)
       SELECT $1, $2, $3, $4, 'active', 'employee',
              e.department_id, $5, e.legal_entity_id, e.shift_id,
              DATE '2020-01-01', 'INR'
         FROM employee e WHERE e.id = $6
       RETURNING id`,
      [ctx.tenant, code, `ZZ ${code}`, `zz-hol-${code}@360.technology`,
        siteId, ctx.adminEmployeeId])).rows[0].id;

    const atA = await personAt('ZZHA', siteA.id);
    const atB = await personAt('ZZHB', siteB.id);

    const DAY = '2026-01-26';

    console.log(`${NL}a holiday can name a location${NL}`);

    await addHoliday(caller, DAY, 'Republic Day', false, siteA.id);
    const stored = (await admin.query(
      `SELECT h.name, s.code AS site FROM holiday h
         LEFT JOIN site s ON s.id = h.site_id
        WHERE h.tenant_id = $1 AND h.observed_on = $2`, [ctx.tenant, DAY])).rows;
    ok('1. it is stored against that site, not tenant-wide',
      stored.length === 1 && stored[0].site === ctx.site, JSON.stringify(stored));

    console.log(`${NL}one fixed holiday per date per location${NL}`);

    await refused('2. the same date at the same site is refused',
      () => addHoliday(caller, DAY, 'Something else', false, siteA.id),
      new RegExp(siteA.name));
    await addHoliday(caller, DAY, 'Republic Day', false, siteB.id);
    ok('3. but the same date at another site is fine', true);
    await addHoliday(caller, DAY, 'Company day', false, null);
    ok('4.  and a tenant-wide row on that date is fine too — it is its own slot', true);
    await addHoliday(caller, DAY, 'Optional extra', true, siteA.id);
    ok('5.  and an optional one is exempt from the rule', true);
    await refused('6. a location from outside this tenant is refused',
      () => addHoliday(caller, '2026-02-02', 'Nope', false,
        '00000000-0000-0000-0000-000000000001'),
      /not one of this tenant/i);

    console.log(`${NL}and the right people get the day off${NL}`);

    /*
     * The assertion the whole change exists for. Both rows are fixed and on the
     * same date: the person at A must see A's name, the person at B must see
     * B's, and neither may see the other's.
     */
    const dayFor = async (empId) => {
      const days = await (await import('../src/tenancy/context.ts'))
        .withTenantReadOnly(
          { ...caller, employeeId: empId },
          (db) => classifyRange(db, empId, DAY, DAY),
        );
      return days[0];
    };

    const a = await dayFor(atA);
    const b = await dayFor(atB);
    ok('7. the person at the first site has a holiday', Boolean(a?.holiday), JSON.stringify(a));
    ok('8. the person at the second site has one as well', Boolean(b?.holiday), JSON.stringify(b));
    ok('9.  and the site row wins over the tenant-wide one',
      a?.holiday === 'Republic Day' && b?.holiday === 'Republic Day',
      `A saw ${a?.holiday}, B saw ${b?.holiday}`);

    /* Remove the per-site rows and the tenant-wide one should surface. */
    await admin.query(
      'DELETE FROM holiday WHERE tenant_id = $1 AND site_id IS NOT NULL', [ctx.tenant]);
    const aAfter = await dayFor(atA);
    ok('10. with no site row, the all-locations one applies',
      aAfter?.holiday === 'Company day', JSON.stringify(aAfter));

    console.log(`${NL}what the administration screen reads${NL}`);

    const listed = await listHolidays(caller);
    ok('11. the list carries a location per row',
      listed.every((h) => 'site' in h), JSON.stringify(listed.slice(0, 2)));
    ok('12.  naming it, so a screen need not resolve an id',
      listed.some((h) => h.site === null),
      JSON.stringify(listed.map((h) => h.site)));
  });
} catch (e) {
  fatal = e;
} finally {
  await admin.end();
}

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a holiday belongs to a location, and the right people get it${NL}`);
process.exit(0);
