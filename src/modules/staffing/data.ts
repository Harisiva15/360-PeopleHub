/**
 * The staffing book's data access — clients, requirements, the bench,
 * billing and the vendor panel.
 *
 * The KPI block, the match engine and the redeployment plan are all service
 * computations: they read rate cards and cost bases across the whole book,
 * which is work a server does once rather than every client repeating.
 */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useKpi = () => useQuery((s) => s.staffing.kpi(), []);
export const useClients = () => useQuery((s) => s.staffing.clients(), []);
export const useRequirements = () => useQuery((s) => s.staffing.requirements(), []);
export const useConsultants = () => useQuery((s) => s.staffing.consultants(), []);
export const useBench = () => useQuery((s) => s.staffing.bench(), []);
/*
 * Days on the bench and what that has cost, for one person. Computed by the
 * service from `bench_since` rather than in the screen: the answer changes
 * every day, and two places computing it is two places to get it wrong.
 */
export const useBenchStanding = (consultantId: string) =>
  useQuery((s) => s.staffing.benchStanding(consultantId), [consultantId]);
/** Open requirements this person could be put forward for, best first. */
export const useMatchesForConsultant = (consultantId: string) =>
  useQuery((s) => s.staffing.matchesForConsultant(consultantId), [consultantId]);
export const usePlacements = () => useQuery((s) => s.staffing.placements(), []);
export const useSubmissions = () => useQuery((s) => s.staffing.submissions(), []);
export const useInvoices = () => useQuery((s) => s.staffing.invoices(), []);
export const useVendors = () => useQuery((s) => s.staffing.vendors(), []);
export const useSows = () => useQuery((s) => s.staffing.sows(), []);
export const useRateCards = () => useQuery((s) => s.staffing.rateCards(), []);
export const usePayRuns = () => useQuery((s) => s.payroll.runs(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);

export const useMoveSubmission = () =>
  useMutation((s, id: string, stage: string) => s.staffing.moveSubmission(id, stage));
