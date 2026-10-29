-- ---------------------------------------------------------------------------
-- 0063 — which hours a person was on, and when
--
-- `employee.shift_id` is one NOT NULL column holding one current value. It
-- answers "what hours are they on now" and destroys "what hours was Tuesday
-- judged by" — and Tuesday is exactly what an attendance correction, a payslip
-- and a late mark have to agree about.
--
-- The gap is not theoretical. VHM007 moved from the India roster to the New
-- York one on 2026-10-29 having worked New York hours since roughly the 23rd.
-- Three of those days have no attendance row at all, so a correction for them
-- had to pick a shift, and the only thing it could read was `employee.shift_id`
-- — today's answer applied to last week's day. It happened to be right, because
-- the move was made before the corrections were raised. Reversing that order
-- would have stored his typed New York times as India times, ten and a half
-- hours out, with nothing in the data to say so.
--
-- ## What this is not
--
--   * **Not a replacement for `employee.shift_id`.** That column stays NOT NULL
--     and stays the current value. Every existing read keeps working unchanged,
--     which is what makes this migration additive and what makes rolling it
--     back a `DROP TABLE`.
--   * **Not about which days.** That is `work_schedule` (0054). A schedule says
--     which days are expected; a shift says which hours, in which zone, with how
--     much grace and break. 0054 kept those separate and so does this.
--   * **Not read by anything yet.** Every service still resolves hours the way
--     it does today. Teaching `createDayFor`, `raiseRegularisation` and
--     `actOnRegularisation` to read this table is the next deploy, deliberately
--     not inside a migration — the same split 0054 made for the same reason.
--
-- ## The shape, and why it matches 0054 exactly
--
-- `employment_record` has used `valid_from`/`valid_to` since 0003,
-- `salary_structure` has had an exclusion constraint for it since 0048, and
-- `employee_schedule` (0054) combined the two. This is a fourth instance of the
-- same pattern rather than a third approach: inclusive `daterange`, so
-- 30 Jun -> 1 Jul does not overlap and no day in the middle of somebody's
-- employment belongs to nobody.
--
-- ## Safety
--
-- One `CREATE TABLE` and one backfill into it. Nothing is altered, nothing is
-- dropped, no existing row is rewritten, and no column is added to `employee`,
-- `attendance` or `shift`. Re-running is a no-op: the backfill is guarded on
-- "this employee has no rows yet", so a boundary an administrator has since
-- corrected is never overwritten.
-- ---------------------------------------------------------------------------

