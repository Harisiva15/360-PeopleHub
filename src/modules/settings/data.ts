/**
 * The settings screens' data access.
 *
 * The writes here are configuration changes with reach — see ConfigService.
 */

import { useMutation, useQuery } from '../../services/react';
import type { AppRole } from '../../types/employee';
import type { DepartmentDraft } from '../../services';
import type {
  ComponentDraft, FenceUpdate, GridPatch, SiteDraft, SitePatch,
} from '../../services';
import { useCaller } from '../../services/people';

export { usePeople, useVisiblePeople } from '../../services/people';
export { useCaller };
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useExitedEmployees = () => useQuery((s) => s.employees.exited(), []);
export const useSites = () => useQuery((s) => s.config.sites(), []);
export const useUpdateFence = () =>
  useMutation((s, siteId: string, patch: FenceUpdate) => s.config.updateFence(siteId, patch));
export const useCreateSite = () =>
  useMutation((s, draft: SiteDraft) => s.config.createSite(draft));
export const useUpdateSite = () =>
  useMutation((s, siteId: string, patch: SitePatch) => s.config.updateSite(siteId, patch));
export const useSetSiteActive = () =>
  useMutation((s, siteId: string, active: boolean) => s.config.setSiteActive(siteId, active));

/* ---------- compensation ---------- */

export const useComponents = () => useQuery((s) => s.compensation.components(), []);
export const useSaveComponent = () =>
  useMutation((s, draft: ComponentDraft) => s.compensation.saveComponent(draft));
export const useRemoveComponent = () =>
  useMutation((s, code: string) => s.compensation.removeComponent(code));
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
export const useSetLeaveQuota = () =>
  useMutation((s, typeId: string, quota: number) => s.config.setLeaveQuota(typeId, quota));
export const useAddHoliday = () =>
  useMutation((s, date: string, name: string, optional: boolean) => s.config.addHoliday(date, name, optional));

/* ---------- permission narrowing ---------- */

/**
 * The permission grid: what the code grants, and what this tenant allows.
 *
 * Admin only, refused by the service rather than hidden here — a hook that
 * filtered by role would be a second, quieter copy of the policy.
 */
export const usePermissionGrid = () => {
  const c = useCaller();
  return useQuery((s) => s.config.permissions(c), [c.role, c.meId]);
};

export const useSetPermissions = () => {
  const c = useCaller();
  return useMutation((s, patches: GridPatch[]) => s.config.setPermissions(c, patches));
};

export const useResetPermissions = () => {
  const c = useCaller();
  return useMutation((s, module: string) => s.config.resetPermissions(c, module));
};

/* ---------- departments ---------- */

/*
 * The organisation structure screen rendered `DEPTS` from `src/data/org.ts` —
 * a client-side constant with no connection to the `department` table the rest
 * of the product joins against. These read and write the real thing.
 */
export const useDepartments = () => useQuery((s) => s.config.departments(), []);
export const useCreateDepartment = () =>
  useMutation((s, draft: DepartmentDraft) => s.config.createDepartment(draft));
export const useUpdateDepartment = () =>
  useMutation((s, code: string, patch: Partial<DepartmentDraft> & { active?: boolean }) =>
    s.config.updateDepartment(code, patch));
export const useRemoveDepartment = () =>
  useMutation((s, code: string) => s.config.removeDepartment(code));
