/** The shift screens' data access. */

import { useMutation, useQuery } from '../../services/react';
import type {
  EmployeeScheduleDraft, NewOvertime, Overtime, ShiftDraft,
  WorkScheduleDayDraft, WorkScheduleDraft,
} from '../../services';

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

/* ---------------- work schedules ----------------
 *
 * Which days somebody works, as against which hours. The reads are open to every
 * role — a company's working week is not privileged, and an employee should be
 * able to see the pattern they are on. The writes are refused by the service for
 * anyone but an admin rather than merely hidden here.
 */

export const useWorkSchedules = () => useQuery((s) => s.schedules.workSchedules(), []);
export const useCreateWorkSchedule = () =>
  useMutation((s, draft: WorkScheduleDraft) => s.schedules.createWorkSchedule(draft));
export const useUpdateWorkSchedule = () =>
  useMutation((s, code: string, patch: WorkScheduleDraft) =>
    s.schedules.updateWorkSchedule(code, patch));
export const useSetWorkScheduleDay = () =>
  useMutation((s, code: string, day: WorkScheduleDayDraft) =>
    s.schedules.setWorkScheduleDay(code, day));
export const useSetWorkScheduleActive = () =>
  useMutation((s, code: string, active: boolean) =>
    s.schedules.setWorkScheduleActive(code, active));

/* One person's effective-dated assignments, newest first. */
export const useEmployeeSchedules = (empId: string) =>
  useQuery((s) => s.schedules.employeeSchedules(empId), [empId]);
export const useAssignEmployeeSchedule = () =>
  useMutation((s, empId: string, draft: EmployeeScheduleDraft) =>
    s.schedules.assignEmployeeSchedule(empId, draft));
export const useCloseEmployeeSchedule = () =>
  useMutation((s, empId: string, assignmentId: string, validTo: string) =>
    s.schedules.closeEmployeeSchedule(empId, assignmentId, validTo));
