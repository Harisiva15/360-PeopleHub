/**
 * User accounts.
 *
 * An account is `tenant_membership` joined to the `employee` it acts as.
 * 0030 gave it the rest of a lifecycle — deactivation, deletion, invitation
 * counts, approval — and this is the layer over it.
 *
 * **The role ladder is enforced here, not in the menu.** Three rules, each of
 * which would be a privilege escalation if it lived only in the frontend:
 *
 *   A manager may raise an account, and it lands `pending_approval`. Only an
 *   administrator approves. Otherwise "raise a user" is "create a user" with
 *   an extra click.
 *
 *   Nobody but an administrator may grant the administrator role, and an
 *   administrator may not remove their own. An account that can demote every
 *   other administrator can lock the tenant out of itself.
 *
 *   A manager may only touch accounts on their own line, checked in SQL
 *   against the same recursive scope every other module uses.
 *
 * **Deleted is a status, not a DELETE.** Removing the row takes the audit
 * trail's subject with it and orphans every historical reference. The
 * employment record is not identity and must outlive the login.
 */

import { reaches } from '../../auth/can.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
/* One creation path for leave entitlement, shared with joiners and onboarding. */
import { openLeaveBalances } from '../people/provision.ts';
/* One employment-history writer, shared with provisioning and exits. */
import { recordEmployment, reasonForChange, termsOf } from '../people/employment.ts';
import { assignInitialSchedule } from '../schedules/service.ts';
import { assignShift, assignableShiftId } from '../shifts/service.ts';
import { authAdmin, inviteRedirect } from '../../auth/adminApi.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { ROLES, grantNeedsAuthority, mayAssignRole } from '../../auth/policy.ts';
import type { Role } from '../../auth/policy.ts';
import { employeeScope } from '../../tenancy/scope.ts';

export class UserError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

/**
 * What "administrator" is, as a column value.
 *
 * It read `['admin', 'company_admin']` through expand, because the column
 * could hold either name and asking for one of them would have counted half
 * the administrators — the guard passing in silence with the last one
 * removable. Step C (0060) removed 'admin' from the CHECK constraints on
 * `tenant_membership.role` and `employee.app_role`, so the column cannot hold
 * it and the list is down to the name that is left.
 *
 * Still a list rather than a string, and still column values rather than
 * `Caller.role`: a second administrator role would join it here, and
 * `asRole()` never sees these.
 *
 * Shared by both halves of the last-administrator invariant: deactivation and
 * demotion. They were written apart, and only one of them had been expanded.
 */
const ADMIN_ROLES = ['company_admin'];

/*
 * The vocabulary this module speaks is the policy's, not its own.
 *
 * It declared `type Role = 'admin' | 'manager' | 'employee'` here, shadowing
 * the real one, which is why every role question below was still asking the old
 * question and why `tsc` had nothing to say about it. Importing the type is
 * what turns the rest of this file's mistakes into compile errors.
 */
export type { Role };

export interface UserAccount {
  id: string; empId: string | null; name: string; email: string; phone: string;
  code: string; dept: string; designation: string; site: string;
  managerId: string | null; empType: string; joinedOn: string;
  role: Role; status: string;
  /** The hours their attendance is measured against, by code. */
  shift: string;
  createdOn: string; createdById: string | null;
  modifiedOn: string | null; modifiedById: string | null;
  lastLoginAt: string | null; invitedCount: number; inviteSentAt: string | null;
  mustChangePassword: boolean;
  /** Set by an administrator; satisfied only by the person themselves. */
  mfaRequired: boolean;
  lockedAt: string | null; lockReason: string;
  deactivatedAt: string | null; deactivatedById: string | null;
  deactivationReason: string;
  requestedById: string | null; approvedById: string | null; approvedAt: string | null;
}

export interface UserFilter {
  q?: string | undefined; status?: string | undefined; role?: string | undefined;
  dept?: string | undefined; site?: string | undefined;
  managerId?: string | undefined; empType?: string | undefined;
  joinedFrom?: string | undefined; joinedTo?: string | undefined;
}

export interface UserDraft {
  name: string; email: string; phone?: string | undefined; code?: string | undefined;
  dept: string; designation: string; site: string;
  managerId?: string | null | undefined; role: Role;
  empType?: string | undefined; joinedOn?: string | undefined;
  empId?: string | null | undefined; sendInvitation?: boolean | undefined;
  /**
   * The working pattern this person starts on, by code. Optional; omitted leaves
   * them unassigned rather than defaulted. Validated against this tenant.
   */
  workScheduleCode?: string | null | undefined;
  /**
   * The hours their attendance is measured against, by code.
   *
   * Omitted leaves `createUser`'s country default alone — the shift whose code
   * matches the site's country, which is the right answer for everybody who
   * works where they sit. It is there for the people who do not: somebody in
   * Chennai on US hours is on a US shift at an Indian site, and until this
   * field existed the only way to say so was the roster screen, which an
   * administrator setting up an account has no reason to visit.
   *
   * On an edit it goes through `assignShift`, the roster screen's own writer,
   * so the rules and the audit entry are the same by either door. Unchanged
   * values are dropped before that call rather than passed through it: the
   * form posts every field, and a manager editing a report's phone number
   * must not be refused by a shift guard they never touched.
   */
  shiftCode?: string | null | undefined;
}

export type UserPatch = Partial<Omit<UserDraft, 'sendInvitation'>>;

/* The database's vocabulary, and the screens'. Mapped in one place. */
const TO_DB: Record<string, string> = {
  'Pending Approval': 'pending_approval', 'Invitation Pending': 'invited',
  Active: 'active', Inactive: 'inactive', Locked: 'locked',
  Suspended: 'suspended', Deleted: 'deleted',
};
const FROM_DB: Record<string, string> = Object.fromEntries(
  Object.entries(TO_DB).map(([k, v]) => [v, k]));

interface Row {
  id: string; employee_id: string | null; role: Role; status: string;
  full_name: string | null; work_email: string | null; phone: string | null;
  code: string | null; dept_code: string | null; designation: string | null;
  site_code: string | null; manager_id: string | null; shift_code: string | null;
  employment_type: string | null; joined_on: string | null;
  invited_at: string | null; last_login_at: string | null;
  invited_count: number; invite_sent_at: string | null;
  must_change_password: boolean;
  mfa_required: boolean;
  locked_at: string | null; lock_reason: string | null;
  deactivated_at: string | null; deactivated_by: string | null;
  deactivation_reason: string | null;
  requested_by: string | null; approved_by: string | null; approved_at: string | null;
  account_email: string | null;
}

/*
 * The account's own name and email are read from the employee where there is
 * one. An account with no employee row — an administrator who is not on
 * payroll — still has to render, so every one of these is COALESCEd rather
 * than joined INNER.
 */
const PROJECTION = `
  SELECT m.id, m.employee_id, m.role, m.status,
         e.full_name, e.work_email, e.phone, e.code,
         d.code AS dept_code, e.designation, s.code AS site_code, e.manager_id,
         sh.code AS shift_code,
         e.employment_type, e.joined_on::text,
         m.invited_at::text, m.last_login_at::text, m.invited_count,
         m.invite_sent_at::text, m.must_change_password, m.mfa_required,
         m.locked_at::text, m.lock_reason,
         m.deactivated_at::text, m.deactivated_by, m.deactivation_reason,
         m.requested_by, m.approved_by, m.approved_at::text,
         -- Not a join: app_rw has no access to the auth schema, and cannot
         -- be granted one because supabase_auth_admin owns it. 0042 wraps
         -- the single column this needs in a SECURITY DEFINER function.
         auth_email_for(m.user_id) AS account_email
    FROM tenant_membership m
    LEFT JOIN employee e ON e.id = m.employee_id
    LEFT JOIN department d ON d.id = e.department_id
    LEFT JOIN site s ON s.id = e.site_id
    LEFT JOIN shift sh ON sh.id = e.shift_id
`;

