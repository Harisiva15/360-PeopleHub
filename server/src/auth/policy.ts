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

  /*
   * Setting somebody's salary is its own module, not a corner of `payroll`.
   *
   * They are narrowed for different reasons. A tenant that wants finance to
   * see the register but not to *change* what people are paid can take this
   * away without also taking away everyone's own payslip, which is what
   * narrowing `payroll` would do.
   *
   * Nothing below admin, and not by oversight: a manager who can revise their
   * own report's pay is a manager who can give themselves a team of one. An
   * employee reading their own compensation history goes through `payroll`
   * with its `own` scope, not through here.
   */
  compensation: rule(NO, NO, ['all', 'all', 'all']),
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
  /* The recruitment desk. Same reasoning as the rest of the book: an order
     carries its bill rate, its pay rate and its markup, which are commercial
     terms. Approve is 'all' because assigning a recruiter and releasing one
     are decisions, not edits. */
  recruitment: rule(NO, NO, ['all', 'all', 'all']),
  /*
   * User administration. A manager reaches their own line — they raise
   * joiners and offboard leavers — and everything sharper than that is
   * bounded act by act in ACTION_SCOPE below, not here.
   */
  /* The catalogue is configuration, so only an admin writes it. Everybody
     reads — an employee reads exactly one record, their own, which the
     service enforces rather than the scope. */
  jobtitles: rule(['own', 'none', 'none'], ['all', 'none', 'none'], ['all', 'all', 'none']),
  /* The journey is about you, so you see your own and may tick off a task
     assigned to you. Nothing here writes a stage — see the service. */
  lifecycle: rule(['own', 'own', 'none'], ['team', 'team', 'none'], ['all', 'all', 'all']),
  /* A contract is procurement and a seat is an access grant, so they part
     ways: a manager reads the estate and revokes on their own line, and only
     an administrator signs for anything. */
  software: rule(['own', 'none', 'none'], ['all', 'team', 'none'], ['all', 'all', 'all']),
  /* The one module where an employee genuinely writes. The plan is theirs —
     they author it and tick it off — and the manager's say is the endorsement,
     which is the approve column rather than the write one. */
  devplans: rule(['own', 'own', 'none'], ['team', 'own', 'team'], ['all', 'all', 'all']),
  /* Everyone reads what is on and answers for themselves; anybody who runs a
     team can run an event, and the organiser is recorded on it. */
  events: rule(['all', 'own', 'none'], ['all', 'team', 'team'], ['all', 'all', 'all']),
  /* Everybody can take out what they can already see, and read their own
     record of having done it. The whole register is an administrator's. */
  exports: rule(NO, ['team', 'own', 'none'], ['all', 'all', 'none']),
  /* A report is a saved question. Writing one is writing your own; the rows it
     returns are whatever the reader could already see. */
  customreports: rule(NO, ['team', 'own', 'none'], ['all', 'all', 'none']),
  /* How the tenant connects to anything is a tenant-level decision. */
  integrations: rule(NO, NO, ['all', 'all', 'all']),
  /*
   * Your own account, and only ever your own.
   *
   * 'own' for every role including admin — deliberately. This module is the
   * control that lets somebody notice a session they did not start, and it
   * only works if it is the *person's* view. Reading somebody else's is
   * user administration and belongs in `users`, where it is scoped.
   */
  account: rule(['own', 'own', 'none'], ['own', 'own', 'none'], ['own', 'own', 'none']),

  users: rule(NO, ['team', 'team', 'none'], ['all', 'all', 'all']),
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

/* ---------------- user administration ---------------- */

/**
 * The individual acts of administering an account.
 *
 * A module-level rule answers "may this role open user management". It cannot
 * answer "may a manager delete somebody", which is the question that matters
 * here — the module is one screen and the twelve things it does carry twelve
 * different risks. So administration is described act by act, each with the
 * reach that act is allowed, and the service asks about the act rather than
 * the screen.
 */
export type UserAction =
  | 'user.view'
  | 'user.create'
  | 'user.edit'
  | 'user.delete'
  | 'user.activate'
  | 'user.deactivate'
  | 'user.suspend'
  | 'user.approve'
  | 'user.reset_password'
  | 'user.resend_invite'
  | 'user.bulk_import'
  | 'user.bulk_update'
  | 'user.export'
  | 'role.assign'
  | 'role.assign_admin'
  | 'permission.manage';

/**
 * How far each role may reach with each act.
 *
 * Three of these are deliberately narrower than the module rule would suggest,
 * and each is a decision rather than an oversight:
 *
 * **A manager may deactivate but not activate.** Deactivating somebody in your
 * own line is ordinary offboarding. Re-activating is not its mirror: the
 * account may have been held by an administrator for a reason the manager
 * cannot see, and letting them undo that turns a sanction into an
 * inconvenience.
 *
 * **A manager may not reset a password.** Password reset is account recovery,
 * and recovery is the standard route to taking over an account. A manager who
 * can reset their report's password can read their mail.
 *
 * **A manager may not approve.** They raise the request; somebody else decides
 * it. A workflow where the proposer is also the approver is not a workflow.
 */
