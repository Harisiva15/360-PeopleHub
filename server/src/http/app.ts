/**
 * HTTP layer.
 *
 * Deliberately built on node:http with no framework. This is a skeleton: the
 * routing here is a placeholder that a real service would replace with Fastify
 * or Hono. What is *not* a placeholder is the shape — every handler receives a
 * Caller resolved from the session and nothing else, so no route can be
 * written that takes a tenant id from the request.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { callerFromToken, AuthError } from '../auth/session.ts';
import { applyCors } from './cors.ts';
import { ANON, AUTHED, hit, keyFor } from './rate-limit.ts';
import type { Caller } from '../tenancy/context.ts';
import { TenantContextError } from '../tenancy/context.ts';
import { LeaveError } from '../modules/leave/service.ts';
import {
  getEmployee, getEmployeeProfile, getEmployeesByIds, getTeam,
  listActiveEmployees, listExitedEmployees, listVisibleEmployees, setEmployeeRole,
  EmployeeError,
} from '../modules/employees/service.ts';
import {
  applyForLeave, approveLeave, balanceFor, balancesFor, balancesForMany,
  cancelLeave, listLeave, rejectLeave,
} from '../modules/leave/service.ts';
import {
  addHoliday, ConfigError, listHolidays, listSites, setLeaveQuota, updateFence,
} from '../modules/config/service.ts';
import {
  approveJoiner, JoinerError, listJoiners, rejectJoiner, requestJoiner,
} from '../modules/joiners/service.ts';
import {
  acknowledgeLocationNotice, actOnRegularisation, AttendanceError, attendanceForDay,
  listAttendance, locationNotice, punchIn, punchOut, raiseRegularisation,
  regularisableDays,
} from '../modules/attendance/service.ts';
import {
  actOnTimesheet, addEntry, copyPreviousWeek, listTimesheets, recallTimesheet,
  removeEntry, setComment, submitTimesheet, TimesheetError, timesheetForWeek,
  updateEntry,
} from '../modules/timesheet/service.ts';
import {
  listAnnouncements, listCelebrations, NoticeboardError, postAnnouncement,
  removeAnnouncement, setPinned,
} from '../modules/noticeboard/service.ts';
import {
  actOnRequest, addAsset, allocate, AssetError, assetKpi, listAssets, listMovements,
  listOpenRequests, listRequests, markReturned, pendingRecovery, requestAsset,
} from '../modules/assets/service.ts';
import { ProvisionError } from '../modules/people/provision.ts';
import {
  boardStats, commentOnItem, createItem, createIteration, listItems,
  listIterations, moveItem, myItems, PlannerError, updateItem,
} from '../modules/planner/service.ts';
import {
  ExitError, exitDetail, listExits, raiseExit, recordExitInterview, setClearance,
  settleExit,
} from '../modules/exits/service.ts';
import {
  approveAdvance, approveClaim, ExpenseError, listAdvances, listClaims,
  reimburseClaim, rejectClaim, requestAdvance, submitClaim,
} from '../modules/expenses/service.ts';
import {
  comment, HelpdeskError, knowledgeBase, listTickets, raiseTicket, resolveTicket,
} from '../modules/helpdesk/service.ts';
import {
  addGoal, calibrateReview, currentCycle, givePraise, listCheckins, listGoals,
  listPraise, listReviews, logCheckin, PerformanceError, setGoalProgress,
  submitManagerReview, submitSelfReview,
} from '../modules/performance/service.ts';
import {
  activeLoans, bankBatches, compensation, compliancePayments, currentRun, dailyRates,
  inputsFor, listRuns, PayrollError, payslipFor, payslipHistory, processRun, register,
  salaryStructureOf, totals, totalsFor,
} from '../modules/payroll/service.ts';
import {
  completeOnboarding, createJourney, listOnboarding, OnboardingError, setTask,
} from '../modules/onboarding/service.ts';
import {
  HiringError, interviewsFor, listCandidates, listInterviews, listRequisitions,
  makeOffer, moveCandidate, offerLetter, openRequisition, recruiterTracker,
  releaseOffer, requisitionTracker, respondToOffer, scheduleInterview, submitCandidate,
  submitFeedback,
} from '../modules/hiring/service.ts';
import {
  collectionSummary, DocumentError, listRequests as listDocRequests, requestDocument,
  requestJoinerDocuments, setRequestStatus,
  listDocuments, documentTypes,
} from '../modules/documents/service.ts';
import {
  actOnOvertime, listOvertime, listShifts, raiseOvertime, rosterFor,
  setEmployeeShift, ShiftError, shiftCoverage,
} from '../modules/shifts/service.ts';
import {
  issueLetter, LetterError, listLetterRequests, listLetterTypes, rejectLetter,
  requestLetter,
} from '../modules/letters/service.ts';
import {
  allDeclarations, declarationFor, saveDeclaration, setRegime, submitProofs,
  TaxError, taxRows, taxSummary, verifyDeclaration,
} from '../modules/tax/service.ts';
import {
  audit, auditCategories, controls, retention, SecurityError,
} from '../modules/security/service.ts';
import {
  datasets as exportDatasets, history as exportHistory, run as runExport,
  stats as exportStats, ExportError,
} from '../modules/exports/service.ts';
import {
  listJobTitles, getJobTitle, mineJobTitle, createJobTitle,
  updateJobTitle, setJobTitleStatus, removeJobTitle, JobTitleError,
} from '../modules/jobtitles/service.ts';
import {
  listLifecycle, getLifecycle, lifecycleStats, addLifecycleTask,
  setLifecycleTaskDone, removeLifecycleTask, LifecycleError,
} from '../modules/lifecycle/service.ts';
import {
  listSoftware, getSoftware, mySoftware, softwareStats, softwareRenewals,
  createSoftware, updateSoftware, removeSoftware, assignSeat, revokeSeat, SoftwareError,
} from '../modules/software/service.ts';
import {
  listDevPlans, getDevPlan, myDevPlan, devPlanStats, devFocus, mentorLoad,
  mentorOptions, createDevPlan, updateDevPlan, endorseDevPlan, setDevPlanStatus,
  setDevPlanReview, addDevAction, setDevActionDone, removeDevAction, DevPlanError,
} from '../modules/devplans/service.ts';
import {
  listEvents, getEvent, myEvents, eventStats, createEvent, updateEvent,
  publishEvent, cancelEvent, removeEvent, rsvp, withdrawRsvp, markAttendance, EventError,
} from '../modules/events/service.ts';
import {
  listReports, reportDatasets, runReport, createReport,
  updateReport, removeReport, duplicateReport, ReportError,
} from '../modules/reports/service.ts';
import {
  listIntegrations, integrationStats, listWebhooks, createWebhook,
  setWebhookActive, removeWebhook, listApiKeys, apiScopes, createApiKey,
  revokeApiKey, IntegrationError,
} from '../modules/integrations/service.ts';
import {
  jobOrders, jobOrder, myJobs, createJobOrder, updateJobOrder, assign, release,
  logActivity, kpi as recruitmentKpi, funnel as recruitmentFunnel,
  unassignedJobs, recruiterPerformance, jobAging, RecruitmentError,
} from '../modules/recruitment/service.ts';
import {
  listUsers, getUser, userStats, nextEmployeeCode, createUser, updateUser,
  setUserStatus, removeUser, decideUser, resendInvitation, resetPassword,
  bulkUpdateUsers, lastLoginNow, accountObligations, passwordChanged,
  setMfaRequired, UserError,
} from '../modules/users/service.ts';
import {
  previewImport, commitImport, importHistory,
} from '../modules/users/import.ts';
import {
  agentFrom, recordLoginEvent, listLoginHistory, listTenantLoginHistory,
} from '../modules/users/loginHistory.ts';
import {
  effectiveModulesFor, effectiveRule, ROLE_SUMMARY,
} from '../auth/policy.ts';
import { overridesFor } from '../auth/overrides.ts';
import { moduleForPath } from './route-modules.ts';
import {
  permissionGrid, setPermissions, resetModule, PermissionError,
} from '../modules/config/permissions.ts';
import { navBadges, pending, pendingCount } from '../modules/approvals/service.ts';
import { approveLoan, listLoans, LoanError } from '../modules/loans/service.ts';
import {
  courses, enrol, enrolments, LearningError, setProgress,
} from '../modules/learning/service.ts';
import {
  EngagementError, enpsHistory, enpsOf, surveys,
} from '../modules/engagement/service.ts';
import {
  BenefitsError, declareFbp, fbpPlan, fbpRows, fbpTotals, insuranceCover,
} from '../modules/benefits/service.ts';
import {
  bench, benchStanding, clients, consultants, invoices, kpi, matchesForConsultant,
  matchesForRequirement, moveSubmission, openRequirements, placements, rateCards,
  redeploymentPlan, requirements, sows, StaffingError, submissions, vendors,
} from '../modules/staffing/service.ts';

type Handler = (
  caller: Caller,
  req: IncomingMessage,
  params: Record<string, string>,
  body: unknown,
) => Promise<unknown>;

/**
 * Where a request came from, for the sign-in history.
 *
 * The trust rule for `x-forwarded-for` lives in agentFrom and is shared with
 * the rate limiter, so there is one answer to whether the hop in front of us
 * is ours rather than two that can drift apart.
 */
const agentOf = (req: IncomingMessage) => agentFrom(
  req.socket.remoteAddress,
  req.headers['x-forwarded-for'] as string | undefined,
  req.headers['user-agent'],
);

