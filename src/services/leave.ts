/**
 * Approved leave as a range read, shared by every screen that shows one.
 *
 * Three modules needed the same call the moment Phase 2h-I gave the attendance
 * view a leave channel — the attendance screens, the rota, and now the dashboard
 * month calendar. Each had its own copy of this one line, which is three places
 * for the status filter to drift out of agreement. It lives here instead, beside
 * `people.ts` and `sites.ts`, which is where this repository keeps data access
 * more than one module shares.
 *
 * **Approved only, and that is not cosmetic.** Pending leave is a request nobody
 * has granted, rejected leave never was, and cancelled leave no longer is.
 * Showing any of them as leave on a calendar would tell somebody they are
 * entitled to be away when they are not. `leaveOn` in the attendance day model
 * filters again on the way in, so a caller who forgets the status here still
 * cannot leak one onto a screen — two independent filters for one rule, because
 * the rule is about what somebody is allowed to do with their day.
 *
 * Scope is the service's, unchanged: an employee sees their own leave, a manager
 * their line, an admin anybody. Passing `empIds` narrows that and never widens
 * it.
 */

import { useQuery } from './react';

/**
 * Approved leave overlapping `from`..`to`, inclusive at both ends.
 *
 * Overlap rather than containment, matching the service: a request that began
 * before the window and runs into it belongs in the answer, and is exactly the
 * leave somebody looking at a month most needs to see.
 */
export const useApprovedLeave = (empIds: string[], from: string, to: string) =>
  useQuery((s) => s.leave.list({ empIds, from, to, status: 'Approved' }),
    [empIds.join(','), from, to]);
