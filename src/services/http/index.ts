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
       * `profile` waited on payroll. The route existed all along but answered
       * three of the contract's eighteen fields, so claiming it here would
       * have rendered blank rows — worse than not claiming it. Compensation
       * landed, the server composite now fills all eighteen, and the drawer
       * reads it.
       *
       * Pay comes back empty rather than refused for a manager reading a
       * report; `canSeeComp` in the drawer already declined to render it.
       */
      profile: (id: string) => api.get(`/employees/${id}/profile`),
    },

    attendance: {
      list: (q) => api.get(`/attendance${qs({
        empIds: q.empIds?.join(','), from: q.from, to: q.to,
        regularisedOnly: q.regularisedOnly ? 'true' : undefined,
      })}`),
      forDay: (empId, date) => api.get(`/attendance/${empId}/${date}`),
      locationNotice: () => api.get('/attendance/location-notice'),
      acknowledgeLocationNotice: () => api.post('/attendance/location-notice'),
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
      createArticle: (draft) => api.post('/helpdesk/kb', draft),
      updateArticle: (id, patch) => api.put(`/helpdesk/kb/${id}`, patch),
      removeArticle: (id) => api.del(`/helpdesk/kb/${id}`),
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

    compensation: {
      components: () => api.get('/compensation/components'),
      saveComponent: (draft) => api.post('/compensation/components', draft),
      removeComponent: (code) => api.del(`/compensation/components/${code}`),
      setStructure: (empId, draft) => api.post(`/compensation/${empId}`, draft),
      /* Own history lives under payroll, which is where the `own` scope is. */
      history: (empId) => api.get(`/payroll/structure/${empId}/history`),
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
       * The tax half. The server's rules.ts already carried both regimes, the
       * slab engine and the HRA test, so these compute against real salary
       * structures rather than a mock.
       *
       * What is still absent is the landlord's PAN: Rule 26C wants it once
       * annual rent passes a lakh, the column that would hold it is plain
       * text, and 0003 decided not to keep tax identifiers that way. The
       * service refuses that one item rather than reversing the decision
       * quietly — so an HRA claim above that threshold is incomplete until
       * somebody rules on it.
       */
      declarations: () => api.get('/tax/declarations'),
      taxRows: () => api.get('/tax/rows'),
      taxSummary: (empId) => api.get(`/tax/${empId}/summary`),
      saveDeclaration: (empId, items) => api.put(`/tax/${empId}`, { items }),
      setRegime: (empId, regime) => api.put(`/tax/${empId}/regime`, { regime }),
      submitProofs: (empId) => api.post(`/tax/${empId}/proofs`),
      verifyDeclaration: (empId) => api.post(`/tax/${empId}/verify`),
    },

    approvals: {
      /*
       * The caller argument is ignored on all three: the server scopes to the
       * session. Sending who you are so the server can decide what you may
       * approve would make the boundary a suggestion.
       */
      pending: () => api.get('/approvals/pending'),
      pendingCount: () => api.get('/approvals/count'),
      navBadges: () => api.get('/approvals/badges'),
    },

    staffing: {
      kpi: () => api.get('/staffing/kpi'),
      clients: () => api.get('/staffing/clients'),
      sows: () => api.get('/staffing/sows'),
      rateCards: () => api.get('/staffing/rate-cards'),
      consultants: () => api.get('/staffing/consultants'),
      bench: () => api.get('/staffing/bench'),
      vendors: () => api.get('/staffing/vendors'),
      invoices: () => api.get('/staffing/invoices'),
      placements: () => api.get('/staffing/placements'),
      submissions: () => api.get('/staffing/submissions'),
      requirements: () => api.get('/staffing/requirements'),
      openRequirements: () => api.get('/staffing/requirements/open'),
      moveSubmission: (id, stage) =>
        api.put(`/staffing/submissions/${id}/stage`, { stage }),
      matchesForConsultant: (id) => api.get(`/staffing/consultants/${id}/matches`),
      matchesForRequirement: (id) => api.get(`/staffing/requirements/${id}/matches`),
      redeploymentPlan: () => api.get('/staffing/redeployment'),
      benchStanding: (id) => api.get(`/staffing/consultants/${id}/bench-standing`),
    },

    benefits: {
      fbpTotals: (empIds) =>
        (empIds.length ? api.get(`/fbp/totals${qs({ empIds: empIds.join(',') })}`)
          : Promise.resolve({})),
      fbpPlan: (empId) => api.get(`/fbp/${empId}`),
      fbpRows: () => api.get('/fbp/rows'),
      declareFbp: (empId, alloc) => api.put(`/fbp/${empId}`, { alloc }),
      insuranceCover: () => api.get('/fbp/insurance'),
    },

    engagement: {
      surveys: () => api.get('/surveys'),
      enpsOf: (surveyId) => api.get(`/surveys/${surveyId}/enps`),
      enpsHistory: () => api.get('/surveys/enps-history'),
      surveyQuestions: (surveyId) => api.get(`/surveys/${surveyId}/questions`),
      respondToSurvey: (surveyId, answers) =>
        api.post(`/surveys/${surveyId}/responses`, { answers }),
    },

    learning: {
      courses: () => api.get('/learning/courses'),
      enrolments: (empIds) =>
        api.get(`/learning/enrolments${qs({ empIds: empIds?.join(',') })}`),
      enrol: (empId, courseId) => api.post('/learning/enrolments', { empId, courseId }),
      setProgress: (empId, courseId, progress) =>
        api.put(`/learning/enrolments/${empId}/${courseId}`, { progress }),
    },

    loans: {
      list: (status) => api.get(`/loans${qs({ status })}`),
      approve: (id) => api.post(`/loans/${id}/approve`),
    },

    security: {
      audit: (cat, sev) => api.get(`/security/audit${qs({ cat, sev })}`),
      auditCategories: () => api.get('/security/audit/categories'),
      controls: () => api.get('/security/controls'),
      retention: () => api.get('/security/retention'),
      /*
       * There is no `posture` here, and none on the mock either. It reported
       * device state nothing in this system can observe; keeping it on the
       * mock meant the demo showed invented percentages and a configured build
       * showed zeros. See src/data/security.ts for the full note.
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
      /*
       * `letterContext` is deliberately NOT here. It carries the salary
       * structure a letter quotes, which is payroll data this deployment does
       * not hold — the same reason `employees.profile` stays on the mock. A
       * partial response would typecheck and print a letter with blank pay.
       */
      documents: (empIds) => api.get(`/documents${qs({ empIds: empIds?.join(',') })}`),
      documentTypes: () => api.get('/documents/types'),
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
      projects: () => api.get('/projects'),
      list: (q) => api.get(`/timesheets${qs({
        empIds: q.empIds?.join(','), weekStart: q.weekStart, since: q.since, status: q.status,
      })}`),
      forWeek: (empId, weekStart) => api.get(`/timesheets/${empId}/${weekStart}`),
      addEntry: (id, draft) => api.post(`/timesheets/${id}/entries`, draft),
      updateEntry: (id, entryId, patch) =>
        api.put(`/timesheets/${id}/entries/${entryId}`, patch),
      removeEntry: (id, entryId) => api.del(`/timesheets/${id}/entries/${entryId}`),
      setComment: (id, note) => api.put(`/timesheets/${id}/comment`, { note }),
      copyPreviousWeek: (id) => api.post(`/timesheets/${id}/copy-previous`),
      submit: (id) => api.post(`/timesheets/${id}/submit`),
      recall: (id) => api.post(`/timesheets/${id}/recall`),
      /*
       * The approver is not sent. The server takes it from the session token,
       * for the same reason `visible()` ignores its caller argument: an
       * approver the client can name is an approver the client can forge.
       */
      decide: (id, decision, note) =>
        api.post(`/timesheets/${id}/decide`, { decision: decision.toLowerCase(), note }),
    },

    joiners: {
      request: (draft) => api.post('/joiners', draft),
      list: (status) => api.get(`/joiners${qs({ status })}`),
      approve: (id, note) => api.post(`/joiners/${id}/approve`, { note }),
      reject: (id, note) => api.post(`/joiners/${id}/reject`, { note }),
    },

    config: {
      sites: () => api.get('/config/sites'),
      departments: () => api.get('/config/departments'),
      createDepartment: (draft) => api.post('/config/departments', draft),
      updateDepartment: (code, patch) => api.put(`/config/departments/${code}`, patch),
      removeDepartment: (code) => api.del(`/config/departments/${code}`),
      holidays: () => api.get('/config/holidays'),
      /*
       * `PUT /config/sites/:code/fence` had been routed and guarded on the
       * server since the config module was written, and was simply never
       * mapped here — so moving a site's geo-fence went to the mock and was
       * lost on reload. checks/reachable.ts could not see it: it asks whether
       * live methods have screen callers, and an unmapped method is not live.
       */
      updateFence: (siteId, patch) =>
        api.put(`/config/sites/${siteId}/fence`, patch),
      createSite: (draft) => api.post('/config/sites', draft),
      updateSite: (siteId, patch) => api.put(`/config/sites/${siteId}`, patch),
      setSiteActive: (siteId, active) =>
        api.put(`/config/sites/${siteId}/active`, { active }),
      setLeaveQuota: (typeId, quota) =>
        api.put(`/config/leave-types/${typeId}/quota`, { quota }),
      permissions: () => api.get('/config/permissions'),
      setPermissions: (_c, patches) => api.put('/config/permissions', { patches }),
      resetPermissions: (_c, module) => api.post('/config/permissions/reset', { module }),
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

    shifts: {
      profiles: () => api.get('/shifts'),
      todayCoverage: () => api.get('/shifts/coverage'),
      roster: (empIds, from, days) =>
        (empIds.length
          ? api.get(`/shifts/roster${qs({ empIds: empIds.join(','), from, days: String(days) })}`)
          : Promise.resolve({})),
      /*
       * A profile change is a change to the person, so it hangs off the
       * employee rather than off a date — migration 0015 dropped the per-day
       * roster the old signature assumed.
       */
      setShift: (empId, shiftCode) =>
        api.put(`/employees/${empId}/shift`, { shift: shiftCode }),
      overtime: (empIds, status) =>
        api.get(`/overtime${qs({ empIds: empIds?.join(','), status })}`),
      raiseOvertime: (o) => api.post('/overtime', o),
      /* No approver argument: the server takes it from the session. */
      approveOvertime: (id) => api.post(`/overtime/${id}/approve`),
      rejectOvertime: (id) => api.post(`/overtime/${id}/reject`),
    },

    letters: {
      types: () => api.get('/letters/types'),
      requests: (status) => api.get(`/letters${qs({ status })}`),
      /* No empId: the server takes the requester from the session. */
      request: (draft) => api.post('/letters', draft),
      issue: (id) => api.post(`/letters/${id}/issue`),
      reject: (id, reason) => api.post(`/letters/${id}/reject`, { reason }),
    },
    /*
     * The five modules the 0032-0036 migrations brought with them.
     *
     * Every method here ignores its `caller` argument, as the rest of this
     * file does: the server derives the caller from the session token, and
     * sending scope from the client would make it a suggestion rather than a
     * boundary.
     */
    jobTitles: {
      list: (_c, f = {}) => api.get(`/job-titles${qs({
        q: f.q, dept: f.dept, family: f.family, level: f.level,
        empType: f.empType, status: f.status,
      })}`),
      get: (_c, id) => api.get(`/job-titles/${id}`),
      mine: () => api.get('/job-titles/mine'),
      create: (_c, draft) => api.post('/job-titles', draft),
      update: (_c, id, patch) => api.patch(`/job-titles/${id}`, patch),
      setStatus: (_c, id, status) => api.put(`/job-titles/${id}/status`, { status }),
      remove: (_c, id) => api.del(`/job-titles/${id}`),
    },

    lifecycle: {
      list: (_c, f = {}) => api.get(`/lifecycle${qs({
        q: f.q, stage: f.stage, dept: f.dept, managerId: f.managerId,
        site: f.site, from: f.from, to: f.to,
      })}`),
      get: (_c, id) => api.get(`/lifecycle/${id}`),
      stats: () => api.get('/lifecycle/stats'),
      addTask: (_c, empId, draft) => api.post(`/lifecycle/${empId}/tasks`, draft),
      setTaskDone: (_c, taskId, done) =>
        api.put(`/lifecycle/tasks/${taskId}/done`, { done }),
      removeTask: (_c, taskId) => api.del(`/lifecycle/tasks/${taskId}`),
    },

    software: {
      list: (_c, f = {}) => api.get(`/software${qs({
        q: f.q, cat: f.cat, vendor: f.vendor, status: f.status, ownerId: f.ownerId,
        renewingWithin: f.renewingWithin,
        hasDormant: f.hasDormant ? 'true' : undefined,
      })}`),
      get: (_c, id) => api.get(`/software/${id}`),
      mine: () => api.get('/software/mine'),
      stats: () => api.get('/software/stats'),
      renewals: (_c, withinDays) => api.get(`/software/renewals${qs({ within: withinDays })}`),
      create: (_c, draft) => api.post('/software', draft),
      update: (_c, id, patch) => api.patch(`/software/${id}`, patch),
      remove: (_c, id) => api.del(`/software/${id}`),
      assignSeat: (_c, productId, empId) =>
        api.post(`/software/${productId}/seats`, { empId }),
      revokeSeat: (_c, seatId) => api.del(`/software/seats/${seatId}`),
    },

    devPlans: {
      list: (_c, f = {}) => api.get(`/dev-plans${qs({
        q: f.q, status: f.status, dept: f.dept, managerId: f.managerId,
        mentorId: f.mentorId, area: f.area,
        endorsed: f.endorsed === undefined ? undefined : String(f.endorsed),
        reviewDue: f.reviewDue ? 'true' : undefined,
        overdueOnly: f.overdueOnly ? 'true' : undefined,
      })}`),
      get: (_c, id) => api.get(`/dev-plans/${id}`),
      mine: () => api.get('/dev-plans/mine'),
      stats: () => api.get('/dev-plans/stats'),
      focus: () => api.get('/dev-plans/focus'),
      mentors: () => api.get('/dev-plans/mentors'),
      mentorOptions: () => api.get('/dev-plans/mentor-options'),
      create: (_c, draft) => api.post('/dev-plans', draft),
      update: (_c, id, patch) => api.patch(`/dev-plans/${id}`, patch),
      endorse: (_c, id) => api.post(`/dev-plans/${id}/endorse`),
      setStatus: (_c, id, status) => api.put(`/dev-plans/${id}/status`, { status }),
      setReview: (_c, id, on) => api.put(`/dev-plans/${id}/review`, { on }),
      addAction: (_c, planId, draft) => api.post(`/dev-plans/${planId}/actions`, draft),
      setActionDone: (_c, actionId, done) =>
        api.put(`/dev-plans/actions/${actionId}/done`, { done }),
      removeAction: (_c, actionId) => api.del(`/dev-plans/actions/${actionId}`),
    },

    events: {
      list: (_c, f = {}) => api.get(`/events${qs({
        q: f.q, type: f.type, status: f.status, site: f.site,
        organiserId: f.organiserId, when: f.when,
        mineOnly: f.mineOnly ? 'true' : undefined,
        from: f.from, to: f.to,
      })}`),
      get: (_c, id) => api.get(`/events/${id}`),
      mine: () => api.get('/events/mine'),
      stats: () => api.get('/events/stats'),
      create: (_c, draft) => api.post('/events', draft),
      update: (_c, id, patch) => api.patch(`/events/${id}`, patch),
      publish: (_c, id) => api.post(`/events/${id}/publish`),
      cancel: (_c, id, reason) => api.post(`/events/${id}/cancel`, { reason }),
      remove: (_c, id) => api.del(`/events/${id}`),
      rsvp: (_c, eventId, choice) => api.post(`/events/${eventId}/rsvp`, { choice }),
      withdraw: (_c, eventId) => api.del(`/events/${eventId}/rsvp`),
      markAttendance: (_c, eventId, empId, attended) =>
        api.put(`/events/${eventId}/attendance`, { empId, attended }),
    },

    /*
     * The recruitment desk and user administration.
     *
     * Both had tables (0029, 0030) and no service, so the screens ran on the
     * demo dataset against a live schema — the worst of the two, because the
     * data looked real. `kpi` and `funnel` take a filter the server reads
     * from the query string; the rest is ordinary REST.
     */
    recruitment: {
      jobOrders: (f = {}) => api.get(`/recruitment/job-orders${qs({
        from: f.from, to: f.to, clientId: f.clientId, recruiterId: f.recruiterId,
        reqId: f.reqId, industry: f.industry, tech: f.tech, location: f.location,
        status: f.status, priority: f.priority,
      })}`),
      jobOrder: (id) => api.get(`/recruitment/job-orders/${id}`),
      createJobOrder: (draft) => api.post('/recruitment/job-orders', draft),
      updateJobOrder: (id, patch) => api.patch(`/recruitment/job-orders/${id}`, patch),
      assign: (id, draft) => api.post(`/recruitment/job-orders/${id}/assign`, draft),
      release: (id, assignmentId) =>
        api.post(`/recruitment/job-orders/${id}/release`, { assignmentId }),
      logActivity: (id, kind, summary, qty) =>
        api.post(`/recruitment/job-orders/${id}/activity`, { kind, summary, qty }),
      myJobs: (recruiterId) => api.get(`/recruitment/my-jobs/${recruiterId}`),
      kpi: (f = {}) => api.get(`/recruitment/kpi${qs({
        from: f.from, to: f.to, clientId: f.clientId, recruiterId: f.recruiterId,
        status: f.status, priority: f.priority,
      })}`),
      funnel: (f = {}) => api.get(`/recruitment/funnel${qs({
        from: f.from, to: f.to, clientId: f.clientId, recruiterId: f.recruiterId,
        status: f.status, priority: f.priority,
      })}`),
    },

    users: {
      list: (_c, f = {}) => api.get(`/users${qs({
        q: f.q, status: f.status, role: f.role, dept: f.dept, site: f.site,
        managerId: f.managerId, empType: f.empType,
        joinedFrom: f.joinedFrom, joinedTo: f.joinedTo,
      })}`),
      get: (_c, id) => api.get(`/users/${id}`),
      stats: () => api.get('/users/stats'),
      nextEmployeeCode: () => api.get('/users/next-code'),
      create: (_c, draft) => api.post('/users', draft),
      update: (_c, id, patch) => api.patch(`/users/${id}`, patch),
      setStatus: (_c, id, status, reason) =>
        api.put(`/users/${id}/status`, { status, reason }),
      /* A POST, because it carries the typed confirmation in a body. */
      remove: (_c, id, typed) => api.post(`/users/${id}/delete`, { typed }),
      decide: (_c, id, decision, note) =>
        api.post(`/users/${id}/decide`, { decision, note }),
      invite: (_c, id) => api.post(`/users/${id}/invite`),
      resendInvitation: (_c, id) => api.post(`/users/${id}/resend-invitation`),
      resetPassword: (_c, id, forceChange) =>
        api.post(`/users/${id}/reset-password`, { forceChange }),
      bulkUpdate: (_c, ids, patch) => api.post('/users/bulk-update', { ids, patch }),
      lastLoginNow: (_c, method) => api.post('/users/me/last-login', { method }),
      signOut: (_c, reason) => api.post('/users/me/sign-out', { reason }),
      /* No id is your own, which is a different route rather than a null id. */
      loginHistory: (_c, empId) => (empId
        ? api.get(`/users/${empId}/login-history`)
        : api.get('/users/me/login-history')),
      tenantLoginHistory: () => api.get('/users/login-history'),
      accountStatus: () => api.get('/users/me/account-status'),
      setMfaRequired: (_c, id, required) =>
        api.put(`/users/${id}/mfa-required`, { required }),
      passwordChanged: () => api.post('/users/me/password-changed'),
    },

    /*
     * Saved reports and integration settings.
     *
     * `run` is a POST although it reads: it bumps the run counters and, because
     * it goes through the export path, writes a row to the export register. A
     * GET that leaves an audit record is what a prefetch turns into a false one.
     */
    reports: {
      list: () => api.get('/reports/saved'),
      datasets: () => api.get('/reports/saved/datasets'),
      run: (_c, id) => api.post(`/reports/saved/${id}/run`),
      create: (_c, draft) => api.post('/reports/saved', draft),
      update: (_c, id, patch) => api.patch(`/reports/saved/${id}`, patch),
      remove: (_c, id) => api.del(`/reports/saved/${id}`),
      duplicate: (_c, id) => api.post(`/reports/saved/${id}/duplicate`),
    },

    integrations: {
      list: () => api.get('/integrations'),
      stats: () => api.get('/integrations/stats'),
      webhooks: () => api.get('/integrations/webhooks'),
      createWebhook: (_c, draft) => api.post('/integrations/webhooks', draft),
      setWebhookActive: (_c, id, active) =>
        api.put(`/integrations/webhooks/${id}/active`, { active }),
      removeWebhook: (_c, id) => api.del(`/integrations/webhooks/${id}`),
      apiKeys: () => api.get('/integrations/keys'),
      scopes: () => api.get('/integrations/scopes'),
      createApiKey: (_c, draft) => api.post('/integrations/keys', draft),
      revokeApiKey: (_c, id) => api.post(`/integrations/keys/${id}/revoke`),
    },

    /*
     * The export centre.
     *
     * The server offers a shorter catalogue than the mock does — three
     * datasets against eight — because the other five have no tables yet.
     * That is deliberate and visible: `datasets` comes from the server, so
     * against a real API the screen lists what can actually be built rather
     * than offering a dataset that would download an empty file.
     *
     * `run` is a POST although it reads, because it writes the register
     * entry. A GET that leaves a row in an audit log is what a retry, a
     * prefetch or a link preview turns into a false record of somebody
     * taking data out.
     */
    exports: {
      datasets: () => api.get('/exports/datasets'),
      history: (_c, f = {}) => api.get(`/exports/history${qs({
        q: f.q, datasetId: f.datasetId, byId: f.byId, outcome: f.outcome,
        personalOnly: f.personalOnly ? 'true' : undefined,
        from: f.from, to: f.to,
      })}`),
      stats: () => api.get('/exports/stats'),
      run: (_c, req) => api.post('/exports/run', req),
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
