/**
 * The attendance screens' data access.
 *
 * Punching, regularising and approving all go through the service, so the day
 * a real backend arrives the geo-fence result and the regularisation credit
 * move with it rather than staying in the view.
 */

import { useMutation, useQuery } from '../../services/react';
import type { AttRecord, PunchAt } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';

export const usePayRuns = () => useQuery((s) => s.payroll.runs(), []);
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

export function useAttendance(empIds: string[], from?: string, to?: string) {
  const key = empIds.join(',');
  return useQuery((s) => s.attendance.list({ empIds, from, to }), [key, from, to]);
}

export function useMyAttendance(empId: string, from?: string, to?: string) {
  return useQuery((s) => s.attendance.list({ empIds: [empId], from, to }), [empId, from, to]);
}

export function useDay(empId: string, date: string) {
  return useQuery((s) => s.attendance.forDay(empId, date), [empId, date]);
}

/** Days carrying a regularisation request, for the caller's scope. */
export function useRegularisations(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.attendance.list({ empIds, regularisedOnly: true }), [key]);
}

export function useRegularisableDays(empId: string, since: string) {
  return useQuery((s) => s.attendance.regularisable(empId, since), [empId, since]);
}

/**
 * Days punched into and never out of — one person's, or the caller's line.
 *
 * Pass an id for somebody's own banner; omit it for a manager's queue. The
 * service scopes either way: an id narrows what the caller may already see and
 * cannot widen it, because the predicate is ANDed onto their own scope.
 *
 * Deliberately not filtered here. A hook that dropped, say, anything older
 * than a fortnight would be deciding policy quietly, and the oldest open day
 * is the one most worth seeing — it is the one payroll is about to read as a
 * present day that earned nothing.
 */
export function useUnclosedDays(empId?: string) {
  return useQuery((s) => s.attendance.unclosed(empId), [empId ?? '']);
}

/* ---------- writes ---------- */

export const useLocationNotice = () =>
  useQuery((s) => s.attendance.locationNotice(), []);
export const useAcknowledgeLocationNotice = () =>
  useMutation((s) => s.attendance.acknowledgeLocationNotice());

export const usePunchIn = () =>
  useMutation((s, empId: string, date: string, at: PunchAt) => s.attendance.punchIn(empId, date, at));

export const usePunchOut = () =>
  useMutation((s, empId: string, date: string, at: PunchAt) => s.attendance.punchOut(empId, date, at));

export const useRaiseRegularisation = () =>
  useMutation((s, empId: string, date: string, inT: string, outT: string, reason: string) =>
    s.attendance.raiseRegularisation(empId, date, inT, outT, reason));

export const useActOnRegularisation = () =>
  useMutation((s, r: AttRecord, decision: 'Approved' | 'Rejected') =>
    s.attendance.actOnRegularisation(r.empId, r.date, decision));

/**
 * The server's working-day verdicts for a month, for the attendance calendar.
 *
 * The grid used to fill its empty days from a holiday list compiled into the
 * bundle and a hard-coded Saturday/Sunday test. This is the same question asked
 * of the server, so a tenant's own holidays are what show.
 */
export const useMonthCalendar = (empId: string, mk: string) => {
  const [y, m] = mk.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  const from = `${mk}-01`;
  const to = `${mk}-${String(last).padStart(2, '0')}`;
  return useQuery((s) => s.calendar.workingDays(empId, from, to), [empId, from, to]);
};

/**
 * The tenant's working patterns, for the policy summary.
 *
 * Read-only. The attendance screen states the working week rather than deciding
 * it — which is why it has to ask rather than assert.
 */
export const useWorkSchedules = () => useQuery((s) => s.schedules.workSchedules(), []);

/*
 * Approved leave for the Expected / Leave / Actual view. Shared with the rota and
 * the dashboard calendar — see services/leave.ts for why the status filter is not
 * duplicated per module.
 */
export { useApprovedLeave } from '../../services/leave';
