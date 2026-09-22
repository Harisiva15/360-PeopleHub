/**
 * The software screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { SoftwareDraft, SoftwareFilter } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const keyOf = (f: SoftwareFilter) =>
  [f.q, f.cat, f.vendor, f.status, f.ownerId, f.renewingWithin, f.hasDormant];

export function useSoftware(f: SoftwareFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.software.list(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useSoftwareProduct(id: string) {
  const c = useCaller();
  return useQuery((s) => s.software.get(c, id), [c.role, c.meId, id]);
}

/** The seats the signed-in person holds — what an employee gets. */
export function useMySoftware() {
  const c = useCaller();
  return useQuery((s) => s.software.mine(c), [c.role, c.meId]);
}

export function useSoftwareStats() {
  const c = useCaller();
  return useQuery((s) => s.software.stats(c), [c.role, c.meId]);
}

export function useRenewals(withinDays = 90) {
  const c = useCaller();
  return useQuery((s) => s.software.renewals(c, withinDays), [c.role, c.meId, withinDays]);
}

export const useCreateSoftware = () => {
  const c = useCaller();
  return useMutation((s, draft: SoftwareDraft) => s.software.create(c, draft));
};

export const useUpdateSoftware = () => {
  const c = useCaller();
  return useMutation((s, id: string, patch: Partial<SoftwareDraft>) =>
    s.software.update(c, id, patch));
};

export const useRemoveSoftware = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.software.remove(c, id));
};

export const useAssignSeat = () => {
  const c = useCaller();
  return useMutation((s, productId: string, empId: string) =>
    s.software.assignSeat(c, productId, empId));
};

export const useRevokeSeat = () => {
  const c = useCaller();
  return useMutation((s, seatId: string) => s.software.revokeSeat(c, seatId));
};
