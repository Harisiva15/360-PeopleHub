/**
 * A department reports to a department.
 *
 * `department.parent_id` has existed since `0002_org_config.sql` — a nullable
 * self-reference behind the composite key `(tenant_id, parent_id)`. The service
 * has carried it the whole time: `createDepartment` inserts it, `updateDepartment`
 * guards it with a recursive CTE, `removeDepartment` counts children among the ten
 * things that block a delete, and `listDepartments` returns it.
 *
 * None of that was tested. One assertion in `departments.test.mjs` covered a
 * department naming *itself* as its parent. The recursive guard — the part that
 * costs something to get right — had no coverage at all, and the column was never
 * exposed in the product, so nothing exercised it from either end.
 *
 * Phase 2c surfaces the column in the department form. A selector that can propose
 * any department makes the guard reachable from the outside for the first time, so
 * it is worth pinning down before the UI can reach it.
 *
 * ## What is worth holding
 *
 * **A cycle is refused at any depth, not just at depth zero.** `A → B → C` and then
 * "A reports to C" is the case the CTE exists for: no single edge is a self-loop,
 * and following the chain gets back to A. Left in, the subtree detaches from the
 * tree and anything walking it recurses until it gives up.
 *
 * **Absent, null and an id are three different requests.** Omitting `parentId`
 * leaves the parent alone, null makes the department top-level, an id moves it.
 * Collapsing the first two would make "rename this department" quietly promote it
 * to the top of the organisation — and the edit form sends the whole record, so
 * that is not a hypothetical.
 *
 * **Cross-tenant is unrepresentable, not merely refused.** A parent is an opaque id
 * chosen by the caller, which is the one field in this feature an administrator
 * could point at another tenant. The decisive assertion offers one tenant's
 * department id as a parent inside another tenant, both through the service and by
 * direct INSERT on the migration connection, which bypasses row level security.
 * The composite key has to refuse it. That is not an application rule.
 *
 * **The existing guards still hold.** Children still block a delete; a manager and
 * an employee still cannot shape the organisation; the business unit assigned in
 * 0052 is untouched when only the parent moves.
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
  console.log('\nSKIPPED: no database, and a cycle guard needs one to walk.\n');
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
         (SELECT count(*)::int FROM department WHERE parent_id IS NOT NULL) nested,
         (SELECT count(*)::int FROM department WHERE business_unit_id IS NOT NULL) assigned,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * The column, read from the catalogue rather than from 0002's text
 * ------------------------------------------------------------------ */

console.log('\nthe parent column is nullable and tenant-safe, and always was\n');

