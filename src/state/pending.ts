import { ATT } from '../data/attendance';
import { CANDS, INTERVIEWS } from '../data/ats';
import { CLAIMS } from '../data/expenses';
import { LEAVES } from '../data/leave';
import { LETTER_REQS } from '../data/letters';
import { LOANS } from '../data/loans';
import { REVIEWS } from '../data/performance';
import { OVERTIME } from '../data/shifts';
import { TS } from '../data/timesheet';
import { visibleIds } from './rbac';
import type { AppRole } from '../types/employee';

export interface PendingItem {
  ic: string;
  k: string;
  n: number;
  /** Route the row opens. */
  r: string;
}

/**
 * Everything waiting on the signed-in user, scoped to what their role can see.
 * Own records are excluded — nobody approves their own request.
 */
export function pendingItems(role: AppRole, meId: string): PendingItem[] {
  const ids = visibleIds(role, meId).filter((i) => i !== meId);
  return [
    { ic: '🌴', k: 'Leave requests', n: LEAVES.filter((l) => l.status === 'Pending' && ids.includes(l.empId)).length, r: 'leave' },
    { ic: '⏱️', k: 'Timesheets', n: TS.filter((t) => t.status === 'Submitted' && ids.includes(t.empId)).length, r: 'timesheet' },
    { ic: '📍', k: 'Attendance regularisations', n: ATT.filter((a) => a.reg && a.reg.status === 'Pending' && ids.includes(a.empId)).length, r: 'attendance' },
    { ic: '🎯', k: 'Interview feedback pending', n: INTERVIEWS.filter((i) => i.panelId === meId && i.status === 'Completed' && !i.feedback).length, r: 'hiring' },
    { ic: '📄', k: 'Offers awaiting approval', n: role === 'admin' ? CANDS.filter((c) => c.offer && c.offer.status === 'Sent').length : 0, r: 'hiring' },
    { ic: '🧾', k: 'Expense claims', n: CLAIMS.filter((c) => c.status === 'Submitted' && ids.includes(c.empId)).length, r: 'expenses' },
    { ic: '⏱️', k: 'Overtime requests', n: OVERTIME.filter((o) => o.status === 'Pending' && ids.includes(o.empId)).length, r: 'shifts' },
    { ic: '🏦', k: 'Loan applications', n: role === 'admin' ? LOANS.filter((l) => l.status === 'Pending Approval').length : 0, r: 'benefits' },
    { ic: '✉️', k: 'Letter requests', n: role === 'admin' ? LETTER_REQS.filter((l) => l.status === 'Pending').length : 0, r: 'documents' },
    { ic: '📝', k: 'Performance reviews to write', n: role === 'employee' ? 0 : REVIEWS.filter((r) => ids.includes(r.empId) && r.self.rating && !r.manager.rating).length, r: 'performance' },
  ].filter((i) => i.n > 0);
}

/**
 * The count shown as a pill against Approvals in the sidebar.
 *
 * This is deliberately narrower than `pendingItems` — it covers only the core
 * approval queues, matching the prototype's badge.
 */
export function pendingCount(role: AppRole, meId: string): number {
  const ids = visibleIds(role, meId);
  let n = 0;
  if (role !== 'employee') {
    n += LEAVES.filter((l) => l.status === 'Pending' && ids.includes(l.empId)).length;
    n += TS.filter((t) => t.status === 'Submitted' && ids.includes(t.empId)).length;
    n += ATT.filter((a) => a.reg && a.reg.status === 'Pending' && ids.includes(a.empId)).length;
    n += CLAIMS.filter((c) => c.status === 'Submitted' && ids.includes(c.empId) && c.empId !== meId).length;
    n += OVERTIME.filter((o) => o.status === 'Pending' && ids.includes(o.empId) && o.empId !== meId).length;
  }
  if (role === 'admin') {
    n += LOANS.filter((l) => l.status === 'Pending Approval').length;
    n += LETTER_REQS.filter((l) => l.status === 'Pending').length;
  }
  return n;
}
