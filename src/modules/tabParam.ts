/**
 * The tab a link asked for.
 *
 * "My Team → Leave" and "Me → Leave" are the same page opened at different
 * tabs, so the sidebar needs a way to say which — otherwise a manager lands on
 * their own leave and has to find the team view themselves every time.
 *
 * Read once, as the initial state. A tab is stateful after that: clicking
 * about the page should not be undone by the URL it was opened from.
 *
 * ## It was reading the wrong place
 *
 * This read `window.location.search`, and the app mounts a `HashRouter`. Under
 * a hash URL the query lives inside the fragment — for
 * `https://host/#/users?v=signins`, `location.search` is `''` and
 * `location.hash` is `'#/users?v=signins'` — so `get('v')` was always null and
 * **no link has ever opened a tab**. Every menu item naming a tab, which is
 * about half of them (Login history, Audit log, Leave approvals, Team
 * timesheets, Payroll inputs…), landed on its page's default tab instead.
 *
 * It reads the router's own location now. React Router parses the fragment for
 * us, so `pathname` and `search` are what the URL meant rather than what the
 * browser puts where.
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';

export function useTabFromUrl<T extends string>(fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const { search } = useLocation();
  const [tab, setTab] = useState<T>(() => {
    try {
      const asked = new URLSearchParams(search).get('v') as T | null;
      /* An unknown tab in a stale bookmark falls back rather than blanking. */
      return asked && allowed.includes(asked) ? asked : fallback;
    } catch {
      return fallback;
    }
  });
  return [tab, setTab];
}