interface Route {
  method: string;
  /** Path pattern with :name segments, e.g. /employees/:id/profile. */
  pattern: string;
  handler: Handler;
}

/**
 * The routes wired so far. The remaining endpoints in docs/api-contract.md
 * follow the same shape; these two modules are the pattern to copy.
 *
 * **Order matters.** Matching stops at the first hit, so a literal segment has
 * to precede the parameter that would also match it — `/employees/active`
 * before `/employees/:id`, or "active" is read as an employee id and every
 * request 404s with a confusing message. A router with proper specificity
 * ranking removes this hazard; until then, keep literals above parameters.
 */
const routes: Route[] = [
  {
    method: 'GET',
    pattern: '/employees',
    handler: (caller) => listVisibleEmployees(caller),
  },
  {
    method: 'GET',
    pattern: '/employees/active',
    handler: (caller) => listActiveEmployees(caller),
  },
  {
    method: 'GET',
    pattern: '/employees/exited',
    handler: (caller) => listExitedEmployees(caller),
  },
  {
    // ?ids=a,b,c — a POST would be tidier for a long list, but this is a read
    // and should stay cacheable and idempotent.
    method: 'GET',
    pattern: '/employees/by-ids',
    handler: (caller, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('ids');
      return getEmployeesByIds(caller, ids ? ids.split(',').filter(Boolean) : []);
    },
  },
  {
    method: 'GET',
    pattern: '/employees/:id/team',
    handler: (caller, req, params) => {
      const deep = new URL(req.url ?? '/', 'http://x').searchParams.get('deep') === 'true';
      return getTeam(caller, params.id!, deep);
    },
  },
  {
    method: 'PUT',
    pattern: '/employees/:id/role',
    handler: (caller, _req, params, body) =>
      setEmployeeRole(caller, params.id!, (body as { role: 'admin' | 'manager' | 'employee' }).role),
  },
  {
    method: 'GET',
    pattern: '/employees/:id',
    handler: async (caller, _req, params) => {
      const one = await getEmployee(caller, params.id!);
      if (!one) throw new NotFound('no such employee');
      return one;
    },
  },
  {
    method: 'GET',
    pattern: '/employees/:id/profile',
    handler: async (caller, _req, params) => {
      const profile = await getEmployeeProfile(caller, params.id!);
      if (!profile) throw new NotFound('no such employee');
      return profile;
    },
  },
  {
    method: 'GET',
    pattern: '/attendance',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = p.get('empIds');
      return listAttendance(c, {
        ...(ids ? { empIds: ids.split(',').filter(Boolean) } : {}),
        ...(p.get('from') ? { from: p.get('from')! } : {}),
        ...(p.get('to') ? { to: p.get('to')! } : {}),
        ...(p.get('regularisedOnly') === 'true' ? { regularisedOnly: true } : {}),
      });
    },
  },
  {
    /* Literal before the parameter, or 'location-notice' reads as an empId. */
    method: 'GET',
    pattern: '/attendance/location-notice',
    handler: (c) => locationNotice(c),
  },
  {
    method: 'POST',
    pattern: '/attendance/location-notice',
    handler: (c) => acknowledgeLocationNotice(c),
  },
  {
    method: 'GET',
    pattern: '/attendance/:empId/regularisable',
    handler: (c, req, p) => {
      const since = new URL(req.url ?? '/', 'http://x').searchParams.get('since');
      return regularisableDays(c, p.empId!, since ?? '1970-01-01');
    },
  },
  {
    method: 'GET',
    pattern: '/attendance/:empId/:date',
    handler: (c, _r, p) => attendanceForDay(c, p.empId!, p.date!),
  },
  {
    method: 'POST',
    pattern: '/attendance/:empId/:date/punch-in',
    handler: (c, _r, p, body) => punchIn(c, p.empId!, p.date!, (body ?? {}) as never),
  },
  {
    method: 'POST',
    pattern: '/attendance/:empId/:date/punch-out',
    handler: (c, _r, p, body) => punchOut(c, p.empId!, p.date!, (body ?? {}) as never),
  },
  {
    method: 'POST',
    pattern: '/attendance/:empId/:date/regularise',
    handler: (c, _r, p, body) => {
      const b = body as { inT: string; outT: string; reason: string };
      return raiseRegularisation(c, p.empId!, p.date!, b.inT, b.outT, b.reason);
    },
  },
  {
    method: 'PUT',
    pattern: '/attendance/:empId/:date/regularise',
    handler: (c, _r, p, body) =>
      actOnRegularisation(c, p.empId!, p.date!,
        (body as { decision: 'Approved' | 'Rejected' }).decision),
  },
  { method: 'GET', pattern: '/payroll/runs', handler: (c) => listRuns(c) },
  { method: 'GET', pattern: '/payroll/runs/current', handler: (c) => currentRun(c) },
  { method: 'GET', pattern: '/payroll/compensation', handler: (c) => compensation(c) },
  { method: 'GET', pattern: '/payroll/bank-batches', handler: (c) => bankBatches(c) },
  { method: 'GET', pattern: '/payroll/compliance', handler: (c) => compliancePayments(c) },
  { method: 'GET', pattern: '/payroll/loans', handler: (c) => activeLoans(c) },
  {
    method: 'GET',
    pattern: '/payroll/daily-rates',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return dailyRates(c, ids ? ids.split(',').filter(Boolean) : []);
    },
  },
  {
    method: 'GET',
    pattern: '/payroll/totals',
    handler: (c, req) => {
      const mks = new URL(req.url ?? '/', 'http://x').searchParams.get('mks');
      return totalsFor(c, mks ? mks.split(',').filter(Boolean) : []);
    },
  },
  { method: 'GET', pattern: '/payroll/:mk/totals', handler: (c, _r, p) => totals(c, p.mk!) },
  { method: 'GET', pattern: '/payroll/:mk/register', handler: (c, _r, p) => register(c, p.mk!) },
  { method: 'GET', pattern: '/payroll/:mk/inputs', handler: (c, _r, p) => inputsFor(c, p.mk!) },
  {
    method: 'POST',
    pattern: '/payroll/:mk/process',
    handler: (c, _r, p) => processRun(c, p.mk!),
  },
  {
    method: 'GET',
    pattern: '/payroll/structure/:empId',
    handler: (c, _r, p) => salaryStructureOf(c, p.empId!),
  },
  {
    method: 'GET',
    pattern: '/payroll/payslips/:empId',
    handler: (c, _r, p) => payslipHistory(c, p.empId!),
  },
  {
    method: 'GET',
    pattern: '/payroll/payslips/:empId/:mk',
    handler: (c, _r, p) => payslipFor(c, p.empId!, p.mk!),
  },
  {
    method: 'GET',
    pattern: '/planner/items',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      return listItems(c, {
        ...(p.get('projectId') ? { projectId: p.get('projectId')! } : {}),
        ...(p.get('iterationId') ? { iterationId: p.get('iterationId')! } : {}),
        ...(p.get('assigneeId') ? { assigneeId: p.get('assigneeId')! } : {}),
        ...(p.get('kind') ? { kind: p.get('kind')! } : {}),
        ...(p.get('openOnly') === 'true' ? { openOnly: true } : {}),
      });
    },
  },
  {
    method: 'POST',
    pattern: '/planner/items',
    handler: (c, _r, _p, body) => createItem(c, (body ?? {}) as Parameters<typeof createItem>[1]),
  },
  {
    method: 'GET',
    pattern: '/planner/mine',
    handler: (c, req) => {
      const who = new URL(req.url ?? '/', 'http://x').searchParams.get('empId');
      return myItems(c, who ?? undefined);
    },
  },
  {
    method: 'GET',
    pattern: '/planner/board',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams.get('projectId');
      return boardStats(c, p ?? undefined);
    },
  },
  { method: 'GET', pattern: '/planner/iterations', handler: (c) => listIterations(c) },
  {
    method: 'POST',
    pattern: '/planner/iterations',
    handler: (c, _r, _p, body) =>
      createIteration(c, (body ?? {}) as Parameters<typeof createIteration>[1]),
  },
  {
    method: 'PUT',
    pattern: '/planner/items/:id/move',
    handler: (c, _r, p, body) => {
      const b = (body ?? {}) as { status: string; afterId?: string | null };
      return moveItem(c, p.id!, b.status, b.afterId ?? null);
    },
  },
  {
    method: 'PUT',
    pattern: '/planner/items/:id',
    handler: (c, _r, p, body) => updateItem(c, p.id!, (body ?? {}) as Parameters<typeof updateItem>[2]),
  },
  {
    method: 'POST',
    pattern: '/planner/items/:id/comments',
    handler: (c, _r, p, body) => commentOnItem(c, p.id!, (body as { text: string }).text),
  },
  { method: 'GET', pattern: '/exits', handler: (c) => listExits(c) },
  {
    method: 'POST',
    pattern: '/exits',
    handler: (c, _r, _p, body) => raiseExit(c, (body ?? {}) as Parameters<typeof raiseExit>[1]),
  },
  { method: 'GET', pattern: '/exits/:id', handler: (c, _r, p) => exitDetail(c, p.id!) },
  {
    method: 'PUT',
    pattern: '/exits/:id/clearance/:department',
    handler: (c, _r, p, body) =>
      setClearance(c, p.id!, p.department!, Boolean((body as { done?: boolean } | undefined)?.done)),
  },
  { method: 'POST', pattern: '/exits/:id/settle', handler: (c, _r, p) => settleExit(c, p.id!) },
  {
    method: 'POST',
    pattern: '/exits/:id/interview',
    handler: (c, _r, p, body) =>
      recordExitInterview(c, p.id!, (body ?? {}) as Parameters<typeof recordExitInterview>[2]),
  },
  { method: 'GET', pattern: '/performance/cycle', handler: (c) => currentCycle(c) },
  { method: 'GET', pattern: '/performance/praise', handler: (c) => listPraise(c) },
  {
    method: 'POST',
    pattern: '/performance/praise',
    handler: (c, _r, _p, body) => {
      const b = (body ?? {}) as { toId: string; value?: string; text: string };
      return givePraise(c, b.toId, b.value ?? '', b.text);
    },
  },
  {
    method: 'GET',
    pattern: '/performance/goals',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return listGoals(c, ids ? ids.split(',').filter(Boolean) : undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/performance/goals',
    handler: (c, _r, _p, body) => addGoal(c, (body ?? {}) as Parameters<typeof addGoal>[1]),
  },
  {
    method: 'PUT',
    pattern: '/performance/goals/:id/progress',
    handler: (c, _r, p, body) =>
      setGoalProgress(c, p.id!, Number((body as { progress: number }).progress)),
  },
  {
    method: 'GET',
    pattern: '/performance/checkins',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return listCheckins(c, ids ? ids.split(',').filter(Boolean) : undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/performance/checkins',
    handler: (c, _r, _p, body) => logCheckin(c, (body ?? {}) as Parameters<typeof logCheckin>[1]),
  },
  {
    method: 'GET',
    pattern: '/performance/reviews',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return listReviews(c, ids ? ids.split(',').filter(Boolean) : undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/performance/reviews/self',
    handler: (c, _r, _p, body) => {
      const b = (body ?? {}) as { rating: number; comments?: string };
      return submitSelfReview(c, Number(b.rating), b.comments ?? '');
    },
  },
  {
    method: 'POST',
    pattern: '/performance/reviews/:empId/manager',
    handler: (c, _r, p, body) => {
      const b = (body ?? {}) as { rating: number; comments?: string };
      return submitManagerReview(c, p.empId!, Number(b.rating), b.comments ?? '');
    },
  },
  {
    method: 'POST',
    pattern: '/performance/reviews/:empId/calibrate',
    handler: (c, _r, p, body) =>
      calibrateReview(c, p.empId!, (body ?? {}) as Parameters<typeof calibrateReview>[2]),
  },
  { method: 'GET', pattern: '/helpdesk/kb', handler: (c) => knowledgeBase(c) },
  {
    method: 'GET',
    pattern: '/helpdesk/tickets',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return listTickets(c, ids ? ids.split(',').filter(Boolean) : undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/helpdesk/tickets',
    handler: (c, _r, _p, body) => raiseTicket(c, (body ?? {}) as Parameters<typeof raiseTicket>[1]),
  },
  {
    method: 'POST',
    pattern: '/helpdesk/tickets/:id/comments',
    handler: (c, _r, p, body) => {
      const b = (body ?? {}) as { text: string; internal?: boolean };
      return comment(c, p.id!, b.text, Boolean(b.internal));
    },
  },
  {
    method: 'POST',
    pattern: '/helpdesk/tickets/:id/resolve',
    handler: (c, _r, p, body) => {
      const b = (body ?? {}) as { csat?: number };
      return resolveTicket(c, p.id!, b.csat === undefined ? undefined : Number(b.csat));
    },
  },
  {
    method: 'GET',
    pattern: '/expenses/claims',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = p.get('empIds');
      return listClaims(c, {
        ...(ids ? { empIds: ids.split(',').filter(Boolean) } : {}),
        ...(p.get('status') ? { status: p.get('status')! } : {}),
      });
    },
  },
  {
    method: 'POST',
    pattern: '/expenses/claims',
    handler: (c, _r, _p, body) => submitClaim(c, (body ?? {}) as Parameters<typeof submitClaim>[1]),
  },
  {
    method: 'POST',
    pattern: '/expenses/claims/:id/approve',
    handler: (c, _r, p) => approveClaim(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/expenses/claims/:id/reject',
    handler: (c, _r, p, body) =>
      rejectClaim(c, p.id!, (body as { note?: string } | undefined)?.note ?? ''),
  },
  {
    method: 'POST',
    pattern: '/expenses/claims/:id/reimburse',
    handler: (c, _r, p) => reimburseClaim(c, p.id!),
  },
  {
    method: 'GET',
    pattern: '/expenses/advances',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return listAdvances(c, ids ? ids.split(',').filter(Boolean) : undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/expenses/advances',
    handler: (c, _r, _p, body) => {
      const b = (body ?? {}) as { empId?: string; amount: number; reason: string };
      return requestAdvance(c, b.empId ?? '', Number(b.amount), b.reason);
    },
  },
  {
    method: 'POST',
    pattern: '/expenses/advances/:id/approve',
    handler: (c, _r, p) => approveAdvance(c, p.id!),
  },
  { method: 'GET', pattern: '/onboarding', handler: (c) => listOnboarding(c) },
  {
    method: 'POST',
    pattern: '/onboarding',
    handler: (c, _r, _p, body) =>
      createJourney(c, (body ?? {}) as Parameters<typeof createJourney>[1]),
  },
  {
    method: 'PUT',
    pattern: '/onboarding/:id/tasks/:key',
    handler: (c, _r, p, body) =>
      setTask(c, p.id!, p.key!, Boolean((body as { done?: boolean } | undefined)?.done)),
  },
  {
    method: 'POST',
    pattern: '/onboarding/:id/complete',
    handler: (c, _r, p) => completeOnboarding(c, p.id!),
  },
  { method: 'GET', pattern: '/requisitions', handler: (c) => listRequisitions(c) },
  {
    method: 'POST',
    pattern: '/requisitions',
    handler: (c, _r, _p, body) =>
      openRequisition(c, (body ?? {}) as Parameters<typeof openRequisition>[1]),
  },
  { method: 'GET', pattern: '/candidates', handler: (c) => listCandidates(c) },
  {
    method: 'POST',
    pattern: '/candidates',
    handler: (c, _r, _p, body) =>
      submitCandidate(c, (body ?? {}) as Parameters<typeof submitCandidate>[1]),
  },
  {
    method: 'PUT',
    pattern: '/candidates/:id/stage',
    handler: (c, _r, p, body) => moveCandidate(c, p.id!, (body as { stage: string }).stage),
  },
  { method: 'GET', pattern: '/interviews', handler: (c) => listInterviews(c) },
  {
    method: 'POST',
    pattern: '/interviews',
    handler: (c, _r, _p, body) =>
      scheduleInterview(c, (body ?? {}) as Parameters<typeof scheduleInterview>[1]),
  },
  {
    method: 'POST',
    pattern: '/interviews/:id/feedback',
    handler: (c, _r, p, body) => {
      const b = (body ?? {}) as { verdict: string; feedback?: string };
      return submitFeedback(c, p.id!, b.verdict, b.feedback ?? '');
    },
  },
  {
    method: 'POST',
    pattern: '/offers',
    handler: (c, _r, _p, body) => makeOffer(c, (body ?? {}) as Parameters<typeof makeOffer>[1]),
  },
  {
    method: 'GET',
    pattern: '/offers/:candId/letter',
    handler: async (c, _r, p) => ({ body: await offerLetter(c, p.candId!) }),
  },
  {
    method: 'POST',
    pattern: '/offers/:candId/release',
    handler: (c, _r, p) => releaseOffer(c, p.candId!),
  },
  {
    method: 'GET',
    pattern: '/documents/requests',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      return listDocRequests(c, {
        ...(p.get('journeyId') ? { journeyId: p.get('journeyId')! } : {}),
        ...(p.get('empId') ? { empId: p.get('empId')! } : {}),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/documents/summary',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      return collectionSummary(c, {
        ...(p.get('journeyId') ? { journeyId: p.get('journeyId')! } : {}),
        ...(p.get('empId') ? { empId: p.get('empId')! } : {}),
      });
    },
  },
  {
    method: 'POST',
    pattern: '/documents/requests',
    handler: (c, _r, _p, body) =>
      requestDocument(c, (body ?? {}) as Parameters<typeof requestDocument>[1]),
  },
  {
    method: 'POST',
    pattern: '/documents/journeys/:journeyId/checklist',
    handler: (c, _r, p, body) =>
      requestJoinerDocuments(c, p.journeyId!, (body as { due?: string } | undefined)?.due),
  },
  {
    method: 'PUT',
    pattern: '/documents/requests/:id',
    handler: (c, _r, p, body) => {
      const b = (body ?? {}) as { status: string; note?: string };
      return setRequestStatus(c, p.id!, b.status, b.note);
    },
  },
  {
    method: 'POST',
    pattern: '/offers/:candId/respond',
    handler: (c, _r, p, body) =>
      respondToOffer(c, p.candId!, (body as { response: string }).response),
  },
  {
    method: 'GET',
    pattern: '/interviews/panel/:panelId',
    handler: (c, req, p) => {
      const st = new URL(req.url ?? '/', 'http://x').searchParams.get('status');
      return interviewsFor(c, p.panelId!, st ?? undefined);
    },
  },
  { method: 'GET', pattern: '/recruiters/tracker', handler: (c) => recruiterTracker(c) },
  { method: 'GET', pattern: '/requisitions/tracker', handler: (c) => requisitionTracker(c) },
  { method: 'GET', pattern: '/assets', handler: (c) => listAssets(c) },
  {
    method: 'GET',
    pattern: '/assets/movements',
    handler: (c, r) => {
      const n = new URL(r.url ?? '/', 'http://x').searchParams.get('limit');
      return listMovements(c, n ? Number(n) : 25);
    },
  },
  {
    method: 'POST',
    pattern: '/assets',
    handler: (c, _r, _p, body) => addAsset(c, (body ?? {}) as Parameters<typeof addAsset>[1]),
  },
  { method: 'GET', pattern: '/assets/kpi', handler: (c) => assetKpi(c) },
  { method: 'GET', pattern: '/assets/requests', handler: (c) => listRequests(c) },
  { method: 'GET', pattern: '/assets/requests/open', handler: (c) => listOpenRequests(c) },
  { method: 'GET', pattern: '/assets/recovery', handler: (c) => pendingRecovery(c) },
  {
    method: 'POST',
    pattern: '/assets/requests',
    handler: (c, _r, _p, body) =>
      requestAsset(c, (body ?? {}) as Parameters<typeof requestAsset>[1]),
  },
  {
    method: 'PUT',
    pattern: '/assets/requests/:id',
    handler: (c, _r, p, body) =>
      actOnRequest(c, p.id!, (body as { status: string }).status),
  },
  {
    method: 'POST',
    pattern: '/assets/:id/allocate',
    handler: (c, _r, p, body) => allocate(c, p.id!, (body as { empId: string }).empId),
  },
  {
    method: 'POST',
    pattern: '/assets/:id/return',
    handler: (c, _r, p) => markReturned(c, p.id!),
  },
  {
    method: 'GET',
    pattern: '/announcements',
    handler: (c) => listAnnouncements(c),
  },
  {
    method: 'POST',
    pattern: '/announcements',
    handler: (c, _r, _p, body) =>
      postAnnouncement(c, (body ?? {}) as Parameters<typeof postAnnouncement>[1]),
  },
  {
    method: 'PUT',
    pattern: '/announcements/:id/pinned',
    handler: (c, _r, p, body) =>
      setPinned(c, p.id!, Boolean((body as { pinned?: boolean } | undefined)?.pinned)),
  },
  {
    method: 'DELETE',
    pattern: '/announcements/:id',
    handler: (c, _r, p) => removeAnnouncement(c, p.id!),
  },
  {
    method: 'GET',
    pattern: '/celebrations',
    handler: (c, req) => {
      const days = new URL(req.url ?? '/', 'http://x').searchParams.get('days');
      return listCelebrations(c, days ? Number(days) : 30);
    },
  },
  {
    method: 'GET',
    pattern: '/timesheets',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = p.get('empIds');
      return listTimesheets(c, {
        ...(ids ? { empIds: ids.split(',').filter(Boolean) } : {}),
        ...(p.get('weekStart') ? { weekStart: p.get('weekStart')! } : {}),
        ...(p.get('since') ? { since: p.get('since')! } : {}),
        ...(p.get('status') ? { status: p.get('status')! } : {}),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/timesheets/:empId/:weekStart',
    handler: (c, _r, p) => timesheetForWeek(c, p.empId!, p.weekStart!),
  },
  {
    method: 'POST',
    pattern: '/timesheets/:id/entries',
    handler: (c, _r, p, body) =>
      addEntry(c, p.id!, body as Parameters<typeof addEntry>[2]),
  },
  {
    method: 'PUT',
    pattern: '/timesheets/:id/entries/:entryId',
    handler: (c, _r, p, body) =>
      updateEntry(c, p.id!, p.entryId!, body as Parameters<typeof updateEntry>[3]),
  },
  {
    method: 'DELETE',
    pattern: '/timesheets/:id/entries/:entryId',
    handler: (c, _r, p) => removeEntry(c, p.id!, p.entryId!),
  },
  {
    method: 'PUT',
    pattern: '/timesheets/:id/comment',
    handler: (c, _r, p, body) =>
      setComment(c, p.id!, (body as { note?: string } | undefined)?.note ?? ''),
  },
  {
    method: 'POST',
    pattern: '/timesheets/:id/copy-previous',
    handler: (c, _r, p) => copyPreviousWeek(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/timesheets/:id/submit',
    handler: (c, _r, p) => submitTimesheet(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/timesheets/:id/recall',
    handler: (c, _r, p) => recallTimesheet(c, p.id!),
  },
  {
    /*
     * One endpoint for the three decisions rather than three. They differ only
     * in the word, and the approver and the guards are identical — three
     * routes would be three places to forget the self-approval check.
     */
    method: 'POST',
    pattern: '/timesheets/:id/decide',
    handler: (c, _r, p, body) => {
      const b = body as { decision: 'approved' | 'returned' | 'rejected'; note?: string };
      return actOnTimesheet(c, p.id!, b.decision, b.note);
    },
  },
  {
    method: 'GET',
    pattern: '/joiners',
    handler: (c, req) => {
      const st = new URL(req.url ?? '/', 'http://x').searchParams.get('status');
      return listJoiners(c, (st ?? undefined) as 'pending' | undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/joiners',
    handler: (c, _r, _p, body) => requestJoiner(c, body as Parameters<typeof requestJoiner>[1]),
  },
  {
    method: 'POST',
    pattern: '/joiners/:id/approve',
    handler: (c, _r, p, body) =>
      approveJoiner(c, p.id!, (body as { note?: string } | undefined)?.note),
  },
  {
    method: 'POST',
    pattern: '/joiners/:id/reject',
    handler: (c, _r, p, body) =>
      rejectJoiner(c, p.id!, (body as { note?: string } | undefined)?.note),
  },
  { method: 'GET', pattern: '/config/sites', handler: (c) => listSites(c) },
  { method: 'GET', pattern: '/config/holidays', handler: (c) => listHolidays(c) },
  {
    method: 'PUT',
    pattern: '/config/sites/:code/fence',
    handler: (c, _r, p, body) =>
      updateFence(c, p.code!, body as Parameters<typeof updateFence>[2]),
  },
  {
    method: 'PUT',
    pattern: '/config/leave-types/:code/quota',
    handler: (c, _r, p, body) => setLeaveQuota(c, p.code!, (body as { quota: number }).quota),
  },
  {
    method: 'POST',
    pattern: '/config/holidays',
    handler: (c, _r, _p, body) => {
      const b = body as { date: string; name: string; optional?: boolean };
      return addHoliday(c, b.date, b.name, Boolean(b.optional));
    },
  },
  {
    method: 'GET',
    pattern: '/leave',
    handler: (c, req) => {
      const p = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = p.get('empIds');
      return listLeave(c, {
        ...(ids ? { empIds: ids.split(',').filter(Boolean) } : {}),
        ...(p.get('status') ? { status: p.get('status') as 'Pending' } : {}),
      });
    },
  },
  {
    method: 'GET',
    pattern: '/leave/balances',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return balancesForMany(c, ids ? ids.split(',').filter(Boolean) : []);
    },
  },
  {
    method: 'GET',
    pattern: '/leave/balances/:empId',
    handler: (c, req, p) => {
      const type = new URL(req.url ?? '/', 'http://x').searchParams.get('type');
      return type ? balanceFor(c, p.empId!, type) : balancesFor(c, p.empId!);
    },
  },
  {
    method: 'POST',
    pattern: '/leave/:id/reject',
    handler: (c, _r, p, body) =>
      rejectLeave(c, p.id!, (body as { note?: string } | undefined)?.note),
  },
  {
    method: 'POST',
    pattern: '/leave',
    handler: (caller, _req, _params, body) =>
      applyForLeave(caller, body as Parameters<typeof applyForLeave>[1]),
  },
  {
    method: 'POST',
    pattern: '/leave/:id/approve',
    handler: (caller, _req, params) => approveLeave(caller, params.id!),
  },
  {
    method: 'POST',
    pattern: '/leave/:id/cancel',
    handler: (caller, _req, params) => cancelLeave(caller, params.id!),
  },

  /* ---- shifts and overtime ---- */
  {
    method: 'GET',
    pattern: '/shifts',
    handler: (c) => listShifts(c),
  },
  {
    method: 'GET',
    pattern: '/shifts/coverage',
    handler: (c) => shiftCoverage(c),
  },
  {
    // ?empIds=a,b&from=2026-09-14&days=14
    method: 'GET',
    pattern: '/shifts/roster',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = q.get('empIds');
      return rosterFor(c, ids ? ids.split(',').filter(Boolean) : [],
        q.get('from') ?? '', Number(q.get('days') ?? 7));
    },
  },
  {
    method: 'PUT',
    pattern: '/employees/:id/shift',
    handler: (c, _r, p, body) =>
      setEmployeeShift(c, p.id!, (body as { shift: string }).shift),
  },
  {
    method: 'GET',
    pattern: '/overtime',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = q.get('empIds');
      return listOvertime(c,
        ids ? ids.split(',').filter(Boolean) : undefined,
        q.get('status') ?? undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/overtime',
    handler: (c, _r, _p, body) => raiseOvertime(c, body as Parameters<typeof raiseOvertime>[1]),
  },
  {
    method: 'POST',
    pattern: '/overtime/:id/approve',
    handler: (c, _r, p) => actOnOvertime(c, p.id!, 'approved'),
  },
  {
    method: 'POST',
    pattern: '/overtime/:id/reject',
    handler: (c, _r, p) => actOnOvertime(c, p.id!, 'rejected'),
  },

  /* ---- HR letters ---- */
  {
    method: 'GET',
    pattern: '/letters/types',
    handler: (c) => listLetterTypes(c),
  },
  {
    method: 'GET',
    pattern: '/letters',
    handler: (c, req) =>
      listLetterRequests(c,
        new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? undefined),
  },
  {
    method: 'POST',
    pattern: '/letters',
    handler: (c, _r, _p, body) => requestLetter(c, body as Parameters<typeof requestLetter>[1]),
  },
  {
    method: 'POST',
    pattern: '/letters/:id/issue',
    handler: (c, _r, p) => issueLetter(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/letters/:id/reject',
    handler: (c, _r, p, body) =>
      rejectLetter(c, p.id!, (body as { reason?: string } | undefined)?.reason ?? ''),
  },

  /* ---- tax declarations ---- */
  {
    method: 'GET',
    pattern: '/tax/declarations',
    handler: (c) => allDeclarations(c),
  },
  {
    method: 'GET',
    pattern: '/tax/rows',
    handler: (c) => taxRows(c),
  },
  {
    method: 'GET',
    pattern: '/tax/:empId/summary',
    handler: (c, _r, p) => taxSummary(c, p.empId!),
  },
  {
    method: 'GET',
    pattern: '/tax/:empId',
    handler: (c, _r, p) => declarationFor(c, p.empId!),
  },
  {
    method: 'PUT',
    pattern: '/tax/:empId',
    handler: (c, _r, p, body) =>
      saveDeclaration(c, p.empId!, (body as { items: Record<string, unknown> }).items ?? {}),
  },
  {
    method: 'PUT',
    pattern: '/tax/:empId/regime',
    handler: (c, _r, p, body) => setRegime(c, p.empId!, (body as { regime: string }).regime),
  },
  {
    method: 'POST',
    pattern: '/tax/:empId/proofs',
    handler: (c, _r, p, body) =>
      submitProofs(c, p.empId!, (body as { note?: string } | undefined)?.note),
  },
  {
    method: 'POST',
    pattern: '/tax/:empId/verify',
    handler: (c, _r, p) => verifyDeclaration(c, p.empId!),
  },

  /* ---- security ---- */
  {
    method: 'GET',
    pattern: '/security/audit',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return audit(c, q.get('cat') ?? undefined, q.get('sev') ?? undefined,
        Number(q.get('limit') ?? 200));
    },
  },
  {
    method: 'GET',
    pattern: '/security/audit/categories',
    handler: (c) => auditCategories(c),
  },
  { method: 'GET', pattern: '/security/controls', handler: (c) => controls(c) },
  { method: 'GET', pattern: '/security/retention', handler: (c) => retention(c) },


  /* ---- the job title catalogue ---- */
  {
    method: 'GET',
    pattern: '/job-titles',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return listJobTitles(c, {
        q: q.get('q') ?? undefined, dept: q.get('dept') ?? undefined, family: q.get('family') ?? undefined,
        level: q.get('level') ?? undefined, empType: q.get('empType') ?? undefined, status: q.get('status') ?? undefined,
      });
    },
  },
  { method: 'GET', pattern: '/job-titles/mine', handler: (c) => mineJobTitle(c) },
  { method: 'GET', pattern: '/job-titles/:id', handler: (c, _r, p) => getJobTitle(c, p.id!) },
  { method: 'POST', pattern: '/job-titles', handler: (c, _r, _p, b) => createJobTitle(c, b as never) },
  {
    method: 'PATCH',
    pattern: '/job-titles/:id',
    handler: (c, _r, p, b) => updateJobTitle(c, p.id!, b as never),
  },
  {
    method: 'PUT',
    pattern: '/job-titles/:id/status',
    handler: (c, _r, p, b) => setJobTitleStatus(c, p.id!, (b as { status: string }).status),
  },
  { method: 'DELETE', pattern: '/job-titles/:id', handler: (c, _r, p) => removeJobTitle(c, p.id!) },

  /* ---- the employment lifecycle ---- */
  {
    method: 'GET',
    pattern: '/lifecycle',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return listLifecycle(c, {
        q: q.get('q') ?? undefined, stage: q.get('stage') ?? undefined, dept: q.get('dept') ?? undefined,
        managerId: q.get('managerId') ?? undefined, site: q.get('site') ?? undefined,
        from: q.get('from') ?? undefined, to: q.get('to') ?? undefined,
      });
    },
  },
  { method: 'GET', pattern: '/lifecycle/stats', handler: (c) => lifecycleStats(c) },
  { method: 'GET', pattern: '/lifecycle/:id', handler: (c, _r, p) => getLifecycle(c, p.id!) },
  {
    method: 'POST',
    pattern: '/lifecycle/:id/tasks',
    handler: (c, _r, p, b) => addLifecycleTask(c, p.id!, b as never),
  },
  {
    method: 'PUT',
    pattern: '/lifecycle/tasks/:taskId/done',
    handler: (c, _r, p, b) => setLifecycleTaskDone(c, p.taskId!, (b as { done: boolean }).done),
  },
  {
    method: 'DELETE',
    pattern: '/lifecycle/tasks/:taskId',
    handler: (c, _r, p) => removeLifecycleTask(c, p.taskId!),
  },

  /* ---- the software estate ---- */
  {
    method: 'GET',
    pattern: '/software',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return listSoftware(c, {
        q: q.get('q') ?? undefined, cat: q.get('cat') ?? undefined, vendor: q.get('vendor') ?? undefined,
        status: q.get('status') ?? undefined, ownerId: q.get('ownerId') ?? undefined,
        renewingWithin: q.get('renewingWithin') ? Number(q.get('renewingWithin')) : undefined,
        hasDormant: q.get('hasDormant') === 'true' || undefined,
      });
    },
  },
  { method: 'GET', pattern: '/software/mine', handler: (c) => mySoftware(c) },
  { method: 'GET', pattern: '/software/stats', handler: (c) => softwareStats(c) },
  {
    method: 'GET',
    pattern: '/software/renewals',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return softwareRenewals(c, q.get('within') ? Number(q.get('within')) : undefined);
    },
  },
  { method: 'GET', pattern: '/software/:id', handler: (c, _r, p) => getSoftware(c, p.id!) },
  { method: 'POST', pattern: '/software', handler: (c, _r, _p, b) => createSoftware(c, b as never) },
  {
    method: 'PATCH',
    pattern: '/software/:id',
    handler: (c, _r, p, b) => updateSoftware(c, p.id!, b as never),
  },
  { method: 'DELETE', pattern: '/software/:id', handler: (c, _r, p) => removeSoftware(c, p.id!) },
  {
    method: 'POST',
    pattern: '/software/:id/seats',
    handler: (c, _r, p, b) => assignSeat(c, p.id!, (b as { empId: string }).empId),
  },
  {
    method: 'DELETE',
    pattern: '/software/seats/:seatId',
    handler: (c, _r, p) => revokeSeat(c, p.seatId!),
  },

  /* ---- development plans ---- */
  {
    method: 'GET',
    pattern: '/dev-plans',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return listDevPlans(c, {
        q: q.get('q') ?? undefined, status: q.get('status') ?? undefined, dept: q.get('dept') ?? undefined,
        managerId: q.get('managerId') ?? undefined, mentorId: q.get('mentorId') ?? undefined, area: q.get('area') ?? undefined,
        endorsed: q.get('endorsed') === null ? undefined : q.get('endorsed') === 'true',
        reviewDue: q.get('reviewDue') === 'true' || undefined,
        overdueOnly: q.get('overdueOnly') === 'true' || undefined,
      });
    },
  },
  { method: 'GET', pattern: '/dev-plans/mine', handler: (c) => myDevPlan(c) },
  { method: 'GET', pattern: '/dev-plans/stats', handler: (c) => devPlanStats(c) },
  { method: 'GET', pattern: '/dev-plans/focus', handler: (c) => devFocus(c) },
  { method: 'GET', pattern: '/dev-plans/mentors', handler: (c) => mentorLoad(c) },
  { method: 'GET', pattern: '/dev-plans/mentor-options', handler: (c) => mentorOptions(c) },
  { method: 'GET', pattern: '/dev-plans/:id', handler: (c, _r, p) => getDevPlan(c, p.id!) },
  { method: 'POST', pattern: '/dev-plans', handler: (c, _r, _p, b) => createDevPlan(c, b as never) },
  {
    method: 'PATCH',
    pattern: '/dev-plans/:id',
    handler: (c, _r, p, b) => updateDevPlan(c, p.id!, b as never),
  },
  { method: 'POST', pattern: '/dev-plans/:id/endorse', handler: (c, _r, p) => endorseDevPlan(c, p.id!) },
  {
    method: 'PUT',
    pattern: '/dev-plans/:id/status',
    handler: (c, _r, p, b) => setDevPlanStatus(c, p.id!, (b as { status: string }).status),
  },
  {
    method: 'PUT',
    pattern: '/dev-plans/:id/review',
    handler: (c, _r, p, b) => setDevPlanReview(c, p.id!, (b as { on: string }).on),
  },
  {
    method: 'POST',
    pattern: '/dev-plans/:id/actions',
    handler: (c, _r, p, b) => addDevAction(c, p.id!, b as never),
  },
  {
    method: 'PUT',
    pattern: '/dev-plans/actions/:actionId/done',
    handler: (c, _r, p, b) => setDevActionDone(c, p.actionId!, (b as { done: boolean }).done),
  },
  {
    method: 'DELETE',
    pattern: '/dev-plans/actions/:actionId',
    handler: (c, _r, p) => removeDevAction(c, p.actionId!),
  },

  /* ---- company events ---- */
  {
    method: 'GET',
    pattern: '/events',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return listEvents(c, {
        q: q.get('q') ?? undefined, type: q.get('type') ?? undefined, status: q.get('status') ?? undefined,
        site: q.get('site') ?? undefined, organiserId: q.get('organiserId') ?? undefined,
        when: (q.get('when') as 'upcoming' | 'past' | null) ?? undefined,
        mineOnly: q.get('mineOnly') === 'true' || undefined,
        from: q.get('from') ?? undefined, to: q.get('to') ?? undefined,
      });
    },
  },
  { method: 'GET', pattern: '/events/mine', handler: (c) => myEvents(c) },
  { method: 'GET', pattern: '/events/stats', handler: (c) => eventStats(c) },
  { method: 'GET', pattern: '/events/:id', handler: (c, _r, p) => getEvent(c, p.id!) },
  { method: 'POST', pattern: '/events', handler: (c, _r, _p, b) => createEvent(c, b as never) },
  {
    method: 'PATCH',
    pattern: '/events/:id',
    handler: (c, _r, p, b) => updateEvent(c, p.id!, b as never),
  },
  { method: 'POST', pattern: '/events/:id/publish', handler: (c, _r, p) => publishEvent(c, p.id!) },
  {
    method: 'POST',
    pattern: '/events/:id/cancel',
    handler: (c, _r, p, b) => cancelEvent(c, p.id!, (b as { reason: string }).reason),
  },
  { method: 'DELETE', pattern: '/events/:id', handler: (c, _r, p) => removeEvent(c, p.id!) },
  {
    method: 'POST',
    pattern: '/events/:id/rsvp',
    handler: (c, _r, p, b) => rsvp(c, p.id!, (b as { choice: string }).choice),
  },
  { method: 'DELETE', pattern: '/events/:id/rsvp', handler: (c, _r, p) => withdrawRsvp(c, p.id!) },
  {
    method: 'PUT',
    pattern: '/events/:id/attendance',
    handler: (c, _r, p, b) => markAttendance(
      c, p.id!, (b as { empId: string }).empId, (b as { attended: boolean }).attended),
  },



  /* ---- employee documents ---- */
  {
    method: 'GET',
    pattern: '/documents',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const ids = q.get('empIds');
      return listDocuments(c, ids ? ids.split(',') : undefined);
    },
  },
  { method: 'GET', pattern: '/documents/types', handler: (c) => documentTypes(c) },

  /* ---- the recruitment desk ---- */
  {
    method: 'GET',
    pattern: '/recruitment/job-orders',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return jobOrders(c, {
        from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, clientId: q.get('clientId') ?? undefined,
        recruiterId: q.get('recruiterId') ?? undefined, reqId: q.get('reqId') ?? undefined,
        industry: q.get('industry') ?? undefined, tech: q.get('tech') ?? undefined, location: q.get('location') ?? undefined,
        status: q.get('status') ?? undefined, priority: q.get('priority') ?? undefined,
      });
    },
  },
  { method: 'GET', pattern: '/recruitment/kpi', handler: (c) => recruitmentKpi(c) },
  { method: 'GET', pattern: '/recruitment/funnel', handler: (c) => recruitmentFunnel(c) },
  { method: 'GET', pattern: '/recruitment/unassigned', handler: (c) => unassignedJobs(c) },
  { method: 'GET', pattern: '/recruitment/recruiters', handler: (c) => recruiterPerformance(c) },
  { method: 'GET', pattern: '/recruitment/aging', handler: (c) => jobAging(c) },
  {
    method: 'GET',
    pattern: '/recruitment/my-jobs/:recruiterId',
    handler: (c, _r, p) => myJobs(c, p.recruiterId!),
  },
  {
    method: 'GET',
    pattern: '/recruitment/job-orders/:id',
    handler: (c, _r, p) => jobOrder(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/recruitment/job-orders',
    handler: (c, _r, _p, b) => createJobOrder(c, b as never),
  },
  {
    method: 'PATCH',
    pattern: '/recruitment/job-orders/:id',
    handler: (c, _r, p, b) => updateJobOrder(c, p.id!, b as never),
  },
  {
    method: 'POST',
    pattern: '/recruitment/job-orders/:id/assign',
    handler: (c, _r, p, b) => assign(c, p.id!, b as never),
  },
  {
    method: 'POST',
    pattern: '/recruitment/job-orders/:id/release',
    handler: (c, _r, p, b) => release(c, p.id!, (b as { assignmentId: string }).assignmentId),
  },
  {
    method: 'POST',
    pattern: '/recruitment/job-orders/:id/activity',
    handler: (c, _r, p, b) => {
      const d = b as { kind: string; summary: string; qty?: number };
      return logActivity(c, p.id!, d.kind, d.summary, d.qty);
    },
  },

  /* ---- user accounts ---- */
  {
    method: 'GET',
    pattern: '/users',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return listUsers(c, {
        q: q.get('q') ?? undefined, status: q.get('status') ?? undefined, role: q.get('role') ?? undefined, dept: q.get('dept') ?? undefined,
        site: q.get('site') ?? undefined, managerId: q.get('managerId') ?? undefined, empType: q.get('empType') ?? undefined,
        joinedFrom: q.get('joinedFrom') ?? undefined, joinedTo: q.get('joinedTo') ?? undefined,
      });
    },
  },
  { method: 'GET', pattern: '/users/stats', handler: (c) => userStats(c) },
  { method: 'GET', pattern: '/users/next-code', handler: (c) => nextEmployeeCode(c) },
  /* Above /users/:id, or "login-history" is read as an account id. */
  {
    method: 'GET',
    pattern: '/users/login-history',
    handler: (c) => listTenantLoginHistory(c),
  },
  { method: 'GET', pattern: '/users/:id', handler: (c, _r, p) => getUser(c, p.id!) },
  { method: 'POST', pattern: '/users', handler: (c, _r, _p, b) => createUser(c, b as never) },
  {
    method: 'PATCH',
    pattern: '/users/:id',
    handler: (c, _r, p, b) => updateUser(c, p.id!, b as never),
  },
  {
    method: 'PUT',
    pattern: '/users/:id/status',
    handler: (c, _r, p, b) => {
      const d = b as { status: string; reason?: string };
      return setUserStatus(c, p.id!, d.status, d.reason);
    },
  },
  {
    method: 'POST',
    pattern: '/users/:id/delete',
    handler: (c, _r, p, b) => removeUser(c, p.id!, (b as { typed: string }).typed),
  },
  {
    method: 'POST',
    pattern: '/users/:id/decide',
    handler: (c, _r, p, b) => {
      const d = b as { decision: 'Approved' | 'Rejected'; note?: string };
      return decideUser(c, p.id!, d.decision, d.note);
    },
  },
  {
    method: 'POST',
    pattern: '/users/:id/resend-invitation',
    handler: (c, _r, p) => resendInvitation(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/users/:id/reset-password',
    handler: (c, _r, p, b) =>
      resetPassword(c, p.id!, (b as { forceChange?: boolean }).forceChange ?? true),
  },
  /* No id: it stamps the caller's own row and nobody else's. */
  {
    method: 'POST',
    pattern: '/users/me/last-login',
    handler: async (c, r, _p, b) => {
      const account = await lastLoginNow(c);
      /*
       * The stamp and the history entry are the same event seen twice:
       * `last_login_at` is the current fact an administrator sorts on, the
       * history row is what the person themselves reads to recognise a
       * session. Written together so they cannot disagree.
       *
       * `method` comes from the body because only the client knows whether a
       * second factor was used, and it is a label on the caller's own row —
       * the worst a lie does is mislabel your own history. Validated against
       * a fixed list anyway.
       */
      const method = (b as { method?: string } | undefined)?.method ?? 'password';
      await recordLoginEvent(c, 'success', agentOf(r), method);
      return account;
    },
  },
  {
    method: 'POST',
    pattern: '/users/me/sign-out',
    handler: async (c, r, _p, b) => {
      /*
       * Recorded before the token is discarded, because afterwards there is
       * no caller to attribute it to. An inactivity timeout and a deliberate
       * sign-out both land here and are told apart by the reason, which is
       * the difference between "I left" and "it logged me out".
       */
      const why = (b as { reason?: string } | undefined)?.reason;
      await recordLoginEvent(c, 'signed_out', agentOf(r), 'password',
        why === 'idle' ? 'signed out after a period of inactivity' : 'signed out');
      return { ok: true };
    },
  },
  /*
   * Whether this caller owes a password change, and the acknowledgement that
   * they have made one. Both take no id: your own row is the only one.
   */
  {
    method: 'GET',
    pattern: '/users/me/account-status',
    handler: (c) => accountObligations(c),
  },
  {
    method: 'POST',
    pattern: '/users/me/password-changed',
    handler: (c) => passwordChanged(c),
  },
  /* Your own history needs no permission; it is how you notice a stranger. */
  {
    method: 'GET',
    pattern: '/users/me/login-history',
    handler: (c) => listLoginHistory(c),
  },
  {
    method: 'GET',
    pattern: '/users/:id/login-history',
    handler: (c, _r, p) => listLoginHistory(c, p.id!),
  },
  /* An administrator may require a second factor; only the person can meet it. */
  {
    method: 'PUT',
    pattern: '/users/:id/mfa-required',
    handler: (c, _r, p, b) =>
      setMfaRequired(c, p.id!, (b as { required: boolean }).required),
  },
  {
    method: 'POST',
    pattern: '/users/bulk-update',
    handler: (c, _r, _p, b) => {
      const d = b as { ids: string[]; patch: Record<string, unknown> };
      return bulkUpdateUsers(c, d.ids, d.patch as never);
    },
  },

  /* ---- bulk import ---- */
  /*
   * Preview and commit are separate calls on purpose. Nothing is written
   * until somebody has seen the per-row verdict — a one-call import leaves a
   * half-loaded tenant behind the first bad row.
   */
  {
    method: 'POST',
    pattern: '/users/import/preview',
    handler: (c, _r, _p, b) => {
      const d = b as { fileName: string; text: string };
      return previewImport(c, d.fileName, d.text);
    },
  },
  {
    method: 'POST',
    pattern: '/users/import/commit',
    handler: (c, _r, _p, b) => {
      const d = b as { fileName: string; text: string };
      return commitImport(c, d.fileName, d.text);
    },
  },
  { method: 'GET', pattern: '/users/import/history', handler: (c) => importHistory(c) },

  /* ---- saved reports ---- */
  { method: 'GET', pattern: '/reports/saved', handler: (c) => listReports(c) },
  { method: 'GET', pattern: '/reports/saved/datasets', handler: (c) => reportDatasets(c) },
  /* A POST, because running one bumps the counters and writes an export record. */
  { method: 'POST', pattern: '/reports/saved/:id/run', handler: (c, _r, p) => runReport(c, p.id!) },
  { method: 'POST', pattern: '/reports/saved', handler: (c, _r, _p, b) => createReport(c, b as never) },
  {
    method: 'PATCH',
    pattern: '/reports/saved/:id',
    handler: (c, _r, p, b) => updateReport(c, p.id!, b as never),
  },
  { method: 'DELETE', pattern: '/reports/saved/:id', handler: (c, _r, p) => removeReport(c, p.id!) },
  {
    method: 'POST',
    pattern: '/reports/saved/:id/duplicate',
    handler: (c, _r, p) => duplicateReport(c, p.id!),
  },

  /* ---- integrations ---- */
  { method: 'GET', pattern: '/integrations', handler: (c) => listIntegrations(c) },
  { method: 'GET', pattern: '/integrations/stats', handler: (c) => integrationStats(c) },
  { method: 'GET', pattern: '/integrations/webhooks', handler: (c) => listWebhooks(c) },
  { method: 'GET', pattern: '/integrations/scopes', handler: () => apiScopes() },
  { method: 'GET', pattern: '/integrations/keys', handler: (c) => listApiKeys(c) },
  {
    method: 'POST',
    pattern: '/integrations/webhooks',
    handler: (c, _r, _p, b) => createWebhook(c, b as never),
  },
  {
    method: 'PUT',
    pattern: '/integrations/webhooks/:id/active',
    handler: (c, _r, p, b) => setWebhookActive(c, p.id!, (b as { active: boolean }).active),
  },
  {
    method: 'DELETE',
    pattern: '/integrations/webhooks/:id',
    handler: (c, _r, p) => removeWebhook(c, p.id!),
  },
  {
    method: 'POST',
    pattern: '/integrations/keys',
    handler: (c, _r, _p, b) => createApiKey(c, b as never),
  },
  {
    method: 'POST',
    pattern: '/integrations/keys/:id/revoke',
    handler: (c, _r, p) => revokeApiKey(c, p.id!),
  },

  /* ---- the export centre ---- */
  { method: 'GET', pattern: '/exports/datasets', handler: (c) => exportDatasets(c) },
  {
    method: 'GET',
    pattern: '/exports/history',
    handler: (c, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return exportHistory(c, {
        q: q.get('q') ?? undefined,
        datasetId: q.get('datasetId') ?? undefined,
        byId: q.get('byId') ?? undefined,
        outcome: (q.get('outcome') as 'Completed' | 'Refused' | null) ?? undefined,
        personalOnly: q.get('personalOnly') === 'true' || undefined,
        from: q.get('from') ?? undefined,
        to: q.get('to') ?? undefined,
      });
    },
  },
  { method: 'GET', pattern: '/exports/stats', handler: (c) => exportStats(c) },
  /*
   * A POST, although it reads. It writes the register entry, and a GET that
   * leaves a row in an audit log is the kind of thing a retry, a prefetch or a
   * link preview turns into a false record of somebody taking data out.
   */
  {
    method: 'POST',
    pattern: '/exports/run',
    handler: (c, _r, _p, body) => runExport(c, body as never),
  },

  /*
   * What the caller's own role may do.
   *
   * Served from the policy rather than the table: the policy is the definition
   * and the table is seeded from it, so reading the table here would add a
   * round trip to get the same answer one edit later. When a tenant customises
   * its own rows this reads the table instead — and that is the change to
   * make, not a second copy of the rules in the client.
   */
  {
    method: 'GET',
    pattern: '/me/permissions',
    /*
     * The tenant's *effective* policy, not the code's.
     *
     * role_permission may narrow what policy.ts grants, never widen it — see
     * effectiveRule. So this can return less than the code does and never
     * more, which is what makes it safe to let a screen drive itself from the
     * answer: the worst a wrong row does is hide something.
     *
     * Narrowing is presentational until the route layer enforces it. It takes
     * nothing away from the API, and it cannot add anything either, because a
     * caller who ignores this response is left with exactly the access
     * policy.ts already gave them.
     */
    handler: async (c) => {
      const overrides = await overridesFor(c);
      const modules = effectiveModulesFor(c.role, overrides);
      return {
        role: c.role,
        summary: ROLE_SUMMARY[c.role],
        modules,
        rules: Object.fromEntries(
          modules.map((m) => [m, effectiveRule(c.role, m, overrides)]),
        ),
      };
    },
  },

  /*
   * Permission narrowing. Under /config so it inherits the settings module,
   * which only an administrator reads — the service checks the role again
   * anyway, because a route grouping is not a permission.
   */
  { method: 'GET', pattern: '/config/permissions', handler: (c) => permissionGrid(c) },
  {
    method: 'PUT',
    pattern: '/config/permissions',
    handler: (c, _r, _p, b) =>
      setPermissions(c, (b as { patches: never[] }).patches),
  },
  {
    method: 'POST',
    pattern: '/config/permissions/reset',
    handler: (c, _r, _p, b) => resetModule(c, (b as { module: string }).module),
  },

  /* ---- approvals: the caller is the scope, so nothing is passed ---- */
  { method: 'GET', pattern: '/approvals/pending', handler: (c) => pending(c) },
  { method: 'GET', pattern: '/approvals/count', handler: (c) => pendingCount(c) },
  { method: 'GET', pattern: '/approvals/badges', handler: (c) => navBadges(c) },

  /* ---- loans ---- */
  {
    method: 'GET',
    pattern: '/loans',
    handler: (c, req) =>
      listLoans(c, new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? undefined),
  },
  {
    method: 'POST',
    pattern: '/loans/:id/approve',
    handler: (c, _r, p) => approveLoan(c, p.id!),
  },

  /* ---- learning ---- */
  { method: 'GET', pattern: '/learning/courses', handler: (c) => courses(c) },
  {
    method: 'GET',
    pattern: '/learning/enrolments',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return enrolments(c, ids ? ids.split(',').filter(Boolean) : undefined);
    },
  },
  {
    method: 'POST',
    pattern: '/learning/enrolments',
    handler: (c, _r, _p, body) => {
      const b = body as { empId: string; courseId: string };
      return enrol(c, b.empId, b.courseId);
    },
  },
  {
    method: 'PUT',
    pattern: '/learning/enrolments/:empId/:courseId',
    handler: (c, _r, p, body) =>
      setProgress(c, p.empId!, p.courseId!, (body as { progress: number }).progress),
  },

  /* ---- engagement. Literal before the parameter. ---- */
  { method: 'GET', pattern: '/surveys', handler: (c) => surveys(c) },
  { method: 'GET', pattern: '/surveys/enps-history', handler: (c) => enpsHistory(c) },
  {
    method: 'GET',
    pattern: '/surveys/:id/enps',
    handler: (c, _r, p) => enpsOf(c, p.id!),
  },

  /* ---- flexible benefits. Literals before the parameter. ---- */
  { method: 'GET', pattern: '/fbp/rows', handler: (c) => fbpRows(c) },
  { method: 'GET', pattern: '/fbp/insurance', handler: (c) => insuranceCover(c) },
  {
    method: 'GET',
    pattern: '/fbp/totals',
    handler: (c, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('empIds');
      return fbpTotals(c, ids ? ids.split(',').filter(Boolean) : []);
    },
  },
  { method: 'GET', pattern: '/fbp/:empId', handler: (c, _r, p) => fbpPlan(c, p.empId!) },
  {
    method: 'PUT',
    pattern: '/fbp/:empId',
    handler: (c, _r, p, body) =>
      declareFbp(c, p.empId!, (body as { alloc: Record<string, unknown> }).alloc ?? {}),
  },

  /* ---- staffing ---- */
  { method: 'GET', pattern: '/staffing/kpi', handler: (c) => kpi(c) },
  { method: 'GET', pattern: '/staffing/clients', handler: (c) => clients(c) },
  { method: 'GET', pattern: '/staffing/sows', handler: (c) => sows(c) },
  { method: 'GET', pattern: '/staffing/rate-cards', handler: (c) => rateCards(c) },
  { method: 'GET', pattern: '/staffing/consultants', handler: (c) => consultants(c) },
  { method: 'GET', pattern: '/staffing/bench', handler: (c) => bench(c) },
  { method: 'GET', pattern: '/staffing/vendors', handler: (c) => vendors(c) },
  { method: 'GET', pattern: '/staffing/invoices', handler: (c) => invoices(c) },
  { method: 'GET', pattern: '/staffing/placements', handler: (c) => placements(c) },
  { method: 'GET', pattern: '/staffing/submissions', handler: (c) => submissions(c) },
  { method: 'GET', pattern: '/staffing/redeployment', handler: (c) => redeploymentPlan(c) },
  {
    /* Literals first — 'open' would otherwise read as a requirement id. */
    method: 'GET',
    pattern: '/staffing/requirements/open',
    handler: (c) => openRequirements(c),
  },
  { method: 'GET', pattern: '/staffing/requirements', handler: (c) => requirements(c) },
  {
    method: 'GET',
    pattern: '/staffing/requirements/:id/matches',
    handler: (c, _r, p) => matchesForRequirement(c, p.id!),
  },
  {
    method: 'GET',
    pattern: '/staffing/consultants/:id/matches',
    handler: (c, _r, p) => matchesForConsultant(c, p.id!),
  },
  {
    method: 'GET',
    pattern: '/staffing/consultants/:id/bench-standing',
    handler: (c, _r, p) => benchStanding(c, p.id!),
  },
  {
    method: 'PUT',
    pattern: '/staffing/submissions/:id/stage',
    handler: (c, _r, p, body) =>
      moveSubmission(c, p.id!, (body as { stage: string }).stage),
  },

];

