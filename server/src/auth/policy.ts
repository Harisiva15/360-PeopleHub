/**
 * What each role may do, in one place.
 *
 * Three places used to describe this and disagree: `PERMS` in the frontend
 * gated navigation, `role_permission` in the database called itself "the
 * authority" while being read by nothing, and 114 hand-written `caller.role`
 * checks did the actual enforcing. This file is the description; the services
 * remain the enforcement, and `checks/roles.ts` fails the build when the two
 * drift apart.
 *
 * ---------------------------------------------------------------------------
 * THE ROLES, AND THE ONE THAT IS NOT A ROLE
 * ---------------------------------------------------------------------------
 *
 * **employee** — everyone, self-service, and the floor every other role stands
 * on. Sees their own record and what the whole company shares: the org chart,
 * announcements, celebrations, the project board. Raises their own requests and
 * approves nothing, including their own.
 *
 * **hr_admin** — people. The directory, job titles, the lifecycle, onboarding,
 * exits, hiring, documents, attendance, leave, timesheets, shifts, performance,
 * learning, benefits and the helpdesk, all at `all`. Edits compensation.
 *
 * **finance_admin** — money. Payroll, tax, expenses and the commercial book at
 * `all`, plus read over the people data those depend on. Sees pay and does not
 * change what people are paid.
 *
 * **company_admin** — the whole tenant, and the only role that creates logins,
 * assigns roles or edits company settings.
 *
 * **manager is deliberately not a role.** It used to be one, and that was
 * wrong: whether somebody answers for other people is a fact about the
 * reporting tree, not a title somebody is given. So `manager` below is a
 * *layer*, applied to anyone with reports at any depth, on top of whatever role
 * they hold. An HR administrator who runs a team is both; so is an employee who
 * runs a team, which is the ordinary case and used to require an assigned role
 * to express.
 *
 * One consequence worth stating: on a tenant where `employee.manager_id` is
 * empty, the layer applies to nobody and every team scope is empty. That is
 * correct — there are no teams — but it means populating the reporting tree is
 * what turns this half of the model on.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMNS ADD; THEY DO NOT REPLACE
 * ---------------------------------------------------------------------------
 *
 * An assigned role's column is **what that role adds** to the person's own
 * employee access and, where they have reports, the manager layer. Effective
 * reach is the widest of the three, per module and per verb:
 *
 *     effective = max(employee, hasReports ? manager : none, assignedRole)
 *
 * This is why three cells below look wrong and are not. `software` gives
 * hr_admin `none` while an employee reads their own licences; `shifts` gives
 * finance_admin `none` while an employee reads their own; `expenses` gives
 * hr_admin exactly what an employee has. In each case the role adds nothing to
 * that module, and the person keeps what they already had. Reading a column as
 * an absolute grant would take access away from somebody for being promoted,
 * which is the opposite of what an administrative role is for.
 *
 * `effectiveFor` is the only correct way to ask this question. `ruleFor` answers
 * about one layer in isolation and is for the screens that explain the model.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, NOT PERMISSION
 * ---------------------------------------------------------------------------
 *
 * A boolean cannot describe any of the above. Almost every rule here is about
 * *how much* rather than *whether*: a manager reads leave for their team, an
 * employee reads their own, an administrator reads all — three answers to one
 * question. So each of read, write and approve carries a scope, and
 * `role_permission` holds it for per-tenant narrowing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * **Self-approval.** No scope can express it: `approve: 'all'` includes the
 * caller's own row by definition. Every approve path refuses the caller
 * separately, for every role including company_admin, because "senior enough
 * to approve" and "allowed to approve your own" are different questions and the
 * second answer is always no.
 *
 * **Which items an inbox or a report contains.** The access table qualifies two
 * cells — hr_admin approves "HR items", finance_admin "pay/expense items", and
 * their reports cover "people data" and "pay data" respectively. Those are not
 * scopes and are deliberately not modelled here. An approvals queue belongs to
 * a module and inherits that module's `approve`; a report returns rows the
 * reader could already see. Both qualifiers are consequences of the table
 * above, so writing them down a second time would be two authorities that can
 * disagree.
 *
 * **Who may hold a role, and that somebody always can.** Only company_admin
 * assigns roles, never their own, and a tenant keeps at least one active
 * company_admin. The first is `ACTION_SCOPE` below; the second two are
 * cross-row invariants that a scope cannot hold and the service and a trigger
 * enforce.
 */

