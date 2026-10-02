/**
 * A tenant may rename itself, and may change nothing else about itself.
 *
 * `tenant` is the tenancy root. It is in `check-schema`'s GLOBAL_TABLES, it has
 * **no row level security**, and 0010 granted `app_rw` SELECT on it and nothing
 * more — alongside `country`, `currency` and `fx_rate`. In fifty-two migrations
 * nothing wrote to it outside the seed.
 *
 * Migration 0053 opens exactly one column. That makes this suite mostly a
 * privilege test rather than a behaviour test, because the interesting claim is
 * not "the service refuses to change the data region" — it is "the database
 * refuses, so the service being wrong would not be enough".
 *
 * ## What is worth holding
 *
 * **The grant is column-level, and the table-level one is absent.** Asserted both
 * ways: `has_column_privilege` says yes for `display_name` and no for the other
 * ten, and `has_table_privilege(…, 'UPDATE')` is false. The first column-level
 * grant in this schema deserves to be read back from the catalogue rather than
 * assumed from the migration text.
 *
 * **A direct UPDATE of a protected column is refused by PostgreSQL.** Not by the
 * service — by the engine, on the `app_rw` connection, with the service bypassed
 * entirely. That is the assertion the whole design rests on.
 *
 * **Because RLS is off here, the `WHERE id = current_tenant_id()` is the only
 * scoping.** Everywhere else in this module the policy would still refuse another
 * tenant's row. Not here. So isolation is tested by renaming in one tenant and
 * reading the other.
 *
 * **A refused write leaves no audit row.** A trail that records attempts as though
 * they happened is worse than none.
 *
 * **The modules that read the tenant still read it.** A dozen of them pull
 * `base_currency` or `fiscal_year_start_month`; the lookups they perform are run
 * directly afterwards to prove a rename did not disturb them.
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
  console.log('\nSKIPPED: no database, and a column grant can only be read from one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const config = await import('../src/modules/config/service.ts');
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

/* The migration role, for reading the catalogue and for direct writes. */
const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

/*
 * A second connection as `app_rw` itself. The privilege assertions below are
 * about what this role may do, so they are made by this role rather than
 * inferred. `app_rw` is NOBYPASSRLS, which is the point of using it.
 */
const asApp = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});
await asApp.connect();

const PROTECTED = ['legal_name', 'slug', 'status', 'home_country', 'base_currency',
  'fiscal_year_start_month', 'data_region', 'created_at', 'updated_at', 'id'];

const census = async () => (await db.query(`
  SELECT (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a,
         (SELECT string_agg(display_name, '|' ORDER BY slug::text) FROM tenant) names,
         (SELECT string_agg(slug::text, '|' ORDER BY slug::text) FROM tenant) slugs,
         (SELECT string_agg(base_currency, '|' ORDER BY slug::text) FROM tenant) ccy,
         (SELECT string_agg(status, '|' ORDER BY slug::text) FROM tenant) statuses`)).rows[0];
const before = await census();

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * 1/2. the table is untouched
 * ------------------------------------------------------------------ */

console.log('\nthe tenant table is exactly the one 0001 created\n');

