/**
 * The tab a link asked for.
 *
 * "My Team → Leave" and "Me → Leave" are the same page opened at different
 * tabs, so the sidebar needs a way to say which — otherwise a manager lands on
 * their own leave and has to find the team view themselves every time.
 *
 * Read once, as the initial state. A tab is stateful after that: clicking
 * about the page should not be undone by the URL it was opened from.
 */
import { useState } from 'react';

export function useTabFromUrl<T extends string>(fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [tab, setTab] = useState<T>(() => {
    try {
      const asked = new URLSearchParams(window.location.search).get('v') as T | null;
      /* An unknown tab in a stale bookmark falls back rather than blanking. */
      return asked && allowed.includes(asked) ? asked : fallback;
    } catch {
      return fallback;
    }
  });
  return [tab, setTab];
}
