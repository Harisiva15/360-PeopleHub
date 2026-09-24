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
export const PERMS: Record<AppRole, string[]> = {
  /* Self-service. Their own work, and what the company shares. */
  employee: [
    'dashboard', 'attendance', 'timesheet', 'leave', 'shifts', 'payroll', 'tax',
    'benefits', 'expenses', 'assets', 'helpdesk', 'documents', 'learning',
    'performance', 'org', 'employees', 'announcements', 'celebrations', 'planner', 'jobtitles', 'lifecycle', 'software', 'devplans', 'events',
    // Answering a survey is an employee's, and was the one thing in Engagement
    // they were meant to do. The module sat manager-and-above because it reads
    // as reporting; the Submit button did nothing, so nobody noticed.
    'engagement',
    'account',
  ],

  /* Everything above, plus their reporting line. */
  manager: [
    'dashboard', 'attendance', 'timesheet', 'leave', 'shifts', 'payroll', 'tax',
    'benefits', 'expenses', 'assets', 'helpdesk', 'documents', 'learning',
    'performance', 'org', 'employees', 'announcements', 'celebrations', 'planner', 'jobtitles', 'lifecycle', 'software', 'devplans', 'events', 'exports', 'customreports',
    // The line.
    'approvals', 'onboarding', 'hiring', 'reports', 'exit', 'engagement', 'users', 'account',
  ],

  /*
   * Everything above, plus the tenant.
   *
   * Staffing — clients, requirements, bench, placements, vendors — is here and
   * nowhere else. Bill rates, credit limits and vendor markups are commercial
   * terms, and the staffing service refuses anybody but an admin outright.
   * Managers used to be offered all five and got a page of refusals on each.
   */
  admin: [
    'dashboard', 'attendance', 'timesheet', 'leave', 'shifts', 'payroll', 'compensation', 'tax',
    'benefits', 'expenses', 'assets', 'helpdesk', 'documents', 'learning',
    'performance', 'org', 'employees', 'announcements', 'celebrations', 'planner', 'jobtitles', 'lifecycle', 'software', 'devplans', 'events', 'exports', 'customreports', 'integrations',
    'approvals', 'onboarding', 'hiring', 'reports', 'exit', 'engagement', 'users', 'account',
    // The tenant.
    'settings', 'security', 'exec', 'billing',
    'clients', 'requirements', 'bench', 'placements', 'vendors', 'recruitment',
  ],
};

export interface ScopeInfo {
  label: string;
  desc: string;
}

/** How wide each role's data scope is — surfaced in the UI so it is legible. */
export const SCOPE: Record<AppRole, ScopeInfo> = {
  admin: {
    label: 'Organisation-wide',
    desc: 'Creates and modifies people, runs payroll, configures the tenant and reads every report.',
  },
  manager: {
    label: 'My team',
    desc: 'Raises joining requests, approves leave, timesheets and expenses, and reads the trackers — '
      + 'all within your reporting tree.',
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
export const can = (role: AppRole, k: string): boolean =>
  PERMS[role].includes(k) && (!apiConfigured || LIVE_MODULES.has(k));

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
  admin: 'Administrator',
  manager: 'Manager',
  employee: 'Employee',
};

/** The three demo identities the topbar role-switcher signs in as. */
export const ACCOUNTS = (): Account[] => [
  { role: 'admin', empId: HRHEAD.id, label: 'HR Administrator' },
  { role: 'manager', empId: DEMO_MGR.id, label: 'Reporting Manager' },
  { role: 'employee', empId: DEMO_EMP.id, label: 'Employee (Self-service)' },
];

/** Employee ids the signed-in user may see: everyone, their tree, or themselves. */
export function visibleIds(role: AppRole, meId: string): string[] {
  if (role === 'admin') return ACTIVE().map((e) => e.id);
  if (role === 'manager') return [meId].concat(teamOf(meId, true));
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
  | 'user.view' | 'user.create' | 'user.edit' | 'user.delete'
  | 'user.activate' | 'user.deactivate' | 'user.suspend' | 'user.approve'
  | 'user.reset_password' | 'user.resend_invite'
  | 'user.bulk_import' | 'user.bulk_update' | 'user.export'
  | 'role.assign' | 'role.assign_admin' | 'permission.manage';

export type Scope = 'none' | 'own' | 'team' | 'all';

const ACTION_SCOPE: Record<UserAction, Record<AppRole, Scope>> = {
  'user.view': { employee: 'none', manager: 'team', admin: 'all' },
  'user.create': { employee: 'none', manager: 'team', admin: 'all' },
  'user.edit': { employee: 'none', manager: 'team', admin: 'all' },
  'user.delete': { employee: 'none', manager: 'none', admin: 'all' },
  'user.activate': { employee: 'none', manager: 'none', admin: 'all' },
  'user.deactivate': { employee: 'none', manager: 'team', admin: 'all' },
  'user.suspend': { employee: 'none', manager: 'none', admin: 'all' },
  'user.approve': { employee: 'none', manager: 'none', admin: 'all' },
  'user.reset_password': { employee: 'none', manager: 'none', admin: 'all' },
  'user.resend_invite': { employee: 'none', manager: 'team', admin: 'all' },
  'user.bulk_import': { employee: 'none', manager: 'team', admin: 'all' },
  'user.bulk_update': { employee: 'none', manager: 'team', admin: 'all' },
  'user.export': { employee: 'none', manager: 'team', admin: 'all' },
  'role.assign': { employee: 'none', manager: 'team', admin: 'all' },
  'role.assign_admin': { employee: 'none', manager: 'none', admin: 'all' },
  'permission.manage': { employee: 'none', manager: 'none', admin: 'all' },
};

export const actionScope = (role: AppRole, action: UserAction): Scope =>
  ACTION_SCOPE[action]?.[role] ?? 'none';

/** Whether this role may perform this act at all. */
export const may = (role: AppRole, action: UserAction): boolean =>
  actionScope(role, action) !== 'none';

/** Whether this role may hand out that role. Only an admin makes an admin. */
export const mayAssignRole = (role: AppRole, granted: AppRole): boolean => {
  if (!may(role, 'role.assign')) return false;
  return granted === 'admin' ? may(role, 'role.assign_admin') : true;
};

export const USER_ACTIONS = Object.keys(ACTION_SCOPE) as UserAction[];
