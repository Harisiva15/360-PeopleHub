/**
 * The leave screens' data access — every read and write this module needs,
 * expressed as service calls.
 *
 * Views import from here and never from `src/data`, which is what lets the
 * dataset be swapped for an API without touching the views. The two-stage
 * pattern below (fetch rows, then resolve the people they reference) is what
 * a real client does when the API does not denormalise names into the row.
 */

import { useMemo } from 'react';
import { useQuery, useMutation } from '../../services/react';
import type { Caller, Employee, LeaveBalanceRow, LeaveRequest } from '../../services';
import { useApp } from '../../state/AppContext';

/** The identity every scoped read is made on behalf of. */
export function useCaller(): Caller {
  const app = useApp();
  return useMemo(() => ({ role: app.role, meId: app.meId }), [app.role, app.meId]);
}

export interface Directory {
  list: Employee[];
  ids: string[];
  byId: (id: string) => Employee | undefined;
  name: (id: string | null | undefined) => string;
  loading: boolean;
}

const emptyDirectory = (loading: boolean): Directory => ({
  list: [], ids: [], byId: () => undefined, name: () => '—', loading,
});

function toDirectory(list: Employee[] | undefined, loading: boolean): Directory {
  if (!list) return emptyDirectory(loading);
  const map = new Map(list.map((e) => [e.id, e]));
  return {
    list,
    ids: list.map((e) => e.id),
    byId: (id) => map.get(id),
    name: (id) => (id ? map.get(id)?.name ?? '—' : '—'),
    loading,
  };
}

/** Everyone the signed-in user may see. */
export function useVisiblePeople(): Directory {
  const caller = useCaller();
  const { data, loading } = useQuery((s) => s.employees.visible(caller), [caller.role, caller.meId]);
  return useMemo(() => toDirectory(data, loading), [data, loading]);
}

/** Resolve a specific set of people — the approvers and applicants rows refer to. */
export function usePeople(ids: (string | null | undefined)[]): Directory {
  const wanted = useMemo(() => Array.from(new Set(ids.filter(Boolean) as string[])).sort(), [ids.join(',')]);
  const { data, loading } = useQuery((s) => s.employees.byIds(wanted), [wanted.join(',')]);
  return useMemo(() => toDirectory(data, loading), [data, loading]);
}

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
