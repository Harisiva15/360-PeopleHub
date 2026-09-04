/**
 * The security screens' data access.
 */

import { useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAudit = (cat?: string, sev?: string) =>
  useQuery((s) => s.security.audit(cat || undefined, (sev || undefined) as never), [cat, sev]);
export const useAuditCategories = () => useQuery((s) => s.security.auditCategories(), []);
export const usePosture = () => useQuery((s) => s.security.posture(), []);
export const useControls = () => useQuery((s) => s.security.controls(), []);
export const useRetention = () => useQuery((s) => s.security.retention(), []);
export const useAssets = () => useQuery((s) => s.assets.list(), []);
export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
