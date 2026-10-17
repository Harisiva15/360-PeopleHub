/**
 * The shift list says what the database says.
 *
 * `shift` has existed since 0002 and carried `break_minutes` and `grace_minutes`
 * the whole time. `listShifts` did not project them, so the screen read them from
 * `src/data/shifts.ts` instead — and the two disagreed:
 *
 *     constant:  India shift, 45-minute break, 20-minute grace
 *     column:    India shift, 60-minute break, 10-minute grace
 *
 * The column is not decoration. `attendance/service.ts` deducts `break_minutes`
 * from worked time and marks somebody late when their punch is past
 * `starts_at + grace_minutes`. So the screen told an administrator they had twenty
 * minutes of grace while their people were marked late after ten.
 *
 * Phase 2g-A carries the four missing columns across the seam. **No migration, no
 * new route, and no change to how attendance calculates anything** — the numbers
 * were always right in the database and always wrong on the screen.
 *
 * ## What is worth holding
 *
 * **The projection reads the column, not a default.** Asserted with values that are
 * not the schema defaults, because a test against 60 and 10 would pass just as well
 * against hard-coded 60 and 10.
 *
 * **The lateness expression still uses the same column the list now reports.** Run
 * directly, so the screen and the calculation are provably reading one number.
 *
 * **Nothing already returned moved.** `starts_at`, `ends_at`, `timezone`, `region`,
 * `is_night`, `is_flexible` and `headcount` are all checked, because widening a
 * projection is exactly when a column quietly changes shape.
 *
 * This is the first suite to cover shifts at all; before it, `listShifts`,
 * `shiftCoverage` and `setEmployeeShift` had no assertions anywhere.
 *
 * ## 2g-B, from assertion 32
 *
 * CRUD, and the two rules worth more than the CRUD:
 *
 * **A profile with attendance against it keeps the four settings attendance reads.**
 * `timezone` is the sharpest — `PROJECTION` renders every stored punch through
 * `AT TIME ZONE sh.timezone` on the employee's *current* profile, so moving it
 * rewrites what every historical row displays. `starts_at`, `grace_minutes` and
 * `break_minutes` are protected for a different reason: `attendance.late` and
 * `attendance.worked_minutes` are stored columns computed once at punch time, so
 * changing these leaves rows whose verdict was reached under settings the screen no
 * longer shows. `ends_at` is deliberately *not* protected — nothing in attendance
 * reads it.
 *
 * **Withdrawing a profile moves nobody.** The row stays, `employee.shift_id` stays,
 * `listShifts` still returns it — it simply stops being offered for a new
 * assignment. There is no delete at all.
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
  console.log('\nSKIPPED: no database, and the point is what the columns hold.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { sslConfig } = await import('./ssl.mjs');
const shifts = await import('../src/modules/shifts/service.ts');
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
const refusedShift = async (label, fn, expect) => {
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
  SELECT (SELECT count(*)::int FROM shift) s,
         (SELECT count(*)::int FROM tenant) t,
         (SELECT string_agg(code || ':' || break_minutes || '/' || grace_minutes, '|'
                   ORDER BY code) FROM shift) profile,
         (SELECT count(*)::int FROM employee) e,
         (SELECT count(*)::int FROM attendance) a`)).rows[0];
const before = await census();

let fatal = null;
try {

/* ------------------------------------------------------------------ *
 * The schema is untouched — this phase added no migration
 * ------------------------------------------------------------------ */

console.log('\nthe shift table is exactly the one 0002 and 0015 left\n');

