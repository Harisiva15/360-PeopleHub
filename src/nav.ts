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
    group: 'People',
    ic: 'employees',
    k: 'employees',
    desc: 'Manage your people, organisation and employee records.',
    items: [
      { k: 'account', n: 'My account', ic: 'lock', d: 'Your sign-in details and every session opened against your account.' },
      { k: 'employees', n: 'Employee directory', ic: 'people', d: 'Find and contact colleagues.' },
      { k: 'org', n: 'Organisation chart', ic: 'projects', d: 'See who reports to whom.' },
      { k: 'jobtitles', n: 'Job titles', ic: 'briefcase', d: 'Titles, levels and who holds them.' },
      { k: 'lifecycle', n: 'Employee lifecycle', ic: 'swap', d: 'Where everyone is, from offer to alumni.' },
      { k: 'documents', n: 'Documents & letters', ic: 'document', d: 'Issue and track employee paperwork.' },
      { k: 'onboarding', n: 'Onboarding', ic: 'joiner', d: 'Bring new joiners through their first weeks.', roles: ['manager', 'admin'] },
      { k: 'exit', n: 'Exit & final settlement', ic: 'undo', d: 'Offboard leavers and settle their dues.', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Time & attendance',
    ic: 'attendance',
    k: 'attendance',
    desc: 'Hours worked, days off, timesheets and who is in today.',
    items: [
      { k: 'attendance', n: 'My attendance', ic: 'clock', d: 'Punch in and out, and see your month.' },
      { k: 'leave', n: 'My leave', ic: 'holiday', d: 'Apply for leave and check your balance.' },
      { k: 'attendance', n: 'Live board', to: '/attendance?v=live', ic: 'people', d: 'Who is in, out or remote right now.', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Team leave', to: '/leave?v=team', ic: 'team', d: 'Your line’s leave, in one calendar.', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Leave approvals', to: '/leave?v=appr', ic: 'done', d: 'Decide the requests waiting on you.', roles: ['manager', 'admin'] },
      { k: 'shifts', n: 'Roster', ic: 'schedule', d: 'Plan shifts and working patterns.', roles: ['manager', 'admin'] },
      { k: 'attendance', n: 'Attendance regularisation', to: '/attendance?v=reg', ic: 'undo', d: 'Correct a missed punch or a wrong day.' },
      { k: 'leave', n: 'Holiday calendar', to: '/leave?v=cal', ic: 'calendar', d: 'Public holidays by location.' },
    ],
  },

  {
    group: 'Timesheet',
    ic: 'note',
    k: 'timesheet',
    desc: 'What you worked on, by week, and whose weeks are waiting on you.',
    items: [
      { k: 'timesheet', n: 'My timesheet', to: '/timesheet?v=entry', ic: 'note', d: 'Log this week’s hours.' },
      { k: 'timesheet', n: 'Time entries', to: '/timesheet?v=entries', ic: 'document', d: 'Every line you have logged, filterable.' },
      { k: 'timesheet', n: 'Calendar', to: '/timesheet?v=cal', ic: 'calendar', d: 'Your weeks at a glance, and the ones you have not started.' },
      { k: 'timesheet', n: 'History', to: '/timesheet?v=hist', ic: 'clock', d: 'Every week you have submitted.' },
      /*
       * The four below read somebody else's week, which the policy grants a
       * manager ('team') and an admin ('all') and an employee not at all. The
       * service scopes every read again — this only stops offering a screen
       * that would come back empty.
       */
      { k: 'timesheet', n: 'Team timesheets', to: '/timesheet?v=team', ic: 'team', d: 'Your line’s weeks, with hours and status.', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Pending approvals', to: '/timesheet?v=appr', ic: 'done', d: 'Decide your team’s weeks.', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Projects', to: '/timesheet?v=proj', ic: 'projects', d: 'What time can be booked against.', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Reports', to: '/timesheet?v=rep', ic: 'chart', d: 'Utilisation and effort by project.', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Compensation',
    ic: 'payroll',
    k: 'payroll',
    desc: 'Pay, tax, benefits and what you are owed.',
    items: [
      { k: 'payroll', n: 'My payslips', to: '/payroll?v=me', ic: 'payslip', d: 'Download any month’s payslip.' },
      { k: 'payroll', n: 'Salary details', to: '/payroll?v=struct', ic: 'money', d: 'How your package is made up.', roles: ['employee', 'manager'] },
      /*
       * The same tab, named for what an admin does there. For everyone else it
       * shows their own package; for an admin it is the compensation master,
       * where a salary is set and its history read. One route, two audiences,
       * so the label says which one is reading.
       */
      { k: 'payroll', n: 'Compensation', to: '/payroll?v=struct', ic: 'money', d: 'Set salaries and read what they were before.', roles: ['admin'] },
      { k: 'tax', n: 'Tax declarations', ic: 'tax', d: 'Declare investments and claim exemptions.' },
      { k: 'benefits', n: 'Benefits & flexi', ic: 'gift', d: 'Allocate your flexible benefit pot.' },
      { k: 'expenses', n: 'Reimbursements', ic: 'invoice', d: 'Claim expenses and travel.' },
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
    items: [
      { k: 'assets', n: 'Asset register', to: '/assets?v=reg', ic: 'laptop', d: 'Every asset, where it is and who holds it.' },
      { k: 'assets', n: 'Issue & return', to: '/assets?v=alloc', ic: 'swap', d: 'Hand kit out, and take it back.' },
      { k: 'software', n: 'Software assets', ic: 'puzzle', d: 'Licences, seats and what renews next.' },
      { k: 'software', n: 'Renewals', to: '/software?v=renewals', ic: 'clock', d: 'What the company re-signs, and when.', roles: ['manager', 'admin'] },
      { k: 'software', n: 'Idle seats', to: '/software?v=dormant', ic: 'warn', d: 'Seats nobody opens, and their cost.', roles: ['manager', 'admin'] },
    ],
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
      { k: 'devplans', n: 'Development plans', ic: 'rocket', d: 'Where people are heading, and how.' },
      { k: 'devplans', n: 'Mentors', to: '/devplans?v=mentors', ic: 'people', d: 'Who is mentoring whom, and the load.', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Work',
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
      { k: 'recruitment', n: 'Recruitment reports', to: '/recruitment?v=reports', ic: 'reports', d: 'Conversion, ageing and fill rate.' },
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
      { k: 'events', n: 'Company events', ic: 'calendar', d: 'What is on, and whether you are coming.' },
      { k: 'events', n: 'My events', to: '/events?v=mine', ic: 'schedule', d: 'Everything you have said yes to.' },
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
      { k: 'reports', n: 'Attendance reports', to: '/reports?v=attendance', ic: 'attendance', d: 'Presence, WFH, late marks and absence.' },
      { k: 'reports', n: 'Leave reports', to: '/reports?v=leave', ic: 'holiday', d: 'Balances, utilisation and liability.' },
      { k: 'reports', n: 'Timesheet reports', to: '/reports?v=utilisation', ic: 'timesheet', d: 'Billable against non-billable effort.' },
      { k: 'reports', n: 'Payroll reports', to: '/reports?v=payroll', ic: 'payroll', d: 'Gross, deductions and net by month.', roles: ['admin'] },
      { k: 'reports', n: 'Employee reports', to: '/reports?v=headcount', ic: 'people', d: 'Headcount and distribution.' },
      { k: 'reports', n: 'Hiring reports', to: '/reports?v=hiring', ic: 'hiring', d: 'Funnel, source quality and time to hire.' },
      { k: 'reports', n: 'Attrition & retention', to: '/reports?v=attrition', ic: 'down', d: 'Exits, reasons and tenure.', roles: ['admin'] },
      { k: 'reports', n: 'Performance & talent', to: '/reports?v=talent', ic: 'performance', d: 'Ratings, goals and recognition.' },
      { k: 'reports', n: 'Expense & cost', to: '/reports?v=spend', ic: 'invoice', d: 'Claims, loans and cost per head.', roles: ['admin'] },
      { k: 'reports', n: 'Statutory compliance', to: '/reports?v=compliance', ic: 'policy', d: 'PF, ESI, PT and TDS remittances.', roles: ['admin'] },
      { k: 'exports', n: 'Export centre', ic: 'download', d: 'Take data out, and see who has.' },
      { k: 'exports', n: 'Export register', to: '/exports?v=register', ic: 'policy', d: 'What left, when, and who took it.' },
      { k: 'customreports', n: 'Custom reports', ic: 'grid', d: 'Questions somebody saved, run as you.' },
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
      { k: 'settings', n: 'Roles & permissions', to: '/settings?v=rbac', ic: 'lock', d: 'What each role may reach.' },
      { k: 'settings', n: 'User roles', to: '/settings?v=users', ic: 'team', d: 'Who holds which role.' },
      { k: 'approvals', n: 'Approval queue', ic: 'done', d: 'Everything waiting on a decision.' },
      { k: 'settings', n: 'Organisation structure', to: '/settings?v=org', ic: 'building', d: 'Departments, heads and headcount.' },
      { k: 'settings', n: 'Locations', to: '/settings?v=sites', ic: 'location', d: 'Sites, addresses and geo-fences.' },
      { k: 'settings', n: 'Leave policy', to: '/settings?v=leave', ic: 'holiday', d: 'Quotas, carry-forward and encashment.' },
      { k: 'integrations', n: 'Integrations', ic: 'puzzle', d: 'What this tenant connects to, and what it does not.' },
      { k: 'integrations', n: 'API keys', to: '/integrations?v=keys', ic: 'lock', d: 'Credentials issued to other systems.' },
      { k: 'settings', n: 'Salary components', to: '/settings?v=pay', ic: 'money', d: 'Earnings, deductions and bands.' },
      { k: 'settings', n: 'Company profile', to: '/settings?v=company', ic: 'building', d: 'Legal entity, addresses and identifiers.' },
      { k: 'users', n: 'Sign-in activity', to: '/users?v=signins', ic: 'clock', d: 'Sessions started, ended and refused, across every account.', roles: ['manager', 'admin'] },
      { k: 'security', n: 'Security & access review', ic: 'lock', d: 'Controls, posture and the access review.' },
      { k: 'settings', n: 'Audit log', to: '/settings?v=audit', ic: 'document', d: 'Who changed what, and when.' },
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
  'My leave', 'My timesheet', 'My attendance', 'Reimbursements',
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
