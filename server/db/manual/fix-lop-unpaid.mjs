/**
 * Loss of Pay is not paid.
 *
 *   node db/manual/fix-lop-unpaid.mjs                      # dry run, rolls back
 *   node db/manual/fix-lop-unpaid.mjs --commit \
 *        --confirm-host=<host>                              # applies it
 *
 * ## What is wrong
 *
 * `leave_type` has `code='LOP'`, `name='Loss of Pay'`, `paid = true`. The name
 * and the flag contradict each other.
 *
 * ## Why it has done no harm
 *
 * Nothing reads the column. Three server queries touch `leave_type` and two of
 * them select `id` alone; the client's `LeaveType` type has no `paid` field at
 * all. Loss of pay reaches payroll by a different route entirely —
 * `lopDays()` counts attendance rows marked 'A' with no approved
 * regularisation, and feeds `payslip.loss_of_pay_days`. The leave type is
 * matched by its code wherever code matters, never by this flag.
 *
 * So this is hygiene, not a repair: no behaviour changes either way. It is
 * worth doing because the first person to implement "deduct for unpaid leave
 * types" will read `paid` and get the wrong answer for the one type where
 * being wrong costs somebody money.
 *
 * ## Why a script rather than the UI
 *
 * `Company Setup → Leave policies` can write exactly one field:
 * `setLeaveQuota(typeId, quota)`. There is no write path for `paid`,
 * `encashable`, `carry_forward_max` or `active` anywhere in the product, which
 * is recorded in docs/roadmap.md as its own piece of work.
 *
 * ## What it asserts before committing
 *
 * That it changed exactly one row, that the row is LOP, and that every other
 * leave type is byte-identical to how it found it — because a one-row fix that
 * quietly touches a second row is worse than the inconsistency it corrects.
 */

import { createRequire } from 'node:module';

const pg = createRequire(new URL('../../package.json', import.meta.url))('pg');

const COMMIT = process.argv.includes('--commit');
const claimed = process.argv.find((a) => a.startsWith('--confirm-host='))?.split('=')[1];

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('  set MIGRATE_DATABASE_URL'); process.exit(2); }
const host = (/@([^/]+)\//.exec(url)?.[1] ?? '?');
const isLocal = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);

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

const snapshot = async () => (await db.query(
  `SELECT code, name, paid, encashable, active, annual_quota::text, carry_forward_max::text
     FROM leave_type ORDER BY code`)).rows;

const NL = String.fromCharCode(10);
console.log('');
console.log(`  target : ${host}`);
console.log(`  mode   : ${COMMIT ? 'COMMIT' : 'dry run (rolls back)'}`);
console.log('');

const before = await snapshot();
console.log('  before:');
for (const r of before) {
  console.log(`    ${r.code.padEnd(8)} paid=${String(r.paid).padEnd(5)} quota=${r.annual_quota}`);
}

let problems = 0;
const check = (label, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : `   ${detail}`}`);
  if (!ok) problems += 1;
};

try {
  await db.query('BEGIN');

  const updated = (await db.query(
    `UPDATE leave_type SET paid = false
      WHERE code = 'LOP' AND paid IS TRUE
      RETURNING code, name, paid`)).rows;

  console.log(`${NL}  assertions:`);
  check('exactly one row changed', updated.length === 1, `${updated.length} changed`);
  check('and it is LOP', updated[0]?.code === 'LOP', JSON.stringify(updated[0] ?? null));
  check('now marked unpaid', updated[0]?.paid === false, JSON.stringify(updated[0] ?? null));

  const after = await snapshot();
  const others = (rows) => rows.filter((r) => r.code !== 'LOP').map((r) => JSON.stringify(r)).join('|');
  check('every other leave type is untouched', others(before) === others(after));
  check('the row count is unchanged', before.length === after.length,
    `${before.length} -> ${after.length}`);

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
  "SELECT code, name, paid FROM leave_type WHERE code = 'LOP'")).rows[0];
console.log(`  read back: ${JSON.stringify(final)}`);
console.log('');
await db.end();
