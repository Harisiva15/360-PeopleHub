/**
 * The employee screens' data access.
 *
 * The profile drawer takes one composite rather than fanning out across a
 * dozen domains — see `EmployeeProfile` in the contracts for why.
 */

import { useMutation, useQuery } from '../../services/react';
import type { AppRole } from '../../types/employee';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export function useProfile(id: string) {
  return useQuery((s) => s.employees.profile(id), [id]);
}

export function useAllEmployees() {
  return useQuery((s) => s.employees.active(), []);
}

export function useExitedEmployees() {
  return useQuery((s) => s.employees.exited(), []);
}

export const useSetRole = () => useMutation((s, id: string, role: AppRole) => s.employees.setRole(id, role));

/** New joiners. Managers raise them; admins decide. */
export const useJoiners = (status?: 'pending') =>
  useQuery((s) => s.joiners.list(status), [status ?? 'all']);
export const useApproveJoiner = () =>
  useMutation((s, id: string, note?: string) => s.joiners.approve(id, note));
export const useRejectJoiner = () =>
  useMutation((s, id: string, note?: string) => s.joiners.reject(id, note));
