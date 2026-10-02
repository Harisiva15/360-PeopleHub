/**
 * A department belongs to a business unit.
 *
 * Migration 0052 put a nullable `business_unit_id` on `department` behind a
 * composite foreign key. `department` had been altered once in fifty-one
 * migrations and ten tables carry a composite key to it, so the bar for touching
 * it was high — and this suite is the evidence that it was cleared.
 *
 * ## What is worth holding
 *
 * **Nothing is assigned implicitly.** The column is nullable, has no default, and
 * the migration backfills nothing. A department that predates business units must
 * keep working with no assignment at all, and the first assertions below read that
 * straight out of the catalogue rather than trusting the migration text.
 *
 * **Absent and null are different requests.** Omitting the field leaves the
 * assignment alone; sending null removes it. Collapsing those two would make
 * "rename this department" quietly clear its business unit.
 *
 * **An inactive unit cannot be assigned, and deactivating one changes nothing
 * already assigned.** Those are two different rules and both are tested: the
 * convention locations and projects follow is that an inactive row stays readable
 * so old records resolve, and is not offered for new work.
 *
 * **Cross-tenant is unrepresentable, not merely refused.** The decisive assertion
 * does a direct INSERT on the migration connection — which bypasses row level
 * security — pointing one tenant's department at another tenant's unit. The
 * composite key has to refuse it. That is the property the whole design rests on,
 * and it is not an application rule.
 *
 * Everything runs in scratch tenants, dropped in one statement each. The live
 * tenant is never addressed and its row counts are compared before and after.
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
  console.log('\nSKIPPED: no database, and this relationship is two columns in one.\n');
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
  SELECT (SELECT count(*)::int FROM department) d,
         (SELECT count(*)::int FROM department WHERE business_unit_id IS NOT NULL) assigned,
         (SELECT count(*)::int FROM business_unit) u,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * A department belongs to a business unit
 *
 * Added with migration 0052, which put a nullable `business_unit_id` on
 * `department` behind a composite foreign key. The things worth pinning down are
 * the ones a nullable cross-table reference gets wrong:
 *
 *   - existing departments keep working with no assignment at all,
 *   - nothing is assigned implicitly,
 *   - absent and null differ on a patch — one leaves the assignment alone, the
 *     other removes it,
 *   - an inactive unit cannot be assigned, but deactivating a unit does not
 *     rewrite the departments already pointing at it,
 *   - and tenant A cannot reach tenant B's unit, which the composite key makes
 *     unrepresentable rather than merely refused.
 * ------------------------------------------------------------------ */

console.log('\na department belongs to a business unit\n');

{
  /* The migration itself, read from the catalogue rather than assumed. */
  const col = (await db.query(
    `SELECT is_nullable, data_type, column_default
       FROM information_schema.columns
      WHERE table_name = 'department' AND column_name = 'business_unit_id'`)).rows[0];
  ok('1. the column exists', Boolean(col));
  ok('    nullable, so existing departments stay valid', col?.is_nullable === 'YES',
    JSON.stringify(col));
  ok('    a uuid', col?.data_type === 'uuid', col?.data_type);
  ok('    with no default, so nothing is assigned implicitly',
    col?.column_default === null, String(col?.column_default));

  const fk = (await db.query(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conname = 'department_business_unit_fkey'`)).rows[0];
  ok('2. the foreign key exists', Boolean(fk), JSON.stringify(fk));
  ok('    and carries tenant_id on both sides, so it cannot point across tenants',
    /\(tenant_id, business_unit_id\) REFERENCES business_unit\(tenant_id, id\)/.test(fk?.d ?? ''),
    fk?.d);

  const ix = (await db.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'department_tenant_business_unit_idx'`
  )).rows[0];
  ok('3. the index leads with tenant_id',
    /\(tenant_id, business_unit_id\)/.test(ix?.indexdef ?? ''), ix?.indexdef);

  const rls = (await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'department'`
  )).rows[0];
  ok('4. department RLS is still enabled and forced',
    rls?.relrowsecurity === true && rls?.relforcerowsecurity === true, JSON.stringify(rls));

  const grants = (await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'department' AND grantee = 'app_rw' ORDER BY privilege_type`
  )).rows.map((r) => r.privilege_type);
  ok('    and app_rw still has all four grants',
    grants.join(',') === 'DELETE,INSERT,SELECT,UPDATE', grants.join(','));
}

