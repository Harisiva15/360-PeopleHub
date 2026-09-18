/**
 * The three small approval surfaces — overtime, staff loans and HR letters.
 *
 * They live together because each is a single transition rather than a domain
 * of its own; splitting them into three files would be filing, not design.
 */

import { addDays, daysBetween, isWeekend, parseYmd, TODAY, ymd } from '../../lib/dates';
import { ACTIVE, DEMO_EMP, empName } from '../../data/employees';
import { LEAVE_BAL } from '../../data/leave';
import { OVERTIME, ROSTER, SHIFTS } from '../../data/shifts';
import { LOANS } from '../../data/loans';
import { LETTER_REQS, LETTER_TYPES } from '../../data/letters';
import { CANDS, INTERVIEWS, REQS, reqOf, STAGES } from '../../data/ats';
import type {
  Candidate, HiringService, Interview, InterviewRow, LetterRequest, LetterService,
  LoanService, Overtime, RecruiterStat, ReqActivity, Requisition, ShiftService,
} from '../contracts';
import type { Offer } from '../../data/ats';
import { ok } from './util';

/** The clock part of an instant, as the schedule stores it. */
const hhmmOf = (d: Date) =>
  String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

/** Everyone currently on a given profile, by their standing shift. */
const onShift = (code: string) =>
  ACTIVE().filter((e) => {
    const week = ROSTER[e.id] ?? {};
    return Object.values(week).some((s) => s === code);
  });

export const shiftService: ShiftService = {
  profiles() {
    return ok(SHIFTS.map((s) => ({
      id: s.id, code: s.id, name: s.n, start: s.start, end: s.end,
      timezone: s.tz, region: s.region, night: s.night, flexible: false,
      headcount: onShift(s.id).length,
    })));
  },

  overtime(empIds, status) {
    let out = OVERTIME.slice();
    if (empIds) {
      const want = new Set(empIds);
      out = out.filter((o) => want.has(o.empId));
    }
    if (status) out = out.filter((o) => o.status === status);
    return ok(out);
  },

  approveOvertime(id) {
    const o = OVERTIME.find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('No such overtime record: ' + id));
    if (o.status !== 'Pending') return Promise.reject(new Error('That claim was already ' + o.status.toLowerCase()));
    o.status = 'Approved';
    /*
     * Eight hours to the day, rounded *down*: a part-day credit is not
     * something the leave ledger can hold, and rounding up would hand out a
     * full day for five hours' work.
     */
    if (o.compensation === 'Comp Off') {
      const days = Math.floor(o.hours / 8);
      const bal = LEAVE_BAL[o.empId]?.CO;
      if (days > 0 && bal) { bal.quota += days; o.credited = days; }
    }
    return ok(o);
  },

  rejectOvertime(id) {
    const o = OVERTIME.find((x) => x.id === id);
    if (!o) return Promise.reject(new Error('No such overtime record: ' + id));
    if (o.status !== 'Pending') return Promise.reject(new Error('That claim was already ' + o.status.toLowerCase()));
    o.status = 'Rejected';
    return ok(o);
  },

  raiseOvertime(o) {
    if (o.hours <= 0) return Promise.reject(new Error('Overtime must be more than zero hours'));
    if (o.hours > 12) return Promise.reject(new Error('More than 12 hours in one day needs an exception, not a claim'));
    if (!o.reason.trim()) return Promise.reject(new Error('Say what the extra hours were for'));
    if (o.date > ymd(TODAY)) return Promise.reject(new Error('That day has not happened yet'));
    const row: Overtime = {
      id: 'OT-' + (900 + OVERTIME.length),
      empId: o.empId, date: o.date, hours: o.hours, reason: o.reason,
      status: 'Pending', compensation: o.compensation, approverId: null, credited: 0,
    };
    OVERTIME.unshift(row);
    return ok(row);
  },

  roster(empIds, from, days) {
    const out: Record<string, Record<string, string>> = {};
    empIds.forEach((id) => {
      const week: Record<string, string> = {};
      for (let i = 0; i < days; i++) {
        const d = ymd(addDays(parseYmd(from), i));
        /* Fall back to the standing profile when the window runs past what is generated. */
        week[d] = ROSTER[id]?.[d]
          ?? (isWeekend(parseYmd(d)) ? 'OFF' : standingOf(id));
      }
      out[id] = week;
    });
    return ok(out);
  },

  setShift(empId, shiftCode) {
    if (!SHIFTS.some((s) => s.id === shiftCode)) {
      return Promise.reject(new Error('No such shift: ' + shiftCode));
    }
    /* A profile change applies to every day, because it is a change to the person. */
    const week = ROSTER[empId] ?? (ROSTER[empId] = {});
    Object.keys(week).forEach((d) => { if (week[d] !== 'OFF') week[d] = shiftCode; });
    return ok({ empId, shift: shiftCode });
  },

  todayCoverage() {
    const out: Record<string, number> = {};
    SHIFTS.forEach((s) => { out[s.id] = onShift(s.id).length; });
    return ok(out);
  },
};

