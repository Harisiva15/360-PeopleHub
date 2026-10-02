-- ---------------------------------------------------------------------------
-- 0054 — which days a person is expected to work
--
-- Nothing in fifty-three migrations has ever recorded this. Monday to Friday was
-- hard-coded: `isWeekend` in the browser, `dow === 0 || dow === 6` in `rosterFor`,
-- and since 2h-B `EXTRACT(ISODOW …) >= 6` in the calendar resolver. A company
-- working Monday to Saturday, or Sunday to Thursday in the Gulf, cannot say so.
--
-- `roster_entry` once held one row per person per day with an `is_week_off` flag,
-- and 0015 dropped it. That decision stands and this does not reverse it: a
-- per-day grid is ~2.5m rows a year at 5,000 employees and describes a rotating
-- support desk, not this business. What follows is a *pattern* — seven rows per
-- schedule, expanded on read — which is the same information at a thousandth of
-- the volume.
--
-- ## Three tables, and why not fewer
--
--   `work_schedule`      which days, as a named pattern a tenant can edit
--   `work_schedule_day`  one row per weekday: expected or not, optionally on a
--                        different shift from the person's usual one
--   `employee_schedule`  which pattern applied to whom, and when
--
-- The split that matters is the last one. Putting `work_schedule_id` on
-- `employee` would answer "what is their pattern now" and destroy "what was it in
-- March" — and March is exactly what a payslip, a leave count and an attendance
-- record have to agree about. `employment_record` has used `valid_from`/`valid_to`
-- for this since 0003 and `salary_structure` has an exclusion constraint for it
-- since 0048; this follows both rather than inventing a third approach.
--
-- ## What this migration deliberately does not do
--
-- It adds no column to `shift`, `employee`, `attendance` or anything else. A
-- schedule says *which days*; a shift says *which hours, in which timezone, with
-- how much grace and break*. Those stayed separate through 0015 and 2g for good
-- reasons and they stay separate here — `work_schedule_day.shift_id` points at
-- the existing table rather than copying a single hour out of it.
--
-- **No service reads these tables yet.** The 2h-B resolver still answers Monday to
-- Friday from its own rule, unchanged. Teaching it to read a schedule is the next
-- phase, and doing it here would mean shipping a behaviour change inside a
-- migration.
--
-- ## Safety
--
-- Three `CREATE TABLE`s and one backfill of rows that did not exist. Nothing is
-- altered, nothing is dropped, no existing row is rewritten. Re-running is a
-- no-op: every insert is guarded.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The pattern
-- ---------------------------------------------------------------------------

CREATE TABLE work_schedule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- The identity people type and quote. Upper-cased by the service, and stable:
  -- renaming is a `name` change, never a `code` change.
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  -- Withdrawn from use rather than deleted. An employee_schedule row that names
  -- an inactive pattern stays meaningful — the pattern still describes the days
  -- they worked — so this only stops it being chosen for a *new* assignment.
  -- Same convention as site, business_unit and shift.
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Lets a tenant-scoped table reference this one through the tenant, so a
  -- foreign key can never point across tenants. check-schema's second invariant.
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  -- The same shape shift codes take, for the same reason: a code is quoted in a
  -- URL and read aloud.
  CONSTRAINT work_schedule_code_shape
    CHECK (code = upper(btrim(code)) AND code ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$'),
  CONSTRAINT work_schedule_name_present CHECK (length(btrim(name)) > 0)
);

-- `UNIQUE (tenant_id, code)` already leads with tenant_id, satisfying the index
-- invariant. This one is for the list screen's own ordering: every read will be
-- "this tenant's schedules, actives first, by name".
CREATE INDEX work_schedule_tenant_active_name_idx
  ON work_schedule (tenant_id, active DESC, name);

SELECT apply_tenant_isolation('work_schedule');

COMMENT ON TABLE work_schedule IS
  'Which days a person is expected to work, as a named pattern. Not hours — '
  'those are on shift. See migration 0054.';

-- ---------------------------------------------------------------------------
-- The days in it
-- ---------------------------------------------------------------------------

CREATE TABLE work_schedule_day (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  work_schedule_id uuid NOT NULL,
  -- ISO 8601: 1 = Monday through 7 = Sunday. The same numbering Postgres's
  -- EXTRACT(ISODOW ...) returns, which is what the calendar resolver already
  -- compares against — so nothing has to translate between two conventions.
  -- JavaScript's getDay() is 0 = Sunday and is deliberately not used here.
  day_of_week      smallint NOT NULL,
  -- Whether the day is expected at all. False is the week off.
  working          boolean NOT NULL,
  /*
   * The shift this weekday runs on, where it differs from the person's usual one.
   *
   * NULL means "the employee's own `shift_id`", which is NOT NULL and has been
   * the authority since 0015 — so a schedule that only says which days are
   * working needs seven NULLs here and changes nothing about anybody's hours.
   *
   * Set, it is an override for that weekday: a pattern can run Monday to
   * Wednesday on one shift and Thursday to Friday on another without copying a
   * single hour, timezone, break or grace value out of `shift`. There is
   * deliberately no second place to define hours.
   */
  shift_id         uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One answer per weekday per schedule. Two rows for Monday is a question with
  -- no defined answer, so the database refuses it rather than a service choosing.
  UNIQUE (tenant_id, work_schedule_id, day_of_week),
  CONSTRAINT work_schedule_day_isodow CHECK (day_of_week BETWEEN 1 AND 7),
  -- A day nobody works has no shift. Allowing one would store an hours override
  -- for a day with no hours, which reads as a configuration somebody meant.
  CONSTRAINT work_schedule_day_off_has_no_shift
    CHECK (working OR shift_id IS NULL),
  FOREIGN KEY (tenant_id, work_schedule_id)
    REFERENCES work_schedule (tenant_id, id) ON DELETE CASCADE,
  -- No ON DELETE: a shift has no delete path (2g withdraws rather than deletes),
  -- and the default RESTRICT is the honest guard if one is ever added.
  FOREIGN KEY (tenant_id, shift_id) REFERENCES shift (tenant_id, id)
);

