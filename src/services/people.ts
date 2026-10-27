/**
 * Directory access, shared by every migrated module.
 *
 * Rows come back referencing people by id, so screens need a way to resolve
 * those to names and avatars. Rather than each module reaching for the
 * dataset, they fetch the set they need through the employee service and look
 * up locally — which is what a client does when the API does not denormalise
 * names into the row.
 */

import { useMemo } from 'react';
import { useQuery } from './react';
import type { Caller, Employee } from './contracts';
import { useApp } from '../state/AppContext';

/** The identity every scoped read is made on behalf of. */
export function useCaller(): Caller {
  const app = useApp();
  return useMemo(() => ({ role: app.role, meId: app.meId }), [app.role, app.meId]);
}

export interface Directory {
  list: Employee[];
  ids: string[];
  byId: (id: string | null | undefined) => Employee | undefined;
  name: (id: string | null | undefined) => string;
  loading: boolean;
  /**
   * The read failed, as against answering that there is nobody.
   *
   * `list` was the only thing this carried, and an empty one meant both — a
   * tenant with no matching people, and a request that never arrived. Every
   * caller treated it as the first, so a failure rendered as a working screen
   * reporting nothing, which is the one outcome nobody files a bug against.
   *
   * Separating them is what lets a screen say "this did not load" and offer
   * `retry`, instead of quietly lying about the company being empty.
   */
  failed: boolean;
  /** What went wrong, for a screen that wants to show the reason. */
  error: Error | null;
  /** Ask again. Safe to call from a button; it re-runs the same read. */
  retry: () => void;
}

/** Exported for the check, which asserts failed-vs-empty directly. */
export function toDirectory(
  list: Employee[] | undefined,
  loading: boolean,
  error: Error | null,
  retry: () => void,
): Directory {
  const rows = list ?? [];
  const map = new Map(rows.map((e) => [e.id, e]));
  return {
    list: rows,
    ids: rows.map((e) => e.id),
    byId: (id) => (id ? map.get(id) : undefined),
    name: (id) => (id ? map.get(id)?.name ?? '—' : '—'),
    loading,
    /* Failed only when there is nothing to show *and* something went wrong.
       A refetch that fails while previous rows are still on screen is not a
       failed directory — the screen has data, and blanking it to show an
       error would be a regression on what the person can see. */
    failed: Boolean(error) && rows.length === 0,
    error,
    retry,
  };
}

/** Everyone the signed-in user may see, already scoped by the service. */
export function useVisiblePeople(): Directory {
  const caller = useCaller();
  const { data, loading, error, refetch } = useQuery(
    (s) => s.employees.visible(caller),
    [caller.role, caller.meId],
  );
  return useMemo(
    () => toDirectory(data, loading, error, refetch),
    [data, loading, error, refetch],
  );
}

/** Resolve a specific set of people — the ids that rows refer to. */
export function usePeople(ids: (string | null | undefined)[]): Directory {
  const key = ids.filter(Boolean).sort().join(',');
  const wanted = useMemo(() => Array.from(new Set(key ? key.split(',') : [])), [key]);
  const { data, loading, error, refetch } = useQuery((s) => s.employees.byIds(wanted), [key]);
  return useMemo(
    () => toDirectory(data, loading, error, refetch),
    [data, loading, error, refetch],
  );
}
