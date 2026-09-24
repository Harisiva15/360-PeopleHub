/** The engagement screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { SurveyAnswer } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useSurveys = () => useQuery((s) => s.engagement.surveys(), []);
export const useEnpsHistory = () => useQuery((s) => s.engagement.enpsHistory(), []);
export const useEnps = (surveyId: string) => useQuery((s) => s.engagement.enpsOf(surveyId), [surveyId]);

/** Recognition is praise — the same record Performance reads, for a different reason. */
export const usePraise = () => useQuery((s) => s.performance.praise(), []);

/**
 * The questions of one survey, as asked.
 *
 * `Survey.questions` is the aggregate — means, withheld below the response
 * floor — and cannot be answered against: no ids, and nothing at all on a
 * survey nobody has answered. This is the form's source.
 */
export const useSurveyQuestions = (surveyId: string) =>
  useQuery((s) => s.engagement.surveyQuestions(surveyId), [surveyId]);

export const useRespondToSurvey = () =>
  useMutation((s, surveyId: string, answers: SurveyAnswer[]) =>
    s.engagement.respondToSurvey(surveyId, answers));
