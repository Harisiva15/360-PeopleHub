/**
 * The three small approval surfaces — overtime, staff loans and HR letters.
 *
 * They live together because each is a single transition rather than a domain
 * of its own; splitting them into three files would be filing, not design.
 */

import { TODAY, ymd } from '../../lib/dates';
import { OVERTIME } from '../../data/shifts';
import { LOANS } from '../../data/loans';
import { LETTER_REQS } from '../../data/letters';
import { CANDS, INTERVIEWS, REQS, reqOf, STAGES } from '../../data/ats';
import type { HiringService, InterviewRow, LetterService, LoanService, ShiftService } from '../contracts';
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
    return ok(o);
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
