/**
 * Which module each API path belongs to.
 *
 * A tenant can narrow a role out of a module (see auth/overrides.ts), and
 * until this file existed that narrowing only removed menu entries — the
 * routes behind them still answered. Hiding a menu item is not a permission,
 * which is the whole reason the frontend policy is mirrored on the server in
 * the first place.
 *
 * **Why a prefix map and not a field on each route.** There are 306 routes and
 * one of them getting no module is silent: it would simply never be narrowed,
 * and nothing on any screen would look wrong. A map of forty-odd prefixes can
 * be read in one sitting, and scripts/route-modules.test.mjs fails if any live
 * route's prefix is missing from it — so the failure is loud and immediate
 * rather than discovered by a tenant who thought they had switched something
 * off.
 *
 * **The API's nouns are not always the menu's.** `/fbp` is the flexible
 * benefit plan and belongs to benefits; `/requisitions`, `/candidates`,
 * `/interviews` and `/offers` are all internal hiring; `/timesheets` is
 * plural where the module is not. Each difference is a deliberate mapping
 * rather than a rename, because renaming a shipped route to match a menu key
 * breaks every client that already calls it.
 */

/** Path prefix (first segment) -> the POLICY module key it belongs to. */
export const ROUTE_MODULE: Record<string, string> = {
  announcements: 'announcements',
  approvals: 'approvals',
  assets: 'assets',
  attendance: 'attendance',
  candidates: 'hiring',
  celebrations: 'celebrations',
  config: 'settings',
  'dev-plans': 'devplans',
  documents: 'documents',
  employees: 'employees',
  events: 'events',
  exits: 'exit',
  expenses: 'expenses',
  exports: 'exports',
  fbp: 'benefits',
  helpdesk: 'helpdesk',
  integrations: 'integrations',
  interviews: 'hiring',
  'job-titles': 'jobtitles',
  joiners: 'onboarding',
  learning: 'learning',
  leave: 'leave',
  letters: 'documents',
  lifecycle: 'lifecycle',
  loans: 'payroll',
  offers: 'hiring',
  onboarding: 'onboarding',
  overtime: 'attendance',
  payroll: 'payroll',
  performance: 'performance',
  planner: 'planner',
  recruiters: 'recruitment',
  recruitment: 'recruitment',
  reports: 'reports',
  requisitions: 'hiring',
  security: 'security',
  shifts: 'shifts',
  software: 'software',
  staffing: 'clients',
  surveys: 'engagement',
  tax: 'tax',
  timesheets: 'timesheet',
  users: 'users',
};

/**
 * Paths that belong to no module and are never narrowed.
 *
 * These are self-service: they act on the caller's own row and nobody else's,
 * and they are how somebody signs in, signs out and reads their own history.
 * Gating them on a module would be actively wrong — `users` grants an employee
 * nothing, so narrowing enforcement over `/users/me/last-login` would stop
 * every employee's sign-in from being recorded, and over
 * `/users/me/password-status` would stop the forced-password gate working for
 * exactly the people it exists for.
 *
 * Matched on the full path, not the prefix, so adding `/users/:id/...` later
 * cannot accidentally inherit the exemption.
 */
export const UNGATED = new Set<string>([
  '/health',
  '/me/permissions',
  '/users/me/last-login',
  '/users/me/sign-out',
  '/users/me/login-history',
  '/users/me/account-status',
  '/users/me/password-changed',
]);

/**
 * The module a request belongs to, or null when it is ungated.
 *
 * Returns the string 'unmapped' for a path whose prefix is in neither list.
 * That case cannot happen while the check passes, and if it ever does the
 * dispatcher refuses rather than waving it through — an unrecognised path is
 * not a reason to skip authorisation.
 */
export function moduleForPath(pathname: string): string | null {
  if (UNGATED.has(pathname)) return null;
  const first = pathname.split('/')[1] ?? '';
  return ROUTE_MODULE[first] ?? 'unmapped';
}
