import { lazy, Suspense } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { ComponentType, ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, Link } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppContext';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { TITLES } from './modules/titles';
import { Icon } from './components/icons';
import { IdleGuard } from './auth/IdleGuard';
import { MfaChallenge } from './auth/MfaChallenge';
import { SetPassword } from './auth/SetPassword';
import { RequireMfa } from './auth/RequireMfa';
import { LoginPage } from './auth/LoginPage';
import { LayerProvider } from './components/Layer';
import { TooltipLayer } from './components/Tooltip';
import { Shell } from './shell/Shell';
import { ALL_ROUTES, isHiddenRoute } from './nav';
import { loadRoute } from './modules';

/**
 * One lazy component per route, created once.
 *
 * `lazy()` caches the promise it is given, so building these at module scope
 * means a revisited route re-renders rather than re-fetching — and a route
 * that renders mid-navigation does not remount from scratch.
 */
const LAZY: Record<string, ComponentType> = Object.fromEntries(
  ALL_ROUTES.map((r) => [r, lazy(() => loadRoute(r))]),
);

/**
 * Renders a route's module, or says why it will not.
 *
 * A role that may not open a module used to be bounced to the dashboard. That
 * is indistinguishable from a broken link: somebody follows a URL a colleague
 * sent them, lands somewhere else, and concludes the application is confused
 * rather than that they lack access. Saying so is both kinder and more honest.
 *
 * It is not a security boundary and does not pretend to be — the API refuses
 * the same request regardless of what this renders. See http/app.ts, where the
 * dispatcher checks the same module against the same policy.
 *
 * A route that does not exist still redirects, because there is nothing to
 * explain: a typo is not a permission problem.
 */
function RouteView({ route }: { route: string }) {
  const app = useApp();
  const View = LAZY[route];
  if (!View) return <Navigate to="/dashboard" replace />;
  /*
   * Out of scope for go-live, and closed rather than merely unlisted.
   * Removing an item from a menu is not access control: the module is still
   * registered, still routed and still rendered by check:renders, so without
   * this a bookmark or a typed URL would walk straight into it.
   */
  if (isHiddenRoute(route)) return <Navigate to="/dashboard" replace />;
  if (!app.can(route)) return <AccessDenied route={route} />;
  /*
   * Inside the shell and around the page only, and keyed by route so moving
   * away builds a new one. A crash costs the page and keeps the navigation —
   * see the boundary's own header for why that is the whole point.
   */
  return (
    <ErrorBoundary key={route} where={route}>
      <View />
    </ErrorBoundary>
  );
}

