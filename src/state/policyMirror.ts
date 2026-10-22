/**
 * The policy, mirrored for the demo build.
 *
 * ## Why a mirror and not an import
 *
 * The frontend does not reach into `server/src` at build time — that is the
 * boundary that keeps server code out of the bundle — and the demo build has
 * no server to ask. So it needs its own copy, and a copy needs something to
 * keep it honest: `checks/roles.ts` compares this table with
 * `server/src/auth/policy.ts` module for module, layer for layer and verb
 * for verb, and fails the build on any difference.
 *
 * ## What it replaced
 *
 * `scopeOfDemo` used to answer from `PERMS` and the role's rank: anything in
 * an administrative role's module list came back `'all'`, on all three verbs.
 * That disagreed with the policy in 300 of 1104 cells — `hr_admin` writing
 * the dashboard, `finance_admin` writing attendance and leave it may only
 * read, every role approving things the policy lets nobody approve. Two of
 * them reached the menu, where `checks/permissions-matrix.ts` found them:
 * finance_admin was offered Request queue and Shifts & work schedules at team
 * scope on an `own` grant.
 *
 * It is generated rather than typed out, from the table it mirrors, in the
 * same vocabulary — so a reader comparing the two files is comparing like
 * with like.
 */

import type { AppRole } from '../types/employee';

export type Scope = 'none' | 'own' | 'team' | 'all';
export type Verb = 'read' | 'write' | 'approve';

export interface ModuleRule {
  read: Scope;
  write: Scope;
  approve: Scope;
}

/** The manager layer is not a role: it is what having reports adds. */
export type Layer = 'manager';

export type ModulePolicy = Record<AppRole | Layer, ModuleRule>;

type Triple = [Scope, Scope, Scope];

/** Shorthand: read, write, approve for each layer, in table order. */
const rule = (
  employee: Triple,
  manager: Triple,
  hrAdmin: Triple,
  financeAdmin: Triple,
  companyAdmin: Triple,
): ModulePolicy => ({
  employee: { read: employee[0], write: employee[1], approve: employee[2] },
  manager: { read: manager[0], write: manager[1], approve: manager[2] },
  hr_admin: { read: hrAdmin[0], write: hrAdmin[1], approve: hrAdmin[2] },
  finance_admin: { read: financeAdmin[0], write: financeAdmin[1], approve: financeAdmin[2] },
  company_admin: { read: companyAdmin[0], write: companyAdmin[1], approve: companyAdmin[2] },
});

const NO: Triple = ['none', 'none', 'none'];
const OWN_R: Triple = ['own', 'none', 'none'];
const ALL_R: Triple = ['all', 'none', 'none'];
const ALL_RW: Triple = ['all', 'all', 'none'];
const ALL_RWA: Triple = ['all', 'all', 'all'];
/** Raise your own, approve nothing. */
const SELF: Triple = ['own', 'own', 'none'];
/** Read the line, write your own, decide the line's requests. */
const LINE: Triple = ['team', 'own', 'team'];