CREATE TABLE employee_shift (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id uuid NOT NULL,
  -- NOT NULL, unlike `work_schedule_day.shift_id`, which is an override and so
  -- has a meaningful null. An assignment with no shift says nothing at all.
  shift_id    uuid NOT NULL,
  -- Dates, not timestamps, for 0054's reason: hours change on a day, and a
  -- timestamp invites a question about which hour they changed at that nobody
  -- wants to answer. A punch mid-change is already handled, and handled better,
  -- by `attendance.shift_id` being stamped at punch time.
  valid_from  date NOT NULL,
  /*
   * The last day this assignment applies, or NULL for "still current".
   *
   * **Inclusive**, matching `employee_schedule` and `leave_request` and
   * deliberately not `salary_structure`'s half-open range: an HR user means
   * "last day" when they type an end date, and an uncovered day is a bug
   * waiting to be found by a payslip.
   */
  valid_to    date,
  /*
   * Where this row's dates came from, so a later reader can tell fact from
   * inference — because the backfill below is partly each.
   *
   *   `attendance`  The dates are what days were actually *measured* against,
   *                 read back off `attendance.shift_id`. Fact.
   *   `audit`       The boundary is an `employee_shift_changed` entry's own
   *                 `effective` date. Fact, but only for moves made after that
   *                 entry started being written (2026-10-28).
   *   `current`     No evidence for a boundary existed, so the row starts at
   *                 the earliest date it could defensibly start. **Inference** —
   *                 the move may have been earlier than this says.
   *   `assigned`    Written by the service when somebody moves a shift from
   *                 here on. Fact, and the only value new rows will carry.
   *
   * A screen listing somebody's shift history should show the inferred rows as
   * inferred. One that lets an administrator correct a boundary writes
   * `assigned` over it, which is how the backfill's guesses get retired.
   */
  source      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Lets a tenant-scoped table reference this one through the tenant, so a
  -- foreign key can never point across tenants. check-schema's second invariant.
  UNIQUE (tenant_id, id),
  CONSTRAINT employee_shift_dates_ordered
    CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_shift_source_known
    CHECK (source IN ('attendance', 'audit', 'current', 'assigned')),
  FOREIGN KEY (tenant_id, employee_id)
    REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  /*
   * No ON DELETE, so the default RESTRICT applies: a shift somebody was
   * actually on cannot be deleted out from under their history. A shift that
   * stops being used is withdrawn — `shift.active` is what that is for — and
   * the rows naming it stay readable. Deliberately not CASCADE: an employee's
   * shift history is not meaningless without the profile it names, it is the
   * only record that the profile ever applied.
   */
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shift (tenant_id, id),
  /*
   * One shift covers any given day for a given employee.
   *
   * `btree_gist` (0048) lets an exclusion constraint mix plain equality on the
   * tenant and the employee with range overlap on the dates. A NULL `valid_to`
   * is an unbounded range, so two open assignments overlap by definition and
   * are refused without a separate index for that case.
   *
   * A constraint rather than a service rule, because the question it answers —
   * which hours applied on a given day — has to have exactly one answer for
   * every reader, including one written later.
   */
  CONSTRAINT employee_shift_no_overlap
    EXCLUDE USING gist (
      tenant_id   WITH =,
      employee_id WITH =,
      daterange(valid_from, valid_to, '[]') WITH &&
    )
);

-- Resolving "which shift applied on this date" reads the employee's rows newest
-- first, the same shape `employee_schedule` and `employment_record` are indexed
-- for.
CREATE INDEX employee_shift_tenant_employee_from_idx
  ON employee_shift (tenant_id, employee_id, valid_from DESC);

SELECT apply_tenant_isolation('employee_shift');

COMMENT ON TABLE employee_shift IS
  'Which shift applied to an employee over which dates. Effective-dated so a '
  'move does not reinterpret what last week meant. employee.shift_id remains '
  'the current value and the authority for a punch happening now. '
  'See migration 0063.';
COMMENT ON COLUMN employee_shift.valid_to IS
  'Inclusive last day, or NULL for current. 30 Jun -> 1 Jul does not overlap.';
COMMENT ON COLUMN employee_shift.source IS
  'Where the dates came from: attendance and audit are fact, current is the '
  'backfill''s inference, assigned is a deliberate act. See migration 0063.';
COMMENT ON CONSTRAINT employee_shift_no_overlap ON employee_shift IS
  'One shift per employee per day. Inclusive ranges.';

-- ---------------------------------------------------------------------------
-- The backfill
--
-- Three sources, used strictly in order of how much they actually know.
--
--   1. **`attendance.shift_id`** — stamped at punch time since 0015 and, as the
--      Phase 2g investigation found, never read back until now. It is the only
--      per-day record of what a day was measured against, and it is fact. Runs
--      of consecutive attended days on the same shift collapse into one
--      interval, and the boundary between two runs is the first day of the
--      later one: a weekend between a Friday on India hours and a Monday on New
--      York hours belongs to India, which costs nothing because nobody punched
--      on it.
--
--   2. **`audit_log`, action `employee_shift_changed`** — carries the move's own
--      `effective` date in `detail`. Used only where attendance cannot answer:
--      an employee whose current shift differs from the last one they were
--      measured against moved at some point after their last attended day, and
--      this is the one record that says when.
--
--   3. **`employee.shift_id`** — the current value. True from the last known
--      boundary to open-ended, and the only thing available for an employee who
--      has never punched at all.
--
-- ## The order this is run in matters, once
--
-- Source 1 reads attendance rows. An approved correction *creates* one, stamped
-- with a shift. So a correction raised for a day with no row is evidence this
-- backfill will read — and corrections raised **after** this migration will be
-- resolved against whatever this migration inferred. For VHM007 specifically:
-- raise and approve 23, 26 and 27 October *first* and his New York boundary
-- lands on the 23rd as fact; run this first instead and it lands on the 29th as
-- inference, and those three days read as India hours.
--
-- ## Guarded
--
-- `WHERE NOT EXISTS (... FROM employee_shift ...)` per employee rather than
-- ON CONFLICT, because an exclusion constraint is not a unique index and cannot
-- carry a conflict target. A re-run therefore changes nothing, and an
-- administrator who has corrected a boundary keeps the correction.
-- ---------------------------------------------------------------------------

