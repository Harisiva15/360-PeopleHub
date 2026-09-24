/**
 * Employment history — the effective-dated record of somebody's terms.
 *
 * `employment_record` has existed since migration 0003, is read by the
 * lifecycle module in three places, and until now was written by nothing at
 * all. Zero rows, permanently. Three derived stages depended on it and none of
 * them could ever fire:
 *
 *   **Promotion** and **Transfer** — a move in the last quarter, read from
 *   `reason IN ('promotion', 'transfer', 'role_change')`. With no rows, nobody
 *   was ever shown as having moved.
 *
 *   **Joined** — the probation branch, which ends when a `probation_confirmed`
 *   record appears. With no rows it never ended; everybody aged out of it
 *   silently at 180 days and became "Active since their joining date" rather
 *   than "Active since they were confirmed".
 *
 * Meanwhile a promotion made through User Management changed `designation` on
 * the employee row, wrote an audit line, and left no trace an HR system would
 * recognise. The audit log is a record of *who did what to the application*.
 * It is not employment history, and reconstructing one from the other is how
 * you end up with a timeline that disagrees with the payslip.
 *
 * ## The shape
 *
 * One row per change, `valid_to` null meaning current — the schema's own
 * comment says an increment, a transfer and a promotion are all the same
 * shape, which is why they share a table. Each row carries the *whole* state
 * as of that date, not a diff: department, site, grade, designation, manager,
 * CTC. So "what were their terms in March" is one query with no replay.
 *
 * The snapshot is read from the `employee` row rather than passed in, which
 * means history cannot disagree with the record it describes. Callers say
 * *why* the change happened; they do not get to say what it was.
 *
 * ## Same-day changes amend rather than stack
 *
 * `setSalaryStructure` takes an effective date from the user and refuses a
 * second revision on the same day. This cannot: the date is implicit — today —
 * and refusing somebody's second correction of an afternoon would be absurd.
 * So a change on the same day the open record began amends that record in
 * place. The alternative is a zero-length slice, or a `valid_to` before its
 * own `valid_from`, which the table's CHECK forbids outright.
 */

import type { TenantClient } from '../../tenancy/context.ts';

/** Exactly the reasons the table's CHECK allows. */
export type EmploymentReason =
  | 'hire' | 'promotion' | 'increment' | 'transfer'
  | 'role_change' | 'probation_confirmed' | 'correction' | 'exit';

/** The employment terms this table tracks, as they are on the employee row. */
export interface EmploymentTerms {
  departmentId: string | null;
  siteId: string | null;
  designation: string | null;
  managerId: string | null;
}

/**
 * Which kind of change this was, or null when nothing tracked here moved.
 *
 * Pure, so the mapping can be argued with directly rather than through a
 * database. Two rules, and the reasoning matters more than the result:
 *
 *   A move between departments or sites is a **transfer**. That is what the
 *   word means, and it is the reading the lifecycle derivation already assumes.
 *
 *   A change of designation or reporting line is a **role_change**.
 *
 * Note what is deliberately absent. `promotion` is a reason the schema allows
 * and the lifecycle derivation gives its own stage, and nothing here ever
 * produces it — because deciding that a new title is a promotion rather than a
 * lateral move is a judgement about grade and pay that the product does not
 * currently capture. Guessing would put "Promotion" on somebody's record on
 * the strength of a renamed job title. When there is an operation that says
 * "this is a promotion", it passes its own reason.
 */
export function reasonForChange(
  before: EmploymentTerms,
  after: EmploymentTerms,
): 'transfer' | 'role_change' | null {
  const moved = before.departmentId !== after.departmentId
    || before.siteId !== after.siteId;
  if (moved) return 'transfer';

  const rerolled = (before.designation ?? '') !== (after.designation ?? '')
    || before.managerId !== after.managerId;
  return rerolled ? 'role_change' : null;
}

