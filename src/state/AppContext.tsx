import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ACCOUNTS, can, SCOPE, visibleIds } from './rbac';
import { EMAP } from '../data/employees';
import { onQueryFailure, subscribe } from '../services/react';
import { apiConfigured } from '../services/http';
import { authConfigured } from '../auth/supabase';
import type { MeIdentity } from '../services';
import type { AppRole, Employee } from '../types/employee';

export type Theme = 'light' | 'dark';

export interface Toast {
  id: number;
  msg: string;
  kind?: 'ok' | 'err';
}

interface AppState {
  role: AppRole;
  meId: string;
  me: Employee;
  /**
   * The signed-in person as the server reports them, or null in a build with
   * no authentication. Screens that show who you are should prefer this: `me`
   * is the demo dataset's row and exists for the demo build.
   */
  identity: MeIdentity | null;
  /**
   * Whether `role`, `meId` and `me` are the server's answer yet.
   *
   * Always true in the demo build, where the dataset *is* the identity. In API
   * mode it is false until `/me` and the caller's own employee row are both
   * in, and `AuthGate` renders nothing while it is — a screen that queries on
   * mount with a provisional id is how demo codes reached the real database.
   */
  identityReady: boolean;
  /** Why the identity could not be established, if it could not. */
  identityError: string | null;
  retryIdentity: () => void;
  theme: Theme;
  /** Bumped by `bump()` to re-render views after the mutable dataset changes. */
  revision: number;

  signInAs: (role: AppRole) => void;
  toggleTheme: () => void;
  /** Call after mutating the dataset so dependent views recompute. */
  bump: () => void;

  can: (route: string) => boolean;
  scope: (typeof SCOPE)[AppRole];

  isMyReport: (id: string) => boolean;

  toasts: Toast[];
  toast: (msg: string, kind?: 'ok' | 'err') => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppState | null>(null);

const THEME_KEY = '360people.theme';

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

let toastSeq = 0;


/**
 * Whether this build talks to the API, or to the in-memory dataset.
 *
 * Both halves matter. `apiConfigured` decides where the 326 service methods
 * send their reads; `authConfigured` decides whether there is a session to send
 * them on behalf of. A build with one and not the other is a misconfiguration
 * rather than a mode, and treating it as the demo is the safe reading.
 */
const apiMode = apiConfigured && authConfigured;

/**
 * Resolve the signed-in person, from the server and only from the server.
 *
 * ## The bug this shape exists for
 *
 * `AppProvider` used to seed `role` and `meId` from `ACCOUNTS()` — the demo
 * dataset — and this hook replaced them *after* a round trip. That is one
 * render with `meId = 'E008'` (the demo HR head) and `me = EMAP['E008']`, whose
 * `managerId` is `'E001'`. Screens query on mount, so those went to the real
 * API, and Postgres said what it should have:
 *
 *     22P02  invalid input syntax for type uuid: "E008"
 *     22P02  invalid input syntax for type uuid: "E001"
 *
 * every single time anybody signed in. `expenses/index.tsx` sent both in one
 * call, from `usePeople([app.meId, app.me.managerId])`.
 *
 * The second half was worse and quieter: once this hook *did* resolve, `meId`
 * became a real uuid, and `me` was still `EMAP[meId]` — a lookup into the demo
 * map, which has no such key. `me` was therefore `undefined` while the type
 * said `Employee`, so every `app.me.managerId` on a signed-in screen was a
 * TypeError waiting for somebody to open Leave, Expenses or Attendance.
 *
 * ## What it does instead
 *
 * Two calls, both the server's: `users.me()` for who you are and what you may
 * reach, then `employees.byIds([empId])` for your own employee row. The second
 * is what makes `app.me` real — the screens read `managerId`, `name`, `code`,
 * `designation` and `ctc` off it, and a record composed here from the identity
 * alone would have had to invent the last of those.
 *
 * Nothing is seeded from `src/data` in this mode, not even provisionally, and
 * `ready` stays false until both answers are in — so no screen ever renders
 * holding a provisional id. That is the actual fix; the guard in the HTTP layer
 * is the net under it.
 *
 * Deliberately inert in the demo build, where `ACCOUNTS()` *is* the identity
 * and the role switcher exists to change it.
 */
function useResolvedIdentity(
  setRole: (r: AppRole) => void,
  setMeId: (id: string) => void,
): {
  identity: MeIdentity | null;
  me: Employee | null;
  ready: boolean;
  error: string | null;
  retry: () => void;
} {
  const [identity, setIdentity] = useState<MeIdentity | null>(null);
  const [me, setMe] = useState<Employee | null>(null);
  const [ready, setReady] = useState(!apiMode);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!apiMode) return undefined;

    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const { getServices } = await import('../services');
        const s = getServices();
        /*
         * The caller passed here is ignored by the server, which reads the
         * token. It is supplied because the contract takes one.
         */
        const who = await s.users.me({ role: 'employee', meId: '' });
        if (cancelled) return;
        if (!who?.identity) throw new Error('The server did not say who you are.');