export type Role = 'employee' | 'hr_admin' | 'finance_admin' | 'company_admin';

/**
 * The derived layer. Not assignable, and not a `Role`.
 *
 * It keeps a key in `ModulePolicy` and a set of rows in `role_permission` so
 * that a tenant can narrow what having reports grants — narrowing the layer is
 * a legitimate thing to want, and the alternative is a layer no tenant can
 * reach.
 */
export type Layer = 'manager';

/**
 * How far a grant reaches.
 *
 * `own` is the caller's own records. `team` is those plus everyone below them
 * in the reporting tree, at any depth — not direct reports only, because a
 * skip-level manager still answers for the people two levels down.
 */
export type Scope = 'none' | 'own' | 'team' | 'all';

/** The three questions a gate can ask about a module - ModuleRule's keys. */
export type Verb = 'read' | 'write' | 'approve';

export interface ModuleRule {
  read: Scope;
  write: Scope;
  approve: Scope;
}

/** Every layer that can grant something in a module. */
export type ModulePolicy = Record<Role | Layer, ModuleRule>;

type Triple = [Scope, Scope, Scope];

/** Shorthand: read, write, approve for each layer, in table order. */
const rule = (
  employee: Triple,
  manager: Triple,
  hrAdmin: Triple,
  financeAdmin: Triple,
  companyAdmin: Triple,
): ModulePolicy => ({
  employee: { read: employee[0], write: employee[1], approve: employee[2] },
  manager: { read: manager[0], write: manager[1], approve: manager[2] },
  hr_admin: { read: hrAdmin[0], write: hrAdmin[1], approve: hrAdmin[2] },
  finance_admin: { read: financeAdmin[0], write: financeAdmin[1], approve: financeAdmin[2] },
  company_admin: { read: companyAdmin[0], write: companyAdmin[1], approve: companyAdmin[2] },
});

const NO: Triple = ['none', 'none', 'none'];
const OWN_R: Triple = ['own', 'none', 'none'];
const ALL_R: Triple = ['all', 'none', 'none'];
const ALL_RW: Triple = ['all', 'all', 'none'];
const ALL_RWA: Triple = ['all', 'all', 'all'];
/** Raise your own, approve nothing. */
const SELF: Triple = ['own', 'own', 'none'];
/** Read the line, write your own, decide the line's requests. */
const LINE: Triple = ['team', 'own', 'team'];

/**
 * Every module, by its route key.
 *
 * Read in the order somebody meets them: their own work first, then their
 * team's, then the company's, then the tenant's.
 */
