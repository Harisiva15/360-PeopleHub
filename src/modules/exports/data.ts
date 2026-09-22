/**
 * The export centre's data access.
 *
 * Every call carries the caller and the service checks it. The hooks decide
 * nothing — a hook that filtered by role would be a second, quieter copy of
 * the rules, and the two would drift.
 */

import { useMutation, useQuery } from '../../services/react';
import { useCaller } from '../../services/people';
import type { ExportFilter, ExportRequest } from '../../services';

export { useCaller, usePeople, useVisiblePeople } from '../../services/people';
export type { Directory } from '../../services/people';

const keyOf = (f: ExportFilter) =>
  [f.q, f.datasetId, f.byId, f.outcome, f.personalOnly, f.from, f.to];

/** Only the datasets this person could actually run. */
export function useDatasets() {
  const c = useCaller();
  return useQuery((s) => s.exports.datasets(c), [c.role, c.meId]);
}

export function useExportHistory(f: ExportFilter = {}) {
  const c = useCaller();
  return useQuery((s) => s.exports.history(c, f), [c.role, c.meId, ...keyOf(f)]);
}

export function useExportStats() {
  const c = useCaller();
  return useQuery((s) => s.exports.stats(c), [c.role, c.meId]);
}

export const useRunExport = () => {
  const c = useCaller();
  return useMutation((s, req: ExportRequest) => s.exports.run(c, req));
};