-- >>> BACKFILL BEGIN — shift-history.test.mjs runs everything between these
-- two markers against its own fixtures, so the suite exercises the SQL that
-- ships rather than a copy of it. Moving or renaming them breaks that suite,
-- which is the point. Everything between them must be re-runnable: the guards
-- are what make it so.

WITH fresh AS (
  -- Only employees with no history yet, so a re-run is a no-op.
  SELECT e.tenant_id, e.id, e.joined_on, e.shift_id AS current_shift_id
    FROM employee e
   WHERE NOT EXISTS (
     SELECT 1 FROM employee_shift es
      WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id
   )
), days AS (
  -- What each attended day was measured against. Rows predating the stamp carry
  -- NULL and are skipped rather than guessed at.
  SELECT a.tenant_id, a.employee_id, a.work_date, a.shift_id
    FROM attendance a
    JOIN fresh f ON f.tenant_id = a.tenant_id AND f.id = a.employee_id
   WHERE a.shift_id IS NOT NULL
), marked AS (
  SELECT d.*,
         CASE WHEN d.shift_id IS DISTINCT FROM
                   LAG(d.shift_id) OVER (PARTITION BY d.tenant_id, d.employee_id
                                             ORDER BY d.work_date)
              THEN 1 ELSE 0 END AS boundary
    FROM days d
), grouped AS (
  SELECT m.*,
         SUM(m.boundary) OVER (PARTITION BY m.tenant_id, m.employee_id
                                   ORDER BY m.work_date) AS run
    FROM marked m
), runs AS (
  SELECT tenant_id, employee_id, shift_id, run,
         MIN(work_date) AS first_day, MAX(work_date) AS last_day
    FROM grouped
   GROUP BY tenant_id, employee_id, shift_id, run
), bounded AS (
  SELECT r.*,
         ROW_NUMBER() OVER (PARTITION BY r.tenant_id, r.employee_id
                                ORDER BY r.first_day) AS seq,
         LEAD(r.first_day) OVER (PARTITION BY r.tenant_id, r.employee_id
                                     ORDER BY r.first_day) AS next_first
    FROM runs r
)
INSERT INTO employee_shift
  (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
SELECT b.tenant_id, b.employee_id, b.shift_id,
       /*
        * The earliest run starts at joining, not at its first punch: the days
        * between being hired and first punching in were on those hours too, and
        * leaving them uncovered would make a correction for one of them
        * unanswerable. LEAST guards the one case that would otherwise break the
        * CHECK — an attendance row dated before `joined_on`, which no constraint
        * forbids.
        */
       CASE WHEN b.seq = 1 THEN LEAST(f.joined_on, b.first_day)
            ELSE b.first_day END,
       /*
        * Up to the day before the next run. The last run is open-ended only
        * when it is the shift they are still on; where it is not, it ends on
        * its last attended day and the tail insert below picks the move up.
        */
       CASE WHEN b.next_first IS NOT NULL THEN b.next_first - 1
            WHEN b.shift_id = f.current_shift_id THEN NULL
            ELSE b.last_day END,
       'attendance'
  FROM bounded b
  JOIN fresh f ON f.tenant_id = b.tenant_id AND f.id = b.employee_id;

/*
 * The tail: employees whose current shift is not the one their last attended
 * day was measured against, so the move happened after that day and attendance
 * cannot say when.
 *
 * `effective` off the audit entry where there is one — fact, for any move made
 * since that entry started being written. Otherwise the day after their last
 * attended day: the earliest date the move could have happened, marked
 * `current` so it reads as the inference it is rather than as a record.
 */
INSERT INTO employee_shift
  (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
SELECT e.tenant_id, e.id, e.shift_id, boundary.starts, NULL, boundary.source
  FROM employee e
  JOIN LATERAL (
    SELECT MAX(es.valid_to) AS last_day
      FROM employee_shift es
     WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id
  ) last ON true
  LEFT JOIN LATERAL (
    SELECT (al.detail->>'effective')::date AS effective
      FROM audit_log al
      JOIN shift sh ON sh.tenant_id = al.tenant_id
                   AND sh.code = al.detail->>'to'
     WHERE al.tenant_id = e.tenant_id
       AND al.action = 'employee_shift_changed'
       AND al.detail->>'employeeId' = e.id::text
       AND sh.id = e.shift_id
       AND (al.detail->>'effective') ~ '^\d{4}-\d{2}-\d{2}$'
     ORDER BY al.occurred_at DESC
     LIMIT 1
  ) aud ON true
  /*
   * The boundary, picked once and used for both the date and the label.
   *
   * The audit's date is taken only when it is actually later than the history
   * it would follow. It need not be: an administrator may move somebody back
   * onto hours they had already been measured against, and an entry dated
   * inside the closed history would overlap it — which the exclusion
   * constraint refuses, taking the whole migration down with it.
   *
   * This was first written as a `WHERE` excluding that case, which is worse
   * than the bug it was guarding: it dropped the employee from the insert
   * entirely, leaving somebody with a closed history and no current row, so
   * every date after their last attended day resolved to nothing. Assertion 11
   * of `shift-history.test.mjs` is that property, and it is what found this.
   *
   * `aud.effective > last.last_day` is NULL when there is no entry, so the
   * CASE falls to the inferred boundary without a separate null test. That
   * boundary cannot overlap by construction: it is the day after the last day
   * the closed history covers.
   */
  CROSS JOIN LATERAL (
    SELECT CASE WHEN aud.effective > last.last_day
                THEN aud.effective ELSE last.last_day + 1 END AS starts,
           CASE WHEN aud.effective > last.last_day
                THEN 'audit' ELSE 'current' END AS source
  ) boundary
 -- Only where a closed history exists and nothing covers today.
 WHERE last.last_day IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM employee_shift es
      WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id
        AND es.valid_to IS NULL
   );

/*
 * Employees who have never punched at all — a new joiner, or anybody hired
 * before the stamp existed whose rows all carry NULL. One open row from their
 * joining date on the hours they are on now. Inference, and marked as such:
 * nothing here says they have been on these hours the whole time, only that
 * nothing says otherwise.
 */
INSERT INTO employee_shift
  (tenant_id, employee_id, shift_id, valid_from, valid_to, source)
SELECT e.tenant_id, e.id, e.shift_id, e.joined_on, NULL, 'current'
  FROM employee e
 WHERE NOT EXISTS (
   SELECT 1 FROM employee_shift es
    WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id
 );

/*
 * ## Why a leaver's last row is left open rather than closed on `left_on`
 *
 * Because this table answers one question — which hours applied on a date —
 * and is not the authority on whether somebody was employed on it. That
 * authority is `employee.joined_on` / `left_on`, which `createDayFor` already
 * checks and refuses on; duplicating it here would put a second answer beside
 * the first. `employee.shift_id` is still set for a leaver, so an open row
 * mirrors it rather than asserting anything about their employment. 0054 made
 * the opposite call for `employee_schedule`, had to skip leavers with no
 * `left_on` entirely, and documented the gap that left for its next phase.
 * This avoids that gap by not reaching for the date at all.
 */

-- <<< BACKFILL END
