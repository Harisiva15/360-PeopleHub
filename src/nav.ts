/**
 * The sidebar.
 *
 * One entry per module, each opening to the views inside it. That is how
 * people say where they are going — "payroll", "recruitment", "the helpdesk" —
 * and it makes the sidebar and the page heading use the same word, so a link
 * and the thing it opens are recognisably one object.
 *
 * An earlier version grouped by whose record a page was about (Me, My team,
 * Org). It read well and it put Leave in three places, which turned the
 * sidebar into something to learn rather than something to scan.
 *
 * **Sub-items are tabs.** `k` is the route and the permission; `to` carries a
 * `?v=` naming the tab. A module with one useful view has no sub-items and is
 * a plain link.
 *
 * **Roles gate both levels.** A route permission is not enough on its own:
 * everybody can reach `/payroll`, because that is where a payslip lives, while
 * the register and the disbursal file inside it belong to whoever runs
 * payroll. Without an item-level gate the menu offers a tab the page will not
 * render.
 */

export type Role = 'employee' | 'manager' | 'admin';

export interface NavItem {
  /** Route key — also the RBAC permission key and the registry key. */
  k: string;
  n: string;
  /** Defaults to `/${k}`; a `?v=` opens the module at a named tab. */
  to?: string;
  /** Who this view is for, when the route permission is broader than the view. */
  roles?: readonly Role[];
}

export interface NavGroup {
  group: string;
  ic: string;
  /** The module this section is — so a section with no sub-items is a link. */
  k: string;
  roles?: readonly Role[];
  /** Open on a first visit; everything else starts shut. */
  open?: boolean;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { group: 'Dashboard', ic: '⌂', k: 'dashboard', items: [] },

  {
    group: 'Internal hiring',
    ic: '◎',
    k: 'hiring',
    roles: ['manager', 'admin'],
    items: [
      { k: 'hiring', n: 'Job requisitions', to: '/hiring?v=reqs' },
      { k: 'hiring', n: 'Candidates', to: '/hiring?v=cands' },
      { k: 'hiring', n: 'Pipeline board', to: '/hiring?v=pipe' },
      { k: 'hiring', n: 'Interviews', to: '/hiring?v=ivs' },
      { k: 'hiring', n: 'Offers', to: '/hiring?v=offers' },
      { k: 'onboarding', n: 'Onboarding' },
      { k: 'hiring', n: 'Reports', to: '/hiring?v=track' },
    ],
  },