export const POLICY: Record<string, ModulePolicy> = {
  /* ---- everybody's own work ---- */

  dashboard: rule(OWN_R, ['team', 'none', 'none'], ALL_R, ALL_R, ALL_R),

  /* A punch is written by the person who made it; a manager decides the
     regularisation when it was missed. Finance reads attendance because pay is
     derived from it, and changes none of it. */
  attendance: rule(SELF, LINE, ALL_RWA, ALL_R, ALL_RWA),
  leave: rule(SELF, LINE, ALL_RWA, ALL_R, ALL_RWA),
  timesheet: rule(SELF, LINE, ALL_RWA, ALL_R, ALL_RWA),
  helpdesk: rule(SELF, LINE, ALL_RWA, NO, ALL_RWA),

  /*
   * Expenses are a pay module, so both administrative roles hold them equally.
   *
   * This gave hr_admin exactly what an employee has, on the reasoning that
   * expenses are finance's. That is not how this company runs them: HR and
   * finance are interchangeable across everything that touches what somebody
   * is paid, and a claim is part of that. Both now read, edit and approve the
   * company's claims.
   *
   * A manager still decides their own line's first — the layer is additive and
   * unchanged. The two-stage chain, manager then finance, is a workflow rather
   * than a scope and is a later task; today either may approve.
   */
  expenses: rule(SELF, LINE, ALL_RWA, ALL_RWA, ALL_RWA),

  /* An asset is issued centrally and answered for locally. */
  assets: rule(SELF, LINE, ALL_R, ALL_R, ALL_RWA),

  /*
   * A shift is the hours you keep, so everyone sees their own and a manager
   * moves their line onto different ones. Overtime approval rides here too.
   */
  shifts: rule(OWN_R, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),

  /*
   * Pay, and the two administrative roles are identical across all of it.
   *
   * hr_admin read the register and could not run it; finance_admin could not
   * set what anybody was paid. That split described a separation of duties this
   * company does not have — the same two people do both — and it produced the
   * worst possible failure mode: a payroll cycle that only one named role could
   * close, with nobody able to cover.
   *
   * So hr_admin and finance_admin are now the same on payroll, compensation,
   * tax, benefits and expenses. Where they still differ is everything else: HR
   * keeps the people modules, finance keeps the commercial book and billing,
   * and neither reaches into the other's.
   *
   * A manager sees their own payslip and nobody else's. That is the one
   * addition the layer deliberately does not make, and it is unchanged.
   */
  payroll: rule(OWN_R, OWN_R, ALL_RWA, ALL_RWA, ALL_RWA),
  tax: rule(SELF, SELF, ALL_RWA, ALL_RWA, ALL_RWA),

  /*
   * Setting somebody's salary stays its own module rather than a corner of
   * `payroll`, even though the two administrative roles now hold both equally.
   *
   * The split still earns its place: a tenant that later wants finance to run
   * the cycle without being able to change what people are paid takes this
   * away without also taking away everyone's own payslip, which is what
   * narrowing `payroll` would do. The per-tenant override layer can express
   * exactly that, and could not if these were one module.
   *
   * Nothing below an administrative role, and not by oversight: a manager who
   * can revise their own report's pay is a manager who can give themselves a
   * team of one.
   */
  compensation: rule(NO, NO, ALL_RWA, ALL_RWA, ALL_RWA),
  benefits: rule(SELF, SELF, ALL_RWA, ALL_RWA, ALL_RWA),

  /* Own documents and letter requests; HR issues them. */
  documents: rule(SELF, SELF, ALL_RWA, SELF, ALL_RWA),

  /* Goals and check-ins are written together, so a manager writes on the line. */
  performance: rule(SELF, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),
  learning: rule(SELF, LINE, ALL_RWA, NO, ALL_RWA),
  devplans: rule(SELF, LINE, ALL_RWA, NO, ALL_RWA),

  /* ---- what the company shares ---- */

  /* The org chart is public on purpose — it is how people find each other. */
  org: rule(ALL_R, ALL_R, ALL_R, ALL_R, ALL_R),
  announcements: rule(ALL_R, ['all', 'team', 'team'], ALL_RWA, ALL_R, ALL_RWA),
  celebrations: rule(ALL_R, ['all', 'team', 'team'], ALL_RWA, ALL_R, ALL_RWA),
  events: rule(['all', 'own', 'none'], ['all', 'team', 'team'], ALL_RWA, ALL_R, ALL_RWA),

  /*
   * Survey results are withheld below the response floor regardless of role —
   * that is in the service, not here, and it applies to every role alike.
   * Answering is the one thing in this module every employee is meant to do.
   */
  engagement: rule(['all', 'own', 'none'], ['all', 'own', 'none'], ALL_RW, ['all', 'own', 'none'], ALL_RW),

  /* Anyone can be assigned work and move their own card. Not in the access
     table; kept as it was, with both administrative roles reading the board. */
  /* The layer writes its own line. 'all' let a manager edit anybody's plan. */
  planner: rule(['all', 'own', 'none'], ['all', 'team', 'none'], ALL_RW, ['all', 'own', 'none'], ALL_RW),

  /*
   * The directory narrows rather than opens: an employee sees themselves, a
   * manager their line, HR everyone and finance everyone it needs to pay.
   * The org chart above is the public view; this one carries contact and
   * employment detail.
   */
  employees: rule(OWN_R, ['team', 'none', 'none'], ALL_RW, ALL_R, ALL_RW),
  jobtitles: rule(OWN_R, ALL_R, ALL_RW, ALL_R, ALL_RW),

  /* ---- people, which is HR's ---- */

  /*
   * The layer reads its line and writes nothing. Changing somebody's
   * lifecycle record is HR's act, not their manager's.
   *
   * This leaves a manager with no way to ask for one either. The request
   * flow that would replace it needs a pending state neither this record
   * nor the exit record has, so it is a schema change and not part of
   * this. Until it exists, assigning a lifecycle task is hr_admin's.
   */
  lifecycle: rule(SELF, ['team', 'none', 'none'], ALL_RWA, ALL_R, ALL_RWA),
  onboarding: rule(NO, ['team', 'team', 'none'], ALL_RWA, NO, ALL_RWA),
  hiring: rule(NO, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),
  recruitment: rule(NO, ['team', 'team', 'team'], ALL_RWA, NO, ALL_RWA),

  /* An exit is raised by HR or the manager and settled by finance, which is
     why finance approves here and writes nothing. */
  /* Reads their line, writes nothing - see lifecycle above. */
  exit: rule(SELF, ['team', 'none', 'none'], ALL_RWA, ['all', 'none', 'all'], ALL_RWA),

  /* ---- the tenant ---- */

  /*
   * The approvals inbox carries no rules of its own.
   *
   * Each queue belongs to a module and inherits that module's `approve`, so
   * which rows a role actually decides falls out of the table rather than being
   * written down twice. Both administrative roles read and approve `all` here,
   * and because they are identical across the pay modules they now see the same
   * pay and expense queues as each other — which needed no change here, only
   * the five rows above.
   */
  approvals: rule(NO, ['team', 'none', 'team'], ['all', 'none', 'all'], ['all', 'none', 'all'], ['all', 'none', 'all']),

  /*
   * A report is a saved question, and the rows it returns are whatever the
   * reader could already see. So the access table's "people data" and "pay
   * data" qualifiers need no expression here, and when the pay modules became
   * common to both administrative roles their reports followed automatically —
   * this module did not change, which is the point of deriving it.
   */
  reports: rule(NO, ['team', 'own', 'none'], ALL_RW, ALL_RW, ALL_RW),
  customreports: rule(NO, ['team', 'own', 'none'], ALL_RW, ALL_RW, ALL_RW),
  exports: rule(NO, ['team', 'own', 'none'], ALL_RW, ALL_RW, ALL_RW),

  /* A contract is procurement and a seat is an access grant, so they part
     ways: a manager reads the estate and revokes on their own line. HR adds
     nothing — an employee still sees the licences they hold. */
  /*
   * Read narrowed to the line, because the estate is not a catalogue: every
   * seat carries employee_id, full_name and dept_code, so reading it at
   * 'all' told a manager who in the company holds which licence.
   */
  software: rule(OWN_R, ['team', 'team', 'none'], NO, ALL_R, ALL_RWA),

  /*
   * User administration, and the one module where the table narrows what a
   * manager used to have.
   *
   * A manager could create logins, resend invitations, bulk-import and assign
   * roles on their line. They read their line now and nothing else: creating a
   * login is company_admin's alone. A manager still raises a joiner — that is
   * `lifecycle`, where they keep `team` write — so the act they lose is making
   * an account, not starting somebody's employment.
   *
   * hr_admin reads every user and changes none, which is why every act below
   * except `user.view` is company_admin's.
   */
  users: rule(NO, ['team', 'none', 'none'], ALL_R, NO, ALL_RWA),

  /*
   * Only company_admin. Users, roles and settings - departments, locations,
   * leave policies, salary components - are one job, and it is not HR's.
   *
   * HR held read: all here, which put the whole section in their menu as a
   * read-only tour. If HR turns out to need one tab of it (the leave policy
   * text is the likely one), that is a grant on that tab, not on settings.
   */
  settings: rule(NO, NO, NO, NO, ALL_RWA),
  security: rule(NO, NO, NO, NO, ALL_RWA),
  integrations: rule(NO, NO, NO, NO, ALL_RWA),
  billing: rule(NO, NO, NO, ALL_R, ALL_R),

  /* Not in the access table. Executive reporting reads the tenant and writes
     nothing; both administrative roles see it, as they do `dashboard`. */
  exec: rule(NO, NO, ALL_R, ALL_R, ALL_R),

  /*
   * The commercial book. Bill rates, client credit limits and vendor markups
   * are commercial terms, so this is finance's and company_admin's. HR reads
   * the requirements and the bench because those are about people to hire.
   */
  clients: rule(NO, NO, NO, ALL_RW, ALL_RW),
  vendors: rule(NO, NO, NO, ALL_RW, ALL_RW),
  placements: rule(NO, NO, NO, ALL_RW, ALL_RW),
  requirements: rule(NO, NO, ALL_R, NO, ALL_RW),
  bench: rule(NO, NO, ALL_R, NO, ALL_RW),

  /*
   * Your own account, and only ever your own.
   *
   * `own` for every role including company_admin — deliberately. This module is
   * the control that lets somebody notice a session they did not start, and it
   * only works if it is the *person's* view. Reading somebody else's is user
   * administration and belongs in `users`, where it is scoped.
   */
  account: rule(SELF, SELF, SELF, SELF, SELF),
};

