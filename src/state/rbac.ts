import { ACTIVE, DEMO_EMP, DEMO_MGR, EMAP, HRHEAD, teamOf } from '../data/employees';
import { apiConfigured } from '../services/http';
import type { AppRole, Employee } from '../types/employee';

/**
 * What each of the three roles may reach.
 *
 * The shape is deliberately a ladder: everything an employee can do, a manager
 * can do, and everything a manager can do, an admin can do. A role that could
 * reach something its senior could not would be a permission nobody can reason
 * about during an incident.
 *
 * **Admin** — the whole product. Creates and modifies people, runs payroll,
 * configures the tenant, reads every report.
 *
 * **Manager** — their own reporting tree. Raises a joining request for a new
 * hire (an admin approves it), approves leave, timesheets and expenses, and
 * reads the recruitment and people trackers. Deliberately without `settings`
 * and `security`: tenant configuration and the audit log are not a team-level
 * concern.
 *
 * **Employee** — self-service. Their dashboard, attendance, timesheet,
 * payslip, the org chart and the kit issued to them.
 *
 * Two things sit in the employee list that were not asked for, because the
 * modules above them do not work otherwise: `leave`, since a manager
 * approving leave requires somebody to have raised it, and `announcements`,
 * since an announcement nobody can read is not an announcement. Say the word
 * and either comes out.
 */
/**
 * Which modules each role may open.
 *
 * A convenience — the services do the enforcing — but one that has to agree
 * with them. `checks/roles.ts` compares this against
 * `server/src/auth/policy.ts` and fails the build on either kind of
 * disagreement: a screen offered to somebody the service will refuse, or one
 * withheld from somebody entitled to it. Both were live before that check
 * existed.
 *
 * The three lists are cumulative on purpose. An employee's modules are a
 * manager's, and a manager's are an admin's, which is why each is written out
 * in full rather than spread — the shape of the ladder should be visible.
 */
/**
 * Which modules each role may open, mirroring `POLICY` in
 * `server/src/auth/policy.ts`. `checks/roles.ts` fails the build when the two
 * disagree, which is why these are written out rather than imported — the
 * frontend does not reach into the server's source at build time.
 *
 * **These are the lists for somebody with no reports.** The manager layer is
 * additive and lives in `MANAGER_ADDS` below, because `can()` has to be able
 * to answer for an employee who runs a team and an HR administrator who runs
 * one, and a per-role list cannot express either.
 *
 * **In a configured build these are the fallback, not the authority.** The
 * server answers `/me/permissions` with the module list it computed from the
 * policy, the reporting tree and this tenant's narrowing, and `can()` prefers
 * that. These lists are what the demo build uses, and what the drift check
 * compares against.
 */
export const PERMS: Record<AppRole, string[]> = {
  /* Self-service. Their own work, and what the company shares. */
  employee: [
    'account', 'announcements', 'assets', 'attendance', 'benefits', 'celebrations',
    'dashboard', 'devplans', 'documents', 'employees', 'engagement', 'events', 'exit',
    'expenses', 'helpdesk', 'jobtitles', 'learning', 'leave', 'lifecycle', 'org',
    'payroll', 'performance', 'planner', 'shifts', 'software', 'tax', 'timesheet',
  ],

  /* People. Everything an employee has, plus the company's people records.
     Reads payroll and does not run it; edits what people are paid. */
  hr_admin: [
    'software',
    'account', 'announcements', 'approvals', 'assets', 'attendance', 'bench',
    'benefits', 'celebrations', 'compensation', 'customreports', 'dashboard',
    'devplans', 'documents', 'employees', 'engagement', 'events', 'exec', 'exit',
    'expenses', 'exports', 'helpdesk', 'hiring', 'jobtitles', 'learning', 'leave',
    'lifecycle', 'onboarding', 'org', 'payroll', 'performance', 'planner',
    'recruitment', 'reports', 'requirements', 'shifts', 'tax',
    'timesheet', 'users',
  ],

  /* Money. Payroll, tax, expenses and the commercial book. Reads compensation
     and does not set it. */
  finance_admin: [
    'devplans', 'helpdesk', 'learning', 'performance', 'shifts',
    'account', 'announcements', 'approvals', 'assets', 'attendance', 'benefits',
    'billing', 'celebrations', 'clients', 'compensation', 'customreports',
    'dashboard', 'documents', 'employees', 'engagement', 'events', 'exec',
    'exit', 'expenses', 'exports', 'jobtitles', 'leave',
    'lifecycle', 'org', 'payroll', 'placements', 'planner', 'reports',
    'software', 'tax', 'timesheet', 'vendors',
  ],

  /* The whole tenant, and the only role that creates logins, changes a role or
     edits company settings. */
  company_admin: [
    'account', 'announcements', 'approvals', 'assets', 'attendance', 'bench',
    'benefits', 'billing', 'celebrations', 'clients', 'compensation', 'customreports',
    'dashboard', 'devplans', 'documents', 'employees', 'engagement', 'events', 'exec',
    'exit', 'expenses', 'exports', 'helpdesk', 'hiring', 'integrations', 'jobtitles',
    'learning', 'leave', 'lifecycle', 'onboarding', 'org', 'payroll', 'performance',
    'placements', 'planner', 'recruitment', 'reports', 'requirements', 'security',
    'settings', 'shifts', 'software', 'tax', 'timesheet', 'users', 'vendors',
  ],
};