        const empId = who.identity.empId;
        /*
         * An account with no employee row is a real state — an invitation
         * claimed before the record was linked — and it is not something to
         * guess around. Say so rather than rendering screens that will ask for
         * "my" leave with no id to ask about.
         */
        if (!empId) {
          throw new Error(
            'Your account is not linked to an employee record yet. '
            + 'Ask your HR administrator to finish setting it up.');
        }

        const rows = await s.employees.byIds([empId]);
        if (cancelled) return;
        const row = rows.find((e) => e.id === empId) ?? null;
        if (!row) throw new Error('Your employee record could not be read.');

        setIdentity(who.identity);
        setRole(who.role);
        setMeId(empId);
        setMe(row);
        setReady(true);
      } catch (e) {
        if (cancelled) return;
        /*
         * Not swallowed, and not fallen back to the demo row. Falling back is
         * what sent E008 to the database; showing the shell with somebody
         * else's identity is worse than showing why it stopped.
         */
        setError(e instanceof Error ? e.message : 'Could not establish who you are.');
      }
    })();
    return () => { cancelled = true; };
  }, [setRole, setMeId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { identity, me, ready, error, retry };
}

export function AppProvider({ children, initialRole = 'admin' }: { children: ReactNode; initialRole?: AppRole }) {
  const start = ACCOUNTS().find((a) => a.role === initialRole)!;
  /*
   * In API mode neither of these is seeded from the demo dataset — not even
   * for the one render before the server answers, because that render is
   * exactly what sent `E008` and `E001` to Postgres. `role` starts at the
   * least privilege rather than at `initialRole`, so if anything ever did slip
   * past the gate below it would show too little rather than too much.
   */
  const [role, setRole] = useState<AppRole>(apiMode ? 'employee' : start.role);
  const [meId, setMeId] = useState<string>(apiMode ? '' : start.empId);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [revision, setRevision] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode — the theme just will not persist */
    }
  }, [theme]);

  const bump = useCallback(() => setRevision((r) => r + 1), []);

  /* Screens still reading the dataset directly need a nudge when a service
     mutation changes it. Removable once every module is on the service layer. */
  useEffect(() => subscribe(bump), [bump]);

  /*
   * Say so when a read fails.
   *
   * 366 of the 384 query call sites in src/modules destructure only `data`,
   * with a default of `[]` or `0`. Without this, a 403, a 500 or a dropped
   * connection renders as a working screen reporting nothing to show, which is
   * why the demo-id defect survived in production: every sign-in failed and the
   * app looked merely empty.
   *
   * A toast, not a takeover: one failed panel should not remove a page that is
   * otherwise working. De-duplicated by message, because a screen mounting ten
   * queries against a server that is down should say one thing, ten times over.
   */
  useEffect(() => onQueryFailure(({ message }) => {
    const id = ++toastSeq;
    setToasts((ts) => (ts.some((t) => t.msg === message)
      ? ts
      : [...ts, { id, msg: message, kind: 'err' as const }]));
    /*
     * Longer than the 2.8s a confirmation gets. Something went wrong and the
     * sentence is worth reading — but it still goes, because a toast that never
     * leaves becomes furniture, and ten of them stack into a wall.
     */
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }), []);

  /*
   * The demo build's role switcher. It picks a person out of the sample data,
   * which is the one thing that must never happen against a real tenant — so
   * it refuses in API mode rather than relying on the switcher being hidden
   * there. The UI already hides it; this makes the function itself safe.
   */
  const signInAs = useCallback((next: AppRole) => {
    if (apiMode) return;
    const acc = ACCOUNTS().find((a) => a.role === next);
    if (!acc) return;
    setRole(acc.role);
    setMeId(acc.empId);
  }, []);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), []);

  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (msg: string, kind?: 'ok' | 'err') => {
      const id = ++toastSeq;
      setToasts((ts) => [...ts, { id, msg, kind }]);
      setTimeout(() => dismissToast(id), 2800);
    },
    [dismissToast],
  );

  const resolved = useResolvedIdentity(setRole, setMeId);
  const { identity } = resolved;

  /*
   * In API mode this is the employee row the server returned for the signed-in
   * person. It was `EMAP[meId]` for both modes, which in API mode is a lookup
   * into the demo map by a real uuid — `undefined`, typed as `Employee`.
   */
  const me = apiMode ? resolved.me : EMAP[meId];

  const value = useMemo<AppState>(
    () => ({
      role,
      meId,
      me: me as Employee,
      identity,
      identityReady: resolved.ready,
      identityError: resolved.error,
      retryIdentity: resolved.retry,
      theme,
      revision,
      signInAs,
      toggleTheme,
      bump,
      can: (route: string) => can(role, route),
      scope: SCOPE[role],
      isMyReport: (id: string) => role !== 'employee' && visibleIds(role, meId).includes(id) && id !== meId,
      toasts,
      toast,
      dismissToast,
    }),
    [role, meId, me, identity, resolved.ready, resolved.error, resolved.retry,
      theme, revision, signInAs, toggleTheme, bump, toasts, toast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
