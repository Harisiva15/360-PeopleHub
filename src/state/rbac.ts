import { ACTIVE, DEMO_EMP, DEMO_MGR, EMAP, HRHEAD, teamOf } from '../data/employees';
import type { AppRole, Employee } from '../types/employee';

/** Routes each role may reach. The nav and the router both gate on this. */
export const PERMS: Record<AppRole, string[]> = {
  admin: [
    'dashboard', 'attendance', 'shifts', 'timesheet', 'leave', 'expenses', 'approvals', 'employees', 'org',
    'celebrations', 'announcements', 'helpdesk', 'engagement', 'payroll', 'tax', 'benefits', 'hiring',
    'onboarding', 'performance', 'learning', 'exit', 'reports', 'documents', 'settings', 'assets', 'security',
    'whatsapp', 'clients', 'requirements', 'bench', 'placements', 'billing', 'vendors', 'copilot', 'exec',
  ],
  manager: [
    'dashboard', 'attendance', 'shifts', 'timesheet', 'leave', 'expenses', 'approvals', 'employees', 'org',
    'celebrations', 'announcements', 'helpdesk', 'engagement', 'payroll', 'tax', 'benefits', 'hiring',
    'onboarding', 'performance', 'learning', 'exit', 'reports', 'documents', 'assets', 'whatsapp', 'clients',
    'requirements', 'bench', 'placements', 'vendors', 'copilot',
  ],
  employee: [
    'dashboard', 'attendance', 'shifts', 'timesheet', 'leave', 'expenses', 'employees', 'org', 'celebrations',
    'announcements', 'helpdesk', 'engagement', 'payroll', 'tax', 'benefits', 'performance', 'learning', 'exit',
    'documents', 'assets', 'whatsapp',
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
    desc: 'Full access to every employee record, payroll run and configuration.',
  },
  manager: {
    label: 'My team',
    desc: 'Access limited to your reporting tree — approvals, attendance and hiring for your team.',
  },
  employee: {
    label: 'Myself',
    desc: 'Self-service access to your own attendance, timesheets, leave and payslips.',
  },
};

export const can = (role: AppRole, k: string): boolean => PERMS[role].includes(k);

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
