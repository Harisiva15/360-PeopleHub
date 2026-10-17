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
  'Pending Approval', 'Invitation Pending', 'Active', 'Inactive', 'Locked',
  'Suspended', 'Deleted',
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
  /** An administrator requires a second factor on this account. */
  mfaRequired: boolean;
  deactivatedAt: string | null;
  deactivatedById: string | null;
  deactivationReason: string;
  /** Set while Locked, and only then. Migration 0038 holds the pair together. */
  lockedAt: string | null;
  lockReason: string;
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
          : roll <= 97 ? 'Inactive'
            : roll <= 99 ? 'Locked'
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
      mfaRequired: ['HR', 'FIN', 'IT'].includes(e.dept),
      deactivatedAt: status === 'Inactive' || status === 'Suspended'
        ? ymd(addDays(TODAY, -ri(5, 120))) : null,
      deactivatedById: status === 'Inactive' || status === 'Suspended' ? actorId() : null,
      /* 0038 ties these two together: set while Locked, null otherwise. */
      lockedAt: status === 'Locked' ? ymd(addDays(TODAY, -ri(0, 9))) : null,
      lockReason: status === 'Locked'
        ? pick([
          'Repeated failed sign-ins',
          'Locked at the request of the security team',
          'Suspicious sign-in from an unrecognised address',
        ])
        : '',
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
   * Guarantee the scarce statuses, rather than hoping for them.
   *
   * The draw above gives Suspended a one-in-a-hundred chance and Inactive
   * three. Over a workforce this size that is *probably* at least one of each
   * — and "probably" is how the book came to be missing a Suspended account
   * the first time an unrelated file stopped calling chance() and shifted
   * every draw after it. checks/users.ts asserts the book contains the cases
   * the module exists to handle; a fixture that meets that assertion by luck
   * is not a fixture.
   *
   * So the scarce statuses are assigned outright, to the accounts at fixed
   * positions in the book. Deterministic, independent of the RNG stream, and
   * it cannot be emptied by a change somewhere else in the chain.
   */
  const PINNED: { at: number; status: UserStatus }[] = [
    { at: 3, status: 'Suspended' },
    { at: 7, status: 'Inactive' },
    { at: 11, status: 'Locked' },
    { at: 15, status: 'Pending Approval' },
    { at: 19, status: 'Invitation Pending' },
  ];
  PINNED.forEach(({ at, status }) => {
    const u = USERS[at];
    if (!u) return;
    u.status = status;
    /* Each status carries its own attached facts; 0038 constrains two of them. */
    u.lockedAt = status === 'Locked' ? ymd(addDays(TODAY, -ri(1, 9))) : null;
    u.lockReason = status === 'Locked' ? 'Repeated failed sign-ins' : '';
    const held = status === 'Inactive' || status === 'Suspended';
    u.deactivatedAt = held ? ymd(addDays(TODAY, -ri(5, 120))) : null;
    u.deactivatedById = held ? actorId() : null;
    u.deactivationReason = status === 'Suspended' ? 'Under investigation'
      : status === 'Inactive' ? 'Left the company' : '';
    /*
     * An account that has never been able to sign in has never signed in.
     * Pinning changed the status of accounts the draw had made Active, and
     * those carried a last-login stamp with them — which checks/users.ts
     * caught, correctly: an invitation that has not been accepted cannot have
     * a sign-in behind it.
     */
    if (status === 'Pending Approval' || status === 'Invitation Pending') {
      u.lastLoginAt = null;
      u.approvedById = null;
      u.approvedAt = null;
    }
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
      mfaRequired: false,
      lockedAt: null,
      lockReason: '',
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

/* ---------------------------------------------------------------------------
 * Sign-in history
 *
 * What this can honestly contain is decided by what the server can honestly
 * observe. Supabase Auth checks the password, so a wrong password never
 * reaches this application — recording one would mean trusting the login page
 * to report its own failures, and an unauthenticated endpoint that writes
 * rows against any address you can name is a way to lock other people out, not
 * a security feature. See `server/src/modules/users/loginHistory.ts`.
 *
 * So: sessions that started, sessions that ended, and tokens refused for the
 * state of the account behind them. The seeded book contains the same mix, at
 * the same proportions, so a screen built against it is not built against a
 * shape the real table will never produce.
 * ------------------------------------------------------------------------- */

export const LOGIN_METHODS = ['password', 'mfa', 'recovery_code', 'sso', 'magic_link'] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const LOGIN_OUTCOMES = ['success', 'failed', 'refused', 'locked_out', 'signed_out'] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];

export interface LoginEvent {
  id: string;
  employeeId: string | null;
  /** ISO, to the second. A sign-in at 09:02 and one at 09:47 are different. */
  at: string;
  outcome: LoginOutcome;
  method: LoginMethod;
  /** Null-equivalent on a success: there is nothing to explain. */
  reason: string;
  ip: string;
  userAgent: string;
}

export const LOGIN_HISTORY: LoginEvent[] = [];

const CLIENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/17.4',
  'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/124.0 Mobile Safari/537.36',
];