const ACTION_SCOPE: Record<UserAction, Record<Role, Scope>> = {
  'user.view': { employee: 'none', manager: 'team', admin: 'all' },
  'user.create': { employee: 'none', manager: 'team', admin: 'all' },
  'user.edit': { employee: 'none', manager: 'team', admin: 'all' },
  /* Removing an account is irreversible in a way the rest of this is not. */
  'user.delete': { employee: 'none', manager: 'none', admin: 'all' },
  'user.activate': { employee: 'none', manager: 'none', admin: 'all' },
  'user.deactivate': { employee: 'none', manager: 'team', admin: 'all' },
  /* A sanction, not an administrative state. */
  'user.suspend': { employee: 'none', manager: 'none', admin: 'all' },
  'user.approve': { employee: 'none', manager: 'none', admin: 'all' },
  'user.reset_password': { employee: 'none', manager: 'none', admin: 'all' },
  'user.resend_invite': { employee: 'none', manager: 'team', admin: 'all' },
  'user.bulk_import': { employee: 'none', manager: 'team', admin: 'all' },
  'user.bulk_update': { employee: 'none', manager: 'team', admin: 'all' },
  'user.export': { employee: 'none', manager: 'team', admin: 'all' },
  /* Assigning a role at all — bounded further by the next line. */
  'role.assign': { employee: 'none', manager: 'team', admin: 'all' },
  /* The one that cannot be delegated: only an administrator makes one. */
  'role.assign_admin': { employee: 'none', manager: 'none', admin: 'all' },
  'permission.manage': { employee: 'none', manager: 'none', admin: 'all' },
};

/** How far this role may reach performing this act. `none` means not at all. */
export const actionScope = (role: Role, action: UserAction): Scope =>
  ACTION_SCOPE[action]?.[role] ?? 'none';

/** Whether this role may perform this act at all, anywhere. */
export const may = (role: Role, action: UserAction): boolean =>
  actionScope(role, action) !== 'none';

/**
 * Whether `role` may hand out `granted`.
 *
 * Separate from `role.assign` because the restriction is on the *value*, not
 * on the act: a manager assigns roles to their line every time they raise a
 * joiner, and the one thing they may not do is make another administrator.
 */
export const mayAssignRole = (role: Role, granted: Role): boolean => {
  if (!may(role, 'role.assign')) return false;
  return granted === 'admin' ? may(role, 'role.assign_admin') : true;
};

/** Every act, for a screen that wants to show what a role can do. */
export const USER_ACTIONS = Object.keys(ACTION_SCOPE) as UserAction[];

/* ---------------------------------------------------------------------------
 * Per-tenant narrowing
 *
 * `role_permission` has been seeded from this file since the seed script was
 * written, and read by nothing. The gap it leaves is real: one tenant wants
 * managers kept out of team cost, another does not, and today that is a code
 * change for everybody.
 *
 * **Overrides may only narrow.** The table cannot grant anything POLICY does
 * not already grant. That one rule is what makes the feature safe to have:
 *
 *   A write to `role_permission` — by a misconfigured screen, a migration, or
 *   somebody with direct database access — cannot escalate privilege. The
 *   worst it can do is take access away, which is visible and complained
 *   about, rather than quietly handing an employee the payroll register.
 *
 *   `checks/roles.ts` keeps working. It holds this file to the frontend mirror
 *   cell by cell across every module and role; if the database could widen a
 *   cell, that check would be comparing two ceilings while the real answer
 *   came from a third place nobody was looking at.
 *
 *   A missing row means "no narrowing", not "no access". A tenant seeded
 *   before a module existed must not lose it the day the module ships, and an
 *   empty table must not lock everybody out of everything.
 * ------------------------------------------------------------------------- */

/** One tenant's overrides: module -> role -> rule. Absent means no narrowing. */
export type Overrides = Record<string, Partial<Record<Role, Partial<ModuleRule>>>>;

/** The tighter of two scopes. */
export const narrower = (a: Scope, b: Scope): Scope => (RANK[a] <= RANK[b] ? a : b);

/**
 * What this role may actually do, after the tenant's own restrictions.
 *
 * Every field is the narrower of the code's grant and the tenant's, so the
 * result can never exceed `ruleFor`. That is asserted exhaustively in
 * scripts/policy.test.mjs rather than left to the reader to verify.
 */
export function effectiveRule(
  role: Role,
  module: string,
  overrides: Overrides | null | undefined,
): ModuleRule {
  const base = ruleFor(role, module);
  const o = overrides?.[module]?.[role];
  if (!o) return base;
  return {
    read: narrower(base.read, o.read ?? base.read),
    write: narrower(base.write, o.write ?? base.write),
    approve: narrower(base.approve, o.approve ?? base.approve),
  };
}

/** The modules a role may open at all, once narrowing is applied. */
export const effectiveModulesFor = (
  role: Role,
  overrides: Overrides | null | undefined,
): string[] =>
  Object.keys(POLICY)
    .filter((m) => effectiveRule(role, m, overrides).read !== 'none')
    .sort();