await withScratchTenant(db, async (ctx) => {
  const A = { role: 'admin', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const MGR = { role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };
  const EMP = { role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null };

  /* The scratch tenant arrives with a department and no business units. */
  const seeded = await config.listDepartments(A);
  ok('5. a department that predates business units has none assigned',
    seeded.length > 0 && seeded.every((d) => d.businessUnitCode === null),
    JSON.stringify(seeded.map((d) => [d.code, d.businessUnitCode])));
  ok('    and still resolves everything else about itself',
    seeded.every((d) => d.code && d.name && typeof d.headcount === 'number'));

  const unit = await config.createBusinessUnit(A, { code: 'BU-OPS', name: 'Operations' });
  const idle = await config.createBusinessUnit(A, { code: 'BU-OLD', name: 'Wound Down' });
  await config.setBusinessUnitActive(A, 'BU-OLD', false);

  console.log('\ncreating a department with and without a unit\n');

  const withUnit = await config.createDepartment(A, {
    code: 'ZZOPS', name: 'ZZ Operations', businessUnitCode: 'bu-ops',
  });
  ok('6. a department can be created with a business unit',
    withUnit.businessUnitCode === 'BU-OPS', withUnit.businessUnitCode);
  ok('    the code is matched case-insensitively', unit.code === 'BU-OPS');
  ok('    and the name is resolved for display',
    withUnit.businessUnitName === 'Operations', withUnit.businessUnitName);

  const noUnit = await config.createDepartment(A, { code: 'ZZNONE', name: 'ZZ Unassigned' });
  ok('7. a department can be created without one',
    noUnit.businessUnitCode === null && noUnit.businessUnitName === null,
    JSON.stringify([noUnit.businessUnitCode, noUnit.businessUnitName]));

  const nulled = await config.createDepartment(A, {
    code: 'ZZNULL', name: 'ZZ Explicit Null', businessUnitCode: null,
  });
  ok('    and an explicit null is the same as omitting it', nulled.businessUnitCode === null);

  const stored = (await db.query(
    `SELECT d.code, b.code AS unit FROM department d
       LEFT JOIN business_unit b ON b.id = d.business_unit_id
      WHERE d.tenant_id = $1 AND d.code IN ('ZZOPS', 'ZZNONE') ORDER BY d.code`,
    [ctx.tenant])).rows;
  ok('    and the database agrees, not just the response',
    JSON.stringify(stored) === JSON.stringify([
      { code: 'ZZNONE', unit: null }, { code: 'ZZOPS', unit: 'BU-OPS' }]),
    JSON.stringify(stored));

  console.log('\nwhat cannot be assigned\n');

  await refused('8. an unknown business unit is refused',
    () => config.createDepartment(A, { code: 'ZZBAD', name: 'ZZ Bad', businessUnitCode: 'NOPE' }),
    /no such business unit/i);
  ok('    and no department was created',
    (await config.listDepartments(A)).every((d) => d.code !== 'ZZBAD'));

  await refused('9. an inactive business unit cannot be assigned',
    () => config.createDepartment(A, {
      code: 'ZZIDLE', name: 'ZZ Idle', businessUnitCode: 'BU-OLD',
    }), /inactive/i);
  ok('    the refusal says what to do about it',
    /activate it first/i.test(
      (await attempt(() => config.updateDepartment(A, 'ZZNONE', {
        name: 'ZZ Unassigned', businessUnitCode: 'BU-OLD',
      })))?.message ?? ''));

  const badUnit = await attempt(() => config.updateDepartment(A, 'ZZNONE', {
    name: 'ZZ Unassigned', businessUnitCode: 'NOPE',
  }));
  ok('    an invalid unit is a 400, not a 404 on the department',
    badUnit?.code === 'invalid', badUnit?.code);

  console.log('\nchanging and removing an assignment\n');

  const moved = await config.updateDepartment(A, 'ZZNONE', {
    name: 'ZZ Unassigned', businessUnitCode: 'BU-OPS',
  });
  ok('10. an unassigned department can be assigned', moved.businessUnitCode === 'BU-OPS');

  const again = await config.updateDepartment(A, 'ZZNONE', {
    name: 'ZZ Unassigned', businessUnitCode: 'BU-OPS',
  });
  ok('    assigning the same unit twice is not an error',
    again.businessUnitCode === 'BU-OPS');

  const untouched = await config.updateDepartment(A, 'ZZNONE', { name: 'ZZ Renamed' });
  ok('11. omitting the field leaves the assignment alone',
    untouched.businessUnitCode === 'BU-OPS' && untouched.name === 'ZZ Renamed',
    `${untouched.businessUnitCode} / ${untouched.name}`);

  const cleared = await config.updateDepartment(A, 'ZZNONE', {
    name: 'ZZ Renamed', businessUnitCode: null,
  });
  ok('12. an explicit null removes the assignment',
    cleared.businessUnitCode === null && cleared.businessUnitName === null,
    JSON.stringify([cleared.businessUnitCode, cleared.businessUnitName]));
  ok('    and the department is otherwise unchanged',
    cleared.code === 'ZZNONE' && cleared.name === 'ZZ Renamed' && cleared.active === true);

  console.log('\ndeactivating a unit does not rewrite the departments naming it\n');

  await config.setBusinessUnitActive(A, 'BU-OPS', false);
  const still = (await config.listDepartments(A)).find((d) => d.code === 'ZZOPS');
  ok('13. a department keeps a unit that is later deactivated',
    still?.businessUnitCode === 'BU-OPS', still?.businessUnitCode);
  ok('    and the name still resolves, so the screen is not left with a dash',
    still?.businessUnitName === 'Operations', still?.businessUnitName);
  await refused('    but it can no longer be assigned to anybody else',
    () => config.updateDepartment(A, 'ZZNULL', {
      name: 'ZZ Explicit Null', businessUnitCode: 'BU-OPS',
    }), /inactive/i);

  /*
   * And the department that already names it stays editable. The edit form sends
   * the whole record, so without this a deactivated unit would make every
   * department under it unsaveable — refused over a field nobody touched.
   */
  const reSent = await config.updateDepartment(A, 'ZZOPS', {
    name: 'ZZ Operations Renamed', businessUnitCode: 'BU-OPS',
  });
  ok('    and a department already naming it is still editable',
    reSent.name === 'ZZ Operations Renamed' && reSent.businessUnitCode === 'BU-OPS',
    `${reSent.name} / ${reSent.businessUnitCode}`);
  const clearedIdle = await config.updateDepartment(A, 'ZZOPS', {
    name: 'ZZ Operations Renamed', businessUnitCode: null,
  });
  ok('    and can be unassigned from it',
    clearedIdle.businessUnitCode === null, clearedIdle.businessUnitCode);

  await config.setBusinessUnitActive(A, 'BU-OPS', true);
  await config.updateDepartment(A, 'ZZOPS', {
    name: 'ZZ Operations', businessUnitCode: 'BU-OPS',
  });

  console.log('\nonly an admin assigns\n');

  for (const [who, c] of [['a manager', MGR], ['an employee', EMP]]) {
    await refused(`14. ${who} cannot assign a business unit`,
      () => config.updateDepartment(c, 'ZZOPS', {
        name: 'ZZ Operations', businessUnitCode: 'BU-OPS',
      }), /only an admin/i);
    await refused(`    nor create a department with one`,
      () => config.createDepartment(c, {
        code: 'ZZTHEIRS', name: 'ZZ Theirs', businessUnitCode: 'BU-OPS',
      }), /only an admin/i);
  }
  ok('    and both may still read the list, as before',
    (await config.listDepartments(MGR)).length > 0
    && (await config.listDepartments(EMP)).length > 0);

  console.log('\nexisting employees still resolve\n');

  const empRow = (await db.query(
    `SELECT e.code, d.code AS dept, b.code AS unit
       FROM employee e
       LEFT JOIN department d ON d.id = e.department_id
       LEFT JOIN business_unit b ON b.id = d.business_unit_id
      WHERE e.tenant_id = $1 AND e.department_id IS NOT NULL LIMIT 1`,
    [ctx.tenant])).rows[0];
  ok('15. an employee still resolves to their department',
    Boolean(empRow?.dept), JSON.stringify(empRow));
  ok('    and through it to a unit, or to null where none is assigned',
    empRow !== undefined && (empRow.unit === null || typeof empRow.unit === 'string'),
    JSON.stringify(empRow));

  console.log('\nthe composite key, and the tenant boundary\n');

  await withScratchTenant(db, async (other) => {
    const B = {
      role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
    };
    const theirs = await config.createBusinessUnit(B, { code: 'BU-OPS', name: 'Their Ops' });
    ok('16. the same unit code exists in both tenants', theirs.code === 'BU-OPS');

    await refused('17. tenant B cannot assign tenant A\'s department to anything',
      () => config.updateDepartment(B, 'ZZOPS', { name: 'Hijacked' }),
      /no such department/i);

    const theirDept = await config.createDepartment(B, {
      code: 'ZZTHEIR', name: 'ZZ Theirs', businessUnitCode: 'BU-OPS',
    });
    ok('    and gets its own unit when it uses the same code',
      theirDept.businessUnitName === 'Their Ops', theirDept.businessUnitName);

    /*
     * The decisive one. A direct INSERT with the migration connection, which
     * bypasses RLS, pointing one tenant's department at the other tenant's unit.
     * The composite foreign key has to refuse it — this is the property the whole
     * design rests on, and it is not an application rule.
     */
    const ourUnitId = (await db.query(
      'SELECT id FROM business_unit WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, 'BU-OPS'])).rows[0].id;
    const crossFk = await attempt(() => db.query(
      `INSERT INTO department (tenant_id, code, name, business_unit_id)
       VALUES ($1, 'ZZCROSS', 'ZZ Cross Tenant', $2)`,
      [other.tenant, ourUnitId]));
    ok('18. the composite key refuses a cross-tenant reference outright',
      crossFk !== null, 'a department was pointed at another tenant\'s business unit');
    ok('    as a foreign key violation, at the database',
      /foreign key|violates/i.test(crossFk?.message ?? ''), crossFk?.message);

    const crossUpdate = await attempt(() => db.query(
      'UPDATE department SET business_unit_id = $2 WHERE tenant_id = $1 AND code = $3',
      [other.tenant, ourUnitId, 'ZZTHEIR']));
    ok('    and refuses it on an update too', crossUpdate !== null,
      'an existing department was repointed across tenants');
  });

  console.log('\nthe assignment is audited\n');

  const audit = (await db.query(
    `SELECT action, detail FROM audit_log
      WHERE tenant_id = $1 AND subject_table = 'department' ORDER BY id`,
    [ctx.tenant])).rows;
  ok('19. a create records the unit it was given',
    audit.some((r) => r.action === 'department_created' && r.detail?.businessUnit === 'bu-ops'),
    JSON.stringify(audit.filter((r) => r.action === 'department_created').map((r) => r.detail)));
  ok('    a create with none records null, rather than omitting it',
    audit.some((r) => r.action === 'department_created'
      && Object.prototype.hasOwnProperty.call(r.detail ?? {}, 'businessUnit')
      && r.detail.businessUnit === null));
  ok('20. an assignment change is recorded',
    audit.some((r) => r.action === 'department_updated' && r.detail?.businessUnitCode === 'BU-OPS'),
    JSON.stringify(audit.filter((r) => r.action === 'department_updated').map((r) => r.detail)));
  ok('    and so is its removal',
    audit.some((r) => r.action === 'department_updated' && r.detail?.businessUnitCode === null));
  ok('    through the existing audit_log, with no second mechanism',
    audit.every((r) => r.action.startsWith('department_')));
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`departments ${after.d}`, after.d === before.d, `was ${before.d}`);
ok(`departments with an assignment ${after.assigned}`, after.assigned === before.assigned,
  `was ${before.assigned} — no existing department was assigned a unit`);
ok(`business units ${after.u}`, after.u === before.u, `was ${before.u}`);
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
  console.error(`${failed} department/business-unit checks failed`);
  process.exit(1);
}
console.log('a department may belong to a business unit, in its own tenant, or to none at all');
