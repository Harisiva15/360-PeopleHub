/**
 * The exit screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useExitDetail = (id: string) => useQuery((s) => s.exits.detail(id), [id]);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useSetClearance = () =>
  useMutation((s, exitId: string, index: number, done: boolean) => s.exits.setClearance(exitId, index, done));
export const useSettleExit = () => useMutation((s, exitId: string) => s.exits.settle(exitId));
export const useMyLeaveBalance = (empId: string, type: string) =>
  useQuery((s) => s.leave.balance(empId, type), [empId, type]);
export const useActiveLoans = () => useQuery((s) => s.payroll.activeLoans(), []);
