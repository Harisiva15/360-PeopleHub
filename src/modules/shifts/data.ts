/** The shift screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { NewOvertime, Overtime } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);

export const useOvertime = (empIds?: string[], status?: Overtime['status']) =>
  useQuery((s) => s.shifts.overtime(empIds, status), [empIds ? empIds.join(',') : 'all', status ?? '']);
export const useApproveOvertime = () =>
  useMutation((s, id: string, approverId: string) => s.shifts.approveOvertime(id, approverId));
export const useRaiseOvertime = () => useMutation((s, o: NewOvertime) => s.shifts.raiseOvertime(o));

export const useRoster = (empIds: string[]) =>
  useQuery((s) => s.shifts.roster(empIds), [empIds.join(',')]);
export const useSetShift = () =>
  useMutation((s, empId: string, date: string, shiftId: string) => s.shifts.setShift(empId, date, shiftId));
export const useTodayCoverage = () => useQuery((s) => s.shifts.todayCoverage(), []);

export const useLeaveBalance = (empId: string, type: string) =>
  useQuery((s) => s.leave.balance(empId, type), [empId, type]);
