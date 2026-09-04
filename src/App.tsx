import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppContext';
import { LayerProvider } from './components/Layer';
import { TooltipLayer } from './components/Tooltip';
import { Shell } from './shell/Shell';
import { ALL_ROUTES } from './nav';
import { getModule } from './modules/registry';
import './modules';

/** Renders a route's module, bouncing to the dashboard if the role lacks access. */
function RouteView({ route }: { route: string }) {
  const app = useApp();
  if (!app.can(route)) return <Navigate to="/dashboard" replace />;
  const mod = getModule(route);
  if (!mod) return <Navigate to="/dashboard" replace />;
  return <mod.Component />;
}

export function Routed() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        {ALL_ROUTES.map((r) => (
          <Route key={r} path={'/' + r} element={<RouteView route={r} />} />
        ))}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppProvider>
        <LayerProvider>
          <TooltipLayer />
          <Routed />
        </LayerProvider>
      </AppProvider>
    </HashRouter>
  );
}
