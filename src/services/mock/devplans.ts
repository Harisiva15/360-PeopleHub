/**
 * Development plans, in memory.
 *
 * The authorisation here is deliberately not the usual ladder. A development
 * plan is the employee's document — they write it, they own it — and the
 * manager's part is to endorse it and to be held to reviewing it. So an
 * employee has genuine write access to their own plan, which almost nothing
 * else in this product gives them, and a manager cannot rewrite somebody's
 * aspiration on their behalf.
 */

import { sortBy } from '../../lib/collections';
import { uid } from '../../lib/rng';
import { addDays, TODAY, ymd } from '../../lib/dates';
import { ACTIVE, EMAP } from '../../data/employees';
import { COURSES } from '../../data/learning';
import {
  ACTION_KINDS, DEV_ACTIONS, DEV_AREAS, DEV_PLANS, actionProgress, actionsFor,
  devKPI, focusSpread, isActionDone, isEndorsed, isReviewDue, mentorLoad,
  overdueActions, planProgress,
} from '../../data/devplans';
import type { DevAction, DevPlan } from '../../data/devplans';
import { recordAudit } from '../../data/audit';
import { visibleIds } from '../../state/rbac';
import type {
  Caller, DevActionRow, DevPlanDetail, DevPlanDraft,
  DevPlanFilter, DevPlanRow, DevPlanService,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));


const actionRow = (a: DevAction, empId: string): DevActionRow => ({
  action: a,
  progress: actionProgress(a, empId),
  done: isActionDone(a, empId),
  overdue: a.due < ymd(TODAY) && !isActionDone(a, empId),
  /* A course action's figure comes from the enrolment, and the screen says so. */
  fromEnrolment: !!a.courseId,
  courseTitle: a.courseId ? COURSES.find((c) => c.id === a.courseId)?.t ?? null : null,
});

const rowOf = (p: DevPlan): DevPlanRow => ({
  plan: p,
  name: EMAP[p.empId]?.name ?? p.empId,
  dept: EMAP[p.empId]?.dept ?? '',
  designation: EMAP[p.empId]?.designation ?? '',
  managerId: EMAP[p.empId]?.managerId ?? null,
  progress: planProgress(p),
  actions: actionsFor(p.id).length,
  done: actionsFor(p.id).filter((a) => isActionDone(a, p.empId)).length,
  overdue: overdueActions(p).length,
  endorsed: isEndorsed(p),
  reviewDue: isReviewDue(p),
});

/** Whose plans this caller may see. Everybody sees their own. */
function inScope(c: Caller): DevPlan[] {
  if (c.role === 'admin') return DEV_PLANS;
  if (c.role === 'manager') {
    const line = new Set(visibleIds('manager', c.meId));
    return DEV_PLANS.filter((p) => line.has(p.empId) || p.empId === c.meId);
  }
  return DEV_PLANS.filter((p) => p.empId === c.meId);
}

/**
 * Who may change the content of a plan.
 *
 * The person whose plan it is, and an administrator. Not their manager: a
 * manager rewriting somebody's stated aspiration is the failure mode this
 * document has in every company that has ever run one, and the endorsement
 * step below is the manager's actual say.
 */
const mayEdit = (c: Caller, p: DevPlan) => c.role === 'admin' || p.empId === c.meId;

/** Who may endorse it — the manager of record, or an administrator. */
const mayEndorse = (c: Caller, p: DevPlan) =>
  c.role === 'admin'
  || (c.role === 'manager' && visibleIds('manager', c.meId).includes(p.empId));

function matches(r: DevPlanRow, f: DevPlanFilter): boolean {
  if (f.status && r.plan.status !== f.status) return false;
  if (f.dept && r.dept !== f.dept) return false;
  if (f.managerId && r.managerId !== f.managerId) return false;
  if (f.area && !r.plan.focus.includes(f.area)) return false;
  if (f.mentorId && r.plan.mentorId !== f.mentorId) return false;
  if (f.endorsed != null && r.endorsed !== f.endorsed) return false;
  if (f.reviewDue && !r.reviewDue) return false;
  if (f.overdueOnly && !r.overdue) return false;
  if (f.q?.trim()) {
    const hay = `${r.name} ${r.designation} ${r.plan.aspiration}`.toLowerCase();
    if (!hay.includes(f.q.trim().toLowerCase())) return false;
  }
  return true;
}

const validate = (d: Partial<DevPlanDraft>, existing?: DevPlan): string | null => {
  const asp = d.aspiration ?? existing?.aspiration;
  if (!asp?.trim()) return 'Say what you are aiming at';
  const focus = d.focus ?? existing?.focus;
  if (!focus?.length) return 'Choose at least one focus area';
  const unknown = focus.filter((a) => !DEV_AREAS.includes(a));
  if (unknown.length) return `Not a focus area: ${unknown[0]}`;
  const h = d.horizonMonths ?? existing?.horizonMonths;
  if (!h || ![6, 12, 24].includes(h)) return 'Choose a horizon of 6, 12 or 24 months';
  const mentor = d.mentorId ?? existing?.mentorId;
  if (mentor && !EMAP[mentor]) return 'No such mentor';
  if (mentor && mentor === (existing?.empId ?? d.empId)) return 'You cannot mentor yourself';
  return null;
};

