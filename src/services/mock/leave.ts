import { TODAY, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { EMAP } from '../../data/employees';
import { LEAVES, LEAVE_BAL, leaveBalance } from '../../data/leave';
import type { LeaveRequest } from '../../data/leave';
import type { LeaveBalanceRow, LeaveService } from '../contracts';
import { ok } from './util';

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
    const row: LeaveRequest = {
      id: uid('LV'),
      empId: req.empId,
      type: req.type,
      from: req.from,
      to: req.to,
      days: req.days,
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
