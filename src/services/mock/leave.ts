import { TODAY, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { EMAP } from '../../data/employees';
import { LEAVES, LEAVE_BAL, leaveBalance } from '../../data/leave';
import type { LeaveRequest } from '../../data/leave';
import type { LeaveBalanceRow, LeaveService } from '../contracts';
import { ok } from './util';
import { classifyDemoDays, demoWorkingDays } from './calendar';
const find = (id: string): LeaveRequest | undefined => LEAVES.find((l) => l.id === id);

const missing = (id: string) => Promise.reject(new Error('No such leave request: ' + id));

export const leaveService: LeaveService = {
  list(q) {
    let out = LEAVES.slice();
    if (q.empIds) {
      const want = new Set(q.empIds);
      out = out.filter((l) => want.has(l.empId));
    }
    if (q.status) out = out.filter((l) => l.status === q.status);
    return ok(out);
  },

  balances(empId) {
    const rows = Object.keys(LEAVE_BAL[empId] || {})
      .map((type) => {
        const b = leaveBalance(empId, type);
        return b ? { type, ...b } : null;
      })
      .filter(Boolean) as LeaveBalanceRow[];
    return ok(rows);
  },

  balance(empId, type) {
    const b = leaveBalance(empId, type);
    return ok(b ? { type, ...b } : null);
  },

  apply(req) {
    const e = EMAP[req.empId];
    /*
     * Derived, not taken from the caller — the same change the server made. A
     * half day is 0.5 of one working day; a range with no working day in it is
     * refused rather than stored as zero.
     */
    const span = demoWorkingDays(req.empId, req.from, req.to);
    if (span === 0) {
      /*
       * Per employee now, because the count is: somebody on a six-day pattern
       * has a working Saturday and somebody on the default does not. The
       * wording follows the server's for the same reasons.
       */
      const why = classifyDemoDays(req.empId, req.from, req.to)
        .some((d) => d.reason === 'NOT_EMPLOYED')
        ? 'those dates fall outside this person\'s employment'
        : 'those dates are all week off or holidays';
      return Promise.reject(new Error(`${why}, so there is no leave to take`));
    }
    if (req.half && req.from !== req.to) {
      return Promise.reject(new Error('a half day is a single day'));
    }
    const days = req.half ? 0.5 : span;
    const row: LeaveRequest = {
      id: uid('LV'),
      empId: req.empId,
      type: req.type,
      from: req.from,
      to: req.to,
      days,
      half: req.half,
      reason: req.reason || 'Personal',
      status: 'Pending',
      approverId: e?.managerId ?? null,
      appliedOn: ymd(TODAY),
      actedOn: null,
      note: '',
    };
    LEAVES.push(row);
    return ok(row);
  },

  /** Approving debits the balance — the one place that write is allowed to happen. */
  approve(id, approverId) {
    const l = find(id);
    if (!l) return missing(id);
    if (l.status !== 'Pending') return Promise.reject(new Error('Already ' + l.status.toLowerCase()));
    l.status = 'Approved';
    l.approverId = approverId;
    l.actedOn = ymd(TODAY);
    const bal = LEAVE_BAL[l.empId]?.[l.type];
    if (bal) bal.used += l.days;
    return ok(l);
  },

  reject(id, approverId, note) {
    const l = find(id);
    if (!l) return missing(id);
    l.status = 'Rejected';
    l.approverId = approverId;
    l.actedOn = ymd(TODAY);
    if (note) l.note = note;
    return ok(l);
  },

  cancel(id) {
    const l = find(id);
    if (!l) return missing(id);
    /* A cancelled approval returns the days to the balance. */
    if (l.status === 'Approved') {
      const bal = LEAVE_BAL[l.empId]?.[l.type];
      if (bal) bal.used -= l.days;
    }
    l.status = 'Cancelled';
    l.actedOn = ymd(TODAY);
    return ok(l);
  },

  balancesFor(empIds) {
    const out: Record<string, LeaveBalanceRow[]> = {};
    empIds.forEach((id) => {
      out[id] = Object.keys(LEAVE_BAL[id] || {})
        .map((type) => {
          const b = leaveBalance(id, type);
          return b ? { type, ...b } : null;
        })
        .filter(Boolean) as LeaveBalanceRow[];
    });
    return ok(out);
  },
};
