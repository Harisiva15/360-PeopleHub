/**
 * The development-plan screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type {
  DevActionDraft, DevPlanDraft, DevPlanFilter, PlanStatus,
} from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const keyOf = (f: DevPlanFilter) => [
  f.q, f.status, f.dept, f.managerId, f.mentorId, f.area,
  f.endorsed, f.reviewDue, f.overdueOnly,
];

export function useDevPlans(f: DevPlanFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.devPlans.list(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useDevPlan(id: string) {
  const c = useCaller();
  return useQuery((s) => s.devPlans.get(c, id), [c.role, c.meId, id]);
}

/** The signed-in person's own plan — the whole of an employee's screen. */
export function useMyDevPlan() {
  const c = useCaller();
  return useQuery((s) => s.devPlans.mine(c), [c.role, c.meId]);
}

export function useDevStats() {
  const c = useCaller();
  return useQuery((s) => s.devPlans.stats(c), [c.role, c.meId]);
}

export function useDevFocus() {
  const c = useCaller();
  return useQuery((s) => s.devPlans.focus(c), [c.role, c.meId]);
}

export function useMentorLoad() {
  const c = useCaller();
  return useQuery((s) => s.devPlans.mentors(c), [c.role, c.meId]);
}

export function useMentorOptions() {
  const c = useCaller();
  return useQuery((s) => s.devPlans.mentorOptions(c), [c.role, c.meId]);
}

export const useCreateDevPlan = () => {
  const c = useCaller();
  return useMutation((s, draft: DevPlanDraft) => s.devPlans.create(c, draft));
};

export const useUpdateDevPlan = () => {
  const c = useCaller();
  return useMutation((s, id: string, patch: Partial<DevPlanDraft>) =>
    s.devPlans.update(c, id, patch));
};

export const useEndorsePlan = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.devPlans.endorse(c, id));
};

export const useSetPlanStatus = () => {
  const c = useCaller();
  return useMutation((s, id: string, status: PlanStatus) =>
    s.devPlans.setStatus(c, id, status));
};

export const useSetReview = () => {
  const c = useCaller();
  return useMutation((s, id: string, on: string) => s.devPlans.setReview(c, id, on));
};

export const useAddAction = () => {
  const c = useCaller();
  return useMutation((s, planId: string, draft: DevActionDraft) =>
    s.devPlans.addAction(c, planId, draft));
};

export const useSetActionDone = () => {
  const c = useCaller();
  return useMutation((s, actionId: string, done: boolean) =>
    s.devPlans.setActionDone(c, actionId, done));
};

export const useRemoveAction = () => {
  const c = useCaller();
  return useMutation((s, actionId: string) => s.devPlans.removeAction(c, actionId));
};
