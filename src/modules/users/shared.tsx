/**
 * The pieces every user-administration screen draws the same way.
 *
 * `PermissionGuard` is the important one, and the important thing about it is
 * what it does *not* do: it hides a control, and hiding a control is not a
 * permission. Every act it wraps is refused again by the service, which is the
 * only place the refusal counts. This exists so people are not offered buttons
 * that answer "your role cannot do that" — a courtesy, not a boundary.
 */

import type { ReactNode } from 'react';
import { Badge } from '../../components/ui';
import { fmtDT } from '../../lib/dates';
import type { BadgeKind } from '../../components/ui';
import { ACTION_GATE, ROLE_LABEL, SCOPE } from '../../state/rbac';
import type { UserAction } from '../../state/rbac';
import { useApp } from '../../state/AppContext';
import type { AppRole } from '../../types/employee';
import type { UserStatus } from '../../services';

/* ---------------- permission ---------------- */

/**
 * Renders its children only when the signed-in role may perform `action`.
 *
 * `fallback` is for the rare case where the absence needs explaining rather
 * than simply not being there — a disabled control with a reason beats a
 * control that silently vanished when somebody is looking for it.
 */
export function PermissionGuard({
  action, children, fallback = null,
}: {
  action: UserAction;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const mayDo = useMay();
  return <>{mayDo(action) ? children : fallback}</>;
}

/**
 * The same question, for code rather than markup.
 *
 * Asks the server's grant — `app.scopeOf` reads the rules `/me/permissions`
 * returned, which already carry the manager layer and this tenant's
 * narrowing. It used to ask `may(app.role, …)`, a local copy of the policy
 * keyed on the role the client happened to hold, while every other gate on
 * these screens asked the server. `ACTION_GATE` carries the mapping and
 * `checks/user-action-gates.ts` proves it grants exactly what the local table
 * granted.
 *
 * In the demo build there is no server, and `scopeOf` falls back to the
 * generated policy mirror — the same source the table was written from.
 */
export function useMay(): (action: UserAction) => boolean {
  const app = useApp();
  return (action) => {
    const gate = ACTION_GATE[action];
    /* An act nobody has classified grants nothing, rather than everything. */
    if (!gate) return false;
    return app.scopeOf(gate.module, gate.verb) !== 'none';
  };
}

/* ---------------- status ---------------- */

/**
 * Green active, amber waiting, red held, grey retired.
 *
 * Deliberately four tones over seven statuses: a status set where every value
 * has its own colour stops being scannable, and the distinctions people act on
 * are "working", "waiting on somebody", "stopped" and "gone".
 */
const STATUS_TONE: Record<UserStatus, BadgeKind> = {
  Active: 'good',
  'Pending Approval': 'warn',
  'Invitation Pending': 'warn',
  Locked: 'crit',
  Suspended: 'crit',
  Inactive: 'mute',
  Deleted: 'mute',
};

export const UserStatusBadge = ({ s }: { s: UserStatus }) => (
  <Badge kind={STATUS_TONE[s]}>{s}</Badge>
);

/* ---------------- role ---------------- */

/*
 * What each role means, and what to call it.
 *
 * Both come from rbac.ts now. There were three copies of this mapping in the
 * tree and two of them still read 'admin' | 'manager' | 'employee', so the
 * label somebody saw depended on which screen they were on.
 */
export { ROLE_LABEL };

export const ROLE_BLURB = Object.fromEntries(
  (Object.keys(SCOPE) as AppRole[]).map((r) => [r, SCOPE[r].desc]),
) as Record<AppRole, string>;
const ROLE_TONE: Record<AppRole, BadgeKind> = {
  company_admin: 'info', hr_admin: 'info', finance_admin: 'info', employee: 'mute',
};

export const RoleBadge = ({ r }: { r: AppRole }) => (
  <Badge kind={ROLE_TONE[r]}>{ROLE_LABEL[r]}</Badge>
);

/* ---------------- time ---------------- */

/**
 * "18 Sep, 09:30" — an instant, where a date alone would not be enough.
 *
 * Now one line over `fmtDT`, which is the app's only date parser. This used to
 * split on 'T' and hand the remainder to `new Date`, which printed
 * "NaN Invalid Date" for every user whose stamp came from the real API — see
 * `parseInstant` for why the demo data hid it.
 *
 * The fallback is '—', not 'Never'. An absent stamp means nobody recorded a
 * sign-in, which is not the same as nobody signing in: VHM007 has sign-out
 * events and no stamp. `lastLoginLabel` is what decides when 'Never' is
 * actually earned.
 */
export const whenOf = (at: string | null, fallback = '—'): string => fmtDT(at, fallback);

/**
 * What the Last login column says, given the stamp and the evidence.
 *
 * Three answers, because there are three states and the old code collapsed two
 * of them. `signInEvents` is the count of rows in `login_history` for this
 * account, which is the record a sign-out is written to as well as a sign-in.
 *
 *   * a stamp            -> the instant
 *   * no stamp, no event -> 'Never', which is now a claim backed by evidence
 *   * no stamp, events   -> '—'. They have signed in; what we lack is when.
 *                           Saying 'Never' here is the bug this splits apart.
 */
export function lastLoginLabel(
  at: string | null,
  signInEvents?: number | null,
): { text: string; title?: string } {
  const shown = fmtDT(at, '');
  if (shown) return { text: shown };
  if (signInEvents === 0) return { text: 'Never', title: 'No sign-in has been recorded' };
  if (signInEvents && signInEvents > 0) {
    return {
      text: '—',
      title: `${signInEvents} sign-in event(s) on record, but no last-sign-in stamp`,
    };
  }
  return { text: '—', title: 'Not recorded' };
}
