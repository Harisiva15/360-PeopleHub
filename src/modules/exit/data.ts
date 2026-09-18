/**
 * The exit screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';
import type { ExitInterviewAnswers, NewExit } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useExitDetail = (id: string) => useQuery((s) => s.exits.detail(id), [id]);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useSetClearance = () =>
  useMutation((s, exitId: string, department: string, done: boolean) => s.exits.setClearance(exitId, department, done));
export const useSettleExit = () => useMutation((s, exitId: string) => s.exits.settle(exitId));
export const useMyLeaveBalance = (empId: string, type: string) =>
  useQuery((s) => s.leave.balance(empId, type), [empId, type]);
export const useActiveLoans = () => useQuery((s) => s.payroll.activeLoans(), []);

/* Both were live on the server with no way to call them: the resignation
   button said so out loud, and the exit interview had no form at all. */
export const useRaiseExit = () =>
  useMutation((s, draft: NewExit) => s.exits.raise(draft));
export const useRecordExitInterview = () =>
  useMutation((s, exitId: string, answers: ExitInterviewAnswers) =>
    s.exits.recordInterview(exitId, answers));
