/**
 * The leave screens' data access — every read and write this module needs,
 * expressed as service calls.
 *
 * Views import from here and never from `src/data`, which is what lets the
 * dataset be swapped for an API without touching the views. The two-stage
 * pattern below (fetch rows, then resolve the people they reference) is what
 * a real client does when the API does not denormalise names into the row.
 */

import { useQuery, useMutation } from '../../services/react';
import type { LeaveBalanceRow, LeaveRequest } from '../../services';

/* Directory access is shared across modules — re-exported so the leave views
   keep one import. */
export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

export function useMyBalances(empId: string) {
  return useQuery((s) => s.leave.balances(empId), [empId]);
}

export function useMyLeave(empId: string) {
  return useQuery((s) => s.leave.list({ empIds: [empId] }), [empId]);
}

export function useLeaveFor(empIds: string[], status?: LeaveRequest['status']) {
  const key = empIds.join(',');
  return useQuery((s) => s.leave.list({ empIds, status }), [key, status]);
}

export function useBalancesFor(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.leave.balancesFor(empIds), [key]);
}

/** Look up one balance row out of a batched result. */
export const balanceOf = (
  all: Record<string, LeaveBalanceRow[]> | undefined,
  empId: string,
  type: string,
): LeaveBalanceRow | undefined => all?.[empId]?.find((b) => b.type === type);

/* ---------- writes ---------- */

export const useApplyLeaveRequest = () => useMutation((s, req: Parameters<typeof s.leave.apply>[0]) => s.leave.apply(req));
export const useApproveLeave = () => useMutation((s, id: string, approverId: string) => s.leave.approve(id, approverId));
export const useRejectLeave = () => useMutation((s, id: string, approverId: string, note: string) => s.leave.reject(id, approverId, note));
export const useCancelLeave = () => useMutation((s, id: string) => s.leave.cancel(id));
