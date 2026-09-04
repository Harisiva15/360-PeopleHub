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

/* ---------- writes ---------- */

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
