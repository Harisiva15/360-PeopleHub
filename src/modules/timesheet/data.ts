/**
 * The timesheet screens' data access.
 *
 * Every edit — adding a line, changing hours, submitting, deciding — is a
 * service command that returns the whole sheet with its totals already
 * recomputed. The screens never add up hours themselves: a client that
 * calculates its own total will eventually disagree with the one the approver
 * sees, and the approver's is the one that matters.
 */

import { useMutation, useQuery } from '../../services/react';
import type { EntryDraft, TSStatus } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

/* ---------- reads ---------- */

export function useSheet(empId: string, weekStart: string) {
  return useQuery((s) => s.timesheet.forWeek(empId, weekStart), [empId, weekStart]);
}

export function useMySheets(empId: string) {
  return useQuery((s) => s.timesheet.list({ empIds: [empId] }), [empId]);
}

export function useSheets(
  empIds: string[],
  opts: { weekStart?: string; since?: string; status?: TSStatus } = {},
) {
  const key = empIds.join(',');
  return useQuery(
    (s) => s.timesheet.list({ empIds, ...opts }),
    [key, opts.weekStart, opts.since, opts.status],
  );
}

/**
 * The projects work can be booked against.
 *
 * This used to call `planner.board()`, which returns `BoardStats[]` — status,
 * count, estimate — and is not a project list at all. Nothing consumed it, so
 * every picker read the static array in `src/data/org.ts` instead, while
 * `addEntry` validated the code against the `project` table. The two agreed by
 * luck rather than construction.
 */
export const useProjects = () => useQuery((s) => s.timesheet.projects(), []);

/** Only an active project may be booked against — the same rule the server applies. */
export function useBookableProjects() {
  const { data, loading, error, refetch } = useProjects();
  return {
    all: data ?? [],
    list: (data ?? []).filter((p) => p.active),
    byId: (id: string | null | undefined) => (data ?? []).find((p) => p.id === id),
    name: (id: string | null | undefined) =>
      (data ?? []).find((p) => p.id === id)?.name ?? id ?? '—',
    loading,
    error,
    refetch,
  };
}

/* ---------- writes ---------- */

export const useAddEntry = () =>
  useMutation((s, id: string, draft: EntryDraft) => s.timesheet.addEntry(id, draft));
export const useUpdateEntry = () =>
  useMutation((s, id: string, entryId: string, patch: Partial<EntryDraft>) =>
    s.timesheet.updateEntry(id, entryId, patch));
export const useRemoveEntry = () =>
  useMutation((s, id: string, entryId: string) => s.timesheet.removeEntry(id, entryId));

export const useSetComment = () =>
  useMutation((s, id: string, note: string) => s.timesheet.setComment(id, note));
export const useCopyPreviousWeek = () =>
  useMutation((s, id: string) => s.timesheet.copyPreviousWeek(id));

export const useSubmitSheet = () => useMutation((s, id: string) => s.timesheet.submit(id));
export const useRecallSheet = () => useMutation((s, id: string) => s.timesheet.recall(id));

/** Approve, return for correction, or refuse. The approver is the session. */
export const useDecideSheet = () =>
  useMutation((s, id: string, decision: 'Approved' | 'Returned' | 'Rejected', note?: string) =>
    s.timesheet.decide(id, decision, note));
