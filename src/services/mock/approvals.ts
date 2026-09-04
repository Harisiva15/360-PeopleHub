/**
 * The approval inbox — what is waiting on the signed-in user.
 *
 * It reaches across nine record sets, which is exactly why it belongs on the
 * server: a client that assembled this would need read access to every one of
 * them, including loans and letters that most callers may not see.
 */

import { ATT } from '../../data/attendance';
import { CANDS, INTERVIEWS } from '../../data/ats';
import { CLAIMS } from '../../data/expenses';
import { LEAVES } from '../../data/leave';
import { LETTER_REQS } from '../../data/letters';
import { LOANS } from '../../data/loans';
import { REVIEWS } from '../../data/performance';
import { OVERTIME } from '../../data/shifts';
import { TS } from '../../data/timesheet';
import { TICKETS } from '../../data/helpdesk';
import { visibleIds } from '../../state/rbac';
import type { ApprovalsService, PendingItem } from '../contracts';
import { ok } from './util';

export const approvalsService: ApprovalsService = {
  pending({ role, meId }) {
    const ids = visibleIds(role, meId).filter((i) => i !== meId);
    const rows: PendingItem[] = [
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
    ];
    return ok(rows.filter((i) => i.n > 0));
  },

  pendingCount({ role, meId }) {
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
    return ok(n);
  },

  navBadges(caller) {
    const counts: Record<string, number> = {};
    return approvalsService.pendingCount(caller).then((n) => {
      if (n > 0) counts.approvals = n;
      const open = TICKETS.filter(
        (t) => t.empId === caller.meId && ['Open', 'In Progress'].includes(t.status),
      ).length;
      if (open > 0) counts.helpdesk = open;
      return counts;
    });
  },
};
