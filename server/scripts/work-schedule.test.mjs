/**
 * The schema for which days a person is expected to work.
 *
 * Migration 0054 adds three tables and reads from none of them. No service
 * consumes a schedule yet — the 2h-B resolver still answers Monday to Friday from
 * its own `ISODOW >= 6` rule — so everything below is about what the database
 * will and will not allow, which is the only thing this phase actually delivers.
 *
 * ## What is worth holding
 *
 * **The three concepts stay apart.** `work_schedule` says which days,
 * `work_schedule_day` says which weekday and optionally which shift that day, and
 * `shift` says the hours. No hour, timezone, break or grace value is duplicated
 * into the new tables, and the assertions check that by reading the catalogue
 * rather than trusting the migration's prose.
 *
 * **Overlap is impossible, not merely refused.** `employee_schedule_no_overlap` is
 * an exclusion constraint over `daterange(valid_from, valid_to, '[]')`, so the
 * question "which pattern applied on this day" has exactly one answer for every
 * reader, including one written later. 30 June to 1 July is adjacent; 15 June into
 * an open range is not.
 *
 * **Inclusive bounds, deliberately.** 0048 uses a half-open range for
 * `salary_structure`, which treats `valid_to` as the first day *not* covered and
 * leaves a one-day gap if read the natural way. `leave_request` reasons
 * inclusively and an HR user means "last day". Assertions 24 to 27 pin which this
 * is, because getting it wrong is a silent off-by-one in somebody's pay.
 *
 * **History survives deactivation.** A withdrawn schedule keeps its assignments
 * readable — it still describes the days somebody worked — and the FK is RESTRICT
 * rather than CASCADE so it cannot be deleted out from under them.
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
  console.log('\nSKIPPED: no database, and this phase is nothing but schema.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};
/** A refusal from the database, with the code that says which rule caught it. */
const refusedBy = async (label, fn, code, constraint) => {
  const e = await attempt(fn);
  ok(label, e !== null, 'the statement succeeded — this is a hole, not a test failure');
  if (e) {
    ok(`    refused as ${code}`, e.code === code, `${e.code}: ${e.message}`);
    if (constraint) {
      ok(`    by ${constraint}`, e.constraint === constraint, String(e.constraint));
    }
  }
};

const db = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: sslConfig(),
});
await db.connect();

const census = async () => (await db.query(`
  SELECT (SELECT count(*)::int FROM tenant) t,
         (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM shift) s,
         (SELECT count(*)::int FROM attendance) a,
         (SELECT count(*)::int FROM leave_request) lr,
         (SELECT count(*)::int FROM work_schedule) ws,
         (SELECT count(*)::int FROM employee_schedule) es`)).rows[0];
const before = await census();

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * A-G. The three tables, read from the catalogue
 * ------------------------------------------------------------------ */

console.log('\nthree tables, tenant-isolated the way every other one is\n');

const EXPECTED = {
  work_schedule: ['id', 'tenant_id', 'code', 'name', 'description', 'active',
    'created_at', 'updated_at'],
  work_schedule_day: ['id', 'tenant_id', 'work_schedule_id', 'day_of_week', 'working',
    'shift_id', 'created_at', 'updated_at'],
  employee_schedule: ['id', 'tenant_id', 'employee_id', 'work_schedule_id',
    'valid_from', 'valid_to', 'created_at', 'updated_at'],
};

for (const [table, want] of Object.entries(EXPECTED)) {
  const cols = (await db.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = $1 ORDER BY ordinal_position`, [table])).rows;
  ok(`1. ${table} exists with its ${want.length} columns`,
    cols.map((c) => c.column_name).join(',') === want.join(','),
    cols.map((c) => c.column_name).join(','));

  const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  ok('    a uuid primary key defaulted by gen_random_uuid()',
    by.id?.data_type === 'uuid' && by.id?.column_default === 'gen_random_uuid()');
  ok('    tenant_id NOT NULL, defaulted to current_tenant_id()',
    by.tenant_id?.is_nullable === 'NO'
    && by.tenant_id?.column_default === 'current_tenant_id()',
    JSON.stringify(by.tenant_id));
  ok('    created_at and updated_at, both NOT NULL now()',
    by.created_at?.column_default === 'now()' && by.updated_at?.column_default === 'now()');

  const pk = (await db.query(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'p'`, [table])).rows[0];
  ok('    with a declared primary key', Boolean(pk), 'none found');

  const rls = (await db.query(
    'SELECT relrowsecurity e, relforcerowsecurity f FROM pg_class WHERE relname = $1',
    [table])).rows[0];
  ok('    RLS enabled and forced', rls?.e === true && rls?.f === true, JSON.stringify(rls));

  const pol = (await db.query(
    `SELECT polname, pg_get_expr(polqual, polrelid) u, pg_get_expr(polwithcheck, polrelid) w
       FROM pg_policy WHERE polrelid = $1::regclass`, [table])).rows[0];
  ok('    with tenant_isolation on both USING and WITH CHECK',
    pol?.polname === 'tenant_isolation'
    && /tenant_id = current_tenant_id\(\)/.test(pol?.u ?? '')
    && /tenant_id = current_tenant_id\(\)/.test(pol?.w ?? ''),
    JSON.stringify(pol));

  const grants = (await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = $1 AND grantee = 'app_rw' ORDER BY privilege_type`, [table])
  ).rows.map((r) => r.privilege_type);
  ok('    and app_rw holding all four grants',
    grants.join(',') === 'DELETE,INSERT,SELECT,UPDATE', grants.join(','));

  const uq = (await db.query(
    `SELECT 1 FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, id)'`, [table])).rows;
  ok('    UNIQUE (tenant_id, id), so a composite FK can target it', uq.length === 1);
}

