/** The engagement screens' data access. */

import { useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useSurveys = () => useQuery((s) => s.engagement.surveys(), []);
export const useEnpsHistory = () => useQuery((s) => s.engagement.enpsHistory(), []);
export const useEnps = (surveyId: string) => useQuery((s) => s.engagement.enpsOf(surveyId), [surveyId]);
