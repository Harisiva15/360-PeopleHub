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
import { isHiddenTab } from '../nav';

export function useTabFromUrl<T extends string>(fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const { pathname, search } = useLocation();
  const [tab, setTab] = useState<T>(() => {
    try {
      const route = pathname.replace(/^\//, '').split('?')[0] ?? '';

      /*
       * ## The fallback has to be in scope too
       *
       * Refusing a hidden tab that was *asked for* was only half of it. Where
       * a page's own default is hidden, every path led straight back to it:
       *
       *   payroll  `useTabFromUrl(tabs[0].v, …)`, and tabs[0] is `runs`
       *   planner  `useTabFromUrl('board', …)`, and `planner:board` is hidden
       *
       * So `/#/payroll` opened the draft payroll run — the screen the launch
       * scope exists to close, with this month's gross and net on it — and
       * `?v=inputs` "fell back" to it rather than away from it. `Tabs` had
       * already dropped the button, so the strip showed three tabs with none
       * selected and no way to leave.
       *
       * The fallback is now the first tab in scope, in the order the page
       * lists them. If a page declares no visible tab at all the original
       * stands, because there is nothing to prefer — and a route in that
       * state belongs in `HIDDEN_ROUTES`, not here.
       */
      const safe = isHiddenTab(route, fallback)
        ? (allowed.find((v) => !isHiddenTab(route, v)) ?? fallback)
        : fallback;

      const asked = new URLSearchParams(search).get('v') as T | null;
      if (!asked) return safe;
      /*
       * A tab that is out of scope for go-live is treated exactly like an
       * unknown one. Payroll keeps five of those — processing, inputs, the
       * register, disbursal, statutory — and `?v=inputs` in a bookmark lands
       * on the first tab in scope rather than the parked screen.
       */
      if (isHiddenTab(route, asked)) return safe;
      /* An unknown tab in a stale bookmark falls back rather than blanking. */
      return allowed.includes(asked) ? asked : safe;
    } catch {
      return fallback;
    }
  });
  return [tab, setTab];
}
