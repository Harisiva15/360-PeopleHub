/**
 * Departments are real, and one cannot be deleted out from under its people.
 *
 * The `department` table has held the company's eight departments since
 * migration 0002, and every employee, job title and requisition joins to it.
 * No endpoint exposed it. The Settings screen rendered `DEPTS` from
 * `src/data/org.ts` — a display constant — so an administrator was looking at
 * eight invented departments beside a database holding eight real ones, with
 * nothing on screen to say which was which.
 *
 * The delete is the part worth testing hardest. Ten tables carry a department
 * reference and none of them cascade, so a naive delete either explodes on a
 * constraint or, where the column is nullable, quietly strips the department
 * off records that still mean it. The rule is therefore: a department nothing
 * points at can go; one with anything behind it is refused, and the refusal
 * says what is in the way.
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
  console.log('\nSKIPPED: no database, and a department is a row in one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { listDepartments, createDepartment, updateDepartment, removeDepartment } =
  await import('../src/modules/config/service.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await admin.connect();

const census = async () => (await admin.query(`
  SELECT (SELECT count(*)::int FROM department) d,
         (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM audit_log) a`)).rows[0];
const before = await census();

const ctx = (await admin.query(`
  SELECT t.id tenant, e.id emp,
         (SELECT id FROM site WHERE active LIMIT 1) site,
         (SELECT id FROM legal_entity LIMIT 1) entity,
         (SELECT id FROM shift LIMIT 1) shift
    FROM tenant t JOIN employee e ON e.tenant_id = t.id
   WHERE t.slug = '360vhm' AND e.code = 'VHM004'`)).rows[0];

const caller = (role) => ({ role, tenantId: ctx.tenant, employeeId: ctx.emp, userId: null });
const madeDepts = [];
const madeEmps = [];

try {
  /* ---------------------------------------------------------------- *
   * The list is the database's, not a constant's
   * ---------------------------------------------------------------- */

  console.log('\nthe list comes from the database\n');

  const rows = (await admin.query('SELECT code, name FROM department ORDER BY code')).rows;
  const listed = await listDepartments(caller('admin'));
  ok(`the service returns ${listed.length} departments`, listed.length === rows.length,
    `database has ${rows.length}`);
  ok('  with the database’s own codes',
    listed.map((d) => d.code).sort().join(',') === rows.map((r) => r.code).sort().join(','),
    'the screen used to render src/data/org.ts, which has its own list');
  ok('  each carrying a headcount', listed.every((d) => typeof d.headcount === 'number'));

  ok('an employee can read them too', (await listDepartments(caller('employee'))).length > 0,
    'every screen that shows a person shows their department');

  /* ---------------------------------------------------------------- *
   * Create, edit
   * ---------------------------------------------------------------- */

  console.log('\ncreating and editing\n');

  const d = await createDepartment(caller('admin'), { code: 'zzprobe', name: 'ZZ Probe Dept' });
  madeDepts.push(d.code);
  ok('a department can be created', Boolean(d.id));
  ok('  and its code is upper-cased', d.code === 'ZZPROBE', d.code);
  ok('  starting active with nobody in it', d.active === true && d.headcount === 0);

  ok('a duplicate code is refused',
    (await attempt(() => createDepartment(caller('admin'), { code: 'ZZPROBE', name: 'ZZ again' }))) !== null);

  const renamed = await updateDepartment(caller('admin'), 'ZZPROBE', { name: 'ZZ Renamed' });
  ok('it can be renamed', renamed.name === 'ZZ Renamed');
  ok('  and the code does not move', renamed.code === 'ZZPROBE',
    'the code is what every employee and job title joins on');

  const off = await updateDepartment(caller('admin'), 'ZZPROBE', { active: false });
  ok('it can be deactivated', off.active === false);
  await updateDepartment(caller('admin'), 'ZZPROBE', { active: true });

  /* ---------------------------------------------------------------- *
   * Validation and permission
   * ---------------------------------------------------------------- */

  console.log('\nwhat is refused\n');

  ok('a blank code is refused',
    (await attempt(() => createDepartment(caller('admin'), { code: ' ', name: 'ZZ x' }))) !== null);
  ok('a blank name is refused',
    (await attempt(() => createDepartment(caller('admin'), { code: 'ZZOK', name: '  ' }))) !== null);
  ok('a code with spaces is refused',
    (await attempt(() => createDepartment(caller('admin'), { code: 'ZZ BAD', name: 'ZZ x' }))) !== null);
  ok('renaming to blank is refused',
    (await attempt(() => updateDepartment(caller('admin'), 'ZZPROBE', { name: '' }))) !== null);

  ok('a department cannot report to itself',
    (await attempt(() => updateDepartment(caller('admin'), 'ZZPROBE', { parentId: d.id }))) !== null,
    'a cycle detaches a branch and the org chart recurses over it');

  ok('a manager cannot create one',
    (await attempt(() => createDepartment(caller('manager'), { code: 'ZZNO', name: 'ZZ no' }))) !== null);
  ok('an employee cannot remove one',
    (await attempt(() => removeDepartment(caller('employee'), 'ZZPROBE'))) !== null);

  /* ---------------------------------------------------------------- *
   * The delete rule
   * ---------------------------------------------------------------- */

  console.log('\nremoval is refused while anything points at it\n');

  const emp = (await admin.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     VALUES ($1, $2, 'ZZ Dept Probe', $3, 'active', 'employee',
             (SELECT id FROM department WHERE code = 'ZZPROBE'), $4, $5, $6, CURRENT_DATE)
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `zz-dept-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      ctx.site, ctx.entity, ctx.shift])).rows[0].id;
  madeEmps.push(emp);

  const blocked = await attempt(() => removeDepartment(caller('admin'), 'ZZPROBE'));
  ok('a department with somebody in it cannot be removed', blocked !== null,
    'the foreign keys do not cascade, so this would either explode or silently orphan');
  ok('  and the refusal counts them', /1 employees/.test(blocked?.message ?? ''), blocked?.message);
  ok('  and points at deactivating instead', /deactivate/i.test(blocked?.message ?? ''),
    blocked?.message);

  const still = (await admin.query(
    "SELECT 1 FROM department WHERE code = 'ZZPROBE'")).rowCount;
  ok('  and the department is still there', still === 1);

  const withDept = await listDepartments(caller('admin'));
  ok('  and its headcount shows why', withDept.find((x) => x.code === 'ZZPROBE')?.headcount === 1);

  console.log('\nand allowed once nothing does\n');

  await admin.query('DELETE FROM employee WHERE id = $1', [emp]);
  madeEmps.length = 0;

  const gone = await removeDepartment(caller('admin'), 'ZZPROBE');
  madeDepts.length = 0;
  ok('an empty department can be removed', gone.code === 'ZZPROBE');
  ok('  and is gone from the list',
    !(await listDepartments(caller('admin'))).some((x) => x.code === 'ZZPROBE'));
  ok('  and removing it twice is a not-found',
    (await attempt(() => removeDepartment(caller('admin'), 'ZZPROBE'))) !== null);

  const trail = (await admin.query(
    `SELECT action FROM audit_log WHERE subject_table = 'department'
      AND detail->>'department' = 'ZZPROBE' ORDER BY occurred_at`)).rows.map((r) => r.action);
  ok('every change left an audit row',
    trail.includes('department_created') && trail.includes('department_updated')
      && trail.includes('department_removed'),
    trail.join(', '));
  await admin.query("DELETE FROM audit_log WHERE subject_table = 'department' AND detail->>'department' = 'ZZPROBE'");
} finally {
  if (madeEmps.length) {
    await admin.query('DELETE FROM employee WHERE id = ANY($1::uuid[])', [madeEmps]);
  }
  if (madeDepts.length) {
    await admin.query('DELETE FROM department WHERE code = ANY($1::text[])', [madeDepts]);
  }
  await admin.query("DELETE FROM audit_log WHERE subject_table = 'department' AND detail->>'department' LIKE 'ZZ%'");
}

console.log('\nthe database is as it was\n');
const after = await census();
ok(`departments ${after.d}`, after.d === before.d, `was ${before.d}`);
ok(`employees ${after.e}`, after.e === before.e, `was ${before.e}`);
ok(`audit rows ${after.a}`, after.a === before.a, `was ${before.a}`);

await admin.end();

console.log(failed
  ? `\n${failed} problem(s)`
  : '\ndepartments come from the database, and one with people in it stays');
process.exit(failed ? 1 : 0);
