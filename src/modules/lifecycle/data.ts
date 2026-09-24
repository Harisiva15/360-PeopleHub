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
import type { LifecycleFilter, LifecycleTaskDraft, PromotionDraft } from '../../services';

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

/* ---------- the two explicit decisions ---------- */

/*
 * Both carry the caller and both are refused by the service, not by these
 * hooks. The screen hides what a role cannot do as a convenience; the server
 * is what makes it true.
 */
export const useConfirmProbation = () => {
  const c = useCaller();
  return useMutation((s, empId: string, opts: { on?: string | null; note?: string | null }) =>
    s.lifecycle.confirmProbation(c, empId, opts));
};

export const usePromote = () => {
  const c = useCaller();
  return useMutation((s, empId: string, draft: PromotionDraft) =>
    s.lifecycle.promote(c, empId, draft));
};

/** The real grade ladder. The GRADES constant has drifted from the database. */
export const useGrades = () => useQuery((s) => s.config.grades(), []);