{
  const cols = (await db.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'tenant' ORDER BY ordinal_position`)).rows;
  ok('1. eleven columns, unchanged', cols.length === 11,
    `${cols.length}: ${cols.map((c) => c.column_name).join(', ')}`);
  const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));

  ok('2. display_name exists and is NOT NULL text',
    by.display_name?.data_type === 'text' && by.display_name?.is_nullable === 'NO',
    JSON.stringify(by.display_name));
  for (const name of PROTECTED) ok(`    ${name} is still there`, Boolean(by[name]));
  ok('    and no timezone column was added', by.timezone === undefined,
    'a tenant with offices in two zones would have one value that is wrong for somebody');
  ok('    and no branding or logo column was added',
    by.branding === undefined && by.logo === undefined);

  ok('3. status still defaults to active with its four values',
    by.status?.column_default === "'active'::text", by.status?.column_default);
  ok('    fiscal_year_start_month still defaults to 4',
    by.fiscal_year_start_month?.column_default === '4');
  ok('    data_region still defaults to ap-south-1',
    by.data_region?.column_default === "'ap-south-1'::text");

  const rls = (await db.query(
    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'tenant'"
  )).rows[0];
  ok('4. RLS on tenant is still off, as the tenancy root',
    rls?.relrowsecurity === false && rls?.relforcerowsecurity === false, JSON.stringify(rls));
  ok('    so no policy was added either',
    (await db.query("SELECT count(*)::int n FROM pg_policy WHERE polrelid = 'tenant'::regclass"))
      .rows[0].n === 0);

  ok('5. the column comment records why display_name is special',
    /migration 0053/.test((await db.query(
      `SELECT col_description('tenant'::regclass, ordinal_position) AS d
         FROM information_schema.columns
        WHERE table_name = 'tenant' AND column_name = 'display_name'`)).rows[0]?.d ?? ''));
}

/* ------------------------------------------------------------------ *
 * 3/4. the privileges, read back from the catalogue
 * ------------------------------------------------------------------ */

console.log('\nthe grant is column-level, and the table-level one is absent\n');

{
  const can = async (col) => (await db.query(
    "SELECT has_column_privilege('app_rw', 'tenant', $1, 'UPDATE') AS ok", [col])).rows[0].ok;
  const tablePriv = async (p) => (await db.query(
    "SELECT has_table_privilege('app_rw', 'tenant', $1) AS ok", [p])).rows[0].ok;

  ok('6. app_rw may UPDATE display_name', (await can('display_name')) === true);
  for (const col of PROTECTED) {
    ok(`7. app_rw may NOT UPDATE ${col}`, (await can(col)) === false,
      'a column grant is the only thing making this unreachable');
  }

  ok('8. there is no table-level UPDATE on tenant', (await tablePriv('UPDATE')) === false,
    'GRANT UPDATE ON tenant would have opened every column');
  ok('    SELECT is still granted', (await tablePriv('SELECT')) === true,
    'a dozen modules read this row');
  ok('    INSERT is still not granted', (await tablePriv('INSERT')) === false);
  ok('    DELETE is still not granted', (await tablePriv('DELETE')) === false);

  const upCols = (await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_name = 'tenant' AND grantee = 'app_rw' AND privilege_type = 'UPDATE'
      ORDER BY column_name`)).rows.map((r) => r.column_name);
  ok('9. exactly one column carries an UPDATE grant',
    upCols.join(',') === 'display_name', upCols.join(',') || '(none)');
}

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const MGR = {
    role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const EMP = {
    role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const row = async () => (await db.query(
    'SELECT * FROM tenant WHERE id = $1', [ctx.tenant])).rows[0];
  const auditCount = async () => (await db.query(
    `SELECT count(*)::int n FROM audit_log
      WHERE tenant_id = $1 AND action = 'tenant_display_name_updated'`, [ctx.tenant])).rows[0].n;

  /* ---------------------------------------------------------------- *
   * 5. the read
   * ---------------------------------------------------------------- */

  console.log('\nthe profile reads the tenant in context\n');

  const read = await config.readTenantProfile(A);
  const raw = await row();
  ok('10. the display name comes back', read.displayName === raw.display_name,
    `${read.displayName} vs ${raw.display_name}`);
  ok('    and so does every read-only field',
    read.legalName === raw.legal_name && read.slug === raw.slug
    && read.status === raw.status && read.homeCountry === raw.home_country
    && read.baseCurrency === raw.base_currency
    && read.fiscalYearStartMonth === raw.fiscal_year_start_month
    && read.dataRegion === raw.data_region,
    JSON.stringify(read));
  ok('    the slug is a string, not a citext object', typeof read.slug === 'string');
  ok('    and created_at is an ISO string', typeof read.createdAt === 'string'
    && !Number.isNaN(Date.parse(read.createdAt)));

  ok('11. a manager may read it', (await config.readTenantProfile(MGR)).slug === raw.slug,
    'the product names the company in its own header');
  ok('    and so may an employee',
    (await config.readTenantProfile(EMP)).slug === raw.slug);

  /* ---------------------------------------------------------------- *
   * 6/7/8/9. the update
   * ---------------------------------------------------------------- */

  console.log('\nan administrator may rename the company\n');

  const renamed = await config.updateTenantDisplayName(A, 'ZZ Renamed Holdings');
  ok('12. the name changes', renamed.displayName === 'ZZ Renamed Holdings');
  ok('    in the row itself', (await row()).display_name === 'ZZ Renamed Holdings');

  const trimmed = await config.updateTenantDisplayName(A, '   ZZ Spaced Out   ');
  ok('13. whitespace is trimmed', trimmed.displayName === 'ZZ Spaced Out',
    JSON.stringify(trimmed.displayName));

  const unicode = await config.updateTenantDisplayName(A, '三六〇 Technologies Pvt Ltd — ₹');
  ok('14. unicode survives', unicode.displayName === '三六〇 Technologies Pvt Ltd — ₹',
    JSON.stringify(unicode.displayName));
  ok('    read back from the database unchanged',
    (await row()).display_name === '三六〇 Technologies Pvt Ltd — ₹');

  const inner = await config.updateTenantDisplayName(A, 'ZZ  Two  Spaces');
  ok('15. inner spacing is left alone — a name is a proper noun',
    inner.displayName === 'ZZ  Two  Spaces', JSON.stringify(inner.displayName));

  await refused('16. an empty name is refused',
    () => config.updateTenantDisplayName(A, '   '), /needs a name/);
  await refused('17. a missing name is refused',
    () => config.updateTenantDisplayName(A, undefined), /needs a name/);
  await refused('18. a non-string is refused, not coerced',
    () => config.updateTenantDisplayName(A, 42), /needs a name/);
  await refused('19. a name over 120 characters is refused',
    () => config.updateTenantDisplayName(A, 'Z'.repeat(121)), /at most 120 characters/);

  const exact = await config.updateTenantDisplayName(A, 'Z'.repeat(120));
  ok('20. exactly 120 is accepted', exact.displayName.length === 120);
  ok('    and 121 after trimming is still refused',
    (await attempt(() => config.updateTenantDisplayName(A, ` ${'Z'.repeat(121)} `))) !== null);

  await config.updateTenantDisplayName(A, 'ZZ Scratch');

  /* ---------------------------------------------------------------- *
   * 11/12. authorization
   * ---------------------------------------------------------------- */

  console.log('\nrenaming the company stays an administrator\'s\n');

  await refused('21. a manager cannot rename it',
    () => config.updateTenantDisplayName(MGR, 'ZZ Manager Was Here'), /only an admin/);
  await refused('22. an employee cannot rename it',
    () => config.updateTenantDisplayName(EMP, 'ZZ Employee Was Here'), /only an admin/);
  ok('    and the name did not move', (await row()).display_name === 'ZZ Scratch');

  /* ---------------------------------------------------------------- *
   * 13-19. the protected columns, refused by the engine
   * ---------------------------------------------------------------- */

  console.log('\nthe protected columns are refused by PostgreSQL, not by the service\n');

  /*
   * These bypass the service entirely and go through the `app_rw` connection.
   * Each must fail with 42501 — insufficient privilege — which is the engine
   * saying no. The service is not involved in any of them.
   */
  const asAppUpdate = async (col, value) => {
    const e = await attempt(() => asApp.query(
      `UPDATE tenant SET ${col} = $1 WHERE id = $2`, [value, ctx.tenant]));
    return e;
  };

  const attempts = [
    ['legal_name', 'ZZ Stolen Legal Name'],
    ['slug', 'zz-stolen-slug'],
    ['status', 'active'],
    ['home_country', 'US'],
    ['base_currency', 'USD'],
    ['fiscal_year_start_month', 1],
    ['data_region', 'us-east-1'],
    ['updated_at', new Date()],
  ];
  for (const [col, value] of attempts) {
    const e = await asAppUpdate(col, value);
    ok(`23. app_rw cannot UPDATE ${col}`, e !== null,
      `the statement succeeded — ${col} is writable and should not be`);
    ok('    refused as insufficient privilege', e?.code === '42501',
      `${e?.code}: ${e?.message}`);
  }

  ok('24. but app_rw CAN update display_name directly',
    (await attempt(() => asApp.query(
      'UPDATE tenant SET display_name = $1 WHERE id = $2',
      ['ZZ Scratch', ctx.tenant]))) === null,
    'the one column the grant opens');

  /* And the values themselves are what they were. */
  const now = await row();
  ok('25. slug is unchanged', now.slug === ctx.slug, `${now.slug} vs ${ctx.slug}`);
  ok('26. status is unchanged', now.status === 'active', now.status);
  ok('27. base_currency is unchanged', now.base_currency === 'INR', now.base_currency);
  ok('28. home_country is unchanged', now.home_country === 'IN', now.home_country);
  ok('29. fiscal_year_start_month is unchanged', now.fiscal_year_start_month === 4,
    String(now.fiscal_year_start_month));
  ok('30. data_region is unchanged', now.data_region === 'ap-south-1', now.data_region);
  ok('31. legal_name is unchanged', now.legal_name === 'ZZ Scratch Tenant', now.legal_name);

  /* ---------------------------------------------------------------- *
   * 20/21. audit
   * ---------------------------------------------------------------- */

  console.log('\nevery rename is recorded, and nothing else is\n');

  const logged = (await db.query(
    `SELECT action, category, subject_table, detail FROM audit_log
      WHERE tenant_id = $1 AND action = 'tenant_display_name_updated'
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ctx.tenant])).rows[0];
  ok('32. the rename is in audit_log', Boolean(logged));
  ok('    under the existing config category', logged?.category === 'config');
  ok('    against subject_table tenant', logged?.subject_table === 'tenant');
  ok('    with the action this phase introduced',
    logged?.action === 'tenant_display_name_updated', logged?.action);
  ok('    and the new name in the detail',
    typeof logged?.detail?.displayName === 'string', JSON.stringify(logged?.detail));
  ok('33. no second audit table was created',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%audit%'`)).rows[0].n === 1);

  const auditBefore = await auditCount();
  await attempt(() => config.updateTenantDisplayName(A, '  '));
  await attempt(() => config.updateTenantDisplayName(A, 'Z'.repeat(200)));
  await attempt(() => config.updateTenantDisplayName(MGR, 'ZZ No'));
  ok('34. a refused rename writes no audit row', (await auditCount()) === auditBefore,
    'a trail that records attempts as though they happened is worse than none');

  /* ---------------------------------------------------------------- *
   * 22. the modules that read the tenant still read it
   * ---------------------------------------------------------------- */

  console.log('\nthe reads a dozen modules perform still work\n');

  const ccy = (await asApp.query(
    'SELECT base_currency FROM tenant WHERE id = $1', [ctx.tenant])).rows[0];
  ok('35. base_currency still reads as INR', ccy?.base_currency === 'INR',
    'hiring, expenses, benefits, leave, assets and exits all read this');

  /* The exact expression config/service.ts uses to pick the leave year. */
  const leaveYear = (await asApp.query(
    `SELECT make_date(
              CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= t.fiscal_year_start_month
                   THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                   ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END,
              t.fiscal_year_start_month, 1) AS ys
       FROM tenant t WHERE t.id = $1`, [ctx.tenant])).rows[0];
  ok('36. the leave-year expression still resolves', Boolean(leaveYear?.ys),
    'a quota change reprices the year this picks');

  ok('37. and the display name is the renamed one throughout',
    (await config.readTenantProfile(A)).displayName === 'ZZ Scratch');

  /* ---------------------------------------------------------------- *
   * 10. isolation — and here the predicate is the only thing scoping
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (other) => {
    const B = {
      role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
    };

    console.log('\nwith no RLS on this table, the predicate is the whole boundary\n');

    await config.updateTenantDisplayName(B, 'ZZ Other Tenant Name');

    ok('38. the other tenant was renamed',
      (await db.query('SELECT display_name FROM tenant WHERE id = $1', [other.tenant]))
        .rows[0].display_name === 'ZZ Other Tenant Name');
    ok('39. and ours was not',
      (await row()).display_name === 'ZZ Scratch',
      'current_tenant_id() is the only thing scoping the UPDATE — RLS is off here');
    ok('40. each read returns its own tenant',
      (await config.readTenantProfile(A)).slug === ctx.slug
      && (await config.readTenantProfile(B)).slug === other.slug);
    ok('    and neither read returns the other\'s name',
      (await config.readTenantProfile(A)).displayName === 'ZZ Scratch'
      && (await config.readTenantProfile(B)).displayName === 'ZZ Other Tenant Name');

    /* No caller-supplied tenant id anywhere: the only identity is the context. */
    ok('41. the update takes no tenant argument at all',
      config.updateTenantDisplayName.length === 2,
      `arity ${config.updateTenantDisplayName.length} — a tenant id parameter would be one more`);
    ok('    and neither does the read', config.readTenantProfile.length === 1);

    /*
     * A caller naming a tenant that is not there.  returns
     * the id happily — it only raises when nothing is set — so the UPDATE matches
     * no rows, and the rowCount guard is what turns that into a refusal instead of
     * a silent success the caller would believe.
     */
    const GHOST = {
      role: 'admin', tenantId: '00000000-0000-0000-0000-0000000000ff',
      employeeId: null, userId: null,
    };
    await refused('42. a caller naming a tenant that does not exist is refused',
      () => config.updateTenantDisplayName(GHOST, 'ZZ Ghost'), /no tenant in context/);
    await refused('    and so is the read',
      () => config.readTenantProfile(GHOST), /no tenant in context/);
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
ok('display names unchanged', after.names === before.names,
  `was ${before.names}, now ${after.names}`);
ok('slugs unchanged', after.slugs === before.slugs, `was ${before.slugs}`);
ok('base currencies unchanged', after.ccy === before.ccy, `was ${before.ccy}`);
ok('statuses unchanged', after.statuses === before.statuses, `was ${before.statuses}`);
ok(`audit rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok('no scratch tenant remains',
  (await db.query("SELECT count(*)::int n FROM tenant WHERE slug LIKE 'zz-scratch-%'"))
    .rows[0].n === 0);

await asApp.end();
await db.end();

if (fatal) {
  console.error(`\nthe run did not finish: ${fatal.message}`);
  console.error(fatal.stack);
  process.exit(1);
}

console.log();
if (failed) {
  console.error(`${failed} tenant profile checks failed`);
  process.exit(1);
}
console.log('a tenant may rename itself; the database refuses everything else about it');
