/**
 * What each role may do, in one place.
 *
 * Until now this was described in three places that disagreed: `PERMS` in the
 * frontend gated navigation, `role_permission` in the database called itself
 * "the authority" while being read by nothing and covering nine of
 * thirty-three modules, and 114 hand-written `caller.role` checks across
 * twenty-two services did the actual enforcing. This file is the description;
 * the services remain the enforcement, and `checks/roles.ts` fails the build
 * when the two drift apart.
 *
 * ---------------------------------------------------------------------------
 * THE THREE ROLES
 * ---------------------------------------------------------------------------
 *
 * **employee** — self-service, and the floor everyone stands on.
 *
 * Sees their own record and the things the whole company shares: the org
 * chart, announcements, celebrations, the project board. Raises their own
 * requests — leave, expenses, timesheets, tickets, asset requests, letters —
 * and approves nothing, including their own. Sees their own pay and nobody
 * else's. An employee is not a lesser manager; most of what the app does for
 * them has no team dimension at all.
 *
 * **manager** — an employee, plus their reporting line.
 *
 * Everything above for themselves, and *read* over everyone beneath them in
 * the tree, however deep. The addition that matters is `approve`: leave,
 * timesheets, regularisations, expenses, overtime and asset requests from
 * their line stop with them. Two things a manager deliberately does not get:
 * anybody else's pay — compensation is admin-only, and a manager seeing their
 * report's salary is a different product decision from seeing their leave —
 * and configuration, which changes the rules for people outside their line.
 *
 * **admin** — the whole tenant.
 *
 * Reads and writes everything, including compensation, configuration, the
 * audit trail and the commercial book. The one thing role does not buy is
 * self-approval: every approve path refuses the caller's own record
 * separately, because "senior enough to approve" and "allowed to approve your
 * own" are different questions and the second answer is always no.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, NOT PERMISSION
 * ---------------------------------------------------------------------------
 *
 * A boolean cannot describe any of the above. Almost every rule here is about
 * *how much* rather than *whether*: a manager reads leave for their team, an
 * employee reads their own, an admin reads all — three different answers to
 * one question. So each of read, write and approve carries a scope, and
 * migration 0027 widens `role_permission` to hold it.
 */

export type Role = 'admin' | 'manager' | 'employee';

/**
 * How far a grant reaches.
 *
 * `own` is the caller's own records. `team` is those plus everyone below them
 * in the reporting tree, at any depth — not direct reports only, because a
 * skip-level manager still answers for the people two levels down.
 */
export type Scope = 'none' | 'own' | 'team' | 'all';

export interface ModuleRule {
  read: Scope;
  write: Scope;
  approve: Scope;
}

export type ModulePolicy = Record<Role, ModuleRule>;

/** Shorthand: the same three scopes, written once per role. */
const rule = (
  employee: [Scope, Scope, Scope],
  manager: [Scope, Scope, Scope],
  admin: [Scope, Scope, Scope],
): ModulePolicy => ({
  employee: { read: employee[0], write: employee[1], approve: employee[2] },
  manager: { read: manager[0], write: manager[1], approve: manager[2] },
  admin: { read: admin[0], write: admin[1], approve: admin[2] },
});

const NO: [Scope, Scope, Scope] = ['none', 'none', 'none'];

/**
 * Every module, by its route key.
 *
 * Read in the order somebody meets them: their own work first, then their
 * team's, then the company's, then the tenant's.
 */
