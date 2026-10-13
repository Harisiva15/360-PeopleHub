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
 * ## Three answers since Phase 2h-I, not two
 *
 * Approved leave is the third, and it is deliberately *beside* the other two
 * rather than folded into either. A Saturday covered by a leave request is still
 * the week off the schedule says it is; a holiday is still a holiday; and an
 * approved leave day with no punch is still "no attendance" — not `L`, which is a
 * status something writes, and not `A`, which is a later phase's decision.
 *
 * Only **approved** leave reaches here. Pending is not leave yet, rejected never
 * was, cancelled no longer is — and `leaveOn` filters on that rather than trusting
 * the caller to have asked for the right status.
 *
 * ## Composed from three bulk reads, never per day
 *
 * The expected side comes from one range call — `calendar.workingDays` for a
 * person or `shifts.roster` for a team — the actual side from one
 * `attendance.list({ empIds, from, to })`, and leave from one
 * `leave.list({ empIds, from, to, status: 'Approved' })`. Joining them is this
 * module's whole job, so a month for forty people stays three requests.
 */

import type { AttRecord, DayVerdict, LeaveRequest } from '../../services';

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
  /**
   * The approved leave request covering this date, or null.
   *
   * A third fact, not a substitute for either of the other two. It being set says
   * nothing about whether a record exists, and nothing about what the schedule
   * expected — both of those are answered beside it.
   */
  leave: LeaveRequest | null;
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

/**
 * The approved leave request covering a date, or null.
 *
 * **Approved only.** Filtered here rather than relying on the caller having asked
 * for the right status, because the one way this feature goes wrong is a pending
 * request being shown as leave somebody is entitled to take.
 *
 * Bounds are inclusive on both ends, matching `leave_request`'s own
 * `starts_on`/`ends_on` and the schema's `CHECK (ends_on >= starts_on)`. Dates
 * compare as `YYYY-MM-DD` strings, which sort correctly and carry no timezone.
 */
export function leaveOn(requests: LeaveRequest[], date: string): LeaveRequest | null {
  return requests.find(
    (r) => r.status === 'Approved' && r.from <= date && date <= r.to) ?? null;
}

/**
 * The leave side in words, or null when none covers the date.
 *
 * Names the type and, for a half day, which half — using the representation the
 * schema already has (`first_half`/`second_half`, surfaced as "First Half"), not a
 * fraction invented here. The `days` figure carries the fraction and is the leave
 * service's to compute.
 */
export function leaveLabel(day: AttendanceDay): string | null {
  if (!day.leave) return null;
  const half = day.leave.half ? ` — ${day.leave.half}` : '';
  return `Approved — ${day.leave.type}${half}`;
}

/**
 * Whether a record exists on a day approved leave also covers.
 *
 * Phase 2h-I surfaces this and deliberately does not resolve it: somebody was
 * marked present on a day they were approved to be away, and which of the two is
 * wrong is not something a read should decide. The label a screen shows for it is
 * neutral by design.
 */
export function recordedDuringLeave(day: AttendanceDay): boolean {
  return day.leave !== null && day.actual !== null && day.actual.status !== 'L';
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
  /* Optional so every existing caller keeps working without a leave read. */
  leaveRequests: LeaveRequest[] = [],
): AttendanceDay[] {
  const byExpected = new Map(verdicts.map((v) => [v.date, v]));
  const byActual = new Map(records.map((r) => [r.date, r]));
  return dates.map((date) => ({
    date,
    expected: byExpected.get(date) ?? null,
    actual: byActual.get(date) ?? null,
    leave: leaveOn(leaveRequests, date),
  }));
}

/**
 * Approved leave grouped by employee, for a team view.
 *
 * One pass over a single `leave.list` result, so the rota joins its rows without
 * asking per person. Unlike attendance this is not keyed by date — a request
 * spans dates, and expanding it into a row per day here would be inventing the
 * date arithmetic `leaveOn` already does against the stored bounds.
 */
export function leaveByEmployee(requests: LeaveRequest[]): Map<string, LeaveRequest[]> {
  const out = new Map<string, LeaveRequest[]>();
  for (const r of requests) {
    const forOne = out.get(r.empId) ?? [];
    forOne.push(r);
    out.set(r.empId, forOne);
  }
  return out;
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
  return day.expected?.reason === 'WORKING' && day.actual === null
    /*
     * Approved leave explains the gap, so it is not one. Before Phase 2h-I this
     * counted leave days as days awaiting a record, which is how a figure meant
     * to prompt a look turns into a figure somebody mistakes for absences.
     */
    && day.leave === null;
}