const toAccount = (r: Row): UserAccount => ({
  id: r.id,
  empId: r.employee_id,
  name: r.full_name ?? r.account_email ?? '—',
  email: r.work_email ?? r.account_email ?? '',
  phone: r.phone ?? '',
  code: r.code ?? '',
  dept: r.dept_code ?? '',
  designation: r.designation ?? '',
  site: r.site_code ?? '',
  managerId: r.manager_id,
  empType: r.employment_type ?? '',
  joinedOn: r.joined_on ?? '',
  role: r.role,
  status: FROM_DB[r.status] ?? r.status,
  shift: r.shift_code ?? '',
  createdOn: r.invited_at?.slice(0, 10) ?? '',
  createdById: r.requested_by,
  modifiedOn: null,
  modifiedById: null,
  lastLoginAt: r.last_login_at,
  invitedCount: Number(r.invited_count ?? 0),
  inviteSentAt: r.invite_sent_at,
  mustChangePassword: Boolean(r.must_change_password),
  mfaRequired: Boolean(r.mfa_required),
  lockedAt: r.locked_at,
  lockReason: r.lock_reason ?? '',
  deactivatedAt: r.deactivated_at,
  deactivatedById: r.deactivated_by,
  deactivationReason: r.deactivation_reason ?? '',
  requestedById: r.requested_by,
  approvedById: r.approved_by,
  approvedAt: r.approved_at,
});

/**
 * Who this caller may administer.
 *
 * An employee administers nobody — not even themselves; changing your own role
 * is not self-service. A manager reaches their own line. The predicate is in
 * SQL, so a crafted id cannot walk past it.
 */
function scopeFor(
  caller: Caller,
  params: unknown[],
  /*
   * Which reach decides visibility. `write` by default, because every caller
   * that loads a row in order to change it has already passed `mayWrite` and
   * should only reach rows it may actually change.
   *
   * The two read paths pass `read`, and they have to. This asked the *write*
   * scope for everybody, so an HR administrator — `users: ALL_R`, read all,
   * write none by the declared policy — fell to `FALSE` and saw User
   * management as an empty list, with `getUser` answering "that account is
   * outside the people you can manage" about an account they are entitled to
   * read. A visibility predicate that asks about writing cannot answer a
   * read, and silently returning no rows is the worst way to get it wrong.
   */
  verb: 'read' | 'write' = 'write',
): string {
  if (reaches(caller, 'users', verb, 'all')) return 'TRUE';
  if (!caller.hasReports || !caller.employeeId) return 'FALSE';
  /*
   * **The verb goes through.** Write reach is built from the write grant and
   * never from the read scope.
   *
   * This call used to omit it, so `employeeScope` defaulted to `read` and the
   * *write* predicate came out of the *read* scope. For a manager that gave
   * the right-looking answer — `users read` is `team`, so they got their line.
   * For anybody holding `users read all` *and* having reports it returned
   * `TRUE`: write reach over every account in the tenant. hr_admin holds
   * `users read all`, so an HR administrator who also managed somebody was an
   * administrator of everything, including the ability to change anybody's
   * work email and then resend their invitation to it.
   *
   * It was the same shape as the frontend bug in 402c1b6, where both
   * `scopeOfDemo` call sites dropped the verb and every write question got the
   * read scope back.
   *
   * ## What this took away, and why nothing asked for it back
   *
   * `users write` is company_admin's alone, so a manager now loads no row for
   * writing and `updateUser`, `setUserStatus` and `bulkUpdateUsers` are
   * company_admin's. One assertion in `employment.test.mjs` required a manager
   * to change their own report's designation; it was testing this leak rather
   * than a workflow, because no screen has ever offered it — `ACTION_GATE`
   * puts `user.edit` behind `users write` and `ACTION_SCOPE` gives the manager
   * layer `none`, so the Edit control is not rendered for a manager and the
   * drawer is the only path to `updateUser`. The three assertions now state
   * the refusal.
   *
   * Creating is untouched and does not come through here: `createUser` gates
   * on `mayAdminister` and decides from the *write* scope what the create
   * *means* — `pending_approval` for a manager or an HR administrator, a live
   * account for company_admin. Raising a joiner was never an account edit.
   *
   * A manager who needs their report's department, manager or location changed
   * asks HR, which is what the `people` policy already says about lifecycle
   * records: "This leaves a manager with no way to ask for one either. The
   * request flow that would replace it needs a pending state neither this
   * record nor the exit record has, so it is a schema change." The same is
   * true here, and it is a feature rather than a guard.
   */
  return employeeScope(caller, 'm.employee_id', params, 'users', verb);
}

/**
 * Who may *see* accounts. A read gate, and only ever used as one.
 *
 * It was the gate on the writes as well, which is how a *read* scope came to
 * guard creating an account and changing somebody's name, email, designation,
 * department and manager. The declared policy
 * (`users: rule(NO, ['team','none','none'], ALL_R, NO, ALL_RWA)`) gives write
 * to the company administrator and to nobody else; what the code enforced was
 * `users read ≥ team`, which hr_admin holds as `read all` and any manager with
 * reports holds as `read team`.
 */
const mayAdminister = (caller: Caller) => {
  if (!reaches(caller, 'users', 'read', 'team')) {
    throw new UserError('Your role cannot manage accounts', 'forbidden');
  }
};

/*
 * There is no `mayWrite`, and that is a decision rather than an omission.
 *
 * One was added here and reverted. Gating the writes on `users write` looks
 * obviously right against the declared policy — which gives `users` write to
 * the company administrator and nobody else — and it breaks two workflows the
 * suites assert deliberately:
 *
 *   * `provisioning.test.mjs`: a manager may raise a joiner. `createUser`
 *     already handles that by what it produces, not by refusing — a caller
 *     without `users write all` creates `pending_approval`.
 *   * `employment.test.mjs`: a manager may change their own report's
 *     designation, recorded in employment history against the manager.
 *
 * So the model is "may you manage accounts" at the gate and "whose" in
 * `scopeFor`, and the policy's `write: none` for a manager describes a scope
 * the product does not consult on this path. Which of the two is wrong is a
 * product decision, not one to settle inside a guard.
 */

/**
 * Load an account and prove this caller may act on it.
 *
 * Always through the scope predicate. Loading by id and checking afterwards is
 * the shape that leaks — one branch forgets, and a manager edits an
 * administrator.
 */
async function load(
  db: TenantClient, caller: Caller, id: string,
  /* Defaults to the write reach: all but one caller loads a row to change
     it, and the exception says so. */
  verb: 'read' | 'write' = 'write',
): Promise<Row> {
  const params: unknown[] = [id];
  const scope = scopeFor(caller, params, verb);
  const { rows } = await db.query<Row>(
    `${PROJECTION} WHERE m.id = $1 AND (${scope})`, params);
  if (!rows[0]) {
    const { rows: exists } = await db.query('SELECT 1 FROM tenant_membership WHERE id = $1', [id]);
    throw new UserError(
      exists.length ? 'That account is outside the people you can manage' : 'No such account',
      exists.length ? 'forbidden' : 'not_found');
  }
  return rows[0];
}

