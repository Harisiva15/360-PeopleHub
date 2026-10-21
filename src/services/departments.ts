/**
 * The organisation's departments, as the server holds them.
 *
 * The companion to `./sites.ts`, and it exists for the same reason. A screen
 * that only prints a department name beside a person can read the static
 * `DEPTS` table in `src/data/org.ts` and be right often enough. A *form* is
 * different: it does not describe a department, it **chooses** one, and the
 * choice is then sent to an API that resolves it with
 *
 *     SELECT id FROM department WHERE code = $1
 *
 * and refuses a code it has never heard of.
 *
 * The two lists had already drifted, in both directions. The static table
 * offers departments this tenant has never created, and does not offer the two
 * it has added since — so the only honest answer a form can give is the one it
 * asks the server for.
 *
 * A demo build still works, because the mock service answers
 * `config.departments()` from the same static table. The difference is only
 * which source is authoritative, and it is the one that will accept the answer.
 */

import { useMemo } from 'react';
import { useQuery } from './react';
import type { Department } from './contracts';

export interface DepartmentList {
  /**
   * The departments a form may offer — the active ones.
   *
   * A retired department is deliberately absent. Nobody can be hired into one
   * the company has closed, and offering it would put a code into a record
   * that no later screen should have to explain.
   */
  list: Department[];
  /** Every department, retired ones included. For administration and lookups. */
  all: Department[];
  /**
   * By code, not by id. `UserAccount.dept` carries the code, because that is
   * what the server resolves against — see the query in the header.
   */
  byCode: (code: string | null | undefined) => Department | undefined;
  /**
   * The department's name, or an em dash. Never the raw code, and never a dash
   * for one that merely closed — those still resolve.
   */
  name: (code: string | null | undefined) => string;
  loading: boolean;
}

/**
 * Every department a form may offer.
 *
 * Deliberately unfiltered by role: a department name is not sensitive, and any
 * screen that can reach a form has already been gated by the route.
 */
export function useDepartments(): DepartmentList {
  const { data, loading } = useQuery((s) => s.config.departments(), []);
  return useMemo(() => {
    const all = data ?? [];
    /* Absent means active: the demo table predates the column. */
    const open = all.filter((d) => d.active !== false);
    const map = new Map(all.map((d) => [d.code, d]));
    return {
      list: open,
      all,
      byCode: (code) => (code ? map.get(code) : undefined),
      name: (code) => (code ? map.get(code)?.name ?? '—' : '—'),
      loading,
    };
  }, [data, loading]);
}
