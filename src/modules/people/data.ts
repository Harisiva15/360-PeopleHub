/**
 * The people screens' data access — org chart, celebrations and the
 * noticeboard. All reads: this is the part of the app everyone can see.
 */

import { useMutation, useQuery } from '../../services/react';
import type { NewAnnouncement } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useTeam = (managerId: string) => useQuery((s) => s.employees.team(managerId, true), [managerId]);
export const useAnnouncements = () => useQuery((s) => s.noticeboard.announcements(), []);
export const useCelebrations = (days: number) => useQuery((s) => s.noticeboard.celebrations(days), [days]);

/**
 * Open positions, for the chart's headline count.
 *
 * Requisitions are recruiter-and-above, so this returns an empty list for an
 * employee and the tile reads zero — which is correct for them rather than a
 * gap: it is not a number they are shown.
 */
export const useRequisitions = () => useQuery((s) => s.hiring.requisitions(), []);

/** Posting is managers and admins only; the service enforces it. */
export const usePostAnnouncement = () =>
  useMutation((s, draft: NewAnnouncement) => s.noticeboard.post(draft));

export const useSetPinned = () =>
  useMutation((s, id: string, pinned: boolean) => s.noticeboard.setPinned(id, pinned));
export const useRemoveAnnouncement = () =>
  useMutation((s, id: string) => s.noticeboard.remove(id));
