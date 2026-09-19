/*
 * Last in the RNG chain, after security.
 *
 * Importing the current tail rather than any earlier link is what matters:
 * two files importing the same predecessor leaves their own order undefined,
 * and the whole dataset is drawn from one seeded stream. `assetWorkflow`
 * looked like the tail from the imports alone — `security` already claims it.
 */
import './security';

import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP, EMP } from './employees';
import type { AppRole } from '../types/employee';

/**
 * A user account.
 *
 * Distinct from an employee, and the distinction is the whole module. An
 * employee is a person the company employs; an account is a way to sign in as
 * them. Most people have both, some have one — a contractor with a login and
 * no payroll record, a leaver whose employment history is retained long after
 * their account is gone — and conflating them is how an offboarding either
 * deletes somebody's payslips or leaves their login working.
 *
 * Mirrors `tenant_membership` as migration 0030 leaves it.
 */
export const USER_STATUSES = [
  'Pending Approval', 'Invitation Pending', 'Active', 'Inactive', 'Suspended', 'Deleted',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Statuses that can sign in. Everything else cannot, for its own reason. */
export const CAN_SIGN_IN: UserStatus[] = ['Active'];

/** Soft-deleted accounts are hidden everywhere except an explicit audit. */
export const IS_GONE: UserStatus[] = ['Deleted'];

export interface UserAccount {
  id: string;
  /** The employee this login acts as. Null for a login with no payroll record. */
  empId: string | null;
  /** Kept on the account: an account outlives the employee row it points at. */
  name: string;
  email: string;
  phone: string;
  code: string;
  dept: string;
  designation: string;
  site: string;
  managerId: string | null;
  empType: string;
  joinedOn: string;
  role: AppRole;
  status: UserStatus;

  /* ---- the account's own history ---- */
  createdOn: string;
  createdById: string | null;
  modifiedOn: string | null;
  modifiedById: string | null;
  lastLoginAt: string | null;
  /** How many times the invitation has gone out. One on creation. */
  invitedCount: number;
  inviteSentAt: string | null;
  mustChangePassword: boolean;
  deactivatedAt: string | null;
  deactivatedById: string | null;
  deactivationReason: string;
  /** Who raised it, when a manager asked rather than an administrator acted. */
  requestedById: string | null;
  approvedById: string | null;
  approvedAt: string | null;
}

export const USERS: UserAccount[] = [];

/*
 * One account per employee, plus a few that only an administrator would ever
 * see: requests waiting on approval, invitations nobody has accepted, accounts
 * held or retired. A book where every row is Active proves nothing about the
 * screens that are supposed to handle the others.
 */
(function genUsers() {
  const admins = ACTIVE().filter((e) => e.role === 'admin');
  const actorId = () => (admins.length ? pick(admins).id : null);

  ACTIVE().forEach((e) => {
    /* Most people are signed in and working. */
    const roll = ri(1, 100);
    const status: UserStatus = roll <= 82 ? 'Active'
      : roll <= 89 ? 'Invitation Pending'
        : roll <= 94 ? 'Pending Approval'
          : roll <= 98 ? 'Inactive'
            : 'Suspended';

    const created = addDays(TODAY, -ri(1, 900));
    const pending = status === 'Pending Approval';
    const invited = status === 'Invitation Pending';

    USERS.push({
      id: uid('USR'),
      empId: e.id,
      name: e.name,
      email: e.email,
      phone: e.phone,
      code: e.code,
      dept: e.dept,
      designation: e.designation,
      site: e.site,
      managerId: e.managerId,
      empType: e.empType,
      joinedOn: e.doj,
      role: e.role,
      status,
      createdOn: ymd(created),
      createdById: actorId(),
      modifiedOn: chance(0.4) ? ymd(addDays(created, ri(1, 200))) : null,
      modifiedById: chance(0.4) ? actorId() : null,
      /* Only an account that can sign in has ever signed in. */
      lastLoginAt: status === 'Active'
        ? `${ymd(addDays(TODAY, -ri(0, 21)))}T${String(ri(7, 20)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}:00`
        : status === 'Inactive' || status === 'Suspended'
          ? `${ymd(addDays(TODAY, -ri(30, 300)))}T09:${String(ri(0, 59)).padStart(2, '0')}:00`
          : null,
      invitedCount: invited ? ri(1, 3) : 1,
      inviteSentAt: invited || status === 'Active' ? ymd(created) : null,
      mustChangePassword: invited && chance(0.3),
      deactivatedAt: status === 'Inactive' || status === 'Suspended'
        ? ymd(addDays(TODAY, -ri(5, 120))) : null,
      deactivatedById: status === 'Inactive' || status === 'Suspended' ? actorId() : null,
      deactivationReason: status === 'Suspended'
        ? pick(['Under investigation', 'Security review', 'Pending disciplinary outcome'])
        : status === 'Inactive'
          ? pick(['Left the company', 'Long leave', 'Contract ended', 'Transferred out'])
          : '',
      /* A pending account was raised by somebody's manager. */
      requestedById: pending ? e.managerId : null,
      approvedById: pending ? null : actorId(),
      approvedAt: pending ? null : ymd(addDays(created, ri(0, 2))),
    });
  });

  /*
   * Leavers keep their employment record and lose their account. This is the
   * case the module exists to get right, so the book has to contain it.
   */
  EMP.filter((e) => e.status === 'Exited').slice(0, 6).forEach((e) => {
    const created = addDays(TODAY, -ri(400, 1200));
    USERS.push({
      id: uid('USR'),
      empId: e.id,
      name: e.name,
      email: e.email,
      phone: e.phone,
      code: e.code,
      dept: e.dept,
      designation: e.designation,
      site: e.site,
      managerId: e.managerId,
      empType: e.empType,
      joinedOn: e.doj,
      role: e.role,
      status: 'Deleted',
      createdOn: ymd(created),
      createdById: actorId(),
      modifiedOn: e.dol,
      modifiedById: actorId(),
      lastLoginAt: e.dol ? `${e.dol}T17:${String(ri(0, 59)).padStart(2, '0')}:00` : null,
      invitedCount: 1,
      inviteSentAt: ymd(created),
      mustChangePassword: false,
      deactivatedAt: e.dol,
      deactivatedById: actorId(),
      deactivationReason: 'Left the company',
      requestedById: null,
      approvedById: actorId(),
      approvedAt: ymd(addDays(created, 1)),
    });
  });
})();

export const userOf = (id: string): UserAccount | undefined => USERS.find((u) => u.id === id);
export const userForEmployee = (empId: string): UserAccount | undefined =>
  USERS.find((u) => u.empId === empId && u.status !== 'Deleted');

/** The employee an account acts as, when there still is one. */
export const employeeOf = (u: UserAccount) => (u.empId ? EMAP[u.empId] : undefined);
