/**
 * The recruitment desk, in memory.
 *
 * Mirrors what migration 0029 enforces rather than approximating it, because
 * these are the rules the screens are written against: a pay rate below the
 * bill rate, an SLA whose three targets run in order, one live holder of each
 * desk role, and a history that is appended to and never edited.
 *
 * **Counts and the SLA are computed here, not in the screen.** Two clients
 * counting submissions their own way will eventually disagree, and the figure
 * a recruiter is measured against has to be the one their manager sees.
 */

import { sortBy } from '../../lib/collections';
import { addDays, parseYmd, TODAY, ymd } from '../../lib/dates';
import { EMAP } from '../../data/employees';
import {
  ACTIVITY_META, CLIENTS, JOB_ACTIVITY, JOB_ASSIGNMENTS, PLACEMENTS, REQUIREMENTS, SUBMISSIONS,
  clientOf, slaOf,
} from '../../data/staffing';
import type {
  ActivityKind, JobActivity, JobAssignment, JobStatus, StaffingRequirement,
} from '../../data/staffing';
import type {
  JobOrderDetail, JobOrderDraft, JobOrderRow, RecruitmentFilter, RecruitmentFunnel,
  RecruitmentKPI, RecruitmentService,
} from '../contracts';
import { ok } from './util';

let seq = 7000;
const nextId = (p: string) => `${p}-${seq += 1}`;

const now = () => `${ymd(TODAY)}T${new Date().toTimeString().slice(0, 8)}`;

const orderOf = (id: string) => REQUIREMENTS.find((r) => r.id === id);
const missing = (id: string) => Promise.reject(new Error('No such job order: ' + id));

/* ---------------- counting ---------------- */

/**
 * Sourced and screened come off the history rather than a column, because
 * they are activities rather than records — nothing else in the system knows
 * a recruiter looked at forty CVs.
 */
function countsFor(reqId: string) {
  const acts = JOB_ACTIVITY.filter((a) => a.reqId === reqId);
  const subs = SUBMISSIONS.filter((s) => s.reqId === reqId);
  const tally = (kind: ActivityKind) =>
    acts.filter((a) => a.kind === kind).reduce((n, a) => n + (a.qty ?? 1), 0);

  return {
    sourced: tally('sourced'),
    screened: tally('screened'),
    submissions: subs.length,
    interviews: subs.filter((s) => s.interviewOn).length,
    offers: acts.filter((a) => a.kind === 'offer_released').length,
    hires: PLACEMENTS.filter((p) => p.reqId === reqId).length,
  };
}

const slaFor = (r: StaffingRequirement) => {
  const c = countsFor(r.id);
  return slaOf(r, { submissions: c.submissions, interviews: c.interviews, hires: c.hires });
};

/* ---------------- filtering ---------------- */

/**
 * One filter applied to orders, so the tiles, the funnel and the table beneath
 * them are narrowed by the same predicate. Anything else and the three
 * disagree, which is the commonest bug on a dashboard like this.
 */
function matches(r: StaffingRequirement, f: RecruitmentFilter): boolean {
  if (f.reqId && r.id !== f.reqId) return false;
  if (f.clientId && r.clientId !== f.clientId) return false;
  if (f.status && r.status !== f.status) return false;
  if (f.priority && r.priority !== f.priority) return false;
  if (f.location && r.location !== f.location) return false;
  if (f.industry && clientOf(r.clientId).industry !== f.industry) return false;
  if (f.tech && r.primaryTech !== f.tech && !r.skills.includes(f.tech)) return false;
  if (f.recruiterId) {
    const onDesk = JOB_ASSIGNMENTS.some(
      (a) => a.reqId === r.id && !a.releasedOn && a.recruiterId === f.recruiterId);
    if (!onDesk) return false;
  }
  /* The period is about when the order was worked, so it reads openedOn. */
  if (f.from && r.openedOn < f.from) return false;
  if (f.to && r.openedOn > f.to) return false;
  return true;
}

const selected = (f: RecruitmentFilter = {}) => REQUIREMENTS.filter((r) => matches(r, f));

/* ---------------- writing ---------------- */

function log(
  reqId: string, kind: ActivityKind, summary: string,
  extra: { qty?: number | null; actorId?: string | null; refId?: string | null } = {},
): JobActivity {
  const row: JobActivity = {
    id: nextId('ACT'),
    reqId,
    at: now(),
    actorId: extra.actorId ?? null,
    kind,
    summary,
    qty: extra.qty ?? null,
    refId: extra.refId ?? null,
  };
  JOB_ACTIVITY.unshift(row);      /* newest first, as the table is read */
  return row;
}