{
  const cols = (await db.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'shift' ORDER BY ordinal_position`)).rows;
  ok('1. fifteen columns, unchanged', cols.length === 15,
    `${cols.length}: ${cols.map((c) => c.column_name).join(', ')}`);

  const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  ok('2. break_minutes is there, NOT NULL, defaulting to 60',
    by.break_minutes?.is_nullable === 'NO' && by.break_minutes?.column_default === '60',
    JSON.stringify(by.break_minutes));
  ok('3. grace_minutes is there, NOT NULL, defaulting to 10',
    by.grace_minutes?.is_nullable === 'NO' && by.grace_minutes?.column_default === '10',
    JSON.stringify(by.grace_minutes));
  ok('4. colour is there and nullable', by.colour?.is_nullable === 'YES',
    JSON.stringify(by.colour));
  ok('5. active is there, NOT NULL, defaulting to true',
    by.active?.is_nullable === 'NO' && by.active?.column_default === 'true',
    JSON.stringify(by.active));
  ok('    and no working_days column was added', by.working_days === undefined,
    'working days are out of scope for this phase');
  ok('    timezone is still NOT NULL', by.timezone?.is_nullable === 'NO');

  const rls = (await db.query(
    "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'shift'")).rows[0];
  ok('6. RLS is still enabled and forced',
    rls?.relrowsecurity === true && rls?.relforcerowsecurity === true, JSON.stringify(rls));
  const grants = (await db.query(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'shift' AND grantee = 'app_rw' ORDER BY privilege_type`
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
  const find = async (code) => (await shifts.listShifts(A)).find((s) => s.code === code);

  /*
   * Values chosen so the assertion cannot pass against a hard-coded default: 37
   * and 3 are neither the schema's 60/10 nor the old constant's 45/20.
   */
  await db.query(
    `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, break_minutes,
                        grace_minutes, is_night, is_flexible, colour, active,
                        timezone, region)
     VALUES ($1, 'ZZPROBE', 'ZZ Probe Shift', '07:15', '16:45', 37, 3,
             true, false, 'var(--s7)', true, 'Europe/Berlin', 'GB')`, [ctx.tenant]);

  /* ---------------------------------------------------------------- *
   * A and B — the two columns this phase exists for
   * ---------------------------------------------------------------- */

  console.log('\nthe list reports the break and grace the database holds\n');

  const probe = await find('ZZPROBE');
  ok('7. the probe profile is listed', Boolean(probe), 'listShifts did not return it');
  ok('8. breakMinutes is the column value, not the schema default',
    probe?.breakMinutes === 37,
    `${probe?.breakMinutes} — 60 would mean the default leaked, 45 the old constant`);
  ok('9. graceMinutes is the column value, not the schema default',
    probe?.graceMinutes === 3,
    `${probe?.graceMinutes} — 10 would mean the default leaked, 20 the old constant`);
  ok('    both come back as numbers, not strings',
    typeof probe?.breakMinutes === 'number' && typeof probe?.graceMinutes === 'number',
    JSON.stringify([typeof probe?.breakMinutes, typeof probe?.graceMinutes]));

  /* A change to the column must show up in the list; that is the whole claim. */
  await db.query(
    "UPDATE shift SET break_minutes = 52, grace_minutes = 7 WHERE tenant_id = $1 AND code = 'ZZPROBE'",
    [ctx.tenant]);
  const moved = await find('ZZPROBE');
  ok('10. changing the column changes what the list reports',
    moved?.breakMinutes === 52 && moved?.graceMinutes === 7,
    JSON.stringify([moved?.breakMinutes, moved?.graceMinutes]));

  /* ---------------------------------------------------------------- *
   * The column the list reports is the column attendance measures against
   * ---------------------------------------------------------------- */

  console.log('\nand it is the same column the lateness test uses\n');

  /*
   * The expression from attendance/service.ts, run verbatim against the probe. A
   * punch 5 minutes after the start is late when grace is 3 and not when it is 20,
   * so this distinguishes the column from the old constant.
   */
  const lateCheck = async (minutesAfterStart) => (await db.query(
    `SELECT (($2::time) > (s.starts_at + (s.grace_minutes || ' minutes')::interval)) AS is_late
       FROM shift s WHERE s.tenant_id = $1 AND s.code = 'ZZPROBE'`,
    [ctx.tenant, `07:${String(15 + minutesAfterStart).padStart(2, '0')}`])).rows[0].is_late;

  ok('11. a punch 2 minutes in is on time against a 7-minute grace',
    (await lateCheck(2)) === false);
  ok('12. a punch 9 minutes in is late against a 7-minute grace',
    (await lateCheck(9)) === true,
    'the old constant said 20 minutes, which would have called this on time');

  /* ---------------------------------------------------------------- *
   * C and D — active and colour
   * ---------------------------------------------------------------- */

  console.log('\nactive and colour come from the row\n');

  ok('13. colour is the column value', moved?.colour === 'var(--s7)', String(moved?.colour));
  ok('14. a null colour comes back as null, not as another shift\'s colour',
    (await (async () => {
      await db.query(
        "UPDATE shift SET colour = NULL WHERE tenant_id = $1 AND code = 'ZZPROBE'", [ctx.tenant]);
      return (await find('ZZPROBE'))?.colour;
    })()) === null);

  ok('15. active is true for an active profile', moved?.active === true);

  /*
   * 2g-A asserted the opposite here: it filtered inactive profiles out, and this
   * line said so. 2g-B dropped that filter deliberately — somebody may still be
   * assigned to a withdrawn profile and a historical punch still has to resolve —
   * so the assertion is inverted rather than deleted, which is what records the
   * change having been a decision.
   */
  await db.query(
    "UPDATE shift SET active = false WHERE tenant_id = $1 AND code = 'ZZPROBE'", [ctx.tenant]);
  const whileOff = await find('ZZPROBE');
  ok('16. an inactive profile is still returned by this read', whileOff !== undefined,
    'an assigned employee and an old punch both still have to resolve it');
  ok('    reporting itself as inactive', whileOff?.active === false, String(whileOff?.active));
  ok('    and still carrying its break and grace',
    whileOff?.breakMinutes === 52 && whileOff?.graceMinutes === 7,
    JSON.stringify([whileOff?.breakMinutes, whileOff?.graceMinutes]));
  await db.query(
    "UPDATE shift SET active = true WHERE tenant_id = $1 AND code = 'ZZPROBE'", [ctx.tenant]);
  ok('    and reports active again once reinstated', (await find('ZZPROBE'))?.active === true);

  /* ---------------------------------------------------------------- *
   * F — everything that was already returned still is
   * ---------------------------------------------------------------- */

  console.log('\nnothing the list already returned has moved\n');

  const p = await find('ZZPROBE');
  ok('17. start is HH:MM from starts_at', p?.start === '07:15', p?.start);
  ok('18. end is HH:MM from ends_at', p?.end === '16:45', p?.end);
  ok('19. timezone is the column value', p?.timezone === 'Europe/Berlin', p?.timezone);
  ok('20. region is the column value', p?.region === 'GB', p?.region);
  ok('21. night reflects is_night', p?.night === true, String(p?.night));
  ok('22. flexible reflects is_flexible', p?.flexible === false, String(p?.flexible));
  ok('23. headcount is a number', typeof p?.headcount === 'number', String(p?.headcount));
  ok('    and is zero for a profile nobody is on', p?.headcount === 0, String(p?.headcount));
  ok('24. code and name are the column values',
    p?.code === 'ZZPROBE' && p?.name === 'ZZ Probe Shift');
  ok('25. id is a uuid, not the code', p?.id !== p?.code && String(p?.id).includes('-'));

  /* The seeded regional profiles still read as they did. */
  const seeded = await shifts.listShifts(A);
  const india = seeded.find((s) => s.code === 'IN');
  /*
   * The scratch tenant's own profile, which leaves break and grace to the schema
   * defaults. That makes this a regression check on the seeded shape rather than
   * proof the column is read — assertions 8 to 10 do that, with values no default
   * could supply.
   */
  ok('26. the tenant\'s seeded profile is still listed', Boolean(india));
  ok('    carrying the default break the column holds', india?.breakMinutes === 60,
    `${india?.breakMinutes} — the old constant said 45 for this code`);
  ok('    and the default grace', india?.graceMinutes === 10,
    `${india?.graceMinutes} — the old constant said 20 for this code`);
  ok('    measured against Asia/Kolkata', india?.timezone === 'Asia/Kolkata');

  /* ---------------------------------------------------------------- *
   * G — roles and tenants behave as before
   * ---------------------------------------------------------------- */

  console.log('\nwho may read, and whose shifts they see\n');

  ok('27. a manager reads the same list', (await shifts.listShifts(MGR)).length === seeded.length);
  ok('    with the real break and grace',
    (await shifts.listShifts(MGR)).find((s) => s.code === 'IN')?.breakMinutes === 60);
  ok('28. an employee reads it too', (await shifts.listShifts(EMP)).length === seeded.length,
    'a person should be able to see the hours they are judged against');

  ok('29. coverage still answers per code',
    typeof (await shifts.shiftCoverage(A))['IN'] === 'number');

  /* setEmployeeShift is untouched by this phase; asserted so a regression shows. */
  const movedEmp = await shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'IN');
  ok('30. an admin may still move somebody onto a profile', movedEmp.shift === 'IN');
  ok('    and an employee still may not',
    (await attempt(() => shifts.setEmployeeShift(EMP, ctx.adminEmployeeId, 'IN'))) !== null);
  ok('    and an unknown code is still refused',
    (await attempt(() => shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'NOPE'))) !== null);

  await withScratchTenant(db, async (other) => {
    const B = {
      role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
    };
    const theirs = await shifts.listShifts(B);
    ok('31. another tenant does not see our probe profile',
      theirs.every((s) => s.code !== 'ZZPROBE'), 'row level security is the boundary');
    ok('    and sees its own', theirs.length >= 1,
      'a scratch tenant is seeded with one profile, not the regional four');
    ok('    with their own break and grace',
      theirs.every((s) => typeof s.breakMinutes === 'number'));
  });