export class NotFound extends Error {}

/** Match a concrete path against a pattern, extracting :params. */
function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const q = path.split('/').filter(Boolean);
  if (p.length !== q.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i]!;
    const value = q[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(value);
    else if (seg !== value) return null;
  }
  return params;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A body larger than this is not a form submission.
    if (size > 1_000_000) throw new BadRequest('request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}

export class BadRequest extends Error {}

const bearer = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
};

/**
 * Turn an error into a status and a message.
 *
 * The default is 500 with no detail. Leaking a database error to a caller is
 * how table names and column names end up in somebody's notes.
 */
function statusFor(error: unknown): { status: number; message: string } {
  if (error instanceof AuthError) return { status: 401, message: error.message };
  if (error instanceof TenantContextError) return { status: 401, message: 'no tenant context' };
  if (error instanceof PermissionError) {
    return { status: error.kind === 'forbidden' ? 403 : 400, message: error.message };
  }
  if (error instanceof EmployeeError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404 : 400;
    return { status, message: error.message };
  }
  if (error instanceof NotFound) return { status: 404, message: error.message };
  if (error instanceof BadRequest) return { status: 400, message: error.message };
  if (error instanceof AttendanceError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof PlannerError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof ExitError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof PerformanceError) {
    const status = error.code === 'forbidden' || error.code === 'self_review'
      || error.code === 'self_praise' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof HelpdeskError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof ExpenseError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof PayrollError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof OnboardingError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }

  /*
   * The five modules added with the 0032-0036 schema. They share a code
   * vocabulary deliberately — forbidden / not_found / invalid / in_use — so
   * the mapping is one table rather than five near-identical blocks, and a
   * sixth module cannot invent a fifth status quietly.
   */
  if (error instanceof RecruitmentError || error instanceof UserError
    || error instanceof ReportError || error instanceof IntegrationError
    || error instanceof JobTitleError || error instanceof LifecycleError
    || error instanceof SoftwareError || error instanceof DevPlanError
    || error instanceof EventError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400
          : error.code === 'closed' ? 409
            : error.code === 'duplicate' ? 409
              : error.code === 'in_use' ? 409 : 400;
    return { status, message: error.message };
  }
  if (error instanceof ExportError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'unknown_dataset' ? 404 : 400;
    return { status, message: error.message };
  }
  if (error instanceof ProvisionError) {
    return { status: error.code === 'duplicate' ? 409 : 400, message: error.message };
  }
  if (error instanceof DocumentError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof HiringError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof StaffingError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof BenefitsError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof EngagementError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof LearningError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof LoanError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof SecurityError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof TaxError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' || error.code === 'not_supported' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof LetterError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof ShiftError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof AssetError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof NoticeboardError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof TimesheetError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' || error.code === 'no_project' || error.code === 'no_row' ? 400
          : 409;
    return { status, message: error.message };
  }
  if (error instanceof JoinerError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof ConfigError) {
    const status = error.code === 'forbidden' ? 403
      : error.code === 'not_found' ? 404
        : error.code === 'invalid' ? 400 : 409;
    return { status, message: error.message };
  }
  if (error instanceof LeaveError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : 409;
    return { status, message: error.message };
  }
  /*
   * PostgreSQL's own refusals, mapped before the catch-all.
   *
   * A malformed date or an id that references nothing is the caller's mistake,
   * and answering 500 says it was ours. Worse, it tells them nothing: the
   * sweep that found this got four identical "internal error" bodies for four
   * unrelated causes.
   *
   * These are a safety net and not a substitute for validating input at the
   * edge — the route should reject a date that is not a date before it reaches
   * SQL. What this guarantees is that when a route forgets, the answer is
   * still honest about whose fault it is.
   *
   * The message is deliberately generic per class rather than Postgres's own
   * text, which names tables, columns and constraints.
   */
  const pg = error as { code?: string; constraint?: string };
  switch (pg?.code) {
    case '22007':
    case '22008':
      return { status: 400, message: 'a date in this request is not a valid date' };
    case '22P02':
      return { status: 400, message: 'a value in this request is the wrong type' };
    case '23503':
      return { status: 404, message: 'this request refers to something that does not exist' };
    case '23505':
      return { status: 409, message: 'that already exists' };
    case '23514':
      return { status: 400, message: 'this request breaks a rule the data must follow' };
    default:
      break;
  }

  return { status: 500, message: 'internal error' };
}