/** The list shape: the order and where it stands, from one pass. */
const row = (r: StaffingRequirement): JobOrderRow => ({
  order: r,
  sla: slaFor(r),
  counts: countsFor(r.id),
});

const detail = (r: StaffingRequirement): JobOrderDetail => ({
  order: r,
  assignments: JOB_ASSIGNMENTS.filter((a) => a.reqId === r.id && !a.releasedOn),
  activity: sortBy(JOB_ACTIVITY.filter((a) => a.reqId === r.id), (a) => a.at, 'desc'),
  sla: slaFor(r),
  counts: countsFor(r.id),
});

/** Everything the database refuses, refused the same way and in the same order. */
function validate(d: Partial<JobOrderDraft>, base?: StaffingRequirement): Error | null {
  const clientId = d.clientId ?? base?.clientId;
  if (!clientId) return new Error('Choose a client');
  if (!CLIENTS.some((c) => c.id === clientId)) return new Error('No such client: ' + clientId);

  const title = d.title ?? base?.title;
  if (!title?.trim()) return new Error('Give the job order a title');
  const role = d.role ?? base?.role;
  if (!role?.trim()) return new Error('Say what the role is');

  const positions = d.positions ?? base?.positions ?? 1;
  if (!Number.isFinite(positions) || positions < 1) {
    return new Error('A job order is for at least one position');
  }

  const billRate = d.billRate ?? base?.billRate;
  if (!Number.isFinite(billRate) || (billRate as number) <= 0) {
    return new Error('Enter the bill rate');
  }
  const payRate = d.payRate === undefined ? base?.payRate ?? null : d.payRate;
  if (payRate !== null && payRate !== undefined && payRate >= (billRate as number)) {
    return new Error('The pay rate has to sit below the bill rate — otherwise every hour loses money');
  }

  const lo = d.salaryMin === undefined ? base?.salaryMin ?? null : d.salaryMin;
  const hi = d.salaryMax === undefined ? base?.salaryMax ?? null : d.salaryMax;
  if (lo !== null && hi !== null && lo !== undefined && hi !== undefined && hi < lo) {
    return new Error('The salary band runs backwards');
  }

  const eMin = d.expMin ?? base?.expMin;
  const eMax = d.expMax ?? base?.expMax;
  if (eMin !== undefined && eMax !== undefined && eMax < eMin) {
    return new Error('The experience band runs backwards');
  }

  const sla = d.slaDays ?? base?.slaDays ?? 30;
  if (!Number.isFinite(sla) || sla < 1) return new Error('The SLA is at least one day');

  return null;
}

