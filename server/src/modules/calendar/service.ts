/**
 * Whether a date is a working day, answered once.
 *
 * Three places used to answer this independently, all in the browser, all from a
 * hard-coded rule:
 *
 *   - `src/modules/leave/index.tsx` counted leave days with
 *     `if (isWeekend(d) || HOLIDAY_MAP[ymd(d)]) excluded++`, and the server stored
 *     whatever number arrived. A request for two dates could claim ten days.
 *   - `src/modules/dashboard/shared.tsx` filled every attendance-less day in the
 *     calendar with `'H'` from the same client constant or `'O'` from the same
 *     weekend rule, so a configured build showed week-offs and holidays no server
 *     data supported.
 *   - `rosterFor` hard-codes Saturday and Sunday in SQL-adjacent JavaScript.
 *
 * `HOLIDAY_MAP` is a list of 2026 Tamil Nadu holidays compiled into the bundle.
 * The `holiday` table has existed since 0002 and is the only thing a tenant can
 * actually edit. The two disagreed, and the bundle won.
 *
 * ## What this module is
 *
 * The one authority on "is this date a working day for this person". Phase 2h-B
 * built it from a hard-coded Monday-to-Friday rule because there was no schedule
 * table. Phase 2h-C added one and 2h-D made it writable; this is the phase where
 * this function reads it, and the callers did not change — which was the point of
 * putting the rule here in the first place.
 *
 * It materialises nothing. No attendance row is created, no status is written.
 *
 * ## The order a date is decided in
 *
 *   1. **Was the person employed?** Outside `[joined_on, left_on]` nothing else is
 *      asked, because there is no day to be expected on. See `NOT_EMPLOYED`.
 *   2. **Which schedule applied *on that date*?** The effective-dated assignment,
 *      per date — never the current one. See `classifyRange`.
 *   3. **Does that schedule work this weekday?** `work_schedule_day.working` for
 *      the date's ISO weekday. With no assignment, the Monday-to-Friday fallback.
 *   4. **Is it a mandatory holiday?** Only then, and only on a day the schedule
 *      works, does the day become `HOLIDAY`.
 *
 * Steps 3 and 4 are in that order deliberately: a holiday falling on a day the
 * person does not work stays `WEEKLY_OFF`, which is what 2h-B reported and what
 * is truthful — the holiday gave them nothing. The count is identical either way,
 * so the order only ever decides the reason.
 *
 * ## Why the weekday is decided in SQL
 *
 * `EXTRACT(ISODOW FROM d)` over `generate_series` treats the values as the
 * calendar dates they are. The JavaScript alternative — `new Date(ymd).getDay()` —
 * reads a date string as UTC midnight and then reports the weekday in the
 * *runtime's* zone, so `2026-10-04` is Sunday in Chennai and Saturday in Los
 * Angeles. A leave count must not depend on where the server happens to run, and
 * `rosterFor`'s `getUTCDay()` already shows the other half of that mistake.
 */

import { withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class CalendarError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

/**
 * Why a date is, or is not, a day this person is expected to work.
 *
 * `NOT_EMPLOYED` is the one value Phase 2h-E added, and it was added because
 * nothing existing could say it truthfully. Before this phase a date before
 * somebody joined — or after they left — came back `WORKING`, since the
 * Monday-to-Friday rule had no notion of a person's employment at all.
 *
 * Adding a reason is a contract change, so the consumers were checked rather than
 * assumed. Both branch on `workingDay` or on `reason === 'HOLIDAY'`:
 * `dashboard/shared.tsx` renders any non-working, non-holiday day as the week-off
 * glyph, and `leave/index.tsx` counts `workingDay`. So an older reader shows a
 * not-employed day as "off" — the correct count, a slightly coarse label — rather
 * than breaking or inventing a working day.
 */
export type DayReason = 'WORKING' | 'WEEKLY_OFF' | 'HOLIDAY' | 'NOT_EMPLOYED';

export interface DayVerdict {
  /** The calendar date, `YYYY-MM-DD`. */
  date: string;
  workingDay: boolean;
  reason: DayReason;
  /** The holiday's name when `reason` is HOLIDAY, otherwise null. */
  holiday: string | null;
  /**
   * The work schedule that decided this date, or null.
   *
   * Null is the honest signal that **no assignment covered this date** and the
   * Monday-to-Friday fallback answered it. That is what makes the fallback
   * visible rather than silent: a caller can tell a scheduled Monday from an
   * assumed one without a second request. See `classifyRange` for why there is a
   * fallback at all.
   */
  schedule: string | null;
  /**
   * The shift code applying on this date, where the person is expected to work.
   *
   * The schedule day's own shift when it names one, otherwise the employee's own
   * `shift_id` — which is NOT NULL and has been the authority since 0015. Null on
   * a day nobody is expected to work. Nothing here copies an hour out of the
   * shift, and nothing writes `employee.shift_id`.
   */
  shift: string | null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A range the database will accept, and short enough that a typo cannot ask for a decade. */
const MAX_SPAN_DAYS = 400;

/** Days since the epoch, parsed from the string's own parts so no zone is involved. */
function epochDay(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

function checkRange(from: string, to: string): void {
  if (!YMD.test(from) || !YMD.test(to)) {
    throw new CalendarError('a date is written as YYYY-MM-DD', 'invalid');
  }
  if (to < from) {
    throw new CalendarError('the end date cannot be before the start date', 'invalid');
  }
  /*
   * Checked before the query rather than after it. The classification now joins
   * schedules, weekdays and holidays per date, so asking for a century is work
   * worth refusing before the database starts rather than after.
   */
  if (epochDay(to) - epochDay(from) + 1 > MAX_SPAN_DAYS) {
    throw new CalendarError(`a range is at most ${MAX_SPAN_DAYS} days`, 'invalid');
  }
}

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Classify every date in a range for one employee.
 *
 * Takes a database handle rather than a caller so the leave service can run it
 * inside its own transaction — the count and the insert that depends on it must
 * not be able to disagree because a holiday was added, or a schedule reassigned,
 * between them.
 *
 * ## One query, not one per day — and not one per person
 *
 * Everything is resolved in a single statement: the span from `generate_series`,
 * the assignment covering each date, that schedule's row for the date's weekday,
 * the shift either the day or the employee names, and the holidays. A year's range
 * is one round trip, and the only work left for JavaScript is choosing which
 * reason the row means.
 *
 * This function is a one-element call into `classifyMany`, which the roster uses
 * for a whole team in the same single statement.
 *
 * ## The schedule is resolved per date, never "the current one"
 *
 * The join is `daterange(valid_from, valid_to, '[]') @> span.day`, so each date
 * finds the assignment that applied *on that date*. Somebody who moved from a
 * five-day pattern to a six-day one in July has May answered by the five-day one
 * and August by the six-day one, and a leave range crossing the change counts each
 * side under its own pattern. Reading the current assignment for a whole range —
 * the obvious shortcut — silently rewrites history every time anybody's schedule
 * changes, which is the bug this join exists to make impossible.
 *
 * `'[]'` because `employee_schedule.valid_to` is **inclusive**: 0054 chose that
 * deliberately, differing from 0048's half-open ranges, and it is why 30 June and
 * 1 July are adjacent rather than overlapping. The exclusion constraint means at
 * most one assignment can match, so the join cannot fan out.
 *
 * ## Why there is a fallback, and why it is not silent
 *
 * An employee with no assignment covering a date is answered by the
 * Monday-to-Friday rule, and the verdict reports `schedule: null` to say so.
 *
 * This is not a policy invention. It is the rule the product applies today — 2h-B
 * wrote it down, and 0054's own backfill encodes the same five days as
 * `DEFAULT_MF` — so keeping it is what makes an unassigned employee behave exactly
 * as they did before this phase. The case is not hypothetical either: `0054`
 * backfills from `joined_on`, and **neither** employee-creation path
 * (`people/provision.ts`, `users/service.ts`) writes an `employee_schedule` row,
 * so every person hired after that migration ran has no assignment at all.
 * Refusing to answer for them would have broken leave for every new joiner.
 *
 * What is deliberately *not* done is reaching for the `DEFAULT_MF` row: that would
 * make a tenant's editable schedule silently govern people nobody put on it, and
 * editing it would move them. The fallback is the constant rule, and
 * `schedule: null` is how a caller tells the difference.
 *
 * ## Holidays
 *
 * **A holiday closes the office only when it is not optional.** `HOLIDAY_MAP` is
 * built with `if (!h.opt)`, the holiday calendar screen labels the two kinds
 * "Fixed" and "Optional", the policy line reads "Optional holidays: any 2 per
 * calendar year", and `holiday_one_per_day` is a unique index `WHERE optional =
 * false`. All four say the same thing: an optional holiday is a normal working day
 * that an employee may choose to take as leave. Treating one as non-working would
 * hand everybody two free days and silently reduce their leave deduction.
 *
 * **A holiday with a site applies only to that site.** `holiday.site_id` is
 * documented in 0002 as "Null means the whole tenant; otherwise a location-
 * specific holiday", and `holiday_one_per_day` keys on `COALESCE(site_id, …)`
 * precisely so one date can carry a tenant-wide row and a per-site row. An
 * employee with no site — `employee.site_id` is nullable — sees tenant-wide
 * holidays only, which is the only reading that does not invent a fallback.
 */
export async function classifyRange(
  db: Db,
  employeeId: string,
  from: string,
  to: string,
): Promise<DayVerdict[]> {
  const byPerson = await classifyMany(db, [employeeId], from, to);
  return byPerson[employeeId] ?? [];
}

/**
 * The same classification for several people at once, keyed by employee id.
 *
 * **One statement, whatever the headcount.** This is what the roster reads: forty
 * people across a fortnight is one round trip, not forty. `classifyRange` is a
 * one-element call into this, so there is a single implementation of what a date
 * means and no second copy to drift — which was the whole reason 2h-B put the rule
 * in one place.
 *
 * An employee the caller may not see simply has no key in the result. Row level
 * security decides that, not this function: a crafted id finds no `employee` row,
 * so it produces no dates.
 */
export async function classifyMany(
  db: Db,
  employeeIds: string[],
  from: string,
  to: string,
): Promise<Record<string, DayVerdict[]>> {
  checkRange(from, to);
  if (!employeeIds.length) return {};

  const { rows } = await db.query(
    `WITH span AS (
       SELECT d::date AS day
         FROM generate_series($2::date, $3::date, interval '1 day') AS d
     ),
     /*
      * Each person's site, lifecycle dates and own shift. Read inside the same
      * statement so a transfer mid-transaction cannot classify half a range
      * against each site, and so the whole verdict comes from one snapshot.
      */
     who AS (
       SELECT e.id, e.site_id, e.joined_on, e.left_on, s.code AS shift_code
         FROM employee e
         LEFT JOIN shift s ON s.id = e.shift_id
        WHERE e.id = ANY($1::uuid[])
     ),
     /*
      * One holiday per person per date. A date may legitimately carry both a
      * tenant-wide row and a site row -- holiday_one_per_day keys on
      * COALESCE(site_id, ...) precisely so it can -- and joining both would
      * duplicate that employee's day. The site-specific one wins, being the more
      * specific statement about where this person works.
      */
     shut AS (
       SELECT DISTINCT ON (who.id, h.observed_on)
              who.id AS employee_id, h.observed_on, h.name
         FROM holiday h
         JOIN who ON (h.site_id IS NULL OR h.site_id = who.site_id)
        WHERE h.optional = false
        ORDER BY who.id, h.observed_on, (h.site_id IS NOT NULL) DESC
     )
     SELECT who.id          AS employee_id,
            to_char(span.day, 'YYYY-MM-DD') AS date,
            EXTRACT(ISODOW FROM span.day)::int AS isodow,
            shut.name       AS holiday,
            ws.code         AS schedule_code,
            wsd.working     AS day_working,
            dshift.code     AS day_shift_code,
            who.shift_code  AS own_shift_code,
            (span.day < who.joined_on) AS before_joining,
            (who.left_on IS NOT NULL AND span.day > who.left_on) AS after_leaving
       FROM span
       CROSS JOIN who
       LEFT JOIN shut ON shut.observed_on = span.day AND shut.employee_id = who.id
       /*
        * The assignment covering this date -- not the employee's current one.
        * employee_schedule_no_overlap guarantees at most one matches.
        */
       LEFT JOIN employee_schedule es
              ON es.employee_id = who.id
             AND daterange(es.valid_from, es.valid_to, '[]') @> span.day
       LEFT JOIN work_schedule ws ON ws.id = es.work_schedule_id
       LEFT JOIN work_schedule_day wsd
              ON wsd.work_schedule_id = es.work_schedule_id
             AND wsd.day_of_week = EXTRACT(ISODOW FROM span.day)::int
       LEFT JOIN shift dshift ON dshift.id = wsd.shift_id
      ORDER BY who.id, span.day`,
    [employeeIds, from, to]);

  const out: Record<string, DayVerdict[]> = {};
  for (const r of rows) {
    const who = r.employee_id as string;
    (out[who] ??= []).push(verdictOf(r));
  }
  return out;
}

/** One row of the classification query, read into the verdict it means. */
function verdictOf(r: Record<string, unknown>): DayVerdict {
  const date = r.date as string;
  const holiday = (r.holiday as string | null) ?? null;

  /*
   * Not employed on this date, so nothing else is asked. No schedule is
   * reported either: there was no expectation to describe, and naming one
   * would suggest the person was due in.
   */
  if (r.before_joining === true || r.after_leaving === true) {
    return {
      date, workingDay: false, reason: 'NOT_EMPLOYED',
      holiday: null, schedule: null, shift: null,
    };
  }

  const schedule = (r.schedule_code as string | null) ?? null;
  /*
   * The schedule's answer for this weekday, or the Monday-to-Friday fallback
   * when no assignment covered the date. `ISODOW` is 1 for Monday through 7 for
   * Sunday, so 6 and 7 are the week off — which is what `isWeekend` has always
   * said and what `DEFAULT_MF` records.
   *
   * `day_working` is read as an explicit boolean rather than coerced: a
   * schedule missing a weekday row would make it null, and `Boolean(null)` is
   * false, which would quietly report an unconfigured day as off. 2h-D writes
   * all seven days on every create, so a null here means something is wrong
   * with the data and the fallback is the honest answer.
   */
  const scheduled = typeof r.day_working === 'boolean'
    ? r.day_working
    : Number(r.isodow) <= 5;

  if (!scheduled) {
    return { date, workingDay: false, reason: 'WEEKLY_OFF', holiday, schedule, shift: null };
  }

  /* A day the person works, so the shift they would work it on is known. */
  const shift = (r.day_shift_code as string | null)
    ?? (r.own_shift_code as string | null) ?? null;

  if (holiday) {
    return { date, workingDay: false, reason: 'HOLIDAY', holiday, schedule, shift };
  }
  return { date, workingDay: true, reason: 'WORKING', holiday: null, schedule, shift };
}

/** How many working days a range holds for one employee. The number leave stores. */
export async function countWorkingDays(
  db: Db,
  employeeId: string,
  from: string,
  to: string,
): Promise<number> {
  const days = await classifyRange(db, employeeId, from, to);
  return days.filter((d) => d.workingDay).length;
}

/**
 * The same classification, for a screen to read.
 *
 * Open to every role for themselves and, through the scope below, to a manager for
 * their line and an admin for anybody — the same shape attendance and leave reads
 * already use. A calendar is not privileged information: an employee should be able
 * to see which days they are expected to work.
 */
export async function workingDaysFor(
  caller: Caller,
  employeeId: string,
  from: string,
  to: string,
): Promise<DayVerdict[]> {
  checkRange(from, to);

  return withTenantReadOnly(caller, async (db) => {
    /*
     * The employee has to exist here first.
     *
     * Row level security already stops another tenant's rows being read, so
     * nothing leaks either way — but without this an admin asking about an id
     * from another tenant got a plausible-looking calendar back: no employee
     * means no site, which means no holidays, which means a clean Monday-to-Friday
     * answer about somebody who is not theirs. A not-found is the truthful reply.
     *
     * Schedules do not change that. Every table the classification reads —
     * `employee_schedule`, `work_schedule`, `work_schedule_day`, `shift`,
     * `holiday` — carries forced row level security from
     * `apply_tenant_isolation`, so a crafted employee id finds nothing rather
     * than somebody else's pattern.
     */
    const { rows: known } = await db.query(
      'SELECT 1 FROM employee WHERE id = $1', [employeeId]);
    if (!known[0]) throw new CalendarError('no such employee', 'not_found');

    if (caller.role !== 'admin') {
      if (!caller.employeeId) {
        throw new CalendarError('this login has no employee record', 'forbidden');
      }
      if (caller.employeeId !== employeeId) {
        /* A manager may read their own line, however deep. Employees, only themselves. */
        if (caller.role === 'employee') {
          throw new CalendarError('you can only read your own calendar', 'forbidden');
        }
        const { rows } = await db.query(
          `WITH RECURSIVE line AS (
             SELECT id FROM employee WHERE manager_id = $1
             UNION ALL
             SELECT c.id FROM employee c JOIN line ON c.manager_id = line.id
           ) SELECT 1 FROM line WHERE id = $2`, [caller.employeeId, employeeId]);
        if (!rows[0]) throw new CalendarError('that person is not in your team', 'forbidden');
      }
    }
    return classifyRange(db, employeeId, from, to);
  });
}
