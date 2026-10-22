import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ACCOUNTS, can, covers, hasReportsFromRules, isAppRole, SCOPE, scopeOfDemo, visibleIds,
} from './rbac';
import type { RuleScopes, Scope } from './rbac';
import { EMAP, teamOf } from '../data/employees';
import { onQueryFailure, subscribe } from '../services/react';
import { apiConfigured } from '../services/http';
import { authConfigured } from '../auth/supabase';
import { useAuth } from '../auth/AuthContext';
import {
  IDENTITY_START, identityFailure, identityOnPlan, identityOnSettled, identityPlan,
} from './identity';
import type { MeIdentity } from '../services';
import type { AppRole, Employee } from '../types/employee';

export type Theme = 'light' | 'dark';

export interface Toast {
  id: number;
  msg: string;
  kind?: 'ok' | 'err';
}

/** The module list and per-module scopes as `/me/permissions` reported them. */
export interface ServerAccess {
  modules: string[];
  rules: Record<string, RuleScopes>;
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
  /**
   * True when there is no usable session. The gate shows the sign-in screen
   * for this rather than the identity error, which was a dead end for anybody
   * whose session had simply expired.
   */
  identitySessionLost: boolean;
  retryIdentity: () => void;
  theme: Theme;
  /** Bumped by `bump()` to re-render views after the mutable dataset changes. */
  revision: number;

  signInAs: (role: AppRole, empId?: string) => void;
  toggleTheme: () => void;
  /** Call after mutating the dataset so dependent views recompute. */
  bump: () => void;