export async function listUsers(caller: Caller, f: UserFilter = {}): Promise<UserAccount[]> {
  mayAdminister(caller);
  const params: unknown[] = [];
  /* A read: an HR administrator reads every account, a manager their line. */
  const where: string[] = [scopeFor(caller, params, 'read')];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.status) where.push(`m.status = ${bind(TO_DB[f.status] ?? f.status)}`);
  if (f.role) where.push(`m.role = ${bind(f.role)}`);
  if (f.dept) where.push(`d.code = ${bind(f.dept)}`);
  if (f.site) where.push(`s.code = ${bind(f.site)}`);
  if (f.managerId) where.push(`e.manager_id = ${bind(f.managerId)}`);
  if (f.empType) where.push(`e.employment_type = ${bind(f.empType)}`);
  if (f.joinedFrom) where.push(`e.joined_on >= ${bind(f.joinedFrom)}`);
  if (f.joinedTo) where.push(`e.joined_on <= ${bind(f.joinedTo)}`);
  if (f.q?.trim()) {
    const p = bind(`%${f.q.trim()}%`);
    where.push(`(e.full_name ILIKE ${p} OR e.work_email ILIKE ${p} OR e.code ILIKE ${p})`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION} WHERE ${where.join(' AND ')} ORDER BY e.full_name NULLS LAST`, params);
    return rows.map(toAccount);
  });
}

export async function getUser(caller: Caller, id: string): Promise<UserAccount | null> {
  mayAdminister(caller);
  return withTenantReadOnly(caller, async (db) => {
    try { return toAccount(await load(db, caller, id, 'read')); }
    catch (e) {
      if (e instanceof UserError && e.code === 'not_found') return null;
      throw e;
    }
  });
}

export async function userStats(caller: Caller) {
  const rows = await listUsers(caller);
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'Active').length,
    pendingApproval: rows.filter((r) => r.status === 'Pending Approval').length,
    inactive: rows.filter((r) => r.status === 'Inactive').length,
    invitationPending: rows.filter((r) => r.status === 'Invitation Pending').length,
  };
}

/** The next free employee code, so two administrators cannot mint the same one. */
export async function nextEmployeeCode(caller: Caller): Promise<string> {
  /* A read gate, because raising a joiner is open to a manager and the form
     that does it needs the next code. */
  mayAdminister(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{ code: string }>(
      "SELECT code FROM employee WHERE code IS NOT NULL AND btrim(code) <> ''");

    /* Codes shaped as a prefix followed by digits — the only kind that has a
       successor. Anything else is somebody's one-off and is skipped. */
    const parsed = rows
      .map((r) => /^(\D*?)(\d+)$/.exec(r.code.trim()))
      .filter((m): m is RegExpExecArray => m !== null);

    if (!parsed.length) {
      throw new UserError(
        'There is no existing employee ID to follow, so one cannot be suggested. '
        + 'Type the first one — it sets the pattern the rest will follow.',
        'invalid');
    }

    /*
     * The prefix most of this tenant's people already use, rather than one
     * chosen here.
     *
     * This used to return `E${n}` with the letter hard-coded and the number
     * padded to three, which was wrong twice over. It ignored the tenant's own
     * format — production uses VHM004, so it proposed E007 — and `/^E\d{3}$/`
     * is exactly the shape the browser's demo-id guard refuses, so every
     * suggestion was rejected by the client before it could be sent. "Suggest"
     * could not produce a usable value for any tenant with fewer than a
     * thousand people.
     *
     * Ties break alphabetically so the answer does not depend on row order.
     */
    const counts = new Map<string, number>();
    for (const m of parsed) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
    const prefix = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];

    const mine = parsed.filter((m) => m[1] === prefix);
    const width = Math.max(...mine.map((m) => m[2]!.length));
    const taken = new Set(rows.map((r) => r.code.trim()));

    /* Skip anything already in use: the highest number is not always the last
       one issued, and a collision is refused on save with a worse message. */
    let n = Math.max(...mine.map((m) => Number(m[2]))) + 1;
    let candidate = `${prefix}${String(n).padStart(width, '0')}`;
    while (taken.has(candidate)) {
      n += 1;
      candidate = `${prefix}${String(n).padStart(width, '0')}`;
    }
    return candidate;
  });
}

/**
 * Whether this caller may grant that role.
 *
 * The rule that matters: only an administrator makes an administrator. A
 * manager who could would be one.
 */
/**
 * Whether this caller may hand out this role.
 *
 * Asks the policy rather than comparing to a string. `role === 'admin'` guarded
 * exactly one spelling, so under the new vocabulary `company_admin` walked
 * straight past it — and `hr_admin` and `finance_admin` were never guarded at
 * all, in either vocabulary. `mayAssignRole` carries the approved rule: only a
 * company_admin grants anything other than `employee`.
 */
function mayGrant(caller: Caller, role: Role) {
  /*
   * Only the elevated grant, as before.
   *
   * `mayAssignRole` bundles two questions — may you assign roles at all, and
   * may you assign an administrative one — and asking it unconditionally moved
   * the baseline: a manager creating an ordinary employee was refused, which
   * `check:provisioning` caught. Whether somebody may create an account is
   * `mayAdminister`'s question, a few lines up. This one is only about handing
   * out something more than `employee`.
   */
  if (grantNeedsAuthority(role) && !mayAssignRole(caller.role, caller.hasReports, role)) {
    throw new UserError('Only an administrator can grant the administrator role', 'forbidden');
  }
}

/**
 * What `employee.employment_type` accepts.
 *
 * Mirrors `CHECK (employment_type IN (…))`, which migration 0003 put on the
 * column and 0012 repeated on `joining_request`. Held here so the refusal can
 * name the field, instead of Postgres refusing it as SQLSTATE 23514 and
 * `statusFor` turning that into "this request breaks a rule the data must
 * follow" — true, unhelpful, and identical for every CHECK in the schema.
 *
 * `check:users` asserts this list against the migration.
 */
export const EMPLOYMENT_TYPES = [
  'permanent', 'contract', 'intern', 'consultant',
] as const;

const validate = (d: Partial<UserDraft>) => {
  if (d.name !== undefined && !d.name.trim()) throw new UserError('Give the person a name', 'invalid');
  if (d.email !== undefined) {
    if (!d.email.trim()) throw new UserError('An account needs an email address', 'invalid');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) {
      throw new UserError('That is not an email address', 'invalid');
    }
  }
  /*
   * Request bodies accept the new vocabulary only, from step A onward.
   *
   * This listed the old three, so `company_admin` was refused as "Not a role"
   * and an administrator could not be created at all. The old names are *not*
   * accepted here even during expand: the normaliser in `session.ts` exists for
   * values read out of the database, and widening the input as well would mean
   * new rows still being written in the old vocabulary, which is what step B
   * has to migrate away from.
   */
  if (d.role !== undefined && !(ROLES as readonly string[]).includes(d.role)) {
    throw new UserError(`Not a role: ${ROLES.join(', ')}`, 'invalid');
  }
  /*
   * The employment type, named rather than left to the column.
   *
   * The screen sent display labels — `Full-time`, `Contract` — where the column
   * wants `permanent`, `contract`. Every account created from the Users drawer
   * was refused by the CHECK, and the answer said only that "this request
   * breaks a rule the data must follow", which is the same sentence every CHECK
   * in the schema produces. Nothing pointed at the field, so nothing pointed at
   * the screen that was wrong.
   */
  if (d.empType !== undefined
      && !(EMPLOYMENT_TYPES as readonly string[]).includes(d.empType)) {
    throw new UserError(
      `Not an employment type: ${EMPLOYMENT_TYPES.join(', ')}`, 'invalid');
  }
};

export async function createUser(caller: Caller, d: UserDraft): Promise<UserAccount> {
  /*
   * A read gate, deliberately. The write scope decides what a create *means*
   * rather than whether it is allowed: `status` below is `invited` or
   * `active` for a caller holding `users write all`, and `pending_approval`
   * for everybody else. A manager raising a joiner creates a request; an
   * administrator creates an account. The approval is a separate verb, which
   * is why `users` has one.
   *
   * `mayWrite` was here briefly and removed that workflow — and the suite
   * said so: `provisioning.test.mjs` asserts "a manager may create an
   * employee on a pattern, as before". The hole worth closing was never this
   * one. It is `updateUser`, `setUserStatus` and `bulkUpdateUsers`, which
   * change accounts that already exist and have no such split.
   */
  mayAdminister(caller);
  validate(d);
  mayGrant(caller, d.role);
  if (!d.dept) throw new UserError('Choose a department', 'invalid');
  if (!d.site) throw new UserError('Choose a location', 'invalid');
  /*
   * The membership records who raised and who approved it, and
   * `tenant_membership_approval_is_attributed` refuses an approval with nobody
   * attached. The INSERT below stamps `approved_at` whenever the status is not
   * `pending_approval` and takes `approved_by` from the caller — so a caller
   * with no employee record would set the first and not the second, and the
   * CHECK would refuse it as another anonymous 23514.
   *
   * It should not be reachable, for the same reason as in `passwordChanged`: a
   * membership with no `employee_id` cannot sign in. Named here anyway, because
   * the alternative answer is a 400 that describes nothing.
   */
  if (!caller.employeeId) {
    throw new UserError(
      'Your own account is not linked to an employee record, so it cannot be '
      + 'recorded as having created this one. Ask an administrator to check it.',
      'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows: dup } = await db.query(
      'SELECT 1 FROM employee WHERE lower(work_email) = lower($1)', [d.email.trim()]);
    if (dup.length) throw new UserError('That email address already has an account', 'duplicate');

    const { rows: dept } = await db.query<{ id: string }>(
      'SELECT id FROM department WHERE code = $1', [d.dept]);
    if (!dept[0]) throw new UserError('No such department', 'invalid');
    const { rows: site } = await db.query<{ id: string }>(
      'SELECT id FROM site WHERE code = $1', [d.site]);
    if (!site[0]) throw new UserError('No such location', 'invalid');

    if (d.managerId) {
      const { rows: mgr } = await db.query('SELECT 1 FROM employee WHERE id = $1', [d.managerId]);
      if (!mgr.length) throw new UserError('No such manager', 'invalid');
    }

    const code = d.code?.trim() || await nextEmployeeCode(caller);
    const { rows: dupCode } = await db.query('SELECT 1 FROM employee WHERE code = $1', [code]);
    if (dupCode.length) throw new UserError(`${code} is already in use`, 'duplicate');

    /*
     * Two columns the form does not ask for and the row cannot do without.
     *
     * Both are NOT NULL with no default, so omitting them made every attempt
     * to create a user fail with a constraint violation the screen reported as
     * "internal error". Resolved here, with a sentence each, because "this
     * company has no legal entity configured" is something an administrator
     * can act on and a Postgres constraint name is not.
     *
     * The legal entity is the tenant's default — there is one per company in
     * the ordinary case, and the flag says which when there are several.
     */
    const { rows: entity } = await db.query<{ id: string; country: string }>(
      'SELECT id, country FROM legal_entity ORDER BY is_default DESC, code LIMIT 1');
    if (!entity[0]) {
      throw new UserError(
        'This company has no legal entity configured, so an employee record '
        + 'cannot be created. Add one under Settings before creating accounts.',
        'invalid');
    }

    /*
     * The shift follows the site's country, because that is what shifts are
     * keyed by — IN, UK, US, AE. Picking one arbitrarily would put somebody in
     * Chennai on the UK roster and their attendance would be judged against
     * hours they never worked. Any shift is better than none if the country
     * has no roster of its own, and the row cannot exist without one.
     */
    const { rows: shift } = await db.query<{ id: string }>(
      `SELECT s.id FROM shift s
        ORDER BY (s.code = (SELECT country FROM site WHERE id = $1)) DESC, s.code
        LIMIT 1`,
      [site[0].id]);
    if (!shift[0]) {
      throw new UserError(
        'This company has no shifts configured, so an employee record cannot be '
        + 'created — attendance would have no hours to measure against.',
        'invalid');
    }

    /*
     * Unless the form said otherwise.
     *
     * The country default above is right for everybody who works where they
     * sit and wrong for everybody who does not, and the people who do not are
     * exactly the ones whose attendance goes wrong quietly — a Chennai-based
     * employee on US hours was measured against IST, so every shift of theirs
     * read as a day and a half late.
     *
     * Through `assignableShiftId` rather than a second lookup here, so "which
     * profiles may somebody be put on" is answered in one place: active ones.
     * There is no `assignShift` call on this path because there is no employee
     * row yet and so nothing to move — no previous shift, no `from`, nothing an
     * `employee_shift_changed` entry could describe. The hire is the record.
     */
    const shiftId = typeof d.shiftCode === 'string' && d.shiftCode.trim()
      ? await assignableShiftId(db, d.shiftCode)
      : shift[0].id;

    /*
     * Currency comes from the employing entity, as `provisionEmployee` derives
     * it. This path left the column null, so two people at the same entity
     * carried different currencies depending on which screen created them —
     * and the mapper coalesces null to INR, which is silently wrong the day
     * there is a non-Indian entity.
     *
     * `grade_id` is deliberately *not* copied across from that path. It is
     * optional in both (the onboarding flow supplies none either), so its
     * absence here is the same absence rather than a divergence.
     */
    const { rows: emp } = await db.query<{ id: string }>(
      `INSERT INTO employee
         (code, full_name, work_email, phone, department_id, site_id, designation,
          manager_id, employment_type, joined_on, status, app_role,
          legal_entity_id, shift_id, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, CURRENT_DATE),'active',$11,
               $12,$13,
               CASE WHEN $14::text = 'IN' THEN 'INR' ELSE 'USD' END)
       RETURNING id`,
      [code, d.name.trim(), d.email.trim(), d.phone ?? '', dept[0].id, site[0].id,
        d.designation, d.managerId ?? null, d.empType ?? 'permanent',
        d.joinedOn ?? null, d.role, entity[0].id, shiftId, entity[0].country]);

    /*
     * Open this leave year's balances.
     *
     * The joiner and onboarding flows have always done this through
     * `provisionEmployee`; this path wrote its own INSERT and did not, so
     * anybody created from User Management — which is how an administrator
     * actually creates an account — got no entitlement.
     *
     * Nothing failed at the time. They could apply for leave, the request
     * landed pending, and their manager got "no leave balance for that type
     * and year" on pressing approve: a refusal at the last step, on a
     * different person's screen, for a reason neither could act on. It took a
     * second and third real account to see it.
     */
    await openLeaveBalances(db, emp[0]!.id);

    /*
     * And the first employment record, dated from the joining date. Without it
     * an account made here has no history at all, and the lifecycle screen
     * shows a person who apparently began existing with no terms.
     */
    /*
     * The working pattern, where one was chosen.
     *
     * Through the schedule service and inside this transaction, as the joiner and
     * onboarding paths do it — so the rules are the same ones a hand-made
     * assignment obeys, and a schedule that cannot be assigned leaves no account
     * and no employee behind.
     *
     * Dated from the joining date the row above carries, never from today.
     */
    if (typeof d.workScheduleCode === 'string' && d.workScheduleCode.trim()) {
      const { rows: joined } = await db.query<{ on: string }>(
        'SELECT joined_on::text AS on FROM employee WHERE id = $1', [emp[0]!.id]);
      await assignInitialSchedule(db, caller, emp[0]!.id, {
        scheduleCode: d.workScheduleCode,
        validFrom: joined[0]!.on,
        validTo: null,
      });
    }

    await recordEmployment(db, emp[0]!.id, 'hire', {
      on: d.joinedOn ?? null, recordedBy: caller.employeeId,
    });

    /*
     * A manager's account lands pending_approval; an administrator's is live.
     * This is the difference between raising a request and creating a user,
     * and it is the whole reason a manager may touch this screen at all.
     */
    /*
     * An account nobody can sign into is not active.
     *
     * Creating one without an invitation used to mark it 'active', which put a
     * usable-looking row in the list for a person who had never been given a
     * way in — there is no Supabase user until they sign up, so nothing could
     * authenticate as it. 0046 makes that state impossible; this makes it
     * unnecessary.
     *
     * Both paths are 'invited'. The difference is whether an email went out,
     * which is what invite_sent_at records — "create the account, I will tell
     * them myself" is a choice about the message, not about the account.
     */
    const status = reaches(caller, 'users', 'write', 'all')
      ? 'invited'
      : 'pending_approval';

    /*
     * Whether an invitation is actually going out.
     *
     * `status === 'invited'` means an administrator made this account rather
     * than a manager raising a joiner — a joiner waits for approval and must
     * not be emailed a sign-in.
     *
     * **`=== true`, not `!== false`.** Sending mail to a real person is an
     * outbound side effect and has to be asked for, not merely left
     * un-refused. This read `!== false` for one commit, which made *omitting*
     * the flag mean "send": `users/import.ts` omits it entirely, so a bulk
     * import of a hundred people would have emailed all hundred of them, and
     * `hierarchy.test.mjs` — which also omits it — caught exactly that by
     * asserting "creating an account sends nothing by itself".
     *
     * The drawer always passes the checkbox explicitly, so the screen behaves
     * the same either way. Everything that does not ask now stays silent.
     */
    const sending = status === 'invited' && d.sendInvitation === true;

    /*
     * Called inside the transaction, exactly as `inviteUser` does it, and for
     * the same reason: if the provider refuses, the throw takes the employee
     * row, the membership and the audit entry with it, so a refused send
     * cannot leave behind an account that claims one happened.
     *
     * This used to be missing entirely. `invite_sent_at` was stamped whenever
     * the status was `invited` and `invited_count` was hard-coded to 1, while
     * nothing ever asked Supabase for anything — so every account created from
     * the Users screen recorded an invitation that was never sent, and the
     * drawer displayed the date of it. `sendInvitation` reached only
     * `must_change_password`, which is why ticking the box changed nothing an
     * email could come out of.
     */
    if (sending) {
      await authAdmin().inviteToSetPassword(d.email.trim(), inviteRedirect());
    }

    /*
     * `must_change_password` is `true`, unconditionally.
     *
     * It used to be `d.sendInvitation === false` — set only when the
     * administrator was going to tell the person their password themselves, and
     * left `false` when an invitation was sent, on the assumption that the
     * invitation link forces a password to be chosen. It does not. Supabase's
     * invite link hands back a working session, which arrives as an ordinary
     * sign-in, and `SetPassword` renders only when `account-status` reports
     * `mustChangePassword` or the auth event was `PASSWORD_RECOVERY`. So an
     * invited person went straight to the home page and ended up with an
     * account they could reach and no password they had chosen.
     *
     * There is no case where a newly created account should be `false`: this
     * path never sets a password, so until somebody chooses one there is
     * nothing to keep. An invitation can only ever mean "set your password".
     *
     * The flag is the reliable half of the gate — it is a fact in the database
     * rather than a guess about which event Supabase emitted. The link type is
     * read on the client too, so the screen appears before the first request
     * comes back, but if the two ever disagree this is the one that decides.
     */
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tenant_membership
         (user_id, role, employee_id, status, invited_at, invite_sent_at,
          invited_count, must_change_password, requested_by,
          approved_by, approved_at)
       VALUES (NULL, $1, $2, $3, now(),
               CASE WHEN $6 THEN now() ELSE NULL END,
               CASE WHEN $6 THEN 1 ELSE 0 END,
               true, $4,
               CASE WHEN $3 <> 'pending_approval' THEN $5::uuid ELSE NULL END,
               CASE WHEN $3 <> 'pending_approval' THEN now() ELSE NULL END)
       RETURNING id`,
      [d.role, emp[0]!.id, status, caller.employeeId, caller.employeeId, sending]);

    await audit(db, caller, 'user.created', rows[0]!.id,
      `${d.name.trim()} · ${d.role} · ${FROM_DB[status]}`);

    /*
     * A second row when one went out, in the same shape `inviteUser` writes,
     * so "was this person ever sent an invitation?" has one answer to look for
     * rather than two depending on which screen created them.
     */
    if (sending) {
      await audit(db, caller, 'user.invited', rows[0]!.id,
        `${d.role} · attempt 1 · sent with the account`);
    }
    const made = await getUser(caller, rows[0]!.id);
    if (!made) throw new UserError('The account was not created', 'invalid');
    return made;
  });
}