export const ROLES: Role[] = ['employee', 'hr_admin', 'finance_admin', 'company_admin'];

/* ---------------------------------------------------------------------------
 * A temporary bridge, which the service sweep deletes
 * ---------------------------------------------------------------------------
 *
 * `Caller.role` still carries the old three values, and 203 `caller.role`
 * comparisons across 47 services still read them. Converting those is a
 * *semantic* change, not a rename: `caller.role !== 'admin'` has to become a
 * question about a module and a verb, because renaming it to `company_admin`
 * would hand hr_admin and finance_admin nothing and defeat the whole model.
 *
 * So that conversion is its own reviewable step, and until it lands this maps
 * the old names onto the new ones at the handful of places that already ask
 * the policy. The mapping is the migration's: `admin` became `company_admin`,
 * `manager` became an employee whose team scope is derived.
 *
 * **This function is scheduled for deletion.** When `Caller.role` carries a
 * `Role`, nothing needs it, and `checks/roles.ts` asserts it has no callers
 * left so it cannot quietly become permanent.
 */
export type LegacyRole = 'admin' | 'manager' | 'employee';

export const fromLegacyRole = (legacy: LegacyRole): Role =>
  (legacy === 'admin' ? 'company_admin' : 'employee');

/**
 * Whether a legacy caller should be treated as having reports.
 *
 * `manager` was an assigned role, so anybody holding it was presumed to answer
 * for somebody. Until the reporting tree is the authority, holding the old role
 * stands in for having reports — which keeps today's managers working through
 * the bridge rather than silently losing their team the moment the policy
 * widened.
 */
