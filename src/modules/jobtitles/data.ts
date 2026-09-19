/**
 * The job-title screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { JobTitleDraft, JobTitleFilter, JobTitleStatus } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const keyOf = (f: JobTitleFilter) => [f.q, f.dept, f.family, f.level, f.empType, f.status];

export function useJobTitles(f: JobTitleFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.jobTitles.list(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useJobTitle(id: string) {
  const c = useCaller();
  return useQuery((s) => s.jobTitles.get(c, id), [c.role, c.meId, id]);
}

/** The one title the signed-in person holds — what an employee gets. */
export function useMyJobTitle() {
  const c = useCaller();
  return useQuery((s) => s.jobTitles.mine(c), [c.role, c.meId]);
}

export const useCreateJobTitle = () => {
  const c = useCaller();
  return useMutation((s, draft: JobTitleDraft) => s.jobTitles.create(c, draft));
};

export const useUpdateJobTitle = () => {
  const c = useCaller();
  return useMutation((s, id: string, patch: Partial<JobTitleDraft>) =>
    s.jobTitles.update(c, id, patch));
};

export const useSetJobTitleStatus = () => {
  const c = useCaller();
  return useMutation((s, id: string, status: JobTitleStatus) =>
    s.jobTitles.setStatus(c, id, status));
};

export const useDeleteJobTitle = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.jobTitles.remove(c, id));
};
