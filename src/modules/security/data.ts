/**
 * The security screens' data access.
 */

import { useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAudit = (cat?: string, sev?: string) =>
  useQuery((s) => s.security.audit(cat || undefined, (sev || undefined) as never), [cat, sev]);
export const useAuditCategories = () => useQuery((s) => s.security.auditCategories(), []);
/*
 * There was a `usePosture` here, over a `security.posture` service method that
 * reported whether each person's device had a second factor, was managed,
 * encrypted and patched. It has been removed rather than left unused.
 *
 * It was wrong in both builds and differently in each. On the mock the values
 * came from a seeded random draw, so the screen read "MFA enrolled 88%,
 * disk encrypted 94%". Wrapped in `unbacked`, a configured build returned an
 * empty list instead, so the same tiles read 0% — a security page telling an
 * administrator that nothing is encrypted. One number was falsely reassuring
 * and the other falsely alarming; neither was measured.
 *
 * What replaces it is in ./measured.ts, which derives the one fact this
 * product owns — the method recorded on each sign-in. Device state has no
 * function there, because nothing here can see a device.
 */
export const useControls = () => useQuery((s) => s.security.controls(), []);
export const useRetention = () => useQuery((s) => s.security.retention(), []);
export const useAssets = () => useQuery((s) => s.assets.list(), []);
export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
