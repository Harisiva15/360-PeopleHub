/**
 * The backfill that gives `employee_shift` its past, and the constraint that
 * keeps it answerable.
 *
 * ## Why this suite runs the migration's own SQL
 *
 * Migration 0063 creates `employee_shift` and fills it from three sources of
 * very different quality: what days were actually measured against, what the
 * audit says about a move, and what the employee is on now. The first is fact,
 * the third is a guess, and the whole value of the table is that a reader can
 * tell which is which.
 *
 * A backfill runs once, in production, against data nobody can rehearse on. So
 * this suite does not test a copy of that SQL — a copy is the thing that
 * drifts. It slices the text between the `BACKFILL BEGIN` / `BACKFILL END`
 * markers out of the migration file and runs *that*, against fixtures built to
 * be exactly the cases the production data will contain. If somebody edits the
 * migration, these assertions are about the edit.
 *
 * Re-running it is safe by construction: every insert is guarded on "this
 * employee has no history yet". That is also what lets this suite run the block
 * repeatedly against new fixtures, and assertion 9 is that property itself.
 *
 * ## What each fixture is
 *
 *   A  moved, and worked days on both rosters — the boundary is fact, and lands
 *      on the first day measured against the new one.
 *   B  moved, worked days only on the old roster, and the move was audited —
 *      the boundary is the audit's own effective date.
 *   C  the same, with no audit entry — the boundary is the earliest date the
 *      move could have happened, marked as the inference it is.
 *   D  never punched at all — one open row from joining.
 *   E  never moved — one open row from *joining*, not from their first punch,
 *      because the days between being hired and punching in were on those
 *      hours too and a correction for one of them has to resolve.
 *   F  punched before the shift stamp existed, so every row carries NULL —
 *      indistinguishable from D, and must not invent a run from nothing.
 *   G  an audit entry claiming a date inside the attended history, which the
 *      exclusion constraint would refuse. The migration has to survive it, not
 *      fail halfway through a production window.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { loadEnv } from './env.mjs';

import { assertLocalDatabase } from './local-only.mjs';

/* This suite writes. It refuses anything but a local database. */
assertLocalDatabase();

loadEnv();

if (!process.env.MIGRATE_DATABASE_URL) {
  console.log('\nSKIPPED: no database, and a backfill has nothing to fill.\n');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '..', 'db', 'migrations', '0063_employee_shift_history.sql');

const { withScratchTenant, sweepScratchTenants } = await import('./lib/scratch-tenant.mjs');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};
const refused = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

/**
 * The backfill, as it ships.
 *
 * No parameters anywhere in it, so the whole block goes through node-postgres's
 * simple query protocol in one call and Postgres runs the statements in order —
 * which is the order they have to run in, since each later insert reads what the
 * earlier ones wrote.
 */
const backfillSql = () => {
  const text = readFileSync(MIGRATION, 'utf8');
  const from = text.indexOf('-- >>> BACKFILL BEGIN');
  const to = text.indexOf('-- <<< BACKFILL END');
  if (from < 0 || to < 0 || to < from) {
    throw new Error(
      'the BACKFILL markers are missing from 0063 — this suite runs the SQL '
      + 'between them, so renaming or moving them makes it test nothing');
  }
  return text.slice(from, to);
};

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();
await sweepScratchTenants(admin);

/* Weekdays well in the past, so no assertion depends on the day it runs. */
const OCT = (d) => `2026-10-${String(d).padStart(2, '0')}`;