export const legacyHasReports = (legacy: LegacyRole): boolean => legacy === 'manager';

/**
 * The database value, as a role.
 *
 * Step A of the cutover leaves both vocabularies valid in the column, so this
 * is the one place that has to understand both:
 *
 *     admin     ->  company_admin
 *     manager   ->  employee, because answering for other people is not a
 *                   role. The layer comes from the reporting tree, which
 *                   `hasReports` below reads, so a manager keeps every
 *                   manager grant without the word surviving.
 *     employee  ->  employee
 *
 * Anything unrecognised becomes `employee`, the narrowest role there is,
 * rather than throwing: a login whose row holds a value nobody has heard of
 * should be able to see their own payslip and nothing else, not be unable to
 * sign in. The policy then fails closed on everything beyond that.
 *
 * Step C deletes this, once no row holds an old value.
 *
 * It lives here rather than in `session.ts` for a dull but real reason:
 * `employees/mapper.ts` reads `app_role` out of a row too, and importing it
 * from `session.ts` pulled `config.ts` in behind it, so a pure mapper
 * suddenly required DATABASE_URL and `check:payvisibility` could not even
 * load. This module is the vocabulary's home and has no environment of its
 * own. `session.ts` re-exports it, so it is still the one entry point for a
 * token's role.
 */
export const normaliseRole = (value: string): Role => {
  switch (value) {
    case 'company_admin':
    case 'hr_admin':
    case 'finance_admin':
    case 'employee':
      return value;
    case 'admin':
      return 'company_admin';
    case 'manager':
      return 'employee';
    default:
      return 'employee';
  }
};


/** Every layer a `role_permission` row may name: the roles, plus the derived one. */
export const POLICY_LAYERS: (Role | Layer)[] = [
  'employee', 'manager', 'hr_admin', 'finance_admin', 'company_admin',
];

