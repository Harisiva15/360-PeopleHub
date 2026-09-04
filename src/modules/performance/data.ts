/** The performance screens' data access. */

import { useMutation, useQuery } from '../../services/react';

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