console.log('');
let fatal = null;
try {
  const applied = (await admin.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_name = 'employee_shift') AS there`)).rows[0].there;
  if (!applied) {
    console.log('\nSKIPPED: 0063 is not applied to this database yet.\n');
    await admin.end();
    process.exit(0);
  }

  await withScratchTenant(admin, async (ctx) => {
    const dept = (await admin.query(
      'SELECT id FROM department WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.dept])).rows[0].id;
    const site = (await admin.query(
      'SELECT id FROM site WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, ctx.site])).rows[0].id;
    const entity = (await admin.query(
      'SELECT id FROM legal_entity WHERE tenant_id = $1 LIMIT 1', [ctx.tenant])).rows[0].id;

    const inShift = (await admin.query(
      'SELECT id FROM shift WHERE tenant_id = $1 AND code = $2',
      [ctx.tenant, 'IN'])).rows[0].id;
    const nyShift = (await admin.query(
      `INSERT INTO shift (tenant_id, code, name, starts_at, ends_at, timezone, active,
                          grace_minutes, break_minutes, region)
       VALUES ($1, 'ZZNY', 'ZZNY', '09:00'::time, '18:00'::time, 'America/New_York',
               true, 10, 60, 'US')
       RETURNING id`, [ctx.tenant])).rows[0].id;

    const JOINED = '2026-10-01';
    let n = 0;
    /** An employee on `shiftId` now, hired on the 1st. */
    const hire = async (shiftId) => {
      n += 1;
      const code = `ZZH${n}`;
      return (await admin.query(
        `INSERT INTO employee
           (tenant_id, code, full_name, work_email, status, app_role, employment_type,
            department_id, site_id, legal_entity_id, shift_id, manager_id, joined_on,
            currency, ctc)
         VALUES ($1, $2, $2, $3::citext, 'active', 'employee', 'permanent',
                 $4, $5, $6, $7, $8, $9::date, 'INR', 900000)
         RETURNING id`,
        [ctx.tenant, code, `${code.toLowerCase()}-${Date.now().toString(36)}@360.technology`,
          dept, site, entity, shiftId, ctx.adminEmployeeId, JOINED])).rows[0].id;
    };

    /** A day measured against `shiftId` — or against nothing, for fixture F. */
    const attended = async (empId, date, shiftId) => admin.query(
      `INSERT INTO attendance (tenant_id, employee_id, work_date, status, shift_id,
                               source, worked_minutes, late, site_id)
       VALUES ($1, $2, $3::date, 'P', $4, 'web', 480, false, $5)`,
      [ctx.tenant, empId, date, shiftId, site]);

    /** What `assignShift` writes when somebody is moved. */
    const audited = async (empId, toCode, effective) => admin.query(
      `INSERT INTO audit_log (tenant_id, category, action, actor_employee_id,
                              actor_label, subject_table, detail)
       VALUES ($1, 'config', 'employee_shift_changed', $2, 'suite', 'shift',
               jsonb_build_object('employeeId', $3::text, 'from', 'IN',
                                  'to', $4::text, 'effective', $5::text))`,
      [ctx.tenant, ctx.adminEmployeeId, empId, toCode, effective]);

    const historyOf = async (empId) => (await admin.query(
      `SELECT sh.code, es.valid_from::text AS vfrom, es.valid_to::text AS vto, es.source
         FROM employee_shift es JOIN shift sh ON sh.id = es.shift_id
        WHERE es.employee_id = $1
        ORDER BY es.valid_from`, [empId])).rows;

    /* ---------------------------------------------------------------- *
     * The fixtures
     * ---------------------------------------------------------------- */

    /* A: days on both rosters. */
    const bothRosters = await hire(nyShift);
    for (const d of [5, 6, 7, 8, 9]) await attended(bothRosters, OCT(d), inShift);
    for (const d of [12, 13, 14, 15, 16]) await attended(bothRosters, OCT(d), nyShift);

    /* B: old roster only, move audited on the 20th. */
    const auditedMove = await hire(nyShift);
    for (const d of [5, 6, 7]) await attended(auditedMove, OCT(d), inShift);
    await audited(auditedMove, 'ZZNY', OCT(20));

    /* C: old roster only, nothing says when the move happened. */
    const silentMove = await hire(nyShift);
    for (const d of [5, 6, 7]) await attended(silentMove, OCT(d), inShift);

    /* D: never punched. */
    const neverPunched = await hire(inShift);

    /* E: never moved. */
    const neverMoved = await hire(inShift);
    for (const d of [5, 6, 7]) await attended(neverMoved, OCT(d), inShift);

    /* F: punched, but before the stamp existed. */
    const unstamped = await hire(inShift);
    for (const d of [5, 6, 7]) await attended(unstamped, OCT(d), null);

    /* G: an audit entry that would overlap the attended history. */
    const impossible = await hire(nyShift);
    for (const d of [5, 6, 7]) await attended(impossible, OCT(d), inShift);
    await audited(impossible, 'ZZNY', OCT(6));

    /* ---------------------------------------------------------------- *
     * Run it
     * ---------------------------------------------------------------- */

    console.log('a backfill that can tell what it knows from what it guessed\n');

    const ran = await refused(() => admin.query(backfillSql()));
    ok('1. the migration\'s own backfill runs against these fixtures',
      ran === null, `${ran?.code}: ${ran?.message}`);

    /* ---------------------------------------------------------------- *
     * Fact, where the days themselves say so
     * ---------------------------------------------------------------- */

    const a = await historyOf(bothRosters);
    ok('2. days on two rosters become two intervals',
      a.length === 2, JSON.stringify(a));
    ok('    the first running from joining, not from the first punch',
      a[0]?.code === 'IN' && a[0]?.vfrom === JOINED,
      `${a[0]?.code} from ${a[0]?.vfrom} — a correction for the 2nd has to resolve`);
    ok('    and ending the day before the new roster was first used',
      a[0]?.vto === OCT(11),
      `${a[0]?.vto} — the 11th, so the weekend belongs to the roster it followed`);
    ok('    the second starting on the first day measured against it',
      a[1]?.code === 'ZZNY' && a[1]?.vfrom === OCT(12),
      `${a[1]?.code} from ${a[1]?.vfrom}`);
    ok('    left open, because it is the roster they are still on',
      a[1]?.vto === null, String(a[1]?.vto));
    ok('    and both marked as read off the days themselves',
      a.every((r) => r.source === 'attendance'), JSON.stringify(a.map((r) => r.source)));

    /* ---------------------------------------------------------------- *
     * Fact, where only the audit says so
     * ---------------------------------------------------------------- */

    console.log('\nand where the days cannot say, the audit can\n');

    const b = await historyOf(auditedMove);
    ok('3. a move with no days on the new roster still closes the old one',
      b.length === 2 && b[0]?.code === 'IN' && b[0]?.vto === OCT(7),
      JSON.stringify(b));
    ok('    the new one starting on the date the move was audited for',
      b[1]?.code === 'ZZNY' && b[1]?.vfrom === OCT(20),
      `${b[1]?.vfrom} — the 20th is what the audit entry says`);
    ok('    marked as the audit\'s word rather than as measurement',
      b[1]?.source === 'audit', String(b[1]?.source));

    /* ---------------------------------------------------------------- *
     * Inference, and labelled as inference
     * ---------------------------------------------------------------- */

    console.log('\nand where nothing says, it guesses and admits it\n');

    const c = await historyOf(silentMove);
    ok('4. an unaudited move starts the day after the last day worked',
      c.length === 2 && c[1]?.vfrom === OCT(8),
      `${JSON.stringify(c)} — the 8th is the earliest it could have happened`);
    ok('    and says so, so a screen can show it as inferred',
      c[1]?.source === 'current', String(c[1]?.source));

    const d = await historyOf(neverPunched);
    ok('5. somebody who never punched gets one open row from joining',
      d.length === 1 && d[0]?.vfrom === JOINED && d[0]?.vto === null,
      JSON.stringify(d));
    ok('    marked inferred, because nothing says they were always on it',
      d[0]?.source === 'current', String(d[0]?.source));

    const f = await historyOf(unstamped);
    ok('6. days recorded before the shift stamp existed invent no run',
      f.length === 1 && f[0]?.source === 'current',
      `${JSON.stringify(f)} — a NULL stamp is not evidence of a roster`);

    /* ---------------------------------------------------------------- *
     * The case that must not take the window down with it
     * ---------------------------------------------------------------- */

    console.log('\nand an impossible audit date does not fail the migration\n');

    const g = await historyOf(impossible);
    ok('7. an audit date inside the attended history is not used',
      g.length === 2 && g[1]?.vfrom === OCT(8),
      `${JSON.stringify(g)} — the 6th would overlap and the insert would be refused`);
    ok('    the inferred boundary is used instead, and labelled as one',
      g[1]?.source === 'current', String(g[1]?.source));

    /* ---------------------------------------------------------------- *
     * The invariants the table exists for
     * ---------------------------------------------------------------- */

    console.log('\nthe table answers "which hours on this day" exactly once\n');

    const e = await historyOf(neverMoved);
    ok('8. somebody who never moved has one row, open, from joining',
      e.length === 1 && e[0]?.vfrom === JOINED && e[0]?.vto === null
        && e[0]?.source === 'attendance',
      JSON.stringify(e));

    const before = (await admin.query(
      'SELECT count(*)::int AS n FROM employee_shift WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n;
    const again = await refused(() => admin.query(backfillSql()));
    const after = (await admin.query(
      'SELECT count(*)::int AS n FROM employee_shift WHERE tenant_id = $1',
      [ctx.tenant])).rows[0].n;
    ok('9. running it twice is a no-op, so a retried window is safe',
      again === null && before === after,
      `${before} -> ${after}${again ? `, ${again.message}` : ''}`);

    const overlap = await refused(() => admin.query(
      `INSERT INTO employee_shift
         (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
       VALUES ($1, $2, $3, '2026-10-10'::date, NULL, 'assigned')`,
      [ctx.tenant, bothRosters, inShift]));
    ok('10. a second shift covering the same day is refused by the database',
      overlap !== null && overlap.code === '23P01',
      `${overlap?.code}: ${overlap?.message}`);

    const backwards = await refused(() => admin.query(
      `INSERT INTO employee_shift
         (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
       VALUES ($1, $2, $3, '2026-11-10'::date, '2026-11-01'::date, 'assigned')`,
      [ctx.tenant, neverPunched, inShift]));
    ok('    and so is an interval that ends before it starts',
      backwards !== null && /employee_shift_dates_ordered/.test(backwards.message),
      String(backwards?.message));

    const madeUp = await refused(() => admin.query(
      `INSERT INTO employee_shift
         (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
       VALUES ($1, $2, $3, '2026-11-10'::date, NULL, 'vibes')`,
      [ctx.tenant, neverPunched, inShift]));
    ok('    and a source nobody defined, so the labels stay meaningful',
      madeUp !== null && /employee_shift_source_known/.test(madeUp.message),
      String(madeUp?.message));

    const gap = (await admin.query(
      `SELECT e.code,
              (SELECT count(*)::int FROM employee_shift es
                WHERE es.employee_id = e.id AND es.valid_to IS NULL) AS open
         FROM employee e
        WHERE e.tenant_id = $1 AND e.code LIKE 'ZZH%'
        ORDER BY e.code`, [ctx.tenant])).rows;
    ok('11. every backfilled employee has exactly one current row',
      gap.length > 0 && gap.every((r) => r.open === 1), JSON.stringify(gap));

    /*
     * The one thing an effective-dated table has to do that a single column
     * cannot: give a different answer for a day either side of the move. This
     * asserts it as the resolver will ask it, so the next phase has a shape to
     * build against.
     */
    const resolve = async (empId, date) => (await admin.query(
      `SELECT sh.code FROM employee_shift es JOIN shift sh ON sh.id = es.shift_id
        WHERE es.employee_id = $1
          AND daterange(es.valid_from, es.valid_to, '[]') @> $2::date`,
      [empId, date])).rows[0]?.code ?? null;

    ok('12. the day before the move resolves to the roster it was worked on',
      await resolve(bothRosters, OCT(9)) === 'IN', String(await resolve(bothRosters, OCT(9))));
    ok('    the day of the move resolves to the new one',
      await resolve(bothRosters, OCT(12)) === 'ZZNY',
      String(await resolve(bothRosters, OCT(12))));
    ok('    a day nobody worked, between the two, still resolves',
      await resolve(bothRosters, OCT(10)) === 'IN',
      `${await resolve(bothRosters, OCT(10))} — this is the case VHM007 needed`);
    ok('    and the day they were hired resolves, before any punch',
      await resolve(bothRosters, JOINED) === 'IN',
      String(await resolve(bothRosters, JOINED)));
  });
} catch (e) {
  fatal = e;
  failed += 1;
  console.log(`\n  FAIL  the suite did not finish: ${e?.message ?? e}`);
  if (e?.stack) console.log(e.stack.split('\n').slice(1, 5).join('\n'));
} finally {
  await admin.end();
}

console.log(`\n${failed
  ? `${failed} FAILED`
  : 'which hours applied on a day is a question with one answer, and it says '
    + 'which answers it measured and which it guessed'}\n`);
process.exit(failed ? 1 : 0);
