/**
 * The AI layer's data access.
 *
 * Matching goes through the service rather than running in the browser: it
 * scores a pairing from consultant cost bases and client bill rates, and that
 * is not data every caller should be holding.
 */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useStaffingKpi = () => useQuery((s) => s.staffing.kpi(), []);
export const useClients = () => useQuery((s) => s.staffing.clients(), []);
export const useConsultants = () => useQuery((s) => s.staffing.consultants(), []);
export const useBench = () => useQuery((s) => s.staffing.bench(), []);
export const usePlacements = () => useQuery((s) => s.staffing.placements(), []);
export const useRequirements = () => useQuery((s) => s.staffing.requirements(), []);
export const useOpenRequirements = () => useQuery((s) => s.staffing.openRequirements(), []);
export const useInvoices = () => useQuery((s) => s.staffing.invoices(), []);
export const useVendors = () => useQuery((s) => s.staffing.vendors(), []);
export const useSubmissions = () => useQuery((s) => s.staffing.submissions(), []);
export const useSows = () => useQuery((s) => s.staffing.sows(), []);
export const useRedeploymentPlan = () => useQuery((s) => s.staffing.redeploymentPlan(), []);

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useReviews = (ids: string[]) => useQuery((s) => s.performance.reviews(ids), [ids.join(',')]);
export const useLeaveAll = (ids: string[]) => useQuery((s) => s.leave.list({ empIds: ids }), [ids.join(',')]);
export const useCurrentRun = () => useQuery((s) => s.payroll.currentRun(), []);
export const usePayrollTotals = (mk: string) => useQuery((s) => s.payroll.totals(mk), [mk]);
export const useCompensation = () => useQuery((s) => s.payroll.compensation(), []);

/* Matches are fetched on demand when a drawer opens, not held in a hook. */
export const useMatchesForConsultant = () =>
  useMutation((s, id: string) => s.staffing.matchesForConsultant(id));
export const useMatchesForRequirement = () =>
  useMutation((s, id: string) => s.staffing.matchesForRequirement(id));

/**
 * Everything the question answerer reads. Gathered by the copilot view and
 * passed in, so `answerFor` stays a pure function of fetched data — which is
 * what makes it testable and what stops it reaching for the dataset.
 */
export interface AnswerSources {
  kpi: import('../../services').StaffingKPI;
  bench: import('../../services').Consultant[];
  consultants: import('../../services').Consultant[];
  clients: import('../../services').Client[];
  vendors: import('../../services').Vendor[];
  invoices: import('../../services').Invoice[];
  placements: import('../../services').Placement[];
  openRequirements: import('../../services').StaffingRequirement[];
  employees: import('../../services').Employee[];
  exits: import('../../services').ExitRecord[];
  leave: import('../../services').LeaveRequest[];
  leaveTypes: { id: string; name: string }[];
  payrollTotals: import('../../services').PayrollTotals;
  currentRunKey: string;
}
