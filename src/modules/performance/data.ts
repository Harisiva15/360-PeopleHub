/** The performance screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { NewCheckIn, NewGoal, ReviewOutcome } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useGoals = (empIds?: string[]) =>
  useQuery((s) => s.performance.goals(empIds), [empIds ? empIds.join(',') : 'all']);
export const useReviews = (empIds?: string[]) =>
  useQuery((s) => s.performance.reviews(empIds), [empIds ? empIds.join(',') : 'all']);
export const usePraise = () => useQuery((s) => s.performance.praise(), []);
export const useCurrentCycle = () => useQuery((s) => s.performance.currentCycle(), []);
export const useCheckins = (empIds?: string[]) =>
  useQuery((s) => s.performance.checkins(empIds), [empIds ? empIds.join(',') : 'all']);
export const useSetGoalProgress = () =>
  useMutation((s, goalId: string, progress: number) => s.performance.setGoalProgress(goalId, progress));
export const useTeam = (managerId: string) => useQuery((s) => s.employees.team(managerId, true), [managerId]);

/* ---------- writing a review ---------- */
/*
 * Six methods that were live on the server with no way to call them. The
 * order the cycle runs in is the server's — a manager's review is refused
 * before the self-assessment is in — so these are plain pass-throughs.
 */
export const useAddGoal = () =>
  useMutation((s, draft: NewGoal) => s.performance.addGoal(draft));
export const useLogCheckin = () =>
  useMutation((s, draft: NewCheckIn) => s.performance.logCheckin(draft));
export const useGivePraise = () =>
  useMutation((s, toId: string, value: string, text: string) =>
    s.performance.givePraise(toId, value, text));
export const useSubmitSelfReview = () =>
  useMutation((s, rating: number, comments: string) =>
    s.performance.submitSelfReview(rating, comments));
export const useSubmitManagerReview = () =>
  useMutation((s, empId: string, rating: number, comments: string) =>
    s.performance.submitManagerReview(empId, rating, comments));
export const useCalibrateReview = () =>
  useMutation((s, empId: string, outcome: ReviewOutcome) =>
    s.performance.calibrateReview(empId, outcome));
