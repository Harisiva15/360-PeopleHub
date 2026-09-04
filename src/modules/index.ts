/**
 * Route loading.
 *
 * Every module is its own chunk, fetched when its route is first visited. The
 * shell does not wait for it: titles come from `titles.ts`, subtitles from
 * `subtitles.ts`, and sidebar pills from the service — so the frame paints
 * immediately and only the page body suspends.
 *
 * Each chunk registers its component on import, which is why the loaders below
 * resolve to the registry rather than to a component: the module owns its own
 * entry, and this file only says where to find it.
 */

import { NAV } from '../nav';
import { getModule, registerModule } from './registry';
import { Placeholder } from './Placeholder';
import { TITLES } from './titles';
import type { ComponentType } from 'react';

/** One dynamic import per route. The keys are the route names in `nav.ts`. */
const LOADERS: Record<string, () => Promise<unknown>> = {
  dashboard: () => import('./dashboard'),
  attendance: () => import('./attendance'),
  shifts: () => import('./shifts'),
  timesheet: () => import('./timesheet'),
  leave: () => import('./leave'),
  expenses: () => import('./expenses'),
  approvals: () => import('./approvals'),

  employees: () => import('./employees'),
  org: () => import('./people'),
  celebrations: () => import('./people'),
  announcements: () => import('./people'),
  engagement: () => import('./engagement'),
  assets: () => import('./assets'),
  whatsapp: () => import('./whatsapp'),
  helpdesk: () => import('./helpdesk'),

  payroll: () => import('./payroll'),
  tax: () => import('./tax'),
  benefits: () => import('./benefits'),

  performance: () => import('./performance'),
  learning: () => import('./learning'),
  hiring: () => import('./hiring'),
  onboarding: () => import('./onboarding'),
  exit: () => import('./exit'),

  clients: () => import('./staffing/clients'),
  requirements: () => import('./staffing/requirements'),
  bench: () => import('./staffing/bench'),
  placements: () => import('./staffing/bench'),
  billing: () => import('./staffing/billing'),
  vendors: () => import('./staffing/vendors'),

  copilot: () => import('./copilot'),
  exec: () => import('./exec'),
  reports: () => import('./reports'),
  documents: () => import('./documents'),
  security: () => import('./security'),
  settings: () => import('./settings'),
};

/** A route with no module yet renders the placeholder, not a broken page. */
const placeholderFor = (route: string): ComponentType => {
  const item = NAV.flatMap((g) => g.items).find((i) => i.k === route);
  const name = item?.n ?? TITLES[route] ?? route;
  return () => Placeholder({ name });
};

/**
 * Load a route's chunk and hand back its component.
 *
 * Two routes can share a chunk — placements ships with bench — so this reads
 * the registry after the import rather than assuming a default export.
 */
export async function loadRoute(route: string): Promise<{ default: ComponentType }> {
  const load = LOADERS[route];
  if (load) await load();
  const mod = getModule(route);
  if (mod) return { default: mod.Component };

  const Fallback = placeholderFor(route);
  registerModule({ key: route, title: TITLES[route] || route, Component: Fallback });
  return { default: Fallback };
}

/** Eager registration, for the render check and any non-browser consumer. */
export async function loadAllRoutes(): Promise<void> {
  await Promise.all(Object.keys(LOADERS).map((r) => loadRoute(r)));
  NAV.flatMap((g) => g.items).forEach((i) => {
    if (getModule(i.k)) return;
    registerModule({ key: i.k, title: TITLES[i.k] || i.n, Component: placeholderFor(i.k) });
  });
}
