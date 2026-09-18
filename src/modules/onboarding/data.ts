/** The onboarding screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { NewJourney } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useJourneys = () => useQuery((s) => s.onboarding.list(), []);
export const useSetTask = () =>
  useMutation((s, id: string, key: string, done: boolean) => s.onboarding.setTask(id, key, done));
export const useCompleteJourney = () => useMutation((s, id: string) => s.onboarding.complete(id));

/** Start a journey for somebody joining outside the recruitment pipeline. */
export const useCreateJourney = () =>
  useMutation((s, draft: NewJourney) => s.onboarding.create(draft));