-- Reading a schedule means reading its seven days in order.
CREATE INDEX work_schedule_day_tenant_schedule_idx
  ON work_schedule_day (tenant_id, work_schedule_id, day_of_week);

SELECT apply_tenant_isolation('work_schedule_day');

COMMENT ON TABLE work_schedule_day IS
  'One row per weekday of a work_schedule: expected or not, and optionally a '
  'different shift that day. ISO weekdays, 1 = Monday. See migration 0054.';
COMMENT ON COLUMN work_schedule_day.shift_id IS
  'An override for this weekday only. NULL means the employee''s own shift_id, '
  'which is the authority and is NOT NULL.';

-- ---------------------------------------------------------------------------
-- Who it applied to, and when
-- ---------------------------------------------------------------------------

CREATE TABLE employee_schedule (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  employee_id      uuid NOT NULL,
  work_schedule_id uuid NOT NULL,
  -- Dates, not timestamps: a schedule changes on a day, and a timestamp would
  -- invite a question about which hour it changed at that nobody wants to answer.
  valid_from       date NOT NULL,
  /*
   * The last day this assignment applies, or NULL for "still current".
   *
   * **Inclusive.** `valid_to = 2026-06-30` means the 30th is covered and the next
   * assignment starts on 1 July. This differs from `salary_structure_no_overlap`
   * in 0048, which uses a half-open `daterange(valid_from, valid_to)` and so
   * treats `valid_to` as the first day *not* covered — leaving the 30th belonging
   * to neither row if you read it the natural way. `leave_request` already
   * reasons inclusively (`daterange(starts_on, ends_on, '[]')`), an HR user means
   * "last day" when they type an end date, and an uncovered day in the middle of
   * somebody's employment is a bug waiting to be found by a payslip. So the
   * exclusion constraint below is built on an inclusive range.
   */
  valid_to         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CONSTRAINT employee_schedule_dates_ordered
    CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (tenant_id, employee_id)
    REFERENCES employee (tenant_id, id) ON DELETE CASCADE,
  /*
   * No ON DELETE on the schedule, so the default RESTRICT applies: a pattern
   * somebody was actually on cannot be deleted out from under their history. A
   * schedule that stops being used is deactivated — that is what `active` is for
   * — and the rows naming it stay readable. Deliberately not CASCADE: this
   * repository uses CASCADE 212 times for rows that are meaningless without
   * their parent, and an employee's schedule history is not one of them.
   */
  FOREIGN KEY (tenant_id, work_schedule_id) REFERENCES work_schedule (tenant_id, id),
  /*
   * One schedule covers any given day for a given employee.
   *
   * `btree_gist` (0048) lets an exclusion constraint mix plain equality on the
   * tenant and the employee with range overlap on the dates. Inclusive bounds, so
   * 30 June -> 1 July does not overlap and 15 June -> open does. A NULL
   * `valid_to` is an unbounded range, so two open assignments overlap by
   * definition and are refused without a separate index for that case.
   *
   * This is a constraint rather than a service rule because the question it
   * answers — which pattern applied on a given day — has to have exactly one
   * answer for every reader, including one written later.
   */
  CONSTRAINT employee_schedule_no_overlap
    EXCLUDE USING gist (
      tenant_id   WITH =,
      employee_id WITH =,
      daterange(valid_from, valid_to, '[]') WITH &&
    )
);

-- Resolving "which schedule applied on this date" reads the employee's rows
-- newest first, which is the same shape employment_record is indexed for.
CREATE INDEX employee_schedule_tenant_employee_from_idx
  ON employee_schedule (tenant_id, employee_id, valid_from DESC);

SELECT apply_tenant_isolation('employee_schedule');

COMMENT ON TABLE employee_schedule IS
  'Which work_schedule applied to an employee over which dates. Effective-dated '
  'so a change does not rewrite what last month meant. See migration 0054.';
COMMENT ON CONSTRAINT employee_schedule_no_overlap ON employee_schedule IS
  'One schedule per employee per day. Inclusive ranges, so 30 Jun -> 1 Jul does '
  'not overlap.';

