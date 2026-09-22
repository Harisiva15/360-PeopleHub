/**
 * The custom-report screens' data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { ReportDraft } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

export function useReports() {
  const c = useCaller();
  return useQuery((s) => s.reports.list(c), [c.role, c.meId]);
}

/** What a report can be built on — the export catalogue, filtered by role. */
export function useReportDatasets() {
  const c = useCaller();
  return useQuery((s) => s.reports.datasets(c), [c.role, c.meId]);
}

/**
 * Running a report is a mutation, not a query.
 *
 * It bumps the run count and the last-run date, and — more to the point — it
 * should happen when somebody asks for it rather than whenever a component
 * re-renders. A `useQuery` here would run every shared report on mount.
 */
export const useRunReport = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.reports.run(c, id));
};

export const useCreateReport = () => {
  const c = useCaller();
  return useMutation((s, draft: ReportDraft) => s.reports.create(c, draft));
};

export const useUpdateReport = () => {
  const c = useCaller();
  return useMutation((s, id: string, patch: Partial<ReportDraft>) =>
    s.reports.update(c, id, patch));
};

export const useRemoveReport = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.reports.remove(c, id));
};

export const useDuplicateReport = () => {
  const c = useCaller();
  return useMutation((s, id: string) => s.reports.duplicate(c, id));
};
