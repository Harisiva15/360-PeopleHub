/**
 * The sidebar.
 *
 * One entry per area of the product, each opening its views in a panel beside
 * the rail. The rail holds nothing but top-level items and never changes
 * height — no section expands inside it, because an accordion in a sidebar
 * pushes everything below it down the screen, and the item somebody is
 * reaching for moves while they reach for it.
 *
 * An earlier version grouped by whose record a page was about (Me, My team,
 * Org). It read well and it put Leave in three places, which turned the
 * sidebar into something to learn rather than something to scan.
 *
 * **Sub-items are tabs.** `k` is the route and the permission; `to` carries a
 * `?v=` naming the tab. A group with no items is a plain link.
 *
 * **Roles gate both levels.** A route permission is not enough on its own:
 * everybody can reach `/payroll`, because that is where a payslip lives, while
 * the register and the disbursal file inside it belong to whoever runs
 * payroll. Without an item-level gate the menu offers a tab the page will not
 * render.
 *
 * **Every item names a view that exists.** The flyout is where somebody looks
 * when they cannot find something, so a plausible entry that goes nowhere is
 * worse than an absent one — they stop trusting the menu. Views the product
 * does not have yet are simply not listed.
 */

import type { IconName } from './components/icons';

export type Role = 'employee' | 'manager' | 'admin';

export interface NavItem {
  /** Route key — also the RBAC permission key and the registry key. */
  k: string;
  n: string;
  /** Defaults to `/${k}`; a `?v=` opens the module at a named tab. */
  to?: string;
  /** One line under the title in the flyout. What the view is for. */
  d?: string;
  /** Name in `src/components/icons.tsx`. */
  ic?: IconName;
  /** Who this view is for, when the route permission is broader than the view. */
  roles?: readonly Role[];
}

export interface NavGroup {
  group: string;
  /** Name in `src/components/icons.tsx`, not a glyph. */
  ic: IconName;
  /** The module this section is — so a section with no sub-items is a link. */
  k: string;
  /** The line under the title in the flyout's header. */
  desc?: string;
  roles?: readonly Role[];
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  { group: 'Dashboard', ic: 'dashboard', k: 'dashboard', items: [] },

