/**
 * Membership, derived from who has already booked time.
 *
 *   node db/manual/backfill-project-members.mjs                  # dry run
 *   node db/manual/backfill-project-members.mjs --commit \
 *        --confirm-host=<host>                                   # applies it
 *
 * Step two of three. 0062 added `project_member`; step three will refuse a
 * timesheet entry without one. Between those two sits this: every
 * (person, project) pair that already appears in timesheet history becomes a
 * membership, so turning the rule on does not reject the next edit to work
 * that was logged long before the rule existed.
 *
 * ## Why history is the right source
 *
 * It is the only honest one. Nobody recorded who was *on* a project, so the
 * question can only be answered by what people did: booking time to a project
 * is the act of working on it. Anything else would be an invention — guessing
 * from departments, or putting everybody on everything.
 *
 * `joined_on` is the earliest `work_date` for the pair rather than today, for
 * the same reason. Today would be a lie that the project page would then
 * display.
 *
 * ## Somebody who has left
 *
 * Gets a membership with `left_on` set to the date they left, not a live one.
 * They worked on it — the history says so and step three may need the row —
 * but they are not on the team now, and a project page listing a leaver as
 * current staff is wrong in a way somebody will have to explain.
 *
 * ## What it asserts before committing
 *
 * That it created exactly as many rows as there are pairs it has not already
 * got, that every one points at a project and an employee in the same tenant,
 * that no pair ended up with two live rows, and that nothing already in the
 * table moved. Re-running is safe and reports nothing to do.
 */

import { createRequire } from 'node:module';

const pg = createRequire(new URL('../../package.json', import.meta.url))('pg');

const COMMIT = process.argv.includes('--commit');
const claimed = process.argv.find((a) => a.startsWith('--confirm-host='))?.split('=')[1];

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('  set MIGRATE_DATABASE_URL'); process.exit(2); }
const host = /@([^/]+)\//.exec(url)?.[1] ?? '?';
const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

if (COMMIT && !isLocal && claimed !== host) {
  console.error('');
  console.error(`  REFUSED: --confirm-host says ${claimed ?? '(nothing)'}, the target is ${host}.`);
  console.error('');
  process.exit(1);
}

