/**
 * The sidebar.
 *
 * Organised around *whose* record a page is about, which is the question
 * somebody is actually asking when they reach for the menu. **Me** is my own
 * record. **My team** is the same pages read about the people who report to
 * me. **Org** is everyone. A flat list sorted by subject — attendance beside
 * rosters beside timesheets — makes the reader work out each time whether a
 * page is about them or about somebody else.
 *
 * **A page can appear twice.** Leave under Me and Leave under My team are the
 * same route opened at different tabs, which is why an item carries `to` as
 * well as `k`: `k` is the permission and the route, `to` is where the link
 * goes. Helpdesk sits in both Me and Org for the same reason — it is where you
 * raise your own ticket and also part of what the organisation offers you.
 *
 * Sections collapse, because the list is long and most people live in two of
 * them. Items the role cannot reach are filtered out, and a section with
 * nothing left does not render — so an employee never learns Staffing exists.
 */

export interface NavItem {
  /** Route key — also the RBAC permission key and the registry key. */
  k: string;
  ic: string;
  n: string;
  /**
   * Roles this entry is for. Needed wherever a link points at a tab rather
   * than a page: Payroll is reachable by everybody — that is where a payslip
   * lives — but the register, the inputs and the disbursal file inside it are
   * not. Permission is per route, so without this the menu offers an employee
   * a tab the page will not render.
   */
  roles?: readonly ('employee' | 'manager' | 'admin')[];
  /**
   * Where the link goes. Defaults to `/${k}`; a `?v=` names the tab to open,
   * so one page can appear in two sections showing different things.
   */
  to?: string;
}

