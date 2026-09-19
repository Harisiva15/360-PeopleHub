/**
 * The user-administration screens' data access.
 *
 * Every call carries the caller, and the service checks it. The hooks do not
 * decide anything — a hook that filtered by role would be a second, quieter
 * copy of the policy, and the two would eventually disagree.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { UserDraft, UserFilter, UserPatch, UserStatus } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

/** Spread into the dependency list so an inline filter object does not refetch. */
const keyOf = (f: UserFilter) => [
  f.q, f.status, f.role, f.dept, f.site, f.managerId, f.empType, f.joinedFrom, f.joinedTo,
];

export function useUsers(f: UserFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.users.list(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useUserStats() {
  const c = useCaller();
  return useQuery((s) => s.users.stats(c), [c.role, c.meId]);
}

export function useUser(id: string) {
  const c = useCaller();
  return useQuery((s) => s.users.get(c, id), [c.role, c.meId, id]);
}

/* ---------- writes ---------- */

export const useCreateUser = () => {
  const c = useCaller();
  return useMutation((s, draft: UserDraft) => s.users.create(c, draft));
};

export const useUpdateUser = () => {
  const c = useCaller();
  return useMutation((s, id: string, patch: UserPatch) => s.users.update(c, id, patch));
};

export const useSetUserStatus = () => {
  const c = useCaller();
  return useMutation((s, id: string, status: UserStatus, reason?: string) =>
    s.users.setStatus(c, id, status, reason));
};

export const useDeleteUser = () => {
  const c = useCaller();
  return useMutation((s, id: string, typed: string) => s.users.remove(c, id, typed));
};

export const useDecideUser = () => {
  const c = useCaller();
  return useMutation((s, id: string, decision: 'Approved' | 'Rejected', note?: string) =>
    s.users.decide(c, id, decision, note));
};

export const useResendInvitation = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.users.resendInvitation(c, id));
};

export const useResetPassword = () => {
  const c = useCaller();
  return useMutation((s, id: string, force?: boolean) => s.users.resetPassword(c, id, force));
};

export const useBulkUpdate = () => {
  const c = useCaller();
  return useMutation((s, ids: string[], patch: UserPatch) => s.users.bulkUpdate(c, ids, patch));
};

export const useNextCode = () => {
  const c = useCaller();
  return useMutation((s) => s.users.nextEmployeeCode(c));
};