export const recruitmentService: RecruitmentService = {
  jobOrders(f = {}) {
    return ok(sortBy(selected(f), (r) => r.openedOn, 'desc').map(row));
  },

  jobOrder(id) {
    const r = orderOf(id);
    return ok(r ? detail(r) : null);
  },

  createJobOrder(draft) {
    const stop = validate(draft);
    if (stop) return Promise.reject(stop);

    const client = clientOf(draft.clientId);
    const slaDays = draft.slaDays ?? 30;
    const opened = TODAY;
    const perm = draft.jobType === 'Full Time' || draft.jobType === 'Part Time';

    const r: StaffingRequirement = {
      id: nextId('REQ'),
      clientId: draft.clientId,
      sowId: draft.sowId ?? '',
      title: draft.title.trim(),
      role: draft.role.trim(),
      skills: draft.skills ?? [],
      location: draft.location,
      ccy: client.ccy,
      billRate: draft.billRate,
      unit: client.country === 'IN' ? 'per day' : 'per hour',
      maxSubmissions: draft.maxSubmissions ?? 5,
      positions: draft.positions,
      filled: 0,
      priority: draft.priority,
      receivedOn: ymd(opened),
      closeBy: ymd(addDays(opened, slaDays)),
      /* Nobody is on the desk until somebody is assigned. */
      recruiterId: '',
      source: draft.vms ? 'VMS' : 'Direct',
      vms: draft.vms ?? client.vms,
      status: draft.status ?? 'Draft',
      duration: draft.duration ?? (perm ? 'Permanent' : '12 months'),

      jobType: draft.jobType,
      employmentType: draft.employmentType,
      workMode: draft.workMode,
      workAuth: draft.workAuth ?? '',
      shift: draft.shift ?? 'Day',

      description: draft.description ?? '',
      primaryTech: draft.primaryTech ?? '',
      preferredSkills: draft.preferredSkills ?? [],
      expMin: draft.expMin ?? 0,
      expMax: draft.expMax ?? 0,
      education: draft.education ?? '',
      certifications: draft.certifications ?? [],
      industry: draft.industry ?? client.industry,
      startOn: draft.startOn ?? ymd(addDays(opened, 21)),
      endOn: draft.endOn ?? null,

      payRate: perm ? null : draft.payRate ?? null,
      markupPct: !perm && draft.payRate
        ? Math.round(((draft.billRate - draft.payRate) / draft.payRate) * 1000) / 10
        : null,
      salaryMin: perm ? draft.salaryMin ?? null : null,
      salaryMax: perm ? draft.salaryMax ?? null : null,
      poNumber: draft.poNumber ?? null,
      vendorId: draft.vendorId ?? null,
      accountManagerId: draft.accountManagerId ?? client.ownerId,
      salesOwnerId: draft.salesOwnerId ?? client.ownerId,

      openedOn: ymd(opened),
      /* The three targets derive from the SLA in the same proportions the
         generated book uses, so a new order is comparable with an old one. */
      targetSubmitOn: ymd(addDays(opened, Math.max(2, Math.round(slaDays * 0.18)))),
      targetInterviewOn: ymd(addDays(opened, Math.max(5, Math.round(slaDays * 0.5)))),
      targetFillOn: ymd(addDays(opened, slaDays)),
      slaDays,
    };

    REQUIREMENTS.unshift(r);
    log(r.id, 'created', `Job order created for ${client.name}`, { actorId: r.salesOwnerId });
    return ok(r);
  },

  updateJobOrder(id, patch) {
    const r = orderOf(id);
    if (!r) return missing(id);
    const stop = validate(patch, r);
    if (stop) return Promise.reject(stop);

    const wasStatus = r.status;
    Object.assign(r, patch);

    /* Keep the derived fields derived. */
    if (patch.slaDays !== undefined) {
      const o = parseYmd(r.openedOn);
      r.targetSubmitOn = ymd(addDays(o, Math.max(2, Math.round(r.slaDays * 0.18))));
      r.targetInterviewOn = ymd(addDays(o, Math.max(5, Math.round(r.slaDays * 0.5))));
      r.targetFillOn = ymd(addDays(o, r.slaDays));
      r.closeBy = r.targetFillOn;
      log(id, 'sla_changed', `SLA revised to ${r.slaDays} days`);
    }
    if (patch.payRate !== undefined && patch.payRate !== null) {
      r.markupPct = Math.round(((r.billRate - patch.payRate) / patch.payRate) * 1000) / 10;
    }
    if (patch.status && patch.status !== wasStatus) {
      log(id, 'status_changed', `Status changed from ${wasStatus} to ${patch.status}`);
    }
    return ok(r);
  },

  assign(id, draft) {
    const r = orderOf(id);
    if (!r) return missing(id);
    if (!EMAP[draft.recruiterId]) {
      return Promise.reject(new Error('No such employee: ' + draft.recruiterId));
    }
    if (draft.targetSubmissions != null && draft.targetSubmissions > r.maxSubmissions) {
      return Promise.reject(new Error(
        `${clientOf(r.clientId).name} will only look at ${r.maxSubmissions} profiles on this order`));
    }

    /*
     * One live holder per desk role. Replacing releases the incumbent rather
     * than deleting them — the row is the record that they held it.
     */
    const held = JOB_ASSIGNMENTS.find(
      (a) => a.reqId === id && a.role === draft.role && !a.releasedOn);
    if (held) {
      if (held.recruiterId === draft.recruiterId) {
        /* Same person, new targets. That is an edit, not a reassignment. */
        Object.assign(held, {
          targetSubmissions: draft.targetSubmissions ?? held.targetSubmissions,
          targetInterviews: draft.targetInterviews ?? held.targetInterviews,
          targetHires: draft.targetHires ?? held.targetHires,
          dailySubmissions: draft.dailySubmissions ?? held.dailySubmissions,
          weeklySubmissions: draft.weeklySubmissions ?? held.weeklySubmissions,
          priority: draft.priority ?? held.priority,
          notes: draft.notes ?? held.notes,
        });
        return ok(detail(r));
      }
      held.releasedOn = ymd(TODAY);
      log(id, 'reassigned',
        `${EMAP[held.recruiterId]?.name ?? 'Recruiter'} released as ${draft.role}`);
    }

    const row: JobAssignment = {
      id: nextId('JA'),
      reqId: id,
      recruiterId: draft.recruiterId,
      role: draft.role,
      assignedOn: ymd(TODAY),
      assignedById: '',
      targetSubmissions: draft.targetSubmissions ?? null,
      targetInterviews: draft.targetInterviews ?? null,
      targetHires: draft.targetHires ?? r.positions,
      dailySubmissions: draft.dailySubmissions ?? null,
      weeklySubmissions: draft.weeklySubmissions ?? null,
      priority: draft.priority ?? r.priority,
      notes: draft.notes ?? '',
      releasedOn: null,
    };
    JOB_ASSIGNMENTS.push(row);

    /* The order's named recruiter follows the primary. */
    if (draft.role === 'primary') r.recruiterId = draft.recruiterId;

    log(id, 'assigned',
      `${EMAP[draft.recruiterId]?.name ?? 'Recruiter'} assigned as ${draft.role}`,
      { actorId: draft.recruiterId });
    return ok(detail(r));
  },

  release(id, assignmentId) {
    const r = orderOf(id);
    if (!r) return missing(id);
    const a = JOB_ASSIGNMENTS.find((x) => x.id === assignmentId && x.reqId === id);
    if (!a) return Promise.reject(new Error('No such assignment: ' + assignmentId));
    if (a.releasedOn) return Promise.reject(new Error('That assignment has already ended'));
    if (a.role === 'primary') {
      return Promise.reject(new Error(
        'An order cannot be left without a primary recruiter — assign a replacement instead'));
    }
    a.releasedOn = ymd(TODAY);
    log(id, 'reassigned',
      `${EMAP[a.recruiterId]?.name ?? 'Recruiter'} released as ${a.role}`);
    return ok(detail(r));
  },

  logActivity(id, kind, summary, qty) {
    const r = orderOf(id);
    if (!r) return missing(id);
    if (!(kind in ACTIVITY_META)) {
      return Promise.reject(new Error('No such activity kind: ' + kind));
    }
    if (!summary.trim()) return Promise.reject(new Error('Say what happened'));
    return ok(log(id, kind, summary.trim(), { qty, actorId: r.recruiterId || null }));
  },

  myJobs(recruiterId) {
    const mine = new Set(
      JOB_ASSIGNMENTS.filter((a) => a.recruiterId === recruiterId && !a.releasedOn)
        .map((a) => a.reqId));
    return ok(sortBy(
      REQUIREMENTS.filter((r) => mine.has(r.id)),
      (r) => r.openedOn, 'desc').map(row));
  },

  kpi(f = {}) {
    const rows = selected(f);
    const open = rows.filter((r) => r.status === 'Open');
    const totals = rows.reduce(
      (acc, r) => {
        const c = countsFor(r.id);
        acc.submissions += c.submissions;
        acc.interviews += c.interviews;
        acc.offers += c.offers;
        acc.hires += c.hires;
        return acc;
      },
      { submissions: 0, interviews: 0, offers: 0, hires: 0 },
    );

    const weekOut = ymd(addDays(TODAY, 7));
    const out: RecruitmentKPI = {
      openJobs: open.length,
      assignedJobs: open.filter((r) =>
        JOB_ASSIGNMENTS.some((a) => a.reqId === r.id && a.role === 'primary' && !a.releasedOn)).length,
      ...totals,
      closingSoon: open.filter((r) =>
        r.targetFillOn >= ymd(TODAY) && r.targetFillOn <= weekOut).length,
      aging: open.filter((r) => slaFor(r).state === 'Overdue').length,
    };
    return ok(out);
  },

  funnel(f = {}) {
    const rows = selected(f);
    const ids = new Set(rows.map((r) => r.id));
    const subs = SUBMISSIONS.filter((s) => ids.has(s.reqId));

    /*
     * A submission that reached interview also passed client review, so each
     * stage counts everything that got at least that far. A funnel whose
     * stages count only their current occupants goes up and down, which is not
     * a funnel.
     */
    const order = ['submitted', 'client', 'interview', 'selected', 'placed'];
    const reached = (stage: string) => {
      const i = order.indexOf(stage);
      return subs.filter((s) => {
        const j = order.indexOf(s.stage);
        return j >= i && j >= 0;
      }).length;
    };

    const tally = (kind: ActivityKind) => JOB_ACTIVITY
      .filter((a) => ids.has(a.reqId) && a.kind === kind)
      .reduce((n, a) => n + (a.qty ?? 1), 0);

    const out: RecruitmentFunnel = {
      openRequirements: rows.filter((r) => r.status === 'Open').length,
      sourced: tally('sourced'),
      screened: tally('screened'),
      submitted: subs.length,
      clientReview: reached('client'),
      interview: reached('interview'),
      offer: reached('selected'),
      hired: PLACEMENTS.filter((p) => ids.has(p.reqId)).length,
    };
    return ok(out);
  },
};

/** Statuses a screen may offer. Exported so a form and the service agree. */
export const OPEN_STATUSES: JobStatus[] = ['Draft', 'Open', 'On Hold'];
