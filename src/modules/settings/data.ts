/**
 * The settings screens' data access.
 *
 * The writes here are configuration changes with reach — see ConfigService.
 */

import { useMutation, useQuery } from '../../services/react';
import type { AppRole } from '../../types/employee';
import type { FenceUpdate } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useExitedEmployees = () => useQuery((s) => s.employees.exited(), []);
export const useSites = () => useQuery((s) => s.config.sites(), []);
export const useHolidays = () => useQuery((s) => s.config.holidays(), []);
export const useCompensation = () => useQuery((s) => s.payroll.compensation(), []);
export const usePayRuns = () => useQuery((s) => s.payroll.runs(), []);
export const useRequisitions = () => useQuery((s) => s.hiring.requisitions(), []);
export const useCandidates = () => useQuery((s) => s.hiring.candidates(), []);
export const useTimesheetsAll = (ids: string[]) =>
  useQuery((s) => s.timesheet.list({ empIds: ids }), [ids.join(',')]);
export const useLeaveAll = (ids: string[]) => useQuery((s) => s.leave.list({ empIds: ids }), [ids.join(',')]);
export const useAttendanceAll = (ids: string[]) =>
  useQuery((s) => s.attendance.list({ empIds: ids }), [ids.join(',')]);

export const useSetRole = () => useMutation((s, id: string, role: AppRole) => s.employees.setRole(id, role));
export const useUpdateFence = () =>
  useMutation((s, siteId: string, patch: FenceUpdate) => s.config.updateFence(siteId, patch));
export const useSetLeaveQuota = () =>
  useMutation((s, typeId: string, quota: number) => s.config.setLeaveQuota(typeId, quota));
export const useAddHoliday = () =>
  useMutation((s, date: string, name: string, optional: boolean) => s.config.addHoliday(date, name, optional));
