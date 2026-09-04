/**
 * People-operations reads: performance, learning, helpdesk, engagement and
 * flexible benefits.
 *
 * These are grouped because every one of them is a read surface the reporting
 * and dashboard screens pull from; splitting them across five files would be
 * filing rather than design.
 */

import { CHECKINS, CUR_CYCLE, GOALS, PRAISE, REVIEWS } from '../../data/performance';
import { COURSES, ENROLL } from '../../data/learning';
import { KB, TICKETS } from '../../data/helpdesk';
import { TODAY, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { enpsOf, ENPS_HISTORY, SURVEYS } from '../../data/engagement';
import { ANNOUNCE, celebrations } from '../../data/announcements';
import { fbpTotal } from '../../data/benefits';
import type {
  BenefitsService, EngagementService, HelpdeskService, LearningService,
  NoticeboardService, PerformanceService,
} from '../contracts';
import { ok } from './util';

/** Narrow a collection to a set of employees, or return it whole. */
const scoped = <T extends { empId: string }>(rows: readonly T[], empIds?: string[]): T[] => {
  if (!empIds) return rows.slice();
  const want = new Set(empIds);
  return rows.filter((r) => want.has(r.empId));
};

export const performanceService: PerformanceService = {
  goals(empIds) { return ok(scoped(GOALS, empIds)); },
  reviews(empIds) { return ok(scoped(REVIEWS, empIds)); },
  praise() { return ok(PRAISE.slice()); },
  currentCycle() { return ok(CUR_CYCLE); },
  checkins(empIds) { return ok(scoped(CHECKINS, empIds)); },

  setGoalProgress(goalId, progress) {
    const g = GOALS.find((x) => x.id === goalId);
    if (!g) return Promise.reject(new Error('No such goal: ' + goalId));
    if (progress < 0 || progress > 100) return Promise.reject(new Error('Progress runs from 0 to 100'));
    g.progress = progress;
    g.status = progress >= 100 ? 'Achieved' : progress >= 60 ? 'On Track' : progress >= 35 ? 'At Risk' : 'Behind';
    /* The mid and final key results mirror the same thresholds. */
    if (g.keyResults[1]) g.keyResults[1].done = progress >= 50;
    if (g.keyResults[2]) g.keyResults[2].done = progress >= 100;
    return ok(g);
  },
};

export const learningService: LearningService = {
  courses() { return ok(COURSES.slice()); },
  enrolments(empIds) { return ok(scoped(ENROLL, empIds)); },

  enrol(empId, courseId) {
    const existing = ENROLL.find((x) => x.empId === empId && x.courseId === courseId);
    if (existing) return Promise.reject(new Error('Already enrolled in that course'));
    const row = { empId, courseId, progress: 0, status: 'Not Started' as const, completedOn: null, score: null };
    ENROLL.push(row);
    return ok(row);
  },

  setProgress(empId, courseId, progress) {
    const en = ENROLL.find((x) => x.empId === empId && x.courseId === courseId);
    if (!en) return Promise.reject(new Error('Not enrolled in that course'));
    const p = Math.max(0, Math.min(100, progress));
    en.progress = p;
    en.status = p === 100 ? 'Completed' : p > 0 ? 'In Progress' : 'Not Started';
    en.completedOn = p === 100 ? ymd(TODAY) : null;
    return ok(en);
  },
};

export const helpdeskService: HelpdeskService = {
  tickets(empIds) { return ok(scoped(TICKETS, empIds)); },
  knowledgeBase() { return ok(KB.slice()); },

  raise(t) {
    const row = {
      id: uid('TK'),
      empId: t.empId,
      cat: t.cat,
      subject: t.subject,
      desc: t.desc,
      priority: t.priority,
      status: 'Open' as const,
      createdOn: ymd(TODAY),
      createdTime: '09:00',
      dueOn: ymd(TODAY),
      slaHours: 24,
      assigneeId: '',
      resolvedOn: null,
      resolutionHrs: null,
      breached: false,
      csat: null,
      comments: [],
    };
    TICKETS.unshift(row);
    return ok(row);
  },

  comment(id, by, text) {
    const t = TICKETS.find((x) => x.id === id);
    if (!t) return Promise.reject(new Error('No such ticket: ' + id));
    t.comments.push({ by, on: ymd(TODAY), text });
    /* The first reply is what starts the clock moving. */
    if (t.status === 'Open') t.status = 'In Progress';
    return ok(t);
  },

  resolve(id, csat) {
    const t = TICKETS.find((x) => x.id === id);
    if (!t) return Promise.reject(new Error('No such ticket: ' + id));
    if (t.status === 'Resolved' || t.status === 'Closed') return Promise.reject(new Error('Already ' + t.status.toLowerCase()));
    t.status = 'Resolved';
    t.resolvedOn = ymd(TODAY);
    if (csat != null) t.csat = csat;
    return ok(t);
  },
};

export const engagementService: EngagementService = {
  surveys() { return ok(SURVEYS.slice()); },
  enpsOf(surveyId) {
    const sv = SURVEYS.find((x) => x.id === surveyId);
    return sv ? ok(enpsOf(sv)) : Promise.reject(new Error('No such survey: ' + surveyId));
  },
  enpsHistory() { return ok(ENPS_HISTORY.slice()); },
};

export const benefitsService: BenefitsService = {
  fbpTotals(empIds) {
    const out: Record<string, number> = {};
    empIds.forEach((id) => { out[id] = fbpTotal(id); });
    return ok(out);
  },
};

export const noticeboardService: NoticeboardService = {
  announcements() { return ok(ANNOUNCE.slice()); },
  celebrations(days) { return ok(celebrations(days)); },
};