export const POLICY: Record<string, ModulePolicy> = {
  /* ---- everybody's own work ---- */

  dashboard: rule(['own', 'none', 'none'], ['team', 'none', 'none'], ['all', 'none', 'none']),

  /* A punch is written by the person who made it; a manager decides the
     regularisation when it was missed. */
  attendance: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),
  timesheet: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),
  leave: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),
  expenses: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),
  assets: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),
  helpdesk: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),

  /*
   * A shift is the hours you keep, so everyone can see their own and a manager
   * can move their line onto different ones. Overtime approval rides here too.
   */
  shifts: rule(['own', 'none', 'none'], ['team', 'team', 'team'], ['all', 'all', 'all']),

  /*
   * Pay stops at the person and the admin. A manager reading their report's
   * salary is a different product decision from reading their leave, and this
   * one is deliberately not taken — `maySeeAll` in the payroll service is
   * admin-only and this records why.
   */
  payroll: rule(['own', 'none', 'none'], ['own', 'none', 'none'], ['all', 'all', 'all']),
  tax: rule(['own', 'own', 'none'], ['own', 'own', 'none'], ['all', 'all', 'all']),
  benefits: rule(['own', 'own', 'none'], ['own', 'own', 'none'], ['all', 'all', 'all']),

  /* Own documents and letter requests; HR issues them. */
  documents: rule(['own', 'own', 'none'], ['own', 'own', 'none'], ['all', 'all', 'all']),

  /* Goals and check-ins are written together, so a manager writes on the line. */
  performance: rule(['own', 'own', 'none'], ['team', 'team', 'team'], ['all', 'all', 'all']),
  learning: rule(['own', 'own', 'none'], ['team', 'own', 'none'], ['all', 'all', 'none']),

  /* ---- what the company shares ---- */

  /* The org chart is public on purpose — it is how people find each other. */
  org: rule(['all', 'none', 'none'], ['all', 'none', 'none'], ['all', 'none', 'none']),
  announcements: rule(['all', 'none', 'none'], ['all', 'none', 'none'], ['all', 'all', 'none']),
  celebrations: rule(['all', 'none', 'none'], ['all', 'none', 'none'], ['all', 'all', 'none']),
  /* Anyone can be assigned work and move their own card. */
  planner: rule(['all', 'own', 'none'], ['all', 'all', 'none'], ['all', 'all', 'none']),

  /*
   * The directory narrows rather than opens: an employee sees themselves, a
   * manager their line, an admin everyone. The org chart above is the public
   * view; this one carries contact and employment detail.
   */
  employees: rule(['own', 'none', 'none'], ['team', 'none', 'none'], ['all', 'all', 'none']),

  /* ---- a manager's line ---- */

  approvals: rule(NO, ['team', 'none', 'team'], ['all', 'none', 'all']),
  onboarding: rule(NO, ['team', 'team', 'none'], ['all', 'all', 'all']),
  hiring: rule(NO, ['team', 'team', 'team'], ['all', 'all', 'all']),
  reports: rule(NO, ['team', 'none', 'none'], ['all', 'none', 'none']),
  /* An exit is raised by HR or the manager and settled by finance. */
  exit: rule(NO, ['team', 'team', 'none'], ['all', 'all', 'all']),
  /* Survey results are withheld below the response floor regardless of role. */
  engagement: rule(NO, ['all', 'none', 'none'], ['all', 'all', 'none']),

  /* ---- the tenant ---- */

  settings: rule(NO, NO, ['all', 'all', 'all']),
  security: rule(NO, NO, ['all', 'none', 'none']),
  exec: rule(NO, NO, ['all', 'none', 'none']),
  billing: rule(NO, NO, ['all', 'none', 'none']),

  /*
   * Staffing is admin-only, all five screens of it.
   *
   * Bill rates, client credit limits and vendor markups are commercial terms,
   * and `assertStaffing` refuses anybody else outright. A manager used to be
   * offered these in the navigation and got a page of 403s — the navigation
   * was wrong, not the service.
   */
  clients: rule(NO, NO, ['all', 'all', 'none']),
  requirements: rule(NO, NO, ['all', 'all', 'none']),
  bench: rule(NO, NO, ['all', 'all', 'none']),
  placements: rule(NO, NO, ['all', 'all', 'none']),
  vendors: rule(NO, NO, ['all', 'all', 'none']),
};

export const ROLES: Role[] = ['employee', 'manager', 'admin'];

/** The modules a role may open at all — anything it can read something in. */
export const modulesFor = (role: Role): string[] =>
  Object.keys(POLICY).filter((m) => POLICY[m]![role].read !== 'none').sort();

/** What this role may do in one module. Unknown modules grant nothing. */
export const ruleFor = (role: Role, module: string): ModuleRule =>
  POLICY[module]?.[role] ?? { read: 'none', write: 'none', approve: 'none' };

/**
 * Whether a scope covers a given reach.
 *
 * Ordered, so a check for `own` passes when the grant is `team` or `all`. Used
 * by the services that want to ask the policy rather than restate it.
 */
const RANK: Record<Scope, number> = { none: 0, own: 1, team: 2, all: 3 };
export const covers = (granted: Scope, needed: Scope): boolean =>
  RANK[granted] >= RANK[needed] && RANK[needed] > 0;

/** The prose above, in a form the settings screen can render. */
export const ROLE_SUMMARY: Record<Role, { title: string; blurb: string }> = {
  employee: {
    title: 'Employee',
    blurb: 'Their own record, their own requests, and what the company shares. '
      + 'Approves nothing. Sees their own pay and nobody else\'s.',
  },
  manager: {
    title: 'Manager',
    blurb: 'Everything an employee has, plus read over their reporting line at '
      + 'any depth and the authority to decide its requests. Not pay, and not '
      + 'configuration.',
  },
  admin: {
    title: 'Administrator',
    blurb: 'The whole tenant — compensation, configuration, the audit trail and '
      + 'the commercial book. Still cannot approve their own requests.',
  },
};