{
  const col = (await db.query(
    `SELECT is_nullable, data_type, column_default
       FROM information_schema.columns
      WHERE table_name = 'department' AND column_name = 'parent_id'`)).rows[0];
  ok('1. the column exists', Boolean(col));
  ok('    nullable, so a top-level department is a real state',
    col?.is_nullable === 'YES', JSON.stringify(col));
  ok('    a uuid', col?.data_type === 'uuid', col?.data_type);
  ok('    with no default, so nothing is nested implicitly',
    col?.column_default === null, String(col?.column_default));

  const fk = (await db.query(
    `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conrelid = 'department'::regclass AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%parent_id%'`)).rows[0];
  ok('2. the self-reference carries tenant_id on both sides',
    /\(tenant_id, parent_id\) REFERENCES department\(tenant_id, id\)/.test(fk?.d ?? ''),
    fk?.d);

  /* 0052's column and index must be exactly as they were. Phase 2c adds no migration. */
  const bu = (await db.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'department' AND column_name = 'business_unit_id'`)).rows[0];
  ok('3. 0052\'s business unit column is untouched', bu?.is_nullable === 'YES',
    JSON.stringify(bu));

  const rls = (await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'department'`
  )).rows[0];
  ok('    department RLS is still enabled and forced',
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
  const MGR = {
    role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const EMP = {
    role: 'employee', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  const find = async (code) => (await config.listDepartments(A)).find((d) => d.code === code);

  /* ---------------------------------------------------------------- *
   * Existing rows, and a chain built through the product's own path
   * ---------------------------------------------------------------- */

  console.log('\nan existing department is top-level, and nothing nested it\n');

  const seeded = await config.listDepartments(A);
  ok('4. the scratch tenant\'s department has no parent',
    seeded.length > 0 && seeded.every((d) => d.parentId === null),
    JSON.stringify(seeded.map((d) => [d.code, d.parentId])));

  console.log('\na three-level chain, built through the service\n');

  const a = await config.createDepartment(A, { code: 'ZZA', name: 'ZZ A' });
  ok('5. a department created with no parent is top-level', a.parentId === null);

  const b = await config.createDepartment(A, { code: 'ZZB', name: 'ZZ B', parentId: a.id });
  ok('6. a department may be created under a parent', b.parentId === a.id,
    `parentId came back ${b.parentId}`);

  const c = await config.createDepartment(A, { code: 'ZZC', name: 'ZZ C', parentId: b.id });
  ok('7. and three levels deep', c.parentId === b.id);

  ok('    the list reads the chain back',
    (await find('ZZC'))?.parentId === b.id && (await find('ZZB'))?.parentId === a.id);

  /* ---------------------------------------------------------------- *
   * The guard this suite exists for
   * ---------------------------------------------------------------- */

  console.log('\na cycle is refused at any depth\n');

  await refused('8. a department cannot report to itself',
    () => config.updateDepartment(A, 'ZZA', { parentId: a.id }),
    /cannot report to itself/);

  await refused('9. nor to its own child',
    () => config.updateDepartment(A, 'ZZA', { parentId: b.id }),
    /report to itself/);

  await refused('10. nor to its grandchild — the case the recursive guard exists for',
    () => config.updateDepartment(A, 'ZZA', { parentId: c.id }),
    /report to itself/);

  ok('    and the chain is unchanged after all three refusals',
    (await find('ZZA'))?.parentId === null
    && (await find('ZZB'))?.parentId === a.id
    && (await find('ZZC'))?.parentId === b.id,
    'a refusal must not half-apply');

  await refused('11. a parent that does not exist is refused',
    () => config.updateDepartment(A, 'ZZB',
      { parentId: '00000000-0000-0000-0000-000000000000' }),
    /23503|does not exist|not exist/);

  /* ---------------------------------------------------------------- *
   * Absent, null and an id
   * ---------------------------------------------------------------- */

  console.log('\nabsent leaves the parent alone, null clears it\n');

  const renamed = await config.updateDepartment(A, 'ZZC', { name: 'ZZ C renamed' });
  ok('12. a rename does not disturb the parent', renamed.parentId === b.id,
    `became ${renamed.parentId}`);
  ok('    and the rename took', renamed.name === 'ZZ C renamed');

  const moved = await config.updateDepartment(A, 'ZZC', { parentId: a.id });
  ok('13. a parent may be changed', moved.parentId === a.id);

  const freed = await config.updateDepartment(A, 'ZZC', { parentId: null });
  ok('14. null makes it top-level again', freed.parentId === null);

  const stillFree = await config.updateDepartment(A, 'ZZC', { name: 'ZZ C' });
  ok('    and absent leaves it top-level', stillFree.parentId === null);

  /* A parent and a unit are independent. 0052's behaviour must not move. */
  console.log('\nthe parent and the business unit do not interfere\n');

  await config.createBusinessUnit(A, { code: 'BU-H', name: 'Hierarchy Unit' });
  const withBoth = await config.updateDepartment(A, 'ZZB',
    { businessUnitCode: 'BU-H', parentId: a.id });
  ok('15. a department may hold both a parent and a unit',
    withBoth.parentId === a.id && withBoth.businessUnitCode === 'BU-H',
    JSON.stringify([withBoth.parentId, withBoth.businessUnitCode]));

  const parentOnly = await config.updateDepartment(A, 'ZZB', { parentId: null });
  ok('16. clearing the parent leaves the unit assigned',
    parentOnly.parentId === null && parentOnly.businessUnitCode === 'BU-H',
    JSON.stringify([parentOnly.parentId, parentOnly.businessUnitCode]));
  ok('    and the unit name still resolves', parentOnly.businessUnitName === 'Hierarchy Unit');

  const unitOnly = await config.updateDepartment(A, 'ZZB',
    { parentId: a.id, businessUnitCode: null });
  ok('17. clearing the unit leaves the parent', unitOnly.parentId === a.id
    && unitOnly.businessUnitCode === null,
    JSON.stringify([unitOnly.parentId, unitOnly.businessUnitCode]));

  /* ---------------------------------------------------------------- *
   * Who may do this, and what children block
   * ---------------------------------------------------------------- */

  console.log('\nshaping the organisation stays an administrator\'s\n');

  await refused('18. a manager cannot move a department',
    () => config.updateDepartment(MGR, 'ZZC', { parentId: a.id }), /only an admin/);
  await refused('19. an employee cannot either',
    () => config.updateDepartment(EMP, 'ZZC', { parentId: a.id }), /only an admin/);
  await refused('20. nor create one under a parent',
    () => config.createDepartment(MGR, { code: 'ZZNO', name: 'ZZ no', parentId: a.id }),
    /only an admin/);
  ok('    and a manager may still read the structure',
    (await config.listDepartments(MGR)).length > 0,
    'reading which department reports where is not privileged');

  console.log('\na parent cannot be removed while it has children\n');

  const blocked = await attempt(() => config.removeDepartment(A, 'ZZA'));
  ok('21. removal is refused', blocked !== null,
    'the self-reference does not cascade, so this would orphan the subtree');
  ok('    and the refusal counts the children',
    /child departments/.test(blocked?.message ?? ''), blocked?.message);
  ok('    and points at deactivating instead',
    /deactivate/i.test(blocked?.message ?? ''), blocked?.message);
  ok('    and the parent is still there', (await find('ZZA')) !== undefined);

  /* A childless leaf is removable, which is what makes the count meaningful. */
  await config.updateDepartment(A, 'ZZB', { parentId: null });
  await config.updateDepartment(A, 'ZZC', { parentId: null });
  ok('22. and is removable once nothing reports to it',
    (await attempt(() => config.removeDepartment(A, 'ZZA'))) === null);

  /* ---------------------------------------------------------------- *
   * Audit
   * ---------------------------------------------------------------- */

  console.log('\na parent change goes through the existing audit trail\n');

  const reparent = await config.updateDepartment(A, 'ZZC', { parentId: b.id });
  ok('23. the move took', reparent.parentId === b.id);

  const logged = (await db.query(
    `SELECT action, category, subject_table, detail FROM audit_log
      WHERE tenant_id = $1 AND subject_table = 'department'
        AND detail ->> 'department' = 'ZZC'
        AND detail ? 'parentId'
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ctx.tenant])).rows[0];
  ok('24. the parent change is in audit_log', Boolean(logged), 'nothing was recorded');
  ok('    under the existing config category', logged?.category === 'config', logged?.category);
  ok('    as department_updated, not a new action',
    logged?.action === 'department_updated', logged?.action);
  ok('    and the detail carries the new parent',
    logged?.detail?.parentId === b.id, JSON.stringify(logged?.detail));
  ok('25. no second audit table was created',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%audit%'`)).rows[0].n === 1);

  /* ---------------------------------------------------------------- *
   * Cross-tenant: the one field a caller chooses by id
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (other) => {
    const B = {
      role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
    };

    console.log('\na parent cannot be borrowed from another tenant\n');

    const ours = await find('ZZC');
    const theirs = (await config.listDepartments(B))[0];
    ok('26. the two tenants see different departments', ours.id !== theirs.id);
    ok('    and neither can see the other\'s',
      (await config.listDepartments(B)).every((d) => d.id !== ours.id)
      && (await config.listDepartments(A)).every((d) => d.id !== theirs.id),
      'row level security is the boundary');

    await refused('27. the service refuses our department as their parent',
      () => config.updateDepartment(B, theirs.code, { parentId: ours.id }),
      /23503|does not exist|not exist|report to itself/);

    await refused('28. and refuses it on a create too',
      () => config.createDepartment(B,
        { code: 'ZZSTEAL', name: 'ZZ Steal', parentId: ours.id }),
      /23503|does not exist|not exist/);

    /*
     * The decisive one. This runs on the migration connection, which is not
     * subject to row level security, so nothing but the composite key stands
     * between tenant B and tenant A's department.
     */
    const crossFk = await attempt(() => db.query(
      `INSERT INTO department (tenant_id, code, name, parent_id)
       VALUES ($1, 'ZZCROSS', 'ZZ Cross Tenant', $2)`, [other.tenant, ours.id]));
    ok('29. the composite key refuses a cross-tenant parent outright', crossFk !== null,
      'a department was given a parent in another tenant');
    ok('    as a foreign key violation', crossFk?.code === '23503', crossFk?.code);

    const crossUpdate = await attempt(() => db.query(
      `UPDATE department SET parent_id = $2 WHERE tenant_id = $1 AND code = $3`,
      [other.tenant, ours.id, theirs.code]));
    ok('30. and refuses it on an update as well', crossUpdate !== null);
    ok('    still a foreign key violation', crossUpdate?.code === '23503', crossUpdate?.code);

    ok('31. their department is still top-level',
      (await config.listDepartments(B)).find((d) => d.code === theirs.code)?.parentId === null);
  });
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`departments ${after.d}`, after.d === before.d, `was ${before.d}`);
ok(`departments with a parent ${after.nested}`, after.nested === before.nested,
  `was ${before.nested} — no existing department was nested`);
ok(`departments with a unit ${after.assigned}`, after.assigned === before.assigned,
  `was ${before.assigned} — 0052's assignments are untouched`);
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
  console.error(`${failed} department hierarchy checks failed`);
  process.exit(1);
}
console.log('a department reports to one in its own tenant, never to itself at any depth');
