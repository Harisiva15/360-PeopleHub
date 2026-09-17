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

/** The letter for one offer: rendered while a draft, frozen once released. */
export const useOfferLetter = (candId: string) =>
  useQuery((s) => s.hiring.offerLetter(candId), [candId]);
export const useReleaseOffer = () =>
  useMutation((s, candId: string) => s.hiring.releaseOffer(candId));

/* ---------- the recruitment activity tracker ---------- */

/** Per-job-order activity: submissions, who is still active, and where. */
export const useRequisitionTracker = () =>
  useQuery((s) => s.hiring.requisitionTracker(), []);
export const useRecruiterTracker = () =>
  useQuery((s) => s.hiring.recruiterTracker(), []);
