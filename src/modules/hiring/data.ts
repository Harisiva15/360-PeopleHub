/** The hiring screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type {
  InterviewVerdict, NewInterview, NewOffer, NewRequisition, NewSubmission, OfferResponse,
} from '../../services';

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

/* ---------- the intake path ---------- */
/*
 * Every one of these was live on the server and unreachable from the app: the
 * pipeline could be read and filtered but nothing could be put into it.
 */


export const useOpenRequisition = () =>
  useMutation((s, draft: NewRequisition) => s.hiring.openRequisition(draft));
export const useSubmitCandidate = () =>
  useMutation((s, draft: NewSubmission) => s.hiring.submitCandidate(draft));
export const useScheduleInterview = () =>
  useMutation((s, draft: NewInterview) => s.hiring.scheduleInterview(draft));
export const useSubmitFeedback = () =>
  useMutation((s, id: string, verdict: InterviewVerdict, feedback: string) =>
    s.hiring.submitFeedback(id, verdict, feedback));
export const useMakeOffer = () =>
  useMutation((s, draft: NewOffer) => s.hiring.makeOffer(draft));
export const useRespondToOffer = () =>
  useMutation((s, candId: string, response: OfferResponse) =>
    s.hiring.respondToOffer(candId, response));
