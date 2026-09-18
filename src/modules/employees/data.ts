/**
 * The employee screens' data access.
 *
 * The profile drawer takes one composite rather than fanning out across a
 * dozen domains — see `EmployeeProfile` in the contracts for why.
 */

import { useMutation, useQuery } from '../../services/react';
import { unbacked } from '../../services/unbacked';
import type { AppRole } from '../../types/employee';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/**
 * The profile composite.
 *
 * Still on the mock, and the one composite that cannot simply be moved: it
 * pulls together documents, learning, loans and the lifecycle trail, and those
 * services have no server behind them yet. Half of it would be real and half
 * invented, on the same screen, with nothing to tell them apart.
 *
 * So in a configured build it resolves to null and the drawer says why. The
 * header — name, designation, code — comes from `employees.byId`, which is
 * live, so clicking a person still does something truthful.
 */
export function useProfile(id: string) {
  return useQuery(unbacked((s) => s.employees.profile(id), null), [id]);
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
