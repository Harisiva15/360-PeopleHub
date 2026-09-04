export interface NavItem {
  /** Route key — also the RBAC permission key and the registry key. */
  k: string;
  ic: string;
  n: string;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

/** Sidebar structure. Items the signed-in role cannot reach are filtered out. */
export const NAV: NavGroup[] = [
  {
    group: 'Workspace',
    items: [
      { k: 'dashboard', ic: '◈', n: 'Dashboard' },
      { k: 'attendance', ic: '◉', n: 'Attendance & Geo' },
      { k: 'shifts', ic: '◑', n: 'Shifts & Roster' },
      { k: 'timesheet', ic: '▤', n: 'Timesheet' },
      { k: 'leave', ic: '↗', n: 'Leave' },
      { k: 'expenses', ic: '🧾', n: 'Expenses' },
      { k: 'approvals', ic: '✓', n: 'Approvals' },
    ],
  },
  {
    group: 'People',
    items: [
      { k: 'employees', ic: '☰', n: 'Employee Directory' },
      { k: 'org', ic: '⌘', n: 'Org Chart' },
      { k: 'celebrations', ic: '★', n: 'Celebrations' },
      { k: 'announcements', ic: '⚑', n: 'Announcements' },
      { k: 'engagement', ic: '◍', n: 'Engagement' },
      { k: 'assets', ic: '💻', n: 'IT Assets' },
      { k: 'whatsapp', ic: '💬', n: 'WhatsApp' },
      { k: 'helpdesk', ic: '◒', n: 'Helpdesk' },
    ],
  },
  {
    group: 'Payroll',
    items: [
      { k: 'payroll', ic: '₹', n: 'Payroll & Payslips' },
      { k: 'tax', ic: '%', n: 'Tax Declaration' },
      { k: 'benefits', ic: '♡', n: 'Benefits & Flexi' },
    ],
  },
  {
    group: 'Talent',
    items: [
      { k: 'performance', ic: '◈', n: 'Performance' },
      { k: 'learning', ic: '◉', n: 'Learning' },
      { k: 'hiring', ic: '◎', n: 'Hiring (ATS)' },
      { k: 'onboarding', ic: '⇥', n: 'Onboarding' },
      { k: 'exit', ic: '⇤', n: 'Exit & F&F' },
    ],
  },
  {
    group: 'Staffing',
    items: [
      { k: 'clients', ic: '⬢', n: 'Clients & SOW' },
      { k: 'requirements', ic: '⌗', n: 'Requirements' },
      { k: 'bench', ic: '◔', n: 'Bench & Consultants' },
      { k: 'placements', ic: '⇉', n: 'Placements' },
      { k: 'billing', ic: '⌸', n: 'Billing & AR' },
      { k: 'vendors', ic: '⬡', n: 'Vendors' },
    ],
  },
  {
    group: 'Insights',
    items: [
      { k: 'copilot', ic: '✨', n: 'AI Copilot' },
      { k: 'exec', ic: '◮', n: 'Executive View' },
      { k: 'reports', ic: '▥', n: 'Reports' },
      { k: 'documents', ic: '▧', n: 'Documents & Letters' },
      { k: 'security', ic: '⚿', n: 'Security & Audit' },
      { k: 'settings', ic: '⚙', n: 'Settings & RBAC' },
    ],
  },
];

/** The five routes that get a bottom tab on a phone. */
export const TABBAR = ['dashboard', 'attendance', 'timesheet', 'leave', 'approvals'];

export const ALL_ROUTES: string[] = NAV.flatMap((g) => g.items.map((i) => i.k));
