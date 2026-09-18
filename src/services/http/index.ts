/**
 * The HTTP implementation of `Services`.
 *
 * 159 methods will not be migrated in one commit, so this is deliberately a
 * *hybrid*: the methods listed below go to the API, and everything else falls
 * through to the in-memory implementation. Screens do not know or care which,
 * which is what makes the migration incremental rather than a flag day.
 *
 * The list is explicit rather than inferred. A proxy that guessed would fail
 * silently when a path was wrong — falling back to the mock and showing
 * plausible fake data instead of an error. That is the single worst failure
 * mode available here, so the mapping is written out and `liveMethodCount()`
 * reports progress honestly.
 */

import type { Services } from '../contracts';
import { api, qs } from './client';
import type { Employee, LeaveRequest } from '../contracts';
import type { AppRole } from '../../types/employee';

export { apiConfigured, ApiError } from './client';

/**
 * Methods backed by the API, by service.
 *
 * Note what is *not* passed: `visible(caller)` ignores its argument, because
 * the server derives the caller from the session token. Sending scope from the
 * client would make it a suggestion rather than a boundary.
 */
function liveMethods(): { [K in keyof Services]?: Partial<Services[K]> } {
  return {
    employees: {
      visible: () => api.get<Employee[]>('/employees'),
      active: () => api.get<Employee[]>('/employees/active'),
      exited: () => api.get<Employee[]>('/employees/exited'),
      byId: (id: string) => api.get<Employee | null>(`/employees/${id}`),
      byIds: (ids: string[]) =>
        (ids.length ? api.get<Employee[]>(`/employees/by-ids${qs({ ids: ids.join(',') })}`)
          : Promise.resolve([])),
      team: (managerId: string, deep?: boolean) =>
        api.get<Employee[]>(`/employees/${managerId}/team${qs({ deep: deep ? 'true' : undefined })}`),
      setRole: (id: string, role: AppRole) =>
        api.put<Employee>(`/employees/${id}/role`, { role }),

      /*
       * `profile` is deliberately NOT here.
       *
       * The contract's EmployeeProfile carries the salary structure, monthly
       * split and tax status — payroll data this deployment does not hold yet.
       * A partial response would typecheck and render blank fields, so the
       * profile drawer stays on the mock until payroll exists. Claiming a
       * method the server cannot honour is worse than not claiming it.
       */
    },

    attendance: {
      list: (q) => api.get(`/attendance${qs({
        empIds: q.empIds?.join(','), from: q.from, to: q.to,
        regularisedOnly: q.regularisedOnly ? 'true' : undefined,
      })}`),
      forDay: (empId, date) => api.get(`/attendance/${empId}/${date}`),
      regularisable: (empId, since) =>
        api.get(`/attendance/${empId}/regularisable${qs({ since })}`),
      punchIn: (empId, date, at) =>
        api.post(`/attendance/${empId}/${date}/punch-in`,
          { site: at.site, lat: at.lat, lng: at.lng, src: at.src, at: at.at }),
      punchOut: (empId, date, at) =>
        api.post(`/attendance/${empId}/${date}/punch-out`,
          { site: at.site, lat: at.lat, lng: at.lng, src: at.src, at: at.at }),
      raiseRegularisation: (empId, date, inT, outT, reason) =>
        api.post(`/attendance/${empId}/${date}/regularise`, { inT, outT, reason }),
      actOnRegularisation: (empId, date, decision) =>
        api.put(`/attendance/${empId}/${date}/regularise`, { decision }),
    },

    planner: {
      items: (q) => api.get(`/planner/items${qs({
        projectId: q.projectId, iterationId: q.iterationId, assigneeId: q.assigneeId,
        kind: q.kind, openOnly: q.openOnly ? 'true' : undefined,
      })}`),
      mine: (empId) => api.get(`/planner/mine${qs({ empId })}`),
      board: (projectId) => api.get(`/planner/board${qs({ projectId })}`),
      iterations: () => api.get('/planner/iterations'),
      createItem: (draft) => api.post('/planner/items', draft),
      createIteration: (draft) => api.post('/planner/iterations', draft),
      moveItem: (id, status, afterId) =>
        api.put(`/planner/items/${id}/move`, { status, afterId }),
      updateItem: (id, patch) => api.put(`/planner/items/${id}`, patch),
      comment: (id, text) => api.post(`/planner/items/${id}/comments`, { text }),
    },

    exits: {
      list: () => api.get('/exits'),
      detail: (exitId) => api.get(`/exits/${exitId}`),
      raise: (draft) => api.post('/exits', draft),
      setClearance: (exitId, department, done) =>
        api.put(`/exits/${exitId}/clearance/${encodeURIComponent(department)}`, { done }),
      settle: (exitId) => api.post(`/exits/${exitId}/settle`),
      recordInterview: (exitId, answers) => api.post(`/exits/${exitId}/interview`, answers),
    },

    performance: {
      goals: (empIds) =>
        api.get(`/performance/goals${qs({ empIds: empIds?.join(',') })}`),
      reviews: (empIds) =>
        api.get(`/performance/reviews${qs({ empIds: empIds?.join(',') })}`),
      praise: () => api.get('/performance/praise'),
      currentCycle: () => api.get('/performance/cycle'),
      checkins: (empIds) =>
        api.get(`/performance/checkins${qs({ empIds: empIds?.join(',') })}`),
      setGoalProgress: (goalId, progress) =>
        api.put(`/performance/goals/${goalId}/progress`, { progress }),
      addGoal: (draft) => api.post('/performance/goals', draft),
      logCheckin: (draft) => api.post('/performance/checkins', draft),
      givePraise: (toId, value, text) =>
        api.post('/performance/praise', { toId, value, text }),
      submitSelfReview: (rating, comments) =>
        api.post('/performance/reviews/self', { rating, comments }),
      submitManagerReview: (empId, rating, comments) =>
        api.post(`/performance/reviews/${empId}/manager`, { rating, comments }),
      calibrateReview: (empId, outcome) =>
        api.post(`/performance/reviews/${empId}/calibrate`, outcome),
    },

    helpdesk: {
      tickets: (empIds) =>
        api.get(`/helpdesk/tickets${qs({ empIds: empIds?.join(',') })}`),
      knowledgeBase: () => api.get('/helpdesk/kb'),
      raise: (t) => api.post('/helpdesk/tickets', t),
      /* `by` is ignored: the author is the session, not a name in the body. */
      comment: (id, _by, text) => api.post(`/helpdesk/tickets/${id}/comments`, { text }),
      resolve: (id, csat) => api.post(`/helpdesk/tickets/${id}/resolve`, { csat }),
    },

    expenses: {
      claims: (q) => api.get(`/expenses/claims${qs({
        empIds: q.empIds?.join(','), status: q.status,
      })}`),
      submitClaim: (c) => api.post('/expenses/claims', c),
      /* approverId is ignored: the server takes the approver from the session. */
      approveClaim: (id) => api.post(`/expenses/claims/${id}/approve`),
      rejectClaim: (id, _approverId, note) =>
        api.post(`/expenses/claims/${id}/reject`, { note }),
      reimburseClaim: (id) => api.post(`/expenses/claims/${id}/reimburse`),
      advances: (empIds) =>
        api.get(`/expenses/advances${qs({ empIds: empIds?.join(',') })}`),
      requestAdvance: (empId, amount, reason) =>
        api.post('/expenses/advances', { empId, amount, reason }),
      approveAdvance: (id) => api.post(`/expenses/advances/${id}/approve`),
    },

    payroll: {
      runs: () => api.get('/payroll/runs'),
      currentRun: () => api.get('/payroll/runs/current'),
      totals: (mk) => api.get(`/payroll/${mk}/totals`),
      totalsFor: (mks) => api.get(`/payroll/totals${qs({ mks: mks.join(',') })}`),
      register: (mk) => api.get(`/payroll/${mk}/register`),
      payslip: (empId, mk) => api.get(`/payroll/payslips/${empId}/${mk}`),
      payslipHistory: (empId) => api.get(`/payroll/payslips/${empId}`),
      dailyRates: (empIds) =>
        (empIds.length ? api.get(`/payroll/daily-rates${qs({ empIds: empIds.join(',') })}`)
          : Promise.resolve({})),
      structure: (empId) => api.get(`/payroll/structure/${empId}`),
      inputs: (mk) => api.get(`/payroll/${mk}/inputs`),
      compensation: () => api.get('/payroll/compensation'),
      bankBatches: () => api.get('/payroll/bank-batches'),
      compliancePayments: () => api.get('/payroll/compliance'),
      activeLoans: () => api.get('/payroll/loans'),
      processRun: (mk) => api.post(`/payroll/${mk}/process`),
      /*
       * The tax-declaration half of PayrollService is deliberately absent.
       * Declarations price a regime against PAN-backed proofs, and the
       * schema holds no PAN; claiming a method the server cannot honour is
       * worse than not claiming it.
       */
    },

    onboarding: {
      list: () => api.get('/onboarding'),
      create: (draft) => api.post('/onboarding', draft),
      setTask: (id, key, done) =>
        api.put(`/onboarding/${id}/tasks/${encodeURIComponent(key)}`, { done }),
      complete: (id) => api.post(`/onboarding/${id}/complete`),
    },

    hiring: {
      requisitions: () => api.get('/requisitions'),
      candidates: () => api.get('/candidates'),
      interviews: () => api.get('/interviews'),
      interviewsFor: (panelId, status) =>
        api.get(`/interviews/panel/${panelId}${qs({ status })}`),
      moveCandidate: (candId, stage) => api.put(`/candidates/${candId}/stage`, { stage }),
      openRequisition: (draft) => api.post('/requisitions', draft),
      submitCandidate: (draft) => api.post('/candidates', draft),
      recruiterTracker: () => api.get('/recruiters/tracker'),
      requisitionTracker: () => api.get('/requisitions/tracker'),
      scheduleInterview: (draft) => api.post('/interviews', draft),
      submitFeedback: (id, verdict, feedback) =>
        api.post(`/interviews/${id}/feedback`, { verdict, feedback }),
      makeOffer: (draft) => api.post('/offers', draft),
      offerLetter: (candId) =>
        api.get<{ body: string }>(`/offers/${candId}/letter`).then((r) => r.body),
      releaseOffer: (candId) => api.post(`/offers/${candId}/release`, {}),
      respondToOffer: (candId, response) =>
        api.post(`/offers/${candId}/respond`, { response }),
    },

    documents: {
      requests: (q = {}) => api.get(`/documents/requests${qs(q)}`),
      collectionSummary: (q = {}) => api.get(`/documents/summary${qs(q)}`),
      requestChecklist: (journeyId, due) =>
        api.post(`/documents/journeys/${journeyId}/checklist`, { due }),
      requestDocument: (draft) => api.post('/documents/requests', draft),
      setRequestStatus: (id, status, note) =>
        api.put(`/documents/requests/${id}`, { status, note }),
    },

    assets: {
      list: () => api.get('/assets'),
      movements: (limit) => api.get(`/assets/movements${qs({ limit })}`),
      addAsset: (draft) => api.post('/assets', draft),
      kpi: () => api.get('/assets/kpi'),
      requests: () => api.get('/assets/requests'),
      openRequests: () => api.get('/assets/requests/open'),
      pendingRecovery: () => api.get('/assets/recovery'),
      requestAsset: (draft) => api.post('/assets/requests', draft),
      actOnRequest: (id, status) => api.put(`/assets/requests/${id}`, { status }),
      allocate: (assetId, empId) => api.post(`/assets/${assetId}/allocate`, { empId }),
      markReturned: (assetId) => api.post(`/assets/${assetId}/return`),
    },

    noticeboard: {
      announcements: () => api.get('/announcements'),
      celebrations: (days) => api.get(`/celebrations${qs({ days: String(days) })}`),
      post: (draft) => api.post('/announcements', draft),
      setPinned: (id, pinned) => api.put(`/announcements/${id}/pinned`, { pinned }),
      remove: (id) => api.del(`/announcements/${id}`),
    },

    timesheet: {
      list: (q) => api.get(`/timesheets${qs({
        empIds: q.empIds?.join(','), weekStart: q.weekStart, since: q.since, status: q.status,
      })}`),
      forWeek: (empId, weekStart) => api.get(`/timesheets/${empId}/${weekStart}`),
      addRow: (id, proj, task) => api.post(`/timesheets/${id}/rows`, { proj, task }),
      removeRow: (id, rowIndex) => api.del(`/timesheets/${id}/rows/${rowIndex}`),
      setRow: (id, rowIndex, patch) => api.put(`/timesheets/${id}/rows/${rowIndex}`, patch),
      setHours: (id, rowIndex, dayIndex, hours) =>
        api.put(`/timesheets/${id}/rows/${rowIndex}/days/${dayIndex}`, { hours }),
      setEntryNote: (id, rowIndex, dayIndex, note) =>
        api.put(`/timesheets/${id}/rows/${rowIndex}/days/${dayIndex}/note`, { note }),
      submit: (id) => api.post(`/timesheets/${id}/submit`),
      recall: (id) => api.post(`/timesheets/${id}/recall`),
      /*
       * approverId is not sent. The server takes the approver from the session
       * token, for the same reason `visible()` ignores its caller argument:
       * an approver the client can name is an approver the client can forge.
       */
      approve: (id) => api.post(`/timesheets/${id}/approve`),
      reject: (id, _approverId, note) => api.post(`/timesheets/${id}/reject`, { note }),
    },

    joiners: {
      request: (draft) => api.post('/joiners', draft),
      list: (status) => api.get(`/joiners${qs({ status })}`),
      approve: (id, note) => api.post(`/joiners/${id}/approve`, { note }),
      reject: (id, note) => api.post(`/joiners/${id}/reject`, { note }),
    },

    config: {
      sites: () => api.get('/config/sites'),
      holidays: () => api.get('/config/holidays'),
      setLeaveQuota: (typeId, quota) =>
        api.put(`/config/leave-types/${typeId}/quota`, { quota }),
      addHoliday: (date, name, optional) =>
        api.post('/config/holidays', { date, name, optional }),
    },

    leave: {
      list: (q) => api.get<LeaveRequest[]>(`/leave${qs({
        empIds: q.empIds?.join(','), status: q.status,
      })}`),
      balances: (empId) => api.get(`/leave/balances/${empId}`),
      balance: (empId, type) => api.get(`/leave/balances/${empId}${qs({ type })}`),
      balancesFor: (empIds) =>
        (empIds.length ? api.get(`/leave/balances${qs({ empIds: empIds.join(',') })}`)
          : Promise.resolve({})),
      apply: (req) => api.post<LeaveRequest>('/leave', {
        employeeId: req.empId, typeCode: req.type, startsOn: req.from,
        endsOn: req.to, days: req.days, reason: req.reason, half: req.half,
      }),
      approve: (id: string) => api.post<LeaveRequest>(`/leave/${id}/approve`),
      reject: (id: string, _approverId: string, note?: string) =>
        api.post<LeaveRequest>(`/leave/${id}/reject`, { note }),
      cancel: (id: string) => api.post<LeaveRequest>(`/leave/${id}/cancel`),
    },
  };
}

/**
 * Build a Services where the mapped methods use HTTP and the rest use `base`.
 *
 * Per-service shallow merge: the mock instance keeps its own internal state and
 * closures, and only the named methods are replaced.
 */
export function createHttpServices(base: Services): Services {
  const live = liveMethods();
  const merged = { ...base } as Record<string, unknown>;

  for (const [name, overrides] of Object.entries(live)) {
    const original = (base as unknown as Record<string, object>)[name];
    merged[name] = { ...original, ...overrides };
  }
  return merged as unknown as Services;
}

/** How much of the contract is real, for the startup log and the README. */
export function liveMethodCount(): { live: number; services: number } {
  const live = liveMethods();
  return {
    live: Object.values(live).reduce((n, s) => n + Object.keys(s ?? {}).length, 0),
    services: Object.keys(live).length,
  };
}
