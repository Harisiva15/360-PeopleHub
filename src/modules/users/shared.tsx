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
import type { BadgeKind } from '../../components/ui';
import { may } from '../../state/rbac';
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
  const app = useApp();
  return <>{may(app.role, action) ? children : fallback}</>;
}

/** The same question, for code rather than markup. */
export function useMay(): (action: UserAction) => boolean {
  const app = useApp();
  return (action) => may(app.role, action);
}

/* ---------------- status ---------------- */

/**
 * Green active, amber waiting, red held, grey retired.
 *
 * Deliberately four tones over six statuses: a status set where every value
 * has its own colour stops being scannable, and the distinctions people act on
 * are "working", "waiting on somebody", "stopped" and "gone".
 */
const STATUS_TONE: Record<UserStatus, BadgeKind> = {
  Active: 'good',
  'Pending Approval': 'warn',
  'Invitation Pending': 'warn',
  Suspended: 'crit',
  Inactive: 'mute',
  Deleted: 'mute',
};

export const UserStatusBadge = ({ s }: { s: UserStatus }) => (
  <Badge kind={STATUS_TONE[s]}>{s}</Badge>
);

/* ---------------- role ---------------- */

/** What each role means, shown when one is chosen — §6. */
export const ROLE_BLURB: Record<AppRole, string> = {
  admin: 'Full end-to-end access: every employee, payroll, configuration and the audit trail.',
  manager: 'Their reporting line — approvals, team records, and limited user administration.',
  employee: 'Self-service only: their own record, their own requests, and what the company shares.',
};

export const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  employee: 'Employee',
};

const ROLE_TONE: Record<AppRole, BadgeKind> = {
  admin: 'info', manager: 'info', employee: 'mute',
};

export const RoleBadge = ({ r }: { r: AppRole }) => (
  <Badge kind={ROLE_TONE[r]}>{ROLE_LABEL[r]}</Badge>
);

/* ---------------- time ---------------- */

/** "18 Sep, 09:30" — an instant, where a date alone would not be enough. */
export function whenOf(at: string | null): string {
  if (!at) return 'Never';
  const [d, t] = at.split('T');
  const day = new Date(`${d}T00:00:00`);
  const label = `${day.getDate()} ${day.toLocaleString('en-GB', { month: 'short' })}`;
  return t ? `${label}, ${t.slice(0, 5)}` : label;
}
