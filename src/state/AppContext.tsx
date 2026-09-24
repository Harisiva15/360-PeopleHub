import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ACCOUNTS, can, SCOPE, visibleIds } from './rbac';
import { EMAP } from '../data/employees';
import { subscribe } from '../services/react';
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
 * Adopt the signed-in person, when there is one.
 *
 * `AppProvider` seeds `role` and `meId` from `ACCOUNTS()`, which is the demo
 * dataset. That is correct for the demo build — it *is* the demo's identity,
 * and the role switcher exists to change it — and wrong the moment a real
 * session exists, where it would put a colleague from the sample data in the
 * top bar and ask for their leave.
 *
 * So in a configured build one call replaces it. `users.me()` is the server's
 * answer to "who am I and what may I reach", derived entirely from the bearer
 * token: nothing the browser sends can influence it.
 *
 * This was never a security hole. The API ignores whatever caller a request
 * claims and rebuilds it from the token — `visible(caller)` discards its
 * argument by design. What it changes is that the screen now draws the person
 * who is actually signed in.
 *
 * Deliberately not run in the demo build: `apiConfigured` is false there, the
 * call would answer from the mock, and overwriting the switcher's choice on
 * every render is the one thing that would break it.
 */
function useAdoptedIdentity(
  setRole: (r: AppRole) => void,
  setMeId: (id: string) => void,
) {
  const [identity, setIdentity] = useState<MeIdentity | null>(null);

  useEffect(() => {
    if (!apiConfigured || !authConfigured) return undefined;

    let cancelled = false;
    void (async () => {
      try {
        const { getServices } = await import('../services');
        /*
         * The caller passed here is ignored by the server, which reads the
         * token. It is supplied because the contract takes one, and the mock
         * — used by nothing in this branch — would need it.
         */
        const me = await getServices().users.me({ role: 'employee', meId: '' });
        if (cancelled || !me?.identity) return;
        setIdentity(me.identity);
        setRole(me.role);
        if (me.identity.empId) setMeId(me.identity.empId);
      } catch {
        /*
         * Left as the seed. A failure here is a network or a session problem,
         * and the gate above this has already decided there is a session — so
         * showing the shell with an unresolved name beats blanking the app.
         */
      }
    })();
    return () => { cancelled = true; };
  }, [setRole, setMeId]);

  return identity;
}

export function AppProvider({ children, initialRole = 'admin' }: { children: ReactNode; initialRole?: AppRole }) {
  const start = ACCOUNTS().find((a) => a.role === initialRole)!;
  const [role, setRole] = useState<AppRole>(start.role);
  const [meId, setMeId] = useState<string>(start.empId);
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

  const signInAs = useCallback((next: AppRole) => {
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

  const identity = useAdoptedIdentity(setRole, setMeId);

  const value = useMemo<AppState>(
    () => ({
      role,
      meId,
      me: EMAP[meId],
      identity,
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
    [role, meId, identity, theme, revision, signInAs, toggleTheme, bump, toasts, toast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
