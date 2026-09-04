/**
 * The assets screens' data access.
 */

import { useMutation, useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAssets = () => useQuery((s) => s.assets.list(), []);
export const useAssetKpi = () => useQuery((s) => s.assets.kpi(), []);
export const useAssetRequests = () => useQuery((s) => s.assets.requests(), []);
export const useOpenAssetRequests = () => useQuery((s) => s.assets.openRequests(), []);
export const usePendingRecovery = () => useQuery((s) => s.assets.pendingRecovery(), []);
export const useExits = () => useQuery((s) => s.exits.list(), []);
export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useActOnRequest = () => useMutation((s, id: string, status: string) => s.assets.actOnRequest(id, status));
export const useAllocateAsset = () => useMutation((s, assetId: string, empId: string) => s.assets.allocate(assetId, empId));
export const useMarkReturned = () => useMutation((s, assetId: string) => s.assets.markReturned(assetId));
export const useOnboardingJourneys = () => useQuery((s) => s.onboarding.list(), []);