/**
 * What having reports opens that an employee cannot reach alone.
 *
 * The additive half of the model. Anybody with people below them in the tree
 * gets these on top of their role's list, at any depth — a skip-level manager
 * still answers for the people two levels down.
 */
/**
 * What having reports adds, and how far, per verb.
 *
 * The layer's own rule per module, mirroring ruleFor('manager', m) on the
 * server. checks/roles.ts holds it to that, verb by verb.
 *
 * It carried only a read scope at first, and the gates used that scope for
 * writes as well. Several modules the layer may read widely and write not at
 * all - jobtitles is read 'all', write 'none' - so a manager could add a job
 * title, add software and edit anybody's event. One scope cannot answer three
 * questions.
 */
export const MANAGER_LAYER: Record<string, ModuleRule> = {
  account: { read: 'own', write: 'own', approve: 'none' },
  announcements: { read: 'all', write: 'team', approve: 'team' },
  approvals: { read: 'team', write: 'none', approve: 'team' },
  assets: { read: 'team', write: 'own', approve: 'team' },
  attendance: { read: 'team', write: 'own', approve: 'team' },
  benefits: { read: 'own', write: 'own', approve: 'none' },
  celebrations: { read: 'all', write: 'team', approve: 'team' },
  customreports: { read: 'team', write: 'own', approve: 'none' },
  dashboard: { read: 'team', write: 'none', approve: 'none' },
  devplans: { read: 'team', write: 'own', approve: 'team' },
  documents: { read: 'own', write: 'own', approve: 'none' },
  employees: { read: 'team', write: 'none', approve: 'none' },
  engagement: { read: 'all', write: 'own', approve: 'none' },
  events: { read: 'all', write: 'team', approve: 'team' },
  exit: { read: 'team', write: 'team', approve: 'none' },
  expenses: { read: 'team', write: 'own', approve: 'team' },
  exports: { read: 'team', write: 'own', approve: 'none' },
  helpdesk: { read: 'team', write: 'own', approve: 'team' },
  hiring: { read: 'team', write: 'team', approve: 'team' },
  jobtitles: { read: 'all', write: 'none', approve: 'none' },
  learning: { read: 'team', write: 'own', approve: 'team' },
  leave: { read: 'team', write: 'own', approve: 'team' },
  lifecycle: { read: 'team', write: 'team', approve: 'none' },
  onboarding: { read: 'team', write: 'team', approve: 'none' },
  org: { read: 'all', write: 'none', approve: 'none' },
  payroll: { read: 'own', write: 'none', approve: 'none' },
  performance: { read: 'team', write: 'team', approve: 'team' },
  planner: { read: 'all', write: 'all', approve: 'none' },
  recruitment: { read: 'team', write: 'team', approve: 'team' },
  reports: { read: 'team', write: 'own', approve: 'none' },
  shifts: { read: 'team', write: 'team', approve: 'team' },
  software: { read: 'all', write: 'team', approve: 'none' },
  tax: { read: 'own', write: 'own', approve: 'none' },
  timesheet: { read: 'team', write: 'own', approve: 'team' },
  users: { read: 'team', write: 'none', approve: 'none' },
};

/** The modules the layer reaches at all. Derived, so it cannot disagree. */
export const MANAGER_ADDS: string[] = Object.keys(MANAGER_LAYER)
  .filter((m) => MANAGER_LAYER[m]!.read !== 'none');

/** One module's three verbs, as the server reports them in `Me.rules`. */
export interface RuleScopes {
  read: string;
  write: string;
  approve: string;
}

