/**
 * The recruitment desk's data access.
 *
 * Every figure a screen shows — the tiles, the funnel, an order's SLA and its
 * counts — comes back from the service already computed. The screens never add
 * these up themselves: a dashboard whose tiles disagree with the funnel
 * beneath them is the commonest failure of a page like this, and it happens
 * the moment two places count the same thing.
 */

import { useMutation, useQuery } from '../../services/react';
import type {
  ActivityKind, AssignmentDraft, JobOrderDraft, RecruitmentFilter,
} from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

/**
 * The filter is spread into the dependency list rather than passed whole, so
 * a caller building the object inline does not refetch on every render.
 */
const keyOf = (f: RecruitmentFilter) => [
  f.from, f.to, f.clientId, f.recruiterId, f.reqId,
  f.industry, f.tech, f.location, f.status, f.priority,
];

/** Rows carry their own SLA and counts — see `JobOrderRow` for why. */
export const useJobOrders = (f: RecruitmentFilter = {}) =>
  useQuery((s) => s.recruitment.jobOrders(f), keyOf(f));

export const useJobOrder = (id: string) =>
  useQuery((s) => s.recruitment.jobOrder(id), [id]);

export const useRecruitmentKpi = (f: RecruitmentFilter = {}) =>
  useQuery((s) => s.recruitment.kpi(f), keyOf(f));

export const useFunnel = (f: RecruitmentFilter = {}) =>
  useQuery((s) => s.recruitment.funnel(f), keyOf(f));

export const useMyJobs = (recruiterId: string) =>
  useQuery((s) => s.recruitment.myJobs(recruiterId), [recruiterId]);

/* Reference data the job-order form needs. */
export const useClients = () => useQuery((s) => s.staffing.clients(), []);
export const useSows = () => useQuery((s) => s.staffing.sows(), []);
export const useVendors = () => useQuery((s) => s.staffing.vendors(), []);
export const useSubmissions = () => useQuery((s) => s.staffing.submissions(), []);

/* ---------- writes ---------- */

export const useCreateJobOrder = () =>
  useMutation((s, draft: JobOrderDraft) => s.recruitment.createJobOrder(draft));

export const useUpdateJobOrder = () =>
  useMutation((s, id: string, patch: Partial<JobOrderDraft>) =>
    s.recruitment.updateJobOrder(id, patch));

export const useAssign = () =>
  useMutation((s, id: string, draft: AssignmentDraft) => s.recruitment.assign(id, draft));

export const useRelease = () =>
  useMutation((s, id: string, assignmentId: string) => s.recruitment.release(id, assignmentId));

export const useLogActivity = () =>
  useMutation((s, id: string, kind: ActivityKind, summary: string, qty?: number) =>
    s.recruitment.logActivity(id, kind, summary, qty));