export const POLICY_MIRROR: Record<string, ModulePolicy> = {
  dashboard: rule(OWN_R, ['team', 'none', 'none'], ALL_R, ALL_R, ALL_R),
  attendance: rule(SELF, LINE, ALL_RWA, ALL_R, ALL_RWA),
  leave: rule(SELF, LINE, ALL_RWA, ALL_R, ALL_RWA),
  timesheet: rule(SELF, LINE, ALL_RWA, ALL_R, ALL_RWA),
  helpdesk: rule(SELF, LINE, ALL_RWA, NO, ALL_RWA),
  expenses: rule(SELF, LINE, ALL_RWA, ALL_RWA, ALL_RWA),
  assets: rule(SELF, LINE, ALL_R, ALL_R, ALL_RWA),
  shifts: rule(OWN_R, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),
  payroll: rule(OWN_R, OWN_R, ALL_RWA, ALL_RWA, ALL_RWA),
  tax: rule(SELF, SELF, ALL_RWA, ALL_RWA, ALL_RWA),
  compensation: rule(NO, NO, ALL_RWA, ALL_RWA, ALL_RWA),
  benefits: rule(SELF, SELF, ALL_RWA, ALL_RWA, ALL_RWA),
  documents: rule(SELF, SELF, ALL_RWA, SELF, ALL_RWA),
  performance: rule(SELF, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),
  learning: rule(SELF, LINE, ALL_RWA, NO, ALL_RWA),
  devplans: rule(SELF, LINE, ALL_RWA, NO, ALL_RWA),
  org: rule(ALL_R, ALL_R, ALL_R, ALL_R, ALL_R),
  announcements: rule(ALL_R, ['all', 'team', 'team'], ALL_RWA, ALL_R, ALL_RWA),
  celebrations: rule(ALL_R, ['all', 'team', 'team'], ALL_RWA, ALL_R, ALL_RWA),
  events: rule(['all', 'own', 'none'], ['all', 'team', 'team'], ALL_RWA, ALL_R, ALL_RWA),
  engagement: rule(['all', 'own', 'none'], ['all', 'own', 'none'], ALL_RW, ['all', 'own', 'none'], ALL_RW),
  planner: rule(['all', 'own', 'none'], ['all', 'team', 'none'], ALL_RW, ['all', 'own', 'none'], ALL_RW),
  employees: rule(OWN_R, ['team', 'none', 'none'], ALL_RW, ALL_R, ALL_RW),
  jobtitles: rule(OWN_R, ALL_R, ALL_RW, ALL_R, ALL_RW),
  lifecycle: rule(SELF, ['team', 'none', 'none'], ALL_RWA, ALL_R, ALL_RWA),
  onboarding: rule(NO, ['team', 'team', 'none'], ALL_RWA, NO, ALL_RWA),
  hiring: rule(NO, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),
  recruitment: rule(NO, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),
  exit: rule(SELF, ['team', 'none', 'none'], ALL_RWA, ['all', 'none', 'all'], ALL_RWA),
  approvals: rule(NO, ['team', 'none', 'team'], ['all', 'none', 'all'], ['all', 'none', 'all'], ['all', 'none', 'all']),
  reports: rule(NO, ['team', 'own', 'none'], ALL_RW, ALL_RW, ALL_RW),
  customreports: rule(NO, ['team', 'own', 'none'], ALL_RW, ALL_RW, ALL_RW),
  exports: rule(NO, ['team', 'own', 'none'], ALL_RW, ALL_RW, ALL_RW),
  software: rule(OWN_R, ['team', 'team', 'none'], NO, ALL_R, ALL_RWA),
  users: rule(NO, ['team', 'none', 'none'], ALL_R, NO, ALL_RWA),
  settings: rule(NO, NO, NO, NO, ALL_RWA),
  security: rule(NO, NO, NO, NO, ALL_RWA),
  integrations: rule(NO, NO, NO, NO, ALL_RWA),
  billing: rule(NO, NO, NO, ALL_R, ALL_R),
  exec: rule(NO, NO, ALL_R, ALL_R, ALL_R),
  clients: rule(NO, NO, NO, ALL_RW, ALL_RW),
  vendors: rule(NO, NO, NO, ALL_RW, ALL_RW),
  placements: rule(NO, NO, NO, ALL_RW, ALL_RW),
  requirements: rule(NO, NO, ALL_R, NO, ALL_RW),
  bench: rule(NO, NO, ALL_R, NO, ALL_RW),
  account: rule(SELF, SELF, SELF, SELF, SELF),
};

export const EMPTY_RULE: ModuleRule = { read: 'none', write: 'none', approve: 'none' };

const RANK: Record<Scope, number> = { none: 0, own: 1, team: 2, all: 3 };

/** The wider of two scopes, which is how layers combine. */
export const widerScope = (a: Scope, b: Scope): Scope => (RANK[a] >= RANK[b] ? a : b);

/**
 * What a person reaches: their role, plus the employee baseline, plus the
 * manager layer where they have reports. The union, per verb — the same
 * three layers and the same order as `effectiveFor` on the server.
 */
export function effectiveRule(role: AppRole, hasReports: boolean, module: string): ModuleRule {
  const p = POLICY_MIRROR[module];
  if (!p) return EMPTY_RULE;
  const layers: ModuleRule[] = [p.employee, p[role] ?? EMPTY_RULE];
  if (hasReports) layers.push(p.manager);
  return layers.reduce((acc, r) => ({
    read: widerScope(acc.read, r.read),
    write: widerScope(acc.write, r.write),
    approve: widerScope(acc.approve, r.approve),
  }), EMPTY_RULE);
}