/**
 * Does this person answer for anybody?
 *
 * `manager` is not a role, so there is nothing to compare against. It is a fact
 * about the reporting tree, and the server has already applied it: the union it
 * computes gives a manager `team` where the same role without reports gets
 * `own`. So the answer is already in the scopes it sent, and reading it back
 * out keeps one authority for the question instead of two that can disagree.
 *
 * Deliberately not a field of its own on the payload. A second statement of the
 * same fact is a second thing to keep in step, and the one that drifts is
 * always the one the UI reads.
 */
export const hasReportsFromRules = (
  rules: Record<string, RuleScopes> | null | undefined,
): boolean => Object.values(rules ?? {})
  .some((r) => r.read === 'team' || r.write === 'team' || r.approve === 'team');

/** Scope width, matching `RANK` in server/src/auth/policy.ts. */
const RANK: Record<Scope, number> = {
  none: 0, own: 1, team: 2, all: 3,
};

/** Whether a granted scope reaches as far as a needed one. */
export const covers = (granted: Scope, needed: Scope): boolean => RANK[granted] >= RANK[needed];

/**
 * A caller's scope on one module, for the in-memory services.
 *
 * The mock has no server to ask and no `hasReports` on `Caller`, so the demo
 * dataset's own reporting tree answers that half. The shape is the same as the
 * server's union: role first, then the tree widens it.
 */
/**
 * A caller's scope on one module and verb, for the in-memory services.
 *
 * The mock has no server to ask and no `hasReports` on `Caller`, so the demo
 * dataset's own reporting tree answers that half. The shape is the same as the
 * server's union: role first, then the tree widens it.
 */
export const callerScope = (
  c: { role: AppRole; meId: string },
  module: string,
  verb: Verb = 'read',
): Scope => scopeOfDemo(c.role, teamOf(c.meId, true).length > 0, module, verb);

/** Does this caller reach `needed` on `module` for `verb`? */
export const callerCovers = (
  c: { role: AppRole; meId: string },
  module: string,
  needed: Scope,
  verb: Verb = 'read',
): boolean => covers(callerScope(c, module, verb), needed);;

/**
 * One module's scope in the demo build, where there is no server to ask.
 *
 * The verb is not a parameter because the demo dataset draws no distinction
 * between reading and writing - it has no enforcement at all, being a
 * demonstration. Anything finer would be invention dressed as a permission.
 */
export const scopeOfDemo = (
  role: AppRole,
  hasReports: boolean,
  module: string,
  verb: Verb = 'read',
): Scope => {
  if (!isAppRole(role)) return 'none';
  const byRole = PERMS[role].includes(module);
  const fromTree = hasReports ? (MANAGER_LAYER[module]?.[verb] ?? 'none') : 'none';
  if (!byRole && fromTree === 'none') return 'none';
  if (role !== 'employee') return 'all';
  /* The layer answers for an employee who has reports; otherwise themselves. */
  return fromTree === 'none' ? 'own' : fromTree;
};

/**
 * Is this actually one of the four roles?
 *
 * It matters because `AppRole` is only a compile-time promise, and the places
 * a role arrives from are not all compiled: a check fixture, a stored row, a
 * JSON payload. A stale 'admin' used to reach `visibleIds`, miss the
 * administrator branch, and fall through to the reporting-tree branch - which
 * answered as though the caller were a manager. That is the worst possible
 * reading of an unknown role, and it is silent.
 */
const ROLES = new Set<string>(['employee', 'hr_admin', 'finance_admin', 'company_admin']);
export const isAppRole = (r: unknown): r is AppRole => typeof r === 'string' && ROLES.has(r);

export interface ScopeInfo {
  label: string;
  desc: string;
}

/** How wide each role's data scope is — surfaced in the UI so it is legible. */
export const SCOPE: Record<AppRole, ScopeInfo> = {
  company_admin: {
    label: 'Organisation-wide',
    desc: 'Everything, and the only role that creates logins, changes a role or '
      + 'configures the tenant.',
  },
  hr_admin: {
    label: 'People, organisation-wide',
    desc: 'The directory, joining and leaving, attendance, leave, performance and '
      + 'the helpdesk. Sets what people are paid; cannot create logins.',
  },
  finance_admin: {
    label: 'Money, organisation-wide',
    desc: 'Payroll, tax, expenses and the commercial book. Sees pay and does not '
      + 'change what people are paid.',
  },
  employee: {
    label: 'Myself',
    desc: 'Your dashboard, attendance, timesheet, payslip, the org chart and your own kit.',
  },
};

