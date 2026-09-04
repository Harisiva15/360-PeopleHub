/**
 * The people screens' data access — org chart, celebrations and the
 * noticeboard. All reads: this is the part of the app everyone can see.
 */

import { useQuery } from '../../services/react';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export const useAllEmployees = () => useQuery((s) => s.employees.active(), []);
export const useTeam = (managerId: string) => useQuery((s) => s.employees.team(managerId, true), [managerId]);
export const useAnnouncements = () => useQuery((s) => s.noticeboard.announcements(), []);
export const useCelebrations = (days: number) => useQuery((s) => s.noticeboard.celebrations(days), [days]);
