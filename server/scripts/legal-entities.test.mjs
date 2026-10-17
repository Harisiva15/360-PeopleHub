/**
 * The registered company, and the one rule the schema does not hold.
 *
 * `legal_entity` has existed since `0002_org_config.sql` and three tables have
 * carried a NOT NULL reference to it ever since — `employee`, `pay_run` and
 * `compliance_payment`. Nothing in the product could create, read or edit one.
 * Only `scripts/seed.mjs` could, which meant a tenant onboarded any other way
 * held no entity and therefore could not run payroll, submit an expense or
 * create an employee: three services refuse outright with 'no default legal
 * entity configured'.
 *
 * Phase 2e is CRUD over those existing columns. **No migration**, and the first
 * assertions below prove that by reading the catalogue: thirteen columns, the
 * same thirteen 0002 created.
 *
 * ## What is worth holding
 *
 * **Exactly one default, always.** This is the part the database does not
 * enforce. `site` has `site_one_headquarters` to refuse two head offices;
 * `legal_entity` has no such index, so the demote-then-promote inside one
 * transaction is the only thing holding the rule. It is asserted after every
 * switch, not just once — a rule enforced in application code earns a closer
 * look than one the database refuses.
 *
 * **The first entity in a tenant becomes the default.** Not a rule invented
 * here: `payroll`, `expenses` and `people/provision` each refuse to work without
 * one, and `seed.mjs` has always written `is_default = true`. Creating the first
 * entity without defaulting it would leave a tenant holding an entity and still
 * unable to run payroll.
 *
 * **The code cannot move.** Three tables join on it. A code change is refused
 * rather than ignored, because silently dropping it reports a rename that did
 * not happen.
 *
 * **Nothing existing is disturbed.** The live tenant's employee, its entity and
 * its `legal_entity_id` are compared before and after, and the lookup payroll
 * actually performs — `SELECT id FROM legal_entity WHERE is_default` — is run
 * directly to prove it still returns exactly one row.
 *
 * Everything runs in scratch tenants, dropped in one statement each.
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
  console.log('\nSKIPPED: no database, and the one-default rule needs one to hold.\n');
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
/** A refusal, not a crash: the service must say no in its own vocabulary. */
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
  SELECT (SELECT count(*)::int FROM legal_entity) le,
         (SELECT count(*)::int FROM legal_entity WHERE is_default) defaults,
         (SELECT count(*)::int FROM employee) emp,
         (SELECT count(*)::int FROM employee WHERE legal_entity_id IS NOT NULL) assigned,
         (SELECT count(*)::int FROM pay_run) runs,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * 1. the schema, read from the catalogue — no migration was written
 * ------------------------------------------------------------------ */

console.log('\nthe table is exactly the one 0002 created\n');

