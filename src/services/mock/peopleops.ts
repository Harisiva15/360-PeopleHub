/**
 * People-operations reads: performance, learning, helpdesk, engagement and
 * flexible benefits.
 *
 * These are grouped because every one of them is a read surface the reporting
 * and dashboard screens pull from; splitting them across five files would be
 * filing rather than design.
 */

import { CUR_CYCLE, GOALS, PRAISE, REVIEWS } from '../../data/performance';
import { COURSES, ENROLL } from '../../data/learning';
import { TICKETS } from '../../data/helpdesk';
import { enpsOf, ENPS_HISTORY, SURVEYS } from '../../data/engagement';
import { ANNOUNCE, celebrations } from '../../data/announcements';
import { EXITS } from '../../data/exit';
import { fbpTotal } from '../../data/benefits';
import type {
  BenefitsService, EngagementService, ExitService, HelpdeskService, LearningService,
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
};

export const learningService: LearningService = {
  courses() { return ok(COURSES.slice()); },
  enrolments(empIds) { return ok(scoped(ENROLL, empIds)); },
};

export const helpdeskService: HelpdeskService = {
  tickets(empIds) { return ok(scoped(TICKETS, empIds)); },
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

export const exitService: ExitService = {
  list() { return ok(EXITS.slice()); },
};
