/**
 * The three small approval surfaces — overtime, staff loans and HR letters.
 *
 * They live together because each is a single transition rather than a domain
 * of its own; splitting them into three files would be filing, not design.
 */

import { TODAY, ymd } from '../../lib/dates';
import { ACTIVE } from '../../data/employees';
import { LEAVE_BAL } from '../../data/leave';
import { OVERTIME, ROSTER, SHIFTS } from '../../data/shifts';
import { LOANS } from '../../data/loans';
import { LETTER_REQS } from '../../data/letters';
import { CANDS, INTERVIEWS, REQS, reqOf, STAGES } from '../../data/ats';
import type { HiringService, InterviewRow, LetterService, LoanService, Overtime, ShiftService } from '../contracts';
import { ok } from './util';

export const shiftService: ShiftService = {
  overtime(empIds, status) {
    let out = OVERTIME.slice();
    if (empIds) {
      const want = new Set(empIds);
      out = out.filter((o) => want.has(o.empId));
    }
    if (status) out = out.filter((o) => o.status === status);
    return ok(out);
  },

  approveOvertime(id, approverId) {
    const o = OVERTIME.find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('No such overtime record: ' + id));
    if (o.status === 'Approved') return Promise.reject(new Error('Already approved'));
    o.status = 'Approved';
    o.approverId = approverId;
    /* Comp off is earned on approval — eight hours to the day. */
    const bal = LEAVE_BAL[o.empId]?.CO;
    if (o.compensation === 'Comp Off' && bal) bal.quota += Math.round(o.hours / 8);
    return ok(o);
  },

  raiseOvertime(o) {
    if (o.hours <= 0) return Promise.reject(new Error('Overtime must be at least an hour'));
    if (o.hours > 12) return Promise.reject(new Error('More than 12 hours in a day needs an exception'));
    if (!o.reason.trim()) return Promise.reject(new Error('Say what the extra hours were for'));
    const row: Overtime = {
      id: 'OT-' + (900 + OVERTIME.length),
      empId: o.empId, date: o.date, hours: o.hours, reason: o.reason,
      status: 'Pending', compensation: o.compensation, approverId: null,
    };
    OVERTIME.unshift(row);
    return ok(row);
  },

  roster(empIds) {
    const out: Record<string, Record<string, string>> = {};
    empIds.forEach((id) => { out[id] = { ...(ROSTER[id] ?? {}) }; });
    return ok(out);
  },

  setShift(empId, date, shiftId) {
    if (shiftId !== 'OFF' && !SHIFTS.some((s) => s.id === shiftId)) {
      return Promise.reject(new Error('That is not a shift pattern'));
    }
    ROSTER[empId] = ROSTER[empId] ?? {};
    ROSTER[empId][date] = shiftId;
    return ok({ empId, date, shiftId });
  },

  todayCoverage() {
    const today = ymd(TODAY);
    const out: Record<string, number> = {};
    SHIFTS.forEach((s) => { out[s.id] = 0; });
    ACTIVE().forEach((e) => {
      const s = ROSTER[e.id]?.[today];
      if (s && out[s] !== undefined) out[s] += 1;
    });
    return ok(out);
  },
};

export const loanService: LoanService = {
  list(status) {
    return ok(status ? LOANS.filter((l) => l.status === status) : LOANS.slice());
  },

  approve(id) {
    const l = LOANS.find((x) => x.id === id);
    if (!l) return Promise.reject(new Error('No such loan: ' + id));
    if (l.status !== 'Pending Approval') return Promise.reject(new Error('Already ' + l.status.toLowerCase()));
    l.status = 'Active';
    return ok(l);
  },
};

export const letterService: LetterService = {
  requests(status) {
    return ok(status ? LETTER_REQS.filter((l) => l.status === status) : LETTER_REQS.slice());
  },

  issue(id) {
    const l = LETTER_REQS.find((x) => x.id === id);
    if (!l) return Promise.reject(new Error('No such letter request: ' + id));
    if (l.status === 'Issued') return Promise.reject(new Error('Already issued'));
    l.status = 'Issued';
    l.issuedOn = ymd(TODAY);
    return ok(l);
  },
};

export const hiringService: HiringService = {
  interviewsFor(panelId, status) {
    const rows: InterviewRow[] = INTERVIEWS.filter(
      (i) => i.panelId === panelId && (!status || i.status === status),
    ).map((interview) => ({
      interview,
      candidate: CANDS.find((c) => c.id === interview.candId) ?? null,
      requisitionTitle: reqOf(interview.reqId)?.title ?? '—',
    }));
    return ok(rows);
  },

  interviews() {
    return ok(INTERVIEWS.slice());
  },

  moveCandidate(candId, stage) {
    const c = CANDS.find((x) => x.id === candId);
    if (!c) throw new Error('That candidate is not on file');
    if (!STAGES.some((s) => s.id === stage)) throw new Error('That is not a pipeline stage');
    c.stage = stage;
    return ok(c);
  },

  candidates() {
    return ok(CANDS.slice());
  },

  requisitions() {
    return ok(REQS.slice());
  },
};