const RANK: Record<Scope, number> = { none: 0, own: 1, team: 2, all: 3 };

/** The wider of two scopes. */
export const wider = (a: Scope, b: Scope): Scope => (RANK[a] >= RANK[b] ? a : b);

/** The narrower of two scopes. Used by the per-tenant override layer. */
export const narrower = (a: Scope, b: Scope): Scope => (RANK[a] <= RANK[b] ? a : b);

/** Whether a granted scope reaches as far as a needed one. */
export const covers = (granted: Scope, needed: Scope): boolean =>
  RANK[granted] >= RANK[needed];

const EMPTY: ModuleRule = { read: 'none', write: 'none', approve: 'none' };

/**
 * One layer's rule in one module, in isolation.
 *
 * Not the question a service should ask — see `effectiveFor`. This is for the
 * screens that explain the model and for the override editor, both of which
 * are about a single layer rather than about a person.
 */
export const ruleFor = (layer: Role | Layer, module: string): ModuleRule =>
  POLICY[module]?.[layer] ?? EMPTY;

/**
 * What a person actually reaches: their role, plus employee, plus the manager
 * layer where they have reports.
 *
 * The union, per verb. This is the question every service asks.
 */
export function effectiveFor(
  role: Role,
  hasReports: boolean,
  module: string,
): ModuleRule {
  /*
   * Fail closed on a role nobody recognises.
   *
   * `Role` is a compile-time promise and this value may not have been
   * compiled: it can arrive from a column, a token claim or a fixture. Left
   * unguarded, an unknown role kept the employee baseline and the manager
   * layer, so it read as an ordinary member of staff rather than as nobody.
   * EMPTY is the only honest answer to "what may this unknown thing do".
   */
  if (!(ROLES as readonly string[]).includes(role)) return EMPTY;
  const p = POLICY[module];
  if (!p) return EMPTY;
  const layers: ModuleRule[] = [p.employee, p[role] ?? EMPTY];
  if (hasReports) layers.push(p.manager);
  return layers.reduce((acc, r) => ({
    read: wider(acc.read, r.read),
    write: wider(acc.write, r.write),
    approve: wider(acc.approve, r.approve),
  }), EMPTY);
}

/** The modules a person may open at all — anything they can read something in. */
export const effectiveModulesFor = (role: Role, hasReports: boolean): string[] =>
  Object.keys(POLICY).filter((m) => effectiveFor(role, hasReports, m).read !== 'none').sort();

/**
 * The modules one layer grants a read in, in isolation.
 *
 * Kept for the access screen, which lists what each layer adds. A person's
 * navigation comes from `effectiveModulesFor`.
 */
export const modulesFor = (layer: Role | Layer): string[] =>
  Object.keys(POLICY).filter((m) => ruleFor(layer, m).read !== 'none').sort();

export const ROLE_SUMMARY: Record<Role, { title: string; blurb: string }> = {
  employee: {
    title: 'Employee',
    blurb: 'Their own record and requests, and what the company shares. '
      + 'Anyone with people reporting to them also gets their team, without '
      + 'being given another role.',
  },
  hr_admin: {
    title: 'HR administrator',
    blurb: 'People: the directory, joining and leaving, attendance, leave, '
      + 'performance and the helpdesk, across the company. Runs pay as well — '
      + 'payroll, compensation, tax, benefits and expenses. Cannot create '
      + 'logins or change roles.',
  },
  finance_admin: {
    title: 'Finance administrator',
    blurb: 'Pay in full — payroll, compensation, tax, benefits and expenses — '
      + 'plus the commercial book and billing. Does not reach the people '
      + 'records HR keeps, and cannot create logins or change roles.',
  },
  company_admin: {
    title: 'Company administrator',
    blurb: 'Everything, and the only role that creates logins, changes '
      + 'somebody\'s role or edits company settings. Still cannot approve '
      + 'their own requests.',
  },
};

/* ---------------------------------------------------------------------------
 * Administration, act by act
 * ---------------------------------------------------------------------------
 *
 * A module-level rule answers "may this role open user management". It cannot
 * answer "may this person delete somebody", which is the question that matters
 * here — the module is one screen and the acts on it carry different risks. So
 * administration is described act by act, each with the reach that act is
 * allowed, and the service asks about the act rather than the screen.
 */