console.log('\nthe constraints that make the model mean something\n');

{
  const def = async (name) => (await db.query(
    'SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = $1',
    [name])).rows[0]?.d ?? '';

  ok('2. a schedule code is unique within the tenant',
    await (async () => (await db.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'work_schedule'::regclass
         AND contype = 'u' AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, code)'`
    )).rows.length === 1)());
  ok('3. and shaped like every other code in this schema',
    /A-Z0-9/.test(await def('work_schedule_code_shape')),
    await def('work_schedule_code_shape'));
  ok('4. a name cannot be blank', /length\(btrim\(name\)\) > 0/.test(
    await def('work_schedule_name_present')));

  ok('5. day_of_week is constrained to 1 through 7',
    /day_of_week >= 1/.test(await def('work_schedule_day_isodow'))
    && /day_of_week <= 7/.test(await def('work_schedule_day_isodow')),
    await def('work_schedule_day_isodow'));
  ok('6. one row per weekday per schedule',
    await (async () => (await db.query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'work_schedule_day'::regclass
         AND contype = 'u'
         AND pg_get_constraintdef(oid) = 'UNIQUE (tenant_id, work_schedule_id, day_of_week)'`
    )).rows.length === 1)());
  ok('7. a non-working day cannot carry a shift',
    /working OR \(shift_id IS NULL\)/.test(await def('work_schedule_day_off_has_no_shift')),
    await def('work_schedule_day_off_has_no_shift'));

  ok('8. valid_to cannot precede valid_from',
    /valid_to >= valid_from/.test(await def('employee_schedule_dates_ordered')),
    await def('employee_schedule_dates_ordered'));
  ok('9. overlap is an exclusion constraint, not a service rule',
    /EXCLUDE USING gist/.test(await def('employee_schedule_no_overlap')),
    await def('employee_schedule_no_overlap'));
  ok('    keyed on the tenant and the employee',
    /tenant_id WITH =/.test(await def('employee_schedule_no_overlap'))
    && /employee_id WITH =/.test(await def('employee_schedule_no_overlap')));
  ok('    over an inclusive date range',
    /daterange\(valid_from, valid_to, '\[\]'/.test(await def('employee_schedule_no_overlap')),
    'half-open would leave the last day belonging to neither assignment');

  /* Every FK carries the tenant, which is check-schema's third invariant. */
  const fks = (await db.query(
    `SELECT conrelid::regclass::text tbl, pg_get_constraintdef(oid) d
       FROM pg_constraint
      WHERE conrelid IN ('work_schedule'::regclass, 'work_schedule_day'::regclass,
                         'employee_schedule'::regclass)
        AND contype = 'f' ORDER BY 1, 2`)).rows;
  ok('10. every foreign key but the tenant one carries tenant_id on both sides',
    fks.filter((f) => !/REFERENCES tenant\(id\)/.test(f.d))
      .every((f) => /^FOREIGN KEY \(tenant_id, /.test(f.d)),
    JSON.stringify(fks.map((f) => f.d)));
  ok('11. a schedule day cascades from its schedule',
    fks.some((f) => f.tbl === 'work_schedule_day'
      && /work_schedule\(tenant_id, id\) ON DELETE CASCADE/.test(f.d)),
    'seven day rows are meaningless without the pattern they belong to');
  ok('12. but an assignment does not — the schedule FK restricts',
    fks.some((f) => f.tbl === 'employee_schedule'
      && /work_schedule\(tenant_id, id\)$/.test(f.d)),
    'an employee\'s schedule history must not vanish with the pattern');
  ok('13. and the shift reference restricts too',
    fks.some((f) => f.tbl === 'work_schedule_day' && /shift\(tenant_id, id\)$/.test(f.d)));

  const idx = (await db.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename IN ('work_schedule', 'work_schedule_day', 'employee_schedule')
        AND indexname NOT LIKE '%_pkey' ORDER BY indexname`)).rows;
  ok('14. every index leads with tenant_id',
    idx.every((i) => /\(tenant_id/.test(i.indexdef)),
    JSON.stringify(idx.map((i) => i.indexname)));
}

console.log('\nno hour, timezone, break or grace was duplicated into a schedule\n');

{
  const leaked = (await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('work_schedule', 'work_schedule_day', 'employee_schedule')
        AND (column_name LIKE '%starts%' OR column_name LIKE '%ends%'
          OR column_name LIKE '%break%' OR column_name LIKE '%grace%'
          OR column_name LIKE '%timezone%' OR column_name LIKE '%night%')`)).rows;
  ok('15. none of the shift columns appears on a schedule table', leaked.length === 0,
    JSON.stringify(leaked));
  ok('16. a schedule day points at shift instead',
    (await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'work_schedule_day' AND column_name = 'shift_id'`)).rows.length === 1);
  ok('17. and shift itself was not touched',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name = 'shift'`)).rows[0].n === 15,
    'fifteen columns, as 2g left it');
  ok('18. employee gained no work_schedule_id',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name = 'employee' AND column_name = 'work_schedule_id'`)).rows[0].n === 0,
    'the assignment is effective-dated in its own table');
  ok('19. attendance gained no schedule reference',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name = 'attendance' AND column_name LIKE '%schedule%'`)).rows[0].n === 0);
}

/* ------------------------------------------------------------------ *
 * The data tests
 * ------------------------------------------------------------------ */

await withScratchTenant(db, async (ctx) => {
  const T = ctx.tenant;

  console.log('\na tenant builds a six-day pattern\n');

  const sched = (await db.query(
    `INSERT INTO work_schedule (tenant_id, code, name, description)
     VALUES ($1, 'ZZSIX', 'ZZ Six Day', 'Monday to Saturday') RETURNING id`, [T])).rows[0].id;
  ok('20. a schedule can be created', Boolean(sched));

  await refusedBy('21. a duplicate code in the same tenant is refused',
    () => db.query(
      `INSERT INTO work_schedule (tenant_id, code, name) VALUES ($1, 'ZZSIX', 'ZZ Again')`, [T]),
    '23505');
  await refusedBy('22. a lower-case code is refused',
    () => db.query(
      `INSERT INTO work_schedule (tenant_id, code, name) VALUES ($1, 'zzbad', 'ZZ Bad')`, [T]),
    '23514', 'work_schedule_code_shape');
  await refusedBy('23. a blank name is refused',
    () => db.query(
      `INSERT INTO work_schedule (tenant_id, code, name) VALUES ($1, 'ZZBLANK', '  ')`, [T]),
    '23514', 'work_schedule_name_present');

  /* Monday to Saturday working, Sunday off, with two different shifts in the week. */
  const inShift = (await db.query(
    "SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'", [T])).rows[0].id;
  const lateShift = (await db.query(
    `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone)
     VALUES ($1, 'ZZLATE', 'ZZ Late Shift', '13:00', '22:00', 'Asia/Kolkata')
     RETURNING id`, [T])).rows[0].id;

  for (const [dow, working, shift] of [
    [1, true, inShift], [2, true, inShift], [3, true, lateShift],
    [4, true, lateShift], [5, true, inShift], [6, true, null], [7, false, null],
  ]) {
    await db.query(
      `INSERT INTO work_schedule_day
         (tenant_id, work_schedule_id, day_of_week, working, shift_id)
       VALUES ($1, $2, $3, $4, $5)`, [T, sched, dow, working, shift]);
  }
  const days = (await db.query(
    `SELECT day_of_week, working, shift_id FROM work_schedule_day
      WHERE work_schedule_id = $1 ORDER BY day_of_week`, [sched])).rows;
  ok('24. seven days are stored', days.length === 7);
  ok('    Monday to Saturday working, Sunday off',
    days.map((d) => (d.working ? 'W' : '-')).join('') === 'WWWWWW-',
    days.map((d) => (d.working ? 'W' : '-')).join(''));
  ok('25. different weekdays can run different shifts',
    days[0].shift_id === inShift && days[2].shift_id === lateShift,
    'the example in the brief: Mon/Tue on one, Wed/Thu on another');
  ok('    and a working day may name no shift, meaning the employee\'s own',
    days[5].shift_id === null);

  await refusedBy('26. a second Monday row is refused',
    () => db.query(
      `INSERT INTO work_schedule_day (tenant_id, work_schedule_id, day_of_week, working)
       VALUES ($1, $2, 1, true)`, [T, sched]),
    '23505');
  await refusedBy('27. weekday 0 is refused — ISO numbering starts at Monday',
    () => db.query(
      `INSERT INTO work_schedule_day (tenant_id, work_schedule_id, day_of_week, working)
       VALUES ($1, $2, 0, true)`, [T, sched]),
    '23514', 'work_schedule_day_isodow');
  await refusedBy('28. weekday 8 is refused',
    () => db.query(
      `INSERT INTO work_schedule_day (tenant_id, work_schedule_id, day_of_week, working)
       VALUES ($1, $2, 8, true)`, [T, sched]),
    '23514', 'work_schedule_day_isodow');
  /* On its own schedule, so the unique index on day 7 cannot fire first. */
  const other = (await db.query(
    `INSERT INTO work_schedule (tenant_id, code, name) VALUES ($1, 'ZZOFF', 'ZZ Off Probe')
     RETURNING id`, [T])).rows[0].id;
  await refusedBy('29. a day off cannot carry a shift',
    () => db.query(
      `INSERT INTO work_schedule_day
         (tenant_id, work_schedule_id, day_of_week, working, shift_id)
       VALUES ($1, $2, 7, false, $3)`, [T, other, inShift]),
    '23514', 'work_schedule_day_off_has_no_shift');

  console.log('\nan assignment is effective-dated, and cannot overlap itself\n');

  const emp = ctx.adminEmployeeId;
  /* The backfill already assigned this employee; close that row first. */
  await db.query(
    `UPDATE employee_schedule SET valid_to = '2025-12-31'
      WHERE tenant_id = $1 AND employee_id = $2 AND valid_to IS NULL`, [T, emp]);

  await db.query(
    `INSERT INTO employee_schedule
       (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
     VALUES ($1, $2, $3, '2026-01-01', '2026-06-30')`, [T, emp, sched]);
  ok('30. a closed assignment is stored', true);

  await db.query(
    `INSERT INTO employee_schedule
       (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
     VALUES ($1, $2, $3, '2026-07-01', NULL)`, [T, emp, other]);
  ok('31. the next one may begin the very next day', true,
    '30 June to 1 July is adjacent, not overlapping');

  await refusedBy('32. an assignment starting inside an existing one is refused',
    () => db.query(
      `INSERT INTO employee_schedule
         (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
       VALUES ($1, $2, $3, '2026-06-15', NULL)`, [T, emp, sched]),
    '23P01', 'employee_schedule_no_overlap');

  await refusedBy('33. a second open-ended assignment is refused',
    () => db.query(
      `INSERT INTO employee_schedule
         (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
       VALUES ($1, $2, $3, '2027-01-01', NULL)`, [T, emp, sched]),
    '23P01', 'employee_schedule_no_overlap');

  await refusedBy('34. one fully containing another is refused',
    () => db.query(
      `INSERT INTO employee_schedule
         (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
       VALUES ($1, $2, $3, '2026-02-01', '2026-03-01')`, [T, emp, sched]),
    '23P01', 'employee_schedule_no_overlap');

  await refusedBy('35. an end before its own start is refused',
    () => db.query(
      `INSERT INTO employee_schedule
         (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
       VALUES ($1, $2, $3, '2028-06-01', '2028-01-01')`, [T, emp, sched]),
    '23514', 'employee_schedule_dates_ordered');

  /* The boundary the inclusive range decides. */
  await refusedBy('36. and an assignment starting on the previous one\'s last day overlaps',
    () => db.query(
      `INSERT INTO employee_schedule
         (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
       VALUES ($1, $2, $3, '2026-06-30', NULL)`, [T, emp, sched]),
    '23P01', 'employee_schedule_no_overlap');

  ok('37. exactly one assignment covers any given day', await (async () => {
    const n = (await db.query(
      `SELECT count(*)::int n FROM employee_schedule
        WHERE tenant_id = $1 AND employee_id = $2
          AND daterange(valid_from, valid_to, '[]') @> '2026-03-15'::date`, [T, emp])).rows[0].n;
    return n === 1;
  })());
  ok('    and the day after a handover resolves to the new one', await (async () => {
    const { rows } = await db.query(
      `SELECT work_schedule_id FROM employee_schedule
        WHERE tenant_id = $1 AND employee_id = $2
          AND daterange(valid_from, valid_to, '[]') @> '2026-07-01'::date`, [T, emp]);
    return rows.length === 1 && rows[0].work_schedule_id === other;
  })());

  console.log('\na withdrawn schedule keeps its history\n');

  await db.query(
    'UPDATE work_schedule SET active = false WHERE tenant_id = $1 AND id = $2', [T, sched]);
  ok('38. a schedule can be deactivated',
    (await db.query('SELECT active FROM work_schedule WHERE id = $1', [sched]))
      .rows[0].active === false);
  ok('39. and the assignment naming it is still readable',
    (await db.query(
      `SELECT count(*)::int n FROM employee_schedule
        WHERE tenant_id = $1 AND work_schedule_id = $2`, [T, sched])).rows[0].n === 1,
    'it still describes the days that person worked');
  ok('    with its days intact',
    (await db.query(
      'SELECT count(*)::int n FROM work_schedule_day WHERE work_schedule_id = $1',
      [sched])).rows[0].n === 7);

  await refusedBy('40. and it cannot be deleted while an assignment names it',
    () => db.query('DELETE FROM work_schedule WHERE tenant_id = $1 AND id = $2', [T, sched]),
    '23503');

  ok('41. deleting an unused schedule takes its days with it', await (async () => {
    const spare = (await db.query(
      `INSERT INTO work_schedule (tenant_id, code, name) VALUES ($1, 'ZZSPARE', 'ZZ Spare')
       RETURNING id`, [T])).rows[0].id;
    await db.query(
      `INSERT INTO work_schedule_day (tenant_id, work_schedule_id, day_of_week, working)
       VALUES ($1, $2, 1, true)`, [T, spare]);
    await db.query('DELETE FROM work_schedule WHERE id = $1', [spare]);
    return (await db.query(
      'SELECT count(*)::int n FROM work_schedule_day WHERE work_schedule_id = $1',
      [spare])).rows[0].n === 0;
  })());

  /* ---------------------------------------------------------------- *
   * Cross-tenant
   * ---------------------------------------------------------------- */

  await withScratchTenant(db, async (o) => {
    console.log('\nnothing reaches across a tenant\n');

    const theirSched = (await db.query(
      `INSERT INTO work_schedule (tenant_id, code, name)
       VALUES ($1, 'ZZSIX', 'ZZ Theirs') RETURNING id`, [o.tenant])).rows[0].id;
    ok('42. the same code may exist in two tenants', Boolean(theirSched));

    await refusedBy('43. their employee cannot be assigned our schedule',
      () => db.query(
        `INSERT INTO employee_schedule
           (tenant_id, employee_id, work_schedule_id, valid_from)
         VALUES ($1, $2, $3, '2026-01-01')`, [o.tenant, o.adminEmployeeId, sched]),
      '23503');

    /*
     * A fresh employee with no assignment of their own, so the foreign key is what
     * refuses this rather than the overlap constraint — `emp` already has an
     * open-ended row, and every date overlaps an unbounded range.
     */
    const spareEmp = (await db.query(
      `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                             department_id, site_id, legal_entity_id, shift_id, joined_on)
       SELECT $1, $2, 'ZZ Spare Person', $3, 'active', 'employee',
              (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
              (SELECT id FROM shift WHERE tenant_id = $1 LIMIT 1), '2026-01-01'
       RETURNING id`,
      [T, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        `zz-sched-${Math.random().toString(36).slice(2, 9)}@360.technology`])).rows[0].id;

    await refusedBy('44. our employee cannot be assigned their schedule',
      () => db.query(
        `INSERT INTO employee_schedule
           (tenant_id, employee_id, work_schedule_id, valid_from)
         VALUES ($1, $2, $3, '2030-01-01')`, [T, spareEmp, theirSched]),
      '23503');

    await refusedBy('45. a schedule day cannot borrow another tenant\'s shift',
      () => db.query(
        `INSERT INTO work_schedule_day
           (tenant_id, work_schedule_id, day_of_week, working, shift_id)
         VALUES ($1, $2, 1, true, $3)`, [o.tenant, theirSched, lateShift]),
      '23503');

    await refusedBy('46. nor another tenant\'s schedule',
      () => db.query(
        `INSERT INTO work_schedule_day
           (tenant_id, work_schedule_id, day_of_week, working)
         VALUES ($1, $2, 2, true)`, [o.tenant, sched]),
      '23503');

    /* And the policy, not just the keys: app_rw sees only its own rows. */
    const asApp = new pg.Client({
      connectionString: process.env.DATABASE_URL, ssl: sslConfig(),
    });
    await asApp.connect();
    try {
      await asApp.query('SELECT set_config($1, $2, false)', ['app.tenant_id', o.tenant]);
      const seen = (await asApp.query('SELECT count(*)::int n FROM work_schedule')).rows[0].n;
      ok('47. app_rw in their tenant cannot see our schedules', seen === 1,
        `${seen} — row level security is the boundary, not the keys alone`);
      const mine = (await asApp.query(
        'SELECT count(*)::int n FROM employee_schedule')).rows[0].n;
      ok('    nor our assignments', mine === 0,
        `${mine} — this tenant was created after 0054 ran, so it has none of its own`);
    } finally {
      await asApp.end();
    }
  });

  /* ---------------------------------------------------------------- *
   * The backfill
   * ---------------------------------------------------------------- */

  console.log('\nthe default pattern the migration wrote\n');

  /*
   * 0054 backfilled the tenants that existed when it ran. A scratch tenant is
   * created afterwards, so it correctly has none — provisioning a default for a
   * new tenant is a service concern and belongs to a later phase. Asserted in
   * both directions so the boundary is recorded rather than assumed.
   */
  ok('48. a tenant created after the migration has no default schedule',
    (await db.query(
      "SELECT count(*)::int n FROM work_schedule WHERE tenant_id = $1 AND code = 'DEFAULT_MF'",
      [T])).rows[0].n === 0,
    'the backfill is not a trigger; provisioning a new tenant is a later phase');
});

console.log('\nand the tenants that did exist when it ran\n');

{
  const defs = (await db.query(
    "SELECT w.id, w.tenant_id, w.name, w.active FROM work_schedule w WHERE w.code = 'DEFAULT_MF'"
  )).rows;
  ok('49. every tenant with an employee got one DEFAULT_MF',
    defs.length === (await db.query(
      'SELECT count(DISTINCT tenant_id)::int n FROM employee')).rows[0].n,
    String(defs.length));
  ok('    named so it reads as a system default rather than a configuration',
    defs.every((d) => /Default Monday-Friday/.test(d.name)),
    JSON.stringify(defs.map((d) => d.name)));
  ok('    and active', defs.every((d) => d.active === true));

  for (const d of defs) {
    const days = (await db.query(
      'SELECT day_of_week, working, shift_id FROM work_schedule_day'
      + ' WHERE work_schedule_id = $1 ORDER BY day_of_week', [d.id])).rows;
    ok('50. it carries all seven weekdays', days.length === 7, String(days.length));
    ok('    Monday to Friday working, Saturday and Sunday off',
      days.map((x) => (x.working ? 'W' : '-')).join('') === 'WWWWW--',
      days.map((x) => (x.working ? 'W' : '-')).join(''));
    ok('51. with no shift override anywhere',
      days.every((x) => x.shift_id === null),
      "the employee's own shift is the authority; this changes nobody's hours");
    ok('52. which is exactly what the 2h-B resolver already answers',
      days.filter((x) => x.working).map((x) => x.day_of_week).join(',') === '1,2,3,4,5',
      'ISODOW >= 6 is the week off, so writing it down changes no behaviour');
  }
}


/* ------------------------------------------------------------------ *
 * Exited employees are excluded, and the reasons are asserted too
 *
 * The exclusion is a judgement call, so the facts it rests on are checked rather
 * than described. If somebody later enforces the link between `employee.status =
 * 'exited'` and an exit record, these assertions fail and point back at the
 * decision in 0054 instead of leaving a stale comment behind.
 * ------------------------------------------------------------------ */

console.log('\nan exited employee gets no assignment, on purpose\n');

await withScratchTenant(db, async (x) => {
  const T = x.tenant;

  /*
   * The scratch tenant postdates the migration, so give it the default pattern.
   * The id is not captured because the backfill finds it by code, exactly as the
   * migration does.
   */
  await db.query(
    `INSERT INTO work_schedule (tenant_id, code, name)
     VALUES ($1, 'DEFAULT_MF', 'Default Monday-Friday Schedule')`, [T]);

  const person = async (status) => (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id, joined_on)
     SELECT $1, $2, $3, $4, $5, 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM shift WHERE tenant_id = $1 LIMIT 1), '2026-01-01'
     RETURNING id`,
    [T, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `ZZ ${status} person`,
      `zz-${status}-${Math.random().toString(36).slice(2, 9)}@360.technology`, status]
  )).rows[0].id;

  const activeId = await person('active');
  const noticeId = await person('on_notice');
  const suspendedId = await person('suspended');
  const exitedDated = await person('exited');
  const exitedUndated = await person('exited');

  /*
   * One leaver whose leaving date the schema knows, and one whose it does not.
   * `employee_check` guarantees `left_on >= joined_on`, which is what makes the
   * first safe to backfill and the second impossible to.
   */
  await db.query(
    "UPDATE employee SET left_on = '2026-06-30' WHERE id = $1", [exitedDated]);
  ok('53. one leaver has a recorded leaving date',
    (await db.query('SELECT left_on FROM employee WHERE id = $1', [exitedDated]))
      .rows[0].left_on !== null);
  ok('    and the other does not',
    (await db.query('SELECT left_on FROM employee WHERE id = $1', [exitedUndated]))
      .rows[0].left_on === null,
    'nothing populates it, so this is an ordinary state');

  /* The migration's own backfill statement, run verbatim against this tenant. */
  await db.query(
    `INSERT INTO employee_schedule
       (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
     SELECT e.tenant_id, e.id, ws.id, e.joined_on,
             CASE WHEN e.status = 'exited' THEN e.left_on ELSE NULL END
       FROM employee e
       JOIN work_schedule ws
         ON ws.tenant_id = e.tenant_id AND ws.code = 'DEFAULT_MF'
      WHERE (e.status <> 'exited' OR e.left_on IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM employee_schedule es
           WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id)`);

  const assigned = async (id) => (await db.query(
    'SELECT count(*)::int n FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2',
    [T, id])).rows[0].n;

  ok('54. an active employee is assigned the default, open-ended',
    (await assigned(activeId)) === 1);
  ok('    and so is one on notice', (await assigned(noticeId)) === 1,
    'they are still working, and still measured against a calendar');
  ok('    and a suspended one', (await assigned(suspendedId)) === 1,
    'suspended is not gone');

  ok('55. a leaver with a recorded date is assigned, and closed on it',
    await (async () => {
      const { rows } = await db.query(
        `SELECT to_char(valid_to, 'YYYY-MM-DD') AS vt FROM employee_schedule
          WHERE tenant_id = $1 AND employee_id = $2`, [T, exitedDated]);
      return rows.length === 1 && rows[0].vt === '2026-06-30';
    })(),
    'left_on is a real date the schema already keeps consistent with joined_on');

  ok('56. a leaver with no recorded date is not assigned at all',
    (await assigned(exitedUndated)) === 0,
    'the alternative was valid_to = NULL, which would claim they are still here');
  ok('    so no open-ended row belongs to anybody who has left',
    (await db.query(
      `SELECT count(*)::int n FROM employee_schedule es
         JOIN employee e ON e.id = es.employee_id
        WHERE es.tenant_id = $1 AND es.valid_to IS NULL AND e.status = 'exited'`,
      [T])).rows[0].n === 0);

  ok('57. and the start was never the problem', await (async () => {
    const r = (await db.query(
      'SELECT joined_on FROM employee WHERE id = $1', [exitedUndated])).rows[0];
    return Boolean(r.joined_on);
  })(), 'joined_on is NOT NULL for everybody; only the end is unanswerable');
});

console.log('\nand the three facts that make the end date unanswerable here\n');

{
  const exitCols = (await db.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'employee'
        AND (column_name LIKE '%exit%' OR column_name LIKE '%left%'
          OR column_name LIKE '%last_working%' OR column_name LIKE '%terminat%')
      ORDER BY column_name`)).rows;
  ok('58. employee carries exactly two exit-related columns',
    exitCols.map((r) => r.column_name).join(',') === 'exit_reason,left_on',
    exitCols.map((r) => r.column_name).join(','));
  ok('    left_on is a date, which is what makes a closed range possible',
    exitCols.find((r) => r.column_name === 'left_on')?.data_type === 'date');
  ok('    and nullable, which is what makes it insufficient on its own',
    exitCols.find((r) => r.column_name === 'left_on')?.is_nullable === 'YES',
    'nothing populates it, so a leaver may have none');
  ok('59. but where it is set the schema keeps it consistent with joined_on',
    /left_on IS NULL\) OR \(left_on >= joined_on/.test((await db.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conrelid = 'employee'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%left_on%'`)).rows[0]?.d ?? ''),
    'so [joined_on, left_on] is a valid range without this migration checking');
  ok('60. and nothing requires it when somebody is marked exited',
    (await db.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conrelid = 'employee'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%exited%'
          AND pg_get_constraintdef(oid) LIKE '%left_on%'`)).rows[0].n === 0,
    'which is the gap 2h-D still has to decide about');

  ok('61. nothing ties employee.status = exited to an exit record',
    (await db.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conrelid = 'employee'::regclass
          AND confrelid = 'exit_record'::regclass`)).rows[0].n === 0,
    'no foreign key, so a row can be marked exited on its own');
  ok('    nor does a trigger',
    (await db.query(
      `SELECT count(*)::int n FROM pg_trigger
        WHERE tgrelid = 'employee'::regclass AND NOT tgisinternal`)).rows[0].n === 0);
  ok('    nor a CHECK constraint',
    (await db.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conrelid = 'employee'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%exited%'
          AND pg_get_constraintdef(oid) LIKE '%exit_record%'`)).rows[0].n === 0);

  ok('62. and even an exit record that exists may be withdrawn',
    /withdrawn/.test((await db.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conrelid = 'exit_record'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%notice_period%'`)).rows[0]?.d ?? ''),
    'a withdrawn exit still carries a last_working_day for somebody who stayed');
  ok('    while last_working_day itself is trustworthy where a row does exist',
    (await db.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'exit_record' AND column_name = 'last_working_day'`)
    ).rows[0]?.is_nullable === 'NO',
    'which is why 2h-D can use it, with the two caveats above');

  /*
   * The decision has to stay readable next to the code that made it. A migration
   * is the only place this reasoning lives, and a later phase will go looking.
   */
  const migration = readFileSync(
    join(here, '..', 'db', 'migrations', '0054_work_schedule.sql'), 'utf8');
  ok('63. the migration records how a leaver is treated and why',
    /An exited employee is assigned only when the schema can say when they left/
      .test(migration));
  ok('    naming left_on and the constraint that makes it usable',
    /left_on/.test(migration) && /employee_check/.test(migration));
  ok('    that it is nullable and nothing populates it',
    /nullable and nothing populates it/.test(migration));
  ok('    the unenforced exit_record link', /no foreign key/i.test(migration));
  ok('    and the withdrawn case', /withdrawn/.test(migration));
  /* Comment prose wraps across lines and carries a leading `*`, so flatten first. */
  const prose = migration.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ');
  ok('64. and states that 2h-D must handle the remainder rather than assume',
    /must be handled deliberately/.test(prose)
    && /not by assuming every employee has an assignment/.test(prose),
    'a later phase reading this table has to decide, not default');
  ok('    naming the three ways it could',
    /backfilling from .exit_record.last_working_day./.test(prose)
    && /falling back to the tenant default/.test(prose)
    && /refusing/.test(prose));
  ok('65. and points at these assertions as the tripwire',
    /points back at this decision/.test(prose));
}
/* Idempotence: the backfill statements can run again and change nothing. */
console.log('\nre-running the backfill changes nothing\n');

{
  const snapshot = async () => (await db.query(
    `SELECT (SELECT count(*)::int FROM work_schedule) a,
            (SELECT count(*)::int FROM work_schedule_day) b,
            (SELECT count(*)::int FROM employee_schedule) c`)).rows[0];
  const was = await snapshot();

  await db.query(
    `INSERT INTO work_schedule (tenant_id, code, name, description, active)
     SELECT DISTINCT e.tenant_id, 'DEFAULT_MF', 'Default Monday-Friday Schedule', 'x', true
       FROM employee e ON CONFLICT (tenant_id, code) DO NOTHING`);
  await db.query(
    `INSERT INTO work_schedule_day
       (tenant_id, work_schedule_id, day_of_week, working, shift_id)
     SELECT ws.tenant_id, ws.id, d.dow, d.dow <= 5, NULL
       FROM work_schedule ws
      CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6), (7)) AS d(dow)
      WHERE ws.code = 'DEFAULT_MF'
      ON CONFLICT (tenant_id, work_schedule_id, day_of_week) DO NOTHING`);
  await db.query(
    `INSERT INTO employee_schedule
       (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
     SELECT e.tenant_id, e.id, ws.id, e.joined_on,
             CASE WHEN e.status = 'exited' THEN e.left_on ELSE NULL END
       FROM employee e
       JOIN work_schedule ws
         ON ws.tenant_id = e.tenant_id AND ws.code = 'DEFAULT_MF'
      WHERE (e.status <> 'exited' OR e.left_on IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM employee_schedule es
           WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id)`);

  const now = await snapshot();
  ok('52. the three statements are idempotent',
    now.a === was.a && now.b === was.b && now.c === was.c,
    `${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
}

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant is as it was, plus its default schedule\n');

const after = await census();
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
ok(`employees ${after.e}`, after.e === before.e, `was ${before.e}`);
ok(`shifts ${after.s}`, after.s === before.s, `was ${before.s}`);
ok(`attendance rows ${after.a}`, after.a === before.a,
  `was ${before.a} — no attendance was materialised`);
ok(`leave requests ${after.lr}`, after.lr === before.lr, `was ${before.lr}`);
ok('its work schedules are unchanged by this run', after.ws === before.ws,
  `was ${before.ws}, now ${after.ws}`);
ok('and so are its assignments', after.es === before.es, `was ${before.es}`);
ok('every live employee that is still here has exactly one assignment',
  (await db.query(
    `SELECT count(*)::int n FROM employee e
      WHERE e.status <> 'exited'
        AND (SELECT count(*) FROM employee_schedule es WHERE es.employee_id = e.id) <> 1`
  )).rows[0].n === 0);
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
  console.error(`${failed} work schedule checks failed`);
  process.exit(1);
}
console.log('a schedule says which days, a shift says which hours, and one pattern covers any day');
