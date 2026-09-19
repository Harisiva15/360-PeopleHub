/**
 * Pinned views, remembered per browser.
 *
 * Deliberately not a service call. A favourite is a preference about this
 * person's own menu on this machine — it does not belong in the tenant's
 * database, it does not need to survive a device change, and putting it behind
 * the API would mean a network round trip before the sidebar could render.
 *
 * Capped, because a favourites list long enough to need scanning is no faster
 * than the menu it shortcuts.
 */

import { useCallback, useState } from 'react';

const KEY = 'nav.favourites';
const MAX = 6;

export interface Favourite {
  /** The full href, tab and all — two tabs of one module are two favourites. */
  href: string;
  n: string;
}

function read(): Favourite[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /* Anything stored by an older shape is discarded rather than rendered. */
    return parsed
      .filter((f): f is Favourite =>
        !!f && typeof (f as Favourite).href === 'string' && typeof (f as Favourite).n === 'string')
      .slice(0, MAX);
  } catch {
    /* A private window has no storage. The menu simply has no favourites. */
    return [];
  }
}

export function useFavourites() {
  const [favourites, setFavourites] = useState<Favourite[]>(read);

  const write = useCallback((next: Favourite[]) => {
    setFavourites(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* fine */ }
  }, []);

  const isFavourite = useCallback(
    (href: string) => favourites.some((f) => f.href === href),
    [favourites],
  );

  const toggleFavourite = useCallback((f: Favourite) => {
    const without = favourites.filter((x) => x.href !== f.href);
    /* Newest first, and the oldest falls off the end rather than being refused. */
    write(without.length === favourites.length ? [f, ...favourites].slice(0, MAX) : without);
  }, [favourites, write]);

  return { favourites, isFavourite, toggleFavourite };
}