export type UserAction =
  | 'user.view'
  | 'user.create'
  /**
   * Ask for an account, rather than open one.
   *
   * A manager knows a joiner is starting before anybody in HR does, and the
   * product has always had the Pending Approval state for it. What it did
   * not have was a permission: the flow existed and `user.create` refused
   * it, so the button submitted into a refusal. This is that permission,
   * and it is deliberately not user.create - a request carries no sign-in,
   * no role above employee, and no way to activate what it made.
   */
  | 'user.request'
  | 'user.edit'
  | 'user.delete'
  | 'user.activate'
  | 'user.deactivate'
  | 'user.suspend'
  | 'user.approve'
  | 'user.reset_password'
  | 'user.resend_invite'
  | 'user.bulk_import'
  | 'user.bulk_update'
  | 'user.export'
  | 'role.assign'
  | 'role.assign_admin'
  | 'permission.manage';

/**
 * How far each layer may reach with each act.
 *
 * Almost everything here is company_admin's alone, which is the access table's
 * instruction: only company_admin creates logins, assigns or changes roles, or
 * edits company settings.
 *
 * What changed, and why it is a narrowing rather than an oversight:
 *
 * **A manager no longer creates logins, resends invitations, bulk-imports or
 * assigns roles.** They did all four on their own line. Creating an account is
 * the act that grants access to the product, and a manager raising a joiner
 * does not need it — `lifecycle` carries that, with `team` write. They keep
 * `user.view` over their line, which is what the directory already gave them.
 *
 * **hr_admin reads users and changes none of them.** They run people's
 * employment, not people's accounts, and the access table gives them
 * view-only on Users & roles. Whether HR should be able to *request* a login
 * is an open question; today they ask company_admin.
 *
 * **A manager may deactivate nothing.** Deactivating used to be theirs on the
 * grounds that offboarding is ordinary. It is an account act, and account acts
 * are now company_admin's; the lifecycle record they do own records the exit.
 */
const ACTION_SCOPE: Record<UserAction, Record<Role | Layer, Scope>> = {
  'user.view': {
    employee: 'none', manager: 'team', hr_admin: 'all', finance_admin: 'none', company_admin: 'all',
  },
  'user.create': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /* Theirs for their own line, and it produces a request, not an account. */
  'user.request': {
    employee: 'none', manager: 'team', hr_admin: 'all', finance_admin: 'none', company_admin: 'all',
  },
  'user.edit': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /* Removing an account is irreversible in a way the rest of this is not. */
  'user.delete': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'user.activate': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'user.deactivate': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /* A sanction, not an administrative state. */
  'user.suspend': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'user.approve': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /* Password reset is account recovery, and recovery is the standard route to
     taking over an account. */
  'user.reset_password': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'user.resend_invite': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'user.bulk_import': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'user.bulk_update': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /*
   * Exporting the user list is an account act, so it sits with the others.
   * People-data exports are `exports`, which hr_admin has at `all` — so HR can
   * take out a directory without this.
   */
  'user.export': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /* Assigning a role at all. Bounded further by the next line, and by the
     service, which refuses the caller's own row. */
  'role.assign': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  /*
   * Handing out an administrative role — any of the three. Identical to
   * `role.assign` now that only one role assigns anything, and kept separate
   * because the two answer different questions: one is "may you assign", the
   * other "may you assign *this*". Collapsing them would lose the second the
   * moment a tenant wants a role that assigns some roles and not others.
   */
  'role.assign_admin': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
  'permission.manage': {
    employee: 'none', manager: 'none', hr_admin: 'none', finance_admin: 'none', company_admin: 'all',
  },
};

/** How far this layer may reach performing this act. `none` means not at all. */
export const actionScope = (layer: Role | Layer, action: UserAction): Scope =>
  ACTION_SCOPE[action]?.[layer] ?? 'none';

/**
 * How far this person may reach performing this act.
 *
 * The union again: the manager layer applies where they have reports.
 */