export interface NavGroup {
  group: string;
  ic: string;
  /**
   * Roles this section is for. Omitted means everyone who can reach an item
   * inside it.
   *
   * Needed because per-item permissions are not enough here: Leave and
   * Timesheet are an employee's own pages *and* a manager's view of their
   * team, so filtering by route alone showed "My team" to everybody. The page
   * underneath refuses them, but a menu that offers something and then says no
   * is a menu that has wasted a click and taught the reader nothing.
   */
  roles?: readonly ('employee' | 'manager' | 'admin')[];
  /** A section of one, rendered as a plain link with no header to expand. */
  solo?: boolean;
  /** Open on a first visit. Everything else starts shut. */
  open?: boolean;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    group: 'Home',
    ic: '⌂',
    solo: true,
    items: [{ k: 'dashboard', ic: '⌂', n: 'Home' }],
  },
  {
    /*
     * Everything about the person reading it. Open by default because for an
     * employee this is not a section of the app, it is the app.
     */
    group: 'Me',
    ic: '👤',
    open: true,
    items: [
      { k: 'attendance', ic: '◉', n: 'Attendance' },
      { k: 'timesheet', ic: '▤', n: 'Timesheet' },
      { k: 'leave', ic: '↗', n: 'Leave' },
      { k: 'expenses', ic: '🧾', n: 'Expense & travel' },
    ],
  },
  {
    /*
     * The same pages, read about somebody else — so the section is gated on
     * the role rather than on the routes, which an employee can also reach for
     * their own record.
     */
    group: 'My team',
    ic: '👥',
    roles: ['manager', 'admin'],
    items: [
      { k: 'approvals', ic: '✓', n: 'Approvals' },
      { k: 'attendance', ic: '◉', n: 'Attendance', to: '/attendance?v=live' },
      { k: 'leave', ic: '↗', n: 'Leave', to: '/leave?v=team' },
      { k: 'timesheet', ic: '▤', n: 'Timesheet', to: '/timesheet?v=team' },
      { k: 'performance', ic: '◈', n: 'Performance', to: '/performance?v=team' },
      { k: 'shifts', ic: '◑', n: 'Roster' },
      { k: 'exit', ic: '⇤', n: 'Exit & F&F' },
      { k: 'reports', ic: '▥', n: 'Reports' },
    ],
  },
  {
    /*
     * The appraisal cycle. Goals, the review itself, recognition and where the
     * cycle has got to are four different conversations that happen at four
     * different times of year, which is why they are listed rather than left
     * as tabs somebody has to remember exist.
     *
     * 1:1 check-ins, salary and promotion, and skills are asked for and are
     * not here: check-ins have a service and no screen, and the other two have
     * neither. A menu entry pointing at a page that does not answer it is
     * worse than its absence.
     */
    group: 'Performance',
    ic: '◈',
    items: [
      { k: 'performance', ic: '◎', n: 'Goals', to: '/performance?v=goals' },
      { k: 'performance', ic: '◈', n: 'Reviews', to: '/performance?v=review' },
      { k: 'performance', ic: '👏', n: 'Recognition', to: '/performance?v=praise' },
      { k: 'performance', ic: '◷', n: 'Cycle', to: '/performance?v=cycle' },
      { k: 'learning', ic: '◉', n: 'Learning' },
    ],
  },
  {
    /*
     * Everything about money in one place. Payroll has ten surfaces behind
     * tabs — runs, the register, inputs, disbursal, statutory — and a person
     * looking for the salary register should not have to know it lives inside
     * a tab of a page called Payslips.
     */
    group: 'Pay',
    ic: '₹',
    items: [
      { k: 'payroll', ic: '₹', n: 'My payslips', to: '/payroll?v=me' },
      { k: 'payroll', ic: '▦', n: 'Salary structure', to: '/payroll?v=struct' },
      { k: 'payroll', ic: '◫', n: 'Team cost', to: '/payroll?v=team', roles: ['manager'] },
      { k: 'payroll', ic: '▶', n: 'Payroll runs', to: '/payroll?v=runs', roles: ['admin'] },
      { k: 'payroll', ic: '☰', n: 'Salary register', to: '/payroll?v=reg', roles: ['admin'] },
      { k: 'payroll', ic: '⇢', n: 'Payroll inputs', to: '/payroll?v=inputs', roles: ['admin'] },
      { k: 'payroll', ic: '🏦', n: 'Bank & disbursal', to: '/payroll?v=bank', roles: ['admin'] },
      { k: 'payroll', ic: '⚖', n: 'Statutory', to: '/payroll?v=stat', roles: ['admin'] },
      { k: 'tax', ic: '%', n: 'Tax declaration' },
      { k: 'benefits', ic: '♡', n: 'Benefits & flexi' },
    ],
  },
  {
    /* What the organisation is and what it offers — open to everyone. */
    group: 'Org',
    ic: '⌘',
    items: [
      { k: 'employees', ic: '☰', n: 'Employees' },
      { k: 'org', ic: '⌘', n: 'Org chart' },
      { k: 'documents', ic: '▧', n: 'Documents' },
    ],
  },
  {
    /*
     * Things the company says to people, and asks of them. Articles are the
     * helpdesk's knowledge base opened at that tab rather than a second store
     * of the same writing — one place to keep current, two ways in.
     */
    group: 'Engage',
    ic: '◍',
    items: [
      { k: 'announcements', ic: '⚑', n: 'Announcements' },
      { k: 'engagement', ic: '🗳', n: 'Surveys & polls', to: '/engagement?v=open' },
      { k: 'celebrations', ic: '★', n: 'Celebrations' },
    ],
  },
  {
    /* Project work: the board, what is assigned to me, and where an iteration
       has got to. Tracking and status are the whole point, so they are named. */
    group: 'Projects',
    ic: '◱',
    items: [
      { k: 'planner', ic: '▦', n: 'Board', to: '/planner?v=board' },
      { k: 'planner', ic: '◉', n: 'My work', to: '/planner?v=mine' },
      { k: 'planner', ic: '✓', n: 'Action items', to: '/planner?v=actions' },
      { k: 'planner', ic: '◷', n: 'Iterations', to: '/planner?v=iterations' },
      { k: 'timesheet', ic: '▤', n: 'Time against projects', to: '/timesheet?v=util',
        roles: ['manager', 'admin'] },
    ],
  },
  {
    /* Raising a ticket and finding the answer yourself are the same desk. */
    group: 'Helpdesk',
    ic: '◒',
    items: [
      { k: 'helpdesk', ic: '✎', n: 'Raise a ticket', to: '/helpdesk?v=my' },
      { k: 'helpdesk', ic: '☰', n: 'Ticket queue', to: '/helpdesk?v=queue', roles: ['manager', 'admin'] },
      { k: 'helpdesk', ic: '📚', n: 'Knowledge base', to: '/helpdesk?v=kb' },
      { k: 'helpdesk', ic: '◷', n: 'SLA & analytics', to: '/helpdesk?v=sla', roles: ['manager', 'admin'] },
    ],
  },
  {
    group: 'Apps',
    ic: '⊞',
    items: [
      { k: 'assets', ic: '💻', n: 'IT assets' },
      { k: 'whatsapp', ic: '💬', n: 'WhatsApp' },
    ],
  },
  {
    /*
     * Recruitment, listed by what a recruiter is doing rather than by tab.
     * Open requisitions and submissions are the two things asked about daily.
     */
    group: 'Recruitment',
    ic: '◎',
    roles: ['manager', 'admin'],
    items: [
      { k: 'hiring', ic: '💼', n: 'Open requisitions', to: '/hiring?v=reqs' },
      { k: 'hiring', ic: '☰', n: 'Candidates', to: '/hiring?v=cands' },
      { k: 'hiring', ic: '▦', n: 'Pipeline board', to: '/hiring?v=pipe' },
      { k: 'hiring', ic: '📅', n: 'Interviews', to: '/hiring?v=ivs' },
      { k: 'hiring', ic: '📄', n: 'Offers', to: '/hiring?v=offers' },
      { k: 'hiring', ic: '◷', n: 'Activity tracker', to: '/hiring?v=track' },
      { k: 'onboarding', ic: '⇥', n: 'Onboarding' },
    ],
  },
  {
    group: 'Staffing',
    ic: '⬢',
    items: [
      { k: 'clients', ic: '⬢', n: 'Clients & SOW' },
      { k: 'requirements', ic: '⌗', n: 'Requirements' },
      { k: 'bench', ic: '◔', n: 'Bench & consultants' },
      { k: 'placements', ic: '⇉', n: 'Placements' },
      { k: 'billing', ic: '⌸', n: 'Billing & AR' },
      { k: 'vendors', ic: '⬡', n: 'Vendors' },
    ],
  },
  {
    group: 'Administration',
    ic: '⚙',
    items: [
      { k: 'exec', ic: '◮', n: 'Executive view' },
      { k: 'security', ic: '⚿', n: 'Security & audit' },
      { k: 'settings', ic: '⚙', n: 'Settings & RBAC' },
    ],
  },
];

/** The five routes that get a bottom tab on a phone. */
export const TABBAR = ['dashboard', 'attendance', 'timesheet', 'leave', 'approvals'];

/**
 * Every route, once.
 *
 * Deduplicated because a page may sit in two sections: the checks walk this to
 * render each route, and rendering Leave twice proves nothing the first pass
 * did not.
 */
export const ALL_ROUTES: string[] = [
  ...new Set(NAV.flatMap((g) => g.items.map((i) => i.k))),
];

/** Where an item points — the route itself unless it named a tab. */
export const hrefOf = (i: NavItem): string => i.to ?? `/${i.k}`;
