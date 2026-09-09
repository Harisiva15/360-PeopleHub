import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { apiConfigured } from './services/http/client';
import './styles/global.css';

/*
 * The swap.
 *
 * With VITE_API_URL set, the mapped service methods go to the API and the rest
 * still resolve from the in-memory dataset — see src/services/http. Without it
 * the app is entirely the mock, which is what the public demo is.
 *
 * Both imports are dynamic and inside the branch on purpose. `./services`
 * pulls in the whole generated dataset, and importing it statically here put
 * ~200 kB of fabricated employees into the entry chunk — the one the browser
 * must fetch before it can paint anything, in every build, including the demo
 * that reaches no API at all.
 */
async function boot() {
  if (apiConfigured) {
    const [{ getServices, setServices }, { createHttpServices, liveMethodCount }] =
      await Promise.all([import('./services'), import('./services/http')]);

    setServices(createHttpServices(getServices()));
    const { live, services } = liveMethodCount();
    console.info(
      `[services] API at ${import.meta.env.VITE_API_URL} — `
      + `${live} method(s) across ${services} service(s) are live; the rest are still the mock.`,
    );
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