export const effectiveActionScope = (
  role: Role,
  hasReports: boolean,
  action: UserAction,
): Scope => {
  const own = actionScope(role, action);
  return hasReports ? wider(own, actionScope('manager', action)) : own;
};

/** Whether this person may perform this act at all, anywhere. */
export const may = (role: Role, hasReports: boolean, action: UserAction): boolean =>
  effectiveActionScope(role, hasReports, action) !== 'none';

/**
 * Whether this person may hand out `granted`.
 *
 * Separate from `role.assign` because the restriction is on the *value*, not
 * on the act. Every administrative role is gated behind `role.assign_admin`.
 *
 * **This does not answer "may they change their own role".** They may not, ever,
 * including company_admin, and a role is a value rather than a row here — the
 * service compares the target to the caller and refuses.
 */
/**
 * Whether handing out this role takes more than the right to make an account.
 *
 * The baseline role grants nothing beyond what everybody already has, so
 * granting it needs no particular authority — a manager creating an ordinary
 * employee is not an escalation. Expressed here because the comparison is
 * against the vocabulary, and the vocabulary is this file's business: a
 * service writing `role !== 'employee'` is the hard-coded comparison the
 * sweep exists to remove.
 */
export const grantNeedsAuthority = (granted: Role): boolean => granted !== 'employee';

export const mayAssignRole = (
  role: Role,
  hasReports: boolean,
  granted: Role,
): boolean => {
  if (!may(role, hasReports, 'role.assign')) return false;
  return granted === 'employee' ? true : may(role, hasReports, 'role.assign_admin');
};

/** Every act, for a screen that wants to show what a role can do. */
export const USER_ACTIONS = Object.keys(ACTION_SCOPE) as UserAction[];

/* ---------------------------------------------------------------------------
 * Per-tenant narrowing
 * ---------------------------------------------------------------------------
 *
 * `role_permission` holds one row per layer per module and may only ever
 * *narrow* what this file grants. A tenant that wants its HR administrators
 * kept out of the helpdesk takes it away there; nothing in that table can hand
 * out something this file does not.
 */

export type Overrides = Record<string, Partial<Record<Role | Layer, Partial<ModuleRule>>>>;

/** One layer's rule in one module, after this tenant's narrowing. */
export function effectiveRule(
  layer: Role | Layer,
  module: string,
  overrides: Overrides,
): ModuleRule {
  const base = ruleFor(layer, module);
  const o = overrides[module]?.[layer];
  if (!o) return base;
  return {
    read: o.read ? narrower(base.read, o.read) : base.read,
    write: o.write ? narrower(base.write, o.write) : base.write,
    approve: o.approve ? narrower(base.approve, o.approve) : base.approve,
  };
}

/**
 * What a person reaches, after this tenant's narrowing.
 *
 * The union is taken over the *narrowed* layers, not before: a tenant that
 * takes the helpdesk away from hr_admin has not taken away the employee's own
 * tickets, and narrowing the union would do exactly that.
 */
export function effectiveRuleFor(
  role: Role,
  hasReports: boolean,
  module: string,
  overrides: Overrides,
): ModuleRule {
  /*
   * Fail closed on a role nobody recognises.
   *
   * `Role` is a compile-time promise and this value may not have been
   * compiled: it can arrive from a column, a token claim or a fixture. Left
   * unguarded, an unknown role kept the employee baseline and the manager
   * layer, so it read as an ordinary member of staff rather than as nobody.
   * EMPTY is the only honest answer to "what may this unknown thing do".
   */
  if (!(ROLES as readonly string[]).includes(role)) return EMPTY;
  if (!POLICY[module]) return EMPTY;
  const layers: (Role | Layer)[] = hasReports
    ? ['employee', 'manager', role]
    : ['employee', role];
  return layers
    .map((l) => effectiveRule(l, module, overrides))
    .reduce((acc, r) => ({
      read: wider(acc.read, r.read),
      write: wider(acc.write, r.write),
      approve: wider(acc.approve, r.approve),
    }), EMPTY);
}

export const effectiveModulesForTenant = (
  role: Role,
  hasReports: boolean,
  overrides: Overrides,
): string[] =>
  Object.keys(POLICY)
    .filter((m) => effectiveRuleFor(role, hasReports, m, overrides).read !== 'none')
    .sort();