export async function updateUser(
  caller: Caller,
  id: string,
  patch: UserPatch,
): Promise<UserAccount> {
  /*
   * The gate is "may you manage accounts at all"; `load` below decides *which*
   * accounts, through `scopeFor`. That division is the model, and keeping it
   * is why there is no `mayWrite` here: a gate asking `users write` would also
   * refuse `createUser`'s manager path, where the write scope is supposed to
   * decide what the create *means* rather than whether it happens.
   *
   * The row predicate is the half that carries the write question, and it now
   * asks it — `scopeFor` passes the verb through, so `users write` being
   * company_admin's makes this company_admin's. See `scopeFor` for what that
   * took away and why nothing reachable asked for it back.
   */
  mayAdminister(caller);
  validate(patch);
  if (patch.role) mayGrant(caller, patch.role);

  return withTenant(caller, async (db) => {
    const row = await load(db, caller, id);

    /*
     * An administrator cannot take their own administrator role away. An
     * account that can demote every administrator including itself can lock
     * the tenant out of its own settings, and there is no way back in.
     */
    const losingAdmin = Boolean(patch.role)
      && ADMIN_ROLES.includes(row.role)
      && !ADMIN_ROLES.includes(patch.role!);

    if (losingAdmin && row.employee_id === caller.employeeId) {
      throw new UserError('You cannot remove your own administrator role', 'forbidden');
    }

    /*
     * And the last administrator cannot be demoted by anybody, including by
     * another administrator.
     *
     * The deactivation half of this invariant counted; this half only ever
     * checked "is it me", so two administrators could take each other's role
     * away and lock the tenant out of its own settings — the same outcome the
     * other half exists to prevent, by a different door. There is no database
     * trigger behind either; the guard is all there is.
     */
    if (losingAdmin) {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tenant_membership
          WHERE role = ANY($2) AND status = 'active' AND id <> $1`,
        [id, ADMIN_ROLES]);
      if (Number(rows[0]?.n ?? 0) === 0) {
        throw new UserError(
          'That is the last administrator — give somebody else the role first',
          'forbidden');
      }
    }

    if (patch.role) {
      await db.query('UPDATE tenant_membership SET role = $1 WHERE id = $2', [patch.role, id]);
      if (row.employee_id) {
        await db.query('UPDATE employee SET app_role = $1 WHERE id = $2',
          [patch.role, row.employee_id]);
      }
    }

    /*
     * The employment terms as they stand, before anything moves. Compared
     * against the terms afterwards to decide whether this edit is history —
     * a phone number is not, a department is.
     */
    const termsBefore = row.employee_id ? await termsOf(db, row.employee_id) : null;

    if (row.employee_id) {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (patch.name !== undefined) set('full_name', patch.name.trim());
      if (patch.email !== undefined) set('work_email', patch.email.trim());
      if (patch.phone !== undefined) set('phone', patch.phone);
      if (patch.designation !== undefined) set('designation', patch.designation);
      if (patch.managerId !== undefined) set('manager_id', patch.managerId);
      if (patch.empType !== undefined) set('employment_type', patch.empType);
      if (patch.joinedOn !== undefined) set('joined_on', patch.joinedOn);
      if (patch.dept !== undefined) {
        const { rows } = await db.query<{ id: string }>(
          'SELECT id FROM department WHERE code = $1', [patch.dept]);
        if (!rows[0]) throw new UserError('No such department', 'invalid');
        set('department_id', rows[0].id);
      }
      if (patch.site !== undefined) {
        const { rows } = await db.query<{ id: string }>(
          'SELECT id FROM site WHERE code = $1', [patch.site]);
        if (!rows[0]) throw new UserError('No such location', 'invalid');
        set('site_id', rows[0].id);
      }
      if (sets.length) {
        params.push(row.employee_id);
        await db.query(`UPDATE employee SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      }

      /*
       * The shift, through the roster screen's own writer.
       *
       * Not a `set('shift_id', …)` line above, because moving somebody onto
       * different hours is not the same kind of edit as correcting their phone
       * number. It has its own gate (`shifts write`, which `mayAdminister`
       * does not imply), its own refusal (nobody moves themselves), its own
       * rule about which profiles are assignable, and its own audit entry. All
       * four live in `assignShift`, and a second copy here would be a second
       * answer waiting to drift from the first.
       *
       * **Compared before it is called.** The drawer posts every field it
       * holds, so a caller who never touched the Shift select still sends one;
       * passing that through would refuse a manager editing their own report's
       * designation with "you cannot change your own shift" or "only a manager
       * or admin may change a shift" — a guard firing on a field nobody
       * touched. Same reasoning as the email audit below: resubmitting what is
       * already there is not a change.
       */
      if (typeof patch.shiftCode === 'string' && patch.shiftCode.trim()) {
        const wanted = patch.shiftCode.trim().toUpperCase();
        const { rows: cur } = await db.query<{ code: string | null }>(
          `SELECT sh.code FROM employee e
             LEFT JOIN shift sh ON sh.id = e.shift_id
            WHERE e.id = $1`, [row.employee_id]);
        if ((cur[0]?.code ?? null) !== wanted) {
          await assignShift(db, caller, row.employee_id, wanted);
        }
      }
    }

    /*
     * Employment history, if this edit actually changed the terms.
     *
     * In the same transaction as the change, so the two cannot disagree: a
     * promotion that reached the employee row and not the history would look
     * complete and be wrong. `reasonForChange` returns null for an edit that
     * touched only a name, an email or a phone number, and nothing is written.
     *
     * The audit row below is not a substitute. It records who used the
     * application; employment history records what somebody's job was.
     */
    if (row.employee_id && termsBefore) {
      const termsAfter = await termsOf(db, row.employee_id);
      const reason = termsAfter ? reasonForChange(termsBefore, termsAfter) : null;
      if (reason) {
        await recordEmployment(db, row.employee_id, reason, {
          recordedBy: caller.employeeId,
          note: Object.keys(patch).join(', '),
        });
      }
    }

    /*
     * A changed work email gets its own audit entry, carrying both addresses.
     *
     * `user.updated` records the field *names* that were touched, which for
     * every other field is enough to go and look. It is not enough for this
     * one, because the work email is where an invitation is sent: `inviteUser`
     * reads `work_email` inside its own transaction and posts it to Supabase's
     * invite endpoint, so changing the address and then resending an
     * invitation points a set-password link somewhere new. Both halves are
     * administrator-only now, and the question an auditor asks afterwards is
     * "from what, to what, by whom" — which `user.updated` could not answer
     * and this can.
     *
     * Written in the same transaction as the change, so a recorded change
     * always happened and a change is always recorded.
     */
    const emailBefore = (row.work_email ?? '').trim();
    const emailAfter = patch.email === undefined ? emailBefore : patch.email.trim();
    if (emailAfter.toLowerCase() !== emailBefore.toLowerCase()) {
      await audit(db, caller, 'user.email_changed', id,
        `${emailBefore || '(none)'} → ${emailAfter || '(none)'}`);
    }

    await audit(db, caller, 'user.updated', id, Object.keys(patch).join(', '));
    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
}

/*
 * Statuses only an administrator may set — and, once set, only an
 * administrator may lift. See the check inside setUserStatus.
 */
const ADMIN_ONLY = ['suspended', 'locked', 'deleted'];

export async function setUserStatus(
  caller: Caller,
  id: string,
  status: string,
  reason?: string,
): Promise<UserAccount> {
  mayAdminister(caller);
  const db_status = TO_DB[status];
  if (!db_status) throw new UserError('Not a status', 'invalid');
  /*
   * Suspension is a sanction, a lock answers a security event, and deletion is
   * final. All three are an administrator's, even on a manager's own line.
   */
  if (ADMIN_ONLY.includes(db_status) && !reaches(caller, 'users', 'write', 'all')) {
    throw new UserError(`Only an administrator can set an account to ${status}`, 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const row = await load(db, caller, id);
    /*
     * And out of one, too. A manager who could not suspend somebody must not
     * be able to lift the suspension an administrator applied — otherwise the
     * sanction lasts exactly as long as it takes the manager to notice it.
     * Same for a lock: the account was locked because something happened, and
     * the person who could not lock it cannot decide it is over.
     */
    if (ADMIN_ONLY.includes(row.status) && !reaches(caller, 'users', 'write', 'all')) {
      throw new UserError(
        `Only an administrator can change an account that is ${FROM_DB[row.status] ?? row.status}`,
        'forbidden');
    }
    if (row.employee_id === caller.employeeId && db_status !== 'active') {
      throw new UserError('You cannot deactivate your own account', 'forbidden');
    }
    /*
     * The last administrator cannot be taken out of service. Counted rather
     * than assumed, because the count is the whole safeguard.
     *
     * Both vocabularies, on both sides of the question. These are database
     * values, not Caller.role, so the normaliser in session.ts never sees
     * them: during expand the column holds either name, and asking for
     * 'admin' alone would have counted zero the moment step B ran - the
     * guard passing silently and the final administrator removable. Step C
     * narrows both to 'company_admin'.
     */
    if (ADMIN_ROLES.includes(row.role) && db_status !== 'active') {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tenant_membership
          WHERE role = ANY($2) AND status = 'active' AND id <> $1`,
        [id, ADMIN_ROLES]);
      if (Number(rows[0]?.n ?? 0) === 0) {
        throw new UserError('This is the last active administrator', 'forbidden');
      }
    }

    await db.query(
      `UPDATE tenant_membership
          SET status = $1,
              -- 0038 constrains locked_at to be set exactly while the status is
              -- locked, so both directions are written here rather than one.
              locked_at = CASE WHEN $1 = 'locked' THEN now() ELSE NULL END,
              lock_reason = CASE WHEN $1 = 'locked' THEN $3 ELSE NULL END,
              deactivated_at = CASE WHEN $1 IN ('inactive','suspended') THEN now() ELSE NULL END,
              deactivated_by = CASE WHEN $1 IN ('inactive','suspended') THEN $2::uuid ELSE NULL END,
              deactivation_reason = CASE WHEN $1 IN ('inactive','suspended') THEN $3 ELSE '' END,
              deleted_at = CASE WHEN $1 = 'deleted' THEN now() ELSE deleted_at END,
              deleted_by = CASE WHEN $1 = 'deleted' THEN $2::uuid ELSE deleted_by END
        WHERE id = $4`,
      [db_status, caller.employeeId, reason ?? '', id]);

    await audit(db, caller, 'user.status', id,
      `${FROM_DB[row.status] ?? row.status} → ${status}${reason ? ` · ${reason}` : ''}`);
    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
}

/**
 * Soft-delete, behind a typed confirmation.
 *
 * The row stays: see the note at the top. `typed` must match the person's
 * name, which is the difference between meaning it and misclicking.
 */
export async function removeUser(
  caller: Caller,
  id: string,
  typed: string,
): Promise<UserAccount> {
  if (!reaches(caller, 'users', 'write', 'all')) {
    throw new UserError('Only an administrator can delete an account', 'forbidden');
  }
  const account = await getUser(caller, id);
  if (!account) throw new UserError('No such account', 'not_found');
  if (typed?.trim() !== account.name) {
    throw new UserError(`Type ${account.name} to confirm`, 'invalid');
  }
  return setUserStatus(caller, id, 'Deleted');
}

export async function decideUser(
  caller: Caller,
  id: string,
  decision: 'Approved' | 'Rejected',
  note?: string,
): Promise<UserAccount> {
  /*
   * The approval is the administrator's, always. A manager approving the
   * account they raised is the same as a manager creating one.
   */
  if (!reaches(caller, 'users', 'write', 'all')) {
    throw new UserError('Only an administrator can decide an account request', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    const row = await load(db, caller, id);
    if (row.status !== 'pending_approval') {
      throw new UserError('That account is not waiting on a decision', 'invalid');
    }
    await db.query(
      `UPDATE tenant_membership
          SET status = $1, approved_by = $2, approved_at = now(),
              invite_sent_at = CASE WHEN $1 = 'invited' THEN now() ELSE NULL END,
              deactivation_reason = $3
        WHERE id = $4`,
      [decision === 'Approved' ? 'invited' : 'inactive', caller.employeeId, note ?? '', id]);
    await audit(db, caller, 'user.decided', id, `${decision}${note ? ` · ${note}` : ''}`);
    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
}

/**
 * Send somebody the invitation their membership has been waiting for.
 *
 * Creating a user and inviting them are separate acts, and this is the second.
 * `createUser` writes an employee and a membership marked `invited`; until this
 * runs, nobody has been told. Splitting them means an administrator can set
 * somebody up before they start and invite them on the day.
 *
 * **Only an open invitation may be sent.** The status must be exactly
 * `invited`, which is the same rule `auth_claim_membership` applies at the
 * other end (0049). A withdrawn membership is an administrator's decision that
 * somebody should not have access, and re-sending is not a way to overturn it:
 * even if a mail went out, the claim would refuse it. Refusing here as well
 * means the administrator finds out now rather than the invitee finding out
 * after following a link.
 *
 * **Sent is recorded only when it was sent.** `invite_sent_at` and
 * `invited_count` move after the provider confirms, never before. The previous
 * implementation incremented the counter and stamped the time without sending
 * anything at all, so every account looked invited and none had been.
 *
 * **The address is the employee's.** It is read from the employee record
 * inside the same transaction, never taken from the request, so an
 * administrator cannot direct somebody else's invitation to an address of
 * their choosing.
 *
 * **No role is assigned here.** The membership already carries the role the
 * administrator chose, and the claim keeps it. An invitation is a message.
 */
export async function inviteUser(caller: Caller, id: string): Promise<UserAccount> {
  /*
   * Admin only, and explicitly rather than through `mayAdminister`, which
   * admits a manager. Managing an account inside your own line is one thing;
   * sending an invitation creates a sign-in for the whole tenant and is
   * another. A manager raising a joiner still gets an account created — it
   * lands as pending_approval and an administrator decides.
   */
  if (!reaches(caller, 'users', 'write', 'all')) {
    throw new UserError('Only an administrator can send an invitation', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    /*
     * The row is locked for the length of the transaction, so two clicks — or
     * two administrators — serialise here. The second waits, re-reads, and
     * sees the count the first committed rather than racing it.
     */
    const row = await load(db, caller, id);
    await db.query('SELECT 1 FROM tenant_membership WHERE id = $1 FOR UPDATE', [id]);
    const fresh = await load(db, caller, id);

    if (fresh.status !== 'invited') {
      throw new UserError(
        fresh.status === 'deleted'
          ? 'That invitation was withdrawn. Create the account again to re-invite them.'
          : `That account is ${FROM_DB[fresh.status] ?? fresh.status}, not waiting on an invitation`,
        'invalid');
    }
    if (!fresh.work_email) {
      throw new UserError('That employee has no work email to invite', 'invalid');
    }

    /*
     * The provider is called inside the transaction on purpose. If it fails,
     * the throw rolls back the counter and the timestamp with it, so a refused
     * send cannot leave a record saying one happened.
     */
    const outcome = await authAdmin().inviteToSetPassword(fresh.work_email, inviteRedirect());

    /*
     * `must_change_password` goes true here as well as in `createUser`.
     *
     * This path invites a membership that already exists — a first invitation
     * for a joiner an administrator has just approved, or a re-invitation. In
     * either case the link that goes out can only mean "set your password", so
     * the flag has to be true whatever it was before. Setting it only at
     * creation would leave a re-invited person walking straight in, which is
     * the same defect in a different doorway.
     */
    await db.query(
      `UPDATE tenant_membership
          SET invited_count = invited_count + 1,
              invite_sent_at = now(),
              must_change_password = true
        WHERE id = $1`, [id]);

    /*
     * The address is not in the detail: it is already on the employee record
     * this row points at, and an audit log is read by more people than a user
     * record is. Nothing here is a token, a password or a key.
     */
    await audit(db, caller, row.invite_sent_at ? 'user.invite_resent' : 'user.invited', id,
      `${fresh.role} · attempt ${fresh.invited_count + 1} · `
      + (outcome.kind === 'invited' ? 'new sign-in created' : 'existing sign-in, reset sent'));

    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
}

/**
 * Send it again.
 *
 * The same path, because there is only one correct one. This used to increment
 * a counter and stamp a time while sending nothing, which is how every account
 * came to look invited without anybody having been told.
 */
export async function resendInvitation(caller: Caller, id: string): Promise<UserAccount> {
  return inviteUser(caller, id);
}


/**
 * Mark an account for a password change.
 *
 * This deliberately does not set a password. Issuing one would mean this
 * service knew a credential, and the whole point of delegating sign-in to the
 * identity provider is that it never does. The flag is what the next sign-in
 * reads.
 */
export async function resetPassword(
  caller: Caller,
  id: string,
  forceChange = true,
): Promise<UserAccount> {
  if (!reaches(caller, 'users', 'write', 'all')) {
    throw new UserError('Only an administrator can reset a password', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    await load(db, caller, id);
    await db.query('UPDATE tenant_membership SET must_change_password = $1 WHERE id = $2',
      [forceChange, id]);
    await audit(db, caller, 'user.password_reset', id, 'marked for change at next sign-in');
    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
}

export async function bulkUpdateUsers(
  caller: Caller,
  ids: string[],
  patch: UserPatch,
): Promise<UserAccount[]> {
  mayAdminister(caller);
  /*
   * One at a time, through the same path a single edit takes. A bulk UPDATE
   * would be one query and would skip every rule above — which is exactly how
   * a bulk action becomes the way round the rules.
   */
  const out: UserAccount[] = [];
  for (const id of ids) out.push(await updateUser(caller, id, patch));
  return out;
}

/**
 * Stamp the caller's own last sign-in.
 *
 * **Takes no id, deliberately.** The first version took one and updated that
 * row with no scope check, which let any signed-in person stamp anybody
 * else's account. Only a timestamp, so the damage was small — but an
 * unguarded write is an unguarded write, and "who last signed in" is a figure
 * an administrator uses to decide whether an account is dormant.
 *
 * Taking no id removes the hole rather than guarding it: there is no longer a
 * row to name but your own.
 *
 * It is also what a guard audit that greps for scope helpers will miss, which
 * is how this one survived. The fix for that is the shape, not a better grep.
 */
export async function lastLoginNow(caller: Caller): Promise<UserAccount | null> {
  if (!caller.employeeId) return null;
  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE tenant_membership SET last_login_at = now()
        WHERE employee_id = $1
       RETURNING id`,
      [caller.employeeId]);
    if (!rows[0]) return null;
    /*
     * Read back through `getUser`, which applies the scope — so this returns
     * the account only if the caller may see it, which for their own always
     * holds and for anything else cannot arise.
     */
    return getUser(caller, rows[0].id);
  });
}

async function audit(
  db: TenantClient,
  caller: Caller,
  action: string,
  subjectId: string,
  summary: string,
) {
  await db.query(
    `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                            subject_table, subject_id, detail)
     SELECT 'access', $1, 'notice', $2,
            COALESCE((SELECT full_name FROM employee WHERE id = $2), 'system'),
            'tenant_membership', $3, jsonb_build_object('summary', $4::text)`,
    [action, caller.employeeId, subjectId, summary]);
}

/**
 * Whether this caller has to set a new password before going any further.
 *
 * **Takes no id**, like `lastLoginNow` and for the same reason: there is no row
 * to ask about but your own, so there is nothing to guard. An endpoint that
 * told you whether *somebody else* had a pending password reset would be a way
 * to find the accounts worth attacking.
 *
 * This existed as a stored fact long before anything read it. `resetPassword`
 * has set `must_change_password` since 0030 and the user drawer has displayed
 * it — "Must change password: At next sign-in" — while the next sign-in did
 * nothing at all. A flag nothing enforces is worse than no flag: the screen
 * reports a control that is not there.
 */
export async function accountObligations(
  caller: Caller,
): Promise<{ mustChangePassword: boolean; mustEnrolMfa: boolean }> {
  if (!caller.employeeId) return { mustChangePassword: false, mustEnrolMfa: false };
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{
      must_change_password: boolean; mfa_required: boolean; has_factor: boolean;
    }>(
      `SELECT m.must_change_password, m.mfa_required,
              auth_has_verified_factor(m.user_id) AS has_factor
         FROM tenant_membership m
        WHERE m.employee_id = $1`,
      [caller.employeeId]);
    const r = rows[0];
    return {
      mustChangePassword: Boolean(r?.must_change_password),
      /*
       * Owed only while there is no factor. Asking somebody who has already
       * enrolled to enrol again is how a requirement turns into a loop nobody
       * can leave — and the answer comes from auth.mfa_factors rather than a
       * copy here, so it cannot go stale.
       */
      mustEnrolMfa: Boolean(r?.mfa_required) && !r?.has_factor,
    };
  });
}