-- ---------------------------------------------------------------------------
-- The default pattern, as data
--
-- Monday to Friday, which is what the product has always applied — `isWeekend`
-- in the browser, `rosterFor` in SQL-adjacent JavaScript, and the 2h-B resolver's
-- `ISODOW >= 6`. Writing it down changes no behaviour today: no service reads
-- these tables yet, and when one does it will find the rule it was already using.
--
-- Named so it is obviously a system default rather than somebody's considered
-- configuration. A tenant that works six days edits it or adds their own.
--
-- Scoped to tenants that actually have employees — a schedule for an empty
-- tenant is furniture — and every insert is guarded, so a re-run changes nothing
-- and a tenant that has already edited theirs keeps the edit.
-- ---------------------------------------------------------------------------

INSERT INTO work_schedule (tenant_id, code, name, description, active)
SELECT DISTINCT e.tenant_id, 'DEFAULT_MF', 'Default Monday-Friday Schedule',
       'Created by migration 0054 as the pattern the product already applied. '
       || 'Edit it, or add your own, if this company works other days.', true
  FROM employee e
 ON CONFLICT (tenant_id, code) DO NOTHING;

/*
 * Seven days per default schedule. `shift_id` is NULL throughout: the employee's
 * own shift is the authority and this pattern overrides nobody's hours.
 */
INSERT INTO work_schedule_day (tenant_id, work_schedule_id, day_of_week, working, shift_id)
SELECT ws.tenant_id, ws.id, d.dow, d.dow <= 5, NULL
  FROM work_schedule ws
 CROSS JOIN (VALUES (1), (2), (3), (4), (5), (6), (7)) AS d(dow)
 WHERE ws.code = 'DEFAULT_MF'
 ON CONFLICT (tenant_id, work_schedule_id, day_of_week) DO NOTHING;

/*
 * Assign it from each person's joining date.
 *
 * `employee.joined_on` is `date NOT NULL`, so every row has a defensible start
 * and nothing is guessed. `valid_to` is NULL: this is the pattern that still
 * applies, and the next phase supersedes it by closing this row rather than
 * editing it.
 *
 * **An exited employee is assigned only when the schema can say when they left.**
 *
 * An assignment needs a start and an end. `joined_on` is `date NOT NULL`, so the
 * start is never in doubt. The end is the whole question, and the schema answers
 * it for some leavers and not others:
 *
 *   1. `employee.left_on` is a `date`, and `employee_check` enforces
 *      `left_on IS NULL OR left_on >= joined_on`. Where it is set it is a
 *      trustworthy end: it is a real date and it cannot precede the start, so
 *      `[joined_on, left_on]` is a valid range by construction.
 *   2. **It is nullable and nothing populates it.** No CHECK ties
 *      `status = 'exited'` to `left_on IS NOT NULL`, there is no foreign key from
 *      `employee` to `exit_record`, and no trigger on `employee`. A row can be
 *      marked exited with `left_on` still null.
 *   3. `exit_record.last_working_day` is `date NOT NULL` and would be the other
 *      candidate, but it is not reachable safely: nothing guarantees a record
 *      exists for an exited employee, and `exit_record.status` includes
 *      'withdrawn' — a withdrawn exit still carries a last working day for
 *      somebody who stayed.
 *
 * So the rule is to use what is asserted and nothing else. An exited employee with
 * `left_on` set gets `valid_to = left_on`. One without gets no row at all, because
 * the alternatives were to write `valid_to = NULL` — claiming a leaver is still on
 * this pattern — or to derive a date from a record that may be absent or
 * withdrawn. Both would put a guess where a later phase reads fact.
 *
 * **What this leaves for Phase 2h-D, explicitly.** A resolver asking which
 * schedule applied to an exited employee with no `left_on` will find no row. That
 * remaining gap must be handled deliberately — by backfilling from
 * `exit_record.last_working_day` where a non-withdrawn record exists, by falling
 * back to the tenant default, or by refusing — and not by assuming every employee
 * has an assignment. `work-schedule.test.mjs` asserts the three facts above, so if
 * the link is ever enforced the assertion fails and points back at this decision.
 *
 * `WHERE NOT EXISTS` rather than ON CONFLICT: the exclusion constraint is not a
 * unique index, so it cannot carry a conflict target.
 */
INSERT INTO employee_schedule (tenant_id, employee_id, work_schedule_id, valid_from, valid_to)
SELECT e.tenant_id, e.id, ws.id, e.joined_on,
       /*
        * Open-ended for anybody still here. Closed on `left_on` for a leaver who
        * has one — `employee_check` guarantees it is not before `joined_on`, so
        * the range is valid without this statement checking anything itself.
        */
       CASE WHEN e.status = 'exited' THEN e.left_on ELSE NULL END
  FROM employee e
  JOIN work_schedule ws
    ON ws.tenant_id = e.tenant_id AND ws.code = 'DEFAULT_MF'
 -- A leaver with no recorded leaving date is skipped rather than guessed at.
 WHERE (e.status <> 'exited' OR e.left_on IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM employee_schedule es
      WHERE es.tenant_id = e.tenant_id AND es.employee_id = e.id
   );
