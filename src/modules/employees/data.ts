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

/**
 * The profile composite.
 *
 * It was the last method on the mock, and it waited on the services it pulls
 * together — documents, learning, loans and the lifecycle trail. Those went
 * live, compensation landed, and the server now assembles all eighteen fields
 * from the modules that own them, each already scoped to the caller.
 *
 * Null now means what it says: no such person, or not one this caller may see.
 */
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
