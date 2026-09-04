/**
 * The timesheet screens' data access.
 *
 * Every edit — adding a row, typing an hour, submitting, approving — is a
 * service command. The editor used to mutate the sheet in place during render
 * and call `bump()`, which is why the linter flagged it; the total is now
 * derived by the service and comes back on the response.
 */

import { useMutation, useQuery } from '../../services/react';
import type { TSStatus } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

export function useSheet(empId: string, weekStart: string) {
  return useQuery((s) => s.timesheet.forWeek(empId, weekStart), [empId, weekStart]);
}

export function useMySheets(empId: string) {
  return useQuery((s) => s.timesheet.list({ empIds: [empId] }), [empId]);
}

export function useSheets(empIds: string[], opts: { weekStart?: string; since?: string; status?: TSStatus } = {}) {
  const key = empIds.join(',');
  return useQuery(
    (s) => s.timesheet.list({ empIds, ...opts }),
    [key, opts.weekStart, opts.since, opts.status],
  );
}

/* ---------- writes ---------- */

export const useAddRow = () => useMutation((s, id: string, proj: string, task: string) => s.timesheet.addRow(id, proj, task));
export const useRemoveRow = () => useMutation((s, id: string, i: number) => s.timesheet.removeRow(id, i));
export const useSetRow = () =>
  useMutation((s, id: string, i: number, patch: { proj?: string; task?: string }) => s.timesheet.setRow(id, i, patch));
export const useSetHours = () =>
  useMutation((s, id: string, ri: number, di: number, h: number) => s.timesheet.setHours(id, ri, di, h));
export const useSubmitSheet = () => useMutation((s, id: string) => s.timesheet.submit(id));
export const useRecallSheet = () => useMutation((s, id: string) => s.timesheet.recall(id));
export const useApproveSheet = () => useMutation((s, id: string, approverId: string) => s.timesheet.approve(id, approverId));
export const useRejectSheet = () =>
  useMutation((s, id: string, approverId: string, note: string) => s.timesheet.reject(id, approverId, note));
