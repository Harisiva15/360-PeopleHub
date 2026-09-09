/**
 * The three small approval surfaces — overtime, staff loans and HR letters.
 *
 * They live together because each is a single transition rather than a domain
 * of its own; splitting them into three files would be filing, not design.
 */

import { TODAY, ymd } from '../../lib/dates';
import { ACTIVE, empName } from '../../data/employees';
import { LEAVE_BAL } from '../../data/leave';
import { OVERTIME, ROSTER, SHIFTS } from '../../data/shifts';
import { LOANS } from '../../data/loans';
import { LETTER_REQS } from '../../data/letters';
import { CANDS, INTERVIEWS, REQS, reqOf, STAGES } from '../../data/ats';
import type {
  Candidate, HiringService, InterviewRow, LetterService, LoanService, Overtime,
  RecruiterStat, Requisition, ShiftService,
} from '../contracts';
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

  openRequisition(draft) {
    if (!draft.title.trim()) return Promise.reject(new Error('A requisition needs a title'));
    if (!(draft.openings >= 1)) return Promise.reject(new Error('A requisition needs at least one opening'));
    REQS.unshift({
      id: 'REQ-' + (REQS.length + 1),
      title: draft.title.trim(),
      dept: draft.dept,
      grade: (draft.grade ?? 'L2') as Requisition['grade'],
      site: draft.site ?? 'CHN',
      openings: draft.openings,
      filled: 0,
      priority: (draft.priority ?? 'Medium') as Requisition['priority'],
      status: 'Open',
      hiringManagerId: draft.hiringManagerId,
      recruiterId: draft.recruiterId ?? draft.hiringManagerId,
      openedOn: ymd(TODAY),
      budgetMin: draft.budgetMin ?? 0,
      budgetMax: draft.budgetMax ?? 0,
      type: draft.type ?? 'permanent',
      desc: draft.desc ?? '',
      must: draft.must ?? [],
      exp: draft.exp ?? '',
    });
    return ok(REQS.slice());
  },

  submitCandidate(draft) {
    const req = REQS.find((r) => r.id === draft.reqId);
    if (!req) return Promise.reject(new Error('No such requisition'));
    if (req.status === 'Closed') return Promise.reject(new Error('That role is closed'));
    if (CANDS.some((c) => c.reqId === draft.reqId && c.email === draft.email)) {
      return Promise.reject(new Error('That candidate has already been submitted for this role'));
    }
    const cand: Candidate = {
      id: 'CAND-' + (CANDS.length + 1),
      name: draft.name.trim(),
      reqId: draft.reqId,
      stage: 'applied',
      email: draft.email.trim(),
      phone: draft.phone ?? '',
      source: draft.source ?? '',
      appliedOn: ymd(TODAY),
      exp: draft.exp ?? '',
      current: draft.current ?? '',
      ctcCur: draft.ctcCur ?? 0,
      ctcExp: draft.ctcExp ?? 0,
      notice: draft.notice ?? '',
      rating: 0,
      skills: draft.skills ?? [],
      loc: draft.loc ?? '',
      resume: '',
      notes: [],
      offer: null,
    };
    CANDS.push(cand);
    return ok(cand);
  },

  recruiterTracker() {
    const byRecruiter = new Map<string, RecruiterStat>();
    REQS.forEach((r) => {
      const stat = byRecruiter.get(r.recruiterId) ?? {
        recruiterId: r.recruiterId, name: empName(r.recruiterId),
        openReqs: 0, openings: 0, submissions: 0, inPipeline: 0,
        interviews: 0, offers: 0, hires: 0,
      };
      if (r.status === 'Open') { stat.openReqs += 1; stat.openings += r.openings; }
      const cands = CANDS.filter((c) => c.reqId === r.id);
      stat.submissions += cands.length;
      stat.inPipeline += cands.filter((c) => c.stage !== 'hired' && c.stage !== 'rejected').length;
      stat.offers += cands.filter((c) => c.stage === 'offer').length;
      stat.hires += cands.filter((c) => c.stage === 'hired').length;
      stat.interviews += INTERVIEWS.filter((i) => i.reqId === r.id).length;
      byRecruiter.set(r.recruiterId, stat);
    });
    return ok([...byRecruiter.values()].sort((a, b) => b.hires - a.hires || b.submissions - a.submissions));
  },
};
