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
      { k: 'helpdesk', ic: '◒', n: 'Helpdesk' },
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
      { k: 'expenses', ic: '🧾', n: 'Expense & travel', to: '/expenses?v=all' },
      { k: 'timesheet', ic: '▤', n: 'Timesheet', to: '/timesheet?v=team' },
      { k: 'performance', ic: '◈', n: 'Performance', to: '/performance?v=team' },
      { k: 'shifts', ic: '◑', n: 'Roster' },
      { k: 'onboarding', ic: '⇥', n: 'Onboarding' },
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
    /* Mine, but money — kept apart because it is read at different times. */
    group: 'My pay',
    ic: '₹',
    items: [
      { k: 'payroll', ic: '₹', n: 'Payslips' },
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
      { k: 'helpdesk', ic: '◒', n: 'Helpdesk' },
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
      { k: 'helpdesk', ic: '📚', n: 'Articles', to: '/helpdesk?v=kb' },
      { k: 'celebrations', ic: '★', n: 'Celebrations' },
    ],
  },
  {
    /* Tools rather than records — opened to do a job, not to look yourself up. */
    group: 'Apps',
    ic: '⊞',
    items: [
      { k: 'planner', ic: '◱', n: 'Project planner' },
      { k: 'hiring', ic: '◎', n: 'Recruitment' },
      { k: 'assets', ic: '💻', n: 'IT assets' },
      { k: 'whatsapp', ic: '💬', n: 'WhatsApp' },
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
