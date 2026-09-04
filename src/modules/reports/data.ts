/**
 * The reporting screens' data access.
 *
 * Reports are read-only by nature, so this is all queries — but they still go
 * through the service, because a reporting API is exactly the thing a real
 * deployment moves server-side first (these are the queries that get slow).
 */

import { useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const key = (ids: string[]) => ids.join(',');

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useExitedEmployees = () => useQuery((s) => s.employees.exited(), []);

export const useAttendanceIn = (ids: string[], from?: string, to?: string) =>
  useQuery((s) => s.attendance.list({ empIds: ids, from, to }), [key(ids), from, to]);

export const useLeaveIn = (ids: string[]) =>
  useQuery((s) => s.leave.list({ empIds: ids }), [key(ids)]);
export const useLeaveBalancesIn = (ids: string[]) =>
  useQuery((s) => s.leave.balancesFor(ids), [key(ids)]);
export const useDailyRates = (ids: string[]) =>
  useQuery((s) => s.payroll.dailyRates(ids), [key(ids)]);

export const useTimesheetsIn = (ids: string[]) =>
  useQuery((s) => s.timesheet.list({ empIds: ids }), [key(ids)]);

export const usePayRuns = () => useQuery((s) => s.payroll.runs(), []);
export const usePayrollTotalsFor = (mks: string[]) =>
  useQuery((s) => s.payroll.totalsFor(mks), [mks.join(',')]);
export const useRegister = (mk: string) => useQuery((s) => s.payroll.register(mk), [mk]);
export const useCompensation = () => useQuery((s) => s.payroll.compensation(), []);

export const useCandidates = () => useQuery((s) => s.hiring.candidates(), []);
export const useRequisitions = () => useQuery((s) => s.hiring.requisitions(), []);

export const useClaimsIn = (ids: string[]) =>
  useQuery((s) => s.expenses.claims({ empIds: ids }), [key(ids)]);
export const useActiveLoans = () => useQuery((s) => s.payroll.activeLoans(), []);
export const useFbpTotals = (ids: string[]) =>
  useQuery((s) => s.benefits.fbpTotals(ids), [key(ids)]);

export const useGoals = (ids: string[]) => useQuery((s) => s.performance.goals(ids), [key(ids)]);
export const useReviews = (ids: string[]) => useQuery((s) => s.performance.reviews(ids), [key(ids)]);
export const usePraise = () => useQuery((s) => s.performance.praise(), []);
export const useCurrentCycle = () => useQuery((s) => s.performance.currentCycle(), []);

export const useTickets = () => useQuery((s) => s.helpdesk.tickets(), []);
export const useSurveys = () => useQuery((s) => s.engagement.surveys(), []);
export const useEnpsHistory = () => useQuery((s) => s.engagement.enpsHistory(), []);
export const useCourses = () => useQuery((s) => s.learning.courses(), []);
export const useEnrolments = () => useQuery((s) => s.learning.enrolments(), []);