  {
    group: 'Employees',
    ic: 'employees',
    k: 'employees',
    desc: 'Manage your people, organisation and employee records.',
    items: [
      { k: 'employees', n: 'Employee directory', ic: 'people', d: 'Find and contact colleagues.' },
      { k: 'org', n: 'Organisation chart', ic: 'projects', d: 'See who reports to whom.' },
      { k: 'documents', n: 'Documents & letters', ic: 'document', d: 'Issue and track employee paperwork.' },
      { k: 'onboarding', n: 'Onboarding', ic: 'joiner', d: 'Bring new joiners through their first weeks.', roles: ['manager', 'admin'] },
      { k: 'exit', n: 'Exit & final settlement', ic: 'undo', d: 'Offboard leavers and settle their dues.', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Leave & attendance',
    ic: 'attendance',
    k: 'attendance',
    desc: 'Hours worked, days off, and who is in today.',
    items: [
      { k: 'attendance', n: 'My attendance', ic: 'clock', d: 'Punch in and out, and see your month.' },
      { k: 'leave', n: 'My leave', ic: 'holiday', d: 'Apply for leave and check your balance.' },
      { k: 'attendance', n: 'Live board', to: '/attendance?v=live', ic: 'people', d: 'Who is in, out or remote right now.', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Team leave', to: '/leave?v=team', ic: 'team', d: 'Your line’s leave, in one calendar.', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Leave approvals', to: '/leave?v=appr', ic: 'done', d: 'Decide the requests waiting on you.', roles: ['manager', 'admin'] },
      { k: 'shifts', n: 'Roster', ic: 'schedule', d: 'Plan shifts and working patterns.', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Holiday calendar', to: '/leave?v=cal', ic: 'calendar', d: 'Public holidays by location.' },
    ],
  },

  {
    group: 'Timesheet',
    ic: 'timesheet',
    k: 'timesheet',
    desc: 'Track work hours, projects and approvals.',
    items: [
      { k: 'timesheet', n: 'Timesheet entry', to: '/timesheet?v=entry', ic: 'note', d: 'Log this week’s hours.' },
      { k: 'timesheet', n: 'My timesheets', to: '/timesheet?v=mine', ic: 'document', d: 'Every week you have submitted.' },
      { k: 'timesheet', n: 'Approvals', to: '/timesheet?v=appr', ic: 'done', d: 'Decide your team’s weeks.', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Time reports', to: '/timesheet?v=rep', ic: 'chart', d: 'Utilisation and effort by project.' },
    ],
  },

  {
    group: 'Payroll',
    ic: 'payroll',
    k: 'payroll',
    desc: 'Pay, tax, benefits and what you are owed.',
    items: [
      { k: 'payroll', n: 'My payslips', to: '/payroll?v=me', ic: 'payslip', d: 'Download any month’s payslip.' },
      { k: 'payroll', n: 'Salary details', to: '/payroll?v=struct', ic: 'money', d: 'How your package is made up.' },
      { k: 'tax', n: 'Tax declarations', ic: 'tax', d: 'Declare investments and claim exemptions.' },
      { k: 'benefits', n: 'Benefits & flexi', ic: 'gift', d: 'Allocate your flexible benefit pot.' },
      { k: 'expenses', n: 'Reimbursements', ic: 'invoice', d: 'Claim expenses and travel.' },
      { k: 'payroll', n: 'Team cost', to: '/payroll?v=team', ic: 'team', d: 'What your line costs.', roles: ['manager'] },
      { k: 'payroll', n: 'Payroll runs', to: '/payroll?v=runs', ic: 'refresh', d: 'Open, process and close a cycle.', roles: ['admin'] },
      { k: 'payroll', n: 'Salary register', to: '/payroll?v=reg', ic: 'document', d: 'Every payslip in the cycle.', roles: ['admin'] },
      { k: 'payroll', n: 'Payroll inputs', to: '/payroll?v=inputs', ic: 'note', d: 'Overtime, deductions and one-offs.', roles: ['admin'] },
      { k: 'payroll', n: 'Bank & disbursal', to: '/payroll?v=bank', ic: 'bank', d: 'Build and release the payment file.', roles: ['admin'] },
      { k: 'payroll', n: 'Statutory', to: '/payroll?v=stat', ic: 'policy', d: 'PF, ESI and tax remittances.', roles: ['admin'] },
    ],
  },

  {
    group: 'Assets',
    ic: 'assets',
    k: 'assets',
    desc: 'Kit issued to people, and what is left in stock.',
    items: [],
  },

  {
    group: 'Performance',
    ic: 'performance',
    k: 'performance',
    desc: 'Goals, reviews, recognition and growth.',
    items: [
      { k: 'performance', n: 'My goals', to: '/performance?v=goals', ic: 'target', d: 'What you are working towards.' },
      { k: 'performance', n: 'Performance reviews', to: '/performance?v=review', ic: 'note', d: 'Write and read review cycles.' },
      { k: 'performance', n: 'Recognition', to: '/performance?v=praise', ic: 'trophy', d: 'Praise colleagues, and read yours.' },
      { k: 'performance', n: 'Team goals', to: '/performance?v=team', ic: 'team', d: 'Where your line stands.', roles: ['manager', 'admin'] },
      { k: 'performance', n: 'Calibration', to: '/performance?v=calib', ic: 'chart', d: 'Compare ratings across the team.', roles: ['manager', 'admin'] },
      { k: 'performance', n: 'Review cycle', to: '/performance?v=cycle', ic: 'schedule', d: 'Where the current cycle has got to.' },
      { k: 'learning', n: 'Learning', ic: 'learning', d: 'Courses, enrolments and progress.' },
    ],
  },

  {
    group: 'Projects',
    ic: 'projects',
    k: 'planner',
    desc: 'Work in flight, and who is carrying it.',
    items: [
      { k: 'planner', n: 'Board', to: '/planner?v=board', ic: 'grid', d: 'Everything in progress, by column.' },
      { k: 'planner', n: 'My work', to: '/planner?v=mine', ic: 'person', d: 'What is assigned to you.' },
      { k: 'planner', n: 'Action items', to: '/planner?v=actions', ic: 'goal', d: 'Follow-ups and their owners.' },
      { k: 'planner', n: 'Iterations', to: '/planner?v=iterations', ic: 'refresh', d: 'Sprints and what each delivered.' },
    ],
  },

  {
    group: 'Recruitment',
    ic: 'recruitment',
    k: 'recruitment',
    desc: 'Job orders, candidates and the desk working them.',
    roles: ['admin'],
    items: [
      { k: 'recruitment', n: 'Recruitment dashboard', to: '/recruitment?v=dash', ic: 'chart', d: 'Open demand, the funnel and what is late.' },
      { k: 'recruitment', n: 'Job requisitions', to: '/recruitment?v=reqs', ic: 'goal', d: 'Every order, its SLA and its desk.' },
      { k: 'recruitment', n: 'My assigned jobs', to: '/recruitment?v=mine', ic: 'person', d: 'The orders on your desk.' },
      { k: 'recruitment', n: 'Candidates', to: '/recruitment?v=cands', ic: 'people', d: 'People you can put forward.' },
      { k: 'recruitment', n: 'Candidate submissions', to: '/recruitment?v=subs', ic: 'submission', d: 'Profiles with the client.' },
      { k: 'recruitment', n: 'Interviews', to: '/recruitment?v=ivs', ic: 'schedule', d: 'Booked, done and awaiting feedback.' },
      { k: 'recruitment', n: 'Offers', to: '/recruitment?v=offers', ic: 'mail', d: 'Released, accepted and declined.' },
      { k: 'placements', n: 'Placements', ic: 'done', d: 'Consultants on assignment.' },
      { k: 'recruitment', n: 'Recruiter activity', to: '/recruitment?v=activity', ic: 'timer', d: 'What each desk has produced.' },
      { k: 'recruitment', n: 'Talent pool', to: '/recruitment?v=pool', ic: 'star', d: 'People worth going back to.' },
      { k: 'clients', n: 'Clients & accounts', ic: 'client', d: 'Accounts, contacts and their SOWs.' },
      { k: 'recruitment', n: 'Recruitment reports', to: '/recruitment?v=rep', ic: 'reports', d: 'Conversion, ageing and fill rate.' },
      { k: 'bench', n: 'Bench & consultants', ic: 'briefcase', d: 'Who is available, and for how long.' },
      { k: 'billing', n: 'Billing & AR', ic: 'invoice', d: 'Invoices raised and money owed.' },
      { k: 'vendors', n: 'Vendors', ic: 'building', d: 'Supplier panel and their performance.' },
      { k: 'requirements', n: 'Requirements (legacy)', ic: 'document', d: 'The earlier requirements view.' },
    ],
  },

  {
    group: 'Internal hiring',
    ic: 'hiring',
    k: 'hiring',
    desc: 'Filling our own roles, rather than a client’s.',
    roles: ['manager', 'admin'],
    items: [
      { k: 'hiring', n: 'Job requisitions', to: '/hiring?v=reqs', ic: 'goal', d: 'Roles we are hiring for ourselves.' },
      { k: 'hiring', n: 'Candidates', to: '/hiring?v=cands', ic: 'people', d: 'Applicants and where they are.' },
      { k: 'hiring', n: 'Pipeline board', to: '/hiring?v=pipe', ic: 'grid', d: 'The funnel, stage by stage.' },
      { k: 'hiring', n: 'Interviews', to: '/hiring?v=ivs', ic: 'schedule', d: 'Panels, slots and feedback.' },
      { k: 'hiring', n: 'Offers', to: '/hiring?v=offers', ic: 'mail', d: 'Offers out and their outcomes.' },
      { k: 'hiring', n: 'Hiring reports', to: '/hiring?v=track', ic: 'reports', d: 'Time to hire and source quality.' },
    ],
  },

  {
    group: 'Engagement',
    ic: 'engagement',
    k: 'engagement',
    desc: 'Celebrations, recognition and how people are feeling.',
    items: [
      { k: 'celebrations', n: 'Celebrations', ic: 'party', d: 'Birthdays, anniversaries and joiners.' },
      { k: 'announcements', n: 'Announcements', ic: 'announcements', d: 'What the company is telling everyone.' },
      { k: 'engagement', n: 'Engagement overview', to: '/engagement?v=results', ic: 'chart', d: 'How the last survey landed.' },
      { k: 'engagement', n: 'Surveys & polls', to: '/engagement?v=open', ic: 'vote', d: 'Open questions waiting on you.' },
      { k: 'engagement', n: 'Recognition', to: '/engagement?v=recog', ic: 'applause', d: 'Who has been thanked lately.' },
    ],
  },

  {
    group: 'Company',
    ic: 'building',
    k: 'helpdesk',
    desc: 'Policies, the knowledge base and where to ask for help.',
    items: [
      { k: 'helpdesk', n: 'Helpdesk', to: '/helpdesk?v=my', ic: 'helpdesk', d: 'Raise a ticket and track it.' },
      { k: 'helpdesk', n: 'Knowledge base', to: '/helpdesk?v=kb', ic: 'policy', d: 'Policies and how-to articles.' },
      { k: 'helpdesk', n: 'Ticket queue', to: '/helpdesk?v=queue', ic: 'inbox', d: 'Everything waiting on your team.', roles: ['manager', 'admin'] },
      { k: 'helpdesk', n: 'SLA & analytics', to: '/helpdesk?v=sla', ic: 'timer', d: 'Response times against target.', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Reports',
    ic: 'reports',
    k: 'reports',
    desc: 'The numbers, across every module.',
    roles: ['manager', 'admin'],
    items: [
      { k: 'reports', n: 'All reports', ic: 'reports', d: 'Every report, by area.' },
      { k: 'exec', n: 'Executive view', ic: 'chart', d: 'The company on one page.', roles: ['admin'] },
    ],
  },

  {
    group: 'Administration',
    ic: 'settings',
    k: 'settings',
    desc: 'Accounts, permissions and how the tenant is configured.',
    roles: ['admin'],
    items: [
      { k: 'users', n: 'User management', ic: 'person', d: 'Create, approve and retire accounts.' },
      { k: 'settings', n: 'Settings & RBAC', ic: 'settings', d: 'Roles, permissions and configuration.' },
      { k: 'security', n: 'Security & audit', ic: 'lock', d: 'The audit trail and access review.' },
      { k: 'approvals', n: 'Approvals', ic: 'done', d: 'Everything waiting on a decision.' },
    ],
  },
];

export const TABBAR = ['dashboard', 'attendance', 'timesheet', 'leave', 'approvals'];

/**
 * Every route the navigation can reach. Deduplicated, because a module can
 * appear in more than one section.
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
  'My leave', 'Timesheet entry', 'My attendance', 'Reimbursements',
  'Helpdesk', 'My payslips', 'Employee directory',
] as const;

/**
 * Every view in the product, flattened, for the sidebar's search.
 *
 * Searching section names alone would mean knowing that "disbursal" lives
 * under Payroll before you could find it — which is the thing somebody
 * searching has already failed to do.
 */
export interface NavHit {
  group: string;
  groupKey: string;
  groupIcon: IconName;
  item: NavItem;
  href: string;
}

export const ALL_VIEWS: NavHit[] = NAV.flatMap((g) =>
  g.items.map((i) => ({
    group: g.group,
    groupKey: g.k,
    groupIcon: g.ic,
    item: i,
    href: hrefOf(i),
  })),
);