export const devPlanService: DevPlanService = {
  list(c, f = {}) {
    const rows = inScope(c).map(rowOf).filter((r) => matches(r, f));
    return ok(sortBy(rows, (r) => r.name));
  },

  get(c, id) {
    const p = DEV_PLANS.find((x) => x.id === id);
    if (!p) return ok(null);
    if (!inScope(c).some((x) => x.id === id)) {
      return refuse('That plan belongs to somebody you cannot see');
    }
    const detail: DevPlanDetail = {
      ...rowOf(p),
      items: actionsFor(p.id).map((a) => actionRow(a, p.empId)),
      history: recordAudit.forSubject('dev_plan', p.id),
    };
    return ok(detail);
  },

  /** The signed-in person's own plan, which is the employee's whole screen. */
  mine(c) {
    const p = DEV_PLANS.find((x) => x.empId === c.meId && x.status !== 'Cancelled');
    if (!p) return ok(null);
    const detail: DevPlanDetail = {
      ...rowOf(p),
      items: actionsFor(p.id).map((a) => actionRow(a, p.empId)),
      history: recordAudit.forSubject('dev_plan', p.id),
    };
    return ok(detail);
  },

  stats(c) {
    return ok(devKPI(inScope(c)));
  },

  focus(c) {
    return ok(focusSpread(inScope(c)));
  },

  mentors(c) {
    if (c.role === 'employee') return refuse('Your role cannot see who is mentoring whom');
    return ok(mentorLoad());
  },

  create(c, draft) {
    /*
     * An employee writes their own plan and nobody else's. A manager raising
     * one on somebody's behalf sounds helpful and produces a document the
     * person has never read.
     */
    const empId = draft.empId ?? c.meId;
    if (empId !== c.meId && c.role !== 'admin') {
      return refuse('A development plan is written by the person it is about');
    }
    if (!EMAP[empId]) return refuse('No such employee');
    if (DEV_PLANS.some((p) => p.empId === empId && p.status !== 'Cancelled')) {
      return refuse('There is already a live plan — complete or cancel it first');
    }
    const bad = validate({ ...draft, empId });
    if (bad) return refuse(bad);

    const from = ymd(TODAY);
    const p: DevPlan = {
      id: uid('IDP'),
      empId,
      aspiration: draft.aspiration.trim(),
      targetLevel: draft.targetLevel ?? null,
      horizonMonths: draft.horizonMonths,
      from,
      to: ymd(addDays(TODAY, draft.horizonMonths * 30)),
      /* New plans start as drafts — endorsement is a separate, visible act. */
      status: 'Draft',
      mentorId: draft.mentorId ?? null,
      focus: draft.focus,
      strengths: draft.strengths?.trim() ?? '',
      createdOn: from,
      reviewOn: draft.reviewOn ?? ymd(addDays(TODAY, 90)),
      endorsedOn: null,
      endorsedById: null,
      notes: draft.notes?.trim() ?? '',
    };
    DEV_PLANS.push(p);
    recordAudit.write(c, 'dev_plan.created', 'dev_plan', p.id,
      `${EMAP[empId]?.name ?? empId} · ${p.aspiration}`);
    return ok(p);
  },

  update(c, id, patch) {
    const p = DEV_PLANS.find((x) => x.id === id);
    if (!p) return refuse('No such plan');
    if (!mayEdit(c, p)) return refuse('Only the person a plan is about can change it');
    if (p.status === 'Completed' || p.status === 'Cancelled') {
      return refuse(`A ${p.status.toLowerCase()} plan cannot be changed`);
    }
    const bad = validate(patch, p);
    if (bad) return refuse(bad);

    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify((patch as Record<string, unknown>)[k])
        !== JSON.stringify((p as unknown as Record<string, unknown>)[k]),
    );
    Object.assign(p, patch);
    if (patch.horizonMonths) p.to = ymd(addDays(p.from, patch.horizonMonths * 30));

    /*
     * Changing what the plan is for withdraws the endorsement. A manager who
     * signed off "move into a lead role" has not signed off whatever replaced
     * it, and carrying the signature across would make endorsement meaningless.
     */
    const material = changed.some((k) => ['aspiration', 'focus', 'targetLevel', 'horizonMonths'].includes(k));
    if (material && p.endorsedOn) {
      p.endorsedOn = null;
      p.endorsedById = null;
      p.status = 'Draft';
      recordAudit.write(c, 'dev_plan.endorsement_withdrawn', 'dev_plan', p.id,
        `${EMAP[p.empId]?.name ?? p.empId} · the plan changed materially`);
    }
    if (changed.length) {
      recordAudit.write(c, 'dev_plan.updated', 'dev_plan', p.id,
        `${EMAP[p.empId]?.name ?? p.empId} · ${changed.join(', ')}`);
    }
    return ok(p);
  },

  endorse(c, id) {
    const p = DEV_PLANS.find((x) => x.id === id);
    if (!p) return refuse('No such plan');
    if (!mayEndorse(c, p)) return refuse('Only their manager can endorse this plan');
    if (p.empId === c.meId) return refuse('You cannot endorse your own plan');
    if (p.status === 'Cancelled') return refuse('That plan was cancelled');
    if (!actionsFor(p.id).length) {
      return refuse('A plan with no actions is an intention — add at least one first');
    }
    p.endorsedOn = ymd(TODAY);
    p.endorsedById = c.meId;
    if (p.status === 'Draft') p.status = 'Active';
    recordAudit.write(c, 'dev_plan.endorsed', 'dev_plan', p.id, EMAP[p.empId]?.name ?? p.empId);
    return ok(p);
  },

  setStatus(c, id, status) {
    const p = DEV_PLANS.find((x) => x.id === id);
    if (!p) return refuse('No such plan');
    if (!mayEdit(c, p)) return refuse('Only the person a plan is about can close it');
    if (status === 'Active' && !isEndorsed(p)) {
      return refuse('A plan becomes active when it is endorsed, not before');
    }
    if (p.status === status) return ok(p);
    const was = p.status;
    p.status = status;
    recordAudit.write(c, 'dev_plan.status', 'dev_plan', p.id, `${was} → ${status}`);
    return ok(p);
  },

  /** Move the next conversation. Either side may, because either may be busy. */
  setReview(c, id, on) {
    const p = DEV_PLANS.find((x) => x.id === id);
    if (!p) return refuse('No such plan');
    if (!mayEdit(c, p) && !mayEndorse(c, p)) {
      return refuse('That plan belongs to somebody you cannot see');
    }
    if (!on) return refuse('Give the review a date');
    p.reviewOn = on;
    recordAudit.write(c, 'dev_plan.review_set', 'dev_plan', p.id, `next review ${on}`);
    return ok(p);
  },

  addAction(c, planId, draft) {
    const p = DEV_PLANS.find((x) => x.id === planId);
    if (!p) return refuse('No such plan');
    if (!mayEdit(c, p)) return refuse('Only the person a plan is about can add to it');
    if (!draft.n?.trim()) return refuse('Say what the action is');
    if (!draft.due) return refuse('Give the action a date');
    if (!ACTION_KINDS.includes(draft.kind)) return refuse('Not a kind of action');
    if (!DEV_AREAS.includes(draft.area)) return refuse('Not a focus area');
    if (draft.courseId && !COURSES.some((x) => x.id === draft.courseId)) {
      return refuse('No such course');
    }
    const a: DevAction = {
      id: uid('IDA'),
      planId,
      kind: draft.kind,
      area: draft.area,
      n: draft.n.trim(),
      courseId: draft.courseId ?? null,
      due: draft.due,
      doneOn: null,
      note: draft.note?.trim() ?? '',
    };
    DEV_ACTIONS.push(a);
    recordAudit.write(c, 'dev_plan.action_added', 'dev_plan', planId,
      `${EMAP[p.empId]?.name ?? p.empId} · ${a.n}`);
    return ok(a);
  },

  setActionDone(c, actionId, done) {
    const a = DEV_ACTIONS.find((x) => x.id === actionId);
    if (!a) return refuse('No such action');
    const p = DEV_PLANS.find((x) => x.id === a.planId);
    if (!p) return refuse('No such plan');
    if (!mayEdit(c, p)) return refuse('Only the person a plan is about can tick this off');
    /*
     * The one thing this module will not let you do. A course action's state
     * lives in the enrolment, and ticking it here would put two screens into
     * disagreement about the same course — which is exactly the shape of bug
     * reading the enrolment was meant to make impossible.
     */
    if (a.courseId) {
      return refuse('This tracks a course — complete it in Learning and it updates here');
    }
    a.doneOn = done ? ymd(TODAY) : null;
    recordAudit.write(c, done ? 'dev_plan.action_done' : 'dev_plan.action_reopened',
      'dev_plan', a.planId, `${EMAP[p.empId]?.name ?? p.empId} · ${a.n}`);
    return ok(a);
  },

  removeAction(c, actionId) {
    const i = DEV_ACTIONS.findIndex((x) => x.id === actionId);
    if (i < 0) return refuse('No such action');
    const a = DEV_ACTIONS[i];
    const p = DEV_PLANS.find((x) => x.id === a.planId);
    if (!p || !mayEdit(c, p)) return refuse('Only the person a plan is about can remove this');
    DEV_ACTIONS.splice(i, 1);
    recordAudit.write(c, 'dev_plan.action_removed', 'dev_plan', a.planId,
      `${EMAP[p.empId]?.name ?? p.empId} · ${a.n}`);
    return ok(a);
  },

  /** Who is available to mentor, with how many people they already carry. */
  mentorOptions(c) {
    const load = new Map(mentorLoad().map((m) => [m.mentorId, m.mentees]));
    return ok(sortBy(
      ACTIVE()
        .filter((e) => /Manager|Head|Lead|Director|Chief|VP/i.test(e.designation) && e.id !== c.meId)
        .map((e) => ({ id: e.id, name: e.name, designation: e.designation, mentees: load.get(e.id) ?? 0 })),
      (m) => m.name,
    ));
  },
};
