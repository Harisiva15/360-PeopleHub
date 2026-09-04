/**
 * The dashboard's data access.
 *
 * The landing screen touches nearly every domain, which makes it the one that
 * most needs the seam: without it, the first page a user sees is also the one
 * most tightly welded to the dataset.
 */

import { useQuery } from '../../services/react';

import { useCaller } from '../../services/people';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const key = (ids: string[]) => ids.join(',');

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useTeam = (managerId: string) => useQuery((s) => s.employees.team(managerId, true), [managerId]);

export const useAttendanceIn = (ids: string[], from?: string, to?: string) =>
  useQuery((s) => s.attendance.list({ empIds: ids, from, to }), [key(ids), from, to]);
export const useMyAttendance = (empId: string, from?: string, to?: string) =>
  useQuery((s) => s.attendance.list({ empIds: [empId], from, to }), [empId, from, to]);

export const useLeaveIn = (ids: string[]) => useQuery((s) => s.leave.list({ empIds: ids }), [key(ids)]);
export const useMyBalances = (empId: string) => useQuery((s) => s.leave.balances(empId), [empId]);

export const useTimesheetsIn = (ids: string[]) => useQuery((s) => s.timesheet.list({ empIds: ids }), [key(ids)]);
export const useClaimsIn = (ids: string[]) => useQuery((s) => s.expenses.claims({ empIds: ids }), [key(ids)]);

export const usePayRuns = () => useQuery((s) => s.payroll.runs(), []);
export const useCurrentRun = () => useQuery((s) => s.payroll.currentRun(), []);
export const usePayrollTotals = (mk: string) => useQuery((s) => s.payroll.totals(mk), [mk]);
export const usePayslipHistory = (empId: string) => useQuery((s) => s.payroll.payslipHistory(empId), [empId]);
export const useDeclarations = () => useQuery((s) => s.payroll.declarations(), []);
export const useCompliancePayments = () => useQuery((s) => s.payroll.compliancePayments(), []);

export const useCandidates = () => useQuery((s) => s.hiring.candidates(), []);
export const useRequisitions = () => useQuery((s) => s.hiring.requisitions(), []);

export const useGoals = (ids: string[]) => useQuery((s) => s.performance.goals(ids), [key(ids)]);
export const useCurrentCycle = () => useQuery((s) => s.performance.currentCycle(), []);
export const useCourses = () => useQuery((s) => s.learning.courses(), []);
export const useEnrolments = (ids?: string[]) =>
  useQuery((s) => s.learning.enrolments(ids), [ids ? key(ids) : 'all']);
export const useTickets = (ids?: string[]) => useQuery((s) => s.helpdesk.tickets(ids), [ids ? key(ids) : 'all']);
export const useSurveys = () => useQuery((s) => s.engagement.surveys(), []);

export const useAnnouncements = () => useQuery((s) => s.noticeboard.announcements(), []);
export const useCelebrations = (days: number) => useQuery((s) => s.noticeboard.celebrations(days), [days]);
export const useExits = () => useQuery((s) => s.exits.list(), []);

/** The approval inbox, assembled and scoped by the service. */
export const usePendingItems = () => {
  const caller = useCaller();
  return useQuery((s) => s.approvals.pending(caller), [caller.role, caller.meId]);
};
export const usePendingCount = () => {
  const caller = useCaller();
  return useQuery((s) => s.approvals.pendingCount(caller), [caller.role, caller.meId]);
};
