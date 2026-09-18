/**
 * The assets screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';
import type { NewAssetRequest } from '../../services';
import type { NewAsset } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAssets = () => useQuery((s) => s.assets.list(), []);
export const useAssetKpi = () => useQuery((s) => s.assets.kpi(), []);
export const useAssetRequests = () => useQuery((s) => s.assets.requests(), []);
export const useOpenAssetRequests = () => useQuery((s) => s.assets.openRequests(), []);
export const usePendingRecovery = () => useQuery((s) => s.assets.pendingRecovery(), []);
export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useAddAsset = () =>
  useMutation((s, draft: NewAsset) => s.assets.addAsset(draft));
export const useActOnRequest = () => useMutation((s, id: string, status: string) => s.assets.actOnRequest(id, status));
export const useAllocateAsset = () => useMutation((s, assetId: string, empId: string) => s.assets.allocate(assetId, empId));
export const useMarkReturned = () => useMutation((s, assetId: string) => s.assets.markReturned(assetId));
export const useOnboardingJourneys = () => useQuery((s) => s.onboarding.list(), []);

/** The movement trail — what happened to the kit, most recent first. */
export const useAssetMovements = (limit = 12) =>
  useQuery((s) => s.assets.movements(limit), [limit]);

/** Raising a request — the approval side has always worked. */
export const useRequestAsset = () =>
  useMutation((s, draft: NewAssetRequest) => s.assets.requestAsset(draft));
