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

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { employeeScope } from '../../tenancy/scope.ts';

export class UserError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

type Role = 'admin' | 'manager' | 'employee';

export interface UserAccount {
  id: string; empId: string | null; name: string; email: string; phone: string;
  code: string; dept: string; designation: string; site: string;
  managerId: string | null; empType: string; joinedOn: string;
  role: Role; status: string;
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
  site_code: string | null; manager_id: string | null;
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
function scopeFor(caller: Caller, params: unknown[]): string {
  if (caller.role === 'admin') return 'TRUE';
  if (caller.role !== 'manager' || !caller.employeeId) return 'FALSE';
  return employeeScope(caller, 'm.employee_id', params);
}

const mayAdminister = (caller: Caller) => {
  if (caller.role === 'employee') {
    throw new UserError('Your role cannot manage accounts', 'forbidden');
  }
};

/**
 * Load an account and prove this caller may act on it.
 *
 * Always through the scope predicate. Loading by id and checking afterwards is
 * the shape that leaks — one branch forgets, and a manager edits an
 * administrator.
 */
async function load(db: TenantClient, caller: Caller, id: string): Promise<Row> {
  const params: unknown[] = [id];
  const scope = scopeFor(caller, params);
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
  const where: string[] = [scopeFor(caller, params)];
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
    try { return toAccount(await load(db, caller, id)); }
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
  mayAdminister(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{ next: string }>(
      `SELECT COALESCE(max(NULLIF(regexp_replace(code, '\\D', '', 'g'), ''))::int, 0) + 1 AS next
         FROM employee`);
    return `E${String(rows[0]?.next ?? 1).padStart(3, '0')}`;
  });
}

/**
 * Whether this caller may grant that role.
 *
 * The rule that matters: only an administrator makes an administrator. A
 * manager who could would be one.
 */
function mayGrant(caller: Caller, role: Role) {
  if (role === 'admin' && caller.role !== 'admin') {
    throw new UserError('Only an administrator can grant the administrator role', 'forbidden');
  }
}

const validate = (d: Partial<UserDraft>) => {
  if (d.name !== undefined && !d.name.trim()) throw new UserError('Give the person a name', 'invalid');
  if (d.email !== undefined) {
    if (!d.email.trim()) throw new UserError('An account needs an email address', 'invalid');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) {
      throw new UserError('That is not an email address', 'invalid');
    }
  }
  if (d.role !== undefined && !['admin', 'manager', 'employee'].includes(d.role)) {
    throw new UserError('Not a role', 'invalid');
  }
};

export async function createUser(caller: Caller, d: UserDraft): Promise<UserAccount> {
  mayAdminister(caller);
  validate(d);
  mayGrant(caller, d.role);
  if (!d.dept) throw new UserError('Choose a department', 'invalid');
  if (!d.site) throw new UserError('Choose a location', 'invalid');

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
    const { rows: entity } = await db.query<{ id: string }>(
      'SELECT id FROM legal_entity ORDER BY is_default DESC, code LIMIT 1');
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

    const { rows: emp } = await db.query<{ id: string }>(
      `INSERT INTO employee
         (code, full_name, work_email, phone, department_id, site_id, designation,
          manager_id, employment_type, joined_on, status, app_role,
          legal_entity_id, shift_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::date, CURRENT_DATE),'active',$11,
               $12,$13)
       RETURNING id`,
      [code, d.name.trim(), d.email.trim(), d.phone ?? '', dept[0].id, site[0].id,
        d.designation, d.managerId ?? null, d.empType ?? 'permanent',
        d.joinedOn ?? null, d.role, entity[0].id, shift[0].id]);

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
    const status = caller.role === 'admin'
      ? 'invited'
      : 'pending_approval';

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tenant_membership
         (user_id, role, employee_id, status, invited_at, invite_sent_at,
          invited_count, must_change_password, requested_by,
          approved_by, approved_at)
       VALUES (NULL, $1, $2, $3, now(),
               CASE WHEN $3 = 'invited' THEN now() ELSE NULL END,
               1, $4, $5,
               CASE WHEN $3 <> 'pending_approval' THEN $6::uuid ELSE NULL END,
               CASE WHEN $3 <> 'pending_approval' THEN now() ELSE NULL END)
       RETURNING id`,
      [d.role, emp[0]!.id, status, d.sendInvitation === false, caller.employeeId,
        caller.employeeId]);

    await audit(db, caller, 'user.created', rows[0]!.id,
      `${d.name.trim()} · ${d.role} · ${FROM_DB[status]}`);
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
    if (patch.role && patch.role !== 'admin' && row.role === 'admin'
      && row.employee_id === caller.employeeId) {
      throw new UserError('You cannot remove your own administrator role', 'forbidden');
    }

    if (patch.role) {
      await db.query('UPDATE tenant_membership SET role = $1 WHERE id = $2', [patch.role, id]);
      if (row.employee_id) {
        await db.query('UPDATE employee SET app_role = $1 WHERE id = $2',
          [patch.role, row.employee_id]);
      }
    }

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
  if (ADMIN_ONLY.includes(db_status) && caller.role !== 'admin') {
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
    if (ADMIN_ONLY.includes(row.status) && caller.role !== 'admin') {
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
     */
    if (row.role === 'admin' && db_status !== 'active') {
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tenant_membership
          WHERE role = 'admin' AND status = 'active' AND id <> $1`, [id]);
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
  if (caller.role !== 'admin') {
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
  if (caller.role !== 'admin') {
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

export async function resendInvitation(caller: Caller, id: string): Promise<UserAccount> {
  mayAdminister(caller);
  return withTenant(caller, async (db) => {
    const row = await load(db, caller, id);
    if (row.status !== 'invited') {
      throw new UserError('That account is not waiting on an invitation', 'invalid');
    }
    await db.query(
      `UPDATE tenant_membership
          SET invited_count = invited_count + 1, invite_sent_at = now()
        WHERE id = $1`, [id]);
    await audit(db, caller, 'user.invite_resent', id, `attempt ${row.invited_count + 1}`);
    const after = await getUser(caller, id);
    if (!after) throw new UserError('No such account', 'not_found');
    return after;
  });
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
  if (caller.role !== 'admin') {
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
  if (!caller.employeeId) return { ok: true };
  return withTenant(caller, async (db) => {
    await db.query(
      'UPDATE tenant_membership SET must_change_password = false WHERE employee_id = $1',
      [caller.employeeId]);
    await audit(db, caller, 'user.password_changed', caller.employeeId ?? '',
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
  if (caller.role !== 'admin') {
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
