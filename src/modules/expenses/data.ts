/**
 * The expense screens' data access.
 *
 * Claims and advances are approval workflows, so every transition is a
 * service command — that is where the rules live (a rejected claim cannot be
 * reimbursed, an advance is approved once).
 */

import { useMutation, useQuery } from '../../services/react';
import type { ClaimStatus, NewClaim } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

export function useClaims(empIds: string[], status?: ClaimStatus) {
  const key = empIds.join(',');
  return useQuery((s) => s.expenses.claims({ empIds, status }), [key, status]);
}

export function useAdvances(empIds: string[]) {
  const key = empIds.join(',');
  return useQuery((s) => s.expenses.advances(empIds), [key]);
}

/* ---------- writes ---------- */

export const useSubmitClaim = () => useMutation((s, c: NewClaim) => s.expenses.submitClaim(c));
export const useApproveClaim = () => useMutation((s, id: string, by: string) => s.expenses.approveClaim(id, by));
export const useRejectClaim = () => useMutation((s, id: string, by: string, note: string) => s.expenses.rejectClaim(id, by, note));
export const useReimburseClaim = () => useMutation((s, id: string) => s.expenses.reimburseClaim(id));
export const useRequestAdvance = () =>
  useMutation((s, empId: string, amount: number, reason: string) => s.expenses.requestAdvance(empId, amount, reason));
export const useApproveAdvance = () => useMutation((s, id: string) => s.expenses.approveAdvance(id));
