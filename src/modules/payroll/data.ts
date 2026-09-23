/**
 * The payroll screens' data access.
 *
 * Payslips, cycle totals, the register and the salary structures are all
 * computed by the service. That is the point of the seam here: a real payroll
 * engine runs on the server, and the screen should be rendering its answer
 * rather than deriving one of its own.
 */

import { useMutation, useQuery } from '../../services/react';
import type { StructureDraft } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const usePayRuns = () => useQuery((s) => s.payroll.runs(), []);
export const useCurrentRun = () => useQuery((s) => s.payroll.currentRun(), []);
export const usePayrollTotals = (mk: string) => useQuery((s) => s.payroll.totals(mk), [mk]);
export const usePayrollTotalsFor = (mks: string[]) =>
  useQuery((s) => s.payroll.totalsFor(mks), [mks.join(",")]);
export const useRegister = (mk: string) => useQuery((s) => s.payroll.register(mk), [mk]);
export const usePayslip = (empId: string, mk: string) => useQuery((s) => s.payroll.payslip(empId, mk), [empId, mk]);
export const usePayslipHistory = (empId: string) => useQuery((s) => s.payroll.payslipHistory(empId), [empId]);
export const useStructure = (empId: string) => useQuery((s) => s.payroll.structure(empId), [empId]);
export const usePayInputs = (mk: string) => useQuery((s) => s.payroll.inputs(mk), [mk]);
export const useCompensation = () => useQuery((s) => s.payroll.compensation(), []);
export const useDeclarations = () => useQuery((s) => s.payroll.declarations(), []);
export const useBankBatches = () => useQuery((s) => s.payroll.bankBatches(), []);
export const useCompliancePayments = () => useQuery((s) => s.payroll.compliancePayments(), []);
export const useActiveLoans = () => useQuery((s) => s.payroll.activeLoans(), []);
export const useApprovedClaims = () => useQuery((s) => s.expenses.claims({ status: 'Approved' }), []);
export const useProcessRun = () => useMutation((s, mk: string) => s.payroll.processRun(mk));

/* ---------- compensation ---------- */

/** One employee's compensation over time. Own, or admin — the service decides. */
export const useSalaryHistory = (empId: string) =>
  useQuery((s) => s.compensation.history(empId), [empId]);
export const useSalaryComponents = () => useQuery((s) => s.compensation.components(), []);
export const useSetStructure = () =>
  useMutation((s, empId: string, draft: StructureDraft) =>
    s.compensation.setStructure(empId, draft));
