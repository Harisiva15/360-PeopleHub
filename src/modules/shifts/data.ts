/** The shift screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type { NewOvertime, Overtime, ShiftDraft } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);

export const useOvertime = (empIds?: string[], status?: Overtime['status']) =>
  useQuery((s) => s.shifts.overtime(empIds, status), [empIds ? empIds.join(',') : 'all', status ?? '']);
export const useApproveOvertime = () =>
  useMutation((s, id: string) => s.shifts.approveOvertime(id));
export const useRejectOvertime = () =>
  useMutation((s, id: string) => s.shifts.rejectOvertime(id));
export const useRaiseOvertime = () => useMutation((s, o: NewOvertime) => s.shifts.raiseOvertime(o));

export const useShiftProfiles = () => useQuery((s) => s.shifts.profiles(), []);
/* Admin-only writes, refused by the service rather than hidden here. */
export const useCreateShift = () =>
  useMutation((s, draft: ShiftDraft) => s.shifts.createShift(draft));
export const useUpdateShift = () =>
  useMutation((s, code: string, patch: ShiftDraft) => s.shifts.updateShift(code, patch));
export const useSetShiftActive = () =>
  useMutation((s, code: string, active: boolean) => s.shifts.setShiftActive(code, active));
export const useRoster = (empIds: string[], from: string, days: number) =>
  useQuery((s) => s.shifts.roster(empIds, from, days), [empIds.join(','), from, String(days)]);
export const useSetShift = () =>
  useMutation((s, empId: string, shiftCode: string) => s.shifts.setShift(empId, shiftCode));
export const useTodayCoverage = () => useQuery((s) => s.shifts.todayCoverage(), []);

export const useLeaveBalance = (empId: string, type: string) =>
  useQuery((s) => s.leave.balance(empId, type), [empId, type]);