/**
 * Clear the flag, once the password has actually been changed.
 *
 * Supabase owns the password, so this server cannot verify the change happened
 * — it is told. That is acceptable only because of what the lie would buy:
 * somebody could clear their own reminder and carry on with the password an
 * administrator wanted rotated. It does not grant access, reveal anything, or
 * touch another account. The alternative is a webhook from Supabase, which is
 * the right answer when there is somewhere to receive one.
 *
 * Recorded either way, so an administrator can see the reset was answered.
 */
export async function passwordChanged(caller: Caller): Promise<{ ok: true }> {
  /*
   * No employee record on the membership, so there is no row to clear.
   *
   * This used to `return { ok: true }`, which is the worst available answer:
   * the flag stays set, the caller is told the change was recorded, and the
   * next sign-in asks for a new password again — forever, with nothing
   * anywhere saying why. A person in that state cannot get past the screen by
   * trying harder, and nobody looking at the logs would see a failure.
   *
   * It should not be reachable: `callerFromToken` builds a Caller from a
   * membership, and a membership with no `employee_id` cannot sign in. That is
   * exactly why it must say so loudly rather than shrug — if it ever does
   * happen, the row is broken in a way that needs a person, and the cost of
   * guessing wrong is somebody locked out of the product with no diagnosis.
   */
  if (!caller.employeeId) {
    throw new UserError(
      'This account is not linked to an employee record, so the password '
      + 'change could not be recorded. Your new password was saved. Ask an '
      + 'administrator to check the account before signing in again.',
      'invalid');
  }

  /*
   * Captured before the closure, not read inside it.
   *
   * The guard above proves it is a string, but the narrowing does not survive
   * into the callback — `caller` is still `Caller`, so `caller.employeeId` is
   * `string | null` in there and `audit` wants a `string`. A local const keeps
   * the narrowing and needs no `?? ''`, which is what the guard was for.
   */
  const employeeId = caller.employeeId;

  return withTenant(caller, async (db) => {
    await db.query(
      'UPDATE tenant_membership SET must_change_password = false WHERE employee_id = $1',
      [employeeId]);
    await audit(db, caller, 'user.password_changed', employeeId,
      'set a new password at sign-in');
    return { ok: true } as const;
  });
}