/** The employment fields, read from the employee row. */
export async function termsOf(
  db: TenantClient,
  employeeId: string,
): Promise<EmploymentTerms | null> {
  const { rows } = await db.query(
    `SELECT department_id, site_id, designation, manager_id
       FROM employee WHERE id = $1`, [employeeId]);
  if (!rows[0]) return null;
  const r = rows[0] as Record<string, string | null>;
  return {
    departmentId: r.department_id ?? null,
    siteId: r.site_id ?? null,
    designation: r.designation ?? null,
    managerId: r.manager_id ?? null,
  };
}

export interface RecordOpts {
  /** Defaults to today. `hire` passes the joining date. */
  on?: string | null;
  /** Who made the change. Null for a system action. */
  recordedBy?: string | null;
  note?: string | null;
}

/**
 * Open a new employment record, closing whatever was current.
 *
 * Takes the caller's open transaction — the history and the change it
 * describes commit together or not at all. A promotion that reached the
 * employee row and not the history would be worse than no history, because it
 * would look complete.
 */
export async function recordEmployment(
  db: TenantClient,
  employeeId: string,
  reason: EmploymentReason,
  opts: RecordOpts = {},
): Promise<void> {
  const on = opts.on ?? null;

  /*
   * Lock this employee's history for the transaction. Two changes arriving
   * together would otherwise both read "no open record" and both open one,
   * leaving two rows claiming to be current.
   */
  const { rows: open } = await db.query(
    `SELECT id, valid_from::text AS valid_from FROM employment_record
      WHERE employee_id = $1 AND valid_to IS NULL
      ORDER BY valid_from DESC
      FOR UPDATE`, [employeeId]);

  const { rows: dateRow } = await db.query(
    'SELECT COALESCE($1::date, CURRENT_DATE)::text AS d', [on]);
  const from = (dateRow[0] as { d: string }).d;

  const current = open[0] as { id: string; valid_from: string } | undefined;

  /*
   * A change on the day the open record began amends it rather than
   * superseding it — see the header. Anything else closes the day before the
   * new one opens, so the two meet without overlapping.
   */
  if (current && current.valid_from === from) {
    await db.query(
      `UPDATE employment_record er
          SET reason = $2, note = COALESCE($3, er.note), recorded_by = $4,
              recorded_at = now(),
              department_id = e.department_id, site_id = e.site_id,
              grade_id = e.grade_id, designation = e.designation,
              manager_id = e.manager_id, ctc = e.ctc, currency = e.currency
         FROM employee e
        WHERE er.id = $1 AND e.id = $5`,
      [current.id, reason, opts.note ?? null, opts.recordedBy ?? null, employeeId]);
    return;
  }

  if (current) {
    await db.query(
      'UPDATE employment_record SET valid_to = ($2::date - 1) WHERE id = $1',
      [current.id, from]);
  }

  /*
   * The snapshot is selected from `employee` rather than passed in, so the
   * history cannot describe terms the employee row does not have.
   */
  await db.query(
    `INSERT INTO employment_record
       (employee_id, valid_from, valid_to, reason, department_id, site_id,
        grade_id, designation, manager_id, ctc, currency, note, recorded_by)
     SELECT e.id, $2::date, NULL, $3, e.department_id, e.site_id,
            e.grade_id, e.designation, e.manager_id, e.ctc, e.currency, $4, $5
       FROM employee e WHERE e.id = $1`,
    [employeeId, from, reason, opts.note ?? null, opts.recordedBy ?? null]);
}

/**
 * Close the open record when somebody leaves.
 *
 * No new row: they have no terms after their last working day, and inventing
 * an open-ended `exit` record would make them look currently employed to
 * anything asking "what is their department" with `valid_to IS NULL`.
 */
export async function closeEmployment(
  db: TenantClient,
  employeeId: string,
  lastWorkingDay: string,
  recordedBy?: string | null,
): Promise<void> {
  await db.query(
    `UPDATE employment_record
        SET valid_to = GREATEST(valid_from, $2::date),
            reason = CASE WHEN valid_from = $2::date THEN 'exit' ELSE reason END,
            recorded_by = COALESCE($3, recorded_by)
      WHERE employee_id = $1 AND valid_to IS NULL`,
    [employeeId, lastWorkingDay, recordedBy ?? null]);
}