export function Routed() {
  return (
    <Shell>
      {/* The shell's frame is already painted; only the page body waits. */}
      <Suspense fallback={<div className="muted" style={{ padding: 24 }}>Loading…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          {ALL_ROUTES.map((r) => (
            <Route key={r} path={'/' + r} element={<RouteView route={r} />} />
          ))}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

/**
 * Decides whether anything is rendered at all.
 *
 * In demo mode there is nothing to sign in to, so this is a pass-through. When
 * the build has a Supabase project, no route renders without a session — the
 * gate is here rather than per-route so a new route cannot forget it.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const app = useApp();

  if (!auth.configured) return <>{children}</>;

  // Wait for the first session check. Rendering the login page during it would
  // flash it at someone who is already signed in.
  if (!auth.ready) {
    return (
      <div className="login-shell">
        <div className="muted" style={{ fontSize: 13 }}>Checking your session…</div>
      </div>
    );
  }

  if (!auth.session) return <LoginPage theme={app.theme} />;

  /*
   * A session is not enough when the account carries a second factor.
   *
   * `null` means the answer has not come back yet, and it waits rather than
   * guessing — rendering the app for the instant before the check resolves
   * is the entire bypass, and it would be invisible in normal use because
   * the check is fast. The strict direction costs a moment on a slow
   * connection; the lax one costs the feature.
   *
   * The level itself is read from Supabase on every settle, so this cannot
   * be turned off by editing anything the browser holds.
   */
  if (auth.mfaRequired === null) {
    return (
      <div className="login-shell">
        <div className="muted" style={{ fontSize: 13 }}>Checking your session…</div>
      </div>
    );
  }
  if (auth.mfaRequired) return <MfaChallenge theme={app.theme} />;

  /*
   * And a pending password change, after the second factor rather than
   * before it. Proving who you are comes first: otherwise a stolen password
   * alone would reach the screen that sets a new one, which is the whole
   * account.
   */
  if (auth.passwordChangeRequired === null) {
    return (
      <div className="login-shell">
        <div className="muted" style={{ fontSize: 13 }}>Checking your session…</div>
      </div>
    );
  }
  if (auth.passwordChangeRequired) return <SetPassword />;

  /*
   * Last of the four gates, and last on purpose. Somebody arriving with a
   * password an administrator set replaces it first; binding a second factor
   * to an account still on its temporary credential is the wrong order.
   *
   * Only ever true when the account owes an enrolment *and* has no factor,
   * so completing it ends the loop. `null` falls through rather than waiting:
   * unlike the others this one cannot be satisfied without a working Supabase
   * project, and blocking on an unknown answer would strand people behind a
   * QR code nobody can help them past.
   */
  if (auth.mfaEnrolmentRequired) return <RequireMfa />;

  /*
   * And finally: who are you?
   *
   * A session proves the browser holds a valid token. It does not say which
   * employee that token belongs to, and every screen asks for "my" leave, "my"
   * claims, "my" week the moment it mounts. Until this session's own commit,
   * `AppProvider` answered that question from the demo dataset while the real
   * answer was in flight — so for one render `meId` was `E008` and
   * `me.managerId` was `E001`, and those went out to a Postgres that quite
   * correctly refused them as malformed uuids, on every sign-in.
   *
   * Waiting here is the fix, rather than patching the screens that happened to
   * query first. There is no provisional identity to leak if nothing renders
   * until the real one is in hand, and a new screen cannot reintroduce the bug
   * by being written the obvious way.
   *
   * Costs a moment after sign-in. In the demo build `identityReady` is true
   * from the first render, so this is not in that path at all.
   */
  /*
   * A session that is gone is a reason to sign in, not a broken identity.
   *
   * This branch is the reported bug. The resolver used to run before
   * `AuthProvider` had restored the session, get `401 You are not signed in`
   * from the HTTP client, and latch it into `identityError` — and by the time
   * the session did arrive, `auth.session` was non-null so the gate had already
   * walked past its own login branch above. A signed-in person deep-linking to
   * `/#/settings?v=company` landed on "We could not tell who you are — You are
   * not signed in", with Try again and Sign out as the only ways out.
   *
   * The resolver no longer asks before there is a token and re-asks when one
   * arrives, so this should be rare: an expired session whose refresh failed,
   * or a sign-out in another tab. When it happens, the honest screen is the one
   * that lets them sign in.
   */
  if (app.identitySessionLost) return <LoginPage theme={app.theme} />;

  if (!app.identityReady) {
    if (app.identityError) {
      return (
        <div className="login-shell">
          <div className="stack" style={{ maxWidth: 420, textAlign: 'center', gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>We could not tell who you are</div>
            <div className="muted" style={{ fontSize: 13 }}>{app.identityError}</div>
            <div className="row gap" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={app.retryIdentity}>Try again</button>
              <button className="btn" onClick={() => void auth.signOut()}>Sign out</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="login-shell">
        <div className="muted" style={{ fontSize: 13 }}>Loading your profile…</div>
      </div>
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <AppProvider>
          <LayerProvider>
            <TooltipLayer />
            <AuthGate>
              <Routed />
            </AuthGate>
            {/* Outside the gate: it renders nothing without a session, and
                inside it would unmount the moment it signed somebody out. */}
            <IdleGuard />
          </LayerProvider>
        </AppProvider>
      </AuthProvider>
    </HashRouter>
  );
}

/**
 * What somebody sees when their role cannot open a route.
 *
 * Names the module, because "access denied" without a subject leaves people
 * guessing which of the three links they just clicked was the problem. Offers
 * the way back rather than only the bad news, and says who can change it —
 * "ask an administrator" is actionable in a way that a bare 403 is not.
 */
function AccessDenied({ route }: { route: string }) {
  return (
    <div className="denied">
      <Icon n="lock" size="xl" />
      <h1>You do not have access to this</h1>
      <p>
        Your role does not include <strong>{TITLES[route] ?? route}</strong>. If you
        need it, an administrator can change what your role reaches under
        Settings → Access Control.
      </p>
      <Link className="btn primary" to="/dashboard">Back to the dashboard</Link>
    </div>
  );
}
