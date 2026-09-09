/**
 * Database rows → the leave shapes the screens render.
 *
 * The same three mismatches as employees: codes rather than uuids, display
 * enums rather than storage enums, and `numeric` arriving as a string because
 * the driver is configured not to lose precision on money and day counts.
 */

/** Mirrors the contract's LeaveRequest. */
export interface LeaveRequest {
  id: string;
  empId: string;
  type: string;
  from: string;
  to: string;
  days: number;
  half: string | null;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected' | 'Cancelled';
  approverId: string | null;
  appliedOn: string;
  actedOn: string | null;
  note: string;
}

/** Mirrors the contract's LeaveBalanceRow. */
export interface LeaveBalanceRow {
  type: string;
  quota: number;
  carry: number;
  used: number;
  avail: number;
}

const STATUS: Record<string, LeaveRequest['status']> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** 'first_half' in the column, 'First Half' on the screen. */
const HALF: Record<string, string> = {
  first_half: 'First Half',
  second_half: 'Second Half',
};

export const toHalfDayColumn = (v: string | null): string | null => {
  if (!v) return null;
  const found = Object.entries(HALF).find(([, label]) => label === v);
  return found ? found[0] : null;
};

export function toLeaveRequest(r: Record<string, unknown>): LeaveRequest {
  return {
    id: r.id as string,
    empId: r.employee_id as string,
    type: (r.type_code as string) ?? '',
    from: r.starts_on as string,
    to: r.ends_on as string,
    days: Number(r.days),
    half: r.half_day ? (HALF[r.half_day as string] ?? null) : null,
    reason: (r.reason as string) ?? '',
    status: STATUS[r.status as string] ?? 'Pending',
    approverId: (r.approver_id as string | null) ?? null,
    appliedOn: r.applied_on as string,
    actedOn: (r.acted_on as string | null) ?? null,
    note: (r.approver_note as string) ?? '',
  };
}

export function toBalanceRow(r: Record<string, unknown>): LeaveBalanceRow {
  const quota = Number(r.quota);
  const carry = Number(r.carried_over);
  const used = Number(r.used);
  return {
    type: r.type_code as string,
    quota,
    carry,
    used,
    // Computed here rather than stored, so it can never disagree with its parts.
    avail: quota + carry - used,
  };
}