/** The profile somebody is on, read off whichever working day is generated. */
function standingOf(empId: string): string {
  const week = ROSTER[empId] ?? {};
  return Object.values(week).find((s) => s !== 'OFF') ?? 'IN';
}

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

const refOf = (type: string, id: string) =>
  `${type.toUpperCase()}/${TODAY.getFullYear()}/${id.slice(-4).toUpperCase()}`;

/* Stands in for what the service renders from the facts on file. */
const bodyFor = (type: string, empId: string) =>
  `${LETTER_TYPES.find((t) => t.id === type)?.n ?? 'Letter'} for ${empName(empId)}, `
  + 'issued on ' + ymd(TODAY) + '.';

export const letterService: LetterService = {
  types() {
    return ok(LETTER_TYPES.map((t) => ({
      code: t.id, name: t.n, instant: t.self, requiresApproval: !t.self,
    })));
  },

  requests(status) {
    return ok(status ? LETTER_REQS.filter((l) => l.status === status) : LETTER_REQS.slice());
  },

  request(draft) {
    const t = LETTER_TYPES.find((x) => x.id === draft.type);
    if (!t) return Promise.reject(new Error('No such letter type: ' + draft.type));
    /* One open request per person per type — asking twice should not queue two. */
    if (LETTER_REQS.some((l) => l.empId === DEMO_EMP.id && l.type === t.id && l.status === 'Pending')) {
      return Promise.reject(new Error('You already have an open request for that letter'));
    }
    const id = 'LTR-' + (900 + LETTER_REQS.length);
    const row: LetterRequest = {
      id,
      empId: DEMO_EMP.id,
      type: t.id,
      purpose: draft.purpose ?? '',
      requestedOn: ymd(TODAY),
      status: 'Pending',
      issuedOn: null,
      body: '',
      reference: null,
      declineReason: null,
    };
    /* An instant letter is not a request — it is true the moment it is asked for. */
    if (t.self) {
      row.status = 'Issued';
      row.issuedOn = ymd(TODAY);
      row.body = bodyFor(t.id, row.empId);
      row.reference = refOf(t.id, id);
    }
    LETTER_REQS.unshift(row);
    return ok(row);
  },

  issue(id) {
    const l = LETTER_REQS.find((x) => x.id === id);
    if (!l) return Promise.reject(new Error('No such letter request: ' + id));
    if (l.status !== 'Pending') return Promise.reject(new Error('That request was already ' + l.status.toLowerCase()));
    l.status = 'Issued';
    l.issuedOn = ymd(TODAY);
    l.body = bodyFor(l.type, l.empId);
    l.reference = refOf(l.type, l.id);
    return ok(l);
  },

  reject(id, reason) {
    const l = LETTER_REQS.find((x) => x.id === id);
    if (!l) return Promise.reject(new Error('No such letter request: ' + id));
    if (l.status !== 'Pending') return Promise.reject(new Error('That request was already ' + l.status.toLowerCase()));
    if (!reason.trim()) return Promise.reject(new Error('Say why — the employee sees this'));
    l.status = 'Rejected';
    l.declineReason = reason.trim();
    return ok(l);
  },
};

/**
 * Letters frozen at the moment of release, keyed by candidate.
 *
 * Kept beside the offer rather than on it because the stored letter is not part
 * of the offer's shape — it is a record of what the offer said when it went
 * out, which is a different question from what the offer says now.
 */
const LETTERS = new Map<string, string>();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Read straight off 'YYYY-MM-DD'; see the note in the server's renderLetter. */
const inWords = (d: string) => {
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
};

