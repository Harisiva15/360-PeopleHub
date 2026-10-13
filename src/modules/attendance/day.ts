/**
 * What was expected of somebody on a date, and what actually happened.
 *
 * Two questions, kept apart. The product has answered the first since Phase 2h-B
 * — the calendar resolver, from the work schedule, the holiday table and the
 * employee's own lifecycle — and the second since migration 0004, from the
 * `attendance` row. Until now the screens collapsed them into one glyph, which
 * made a week off look like an attendance record of status `O` and left no way to
 * say "we expected them in and there is no record".
 *
 * ## The rule this module exists to hold
 *
 * **A scheduled working day with no attendance row is not an absence.** It is a
 * working day with no attendance row. `A` is a real persisted status that
 * something has to write deliberately; the absence of a row is the absence of
 * information, and the two must not be rendered as the same fact. Whether a
 * missing record *becomes* an absence is a policy question with a payroll
 * consequence, and it belongs to a later phase than this one.
 *
 * ## Read-only, and not persisted
 *
 * `AttendanceDay` is a display shape composed from two reads. Nothing here writes,
 * and nothing here is stored: there is no `expected_status` column and this phase
 * deliberately did not add one, because the expectation is derived and would go
 * stale the moment somebody's schedule changed.
 *
 * ## Composed from two bulk reads, never per day
 *
 * The expected side comes from one range call — `calendar.workingDays` for a
 * person or `shifts.roster` for a team — and the actual side from one
 * `attendance.list({ empIds, from, to })`. Joining them is this module's whole
 * job, so a month for forty people stays two requests.
 */

import type { AttRecord, DayVerdict } from '../../services';

/** One date, answered twice. */
export interface AttendanceDay {
  date: string;
  /**
   * What the schedule expected. Null when the server gave no verdict for this
   * date — rendered as nothing rather than guessed at, which is the same rule the
   * rota follows for a cell it was not told about.
   */
  expected: DayVerdict | null;
  /**
   * What attendance holds. **Null means there is no record**, which is a display
   * state and never a status: see the module comment.
   */
  actual: AttRecord | null;
}

/**
 * The attendance statuses this product actually has, as migration 0004 defines
 * them: `status char(1) CHECK (status IN ('P','W','A','L','H','O'))`.
 *
 * Nothing is added to this list. "No attendance" is deliberately absent from it
 * because it is not a status — it is what the map cannot answer.
 */
export const ACTUAL_LABEL: Record<string, string> = {
  P: 'Present', W: 'WFH', L: 'Leave', A: 'Absent', H: 'Holiday', O: 'Week off',
};

/** The words for the actual side, including the honest answer when there is none. */
export const NO_ATTENDANCE = 'No attendance';

/**
 * The actual side in words.
 *
 * Returns `NO_ATTENDANCE` for a day with no row — never `Absent`, and never the
 * expected state dressed up as an actual one.
 */
export function actualLabel(day: AttendanceDay): string {
  if (!day.actual) return NO_ATTENDANCE;
  return ACTUAL_LABEL[day.actual.status] ?? day.actual.status;
}

/** The expected side in words, or null where the server gave no answer. */
export function expectedLabel(day: AttendanceDay): string | null {
  if (!day.expected) return null;
  if (day.expected.reason === 'HOLIDAY') {
    return day.expected.holiday ? `Holiday — ${day.expected.holiday}` : 'Holiday';
  }
  return day.expected.reason === 'WORKING' ? 'Working'
    : day.expected.reason === 'WEEKLY_OFF' ? 'Week off'
      : 'Not employed';
}

/**
 * Join a span of dates against one person's verdicts and records.
 *
 * `dates` drives the result, so a date the server answered neither way still
 * appears — as `expected: null, actual: null` — rather than vanishing. A calendar
 * that silently drops a day is worse than one that admits it knows nothing.
 */
export function composeDays(
  dates: string[],
  verdicts: DayVerdict[],
  records: AttRecord[],
): AttendanceDay[] {
  const byExpected = new Map(verdicts.map((v) => [v.date, v]));
  const byActual = new Map(records.map((r) => [r.date, r]));
  return dates.map((date) => ({
    date,
    expected: byExpected.get(date) ?? null,
    actual: byActual.get(date) ?? null,
  }));
}

/**
 * Attendance records grouped by employee then date, for a team view.
 *
 * One pass over a single `attendance.list` result, so the rota joins its forty
 * rows without asking per person.
 */
export function recordsByEmployee(records: AttRecord[]): Map<string, Map<string, AttRecord>> {
  const out = new Map<string, Map<string, AttRecord>>();
  for (const r of records) {
    const forOne = out.get(r.empId) ?? new Map<string, AttRecord>();
    forOne.set(r.date, r);
    out.set(r.empId, forOne);
  }
  return out;
}

/**
 * Whether this day is one somebody was expected in for and has no record of.
 *
 * Offered so a screen can draw attention to it **without naming it an absence**.
 * It is the question "is there something here worth a human looking at", which is
 * a different question from "was this person absent" — and the answer to the
 * second one is not this module's to give.
 */
export function awaitingRecord(day: AttendanceDay): boolean {
  return day.expected?.reason === 'WORKING' && day.actual === null;
}
