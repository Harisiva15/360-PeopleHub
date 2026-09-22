/**
 * The lifecycle screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 *
 * Note what is missing: there is no `useSetStage`. The stage is derived from
 * the records the product already keeps, so there is nothing here to set it
 * with, and the screen says where to change it instead.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { LifecycleFilter, LifecycleTaskDraft } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const keyOf = (f: LifecycleFilter) => [f.q, f.stage, f.dept, f.managerId, f.site, f.from, f.to];

export function useLifecycle(f: LifecycleFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.lifecycle.list(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useLifecycleRow(id: string) {
  const c = useCaller();
  return useQuery((s) => s.lifecycle.get(c, id), [c.role, c.meId, id]);
}

export function useLifecycleStats() {
  const c = useCaller();
  return useQuery((s) => s.lifecycle.stats(c), [c.role, c.meId]);
}

export const useAddTask = () => {
  const c = useCaller();
  return useMutation((s, empId: string, draft: LifecycleTaskDraft) =>
    s.lifecycle.addTask(c, empId, draft));
};

export const useSetTaskDone = () => {
  const c = useCaller();
  return useMutation((s, taskId: string, done: boolean) =>
    s.lifecycle.setTaskDone(c, taskId, done));
};

export const useRemoveTask = () => {
  const c = useCaller();
  return useMutation((s, taskId: string) => s.lifecycle.removeTask(c, taskId));
};