/**
 * Require — or stop requiring — a second factor on one account.
 *
 * **Sets an obligation; never satisfies one.** There is no path here that
 * enrols a factor, because enrolling means handling the TOTP secret and the
 * only party who should ever hold it is the account's owner. An administrator
 * able to enrol on somebody's behalf could, for a moment, sign in as them.
 *
 * The same asymmetry means this cannot *clear* a factor either: removing one
 * is `supabase.auth.admin.mfa.deleteFactor`, which needs the service key this
 * codebase deliberately does not hold. Turning the requirement off stops the
 * account being blocked; it leaves any factor already enrolled in place, and
 * the person can remove that themselves from My Account.
 */
export async function setMfaRequired(
  caller: Caller,
  id: string,
  required: boolean,
): Promise<UserAccount> {
  if (!reaches(caller, 'users', 'write', 'all')) {
    throw new UserError('Only an administrator can require a second factor', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    await load(db, caller, id);
    await db.query('UPDATE tenant_membership SET mfa_required = $1 WHERE id = $2',
      [required, id]);
    await audit(db, caller, 'user.mfa_required', id,
      required
        ? 'must set up two-factor sign-in before next use'
        : 'no longer required to use two-factor sign-in');
    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
}

/**
 * Who the caller is, for the screen that is about to draw them.
 *
 * The frontend seeds its own identity — the name in the top bar, the employee
 * id behind "my leave" and "my timesheet" — from `ACCOUNTS()` in
 * `src/state/rbac.ts`, which is the demo dataset. That is right for the demo
 * build and wrong the moment a real session exists: it would show a colleague
 * from the sample data and ask for *their* leave.
 *
 * It was never a security hole, because the server ignores whatever caller a
 * request claims and rebuilds it from the token. But it is the difference
 * between an application and a screenshot, so identity has to come from here.
 *
 * Read from the membership and the employee, on the caller the token resolved
 * to. Nothing is taken from the request.
 */
export interface Identity {
  /** The membership, which is what an account *is* in this schema. */
  membershipId: string;
  /** The employee they act as. Null for a login with no payroll record. */
  empId: string | null;
  name: string;
  email: string;
  code: string;
  designation: string;
  dept: string;
  site: string;
  /** The company, as it should be shown. */
  tenantName: string;
  tenantSlug: string;
}

export async function whoAmI(caller: Caller): Promise<Identity | null> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT m.id AS membership_id, m.employee_id,
              COALESCE(e.full_name, '') AS full_name,
              COALESCE(e.work_email, '') AS work_email,
              COALESCE(e.code, '') AS code,
              COALESCE(e.designation, '') AS designation,
              COALESCE(d.code, '') AS dept_code,
              COALESCE(s.code, '') AS site_code,
              t.display_name AS tenant_name, t.slug AS tenant_slug
         FROM tenant_membership m
         JOIN tenant t ON t.id = m.tenant_id
         LEFT JOIN employee e ON e.id = m.employee_id
         LEFT JOIN department d ON d.id = e.department_id
         LEFT JOIN site s ON s.id = e.site_id
        WHERE m.employee_id IS NOT DISTINCT FROM $1
          AND m.tenant_id = current_tenant_id()
        LIMIT 1`,
      [caller.employeeId]);

    const r = rows[0];
    if (!r) return null;
    return {
      membershipId: r.membership_id as string,
      empId: (r.employee_id as string | null) ?? null,
      name: r.full_name as string,
      /*
       * The work email, not the address they signed in with. They can differ —
       * an account may be invited at one address and the employee record carry
       * another — and the one the company knows them by is the right one to
       * show beside their name.
       */
      email: r.work_email as string,
      code: r.code as string,
      designation: r.designation as string,
      dept: r.dept_code as string,
      site: r.site_code as string,
      tenantName: r.tenant_name as string,
      tenantSlug: String(r.tenant_slug),
    };
  });
}
