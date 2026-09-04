import { lazy, Suspense } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppContext';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { LoginPage } from './auth/LoginPage';
import { LayerProvider } from './components/Layer';
import { TooltipLayer } from './components/Tooltip';
import { Shell } from './shell/Shell';
import { ALL_ROUTES } from './nav';
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

/** Renders a route's module, bouncing to the dashboard if the role lacks access. */
function RouteView({ route }: { route: string }) {
  const app = useApp();
  if (!app.can(route)) return <Navigate to="/dashboard" replace />;
  const View = LAZY[route];
  if (!View) return <Navigate to="/dashboard" replace />;
  return <View />;
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
          </LayerProvider>
        </AppProvider>
      </AuthProvider>
    </HashRouter>
  );
}