/*
 * Office addresses and a handful from elsewhere. A history where every row
 * carries the same address teaches nobody to notice the one that does not,
 * which is the entire use of the screen.
 */
const OFFICE_IPS = ['203.0.113.14', '203.0.113.15', '198.51.100.22'];
const AWAY_IPS = ['49.207.188.6', '106.51.72.140', '157.49.14.233'];

/**
 * Which accounts could have signed in at all.
 *
 * An invitation that has not been accepted has no sign-in behind it, and
 * neither has a request still waiting on an approval. Seeding history for
 * those produced 71 successful sign-ins against 18 accounts that had never
 * been able to sign in — a book that disagrees with itself teaches a screen
 * built against it to render a state the real table cannot produce.
 */
const COULD_SIGN_IN = (s: UserStatus) =>
  s !== 'Deleted' && s !== 'Pending Approval' && s !== 'Invitation Pending';

(() => {
  USERS.filter((u) => COULD_SIGN_IN(u.status)).forEach((u) => {
    /*
     * Whether this person uses a second factor is a property of the person,
     * not of each sign-in — nobody uses an authenticator on a random 30% of
     * their logins. Drawing it per session, which is how this was first
     * written, meant that over eight to twenty-six sessions essentially
     * everybody hit 'mfa' at least once, and the security screen's
     * "signed in with a second factor" read 100%. A figure that is always
     * 100% is as uninformative as the invented one it replaced.
     */
    const usesSecondFactor = chance(0.46);
    // A person signs in most working days. Enough rows to page, not so many
    // that the book takes a second to build.
    const sessions = u.status === 'Active' ? ri(8, 26) : ri(1, 6);
    for (let i = 0; i < sessions; i += 1) {
      const day = addDays(TODAY, -ri(0, 60));
      const at = `${ymd(day)}T${String(ri(7, 19)).padStart(2, '0')}:`
        + `${String(ri(0, 59)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}`;
      const away = chance(0.12);
      LOGIN_HISTORY.push({
        id: uid('LGN'),
        employeeId: u.empId,
        at,
        outcome: 'success',
        // Recovery codes stay rare even for people who use a second factor:
        // a book where they are common makes an alarming figure look ordinary.
        method: usesSecondFactor
          ? (chance(0.04) ? 'recovery_code' : 'mfa')
          : 'password',
        reason: '',
        ip: away ? pick(AWAY_IPS) : pick(OFFICE_IPS),
        userAgent: away ? pick(CLIENTS.slice(3)) : pick(CLIENTS.slice(0, 3)),
      });
      // Most sessions end by the token expiring rather than by anybody
      // pressing anything, so only some have a matching end.
      if (chance(0.55)) {
        const idle = chance(0.35);
        LOGIN_HISTORY.push({
          id: uid('LGN'),
          employeeId: u.empId,
          at: `${at.slice(0, 11)}${String(Math.min(23, Number(at.slice(11, 13)) + ri(1, 5)))
            .padStart(2, '0')}${at.slice(13)}`,
          outcome: 'signed_out',
          method: 'password',
          reason: idle ? 'signed out after a period of inactivity' : 'signed out',
          ip: away ? pick(AWAY_IPS) : pick(OFFICE_IPS),
          userAgent: away ? pick(CLIENTS.slice(3)) : pick(CLIENTS.slice(0, 3)),
        });
      }
    }

    /*
     * An account that is not active still holds a token until it expires, and
     * every request it makes in the meantime is refused. That refusal is the
     * evidence the deactivation took effect, so the book contains it.
     */
    if (u.status === 'Locked' || u.status === 'Suspended' || u.status === 'Inactive') {
      for (let i = 0; i < ri(1, 4); i += 1) {
        const day = addDays(TODAY, -ri(0, 8));
        LOGIN_HISTORY.push({
          id: uid('LGN'),
          employeeId: u.empId,
          at: `${ymd(day)}T${String(ri(8, 18)).padStart(2, '0')}:`
            + `${String(ri(0, 59)).padStart(2, '0')}:00`,
          outcome: u.status === 'Locked' ? 'locked_out' : 'refused',
          method: 'password',
          reason: u.status === 'Locked'
            ? 'this account is locked after too many failed sign-in attempts'
            : u.status === 'Suspended'
              ? 'this account is suspended'
              : 'this account has been deactivated',
          ip: pick([...OFFICE_IPS, ...AWAY_IPS]),
          userAgent: pick(CLIENTS),
        });
      }
    }
  });

  // Newest first is how every reader wants it, and sorting once here beats
  // sorting in each of the three screens that show it.
  LOGIN_HISTORY.sort((a, b) => b.at.localeCompare(a.at));
})();

/** One person's history, newest first. */
export const loginHistoryFor = (empId: string | null): LoginEvent[] =>
  (empId ? LOGIN_HISTORY.filter((e) => e.employeeId === empId) : []);
