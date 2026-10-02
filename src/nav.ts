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
 *
 * ## The information architecture
 *
 * Fourteen groups, ordered the way an HRMS is usually walked rather than by how
 * the system is built. Each has one audience, which is what decides where a new
 * view belongs — a group cannot have two, because `Shell` gates the whole thing
 * on `can(g.k)` plus `g.roles`:
 *
 * | Group                  | Key         | Audience        | Holds                         |
 * |------------------------|-------------|-----------------|-------------------------------|
 * | Dashboard              | dashboard   | everyone        | the landing view              |
 * | Company Setup          | settings    | **admin only**  | entity, structure, policy     |
 * | People                 | employees   | everyone        | records, org, requests, life  |
 * | Time & Attendance      | attendance  | everyone        | presence, corrections, shifts |
 * | Timesheet              | timesheet   | everyone        | booked effort and the planner |
 * | Leave                  | leave       | everyone        | requests, calendar, holidays  |
 * | Payroll & Compensation | payroll     | everyone        | pay, tax, benefits, claims    |
 * | Performance            | performance | everyone        | goals, reviews, engagement    |
 * | Learning & Development | learning    | everyone        | courses, plans, mentoring     |
 * | Recruitment            | hiring      | manager + admin | our vacancies and the desk's  |
 * | Assets                 | assets      | everyone        | hardware and software issued  |
 * | Documents              | documents   | everyone        | paperwork and policy          |
 * | Reports & Analytics    | reports     | manager + admin | reporting and exports         |
 * | Administration         | settings    | **admin only**  | accounts, permissions, audit  |
 *
 * ### Recruitment is one section and two permissions
 *
 * Client recruitment and internal hiring were two groups, because their
 * audiences differ: the client desk is admin-only and holds client and vendor
 * data, while a line manager hires into their own team. They are now one
 * section, and the distinction survives in a way that does not depend on a
 * heading.
 *
 * The group keys on `hiring`, which `PERMS.manager` holds, so a manager can open
 * it. Every client-facing item keys on `recruitment`, `clients`, `bench`,
 * `placements`, `billing`, `vendors` or `requirements` — none of which it holds
 * — and `Shell` filters each item on `can(i.k)` as well, so a manager sees the
 * six internal views and nothing else. Each client item also carries
 * `roles: ['admin']`, saying the same thing a second way so the intent is
 * readable here rather than inferred from a list in another file.
 *
 * Neither of those is the boundary. `server/src/auth/policy.ts` is, and it still
 * grants `recruitment` to an admin alone, so a manager who typed the URL is
 * refused by the API.
 *
 * ### A group is not a module
 *
 * Several sections gather views from more than one route, because people look
 * for a thing by what it is rather than by which service serves it: the planner
 * sits in Timesheet, the knowledge base in Documents, engagement beside
 * recognition in Performance, and the helpdesk SLA with the other analytics.
 * `bench` and `placements` even load the same screen. An entry is a route plus a
 * tab, not a file.
 *
 * ### Nothing here is a permission
 *
 * `can(role, k)` reads `PERMS` and `LIVE_MODULES` in `state/rbac.ts`. Moving an
 * item between groups, renaming it, or reordering the rail cannot widen or
 * narrow access, and this file must never become the place where that is
 * decided.
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

  /*
   * Configuration, separated from Administration.
   *
   * Administration had grown to fourteen items spanning two unrelated jobs:
   * running accounts and permissions, and configuring what the tenant *is*.
   * These five are the second job. All are `settings` tabs and all were already
   * admin-only, so this moves them and changes nothing about who reaches them.
   *
   * Deliberately not here: job titles, shifts and the holiday calendar. Your IA
   * lists them as configuration and they are, but each is reachable today by an
   * employee or a manager, and this group is admin-only — moving them would
   * quietly withdraw a screen somebody uses. They stay where their audience is.
   */
  {
    group: 'Company Setup',
    ic: 'building',
    k: 'settings',
    desc: 'How this tenant is configured — entity, structure, locations and policy.',
    roles: ['admin'],
    items: [
      { k: 'settings', n: 'Company profile', to: '/settings?v=company', ic: 'building', d: 'Legal entity, addresses and identifiers.' },
      { k: 'settings', n: 'Organisation structure', to: '/settings?v=org', ic: 'building', d: 'Departments, heads and headcount.' },
      /* The level above a department. Same `settings` route and permission as
         every other configuration screen — a new tab, not a new route. */
      { k: 'settings', n: 'Business units', to: '/settings?v=bu', ic: 'projects', d: 'The operating divisions a department belongs to.' },
      { k: 'settings', n: 'Locations', to: '/settings?v=sites', ic: 'location', d: 'Sites, addresses and geo-fences.' },
      { k: 'settings', n: 'Leave policies', to: '/settings?v=leave', ic: 'holiday', d: 'Quotas, carry-forward and encashment.' },
      { k: 'settings', n: 'Salary components', to: '/settings?v=pay', ic: 'money', d: 'Earnings, deductions and bands.' },
    ],
  },

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
      /*
       * Employee requests and company life. A helpdesk ticket is the request an
       * employee raises about their own employment, which is what this group is
       * for; celebrations and announcements are the company talking to its
       * people. None of these is configuration, so none belongs in Company
       * Setup — and that group is admin-only, which would have withdrawn five
       * screens every employee reaches today.
       */
      { k: 'helpdesk', n: 'Employee requests', to: '/helpdesk?v=my', ic: 'helpdesk', d: 'Raise a ticket and track it.' },
      { k: 'events', n: 'Company events', ic: 'calendar', d: 'What is on, and whether you are coming.' },
      { k: 'events', n: 'My events', to: '/events?v=mine', ic: 'schedule', d: 'Everything you have said yes to.' },
      { k: 'celebrations', n: 'Celebrations', ic: 'party', d: 'Birthdays, anniversaries and joiners.' },
      { k: 'announcements', n: 'Announcements', ic: 'announcements', d: 'What the company is telling everyone.' },
      { k: 'onboarding', n: 'Onboarding', ic: 'joiner', d: 'Bring new joiners through their first weeks.', roles: ['manager', 'admin'] },
      { k: 'exit', n: 'Exit & final settlement', ic: 'undo', d: 'Offboard leavers and settle their dues.', roles: ['manager', 'admin'] },
      { k: 'helpdesk', n: 'Request queue', to: '/helpdesk?v=queue', ic: 'inbox', d: 'Everything waiting on your team.', roles: ['manager', 'admin'] },
    ],
  },

  /*
   * Attendance only. Leave used to sit here and now has its own section: the two
   * were one group because both answer "was somebody at work", and in a rail of
   * fourteen sections that put My leave three rows below My attendance under a
   * heading that named neither.
   */
  {
    group: 'Time & Attendance',
    ic: 'attendance',
    k: 'attendance',
    desc: 'Hours worked, who is in today, and corrections.',
    items: [
      { k: 'attendance', n: 'My attendance', ic: 'clock', d: 'Punch in and out, and see your month.' },
      { k: 'attendance', n: 'Attendance board', to: '/attendance?v=live', ic: 'people', d: 'Who is in, out or remote right now.', roles: ['manager', 'admin'] },
      { k: 'attendance', n: 'Attendance corrections', to: '/attendance?v=reg', ic: 'undo', d: 'Correct a missed punch or a wrong day.' },
      { k: 'shifts', n: 'Shifts & work schedules', ic: 'schedule', d: 'Plan shifts and working patterns.', roles: ['manager', 'admin'] },
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
      { k: 'timesheet', n: 'Timesheet calendar', to: '/timesheet?v=cal', ic: 'calendar', d: 'Your weeks at a glance, and the ones you have not started.' },
      { k: 'timesheet', n: 'Timesheet history', to: '/timesheet?v=hist', ic: 'clock', d: 'Every week you have submitted.' },
      /*
       * The planner, which is the work the hours are booked against. Your IA
       * puts Projects and Tasks in this group, and these four are that: a board
       * of what is in progress, who carries it, and which iteration it sits in.
       * Every role reaches them, as before.
       */
      { k: 'planner', n: 'Work board', to: '/planner?v=board', ic: 'grid', d: 'Everything in progress, by column.' },
      { k: 'planner', n: 'My work', to: '/planner?v=mine', ic: 'person', d: 'What is assigned to you.' },
      { k: 'planner', n: 'Action items', to: '/planner?v=actions', ic: 'goal', d: 'Follow-ups and their owners.' },
      { k: 'planner', n: 'Iterations', to: '/planner?v=iterations', ic: 'refresh', d: 'Sprints and what each delivered.' },
      /*
       * The four below read somebody else's week, which the policy grants a
       * manager ('team') and an admin ('all') and an employee not at all. The
       * service scopes every read again — this only stops offering a screen
       * that would come back empty.
       */
      { k: 'timesheet', n: 'Team timesheets', to: '/timesheet?v=team', ic: 'team', d: 'Your line’s weeks, with hours and status.', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Pending approvals', to: '/timesheet?v=appr', ic: 'done', d: 'Decide your team’s weeks.', roles: ['manager', 'admin'] },
      { k: 'timesheet', n: 'Projects', to: '/timesheet?v=proj', ic: 'projects', d: 'What time can be booked against.', roles: ['manager', 'admin'] },
      /* Not "Timesheet reports": that name belongs to the cross-module report in
         Reports & Analytics, and two rows with one label is the defect the
         Recruitment relabel fixed. This one is the in-module view. */
      { k: 'timesheet', n: 'Utilisation & effort', to: '/timesheet?v=rep', ic: 'chart', d: 'Utilisation and effort by project.', roles: ['manager', 'admin'] },
    ],
  },

  /*
   * Leave, out of Time & attendance and into its own section. Every item is an
   * existing `/leave` tab; the policy editor stays in Company Setup because it
   * is a `settings` tab and admin-only.
   */
  {
    group: 'Leave',
    ic: 'holiday',
    k: 'leave',
    desc: 'Requests, balances, the team calendar and public holidays.',
    items: [
      { k: 'leave', n: 'My leave', ic: 'holiday', d: 'Apply for leave and check your balance.' },
      { k: 'leave', n: 'Holiday calendar', to: '/leave?v=cal', ic: 'calendar', d: 'Public holidays by location.' },
      { k: 'leave', n: 'Team leave', to: '/leave?v=team', ic: 'team', d: 'Your line’s leave, in one calendar.', roles: ['manager', 'admin'] },
      { k: 'leave', n: 'Leave approvals', to: '/leave?v=appr', ic: 'done', d: 'Decide the requests waiting on you.', roles: ['manager', 'admin'] },
    ],
  },

  {
    group: 'Payroll & Compensation',
    ic: 'payroll',
    k: 'payroll',
    desc: 'Pay, compensation, tax, benefits and what you are owed.',
    items: [
      { k: 'payroll', n: 'My payslips', to: '/payroll?v=me', ic: 'payslip', d: 'Download any month’s payslip.' },
      { k: 'payroll', n: 'Salary details', to: '/payroll?v=struct', ic: 'money', d: 'How your package is made up.', roles: ['employee', 'manager'] },
      /*
       * The same tab, named for what an admin does there. For everyone else it
       * shows their own package; for an admin it is the compensation master,
       * where a salary is set and its history read. One route, two audiences,
       * so the label says which one is reading.
       */
      { k: 'payroll', n: 'Employee compensation', to: '/payroll?v=struct', ic: 'money', d: 'Set salaries and read what they were before.', roles: ['admin'] },
      { k: 'tax', n: 'Tax declarations', ic: 'tax', d: 'Declare investments and claim exemptions.' },
      { k: 'benefits', n: 'Benefits & flexi', ic: 'gift', d: 'Allocate your flexible benefit pot.' },
      { k: 'expenses', n: 'Reimbursements', ic: 'invoice', d: 'Claim expenses and travel.' },
      { k: 'payroll', n: 'Payroll processing', to: '/payroll?v=runs', ic: 'refresh', d: 'Open, process and close a cycle.', roles: ['admin'] },
      { k: 'payroll', n: 'Salary register', to: '/payroll?v=reg', ic: 'document', d: 'Every payslip in the cycle.', roles: ['admin'] },
      { k: 'payroll', n: 'Payroll inputs', to: '/payroll?v=inputs', ic: 'note', d: 'Overtime, deductions and one-offs.', roles: ['admin'] },
      { k: 'payroll', n: 'Bank & disbursal', to: '/payroll?v=bank', ic: 'bank', d: 'Build and release the payment file.', roles: ['admin'] },
      { k: 'payroll', n: 'Statutory remittances', to: '/payroll?v=stat', ic: 'policy', d: 'PF, ESI and tax remittances.', roles: ['admin'] },
    ],
  },

  {
    group: 'Performance',
    ic: 'performance',
    k: 'performance',
    desc: 'Goals, reviews, calibration and recognition.',
    items: [
      { k: 'performance', n: 'My goals', to: '/performance?v=goals', ic: 'target', d: 'What you are working towards.' },
      { k: 'performance', n: 'Performance reviews', to: '/performance?v=review', ic: 'note', d: 'Write and read review cycles.' },
      { k: 'performance', n: 'Review cycle', to: '/performance?v=cycle', ic: 'schedule', d: 'Where the current cycle has got to.' },
      { k: 'performance', n: 'Give recognition', to: '/performance?v=praise', ic: 'trophy', d: 'Praise colleagues, and read yours.' },
      /*
       * Engagement, beside recognition rather than in a section of its own.
       * "Give recognition" was already here, so the wall that shows the result
       * belongs next to it, and a survey measures the same thing a review does
       * from the other direction. Employee-visible, exactly as before.
       */
      { k: 'engagement', n: 'Recognition wall', to: '/engagement?v=recog', ic: 'applause', d: 'Who has been thanked lately.' },
      { k: 'engagement', n: 'Surveys & polls', to: '/engagement?v=open', ic: 'vote', d: 'Open questions waiting on you.' },
      { k: 'engagement', n: 'Engagement overview', to: '/engagement?v=results', ic: 'chart', d: 'How the last survey landed.' },
      { k: 'performance', n: 'Team goals', to: '/performance?v=team', ic: 'team', d: 'Where your line stands.', roles: ['manager', 'admin'] },
      { k: 'performance', n: 'Calibration', to: '/performance?v=calib', ic: 'chart', d: 'Compare ratings across the team.', roles: ['manager', 'admin'] },
    ],
  },

  /*
   * Learning and development, out of Performance. They were appended to it
   * because growth follows a review, which is true of the process and not of
   * the navigation: somebody looking for a course was reading a list of
   * appraisal screens.
   */
  {
    group: 'Learning & Development',
    ic: 'learning',
    k: 'learning',
    desc: 'Courses, enrolments, development plans and mentoring.',
    items: [
      { k: 'learning', n: 'My learning', ic: 'learning', d: 'Courses, enrolments and progress.' },
      { k: 'devplans', n: 'Development plans', ic: 'rocket', d: 'Where people are heading, and how.' },
      { k: 'devplans', n: 'Mentors', to: '/devplans?v=mentors', ic: 'people', d: 'Who is mentoring whom, and the load.', roles: ['manager', 'admin'] },
    ],
  },

  /*
   * Recruitment and internal hiring, in one section and still two permissions.
   *
   * They were two groups because their audiences differ, and merging the groups
   * naively would have broken that: `Shell` gates a whole group on `can(g.k)`
   * plus `g.roles`, so one group means one audience.
   *
   * What makes this safe is that the group's key is `hiring` — which
   * `PERMS.manager` holds — while every client-facing item below keys on
   * `recruitment`, `clients`, `bench`, `placements`, `billing`, `vendors` or
   * `requirements`, none of which it holds. `Shell` filters each item on
   * `can(i.k)` as well, so a manager opens this section and sees the six
   * internal-hiring views and nothing else. The `roles: ['admin']` on each
   * client item says the same thing a second way, so the intent is readable
   * here and does not rest on a list in another file.
   *
   * Neither of those is the boundary. `server/src/auth/policy.ts` is, and it is
   * unchanged: `recruitment` remains admin-only there, so a manager who typed
   * the URL would still be refused by the API.
   */
  {
    group: 'Recruitment',
    ic: 'recruitment',
    k: 'hiring',
    desc: 'Our own vacancies, and the client desk’s orders and candidates.',
    roles: ['manager', 'admin'],
    items: [
      { k: 'hiring', n: 'Internal requisitions', to: '/hiring?v=reqs', ic: 'goal', d: 'Roles we are hiring for ourselves.' },
      { k: 'hiring', n: 'Applicants', to: '/hiring?v=cands', ic: 'people', d: 'Applicants and where they are.' },
      { k: 'hiring', n: 'Pipeline board', to: '/hiring?v=pipe', ic: 'grid', d: 'The funnel, stage by stage.' },
      { k: 'hiring', n: 'Interview panels', to: '/hiring?v=ivs', ic: 'schedule', d: 'Panels, slots and feedback.' },
      { k: 'hiring', n: 'Internal offers', to: '/hiring?v=offers', ic: 'mail', d: 'Offers out and their outcomes.' },
      { k: 'hiring', n: 'Hiring tracker', to: '/hiring?v=track', ic: 'reports', d: 'Time to hire and source quality.' },
      { k: 'recruitment', n: 'Recruitment dashboard', to: '/recruitment?v=dash', ic: 'chart', d: 'Open demand, the funnel and what is late.', roles: ['admin'] },
      { k: 'recruitment', n: 'Client job orders', to: '/recruitment?v=reqs', ic: 'goal', d: 'Every order, its SLA and its desk.', roles: ['admin'] },
      { k: 'recruitment', n: 'My assigned jobs', to: '/recruitment?v=mine', ic: 'person', d: 'The orders on your desk.', roles: ['admin'] },
      { k: 'recruitment', n: 'Client candidates', to: '/recruitment?v=cands', ic: 'people', d: 'People you can put forward.', roles: ['admin'] },
      { k: 'recruitment', n: 'Candidate submissions', to: '/recruitment?v=subs', ic: 'submission', d: 'Profiles with the client.', roles: ['admin'] },
      { k: 'recruitment', n: 'Client interviews', to: '/recruitment?v=ivs', ic: 'schedule', d: 'Booked, done and awaiting feedback.', roles: ['admin'] },
      { k: 'recruitment', n: 'Client offers', to: '/recruitment?v=offers', ic: 'mail', d: 'Released, accepted and declined.', roles: ['admin'] },
      { k: 'recruitment', n: 'Talent pool', to: '/recruitment?v=pool', ic: 'star', d: 'People worth going back to.', roles: ['admin'] },
      { k: 'recruitment', n: 'Recruiter activity', to: '/recruitment?v=activity', ic: 'timer', d: 'What each desk has produced.', roles: ['admin'] },
      { k: 'recruitment', n: 'Recruitment reports', to: '/recruitment?v=reports', ic: 'reports', d: 'Conversion, ageing and fill rate.', roles: ['admin'] },
      { k: 'placements', n: 'Placements', ic: 'done', d: 'Consultants on assignment.', roles: ['admin'] },
      { k: 'bench', n: 'Bench & consultants', ic: 'briefcase', d: 'Who is available, and for how long.', roles: ['admin'] },
      { k: 'clients', n: 'Clients & accounts', ic: 'client', d: 'Accounts, contacts and their SOWs.', roles: ['admin'] },
      { k: 'vendors', n: 'Vendors', ic: 'building', d: 'Supplier panel and their performance.', roles: ['admin'] },
      { k: 'billing', n: 'Billing & AR', ic: 'invoice', d: 'Invoices raised and money owed.', roles: ['admin'] },
      { k: 'requirements', n: 'Requirements (legacy)', ic: 'document', d: 'Superseded by Client job orders — kept so older requirements stay readable.', roles: ['admin'] },
    ],
  },

  {
    group: 'Assets',
    ic: 'assets',
    k: 'assets',
    desc: 'Kit issued to people, software seats, and what is left in stock.',
    items: [
      { k: 'assets', n: 'Asset register', to: '/assets?v=reg', ic: 'laptop', d: 'Every asset, where it is and who holds it.' },
      { k: 'assets', n: 'Issue & return', to: '/assets?v=alloc', ic: 'swap', d: 'Hand kit out, and take it back.' },
      { k: 'software', n: 'Software assets', ic: 'puzzle', d: 'Licences, seats and what renews next.' },
      { k: 'software', n: 'Licence renewals', to: '/software?v=renewals', ic: 'clock', d: 'What the company re-signs, and when.', roles: ['manager', 'admin'] },
      { k: 'software', n: 'Idle seats', to: '/software?v=dormant', ic: 'warn', d: 'Seats nobody opens, and their cost.', roles: ['manager', 'admin'] },
    ],
  },

  /*
   * Paperwork, looked for by name rather than found under People.
   *
   * Two items, so a section rather than a link: the employee's own documents,
   * and the knowledge base, which is where the policies live. The knowledge
   * base is a `helpdesk` tab and keeps that key — it is shelved here because
   * somebody looking for a policy looks for a document, not a support ticket.
   */
  {
    group: 'Documents',
    ic: 'document',
    k: 'documents',
    desc: 'Employee paperwork, letters and company policy.',
    items: [
      { k: 'documents', n: 'Employee documents', ic: 'document', d: 'Issue and track employee paperwork.' },
      { k: 'helpdesk', n: 'Policies & knowledge base', to: '/helpdesk?v=kb', ic: 'policy', d: 'Policies and how-to articles.' },
    ],
  },

  {
    group: 'Reports & Analytics',
    ic: 'reports',
    k: 'reports',
    desc: 'The numbers, across every module.',
    roles: ['manager', 'admin'],
    items: [
      { k: 'reports', n: 'All reports', ic: 'reports', d: 'Every report, by area.' },
      { k: 'reports', n: 'Employee reports', to: '/reports?v=headcount', ic: 'people', d: 'Headcount and distribution.' },
      { k: 'reports', n: 'Attendance reports', to: '/reports?v=attendance', ic: 'attendance', d: 'Presence, WFH, late marks and absence.' },
      { k: 'reports', n: 'Leave reports', to: '/reports?v=leave', ic: 'holiday', d: 'Balances, utilisation and liability.' },
      { k: 'reports', n: 'Timesheet reports', to: '/reports?v=utilisation', ic: 'timesheet', d: 'Billable against non-billable effort.' },
      { k: 'reports', n: 'Hiring reports', to: '/reports?v=hiring', ic: 'hiring', d: 'Funnel, source quality and time to hire.' },
      { k: 'reports', n: 'Performance & talent', to: '/reports?v=talent', ic: 'performance', d: 'Ratings, goals and recognition.' },
      /* A helpdesk tab, but it is analytics, and its own roles already match
         this group's gate exactly — so shelving it here moves nothing. */
      { k: 'helpdesk', n: 'Helpdesk SLA & analytics', to: '/helpdesk?v=sla', ic: 'timer', d: 'Response times against target.', roles: ['manager', 'admin'] },
      { k: 'reports', n: 'Payroll reports', to: '/reports?v=payroll', ic: 'payroll', d: 'Gross, deductions and net by month.', roles: ['admin'] },
      { k: 'reports', n: 'Attrition & retention', to: '/reports?v=attrition', ic: 'down', d: 'Exits, reasons and tenure.', roles: ['admin'] },
      { k: 'reports', n: 'Expense & cost', to: '/reports?v=spend', ic: 'invoice', d: 'Claims, loans and cost per head.', roles: ['admin'] },
      { k: 'reports', n: 'Statutory compliance', to: '/reports?v=compliance', ic: 'policy', d: 'PF, ESI, PT and TDS remittances.', roles: ['admin'] },
      { k: 'customreports', n: 'Custom reports', ic: 'grid', d: 'Questions somebody saved, run as you.' },
      { k: 'exports', n: 'Export centre', ic: 'download', d: 'Take data out, and see who has.' },
      { k: 'exports', n: 'Export register', to: '/exports?v=register', ic: 'policy', d: 'What left, when, and who took it.' },
      { k: 'exec', n: 'Executive view', ic: 'chart', d: 'The company on one page.', roles: ['admin'] },
    ],
  },

  /*
   * Accounts, permissions and the audit trail. The five configuration screens
   * that used to sit here are now Company Setup; what is left is one job.
   */
  {
    group: 'Administration',
    ic: 'settings',
    k: 'settings',
    desc: 'Accounts, permissions, integrations and the audit trail.',
    roles: ['admin'],
    items: [
      { k: 'users', n: 'User management', ic: 'person', d: 'Create, approve and retire accounts.' },
      { k: 'settings', n: 'Roles & permissions', to: '/settings?v=rbac', ic: 'lock', d: 'What each role may reach.' },
      { k: 'settings', n: 'User roles', to: '/settings?v=users', ic: 'team', d: 'Who holds which role.' },
      { k: 'approvals', n: 'Approval queue', ic: 'done', d: 'Everything waiting on a decision.' },
      { k: 'integrations', n: 'Integrations', ic: 'puzzle', d: 'What this tenant connects to, and what it does not.' },
      { k: 'integrations', n: 'API keys', to: '/integrations?v=keys', ic: 'lock', d: 'Credentials issued to other systems.' },
      { k: 'security', n: 'Security & access review', ic: 'lock', d: 'Controls, posture and the access review.' },
      { k: 'users', n: 'Login history', to: '/users?v=signins', ic: 'clock', d: 'Sessions started, ended and refused, across every account.', roles: ['manager', 'admin'] },
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
/*
 * Matched against `NavItem.n`, so renaming an item renames the quick action it
 * refers to. `checks/routes.tsx` asserts each one still resolves to exactly one
 * view, which is how "Helpdesk" was caught after it became "Employee requests".
 */
export const QUICK_ACTIONS = [
  'My leave', 'My timesheet', 'My attendance', 'Reimbursements',
  'Employee requests', 'My payslips', 'Employee directory',
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