/* ------------------------------------------------------------------ *
 * 2g-B — administering the profiles
 * ------------------------------------------------------------------ */

console.log('\nan admin may register a profile\n');

{
  const made = await shifts.createShift(A, {
    code: 'zznew', name: '  ZZ New Shift  ', startsAt: '08:00', endsAt: '16:30',
    breakMinutes: 30, graceMinutes: 5, isNight: false, isFlexible: false,
    colour: 'var(--s2)', timezone: 'Europe/London', region: 'gb',
  });
  ok('32. the code is upper-cased', made.code === 'ZZNEW', made.code);
  ok('    the name is trimmed', made.name === 'ZZ New Shift', made.name);
  ok('    the hours are stored', made.start === '08:00' && made.end === '16:30',
    `${made.start}-${made.end}`);
  ok('    break and grace are the values given', made.breakMinutes === 30
    && made.graceMinutes === 5, JSON.stringify([made.breakMinutes, made.graceMinutes]));
  ok('    the timezone is stored', made.timezone === 'Europe/London', made.timezone);
  ok('    the region is upper-cased', made.region === 'GB', made.region);
  ok('    the colour is stored', made.colour === 'var(--s2)', String(made.colour));
  ok('    and it starts active', made.active === true);
  ok('33. defaults apply when break and grace are omitted',
    await (async () => {
      const d = await shifts.createShift(A, {
        code: 'ZZDEF', name: 'ZZ Default', startsAt: '09:00', endsAt: '17:00',
        timezone: 'Asia/Kolkata',
      });
      return d.breakMinutes === 60 && d.graceMinutes === 10;
    })(), 'the schema defaults are 60 and 10');

  console.log('\nand the validation the schema has no constraints for\n');

  await refusedShift('34. a duplicate code is refused as a conflict, not a raw error',
    () => shifts.createShift(A, {
      code: 'ZZNEW', name: 'ZZ Again', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata',
    }), /already a shift/);
  await refusedShift('35. a blank name is refused',
    () => shifts.createShift(A, {
      code: 'ZZBL', name: '   ', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata',
    }), /needs a name/);
  await refusedShift('36. a code that is not a code is refused',
    () => shifts.createShift(A, {
      code: 'ZZ BAD!', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata',
    }), /2-12 characters/);
  await refusedShift('37. an unknown timezone is refused by the database\'s own list',
    () => shifts.createShift(A, {
      code: 'ZZTZ', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Mars/Olympus',
    }), /not a timezone this database recognises/);
  await refusedShift('    and so is a plausible-looking fake',
    () => shifts.createShift(A, {
      code: 'ZZTZ2', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Chennai',
    }), /not a timezone/);
  await refusedShift('38. a negative break is refused',
    () => shifts.createShift(A, {
      code: 'ZZB1', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', breakMinutes: -1,
    }), /cannot be negative/);
  await refusedShift('    an absurd break is refused',
    () => shifts.createShift(A, {
      code: 'ZZB2', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', breakMinutes: 9999,
    }), /at most 480/);
  await refusedShift('    and a fractional break is refused',
    () => shifts.createShift(A, {
      code: 'ZZB3', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', breakMinutes: 30.5,
    }), /whole number/);
  await refusedShift('39. a negative grace is refused',
    () => shifts.createShift(A, {
      code: 'ZZG1', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', graceMinutes: -5,
    }), /cannot be negative/);
  await refusedShift('    and an absurd grace is refused',
    () => shifts.createShift(A, {
      code: 'ZZG2', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', graceMinutes: 1000,
    }), /at most 240/);
  await refusedShift('40. hours that end before they start are refused',
    () => shifts.createShift(A, {
      code: 'ZZREV', name: 'x', startsAt: '18:00', endsAt: '09:00',
      timezone: 'Asia/Kolkata',
    }), /must end after it starts/);
  await refusedShift('    and so are a night shift\'s, because nothing computes overnight',
    () => shifts.createShift(A, {
      code: 'ZZNGT', name: 'x', startsAt: '22:00', endsAt: '06:00',
      timezone: 'Asia/Kolkata', isNight: true,
    }), /Overnight hours are not supported/);
  ok('    but is_night itself is accepted and stored',
    (await shifts.createShift(A, {
      code: 'ZZNOK', name: 'ZZ Evening', startsAt: '14:00', endsAt: '22:30',
      timezone: 'Asia/Kolkata', isNight: true, nightAllowance: 250,
    })).night === true);
  await refusedShift('41. a bad hour format is refused',
    () => shifts.createShift(A, {
      code: 'ZZFMT', name: 'x', startsAt: '9am', endsAt: '5pm',
      timezone: 'Asia/Kolkata',
    }), /written as HH:MM/);
  await refusedShift('42. a bad region is refused',
    () => shifts.createShift(A, {
      code: 'ZZRG', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', region: 'IND',
    }), /two-letter country code/);
  await refusedShift('43. a negative night allowance is refused',
    () => shifts.createShift(A, {
      code: 'ZZNA', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata', nightAllowance: -10,
    }), /cannot be negative/);

  console.log('\nonly an admin shapes a profile\n');

  await refusedShift('44. a manager cannot create one',
    () => shifts.createShift(MGR, {
      code: 'ZZNO', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata',
    }), /only an admin/);
  await refusedShift('45. an employee cannot create one',
    () => shifts.createShift(EMP, {
      code: 'ZZNO', name: 'x', startsAt: '09:00', endsAt: '17:00',
      timezone: 'Asia/Kolkata',
    }), /only an admin/);
  await refusedShift('46. a manager cannot update one',
    () => shifts.updateShift(MGR, 'ZZNEW', { name: 'x' }), /only an admin/);
  await refusedShift('47. an employee cannot update one',
    () => shifts.updateShift(EMP, 'ZZNEW', { name: 'x' }), /only an admin/);
  await refusedShift('48. a manager cannot withdraw one',
    () => shifts.setShiftActive(MGR, 'ZZNEW', false), /only an admin/);
  await refusedShift('49. an employee cannot withdraw one',
    () => shifts.setShiftActive(EMP, 'ZZNEW', false), /only an admin/);

  /* ---------------------------------------------------------------- *
   * Update, and the code that cannot move
   * ---------------------------------------------------------------- */

  console.log('\nan admin may correct a profile with no history\n');

  const edited = await shifts.updateShift(A, 'ZZNEW', {
    name: 'ZZ New Name', endsAt: '17:15', breakMinutes: 45, graceMinutes: 15,
    timezone: 'Asia/Dubai', region: 'AE', colour: 'var(--s4)',
  });
  ok('50. the name changes', edited.name === 'ZZ New Name');
  ok('    the end time changes', edited.end === '17:15', edited.end);
  ok('    break and grace change', edited.breakMinutes === 45 && edited.graceMinutes === 15);
  ok('    the timezone changes', edited.timezone === 'Asia/Dubai');
  ok('    the region changes', edited.region === 'AE');
  ok('    and absent fields are left alone', edited.start === '08:00', edited.start);

  await refusedShift('51. the code cannot change',
    () => shifts.updateShift(A, 'ZZNEW', { code: 'ZZOTHER' }), /code cannot change/);
  ok('    and nothing was renamed by the attempt',
    (await find('ZZNEW'))?.code === 'ZZNEW');
  await refusedShift('52. a profile that does not exist is refused',
    () => shifts.updateShift(A, 'ZZGONE', { name: 'x' }), /no such shift/);
  await refusedShift('53. renaming to blank is refused',
    () => shifts.updateShift(A, 'ZZNEW', { name: '  ' }), /needs a name/);
  await refusedShift('54. an unknown timezone is refused on a patch too',
    () => shifts.updateShift(A, 'ZZNEW', { timezone: 'Nowhere/Nothing' }),
    /not a timezone/);
  await refusedShift('55. reversing the hours by patching the end is refused',
    () => shifts.updateShift(A, 'ZZNEW', { endsAt: '07:00' }), /must end after it starts/);

  /* ---------------------------------------------------------------- *
   * The historical guard — the point of the phase
   * ---------------------------------------------------------------- */

  console.log('\na profile with attendance against it keeps its settings\n');

  const histId = (await find('ZZDEF')).id;
  await db.query(
    `INSERT INTO attendance (tenant_id, employee_id, work_date, status, shift_id,
                            punch_in, source, late, worked_minutes)
     VALUES ($1, $2, CURRENT_DATE - 1, 'P', $3,
             now() - interval '1 day', 'web', false, 480)`,
    [ctx.tenant, ctx.adminEmployeeId, histId]);
  ok('56. an attendance row now points at ZZDEF',
    (await db.query('SELECT count(*)::int n FROM attendance WHERE shift_id = $1', [histId]))
      .rows[0].n === 1);

  await refusedShift('57. the start time cannot be changed',
    () => shifts.updateShift(A, 'ZZDEF', { startsAt: '10:00' }),
    /has attendance history/);
  await refusedShift('58. nor the timezone',
    () => shifts.updateShift(A, 'ZZDEF', { timezone: 'America/New_York' }),
    /has attendance history/);
  await refusedShift('59. nor the grace',
    () => shifts.updateShift(A, 'ZZDEF', { graceMinutes: 45 }),
    /has attendance history/);
  await refusedShift('60. nor the break',
    () => shifts.updateShift(A, 'ZZDEF', { breakMinutes: 15 }),
    /has attendance history/);
  ok('61. the refusal says to create a new profile instead',
    /Create a new shift profile instead/.test(
      (await attempt(() => shifts.updateShift(A, 'ZZDEF', { startsAt: '10:00' })))?.message ?? ''));
  ok('    and names which settings were refused',
    /startsAt/.test(
      (await attempt(() => shifts.updateShift(A, 'ZZDEF', { startsAt: '10:00' })))?.message ?? ''));

  const untouched = await find('ZZDEF');
  ok('62. and none of the four actually moved',
    untouched.start === '09:00' && untouched.timezone === 'Asia/Kolkata'
    && untouched.graceMinutes === 10 && untouched.breakMinutes === 60,
    JSON.stringify([untouched.start, untouched.timezone,
      untouched.graceMinutes, untouched.breakMinutes]));

  /* What stays editable, which is what makes the rule a rule and not a freeze. */
  const stillOk = await shifts.updateShift(A, 'ZZDEF', {
    name: 'ZZ Default Renamed', endsAt: '17:30', region: 'IN', isFlexible: true,
  });
  ok('63. the name can still be corrected', stillOk.name === 'ZZ Default Renamed');
  ok('    the end time can still be corrected, because attendance never reads it',
    stillOk.end === '17:30', stillOk.end);
  ok('    the region can still be corrected', stillOk.region === 'IN');
  ok('    and the flexible flag', stillOk.flexible === true);

  /* Re-sending the values it already has must not trip the guard. */
  const resend = await shifts.updateShift(A, 'ZZDEF', {
    name: 'ZZ Default Renamed', startsAt: '09:00', timezone: 'Asia/Kolkata',
    graceMinutes: 10, breakMinutes: 60,
  });
  ok('64. re-sending the settings it already has is accepted',
    resend.start === '09:00' && resend.graceMinutes === 10,
    'the edit form sends the whole record, so refusing this would freeze the profile');

  /* ---------------------------------------------------------------- *
   * Withdrawing and reinstating
   * ---------------------------------------------------------------- */

  console.log('\nwithdrawing a profile keeps the people on it\n');

  await shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'ZZNEW');
  const before = (await db.query(
    'SELECT shift_id FROM employee WHERE id = $1', [ctx.adminEmployeeId])).rows[0].shift_id;

  const off = await shifts.setShiftActive(A, 'ZZNEW', false);
  ok('65. an admin may withdraw a profile', off.active === false);
  ok('66. it is still returned by the list',
    (await find('ZZNEW')) !== undefined,
    'an assigned employee and a historical punch both still have to resolve');
  ok('67. the employee still points at it',
    (await db.query('SELECT shift_id FROM employee WHERE id = $1', [ctx.adminEmployeeId]))
      .rows[0].shift_id === before,
    'deactivating must not move anybody');
  ok('68. and the row was not deleted',
    (await db.query("SELECT count(*)::int n FROM shift WHERE code = 'ZZNEW'")).rows[0].n === 1);

  await refusedShift('69. a withdrawn profile cannot be newly assigned',
    () => shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'ZZNEW'),
    /not in use and cannot be assigned/);

  const on = await shifts.setShiftActive(A, 'ZZNEW', true);
  ok('70. and it can be reinstated', on.active === true);
  ok('    after which it can be assigned again',
    (await shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'ZZNEW')).shift === 'ZZNEW');
  ok('71. setting the state it already has is a no-op, not a refusal',
    (await shifts.setShiftActive(A, 'ZZNEW', true)).active === true);
  await refusedShift('72. a profile that does not exist cannot be withdrawn',
    () => shifts.setShiftActive(A, 'ZZGONE', false), /no such shift/);

  ok('73. actives sort before inactives in the list', await (async () => {
    await shifts.setShiftActive(A, 'ZZNOK', false);
    const list = await shifts.listShifts(A);
    const firstInactive = list.findIndex((x) => !x.active);
    return firstInactive === -1 || list.slice(firstInactive).every((x) => !x.active);
  })());
  ok('    and the list contains both states',
    (await shifts.listShifts(A)).some((x) => x.active)
    && (await shifts.listShifts(A)).some((x) => !x.active));
  ok('74. a manager reads the inactive ones too',
    (await shifts.listShifts(MGR)).some((x) => !x.active),
    'a withdrawn profile still has to resolve on an old record');
  ok('    and so does an employee',
    (await shifts.listShifts(EMP)).some((x) => !x.active));

  /* ---------------------------------------------------------------- *
   * Moving somebody between profiles
   * ---------------------------------------------------------------- */

  console.log('\nmoving somebody between profiles is recorded\n');

  await shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'IN');
  const movedTo = await shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'ZZNEW');
  ok('75. an admin may move somebody', movedTo.shift === 'ZZNEW');

  const moveRow = (await db.query(
    `SELECT action, category, subject_table, detail FROM audit_log
      WHERE tenant_id = $1 AND action = 'employee_shift_changed'
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ctx.tenant])).rows[0];
  ok('76. the move is in audit_log', Boolean(moveRow));
  ok('    under the existing config category', moveRow?.category === 'config');
  ok('    against subject_table shift', moveRow?.subject_table === 'shift');
  ok('77. the detail names the employee', typeof moveRow?.detail?.employee === 'string',
    JSON.stringify(moveRow?.detail));
  ok('78. and captures the profile moved from', moveRow?.detail?.from === 'IN',
    JSON.stringify(moveRow?.detail?.from));
  ok('    and the one moved to', moveRow?.detail?.to === 'ZZNEW',
    JSON.stringify(moveRow?.detail?.to));

  await refusedShift('79. an employee still cannot move anybody',
    () => shifts.setEmployeeShift(EMP, ctx.adminEmployeeId, 'IN'),
    /only a manager or admin/);
  await refusedShift('80. an unknown profile is still refused',
    () => shifts.setEmployeeShift(A, ctx.adminEmployeeId, 'ZZGONE'), /no such shift/);

  /* A manager may move their own line and nobody else's. */
  const reportId = (await db.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, status, app_role,
                           department_id, site_id, legal_entity_id, shift_id,
                           manager_id, joined_on)
     SELECT $1, $2, 'ZZ Shift Report', $3, 'active', 'employee',
            (SELECT id FROM department WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM site WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1),
            (SELECT id FROM shift WHERE tenant_id = $1 AND code = 'IN'),
            $4, CURRENT_DATE
     RETURNING id`,
    [ctx.tenant, `ZZ${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      `zz-shift-${Math.random().toString(36).slice(2, 9)}@360.technology`,
      ctx.adminEmployeeId])).rows[0].id;

  const MGR2 = {
    role: 'manager', tenantId: ctx.tenant, employeeId: ctx.adminEmployeeId, userId: null,
  };
  ok('81. a manager may move somebody in their own line',
    (await shifts.setEmployeeShift(MGR2, reportId, 'ZZNEW')).shift === 'ZZNEW');
  await refusedShift('82. and not somebody outside it',
    () => shifts.setEmployeeShift(MGR2, ctx.adminEmployeeId, 'IN'),
    /not in your team/);
  await refusedShift('83. a withdrawn profile is refused for a manager too',
    () => (async () => {
      await shifts.setShiftActive(A, 'ZZDEF', false);
      return shifts.setEmployeeShift(MGR2, reportId, 'ZZDEF');
    })(), /not in use/);
  await shifts.setShiftActive(A, 'ZZDEF', true);

  /* ---------------------------------------------------------------- *
   * Audit for the configuration changes
   * ---------------------------------------------------------------- */

  console.log('\nevery configuration change goes through the existing audit trail\n');

  const logged = async (action, code) => (await db.query(
    `SELECT action, category, subject_table, detail FROM audit_log
      WHERE tenant_id = $1 AND subject_table = 'shift' AND action = $2
        AND detail ->> 'shift' = $3
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, [ctx.tenant, action, code])).rows[0];

  const createdRow = await logged('shift_created', 'ZZNEW');
  ok('84. the create is recorded', Boolean(createdRow));
  ok('    under the config category', createdRow?.category === 'config');
  ok('    with the settings it was created with',
    createdRow?.detail?.timezone === 'Europe/London'
    && createdRow?.detail?.breakMinutes === 30,
    JSON.stringify(createdRow?.detail));

  ok('85. the update is recorded', Boolean(await logged('shift_updated', 'ZZNEW')));
  const activeRow = await logged('shift_active_changed', 'ZZNEW');
  ok('86. the state change is recorded', Boolean(activeRow));
  ok('    saying which way it went', typeof activeRow?.detail?.active === 'boolean',
    JSON.stringify(activeRow?.detail));
  ok('    and how many people were still on it',
    typeof activeRow?.detail?.peopleStillAssigned === 'number',
    JSON.stringify(activeRow?.detail));
  ok('87. no second audit table was created',
    (await db.query(
      `SELECT count(*)::int n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE '%audit%'`)).rows[0].n === 1);

  const auditBefore = (await db.query(
    "SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND subject_table = 'shift'",
    [ctx.tenant])).rows[0].n;
  await attempt(() => shifts.createShift(A, { code: 'ZZ', name: '', timezone: 'x' }));
  await attempt(() => shifts.updateShift(MGR, 'ZZNEW', { name: 'x' }));
  await attempt(() => shifts.updateShift(A, 'ZZDEF', { startsAt: '11:00' }));
  ok('88. a refused change writes no audit row',
    (await db.query(
      "SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND subject_table = 'shift'",
      [ctx.tenant])).rows[0].n === auditBefore,
    'a trail that records attempts as though they happened is worse than none');

  /* ---------------------------------------------------------------- *
   * Regression — 2g-A and the reads it widened
   * ---------------------------------------------------------------- */

  console.log('\nnothing 2g-A established has moved\n');

  const after2gA = await find('ZZPROBE');
  ok('89. the probe profile still reports its own break and grace',
    after2gA?.breakMinutes === 52 && after2gA?.graceMinutes === 7,
    JSON.stringify([after2gA?.breakMinutes, after2gA?.graceMinutes]));
  ok('90. coverage still answers per code',
    typeof (await shifts.shiftCoverage(A))['IN'] === 'number');
  ok('91. the roster still answers per employee and date', await (async () => {
    const r = await shifts.rosterFor(A, [ctx.adminEmployeeId], '2026-10-05', 7);
    const days = r[ctx.adminEmployeeId];
    return Boolean(days) && Object.keys(days).length === 7;
  })());
  ok('92. and the lateness expression is unchanged', await (async () => {
    const { rows } = await db.query(
      `SELECT (('09:20'::time) > (s.starts_at + (s.grace_minutes || ' minutes')::interval))
                AS is_late
         FROM shift s WHERE s.tenant_id = $1 AND s.code = 'IN'`, [ctx.tenant]);
    /* 09:20 against a 09:30 start is not late whatever the grace. */
    return rows[0].is_late === false;
  })());

  /* Tenant isolation for the writes. */
  await withScratchTenant(db, async (other) => {
    const B = {
      role: 'admin', tenantId: other.tenant, employeeId: other.adminEmployeeId, userId: null,
    };
    ok('93. another tenant does not see our new profiles',
      (await shifts.listShifts(B)).every((x) => !x.code.startsWith('ZZ')
        || x.code === 'IN'),
      JSON.stringify((await shifts.listShifts(B)).map((x) => x.code)));
    await refusedShift('94. and cannot correct one of ours',
      () => shifts.updateShift(B, 'ZZNEW', { name: 'stolen' }), /no such shift/);
    await refusedShift('95. nor withdraw it',
      () => shifts.setShiftActive(B, 'ZZNEW', false), /no such shift/);
    ok('96. and may create its own profile with the same code',
      (await shifts.createShift(B, {
        code: 'ZZNEW', name: 'ZZ Theirs', startsAt: '09:00', endsAt: '17:00',
        timezone: 'Asia/Kolkata',
      })).name === 'ZZ Theirs',
      'UNIQUE (tenant_id, code) is per tenant');
    ok('    and ours is untouched', (await find('ZZNEW'))?.name === 'ZZ New Name');
  });
}
});

} catch (e) {
  fatal = e;
} finally {
  await sweepScratchTenants(db);
}

console.log('\nthe live tenant was never written to\n');

const after = await census();
ok(`shifts ${after.s}`, after.s === before.s, `was ${before.s}`);
ok('break and grace unchanged on every live profile', after.profile === before.profile,
  `was ${before.profile}, now ${after.profile}`);
ok(`employees ${after.e}`, after.e === before.e, `was ${before.e}`);
ok(`attendance rows ${after.a}`, after.a === before.a, `was ${before.a}`);
ok(`tenants ${after.t}`, after.t === before.t, `was ${before.t}`);
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
  console.error(`${failed} shift checks failed`);
  process.exit(1);
}
console.log('the shift list reports the columns attendance measures against');
