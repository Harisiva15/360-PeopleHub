/**
 * The security screens' data access.
 */

import { useQuery } from '../../services/react';
import { unbacked } from '../../services/unbacked';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAudit = (cat?: string, sev?: string) =>
  useQuery((s) => s.security.audit(cat || undefined, (sev || undefined) as never), [cat, sev]);
export const useAuditCategories = () => useQuery((s) => s.security.auditCategories(), []);
/**
 * Device and identity posture.
 *
 * The one read on this screen with nothing behind it: it reports whether each
 * person's device has a second factor, is managed, encrypted and patched, and
 * this system has no MDM, no identity-provider feed and no agent. A fabricated
 * "94% encrypted" on a security page is a false assurance somebody repeats to
 * a client, so a configured build shows nothing rather than something
 * reassuring and invented.
 */
export const usePosture = () => useQuery(unbacked((s) => s.security.posture(), []), []);
export const useControls = () => useQuery((s) => s.security.controls(), []);
export const useRetention = () => useQuery((s) => s.security.retention(), []);
export const useAssets = () => useQuery((s) => s.assets.list(), []);
export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