  can: (route: string) => boolean;
  scope: (typeof SCOPE)[AppRole];
  /**
   * Whether this person answers for anybody, read back out of the scopes the
   * server sent. Not a role: see hasReportsFromRules.
   */
  hasReports: boolean;
  /**
   * How wide this person is on one module and one verb, as the server said.
   * Unknown modules answer 'none', so a module nobody has classified is not
   * readable by accident.
   */
scopeOf: (module: string, verb: 'read' | 'write' | 'approve') => Scope;
  /**
   * Does this person reach `needed` on this module and verb?
   *
   * The question nearly every screen actually wants. `role === 'admin'` was
   * standing in for it, which is why hr_admin and finance_admin would have
   * been locked out of their own modules by a mechanical rename.
   */
  reaches: (module: string, verb: 'read' | 'write' | 'approve', needed: Scope) => boolean;

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
  authReady: boolean,
  accessToken: string | null,
): {
  identity: MeIdentity | null;
  me: Employee | null;
  /** The module list and scopes the server granted, or null before it answers. */
  access: ServerAccess | null;
  /** True when there is no usable session, so the gate shows sign-in. */
  sessionLost: boolean;
  ready: boolean;
  error: string | null;
  retry: () => void;
} {
  const [identity, setIdentity] = useState<MeIdentity | null>(null);
  /*
   * What the server granted, kept rather than discarded.
   *
   * `/me/permissions` answers with the module list and the per-module scopes
   * it computed from the policy, the reporting tree and the tenant's
   * narrowing. All three were being thrown away and the UI was re-deciding
   * from the role alone - which cannot see the reporting tree at all, so a
   * manager got an employee's menu.
   */
  const [access, setAccess] = useState<ServerAccess | null>(null);
  const [me, setMe] = useState<Employee | null>(null);
  /*
   * One piece of state, moved by the two transitions in ./identity.
   *
   * It was three setters called from five places, and whether the application
   * stayed mounted through an hourly token refresh depended on which of them a
   * given path happened not to call. That is not a property worth leaving to
   * the shape of an effect, so it is a function with assertions on it.
   */
  const [state, setState] = useState(apiMode ? IDENTITY_START : { ...IDENTITY_START, ready: true });
  const [attempt, setAttempt] = useState(0);
  /*
   * The token the current answer belongs to.
   *
   * A ref rather than state: it is read inside the effect to decide whether to
   * ask again, and putting it in the dependency list would re-run the effect
   * with the value it had just written.
   */
  const resolvedFor = useRef<string | null>(null);

  useEffect(() => {
    const plan = identityPlan({
      apiMode, authReady, accessToken, resolvedFor: resolvedFor.current,
    });

    /*
     * Nothing to do, and nothing to say. 'keep' is the demo build and the
     * already-answered case; 'wait' is the window before the session check
     * settles, which is the window the original bug asked the API in.
     */
    setState((prev) => identityOnPlan(prev, plan));
    if (plan.do === 'keep' || plan.do === 'wait') return undefined;

    /*
     * No session. Not an identity failure — the gate shows the sign-in screen
     * for this, which is what somebody who needs to sign in again should see
     * rather than "We could not tell who you are".
     */
    if (plan.do === 'sign-in') {
      resolvedFor.current = null;
      setIdentity(null);
      setMe(null);
      setAccess(null);
      return undefined;
    }

    let cancelled = false;
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

        resolvedFor.current = plan.token;
        setIdentity(who.identity);
        setAccess({ modules: who.modules ?? [], rules: who.rules ?? {} });
        /*
         * A role the server names but this bundle has never heard of becomes
         * `employee` for display, the same mapping the server's own normaliser
         * makes.
         *
         * During the cutover deploy the two halves move minutes apart, and a
         * browser holding the new bundle can be answered by the old server,
         * which says `admin`. `SCOPE[role].label` is read directly on the
         * attendance and expenses screens, and `SCOPE['admin']` is undefined,
         * so that window crashed them. Access is unaffected either way: in API
         * mode every scope comes from `setAccess` above — the grant the server
         * computed — and never from this value.
         */
        setRole(isAppRole(who.role) ? who.role : 'employee');
        setMeId(empId);
        setMe(row);
        setState((prev) => identityOnSettled(prev, { kind: 'resolved' }));
      } catch (e) {
        if (cancelled) return;
        /*
         * Two outcomes, because they need different screens.
         *
         * A session that evaporated between the plan and the request — expired
         * and failed to refresh, or signed out in another tab — is not a broken
         * account. It latched "You are not signed in" into the identity error
         * before, which the gate renders as a dead end for somebody whose only
         * problem was needing to sign in again.
         *
         * Anything else is reported. Not swallowed, and not fallen back to the
         * demo row: falling back is what sent E008 to the database, and showing
         * the shell with somebody else's identity is worse than showing why it
         * stopped.
         */
        const failure = identityFailure(e);
        if (failure === 'session-lost') resolvedFor.current = null;
        setState((prev) => identityOnSettled(prev, {
          kind: 'failed',
          failure,
          message: e instanceof Error ? e.message : 'Could not establish who you are.',
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [setRole, setMeId, attempt, authReady, accessToken]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    identity,
    me,
    access,
    sessionLost: state.sessionLost,
    ready: state.ready,
    error: state.error,
    retry,
  };
}

export function AppProvider({ children, initialRole = 'company_admin' }: { children: ReactNode; initialRole?: AppRole }) {
  /*
   * The demo account to start as.
   *
   * This was `...find(...)!`, and the `!` was load-bearing in the worst way:
   * a role with no demo account gave `undefined`, and the next line read
   * `.role` off it. A stale initialRole produced "Cannot read properties of
   * undefined" from a component three levels down, forty times over, with
   * nothing naming the role that caused it.
   */
  const start = ACCOUNTS().find((acc) => acc.role === initialRole);
  if (!start) {
    throw new Error(
      `No demo account for role "${initialRole}". `
      + `ACCOUNTS() offers: ${ACCOUNTS().map((acc) => acc.role).join(', ')}.`,
    );
  }
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
  /*
   * `empId` because a role is not an identity. Two of the demo accounts are
   * employees — one with reports, one without — and matching on the role
   * alone found the first of them every time, so "Employee (Self-service)"
   * signed you in as the reporting manager and the self-service account could
   * not be reached at all. The only distinction the manager layer turns on
   * was the one the switcher could not express.
   *
   * It stays optional: `settings/access.tsx` switches by role, where any
   * holder of it will do.
   */
  const signInAs = useCallback((next: AppRole, empId?: string) => {
    if (apiMode) return;
    const acc = ACCOUNTS().find((a) => a.role === next && (!empId || a.empId === empId));
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

  /*
   * The session, from the layer that owns it. The resolver used to run on
   * mount regardless, which raced AuthProvider restoring the session and
   * produced a 401 it then latched forever.
   */
  const auth = useAuth();
  const resolved = useResolvedIdentity(
    setRole, setMeId, auth.ready, auth.session?.access_token ?? null);
  const { identity } = resolved;

  /*
   * In API mode this is the employee row the server returned for the signed-in
   * person. It was `EMAP[meId]` for both modes, which in API mode is a lookup
   * into the demo map by a real uuid — `undefined`, typed as `Employee`.
   */
  const me = apiMode ? resolved.me : EMAP[meId];

  /*
   * Manager-ness, from whichever authority this build has.
   *
   * In API mode it is the server's scopes: it already applied the reporting
   * tree, so asking it again locally could only disagree. In the demo build
   * there is no server, and the dataset's own tree is the fact.
   */
  const hasReports = apiMode
    ? hasReportsFromRules(resolved.access?.rules)
    : teamOf(meId, true).length > 0;

  const serverModules = apiMode ? resolved.access?.modules ?? null : null;

  const value = useMemo<AppState>(
    () => ({
      role,
      meId,
      me: me as Employee,
      identity,
      identityReady: resolved.ready,
      identityError: resolved.error,
      identitySessionLost: resolved.sessionLost,
      retryIdentity: resolved.retry,
      theme,
      revision,
      signInAs,
      toggleTheme,
      bump,
      can: (route: string) => can(role, route, hasReports, serverModules),
      scope: SCOPE[role],
      hasReports,
      scopeOf: (module: string, verb: 'read' | 'write' | 'approve') => {
        const r = resolved.access?.rules?.[module];
        /* Fail closed: a module the server did not mention grants nothing. */
        if (!r) return apiMode ? 'none' : scopeOfDemo(role, hasReports, module);
        return (r[verb] ?? 'none') as Scope;
      },
      reaches: (module: string, verb: 'read' | 'write' | 'approve', needed: Scope) => {
        const r = resolved.access?.rules?.[module];
        const granted = r
          ? ((r[verb] ?? 'none') as Scope)
          : (apiMode ? 'none' : scopeOfDemo(role, hasReports, module));
        return covers(granted, needed);
      },
      /*
       * Having reports is the question, not holding a role. `role !== 'employee'`
       * answered false for every manager - the only people the helper exists
       * for - because a manager is an employee the reporting tree widened.
       */
      isMyReport: (id: string) => hasReports
        && visibleIds(role, meId).includes(id)
        && id !== meId,
      toasts,
      toast,
      dismissToast,
    }),
    [role, meId, me, identity, hasReports, serverModules, resolved.access,
      resolved.ready, resolved.error, resolved.sessionLost,
      resolved.retry,
      theme, revision, signInAs, toggleTheme, bump, toasts, toast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}