/**
 * Modules backed end to end by the API.
 *
 * A configured build shows only these. The rest of the product still runs
 * against the in-memory dataset, and a screen that renders invented helpdesk
 * tickets or invented performance ratings against a real company's login is
 * worse than a screen that is not there: people act on what they read.
 *
 * The demo build is unaffected and still shows everything — it is explicitly
 * a demonstration, with a role switcher and no login.
 *
 * A module joins this list when its service is mapped in
 * `src/services/http/index.ts`, not before.
 *
 * `checks/coverage.ts` derives this from what the API actually backs and fails
 * on either mismatch, because both directions of drift have happened: three
 * services went live and their screens stayed hidden, and a screen stayed
 * listed after its panel was found to be running on the mock.
 */
export const LIVE_MODULES = new Set([
  'dashboard', 'attendance', 'timesheet', 'leave', 'employees', 'org', 'people',
  'celebrations', 'announcements', 'payroll', 'hiring', 'onboarding', 'documents',
  'assets', 'expenses', 'helpdesk', 'performance', 'exit', 'planner', 'settings',
  'shifts', 'tax', 'approvals', 'security', 'learning', 'engagement', 'benefits', 'reports', 'staffing', 'exec',
  'clients', 'requirements', 'bench', 'placements', 'vendors', 'billing',
  /* Added with the 0031-0037 schema and their services. Until these were
     listed they were hidden in any configured build — the backends existed
     and nobody could reach them, which checks/coverage.ts caught. */
  'users', 'recruitment', 'jobtitles', 'lifecycle', 'software', 'devplans',
  'events', 'exports', 'customreports', 'integrations',
  /* Self-service: your own account and your own sign-in history. */
  'account',
]);

/**
 * May this role reach this module?
 *
 * Two gates, not one: the role has to permit it, and — in a configured build —
 * the module has to be backed by real data.
 */
export const can = (
  role: AppRole,
  k: string,
  hasReports = false,
  serverModules?: readonly string[] | null,
): boolean => {
  /*
   * The server's own list wins where there is one. It was computed from the
   * policy, the reporting tree and the tenant's narrowing, so it already
   * answers both of the questions the arguments above exist to answer — and a
   * menu that disagrees with the server is a menu that offers 403s.
   */
  /*
   * Fail closed before anything else, including the manager layer.
   *
   * The guard used to sit only on PERMS[role], so an unrecognised role with
   * reports still collected everything MANAGER_ADDS grants - which went from
   * eight modules to thirty-five and turned a small hole into most of the
   * product. Having reports is not a role, and it cannot stand in for one.
   */
  if (!isAppRole(role)) return false;
  const granted = serverModules && serverModules.length
    ? serverModules.includes(k)
    : PERMS[role].includes(k) || (hasReports && MANAGER_ADDS.includes(k));
  return granted && (!apiConfigured || LIVE_MODULES.has(k));
};

export interface Account {
  role: AppRole;
  empId: string;
  label: string;
}

/**
 * What to call a role in the interface. One place, because "employee",
 * "Employee" and "Self-service" were being written out at each call site and
 * had already drifted into three different words for the same thing.
 */
export const ROLE_LABEL: Record<AppRole, string> = {
  company_admin: 'Company administrator',
  hr_admin: 'HR administrator',
  finance_admin: 'Finance administrator',
  employee: 'Employee',
};

/** The three demo identities the topbar role-switcher signs in as. */
export const ACCOUNTS = (): Account[] => [
  { role: 'company_admin', empId: HRHEAD.id, label: 'Company Administrator' },
  { role: 'hr_admin', empId: HRHEAD.id, label: 'HR Administrator' },
  { role: 'employee', empId: DEMO_MGR.id, label: 'Reporting Manager (has reports)' },
  { role: 'employee', empId: DEMO_EMP.id, label: 'Employee (Self-service)' },
];

/** Employee ids the signed-in user may see: everyone, their tree, or themselves. */
export function visibleIds(role: AppRole, meId: string): string[] {
  /*
   * Breadth by role, then by the tree.
   *
   * It used to read `role === 'manager'` for the team case. Whether somebody
   * answers for other people is now a fact about `manager_id`, so the team
   * branch is taken by anybody who has reports, whatever role they hold — an
   * employee who runs a team, or an HR administrator who does.
   */
  /* Fail closed. An unrecognised role is not a manager. */
  if (!isAppRole(role)) return [meId];
  if (role === 'hr_admin' || role === 'finance_admin' || role === 'company_admin') {
    return ACTIVE().map((e) => e.id);
  }
  const team = teamOf(meId, true);
  if (team.length) return [meId].concat(team);
  return [meId];
}

export function visibleEmps(role: AppRole, meId: string): Employee[] {
  const v = new Set(visibleIds(role, meId));
  return ACTIVE().filter((e) => v.has(e.id));
}