const send = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // This API is called by a browser SPA on another origin; it must never be
    // reachable from a page the user did not open deliberately.
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
};

export function createApp() {
  return createServer((req, res) => {
    void (async () => {
      // Before anything else, including auth: a preflight carries no
      // credentials and must be answered whatever the route turns out to be.
      if (applyCors(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/health') {
        send(res, 200, { ok: true });
        return;
      }

      /*
       * Rate limit before the route lookup and before token verification.
       *
       * Verifying a token costs a JWKS lookup, so limiting after it would mean
       * a caller could still make this server do the expensive part as fast as
       * it liked. The unauthenticated allowance is deliberately small: a
       * caller with no usable token is either signing in or guessing.
       */
      const token = bearer(req);
      const limit = token ? AUTHED : ANON;
      const verdict = hit(
        keyFor(token, req.socket.remoteAddress, req.headers['x-forwarded-for'] as string | undefined),
        limit);

      res.setHeader('x-ratelimit-limit', String(limit.max));
      res.setHeader('x-ratelimit-remaining', String(verdict.remaining));

      if (!verdict.allowed) {
        res.setHeader('retry-after', String(verdict.resetSeconds));
        send(res, 429, {
          error: `too many requests — try again in ${verdict.resetSeconds}s`,
        });
        return;
      }

      try {
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const params = match(route.pattern, url.pathname);
          if (!params) continue;

          const caller = await callerFromToken(token);

          /*
           * The tenant's narrowing, enforced here rather than only in the menu.
           *
           * Without this, an administrator switching a module off removed its
           * menu entry and left its routes answering — which is a preference,
           * not a permission. One place rather than in each of forty-two
           * services, because a service that forgot would fail silently.
           *
           * Read scope only. Whether a *particular* act inside a module is
           * allowed stays with the service that performs it, where the rules
           * are specific ("only an administrator can suspend an account") and
           * already enforced. This gate answers the coarser question the
           * override table actually asks: may this role open this module at
           * all.
           */
          const moduleKey = moduleForPath(url.pathname);
          if (moduleKey) {
            const overrides = await overridesFor(caller);
            if (effectiveRule(caller.role, moduleKey, overrides).read === 'none') {
              send(res, 403, { error: 'this module is not available to your role' });
              return;
            }
          }

          const body = req.method === 'GET' ? undefined : await readJsonBody(req);
          const result = await route.handler(caller, req, params, body);
          send(res, 200, result);
          return;
        }
        send(res, 404, { error: 'no such route' });
      } catch (error) {
        const { status, message } = statusFor(error);
        if (status >= 500) console.error('[http] unhandled', error);
        /*
         * A refusal that came from the database, logged even though the caller
         * gets a 4xx.
         *
         * Mapping these to 400/404/409 was right — a malformed date is not our
         * fault — but it also stopped them reaching the log, because only 5xx
         * was printed. The result was a generic sentence on the screen and
         * nothing anywhere to say which constraint objected, which is worse
         * than the 500 it replaced.
         *
         * The response stays generic, deliberately: constraint and column
         * names describe the schema and belong in the log, not in a body sent
         * to whoever asked.
         */
        const dbErr = error as { code?: string; constraint?: string; table?: string; message?: string };
        if (status < 500 && typeof dbErr?.code === 'string' && /^[0-9A-Z]{5}$/.test(dbErr.code)) {
          console.warn(
            `[db] ${req.method} ${url.pathname} -> ${status}  sqlstate=${dbErr.code}`
            + `${dbErr.table ? ` table=${dbErr.table}` : ''}`
            + `${dbErr.constraint ? ` constraint=${dbErr.constraint}` : ''}`
            + `
      ${dbErr.message ?? ''}`);
        }
        send(res, status, { error: message });
      }
    })();
  });
}
