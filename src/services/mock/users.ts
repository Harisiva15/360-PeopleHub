/**
 * User administration, in memory.
 *
 * **Every method takes the caller and checks it.** Not because the mock is a
 * security boundary — it runs in the browser and anybody can edit it — but
 * because the screens are written against it. A refusal the server makes and
 * the mock does not is a bug that first appears in production, on the one
 * module where the failure mode is somebody deleting an account they should
 * not have been able to see.
 *
 * The rules are `ACTION_SCOPE` in `src/state/rbac.ts`, which is the mirror of
 * the server's policy that `checks/roles.ts` holds to it cell by cell.
 */

import { sortBy } from '../../lib/collections';
import { TODAY, ymd } from '../../lib/dates';
import { EMAP } from '../../data/employees';
import { USERS, userOf } from '../../data/users';
import type { UserAccount, UserStatus } from '../../data/users';
import { actionScope, may, mayAssignRole } from '../../state/rbac';
import type { UserAction } from '../../state/rbac';
import { visibleIds } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import type {
  Caller, UserDraft, UserFilter, UserService, UserStats,
} from '../contracts';
import { ok } from './util';

let seq = 5000;
const nextId = () => `USR-${seq += 1}`;

const now = () => `${ymd(TODAY)}T${new Date().toTimeString().slice(0, 8)}`;

/* ---------------- refusals ---------------- */

class Refused extends Error {}

const refuse = (why: string) => Promise.reject(new Refused(why));

/** The accounts this caller may see at all. */
function inScope(c: Caller): UserAccount[] {
  const scope = actionScope(c.role, 'user.view');
  if (scope === 'none') return [];
  if (scope === 'all') return USERS.slice();
  /*
   * A manager sees their reporting line. `visibleIds` is the same function the
   * employee service scopes by, so the two cannot drift into disagreeing about
   * who is on somebody's team.
   */
  const mine = new Set(visibleIds(c.role, c.meId));
  return USERS.filter((u) => u.empId && mine.has(u.empId));
}

/**
 * Whether the caller may perform `action` on `target`.
 *
 * Two questions, and both have to pass: may they do this at all, and does
 * their reach cover this particular account. Checking only the first is the
 * classic hole — a manager who may deactivate, deactivating the CEO.
 */
function guard(c: Caller, action: UserAction, target?: UserAccount): string | null {
  const scope = actionScope(c.role, action);
  if (scope === 'none') return `Your role cannot ${action.replace(/^\w+\./, '').replace(/_/g, ' ')}`;
  if (!target || scope === 'all') return null;

  const reachable = inScope(c).some((u) => u.id === target.id);
  if (!reachable) return 'That account is outside the people you manage';
  return null;
}

/** An account a soft delete has retired is gone to everything but an audit. */
const live = (u: UserAccount) => u.status !== 'Deleted';

/* ---------------- reading ---------------- */

function matches(u: UserAccount, f: UserFilter): boolean {
  if (f.status && u.status !== f.status) return false;
  if (f.role && u.role !== f.role) return false;
  if (f.dept && u.dept !== f.dept) return false;
  if (f.site && u.site !== f.site) return false;
  if (f.managerId && u.managerId !== f.managerId) return false;
  if (f.empType && u.empType !== f.empType) return false;
  if (f.joinedFrom && u.joinedOn < f.joinedFrom) return false;
  if (f.joinedTo && u.joinedOn > f.joinedTo) return false;
  if (f.q?.trim()) {
    /* Name, email, employee id, department, designation — §31. */
    const hay = `${u.name} ${u.email} ${u.code} ${u.dept} ${u.designation}`.toLowerCase();
    if (!hay.includes(f.q.trim().toLowerCase())) return false;
  }
  return true;
}

/* ---------------- writing ---------------- */

const stamp = (u: UserAccount, c: Caller) => {
  u.modifiedOn = ymd(TODAY);
  u.modifiedById = c.meId;
};

/** Everything the database refuses, refused the same way and in the same order. */
function validate(d: Partial<UserDraft>, c: Caller, existing?: UserAccount): string | null {
  const name = d.name ?? existing?.name;
  if (!name?.trim()) return 'Give the user a name';

  const email = (d.email ?? existing?.email ?? '').trim().toLowerCase();
  if (!email) return 'An email address is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That is not an email address';

  const clash = USERS.find((u) => u.email.toLowerCase() === email && u.id !== existing?.id && live(u));
  if (clash) return `${email} already has an account`;

  const code = (d.code ?? existing?.code ?? '').trim();
  if (code) {
    const dup = USERS.find((u) => u.code === code && u.id !== existing?.id && live(u));
    if (dup) return `Employee ID ${code} is already in use`;
  }

  if (!(d.dept ?? existing?.dept)) return 'Choose a department';
  if (!(d.designation ?? existing?.designation)) return 'Enter a designation';
  if (!(d.site ?? existing?.site)) return 'Choose a location';

  const role = d.role ?? existing?.role;
  if (!role) return 'Choose a role';
  /*
   * The rule the whole module rests on: only an administrator makes another
   * administrator. Checked on the value, not the act — a manager assigns roles
   * every time they raise a joiner, and this is the one they may not assign.
   */
  if (role !== existing?.role && !mayAssignRole(c.role, role)) {
    return role === 'admin'
      ? 'Only an administrator can create or assign the Administrator role'
      : 'Your role cannot assign that role';
  }

  if (d.managerId && !EMAP[d.managerId]) return 'No such manager';
  return null;
}