export const isMyReport = (meId: string, id: string): boolean => teamOf(meId, true).includes(id);

export const meOf = (meId: string): Employee => EMAP[meId];

/* ---------------- user administration ---------------- */

/**
 * The individual acts of administering an account.
 *
 * Mirrors `UserAction` in `server/src/auth/policy.ts`. Mirrored rather than
 * imported because the frontend does not depend on server code — it ships to a
 * browser, and the boundary is the point. `checks/roles.ts` compares the two
 * tables and fails the build on any disagreement, which is the same
 * arrangement `PERMS` has had with the module policy since it was written.
 *
 * What these are for: hiding a button somebody may not use. They are not the
 * enforcement — the service refuses the call regardless, and a screen that
 * relies on a hidden button is a screen somebody reaches with a URL.
 */
export type UserAction =
  | 'user.view' | 'user.create' | 'user.request' | 'user.edit' | 'user.delete'
  | 'user.activate' | 'user.deactivate' | 'user.suspend' | 'user.approve'
  | 'user.reset_password' | 'user.resend_invite'
  | 'user.bulk_import' | 'user.bulk_update' | 'user.export'
  | 'role.assign' | 'role.assign_admin' | 'permission.manage';

export type Scope = 'none' | 'own' | 'team' | 'all';

/** The three questions a gate can ask about a module. */
export type Verb = 'read' | 'write' | 'approve';

/** One module's three scopes. Named here rather than imported: the frontend
 * must not depend on server code, so the mirror carries its own shape. */
export type ModuleRule = Record<Verb, Scope>;

const ACTION_SCOPE: Record<UserAction, Record<AppRole | 'manager', Scope>> = {
  /*
   * Reading the user list is the only act below company_admin, and it is where
   * the access table puts it: hr_admin sees every user, somebody with reports
   * sees their line, and neither changes anything.
   */
  'user.view': { employee: 'none', manager: 'team', hr_admin: 'all', finance_admin: 'none', company_admin: 'all' },
  /*
   * Everything else is company_admin's alone — "only company_admin creates
   * logins, assigns or changes roles".
   *
   * A manager used to create accounts, resend invitations, bulk-import and
   * assign roles on their line. They keep raising a joiner, which is
   * `lifecycle`; what they lose is making the account, because that is the act
   * that grants access to the product.
   */
  'user.create': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  /* A request, not an account: theirs for their own line. */
  'user.request': { employee: 'none', manager: 'team', hr_admin: 'all', finance_admin: 'none', company_admin: 'all' },
  'user.edit': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.delete': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.activate': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.deactivate': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.suspend': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.approve': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.reset_password': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.resend_invite': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.bulk_import': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.bulk_update': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'user.export': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'role.assign': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'role.assign_admin': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
  'permission.manage': { employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all' },
};

export const actionScope = (role: AppRole | 'manager', action: UserAction): Scope =>
  ACTION_SCOPE[action]?.[role] ?? 'none';

/** The widest of two scopes, for composing the manager layer onto a role. */
const widerScope = (a: Scope, b: Scope): Scope => {
  const rank: Record<Scope, number> = { none: 0, own: 1, team: 2, all: 3 };
  return rank[a] >= rank[b] ? a : b;
};

/** How far this person reaches, with the layer applied where they have reports. */
export const effectiveActionScope = (
  role: AppRole,
  hasReports: boolean,
  action: UserAction,
): Scope => (hasReports
  ? widerScope(actionScope(role, action), actionScope('manager', action))
  : actionScope(role, action));

/**
 * Whether this person may perform this act at all.
 *
 * Takes `hasReports` because the manager layer grants acts of its own, and
 * the server's `may` has taken it all along. Without it the two sides
 * disagreed about a manager: the client asked the role alone and the server
 * asked the union, so a manager with reports could be offered an act the
 * server would then refuse - or refused one it would have allowed.
 */
export const may = (role: AppRole, hasReports: boolean, action: UserAction): boolean =>
  effectiveActionScope(role, hasReports, action) !== 'none';

/** Whether this role may hand out that role. Only an admin makes an admin. */
/** Whether this person may hand out that role. Mirrors the server exactly. */
export const mayAssignRole = (
  role: AppRole,
  hasReports: boolean,
  granted: AppRole,
): boolean => {
  if (!may(role, hasReports, 'role.assign')) return false;
  return granted === 'employee' ? true : may(role, hasReports, 'role.assign_admin');
};

export const USER_ACTIONS = Object.keys(ACTION_SCOPE) as UserAction[];
