/**
 * The unified approval queue's data access.
 *
 * Every action here is the *same* service call the owning module makes, which
 * is the point: this screen used to carry its own copy of the approve/reject
 * logic for leave, timesheets, regularisations and claims, and the copies had
 * already drifted — the leave one debited the balance, the queue's did too,
 * but neither guarded against a double approval.
 */

import { useMutation, useQuery } from '../../services/react';
import type { AttRecord } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- the pending queues ---------- */

export function usePendingLeave(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.leave.list({ empIds, status: 'Pending' }), [key]);
}

export function usePendingTimesheets(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.timesheet.list({ empIds, status: 'Submitted' }), [key]);
}

export function usePendingRegularisations(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.attendance.list({ empIds, regularisedOnly: true }), [key]);
}

export function usePendingClaims(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.expenses.claims({ empIds, status: 'Submitted' }), [key]);
}

export function usePendingOvertime(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.shifts.overtime(empIds, 'Pending'), [key]);
}

export function usePendingLoans(enabled: boolean) {
  return useQuery((s) => (enabled ? s.loans.list('Pending Approval') : Promise.resolve([])), [enabled]);
}

export function usePendingLetters(enabled: boolean) {
  return useQuery((s) => (enabled ? s.letters.requests('Pending') : Promise.resolve([])), [enabled]);
}

export function useMyInterviews(panelId: string) {
  return useQuery((s) => s.hiring.interviewsFor(panelId, 'Scheduled'), [panelId]);
}

/* ---------- the actions, shared with the owning modules ---------- */

export const useApproveLeave = () => useMutation((s, id: string, by: string) => s.leave.approve(id, by));
export const useRejectLeave = () => useMutation((s, id: string, by: string) => s.leave.reject(id, by));
export const useApproveTimesheet = () => useMutation((s, id: string, by: string) => s.timesheet.approve(id, by));
export const useReturnTimesheet = () =>
  useMutation((s, id: string, by: string, note: string) => s.timesheet.reject(id, by, note));
export const useActOnRegularisation = () =>
  useMutation((s, r: AttRecord, decision: 'Approved' | 'Rejected') =>
    s.attendance.actOnRegularisation(r.empId, r.date, decision));
export const useApproveClaim = () => useMutation((s, id: string, by: string) => s.expenses.approveClaim(id, by));
export const useRejectClaim = () =>
  useMutation((s, id: string, by: string, note: string) => s.expenses.rejectClaim(id, by, note));
export const useReimburseClaim = () => useMutation((s, id: string) => s.expenses.reimburseClaim(id));
export const useApproveOvertime = () => useMutation((s, id: string, by: string) => s.shifts.approveOvertime(id, by));
export const useApproveLoan = () => useMutation((s, id: string) => s.loans.approve(id));
export const useIssueLetter = () => useMutation((s, id: string) => s.letters.issue(id));
