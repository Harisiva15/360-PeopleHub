/** The benefits screens' data access. */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);

export const useFbpPlan = (empId: string) => useQuery((s) => s.benefits.fbpPlan(empId), [empId]);
export const useFbpRows = () => useQuery((s) => s.benefits.fbpRows(), []);
export const useDeclareFbp = () =>
  useMutation((s, empId: string, alloc: Record<string, number>) => s.benefits.declareFbp(empId, alloc));
export const useInsuranceCover = () => useQuery((s) => s.benefits.insuranceCover(), []);

export const useLoans = () => useQuery((s) => s.loans.list(), []);
export const useApproveLoan = () => useMutation((s, id: string) => s.loans.approve(id));
