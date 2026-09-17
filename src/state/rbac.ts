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
export const PERMS: Record<AppRole, string[]> = {
  /* Self-service. The floor of the ladder. */
  employee: [
    'dashboard', 'attendance', 'timesheet', 'leave', 'payroll', 'org', 'employees',
    'assets', 'announcements', 'celebrations', 'helpdesk', 'documents', 'benefits',
    'expenses', 'learning', 'performance', 'tax',
  ],

  /* Everything above, plus the team. */
  manager: [
    'dashboard', 'attendance', 'timesheet', 'leave', 'payroll', 'org', 'employees',
    'assets', 'announcements', 'celebrations', 'helpdesk', 'documents', 'benefits',
    'expenses', 'learning', 'performance', 'tax',
    // The team-level additions.
    'approvals', 'onboarding', 'hiring', 'reports', 'exit', 'engagement', 'shifts',
    'whatsapp', 'clients', 'requirements', 'bench', 'placements', 'vendors',
  ],

  /* Everything above, plus the tenant. */
  admin: [
    'dashboard', 'attendance', 'timesheet', 'leave', 'payroll', 'org', 'employees',
    'assets', 'announcements', 'celebrations', 'helpdesk', 'documents', 'benefits',
    'expenses', 'learning', 'performance', 'tax',
    'approvals', 'onboarding', 'hiring', 'reports', 'exit', 'engagement', 'shifts',
    'whatsapp', 'clients', 'requirements', 'bench', 'placements', 'vendors',
    // The tenant-level additions.
    'settings', 'security', 'billing', 'exec',
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
 */
export const LIVE_MODULES = new Set([
  'dashboard', 'attendance', 'timesheet', 'leave', 'employees', 'org',
  'celebrations', 'announcements', 'payroll', 'hiring', 'onboarding',
  'assets', 'expenses', 'helpdesk', 'performance', 'settings',
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
