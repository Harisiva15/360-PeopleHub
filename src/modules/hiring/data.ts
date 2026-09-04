/** The hiring screens' data access. */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useCandidates = () => useQuery((s) => s.hiring.candidates(), []);
export const useRequisitions = () => useQuery((s) => s.hiring.requisitions(), []);
export const useMyInterviews = (panelId: string) =>
  useQuery((s) => s.hiring.interviewsFor(panelId), [panelId]);
export const useInterviews = () => useQuery((s) => s.hiring.interviews(), []);
export const useMoveCandidate = () =>
  useMutation((s, candId: string, stage: string) => s.hiring.moveCandidate(candId, stage));
