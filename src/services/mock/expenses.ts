import { monthKey, TODAY, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { EMAP } from '../../data/employees';
import { ADVANCES, CLAIMS } from '../../data/expenses';
import type { Advance, Claim } from '../../data/expenses';
import type { ExpenseService } from '../contracts';
import { ok } from './util';

const findClaim = (id: string): Claim | undefined => CLAIMS.find((c) => c.id === id);
const noClaim = (id: string) => Promise.reject(new Error('No such claim: ' + id));

export const expenseService: ExpenseService = {
  claims(q) {
    let out = CLAIMS.slice();
    if (q.empIds) {
      const want = new Set(q.empIds);
      out = out.filter((c) => want.has(c.empId));
    }
    if (q.status) out = out.filter((c) => c.status === q.status);
    return ok(out);
  },

  submitClaim(c) {
    const row: Claim = {
      id: 'EXP-' + (4200 + CLAIMS.length),
      empId: c.empId,
      title: c.title || 'Expense claim',
      items: [{ ...c.item, id: uid('EX') }],
      total: c.item.amount,
      status: 'Submitted',
      submittedOn: ymd(TODAY),
      approverId: EMAP[c.empId]?.managerId ?? null,
      actedOn: null,
      reimbursedOn: null,
      payrollMonth: null,
      note: '',
    };
    CLAIMS.unshift(row);
    return ok(row);
  },

  approveClaim(id, approverId) {
    const c = findClaim(id);
    if (!c) return noClaim(id);
    if (c.status !== 'Submitted') return Promise.reject(new Error('Already ' + c.status.toLowerCase()));
    c.status = 'Approved';
    c.approverId = approverId;
    c.actedOn = ymd(TODAY);
    return ok(c);
  },

  rejectClaim(id, approverId, note) {
    const c = findClaim(id);
    if (!c) return noClaim(id);
    if (c.status !== 'Submitted') return Promise.reject(new Error('Already ' + c.status.toLowerCase()));
    c.status = 'Rejected';
    c.approverId = approverId;
    c.note = note;
    c.actedOn = ymd(TODAY);
    return ok(c);
  },

  /** Only an approved claim is payable — a submitted one has not been agreed yet. */
  reimburseClaim(id) {
    const c = findClaim(id);
    if (!c) return noClaim(id);
    if (c.status !== 'Approved') return Promise.reject(new Error('Only an approved claim can be reimbursed'));
    c.status = 'Reimbursed';
    c.reimbursedOn = ymd(TODAY);
    c.payrollMonth = monthKey(TODAY);
    return ok(c);
  },

  advances(empIds) {
    if (!empIds) return ok(ADVANCES.slice());
    const want = new Set(empIds);
    return ok(ADVANCES.filter((a) => want.has(a.empId)));
  },

  requestAdvance(empId, amount, reason) {
    const row: Advance = {
      id: 'ADV-' + (300 + ADVANCES.length),
      empId,
      amount,
      reason: reason || 'Travel advance',
      requestedOn: ymd(TODAY),
      status: 'Pending',
      settled: 0,
    };
    ADVANCES.unshift(row);
    return ok(row);
  },

  approveAdvance(id) {
    const a = ADVANCES.find((x) => x.id === id);
    if (!a) return Promise.reject(new Error('No such advance: ' + id));
    if (a.status !== 'Pending') return Promise.reject(new Error('Already ' + a.status.toLowerCase()));
    a.status = 'Approved';
    return ok(a);
  },
};