const db = new pg.Client({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
await db.connect();

const NL = String.fromCharCode(10);
let problems = 0;
const check = (label, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `   ${detail}`}`);
  if (!ok) problems += 1;
};

console.log('');
console.log(`  target : ${host}`);
console.log(`  mode   : ${COMMIT ? 'COMMIT' : 'dry run (rolls back)'}`);
console.log('');

/*
 * Every pair in history, with the first day it was booked and whether the
 * person has since left. `project_member` is not consulted here — the
 * INSERT's own NOT EXISTS does that, so a re-run is idempotent rather than
 * dependent on this read.
 */
const PAIRS = `
  SELECT t.employee_id,
         te.project_id,
         min(te.work_date) AS first_booked,
         max(e.left_on)    AS left_on,
         max(e.code)       AS employee_code,
         max(p.code)       AS project_code
    FROM timesheet_entry te
    JOIN timesheet t  ON t.id = te.timesheet_id
    JOIN employee e   ON e.id = t.employee_id
    JOIN project p    ON p.id = te.project_id
   GROUP BY t.employee_id, te.project_id`;

const pairs = (await db.query(PAIRS)).rows;
const already = (await db.query('SELECT count(*)::int AS n FROM project_member')).rows[0].n;

console.log(`  ${pairs.length} pair(s) in timesheet history, `
  + `${already} row(s) already in project_member`);
for (const p of pairs) {
  console.log(`    ${String(p.employee_code).padEnd(8)}${String(p.project_code).padEnd(12)}`
    + `first booked ${new Date(p.first_booked).toISOString().slice(0, 10)}`
    + (p.left_on ? `   (left ${new Date(p.left_on).toISOString().slice(0, 10)})` : ''));
}

if (pairs.length === 0) {
  console.log(`${NL}  no timesheet history, so there is nothing to derive.${NL}`);
  await db.end();
  process.exit(0);
}

try {
  await db.query('BEGIN');

  const before = (await db.query(
    `SELECT id, project_id, employee_id, role, allocation_pct,
            joined_on::text AS joined_on, left_on::text AS left_on
       FROM project_member ORDER BY id`)).rows;

  /*
   * One statement. `left_on` carries the employee's own leaving date, which
   * is null for anybody still here — so an active person gets a live
   * membership and a leaver gets a historical one, from the same INSERT.
   */
  const made = (await db.query(
    `INSERT INTO project_member
       (tenant_id, project_id, employee_id, role, joined_on, left_on)
     SELECT t.tenant_id, te.project_id, t.employee_id, 'member',
            min(te.work_date), max(e.left_on)
       FROM timesheet_entry te
       JOIN timesheet t ON t.id = te.timesheet_id
       JOIN employee e  ON e.id = t.employee_id
      WHERE NOT EXISTS (
        SELECT 1 FROM project_member m
         WHERE m.project_id = te.project_id
           AND m.employee_id = t.employee_id)
      GROUP BY t.tenant_id, te.project_id, t.employee_id
     RETURNING id, project_id, employee_id, joined_on::text AS joined_on,
               left_on::text AS left_on`)).rows;

  const expected = pairs.length - already;

  console.log(`${NL}  assertions:`);
  check(`created one row per pair that had none (${made.length})`,
    made.length === expected, `${made.length}, expected ${expected}`);

  check('every new row joined on the first day its pair booked time',
    made.every((r) => {
      const pair = pairs.find((p) => p.project_id === r.project_id
        && p.employee_id === r.employee_id);
      return pair !== undefined
        && r.joined_on === new Date(pair.first_booked).toISOString().slice(0, 10);
    }));

  check('a leaver got a historical row and anybody still here got a live one',
    made.every((r) => {
      const pair = pairs.find((p) => p.project_id === r.project_id
        && p.employee_id === r.employee_id);
      return (pair?.left_on === null) === (r.left_on === null);
    }));

  const orphans = (await db.query(
    `SELECT count(*)::int AS n FROM project_member m
      WHERE NOT EXISTS (SELECT 1 FROM project p
                         WHERE p.id = m.project_id AND p.tenant_id = m.tenant_id)
         OR NOT EXISTS (SELECT 1 FROM employee e
                         WHERE e.id = m.employee_id AND e.tenant_id = m.tenant_id)`)).rows[0].n;
  check('no row points outside its own tenant', orphans === 0, `${orphans}`);

  const dupes = (await db.query(
    `SELECT count(*)::int AS n FROM (
       SELECT project_id, employee_id FROM project_member
        WHERE left_on IS NULL
        GROUP BY project_id, employee_id HAVING count(*) > 1) x`)).rows[0].n;
  check('no pair has two live memberships', dupes === 0, `${dupes}`);

  const after = (await db.query(
    `SELECT id, project_id, employee_id, role, allocation_pct,
            joined_on::text AS joined_on, left_on::text AS left_on
       FROM project_member WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [before.map((r) => r.id)])).rows;
  check('nothing already in the table was touched',
    JSON.stringify(before) === JSON.stringify(after));

  if (problems) throw new Error(`${problems} assertion(s) failed`);

  if (COMMIT) {
    await db.query('COMMIT');
    console.log(`${NL}  COMMITTED`);
  } else {
    await db.query('ROLLBACK');
    console.log(`${NL}  rolled back — nothing was written`);
  }
} catch (e) {
  try { await db.query('ROLLBACK'); } catch { /* nothing open */ }
  console.error(`${NL}  REFUSED / ROLLED BACK: ${e.message}${NL}`);
  await db.end();
  process.exit(1);
}

/* Read back on a fresh statement, outside the transaction that wrote it. */
const final = (await db.query(
  `SELECT e.code AS employee, p.code AS project, m.joined_on::text AS joined_on,
          m.left_on::text AS left_on
     FROM project_member m
     JOIN employee e ON e.id = m.employee_id
     JOIN project p  ON p.id = m.project_id
    ORDER BY p.code, e.code`)).rows;

console.log('');
console.log(`  read back (${final.length} row(s)):`);
for (const r of final) {
  console.log(`    ${r.employee.padEnd(8)}${r.project.padEnd(12)}${r.joined_on}`
    + (r.left_on ? `   left ${r.left_on}` : ''));
}
console.log('');
await db.end();