/** The next free employee code, for the auto-generate option in §5. */
function nextCode(): string {
  const nums = USERS.map((u) => Number(u.code.replace(/\D/g, ''))).filter(Number.isFinite);
  return `VHM${String(Math.max(1000, ...nums) + 1).padStart(4, '0')}`;
}

export const userService: UserService = {
  nextEmployeeCode(c) {
    if (!may(c.role, 'user.create')) return refuse('Your role cannot create users');
    return ok(nextCode());
  },

  list(c, f = {}) {
    const stop = guard(c, 'user.view');
    if (stop) return refuse(stop);
    /*
     * Deleted accounts are excluded unless asked for by name. A soft delete
     * that still shows up in the default list is not a delete.
     */
    const rows = inScope(c)
      .filter((u) => (f.status === 'Deleted' ? true : live(u)))
      .filter((u) => matches(u, f));
    return ok(sortBy(rows, (u) => u.name));
  },

  get(c, id) {
    const stop = guard(c, 'user.view');
    if (stop) return refuse(stop);
    const u = inScope(c).find((x) => x.id === id);
    return ok(u ?? null);
  },

  stats(c) {
    const stop = guard(c, 'user.view');
    if (stop) return refuse(stop);
    const rows = inScope(c).filter(live);
    const count = (s: UserStatus) => rows.filter((u) => u.status === s).length;
    const out: UserStats = {
      total: rows.length,
      active: count('Active'),
      pendingApproval: count('Pending Approval'),
      inactive: count('Inactive') + count('Suspended'),
      invitationPending: count('Invitation Pending'),
    };
    return ok(out);
  },

  create(c, draft) {
    const stop = guard(c, 'user.create');
    if (stop) return refuse(stop);
    const bad = validate(draft, c);
    if (bad) return refuse(bad);

    /*
     * A manager raises a request; an administrator creates an account. Decided
     * here rather than passed in — a client that chooses its own status is a
     * client that can skip the approval it was supposed to wait for.
     */
    const byManager = c.role === 'manager';
    const status: UserStatus = byManager
      ? 'Pending Approval'
      : draft.sendInvitation === false ? 'Active' : 'Invitation Pending';

    const u: UserAccount = {
      id: nextId(),
      empId: draft.empId ?? null,
      name: draft.name.trim(),
      email: draft.email.trim().toLowerCase(),
      phone: draft.phone ?? '',
      code: (draft.code ?? '').trim() || nextCode(),
      dept: draft.dept,
      designation: draft.designation,
      site: draft.site,
      managerId: draft.managerId ?? null,
      empType: draft.empType ?? 'Full-time',
      joinedOn: draft.joinedOn ?? ymd(TODAY),
      role: draft.role,
      status,
      createdOn: ymd(TODAY),
      createdById: c.meId,
      modifiedOn: null,
      modifiedById: null,
      lastLoginAt: null,
      invitedCount: status === 'Invitation Pending' ? 1 : 0,
      inviteSentAt: status === 'Invitation Pending' ? ymd(TODAY) : null,
      mustChangePassword: draft.sendInvitation === false,
      deactivatedAt: null,
      deactivatedById: null,
      deactivationReason: '',
      requestedById: byManager ? c.meId : null,
      approvedById: byManager ? null : c.meId,
      approvedAt: byManager ? null : ymd(TODAY),
    };
    USERS.unshift(u);
    return ok(u);
  },

  update(c, id, patch) {
    const u = userOf(id);
    if (!u) return refuse('No such user');
    const stop = guard(c, 'user.edit', u);
    if (stop) return refuse(stop);

    /* A role change is its own act, gated separately from editing a name. */
    if (patch.role && patch.role !== u.role) {
      const roleStop = guard(c, 'role.assign', u);
      if (roleStop) return refuse(roleStop);
    }

    const bad = validate(patch as Partial<UserDraft>, c, u);
    if (bad) return refuse(bad);

    Object.assign(u, patch);
    stamp(u, c);
    return ok(u);
  },

  setStatus(c, id, status, reason) {
    const u = userOf(id);
    if (!u) return refuse('No such user');

    /*
     * Which act this is depends on where it is going, and they are not equally
     * permitted: a manager may retire somebody in their line but may neither
     * bring an account back nor hold one as a sanction.
     */
    const action: UserAction = status === 'Active' ? 'user.activate'
      : status === 'Suspended' ? 'user.suspend'
        : 'user.deactivate';
    const stop = guard(c, action, u);
    if (stop) return refuse(stop);

    if (u.status === 'Deleted') return refuse('That account has been deleted');
    if (u.status === status) return ok(u);
    if (status === 'Deleted') return refuse('Use delete, which asks for confirmation');

    if (status !== 'Active' && !reason?.trim()) {
      return refuse('Say why — the account holder and the audit both need it');
    }

    u.status = status;
    if (status === 'Active') {
      u.deactivatedAt = null;
      u.deactivatedById = null;
      u.deactivationReason = '';
      if (!u.approvedAt) { u.approvedAt = ymd(TODAY); u.approvedById = c.meId; }
    } else {
      u.deactivatedAt = ymd(TODAY);
      u.deactivatedById = c.meId;
      u.deactivationReason = reason!.trim();
    }
    stamp(u, c);
    return ok(u);
  },

  remove(c, id, typed) {
    const u = userOf(id);
    if (!u) return refuse('No such user');
    const stop = guard(c, 'user.delete', u);
    if (stop) return refuse(stop);
    /*
     * The typed confirmation is checked here and not only in the dialog. A
     * confirmation the client can skip is a confirmation that protects nobody.
     */
    if (typed !== 'DELETE') return refuse('Type DELETE to confirm');
    if (u.id === USERS.find((x) => x.empId === c.meId)?.id) {
      return refuse('You cannot delete your own account');
    }
    if (u.status === 'Deleted') return refuse('That account is already deleted');

    /* Soft. The employment record outlives the login — see 0030. */
    u.status = 'Deleted';
    u.deactivatedAt = ymd(TODAY);
    u.deactivatedById = c.meId;
    u.deactivationReason = u.deactivationReason || 'Account deleted';
    stamp(u, c);
    return ok(u);
  },

  decide(c, id, decision, note) {
    const u = userOf(id);
    if (!u) return refuse('No such user');
    const stop = guard(c, 'user.approve', u);
    if (stop) return refuse(stop);
    if (u.status !== 'Pending Approval') return refuse('That account is not awaiting approval');
    if (u.requestedById === c.meId) return refuse('You cannot approve your own request');
    if (decision !== 'Approved' && !note?.trim()) return refuse('Say what is wrong with it');

    if (decision === 'Approved') {
      u.status = 'Invitation Pending';
      u.approvedById = c.meId;
      u.approvedAt = ymd(TODAY);
      u.invitedCount = 1;
      u.inviteSentAt = ymd(TODAY);
    } else {
      u.status = 'Inactive';
      u.deactivatedAt = ymd(TODAY);
      u.deactivatedById = c.meId;
      u.deactivationReason = note!.trim();
    }
    stamp(u, c);
    return ok(u);
  },

  resendInvitation(c, id) {
    const u = userOf(id);
    if (!u) return refuse('No such user');
    const stop = guard(c, 'user.resend_invite', u);
    if (stop) return refuse(stop);
    if (u.status !== 'Invitation Pending') {
      return refuse('That account has no invitation outstanding');
    }
    u.invitedCount += 1;
    u.inviteSentAt = ymd(TODAY);
    stamp(u, c);
    return ok(u);
  },

  resetPassword(c, id, forceChange) {
    const u = userOf(id);
    if (!u) return refuse('No such user');
    const stop = guard(c, 'user.reset_password', u);
    if (stop) return refuse(stop);
    if (u.status === 'Deleted') return refuse('That account has been deleted');
    u.mustChangePassword = forceChange !== false;
    stamp(u, c);
    return ok(u);
  },

  bulkUpdate(c, ids, patch) {
    const stop = guard(c, 'user.bulk_update');
    if (stop) return refuse(stop);
    if (patch.role && !mayAssignRole(c.role, patch.role as AppRole)) {
      return refuse('Only an administrator can assign the Administrator role');
    }

    const reachable = new Set(inScope(c).map((u) => u.id));
    const outside = ids.filter((id) => !reachable.has(id));
    if (outside.length) {
      return refuse(`${outside.length} of those accounts are outside the people you manage`);
    }

    const touched: UserAccount[] = [];
    for (const id of ids) {
      const u = userOf(id);
      if (!u || !live(u)) continue;
      Object.assign(u, patch);
      stamp(u, c);
      touched.push(u);
    }
    return ok(touched);
  },

  /**
   * Stamp the caller's own last sign-in.
   *
   * It took an id once, and updated that row without checking whose it was —
   * so anybody signed in could stamp anybody else's account. Only a timestamp,
   * but "who last signed in" is what an administrator uses to decide an
   * account is dormant, and an unguarded write is an unguarded write.
   *
   * Taking no id removes the hole rather than guarding it.
   */
  lastLoginNow(c) {
    const u = USERS.find((x) => x.empId === c.meId);
    if (!u) return ok(null);
    u.lastLoginAt = now();
    return ok(u);
  },
};