{
  const cols = (await db.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'legal_entity' ORDER BY ordinal_position`)).rows;
  ok('1. thirteen columns, unchanged', cols.length === 13,
    `${cols.length}: ${cols.map((c) => c.column_name).join(', ')}`);

  const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  for (const name of ['id', 'tenant_id', 'code', 'legal_name', 'country', 'currency',
    'registered_address', 'tax_id', 'registration_id', 'pf_code', 'esi_code',
    'is_default', 'created_at']) {
    ok(`    ${name}`, Boolean(by[name]), 'missing');
  }
  ok('2. no active column was added', by.active === undefined,
    'this phase identified no workflow that needed one');
  ok('    tenant_id still defaults to current_tenant_id()',
    by.tenant_id?.column_default === 'current_tenant_id()', by.tenant_id?.column_default);
  ok('    is_default still defaults to false',
    by.is_default?.column_default === 'false', by.is_default?.column_default);
  ok('    country is char(2) and currency char(3), the width their foreign keys enforce',
    by.country?.data_type === 'character' && by.currency?.data_type === 'character');

  /*
   * The rule the database does not hold. Asserted so that if a later migration
   * ever adds the index, this line is what says the service guard became
   * belt-and-braces rather than the only thing standing.
   */
  const partial = (await db.query(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'legal_entity' AND indexdef ILIKE '%is_default%'`)).rows;
  ok('3. there is still no index enforcing one default', partial.length === 0,
    `${JSON.stringify(partial)} — if this is intentional, the service guard is now redundant`);

  const rls = (await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = 'legal_entity'`)).rows[0];
  ok('4. RLS is enabled and forced',
    rls?.relrowsecurity === true && rls?.relforcerowsecurity === true, JSON.stringify(rls));

  const grants = (await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'legal_entity' AND grantee = 'app_rw' ORDER BY privilege_type`
  )).rows.map((r) => r.privilege_type);
  ok('    and app_rw has all four grants',
    grants.join(',') === 'DELETE,INSERT,SELECT,UPDATE', grants.join(','));

  const fks = (await db.query(
    `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS d
       FROM pg_constraint WHERE confrelid = 'legal_entity'::regclass ORDER BY 1`)).rows;
  ok('5. three tables reference it, all carrying tenant_id', fks.length === 3
    && fks.every((f) => /\(tenant_id, legal_entity_id\) REFERENCES legal_entity\(tenant_id, id\)/
      .test(f.d)),
    JSON.stringify(fks));
  ok('    and business_unit is not one of them',
    fks.every((f) => f.tbl !== 'business_unit'),
    'a business unit is a sibling dimension, not a child of the entity');
}

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const MGR = {
    role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const EMP = {
    role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  /** Exactly one default, checked from the database rather than from a return value. */
  const defaults = async () => (await db.query(
    'SELECT code FROM legal_entity WHERE tenant_id = $1 AND is_default ORDER BY code',
    [ctx.tenant])).rows.map((r) => r.code);

  /* ---------------------------------------------------------------- *
   * 2/3. list and get
   * ---------------------------------------------------------------- */

  console.log('\nthe scratch tenant arrives with one default entity\n');

  const seeded = await config.listLegalEntities(A);
  ok('6. the list returns it', seeded.length === 1 && seeded[0].code === 'ZZ01',
    JSON.stringify(seeded.map((e) => e.code)));
  ok('    with the default flag set', seeded[0]?.isDefault === true);
  ok('    the country code comes back as a bare code', seeded[0]?.country === 'IN',
    JSON.stringify(seeded[0]?.country));
  ok('    and so does the currency', seeded[0]?.currency === 'INR',
    JSON.stringify(seeded[0]?.currency));
  ok('    and the headcount it employs', seeded[0]?.headcount === 1,
    `${seeded[0]?.headcount} — the scratch admin is employed by it`);
  ok('    optional identifiers come back as null, not empty strings',
    seeded[0]?.taxId === null && seeded[0]?.pfCode === null,
    JSON.stringify([seeded[0]?.taxId, seeded[0]?.pfCode]));

  const got = await config.getLegalEntity(A, 'zz01');
  ok('7. get resolves a lower-case code', got.code === 'ZZ01');
  await refused('    and refuses an unknown one',
    () => config.getLegalEntity(A, 'NOPE'), /no such legal entity/);

  ok('8. a manager may read the entity',
    (await config.listLegalEntities(MGR)).length === 1,
    'a payslip names the employing company, so resolving it is not privileged');
  ok('    and so may an employee', (await config.listLegalEntities(EMP)).length === 1);

  /* ---------------------------------------------------------------- *
   * 4/5. create and update
   * ---------------------------------------------------------------- */

  console.log('\na second entity can be registered, and does not steal the default\n');

  const made = await config.createLegalEntity(A, {
    code: 'gb01', legalName: '  ZZ Scratch UK  ', country: 'gb', currency: 'inr',
    registeredAddress: ' 1 Fleet Street ', taxId: ' GB123456789 ', pfCode: '  ',
  });
  ok('9. the code is upper-cased', made.code === 'GB01');
  ok('    the name is trimmed', made.legalName === 'ZZ Scratch UK', made.legalName);
  ok('    country and currency are upper-cased',
    made.country === 'GB' && made.currency === 'INR',
    JSON.stringify([made.country, made.currency]));
  ok('    an optional identifier is trimmed', made.taxId === 'GB123456789', made.taxId);
  ok('    and a blank one becomes null rather than an empty string',
    made.pfCode === null, JSON.stringify(made.pfCode));
  ok('    its headcount is zero', made.headcount === 0);
  ok('10. it is NOT the default — the first entity already is',
    made.isDefault === false);
  ok('    and the tenant still has exactly one default',
    (await defaults()).join(',') === 'ZZ01', (await defaults()).join(','));

  const patched = await config.updateLegalEntity(A, 'GB01', {
    legalName: 'ZZ Scratch UK Limited',
    registrationId: '09876543',
  });
  ok('11. an update replaces what it names', patched.legalName === 'ZZ Scratch UK Limited'
    && patched.registrationId === '09876543');
  ok('    and leaves absent fields alone', patched.taxId === 'GB123456789'
    && patched.country === 'GB', JSON.stringify([patched.taxId, patched.country]));
  ok('    and does not touch the default flag', patched.isDefault === false);

  const cleared = await config.updateLegalEntity(A, 'GB01', { taxId: '' });
  ok('12. a blank clears an optional identifier', cleared.taxId === null,
    JSON.stringify(cleared.taxId));
  const untouched = await config.updateLegalEntity(A, 'GB01', { legalName: 'ZZ Scratch UK' });
  ok('    while absent still leaves it alone', untouched.registrationId === '09876543');

  /* ---------------------------------------------------------------- *
   * 6/7/8/9. validation
   * ---------------------------------------------------------------- */

  console.log('\nvalidation, since the table carries no CHECK constraints at all\n');

  await refused('13. a blank code is refused',
    () => config.createLegalEntity(A, { code: '  ', legalName: 'x', country: 'IN', currency: 'INR' }),
    /needs a code/);
  await refused('14. a code that is not a code is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZ 01!', legalName: 'x', country: 'IN', currency: 'INR' }),
    /2-10 letters or digits/);
  await refused('15. a blank legal name is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZBL', legalName: '   ', country: 'IN', currency: 'INR' }),
    /registered name/);
  await refused('    and renaming to blank is refused',
    () => config.updateLegalEntity(A, 'GB01', { legalName: '  ' }), /registered name/);
  await refused('16. a duplicate code is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZ01', legalName: 'x', country: 'IN', currency: 'INR' }),
    /already a legal entity/);
  await refused('17. a country that is not two letters is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZCO', legalName: 'x', country: 'IND', currency: 'INR' }),
    /two-letter code/);
  await refused('    and a country that is not in the reference table is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZCO', legalName: 'x', country: 'ZZ', currency: 'INR' }),
    /23503|does not exist/);
  await refused('18. a currency that is not three letters is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZCU', legalName: 'x', country: 'IN', currency: 'IN' }),
    /three-letter code/);
  await refused('    and one that is not in the reference table is refused',
    () => config.createLegalEntity(A,
      { code: 'ZZCU', legalName: 'x', country: 'IN', currency: 'ZZZ' }),
    /23503|does not exist/);
  await refused('19. a missing currency is refused on a create',
    () => config.createLegalEntity(A, { code: 'ZZNC', legalName: 'x', country: 'IN' }),
    /needs a currency/);
  await refused('20. the code cannot change',
    () => config.updateLegalEntity(A, 'GB01', { code: 'GB02' }),
    /code cannot change/);
  ok('    and nothing was renamed by the attempt',
    (await config.getLegalEntity(A, 'GB01')).code === 'GB01');
  await refused('21. updating an entity that does not exist is refused',
    () => config.updateLegalEntity(A, 'NOPE', { legalName: 'x' }), /no such legal entity/);

  /* ---------------------------------------------------------------- *
   * 10/11. the default, which only the service holds
   * ---------------------------------------------------------------- */

  console.log('\nthe default moves, and there is never more than one\n');

  const moved = await config.setDefaultLegalEntity(A, 'gb01');
  ok('22. the default moves to the named entity', moved.isDefault === true);
  ok('    and exactly one row carries it', (await defaults()).join(',') === 'GB01',
    (await defaults()).join(','));
  ok('    the previous default was demoted in the same step',
    (await config.getLegalEntity(A, 'ZZ01')).isDefault === false);

  /* Switched repeatedly, because this rule has no index behind it. */
  for (const code of ['ZZ01', 'GB01', 'ZZ01', 'ZZ01', 'GB01']) {
    await config.setDefaultLegalEntity(A, code);
    const now = await defaults();
    ok(`23. after setting ${code} there is exactly one default`,
      now.length === 1 && now[0] === code, now.join(','));
  }

  ok('24. setting the entity that is already default is a no-op, not a refusal',
    (await config.setDefaultLegalEntity(A, 'GB01')).isDefault === true
    && (await defaults()).length === 1);

  await refused('25. an entity that does not exist cannot become default',
    () => config.setDefaultLegalEntity(A, 'NOPE'), /no such legal entity/);
  ok('    and the default did not move', (await defaults()).join(',') === 'GB01');

  /* The lookup payroll, expenses and provisioning actually perform. */
  const asPayroll = (await db.query(
    'SELECT id FROM legal_entity WHERE tenant_id = $1 AND is_default', [ctx.tenant])).rows;
  ok('26. the lookup payroll performs still returns exactly one row',
    asPayroll.length === 1,
    `${asPayroll.length} — "SELECT id FROM legal_entity WHERE is_default LIMIT 1" must be unambiguous`);

  await config.setDefaultLegalEntity(A, 'ZZ01');

  /* ---------------------------------------------------------------- *
   * 15/16/17. authorization
   * ---------------------------------------------------------------- */

  console.log('\nconfiguring the tenant stays an administrator\'s\n');

  await refused('27. a manager cannot create one',
    () => config.createLegalEntity(MGR,
      { code: 'ZZNO', legalName: 'x', country: 'IN', currency: 'INR' }), /only an admin/);
  await refused('28. a manager cannot update one',
    () => config.updateLegalEntity(MGR, 'ZZ01', { legalName: 'x' }), /only an admin/);
  await refused('29. a manager cannot move the default',
    () => config.setDefaultLegalEntity(MGR, 'GB01'), /only an admin/);
  await refused('30. an employee cannot create one',
    () => config.createLegalEntity(EMP,
      { code: 'ZZNO', legalName: 'x', country: 'IN', currency: 'INR' }), /only an admin/);
  await refused('31. an employee cannot update one',
    () => config.updateLegalEntity(EMP, 'ZZ01', { legalName: 'x' }), /only an admin/);
  await refused('32. an employee cannot move the default',
    () => config.setDefaultLegalEntity(EMP, 'GB01'), /only an admin/);
  ok('    and after six refusals nothing moved',
    (await defaults()).join(',') === 'ZZ01'
    && (await config.getLegalEntity(A, 'ZZ01')).legalName === 'ZZ Scratch Entity',
    'a refusal must not half-apply');

  /* ---------------------------------------------------------------- *
   * 18. audit
   * ---------------------------------------------------------------- */

  console.log('\nevery write goes through the existing audit trail\n');

  const logged = async (action, code) => (await db.query(
    `SELECT action, category, subject_table, detail FROM audit_log
      WHERE tenant_id = $1 AND subject_table = 'legal_entity'
        AND action = $2 AND detail ->> 'legalEntity' = $3
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ctx.tenant, action, code])).rows[0];

  const createdRow = await logged('legal_entity_created', 'GB01');
  ok('33. the create is recorded', Boolean(createdRow));
  ok('    under the existing config category', createdRow?.category === 'config');
  ok('    against subject_table legal_entity', createdRow?.subject_table === 'legal_entity');
  ok('    and the detail says whether it became the default',
    createdRow?.detail?.isDefault === false, JSON.stringify(createdRow?.detail));

  ok('34. the update is recorded', Boolean(await logged('legal_entity_updated', 'GB01')));
  const defRow = await logged('legal_entity_default_changed', 'ZZ01');
  ok('35. the default change is recorded', Boolean(defRow));
  ok('    as its own action, not as an update',
    defRow?.action === 'legal_entity_default_changed', defRow?.action);

  ok('36. no second audit table was created',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%audit%'`)).rows[0].n === 1);

  /* ---------------------------------------------------------------- *
   * 19/20. nothing existing was disturbed
   * ---------------------------------------------------------------- */

  console.log('\nthe employee already employed by it is untouched\n');

  const emp = (await db.query(
    `SELECT e.code, e.legal_entity_id, l.code AS entity_code
       FROM employee e JOIN legal_entity l ON l.id = e.legal_entity_id
      WHERE e.tenant_id = $1`, [ctx.tenant])).rows;
  ok('37. the scratch admin still points at ZZ01', emp.length === 1
    && emp[0].entity_code === 'ZZ01', JSON.stringify(emp));
  ok('    and the reference resolves, so nothing was orphaned',
    emp[0]?.legal_entity_id === ctx.entityId, JSON.stringify([emp[0]?.legal_entity_id, ctx.entityId]));

  /* ---------------------------------------------------------------- *
   * 12. the first entity in a tenant becomes the default
   * ---------------------------------------------------------------- */

  console.log('\nthe first entity in a tenant becomes the default\n');

  /*
   * A bare tenant, because every scratch tenant arrives with an entity already.
   * No employee either, so `employeeId` is null — which the Caller type allows
   * for an admin who is not on payroll, and which means the audit insert writes
   * nothing. That is the existing behaviour of every config write, not something
   * this phase introduced.
   */
  const bare = (await db.query(
    `INSERT INTO tenant (slug, legal_name, display_name, home_country,
                         base_currency, fiscal_year_start_month, status)
     VALUES ($1::citext, 'ZZ Bare', 'ZZ Bare', 'IN', 'INR', 4, 'active')
     RETURNING id`,
    [`zz-scratch-bare-${Date.now().toString(36)}`])).rows[0].id;

  const BARE = { role: 'admin', tenantId: bare, employeeId: null, userId: null };
  ok('38. the bare tenant has no entity at all',
    (await config.listLegalEntities(BARE)).length === 0);

  const firstOne = await config.createLegalEntity(BARE,
    { code: 'IN01', legalName: 'ZZ Bare India', country: 'IN', currency: 'INR' });
  ok('39. the first entity becomes the default', firstOne.isDefault === true,
    'payroll, expenses and provisioning each refuse to run without one');

  const secondOne = await config.createLegalEntity(BARE,
    { code: 'IN02', legalName: 'ZZ Bare Two', country: 'IN', currency: 'INR' });
  ok('40. the second does not', secondOne.isDefault === false);
  ok('    and the tenant has exactly one default',
    (await db.query('SELECT count(*)::int n FROM legal_entity WHERE tenant_id = $1 AND is_default',
      [bare])).rows[0].n === 1);

  /* ---------------------------------------------------------------- *
   * 13/14. tenant isolation
   * ---------------------------------------------------------------- */

  console.log('\nneither tenant can see or touch the other\'s entity\n');

  ok('41. the bare tenant does not see the scratch tenant\'s entities',
    (await config.listLegalEntities(BARE)).every((e) => e.code !== 'GB01'),
    'row level security is the boundary');
  ok('42. and the scratch tenant does not see the bare tenant\'s',
    (await config.listLegalEntities(A)).every((e) => e.code !== 'IN02'));

  await refused('43. a cross-tenant read is a not-found, not another tenant\'s row',
    () => config.getLegalEntity(BARE, 'GB01'), /no such legal entity/);
  await refused('44. a cross-tenant update is refused',
    () => config.updateLegalEntity(BARE, 'GB01', { legalName: 'stolen' }),
    /no such legal entity/);
  await refused('45. and a cross-tenant default change is refused',
    () => config.setDefaultLegalEntity(BARE, 'GB01'), /no such legal entity/);
  ok('    the other tenant\'s name is unchanged',
    (await config.getLegalEntity(A, 'GB01')).legalName === 'ZZ Scratch UK');
  ok('    and its default did not move', (await defaults()).join(',') === 'ZZ01');

  /*
   * The same code exists in both tenants, which is what UNIQUE (tenant_id, code)
   * is for. Each resolves to its own row.
   */
  const dupe = await config.createLegalEntity(A,
    { code: 'IN01', legalName: 'ZZ Scratch India', country: 'IN', currency: 'INR' });
  ok('46. the same code may exist in two tenants', dupe.code === 'IN01');
  ok('    and each resolves to its own row',
    (await config.getLegalEntity(A, 'IN01')).legalName === 'ZZ Scratch India'
    && (await config.getLegalEntity(BARE, 'IN01')).legalName === 'ZZ Bare India');

  await db.query('DELETE FROM tenant WHERE id = $1', [bare]);
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
  await db.query("DELETE FROM tenant WHERE slug LIKE 'zz-scratch-bare-%'");
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`legal entities ${after.le}`, after.le === before.le, `was ${before.le}`);
ok(`defaults ${after.defaults}`, after.defaults === before.defaults,
  `was ${before.defaults} — the live tenant's default did not move`);
ok(`employees ${after.emp}`, after.emp === before.emp, `was ${before.emp}`);
ok(`employees with an entity ${after.assigned}`, after.assigned === before.assigned,
  `was ${before.assigned} — no existing assignment was changed`);
ok(`pay runs ${after.runs}`, after.runs === before.runs, `was ${before.runs}`);
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
ok(`audit rows ${after.a}`, after.a === before.a, `was ${before.a}`);
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
  console.error(`${failed} legal entity checks failed`);
  process.exit(1);
}
console.log('a tenant has legal entities it can edit, and exactly one of them is the default');