  {
    group: 'Employees',
    ic: '👥',
    k: 'employees',
    items: [
      { k: 'employees', n: 'Directory' },
      { k: 'org', n: 'Org chart' },
      { k: 'documents', n: 'Documents & letters' },
      { k: 'exit', n: 'Exit & F&F', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Leave & attendance',
    ic: '◉',
    k: 'attendance',
    open: true,
    items: [
      { k: 'attendance', n: 'My attendance' },
      { k: 'leave', n: 'My leave' },
      { k: 'attendance', n: 'Live board', to: '/attendance?v=live', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Team leave', to: '/leave?v=team', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Approvals', to: '/leave?v=appr', roles: ['manager', 'admin'] },
      { k: 'shifts', n: 'Roster', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Holiday calendar', to: '/leave?v=cal' },
    ],
  },

  {
    group: 'Timesheet',
    ic: '▤',
    k: 'timesheet',
    items: [
      { k: 'timesheet', n: 'Timesheet entry', to: '/timesheet?v=entry' },
      { k: 'timesheet', n: 'My timesheets', to: '/timesheet?v=mine' },
      { k: 'timesheet', n: 'Approvals', to: '/timesheet?v=appr', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Reports', to: '/timesheet?v=rep' },
    ],
  },

  {
    group: 'Payroll',
    ic: '₹',
    k: 'payroll',
    items: [
      { k: 'payroll', n: 'My payslips', to: '/payroll?v=me' },
      { k: 'payroll', n: 'Salary structure', to: '/payroll?v=struct' },
      { k: 'tax', n: 'Tax declaration' },
      { k: 'benefits', n: 'Benefits & flexi' },
      { k: 'expenses', n: 'Expense & travel' },
      { k: 'payroll', n: 'Team cost', to: '/payroll?v=team', roles: ['manager'] },
      { k: 'payroll', n: 'Payroll runs', to: '/payroll?v=runs', roles: ['admin'] },
      { k: 'payroll', n: 'Salary register', to: '/payroll?v=reg', roles: ['admin'] },
      { k: 'payroll', n: 'Payroll inputs', to: '/payroll?v=inputs', roles: ['admin'] },
      { k: 'payroll', n: 'Bank & disbursal', to: '/payroll?v=bank', roles: ['admin'] },
      { k: 'payroll', n: 'Statutory', to: '/payroll?v=stat', roles: ['admin'] },
    ],
  },

  {
    group: 'Performance',
    ic: '◈',
    k: 'performance',
    items: [
      { k: 'performance', n: 'Goals', to: '/performance?v=goals' },
      { k: 'performance', n: 'Reviews', to: '/performance?v=review' },
      { k: 'performance', n: 'Recognition', to: '/performance?v=praise' },
      { k: 'performance', n: 'Team goals', to: '/performance?v=team', roles: ['manager', 'admin'] },
      { k: 'performance', n: 'Calibration', to: '/performance?v=calib', roles: ['manager', 'admin'] },
      { k: 'performance', n: 'Cycle', to: '/performance?v=cycle' },
      { k: 'learning', n: 'Learning' },
    ],
  },

  {
    group: 'Projects',
    ic: '◱',
    k: 'planner',
    items: [
      { k: 'planner', n: 'Board', to: '/planner?v=board' },
      { k: 'planner', n: 'My work', to: '/planner?v=mine' },
      { k: 'planner', n: 'Action items', to: '/planner?v=actions' },
      { k: 'planner', n: 'Iterations', to: '/planner?v=iterations' },
    ],
  },

  { group: 'IT assets', ic: '💻', k: 'assets', items: [] },

  {
    group: 'Engagement',
    ic: '◍',
    k: 'engagement',
    items: [
      { k: 'engagement', n: 'Overview', to: '/engagement?v=results' },
      { k: 'engagement', n: 'Surveys & polls', to: '/engagement?v=open' },
      { k: 'engagement', n: 'Recognition', to: '/engagement?v=recog' },
    ],
  },

  { group: 'Celebrations', ic: '★', k: 'celebrations', items: [] },
  { group: 'Announcements', ic: '⚑', k: 'announcements', items: [] },

  {
    group: 'Helpdesk',
    ic: '◒',
    k: 'helpdesk',
    items: [
      { k: 'helpdesk', n: 'My tickets', to: '/helpdesk?v=my' },
      { k: 'helpdesk', n: 'Knowledge base', to: '/helpdesk?v=kb' },
      { k: 'helpdesk', n: 'Ticket queue', to: '/helpdesk?v=queue', roles: ['manager', 'admin'] },
      { k: 'helpdesk', n: 'SLA & analytics', to: '/helpdesk?v=sla', roles: ['manager', 'admin'] },
    ],
  },

  {
    /*
     * Recruitment absorbed the staffing suite rather than sitting beside it.
     * They were one domain wearing two names: a staffing requirement *is* a job
     * order, a submission is a candidate submission, and a placement is a hire.
     * Two sections meant two front doors onto the same tables, and a recruiter
     * had to know which one a screen lived behind.
     *
     * The views the brief specifies point at the new module; the ones it names
     * but has not specified point at the tab that says so and links onward.
     * Clients, billing and vendors keep their own screens — they are the same
     * book, and rebuilding working pages to move them was never the ask.
     */
    group: 'Recruitment',
    ic: '⬢',
    k: 'recruitment',
    roles: ['admin'],
    items: [
      { k: 'recruitment', n: 'Recruitment dashboard', to: '/recruitment?v=dash' },
      { k: 'recruitment', n: 'Job requisitions', to: '/recruitment?v=reqs' },
      { k: 'recruitment', n: 'My assigned jobs', to: '/recruitment?v=mine' },
      { k: 'recruitment', n: 'Candidates', to: '/recruitment?v=cands' },
      { k: 'recruitment', n: 'Candidate submissions', to: '/recruitment?v=subs' },
      { k: 'recruitment', n: 'Interviews', to: '/recruitment?v=ivs' },
      { k: 'recruitment', n: 'Offers', to: '/recruitment?v=offers' },
      { k: 'placements', n: 'Placements / hires' },
      { k: 'recruitment', n: 'Recruiter activity', to: '/recruitment?v=activity' },
      { k: 'recruitment', n: 'Talent pool', to: '/recruitment?v=pool' },
      { k: 'clients', n: 'Clients & accounts' },
      { k: 'recruitment', n: 'Recruitment reports', to: '/recruitment?v=reports' },
      { k: 'requirements', n: 'Requirements (legacy view)' },
      { k: 'bench', n: 'Bench & consultants' },
      { k: 'billing', n: 'Billing & AR' },
      { k: 'vendors', n: 'Vendors' },
    ],
  },

  {
    group: 'Reports',
    ic: '▥',
    k: 'reports',
    roles: ['manager', 'admin'],
    items: [
      { k: 'reports', n: 'Reports' },
      { k: 'exec', n: 'Executive view' },
      { k: 'approvals', n: 'Approvals' },
    ],
  },


  {
    group: 'Settings',
    ic: '⚙',
    k: 'settings',
    roles: ['admin'],
    items: [
      { k: 'settings', n: 'Settings & RBAC' },
      { k: 'security', n: 'Security & audit' },
    ],
  },
];

/** The five routes that get a bottom tab on a phone. */
export const TABBAR = ['dashboard', 'attendance', 'timesheet', 'leave', 'approvals'];

/**
 * Every route, once.
 *
 * A section's own `k` counts even when it has no sub-items — that is what
 * makes Dashboard and IT assets reachable — and the set folds away the modules
 * that appear in more than one section.
 */
export const ALL_ROUTES: string[] = [
  ...new Set(NAV.flatMap((g) => [g.k, ...g.items.map((i) => i.k)])),
];

/** Where an item points — the route itself unless it named a tab. */
export const hrefOf = (i: NavItem): string => i.to ?? `/${i.k}`;

/**
 * The header's quick-action menu, named by the view each one opens.
 *
 * Names rather than URLs, resolved against `NAV` at render time: a hard-coded
 * `?v=` in the header is a dead link the moment a tab is renamed, which is
 * exactly how the timesheet's own menu entries went stale when its tabs were
 * rebuilt. `checks/routes.tsx` asserts every name here still resolves, so a
 * rename fails the build instead of quietly emptying the menu.
 *
 * Each is filtered by role at render time — this list is what the product
 * offers, not what any one person gets.
 */
export const QUICK_ACTIONS = [
  'My leave', 'Timesheet entry', 'My attendance', 'Expense & travel',
  'My tickets', 'My payslips', 'Directory',
] as const;
