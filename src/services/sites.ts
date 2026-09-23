/**
 * The company's locations, as the server holds them.
 *
 * `src/data/org.ts` carries a `SITES` table, and for a screen that only needs
 * to print a city next to a name it is fine. A form is different: it does not
 * describe a location, it *chooses* one, and the choice is then sent to an API
 * that will refuse a code it has never heard of.
 *
 * The two lists had already drifted. The static table offered Dallas and
 * Toronto, which this company does not operate, and did not offer Pune, which
 * it does — so the one office a new joiner might actually be posted to was the
 * one the form could not name, and two of the options it did offer would have
 * been rejected on submit with nothing on screen to explain why.
 *
 * A form reads from here. A demo build still works, because the mock service
 * answers `config.sites()` from the same static table — the difference is only
 * which source is authoritative, and it is the one that will accept the answer.
 */

import { useMemo } from 'react';
import { useQuery } from './react';
import type { Site } from '../types/org';

export interface SiteList {
  /**
   * The open locations — what a form may offer.
   *
   * A closed office is deliberately absent. Somebody cannot be posted to a
   * building the company has given up, and offering it would put a code into a
   * record that no later screen should have to explain.
   */
  list: Site[];
  /** Every location, closed ones included. For administration and lookups. */
  all: Site[];
  /** The ones somebody can be posted to — offices, not ways of working. */
  offices: Site[];
  byId: (id: string | null | undefined) => Site | undefined;
  /** The site's name, or an em dash. Never the raw code, and never a dash for
   *  a location that merely closed — those still resolve. */
  name: (id: string | null | undefined) => string;
  /** Head office, if one is nominated. At most one exists (0044). */
  headquarters: Site | undefined;
  loading: boolean;
}

/**
 * Every location a form may offer.
 *
 * Deliberately unfiltered by role: a location is not sensitive, and the screens
 * that can reach a form at all have already been gated by the route.
 */
export function useSites(): SiteList {
  const { data, loading } = useQuery((s) => s.config.sites(), []);
  return useMemo(() => {
    const all = data ?? [];
    /* Absent means open: the demo table predates the column. */
    const open = all.filter((s) => s.active !== false);
    const map = new Map(all.map((s) => [s.id, s]));
    return {
      list: open,
      all,
      offices: open.filter((s) => !s.remote),
      byId: (id) => (id ? map.get(id) : undefined),
      name: (id) => (id ? map.get(id)?.name ?? '—' : '—'),
      headquarters: open.find((s) => s.headquarters),
      loading,
    };
  }, [data, loading]);
}
