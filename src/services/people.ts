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
}

function toDirectory(list: Employee[] | undefined, loading: boolean): Directory {
  const rows = list ?? [];
  const map = new Map(rows.map((e) => [e.id, e]));
  return {
    list: rows,
    ids: rows.map((e) => e.id),
    byId: (id) => (id ? map.get(id) : undefined),
    name: (id) => (id ? map.get(id)?.name ?? '—' : '—'),
    loading,
  };
}

/** Everyone the signed-in user may see, already scoped by the service. */
export function useVisiblePeople(): Directory {
  const caller = useCaller();
  const { data, loading } = useQuery((s) => s.employees.visible(caller), [caller.role, caller.meId]);
  return useMemo(() => toDirectory(data, loading), [data, loading]);
}

/** Resolve a specific set of people — the ids that rows refer to. */
export function usePeople(ids: (string | null | undefined)[]): Directory {
  const key = ids.filter(Boolean).sort().join(',');
  const wanted = useMemo(() => Array.from(new Set(key ? key.split(',') : [])), [key]);
  const { data, loading } = useQuery((s) => s.employees.byIds(wanted), [key]);
  return useMemo(() => toDirectory(data, loading), [data, loading]);
}