function renderOffer(name: string, o: Offer): string {
  const money = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(o.ctc);
  return [
    `Dear ${name},`, '',
    'We are delighted to offer you a position at 360VHM Technology.', '',
    `Your annual cost to company will be ${money}, and we would like you to join `
    + `us on ${inWords(o.doj)}. A detailed breakdown of your compensation `
    + 'accompanies this letter.', '',
    'This offer is subject to satisfactory reference and background checks and to '
    + 'the documents requested separately being provided before your joining date.', '',
    'We would be grateful for your acceptance by return. We are looking forward to '
    + 'working with you.', '',
    'Yours sincerely,', '360VHM Technology',
  ].join('\n');
}

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
      closedOn: null,
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

  scheduleInterview(draft) {
    const cand = CANDS.find((c) => c.id === draft.candId);
    if (!cand) return Promise.reject(new Error('That candidate is not on file'));
    const at = new Date(draft.at);
    if (Number.isNaN(at.getTime())) return Promise.reject(new Error('That is not a valid date and time'));
    const clash = INTERVIEWS.some(
      (i) => i.panelId === draft.panelId && i.status === 'Scheduled'
        && i.date === ymd(at) && i.time === hhmmOf(at),
    );
    if (clash) return Promise.reject(new Error('That panel member is already booked then'));
    const iv: Interview = {
      id: 'IV-' + (INTERVIEWS.length + 1),
      candId: draft.candId,
      reqId: cand.reqId,
      round: draft.round,
      date: ymd(at),
      time: hhmmOf(at),
      panelId: draft.panelId,
      mode: draft.mode ?? 'video',
      status: 'Scheduled',
      verdict: null,
      feedback: '',
    };
    INTERVIEWS.push(iv);
    return ok(iv);
  },

  submitFeedback(id, verdict, feedback) {
    const iv = INTERVIEWS.find((x) => x.id === id);
    if (!iv) return Promise.reject(new Error('No such interview'));
    if (iv.status === 'Completed') return Promise.reject(new Error('That interview already has a verdict'));
    iv.status = 'Completed';
    iv.verdict = verdict;
    iv.feedback = feedback;
    return ok(iv);
  },

  makeOffer(draft) {
    const cand = CANDS.find((c) => c.id === draft.candId);
    if (!cand) return Promise.reject(new Error('That candidate is not on file'));
    if (cand.offer) return Promise.reject(new Error('That candidate already has a live offer'));
    if (!(draft.ctc > 0)) return Promise.reject(new Error('An offer needs a salary above zero'));
    cand.offer = {
      ctc: draft.ctc,
      grade: (draft.grade ?? 'L2') as Offer['grade'],
      status: 'Draft',
      sentOn: null,
      doj: draft.doj,
      site: 'CHN',
    };
    cand.stage = 'offer';
    return ok(cand);
  },

  offerLetter(candId) {
    const cand = CANDS.find((c) => c.id === candId);
    if (!cand?.offer) return Promise.reject(new Error('That candidate has no offer'));
    /* A released letter reads back as it was sent, never re-rendered. */
    return ok(LETTERS.get(candId) ?? renderOffer(cand.name, cand.offer));
  },

  releaseOffer(candId) {
    const cand = CANDS.find((c) => c.id === candId);
    if (!cand?.offer) return Promise.reject(new Error('That candidate has no offer'));
    if (cand.offer.status !== 'Draft') {
      return Promise.reject(new Error('That offer is already ' + cand.offer.status.toLowerCase()));
    }
    /* Frozen here, so a later change of salary cannot rewrite what was promised. */
    LETTERS.set(candId, renderOffer(cand.name, cand.offer));
    cand.offer.status = 'Sent';
    cand.offer.sentOn = ymd(TODAY);
    return ok(cand);
  },

  respondToOffer(candId, response) {
    const cand = CANDS.find((c) => c.id === candId);
    if (!cand?.offer) return Promise.reject(new Error('That candidate has no offer'));
    if (cand.offer.status === 'Accepted') return Promise.reject(new Error('That offer is already accepted'));
    if (cand.offer.status === 'Draft') return Promise.reject(new Error('That offer has not been released yet'));
    if (response === 'accepted') {
      cand.offer.status = 'Accepted';
      cand.stage = 'hired';
    } else if (response === 'negotiating') {
      cand.offer.status = 'Negotiating';
    } else {
      cand.offer = null;
      cand.stage = 'rejected';
    }
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

  requisitionTracker() {
    const rows: ReqActivity[] = REQS.map((r) => {
      const cands = CANDS.filter((c) => c.reqId === r.id);
      const ivs = INTERVIEWS.filter((i) => i.reqId === r.id);

      const byStage: Record<string, number> = {};
      cands.forEach((c) => { byStage[c.stage] = (byStage[c.stage] ?? 0) + 1; });

      /* The latest thing that happened, whatever kind of thing it was. */
      const dates = [
        ...cands.map((c) => c.appliedOn),
        ...ivs.map((i) => i.date),
        ...cands.map((c) => c.offer?.sentOn).filter((d): d is string => !!d),
      ].filter(Boolean).sort();

      return {
        reqId: r.id,
        title: r.title,
        dept: r.dept,
        site: r.site,
        status: r.status,
        priority: r.priority,
        openings: r.openings,
        filled: r.filled,
        openedOn: r.openedOn,
        /* Age runs to closure once closed, not onward to today. */
        ageDays: daysBetween(r.openedOn, r.closedOn ?? ymd(TODAY)),
        hiringManagerId: r.hiringManagerId,
        recruiterId: r.recruiterId,
        submissions: cands.length,
        active: cands.filter((c) => c.stage !== 'hired' && c.stage !== 'rejected').length,
        rejected: cands.filter((c) => c.stage === 'rejected').length,
        byStage,
        interviews: ivs.length,
        interviewsDone: ivs.filter((i) => i.status === 'Completed').length,
        offers: cands.filter((c) => c.stage === 'offer').length,
        hires: cands.filter((c) => c.stage === 'hired').length,
        lastActivity: dates.length ? dates[dates.length - 1]! : null,
      };
    });
    /* Open roles first — a tracker is read to find what still needs work. */
    return ok(rows.sort((a, b) =>
      Number(b.status === 'Open') - Number(a.status === 'Open')
      || b.openedOn.localeCompare(a.openedOn)));
  },
};
