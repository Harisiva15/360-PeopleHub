/** The onboarding screens' data access. */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useJourneys = () => useQuery((s) => s.onboarding.list(), []);
export const useSetTask = () =>
  useMutation((s, id: string, key: string, done: boolean) => s.onboarding.setTask(id, key, done));
export const useCompleteJourney = () => useMutation((s, id: string) => s.onboarding.complete(id));
