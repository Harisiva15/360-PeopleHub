/**
 * The service contracts.
 *
 * Screens talk to these interfaces and never to `src/data` directly, so the
 * dataset can be replaced by a real API without touching a single view. Two
 * rules keep that promise honest:
 *
 *   1. Everything that reads or writes *records* is async. A network round
 *      trip cannot be retrofitted onto a synchronous call site, so the
 *      asynchrony is in the contract from the start even though the mock
 *      resolves immediately.
 *   2. Derived figures that a server would compute — payslips, payroll
 *      totals, leave balances, staffing KPIs — are service calls too, not
 *      helpers the screen runs over fetched rows. Otherwise the business
 *      logic stays welded to the client.
 *
 * Static configuration (departments, sites, grades, leave types, currencies)
 * is deliberately *not* here — it lives in `src/reference` and stays
 * synchronous. See that module for why.
 */

import type { AppRole, Employee } from '../types/employee';
import type { FbpPlan } from '../data/benefits';
import type { LeaveBalance, LeaveRequest, LeaveStatus } from '../data/leave';
import type { AttRecord } from '../data/attendance';
import type { Timesheet, TSStatus } from '../data/timesheet';
import type { Advance, Claim, ClaimStatus, ExpItem } from '../data/expenses';
import type { Asset } from '../types/asset';
import type { EmpDoc } from '../data/announcements';
import type { Ticket } from '../data/helpdesk';
import type { LifecycleEvent } from '../data/lifecycle';
import type { Loan } from '../data/loans';
import type { Goal, Praise } from '../data/performance';
import type { ExitRecord } from '../data/exit';
import type { SalaryStructure } from '../data/salary';
import type { Declaration, DeclTotals, PayInput, PayRun, Payslip, PayrollTotals } from '../data/payroll';
import type { INTax } from '../data/salary';
import type { BankBatch, CompliancePayment } from '../data/payinputs';
import type { Overtime } from '../data/shifts';
import type { LetterRequest } from '../data/letters';
import type { Candidate, Interview, Requisition } from '../data/ats';
import type { CheckIn, Review, Cycle } from '../data/performance';
import type { Ytd } from '../data/letters';
import type { Course, Enrollment } from '../data/learning';
import type { Survey } from '../data/engagement';
import type { Announcement, Celebration } from '../data/announcements';
import type {
  ActivityKind, AssignRole, Client, Consultant, EmploymentType, Invoice, JobActivity,
  JobAssignment, JobPriority, JobStatus, JobType, Placement, RateCard, SlaStanding, Sow,
  StaffingKPI, StaffingRequirement, Submission, Vendor, WorkMode,
} from '../data/staffing';
import type { MatchExplain } from '../data/matching';
import type { AssetRequest } from '../data/assetWorkflow';
import type { AuditEntry, Control, PostureRecord, RetentionRow, Severity } from '../data/security';
import type { FnF } from '../data/exit';
import type { Onboarding } from '../data/onboarding';
import type { Holiday, Site } from '../types/org';

/* Row shapes screens render. Re-exported so a view imports them from the
   service it calls, not from the dataset behind it. */
export type { Employee } from '../types/employee';
export type { FbpComponent, FbpPlan } from '../data/benefits';
export type { LeaveRequest, LeaveStatus } from '../data/leave';
export type { AttRecord, AttStatus, Regularisation } from '../data/attendance';
export type { Timesheet, TSEntry, TSStatus } from '../data/timesheet';
export type { Advance, Claim, ClaimStatus, ExpItem } from '../data/expenses';
export type { Asset } from '../types/asset';
export type { EmpDoc } from '../data/announcements';
export type { Ticket } from '../data/helpdesk';
export type { Enrollment } from '../data/learning';
export type { LifecycleEvent } from '../data/lifecycle';
export type { Loan } from '../data/loans';
export type { Goal, Praise } from '../data/performance';
export type { ExitRecord } from '../data/exit';
export type { SalaryStructure } from '../data/salary';
export type { Declaration, DeclTotals, PayInput, PayRun, Payslip, PayrollTotals } from '../data/payroll';
export type { INTax } from '../data/salary';
export type { BankBatch, CompliancePayment } from '../data/payinputs';
export type { Overtime } from '../data/shifts';
export type { LetterRequest } from '../data/letters';
export type { Candidate, Interview, Requisition } from '../data/ats';
export type { CheckIn, Review, Cycle } from '../data/performance';
export type { Ytd } from '../data/letters';
export type { Course } from '../data/learning';
export type { Survey } from '../data/engagement';
export type { Announcement, Celebration } from '../data/announcements';
export type {
  ActivityKind, AssignRole, Client, Consultant, EmploymentType, Invoice, JobActivity,
  JobAssignment, JobPriority, JobStatus, JobType, Placement, RateCard, SlaStanding, SlaState,
  Sow, StaffingKPI, StaffingRequirement, Submission, Vendor, WorkMode,
} from '../data/staffing';
export type { MatchExplain } from '../data/matching';
export type { AssetRequest } from '../data/assetWorkflow';
export type { Onboarding } from '../data/onboarding';
export type { Holiday, Site } from '../types/org';
export type { AuditEntry, Control, PostureRecord, RetentionRow, Severity } from '../data/security';

/** Who is asking. Every read is scoped to this, the way an API would scope to a token. */
export interface Caller {
  role: AppRole;
  meId: string;
}

/* ---------- employees ---------- */

/**
 * Everything the profile drawer renders, in one response.
 *
 * A real API would expose this as GET /employees/{id}/profile rather than
 * make the screen fan out fourteen calls, so the contract says so here.
 */
export interface EmployeeProfile {
  employee: Employee;
  managerName: string;
  reports: Employee[];
  salary: SalaryStructure;
  /** Monthly basic and allowance totals, already computed. */
  compMonthly: { basic: number; allowance: number };
  taxRegime: string;
  taxStatus: string;
  /** The current month's attendance, for the presence tile. */
  attendanceThisMonth: AttRecord[];
  leaveBalances: LeaveBalanceRow[];
  assets: Asset[];
  documents: EmpDoc[];
  claims: Claim[];
  tickets: Ticket[];
  coursesCompleted: number;
  praiseReceived: number;
  goals: Goal[];
  loans: Loan[];
  lifecycle: LifecycleEvent[];
  exit: ExitRecord | null;
}

export interface EmployeeService {
  /** Everyone the caller may see — the whole company, their tree, or themselves. */
  visible(c: Caller): Promise<Employee[]>;
  byId(id: string): Promise<Employee | null>;
  /** Resolved in bulk; screens should not fetch a directory one row at a time. */
  byIds(ids: string[]): Promise<Employee[]>;
  active(): Promise<Employee[]>;
  /** Leavers — the directory can switch to them. */
  exited(): Promise<Employee[]>;
  /** Direct reports, or the whole sub-tree when `deep`. */
  team(managerId: string, deep?: boolean): Promise<Employee[]>;
  /** The composite behind the profile drawer. */
  profile(id: string): Promise<EmployeeProfile | null>;
  setRole(id: string, role: AppRole): Promise<Employee>;
}

/* ---------- attendance ---------- */

export interface AttendanceQuery {
  empIds?: string[];
  /** Inclusive `YYYY-MM-DD` bounds. */
  from?: string;
  to?: string;
  /** Only days carrying a regularisation request. */
  regularisedOnly?: boolean;
}

export interface PunchAt {
  /** Work mode: an office site code, or WFH / CLIENT. WFH records a W day. */
  site: string;
  /**
   * Where the device says it is. The server recomputes the distance and the
   * fence verdict from these — it does not accept either from the client,
   * because a browser can claim it was inside the fence from anywhere.
   */
  lat: number | null;
  lng: number | null;
  src: string;
  /**
   * When the punch happened, as an ISO-8601 instant.
   *
   * Not 'HH:MM'. A wall-clock time is ambiguous the moment shifts carry
   * timezones — 09:20 is on time in Chennai and four hours early against New
   * York hours, and the string alone cannot say which. The server renders it
   * back in the shift's own zone.
   */
  at: string;
}

/**
 * What somebody is told before a punch ever records where they are.
 *
 * Notice rather than consent: the retention register declares legitimate
 * interest as the basis, and asking somebody to agree while processing anyway
 * if they decline is worse than not asking. Until it is acknowledged the
 * server discards any coordinates sent with a punch — the punch still counts.
 */
export interface LocationNotice {
  version: number;
  title: string;
  body: readonly string[];
  /** When this person acknowledged this version, or null if they have not. */
  acknowledgedAt: string | null;
}

export interface AttendanceService {
  list(q: AttendanceQuery): Promise<AttRecord[]>;
  /** The location notice and whether this caller has seen it. */
  locationNotice(): Promise<LocationNotice>;
  /** Record that they have. Idempotent; keeps the original date. */
  acknowledgeLocationNotice(): Promise<LocationNotice>;
  forDay(empId: string, date: string): Promise<AttRecord | null>;
  /** Days worth regularising: absent, or missing one of the two punches. */
  regularisable(empId: string, since: string): Promise<AttRecord[]>;
  punchIn(empId: string, date: string, at: PunchAt): Promise<AttRecord>;
  punchOut(empId: string, date: string, at: PunchAt): Promise<AttRecord>;
  raiseRegularisation(empId: string, date: string, inT: string, outT: string, reason: string): Promise<AttRecord>;
  /** Approving credits the day as present, which is why it lives behind the service. */
  actOnRegularisation(empId: string, date: string, decision: 'Approved' | 'Rejected'): Promise<AttRecord>;
}

/* ---------- leave ---------- */

export type LeaveBalanceRow = LeaveBalance & { type: string; avail: number };

export interface LeaveQuery {
  empIds?: string[];
  status?: LeaveStatus;
}

export interface ApplyLeave {
  empId: string;
  type: string;
  from: string;
  to: string;
  days: number;
  reason: string;
  /** 'First Half' or 'Second Half' for a half day, null for whole days. */
  half: string | null;
}

export interface LeaveService {
  list(q: LeaveQuery): Promise<LeaveRequest[]>;
  /** The full balance sheet for one employee, already carrying `avail`. */
  balances(empId: string): Promise<LeaveBalanceRow[]>;
  balance(empId: string, type: string): Promise<LeaveBalanceRow | null>;
  apply(req: ApplyLeave): Promise<LeaveRequest>;
  /** Approving debits the balance, which is why it belongs behind the service. */
  approve(id: string, approverId: string): Promise<LeaveRequest>;
  reject(id: string, approverId: string, note?: string): Promise<LeaveRequest>;
  cancel(id: string): Promise<LeaveRequest>;
  /** Balance sheets for a set of employees in one call, keyed by employee id. */
  balancesFor(empIds: string[]): Promise<Record<string, LeaveBalanceRow[]>>;
}

/* ---------- timesheet ---------- */

export interface TimesheetQuery {
  empIds?: string[];
  weekStart?: string;
  /** Weeks on or after this Monday. */
  since?: string;
  status?: TSStatus;
}

/** What one line on a timesheet says. */
export interface EntryDraft {
  /** The day the work happened, as `YYYY-MM-DD`. Must fall inside the week. */
  date: string;
  /** Project code. */
  proj: string;
  task: string;
  billable?: boolean;
  hours?: number;
  remarks?: string;
}

export interface TimesheetService {
  list(q: TimesheetQuery): Promise<Timesheet[]>;
  /**
   * The sheet for one person's week, created as an empty draft if they have
   * not started it. Creation belongs here rather than in the editor, which
   * used to conjure the row mid-render.
   */
  forWeek(empId: string, weekStart: string): Promise<Timesheet>;
  /**
   * Add a line. A second line for the same project, task and day merges into
   * the first — that combination is unique in the table, and it is the same
   * work said twice.
   */
  addEntry(id: string, draft: EntryDraft): Promise<Timesheet>;
  /** Change a line. Limits are measured without its old value, not on top. */
  updateEntry(id: string, entryId: string, patch: Partial<EntryDraft>): Promise<Timesheet>;
  removeEntry(id: string, entryId: string): Promise<Timesheet>;
  /** The note to the manager. Kept apart from the lines and editable with them. */
  setComment(id: string, note: string): Promise<Timesheet>;
  /**
   * Copy last week's lines onto this one, hours included. Refuses when this
   * week already has any — somebody who has started typing and presses it
   * meant to start over, and doubling their morning is the worse guess.
   */
  copyPreviousWeek(id: string): Promise<Timesheet>;
  submit(id: string): Promise<Timesheet>;
  recall(id: string): Promise<Timesheet>;
  /**
   * Approve, return for correction, or refuse. Returned goes back to the
   * employee; rejected is terminal. Both need a reason, and neither can be
   * applied to the caller's own week.
   */
  decide(
    id: string,
    decision: 'Approved' | 'Returned' | 'Rejected',
    note?: string,
  ): Promise<Timesheet>;
}

/* ---------- expenses ---------- */

export interface ClaimQuery {
  empIds?: string[];
  status?: ClaimStatus;
}

export interface NewClaim {
  empId: string;
  title: string;
  item: Omit<ExpItem, 'id'>;
}

export interface ExpenseService {
  claims(q: ClaimQuery): Promise<Claim[]>;
  submitClaim(c: NewClaim): Promise<Claim>;
  approveClaim(id: string, approverId: string): Promise<Claim>;
  rejectClaim(id: string, approverId: string, note: string): Promise<Claim>;
  /** Marks it paid and stamps the payroll month it rides out with. */
  reimburseClaim(id: string): Promise<Claim>;

  advances(empIds?: string[]): Promise<Advance[]>;
  requestAdvance(empId: string, amount: number, reason: string): Promise<Advance>;
  approveAdvance(id: string): Promise<Advance>;
}

/* ---------- payroll ---------- */

/** One row of the payroll register: the person and their computed payslip. */
export interface RegisterRow {
  employee: Employee;
  payslip: Payslip;
  /** Loan instalment recovered in this cycle. */
  loanEmi: number;
}

/** The salary-structure view, computed rather than derived in the screen. */
export interface CompRow {
  employee: Employee;
  salary: SalaryStructure;
  basicAnnual: number;
  allowanceAnnual: number;
}

/**
 * Everything one person's tax screen needs, computed server-side: the caps in
 * declTotals, the HRA exemption and both regimes are tax rules, not display.
 */
export interface TaxSummary {
  declaration: Declaration;
  salary: SalaryStructure;
  totals: DeclTotals;
  /** HRA exempt under section 10(13A), already the least of the three tests. */
  hraExemption: number;
  oldRegime: INTax;
  newRegime: INTax;
  /** Which regime costs less on these numbers. */
  better: Declaration['regime'];
}

/** One row of the workforce-wide declaration tracker. */
export interface TaxRow {
  employee: Employee;
  declaration: Declaration;
  totals: DeclTotals;
  taxPayable: number;
}

export interface PayrollService {
  runs(): Promise<PayRun[]>;
  currentRun(): Promise<PayRun>;
  /** Gross, deductions, statutory splits and per-country totals for a cycle. */
  totals(mk: string): Promise<PayrollTotals>;
  /** Totals for several cycles at once — the trend charts want the series. */
  totalsFor(mks: string[]): Promise<Record<string, PayrollTotals>>;
  /** Everyone paid in a cycle, with their payslip already computed. */
  register(mk: string): Promise<RegisterRow[]>;
  payslip(empId: string, mk: string): Promise<Payslip>;
  /** One person's payslip history — every paid cycle since they joined. */
  payslipHistory(empId: string): Promise<{ run: PayRun; payslip: Payslip }[]>;
  /** Per-day cost for a set of people — drives leave encashment liability. */
  dailyRates(empIds: string[]): Promise<Record<string, number>>;
  /** The salary structure behind one person's own pay. */
  structure(empId: string): Promise<SalaryStructure>;
  /** Off-cycle inputs (bonus, arrears, incentive) keyed by employee. */
  inputs(mk: string): Promise<Record<string, PayInput>>;
  /** Salary structures across the workforce, for the compensation view. */
  compensation(): Promise<CompRow[]>;
  declarations(): Promise<Record<string, Declaration>>;
  /** One person's tax position for the year, with both regimes priced. */
  taxSummary(empId: string): Promise<TaxSummary>;
  /** The declaration tracker across the workforce. */
  taxRows(): Promise<TaxRow[]>;
  /** Save declared investments. Submitting stamps the date. */
  saveDeclaration(empId: string, items: Record<string, number | string>): Promise<Declaration>;
  /** Switch regime. Refuses once Finance has verified the proofs. */
  setRegime(empId: string, regime: Declaration['regime']): Promise<Declaration>;
  submitProofs(empId: string): Promise<Declaration>;
  /** Finance verifies a submitted declaration. A draft cannot be verified. */
  verifyDeclaration(empId: string): Promise<Declaration>;
  bankBatches(): Promise<BankBatch[]>;
  compliancePayments(): Promise<CompliancePayment[]>;
  activeLoans(): Promise<Loan[]>;
  /** Marks a draft cycle paid and generates its bank advice. */
  processRun(mk: string): Promise<PayRun>;
}

/* ---------- shifts, loans, letters ---------- */

export interface NewOvertime {
  empId: string;
  date: string;
  hours: number;
  reason: string;
  compensation: Overtime['compensation'];
}

/** A working-hours profile, with how many people are on it. */
export interface ShiftProfile {
  id: string;
  code: string;
  name: string;
  start: string;
  end: string;
  /** The clock these hours are measured against, as an IANA name. */
  timezone: string;
  region: string;
  night: boolean;
  flexible: boolean;
  headcount: number;
}

/**
 * Shifts and overtime.
 *
 * **A shift is a region's working hours, not a rotation.** Migration 0015
 * dropped the per-day roster table: somebody in Chennai working US hours does
 * not rotate, and the timezone — the part that decides whether a 21:30 punch
 * is late — had nowhere to live in the old model.
 *
 * So `roster` reports each person's standing profile across a span of days
 * rather than a grid somebody fills in, and `setShift` changes the person
 * rather than a day.
 */
export interface ShiftService {
  /** The working-hours profiles this tenant runs, with headcount on each. */
  profiles(): Promise<ShiftProfile[]>;
  overtime(empIds?: string[], status?: Overtime['status']): Promise<Overtime[]>;
  /**
   * Approving credits comp off when that is the compensation, which is why the
   * two happen together behind the service rather than in the screen. The
   * approver is the session, not an argument — passing it would let a caller
   * sign somebody else's name.
   */
  approveOvertime(id: string): Promise<Overtime>;
  rejectOvertime(id: string): Promise<Overtime>;
  raiseOvertime(o: NewOvertime): Promise<Overtime>;
  /**
   * Each person's shift across `days` from `from`, keyed by employee then
   * date. Every working day carries the same code; weekends come back 'OFF'.
   */
  roster(empIds: string[], from: string, days: number): Promise<Record<string, Record<string, string>>>;
  /** Move somebody onto a different profile. Takes effect now, not on a date. */
  setShift(empId: string, shiftCode: string): Promise<{ empId: string; shift: string }>;
  /** How many active people are on each shift profile. */
  todayCoverage(): Promise<Record<string, number>>;
}

export interface LoanService {
  list(status?: Loan['status']): Promise<Loan[]>;
  /** Sanctioning a loan puts it into recovery from the next payroll cycle. */
  approve(id: string): Promise<Loan>;
}

/** A letter the tenant issues. */
export interface LetterTypeRow {
  code: string;
  name: string;
  instant: boolean;
  requiresApproval: boolean;
}

export interface LetterService {
  /** The catalogue. An instant type is issued the moment it is asked for. */
  types(): Promise<LetterTypeRow[]>;
  requests(status?: LetterRequest['status']): Promise<LetterRequest[]>;
  /**
   * Ask for a letter. An instant type comes back already issued; anything else
   * joins the HR queue.
   */
  request(draft: { type: string; purpose?: string }): Promise<LetterRequest>;
  /**
   * Issue a queued letter. The text is rendered by the service from the facts
   * on file — never passed in, or the endpoint becomes a way to make the
   * company assert anything.
   */
  issue(id: string): Promise<LetterRequest>;
  /** Refuse one. The reason is shown to the employee, so it is required. */
  reject(id: string, reason: string): Promise<LetterRequest>;
}

/* ---------- hiring ---------- */

/** An interview with the candidate and requisition it belongs to, resolved. */
export interface InterviewRow {
  interview: Interview;
  candidate: Candidate | null;
  requisitionTitle: string;
}

export interface NewRequisition {
  title: string;
  dept: string;
  grade?: string;
  site?: string;
  openings: number;
  priority?: string;
  hiringManagerId: string;
  recruiterId?: string;
  budgetMin?: number;
  budgetMax?: number;
  type?: string;
  desc?: string;
  must?: string[];
  exp?: string;
}

export interface NewSubmission {
  reqId: string;
  name: string;
  email: string;
  phone?: string;
  source?: string;
  exp?: string;
  current?: string;
  ctcCur?: number;
  ctcExp?: number;
  notice?: string;
  skills?: string[];
  loc?: string;
}

/** One recruiter's activity, for the tracker. */
export interface RecruiterStat {
  recruiterId: string;
  name: string;
  openReqs: number;
  openings: number;
  submissions: number;
  inPipeline: number;
  interviews: number;
  offers: number;
  hires: number;
}

/**
 * Activity against one job order, for the recruitment tracker.
 *
 * Every count is derived from the pipeline when read, never stored. A
 * submission counter that is incremented on submit drifts the first time a
 * candidate is withdrawn and nothing notices — the requisition goes on claiming
 * activity it does not have.
 */
export interface ReqActivity {
  reqId: string;
  title: string;
  dept: string;
  site: string;
  status: string;
  priority: string;
  openings: number;
  filled: number;
  openedOn: string;
  /** Days open; counts to closure once closed, not onward to today. */
  ageDays: number;
  hiringManagerId: string;
  recruiterId: string;
  /** Candidates ever submitted against this job order. */
  submissions: number;
  /** Still in play — neither hired nor rejected. */
  active: number;
  rejected: number;
  /** Head count per pipeline stage, keyed by stage id. Absent stages are zero. */
  byStage: Record<string, number>;
  interviews: number;
  interviewsDone: number;
  offers: number;
  hires: number;
  /**
   * The latest submission, interview or offer. An open job order with no
   * activity for weeks is the finding worth surfacing, and counts alone cannot
   * show it.
   */
  lastActivity: string | null;
}

export interface HiringService {
  /** The panel member's own upcoming interviews. */
  interviewsFor(panelId: string, status?: Interview['status']): Promise<InterviewRow[]>;
  /** The whole interview schedule — the hiring screens filter it themselves. */
  interviews(): Promise<Interview[]>;
  /**
   * Move a candidate to another pipeline stage. Refuses an unknown stage, and
   * refuses a move that would fill more openings than the requisition has.
   */
  moveCandidate(candId: string, stage: string): Promise<Candidate>;
  candidates(): Promise<Candidate[]>;
  requisitions(): Promise<Requisition[]>;
  /** Open a new role. Returns the whole board, which the screens re-render. */
  openRequisition(draft: NewRequisition): Promise<Requisition[]>;
  /** Submit a candidate against a role. Refuses a duplicate and a closed role. */
  submitCandidate(draft: NewSubmission): Promise<Candidate>;
  /** Per-recruiter activity: requisitions, submissions, interviews, hires. */
  recruiterTracker(): Promise<RecruiterStat[]>;
  /** Per-job-order activity: submissions, who is still active, and where. */
  requisitionTracker(): Promise<ReqActivity[]>;

  /** Book a round with a panel member. Refuses a clash on their calendar. */
  scheduleInterview(draft: NewInterview): Promise<Interview>;
  /**
   * Record the outcome. A verdict without a completed interview is not
   * representable, so this sets both.
   */
  submitFeedback(id: string, verdict: InterviewVerdict, feedback: string): Promise<Interview>;
  /**
   * Draft an offer. One live offer per candidate, and it starts as a draft —
   * making an offer and sending it are two decisions.
   */
  makeOffer(draft: NewOffer): Promise<Candidate>;
  /**
   * The offer letter. Rendered from the offer while it is a draft, and read
   * back verbatim once released — a letter that re-renders from a salary that
   * has since moved would quietly rewrite what the company promised.
   */
  offerLetter(candId: string): Promise<string>;
  /** Send the offer, freezing the letter onto it. Refuses one already sent. */
  releaseOffer(candId: string): Promise<Candidate>;
  /** Record the candidate's answer; accepting moves them to hired. */
  respondToOffer(candId: string, response: OfferResponse): Promise<Candidate>;
}

export type InterviewVerdict = 'strong_hire' | 'hire' | 'hold' | 'no_hire';
export type OfferResponse = 'accepted' | 'declined' | 'negotiating';

export interface NewInterview {
  candId: string;
  round: string;
  panelId: string;
  /** ISO instant. */
  at: string;
  mode?: string;
}

export interface NewOffer {
  candId: string;
  designation: string;
  ctc: number;
  grade?: string;
  /** Joining date. */
  doj: string;
}

/* ---------- people operations ---------- */

export interface PerformanceService {
  goals(empIds?: string[]): Promise<Goal[]>;
  reviews(empIds?: string[]): Promise<Review[]>;
  praise(): Promise<Praise[]>;
  currentCycle(): Promise<Cycle>;
  /** 1:1 check-ins logged against the cycle, newest first. */
  checkins(empIds?: string[]): Promise<CheckIn[]>;
  /**
   * Move a goal's progress. Status and the mid/final key results follow from
   * the number rather than being set alongside it.
   */
  setGoalProgress(goalId: string, progress: number): Promise<Goal>;

  /** Set a goal, with its key results. */
  addGoal(draft: NewGoal): Promise<Goal>;
  /** Log a 1:1. The other party is the caller. */
  logCheckin(draft: NewCheckIn): Promise<CheckIn>;
  /** Praise a colleague. Praising yourself is refused. */
  givePraise(toId: string, value: string, text: string): Promise<Praise[]>;
  /** The employee's own assessment; opens the review if it is the first thing written. */
  submitSelfReview(rating: number, comments: string): Promise<Review>;
  /** The manager's. Refused before the self-assessment is in. */
  submitManagerReview(empId: string, rating: number, comments: string): Promise<Review>;
  /** Close a review with its final rating and increment. */
  calibrateReview(empId: string, outcome: ReviewOutcome): Promise<Review>;
}

export interface NewGoal {
  empId: string;
  title: string;
  category?: string;
  weight?: number;
  due?: string;
  alignedTo?: string;
  keyResults?: string[];
}

export interface NewCheckIn {
  empId: string;
  wins?: string;
  blockers?: string;
  next?: string;
  on?: string;
}

export interface ReviewOutcome {
  rating: number;
  hike?: number;
  promoted?: boolean;
  /** 9-box vertical axis, 1 to 3. */
  potential?: number;
  pip?: boolean;
}

export interface LearningService {
  courses(): Promise<Course[]>;
  enrolments(empIds?: string[]): Promise<Enrollment[]>;
  enrol(empId: string, courseId: string): Promise<Enrollment>;
  /** Progress drives the status — 100% completes and stamps the date. */
  setProgress(empId: string, courseId: string, progress: number): Promise<Enrollment>;
}

export interface NewTicket {
  empId: string;
  cat: string;
  subject: string;
  desc: string;
  priority: string;
}

export interface HelpdeskService {
  tickets(empIds?: string[]): Promise<Ticket[]>;
  knowledgeBase(): Promise<{ cat: string; q: string; a: string }[]>;
  raise(t: NewTicket): Promise<Ticket>;
  /** A comment moves an open ticket into progress — that is the SLA clock. */
  comment(id: string, by: string, text: string): Promise<Ticket>;
  resolve(id: string, csat?: number): Promise<Ticket>;
}

export interface EngagementService {
  surveys(): Promise<Survey[]>;
  /**
   * The eNPS for one survey, computed from its promoter split — or null when
   * too few people have answered for the result to be shown.
   *
   * Null rather than zero: zero is a real score, as many detractors as
   * promoters, and a caller that cannot tell "nobody answered" from "opinion
   * is evenly split" will report the first as the second.
   */
  enpsOf(surveyId: string): Promise<number | null>;
  /** eNPS by quarter, oldest first. */
  enpsHistory(): Promise<{ k: string; v: number }[]>;
}

/** One employee's flexible-benefit plan, with what they have allocated. */
export interface FbpRow {
  employee: Employee;
  plan: FbpPlan;
  allocated: number;
}

export interface BenefitsService {
  /** Flexible-benefit allocation per employee, keyed by id. */
  fbpTotals(empIds: string[]): Promise<Record<string, number>>;
  /** One person's plan and what they have allocated so far. */
  fbpPlan(empId: string): Promise<FbpRow>;
  /** The declaration tracker across the workforce. */
  fbpRows(): Promise<FbpRow[]>;
  /**
   * Declare an allocation. Refuses once the plan is locked, and refuses an
   * allocation over the pool or over a component's annual ceiling.
   */
  declareFbp(empId: string, alloc: Record<string, number>): Promise<FbpPlan>;
  /** Group cover sums assured by grade, and what the workforce costs to insure. */
  insuranceCover(): Promise<{ totalSumAssured: number; covered: number }>;
}

/* ---------- the noticeboard and exits ---------- */

export interface NewAnnouncement {
  title: string;
  body: string;
  tag: string;
  pin: boolean;
  /** A department code, or 'All' for everyone. */
  dept: string;
}

/**
 * The noticeboard.
 *
 * The writes return the whole board rather than the one post, because every
 * caller re-renders the list anyway and a pin reorders it — returning one row
 * would leave the screen to guess where it now belongs.
 */
export interface NoticeboardService {
  /** Only posts the caller is an audience for, and only unexpired ones. */
  announcements(): Promise<Announcement[]>;
  /** Birthdays and work anniversaries falling in the next `days` days. */
  celebrations(days: number): Promise<Celebration[]>;
  /** Post to the board. Managers and admins only. */
  post(draft: NewAnnouncement): Promise<Announcement[]>;
  /** Pinned posts sort to the top of the board. */
  setPinned(id: string, pinned: boolean): Promise<Announcement[]>;
  /** Take a post down. */
  remove(id: string): Promise<Announcement[]>;
}

export interface NewExit {
  empId: string;
  type?: string;
  resignedOn?: string;
  noticeDays?: number;
  /** Last working day. */
  lwd: string;
  reason?: string;
  destination?: string;
  /** Notice days bought out, recovered in the settlement. */
  buyout?: number;
}

export interface ExitInterviewAnswers {
  wouldRejoin?: boolean;
  rating?: number;
  comments?: string;
}

export interface ExitService {
  list(): Promise<ExitRecord[]>;
  /** One exit with its settlement computed. */
  detail(exitId: string): Promise<ExitDetail | null>;
  /** Record a resignation, with its clearance checklist. */
  raise(draft: NewExit): Promise<ExitRecord>;
  /** Tick or untick one clearance line, by department. */
  setClearance(exitId: string, department: string, done: boolean): Promise<ExitRecord>;
  /** Close an exit once clearance is complete and the settlement is paid. */
  settle(exitId: string): Promise<ExitRecord>;
  recordInterview(exitId: string, answers: ExitInterviewAnswers): Promise<ExitRecord>;
}

/* ---------- the staffing book ---------- */

/** A scored pairing, with the breakdown that justifies the number. */
export interface MatchRow {
  consultant: Consultant;
  requirement: StaffingRequirement;
  explain: MatchExplain;
}

/** One consultant's proposed redeployment, from the greedy sweep. */
export interface PlanRow {
  consultant: Consultant;
  requirement: StaffingRequirement;
  score: number;
  margin: number;
  benchDays: number;
}

export interface RedeploymentPlan {
  picks: PlanRow[];
  /** Monthly bench cost the plan would recover, in base currency. */
  recovered: number;
  /** Monthly revenue it would unlock, at client bill rates. */
  revenue: number;
  benchTotal: number;
  availableCount: number;
  openRequirementCount: number;
}

export interface StaffingService {
  clients(): Promise<Client[]>;
  requirements(): Promise<StaffingRequirement[]>;
  /** Requirements still taking submissions. */
  openRequirements(): Promise<StaffingRequirement[]>;
  consultants(): Promise<Consultant[]>;
  bench(): Promise<Consultant[]>;
  placements(): Promise<Placement[]>;
  submissions(): Promise<Submission[]>;
  /** Move a submission along the pipeline. Reaching 'placed' starts billing. */
  moveSubmission(id: string, stage: string): Promise<Submission>;
  invoices(): Promise<Invoice[]>;
  vendors(): Promise<Vendor[]>;
  sows(): Promise<Sow[]>;
  rateCards(): Promise<RateCard[]>;
  /** Utilisation, margin, fill rate, DSO — the operating numbers. */
  kpi(): Promise<StaffingKPI>;

  /* The match engine is a server computation: it reads pay rates and cost
     bases, which is not data every caller should be holding. */
  matchesForConsultant(consultantId: string): Promise<MatchRow[]>;
  matchesForRequirement(requirementId: string): Promise<MatchRow[]>;
  redeploymentPlan(): Promise<RedeploymentPlan>;
  /** Bench days and accrued cost for one consultant. */
  benchStanding(consultantId: string): Promise<{ days: number; cost: number }>;
}

/* ---------- recruitment ---------- */

/** What a job order is created from. The rest is derived or defaulted. */
export interface JobOrderDraft {
  clientId: string;
  sowId?: string;
  title: string;
  role: string;
  jobType: JobType;
  employmentType: EmploymentType;
  priority: JobPriority;
  positions: number;
  location: string;
  workMode: WorkMode;
  billRate: number;
  payRate?: number | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  skills?: string[];
  preferredSkills?: string[];
  primaryTech?: string;
  description?: string;
  expMin?: number;
  expMax?: number;
  education?: string;
  certifications?: string[];
  industry?: string;
  workAuth?: string;
  shift?: string;
  startOn?: string;
  endOn?: string | null;
  duration?: string;
  maxSubmissions?: number;
  poNumber?: string | null;
  vendorId?: string | null;
  vms?: string | null;
  accountManagerId?: string;
  salesOwnerId?: string;
  /** Days from opening to the fill target. The three targets derive from it. */
  slaDays?: number;
  /** A draft is written before it is worked; an open order is on a desk. */
  status?: 'Draft' | 'Open';
}

/** One person on the desk, and what they were asked to deliver. */
export interface AssignmentDraft {
  recruiterId: string;
  role: AssignRole;
  targetSubmissions?: number | null;
  targetInterviews?: number | null;
  targetHires?: number | null;
  dailySubmissions?: number | null;
  weeklySubmissions?: number | null;
  priority?: JobPriority;
  notes?: string;
}

/**
 * A job order with everything a desk reads about it in one call.
 *
 * The counts and the SLA are computed on the server rather than in the screen,
 * for the same reason a timesheet's total is: two clients counting submissions
 * their own way will eventually disagree, and the one the recruiter is
 * measured against has to be the one the manager sees.
 */
/**
 * A job order as a list renders it: the order, where it stands, and what has
 * happened on it.
 *
 * The SLA travels with the row rather than being fetched alongside it. A list
 * that asked for orders and standings in two calls would narrow them with two
 * filters, and the day those two disagree is the day the table shows a green
 * badge on an overdue order.
 */
export interface JobOrderRow {
  order: StaffingRequirement;
  sla: SlaStanding;
  counts: { sourced: number; screened: number; submissions: number; interviews: number; offers: number; hires: number };
}

export interface JobOrderDetail {
  order: StaffingRequirement;
  assignments: JobAssignment[];
  activity: JobActivity[];
  sla: SlaStanding;
  counts: { sourced: number; screened: number; submissions: number; interviews: number; offers: number; hires: number };
}

/** The funnel, stage by stage, over whatever was filtered. */
export interface RecruitmentFunnel {
  openRequirements: number;
  sourced: number;
  screened: number;
  submitted: number;
  clientReview: number;
  interview: number;
  offer: number;
  hired: number;
}

/** What the dashboard's eight tiles show. */
export interface RecruitmentKPI {
  openJobs: number;
  assignedJobs: number;
  submissions: number;
  interviews: number;
  offers: number;
  hires: number;
  /** Open orders whose fill target falls within the next week. */
  closingSoon: number;
  /** Open orders already past a target. */
  aging: number;
}

/**
 * How a dashboard, funnel or list is narrowed.
 *
 * Every field is optional and they compose, so one filter object serves the
 * tiles, the funnel and the table beneath them — which is what makes the
 * three agree with each other.
 */
export interface RecruitmentFilter {
  from?: string;
  to?: string;
  clientId?: string;
  recruiterId?: string;
  reqId?: string;
  /** The client's industry, which is the closest thing a desk has to a department. */
  industry?: string;
  tech?: string;
  location?: string;
  status?: JobStatus;
  priority?: JobPriority;
}

export interface RecruitmentService {
  /** Job orders, newest first, narrowed by the filter, each with its standing. */
  jobOrders(f?: RecruitmentFilter): Promise<JobOrderRow[]>;
  /** One order with its desk, its history, its SLA and its counts. */
  jobOrder(id: string): Promise<JobOrderDetail | null>;
  createJobOrder(draft: JobOrderDraft): Promise<StaffingRequirement>;
  updateJobOrder(id: string, patch: Partial<JobOrderDraft>): Promise<StaffingRequirement>;
  /**
   * Assign or replace a desk role. Replacing releases the incumbent rather
   * than deleting them — who was on this order in March is a question a desk
   * asks when a placement falls through.
   */
  assign(id: string, draft: AssignmentDraft): Promise<JobOrderDetail>;
  release(id: string, assignmentId: string): Promise<JobOrderDetail>;
  /** Add a line to the order's history. Append-only, as the table is. */
  logActivity(id: string, kind: ActivityKind, summary: string, qty?: number): Promise<JobActivity>;
  /** The orders one recruiter currently holds, whatever desk role they hold. */
  myJobs(recruiterId: string): Promise<JobOrderRow[]>;
  kpi(f?: RecruitmentFilter): Promise<RecruitmentKPI>;
  funnel(f?: RecruitmentFilter): Promise<RecruitmentFunnel>;
}

/* ---------- documents ---------- */

/**
 * Everything a generated letter states about someone, gathered in one call.
 *
 * A letter is a legal statement of fact, so the facts it asserts — the salary
 * structure, the year-to-date tax withheld, the last working day, the current
 * increment — are what the server holds, not what the printer recomputes.
 */
export interface LetterContext {
  employee: Employee;
  /** Whose name and designation sign the letter. */
  signatory: { name: string; designation: string };
  managerName: string;
  salary: SalaryStructure;
  /** Last working day, when the person has an exit on file. */
  lastWorkingDay: string | null;
  /** The current cycle's review, when one exists. */
  review: Review | null;
  cycleName: string;
  /** Year-to-date payroll, for Form 16 part B. */
  ytd: Ytd;
  /** Annual tax on the new regime, for the Form 16 computation. */
  annualTax: INTax;
}

/**
 * A document that has been asked for — which is not the same thing as a file.
 *
 * "We asked for a degree certificate and it has not arrived" has an answer from
 * the day the offer goes out, long before any PDF exists. `hasFile` says whether
 * one has since been attached; today it is always false, because this
 * deployment has no object storage yet.
 */
export interface DocRequest {
  id: string;
  /** Set while the person is still a joiner; null once they are an employee. */
  journeyId: string | null;
  /** Set once onboarding completes. Exactly one of these two is set. */
  empId: string | null;
  kind: string;
  label: string;
  mandatory: boolean;
  /** pending | received | verified | rejected | waived */
  status: string;
  due: string | null;
  receivedOn: string | null;
  /** Who checked it. A verified request always names one. */
  verifiedBy: string | null;
  verifiedOn: string | null;
  note: string;
  hasFile: boolean;
}

/** What is still missing, which is the only number anybody asks for. */
export interface DocSummary {
  total: number;
  outstanding: number;
  received: number;
  verified: number;
  /** Mandatory documents still pending or rejected — the blocking count. */
  mandatoryOutstanding: number;
}

export interface NewDocRequest {
  /** One of these, never both: a request belongs to a joiner or an employee. */
  journeyId?: string;
  empId?: string;
  kind: string;
  label: string;
  mandatory?: boolean;
  due?: string;
}

export interface DocumentService {
  /** Employment documents on file, for one person or everyone. */
  documents(empIds?: string[]): Promise<EmpDoc[]>;
  documentTypes(): Promise<string[]>;
  /** The facts a generated letter asserts about one person. */
  letterContext(empId: string): Promise<LetterContext>;

  /** Outstanding and collected documents for a joiner or an employee. */
  requests(q?: { journeyId?: string; empId?: string }): Promise<DocRequest[]>;
  /** Counts for the same scope, without the caller re-tallying the list. */
  collectionSummary(q?: { journeyId?: string; empId?: string }): Promise<DocSummary>;
  /**
   * Open the standard joiner checklist. Idempotent — re-running picks up
   * anything the template has gained without disturbing what has been
   * collected.
   */
  requestChecklist(journeyId: string, due?: string): Promise<DocRequest[]>;
  /** Ask for something the template does not cover. Refuses a duplicate. */
  requestDocument(draft: NewDocRequest): Promise<DocRequest[]>;
  /**
   * Move a request along. Rejecting requires a reason, and verifying records
   * who checked it — the server stamps both, never the screen.
   */
  setRequestStatus(id: string, status: string, note?: string): Promise<DocRequest>;
}

/* ---------- exits ---------- */

/** A full-and-final settlement, computed rather than assembled in the view. */
export interface ExitDetail {
  exit: ExitRecord;
  employee: Employee;
  settlement: FnF;
  /** Earned-leave days available for encashment. */
  leaveAvail: number;
  loansOutstanding: number;
}

/* ---------- IT assets ---------- */

/** Register health: counts, book value and what needs attention. */
export interface AssetKPI {
  total: number;
  assigned: number;
  stock: number;
  repair: number;
  retired: number;
  gross: number;
  net: number;
  dep: number;
  outOfWarranty: number;
  eol: number;
  /** Active employees without a laptop issued to them. */
  unassigned: number;
  recovery: number;
}

export interface NewAssetRequest {
  /** Category code: LAPTOP, DISPLAY, MOBILE, PERIPH, SECURITY, LICENCE. */
  cat: string;
  /** The model being asked for, e.g. 'MacBook Pro 14"'. */
  type: string;
  reason: string;
  /** Indicative cost. Above the finance threshold this needs a second approval. */
  cost?: number;
}

export interface NewAsset {
  /** Category code: LAPTOP, DISPLAY, MOBILE, PERIPH, SECURITY, LICENCE. */
  cat: string;
  /** The model, e.g. 'MacBook Pro 14"' or 'Dell 24" Monitor'. */
  type: string;
  serial?: string;
  /** Asset tag. Left blank, the next in the AT series is used. */
  tag?: string;
  cost?: number;
  purchased?: string;
  warrantyEnd?: string;
  vendor?: string;
  /** Issue it to someone as it is added. Blank leaves it in stock. */
  empId?: string;
}

/**
 * One thing that happened to one asset.
 *
 * Every allocation, return and retirement has always written one of these;
 * nothing read them back until the register grew an activity feed.
 */
export interface AssetMovement {
  id: string;
  assetId: string;
  asset: string;
  tag: string;
  cat: string;
  /** allocated | returned | transferred | sent_for_repair | back_from_repair | retired | reported_lost */
  kind: string;
  fromId: string | null;
  fromName: string;
  toId: string | null;
  toName: string;
  movedOn: string;
  /** When the system was told — two things on one day still have an order. */
  at: string;
  note: string;
}

export interface AssetService {
  list(): Promise<Asset[]>;
  /**
   * The movement trail, most recent first. An admin sees all of it; anyone
   * else sees only movements of kit that was theirs.
   */
  movements(limit?: number): Promise<AssetMovement[]>;
  /**
   * Put an item into the register, optionally issued to someone straight away.
   *
   * Without this the register could only ever be read: allocate() moves an
   * asset that already exists, and nothing created one.
   */
  addAsset(draft: NewAsset): Promise<Asset>;
  kpi(): Promise<AssetKPI>;
  requests(): Promise<AssetRequest[]>;
  openRequests(): Promise<AssetRequest[]>;
  /** Kit a leaver still holds — the exit clearance checklist. */
  pendingRecovery(): Promise<Asset[]>;
  /** Ask for kit. Anyone may raise one, for themselves. */
  requestAsset(draft: NewAssetRequest): Promise<AssetRequest>;
  actOnRequest(id: string, status: string): Promise<AssetRequest>;
  /** Issue a specific asset to someone; refuses anything not in stock. */
  allocate(assetId: string, empId: string): Promise<Asset>;
  /** Take an asset back and return it to stock. */
  markReturned(assetId: string): Promise<Asset>;
}

export interface NewJourney {
  name: string;
  dept: string;
  designation: string;
  site?: string;
  /** Joining date. The checklist is templated around it. */
  doj: string;
  managerId?: string;
  buddyId?: string;
  ctc?: number;
  /** Set when the joiner came through the ATS. */
  candId?: string;
}

export interface OnboardingService {
  list(): Promise<Onboarding[]>;
  /**
   * Start a journey, with the standard joining checklist templated around the
   * joining date. Needed because most hires do not come through the ATS, and
   * before this the only way a journey could exist was a hired candidate.
   */
  create(draft: NewJourney): Promise<Onboarding>;
  /**
   * Tick or untick one checklist item. The journey's status follows from the
   * checklist rather than being set alongside it.
   */
  setTask(id: string, key: string, done: boolean): Promise<Onboarding>;
  complete(id: string): Promise<Onboarding>;
}

/* ---------- the approval inbox ---------- */

/** One queue waiting on the signed-in user. */
export interface PendingItem {
  ic: string;
  k: string;
  n: number;
  /** Route the row opens. */
  r: string;
}

export interface ApprovalsService {
  /**
   * Everything waiting on the caller, scoped to what their role may see and
   * excluding their own records — nobody approves their own request.
   */
  pending(caller: Caller): Promise<PendingItem[]>;
  /**
   * The count shown as a pill against Approvals. Deliberately narrower than
   * `pending` — only the core approval queues.
   */
  pendingCount(caller: Caller): Promise<number>;
  /**
   * Sidebar pills, keyed by route. One call rather than one per module: the
   * navigation renders on every route change, and it is not the place to fan
   * out requests.
   */
  navBadges(caller: Caller): Promise<Record<string, number>>;
}

/* ---------- new joiners ---------- */

/** What a manager or admin fills in to add someone. Config values are codes. */
export interface JoinerDraft {
  fullName: string;
  workEmail: string;
  employeeCode?: string;
  designation?: string;
  dept?: string;
  site?: string;
  grade?: string;
  joiningOn: string;
  employmentType?: string;
}

export interface JoiningRequest {
  id: string;
  fullName: string;
  workEmail: string;
  employeeCode: string | null;
  designation: string | null;
  dept: string | null;
  site: string | null;
  grade: string | null;
  joiningOn: string;
  employmentType: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  requestedBy: string | null;
  requestedByName: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  employeeId: string | null;
}

export interface JoinersService {
  /**
   * Raise a joiner. Whether it is created outright or queued depends on the
   * caller's role, decided server-side — the screen reflects the outcome, it
   * does not choose it.
   */
  request(draft: JoinerDraft): Promise<JoiningRequest>;
  /** Admins see every request; a manager sees the ones they raised. */
  list(status?: JoiningRequest['status']): Promise<JoiningRequest[]>;
  approve(id: string, note?: string): Promise<JoiningRequest>;
  reject(id: string, note?: string): Promise<JoiningRequest>;
}

/* ---------- configuration ---------- */

export interface FenceUpdate {
  lat: number;
  lng: number;
  /** Metres. Zero is refused — it would flag every punch at the site. */
  radius: number;
}

/**
 * The settings writes. These are configuration changes with reach: changing an
 * entitlement reprices every open balance, which is exactly why it belongs on
 * a server rather than in a save handler.
 */
export interface ConfigService {
  sites(): Promise<Site[]>;
  holidays(): Promise<Holiday[]>;
  /** Move a site's geo-fence. Does not touch anyone's shift. */
  updateFence(siteId: string, patch: FenceUpdate): Promise<Site>;
  /** Sets an entitlement and reprices open balances to match. */
  setLeaveQuota(typeId: string, quota: number): Promise<{ type: string; quota: number; repriced: number }>;
  addHoliday(date: string, name: string, optional: boolean): Promise<Holiday[]>;
}

/* ---------- security ---------- */

export interface SecurityService {
  audit(cat?: string, sev?: Severity): Promise<AuditEntry[]>;
  auditCategories(): Promise<string[]>;
  posture(): Promise<PostureRecord[]>;
  controls(): Promise<Control[]>;
  retention(): Promise<RetentionRow[]>;
}

/* ---------- the planner ---------- */

export interface WorkItem {
  id: string;
  /** PLAN-14, so people can say it out loud. */
  ref: string;
  projectId: string | null;
  project: string | null;
  iterationId: string | null;
  iteration: string | null;
  parentId: string | null;
  /** epic · story · task · bug · action */
  kind: string;
  title: string;
  desc: string;
  /** backlog · todo · in_progress · review · blocked · done · cancelled */
  status: string;
  priority: string;
  assigneeId: string | null;
  reporterId: string | null;
  /** Where an action item came from — a meeting, a review, an audit. */
  source: string;
  due: string | null;
  estimate: number | null;
  /** Position within the board column. */
  order: number;
  closedOn: string | null;
  comments: { by: string; on: string; text: string }[];
}

export interface Iteration {
  id: string;
  name: string;
  goal: string;
  from: string;
  to: string;
  status: string;
}

export interface WorkItemQuery {
  projectId?: string;
  iterationId?: string;
  assigneeId?: string;
  kind?: string;
  openOnly?: boolean;
}

export interface NewWorkItem {
  title: string;
  kind?: string;
  /** Null for an action item that belongs to no project. */
  projectId?: string | null;
  iterationId?: string | null;
  parentId?: string | null;
  desc?: string;
  priority?: string;
  assigneeId?: string | null;
  source?: string;
  due?: string | null;
  estimate?: number | null;
  status?: string;
}

export interface WorkItemPatch {
  title?: string;
  desc?: string;
  priority?: string;
  assigneeId?: string | null;
  due?: string | null;
  estimate?: number | null;
  iterationId?: string | null;
  projectId?: string | null;
  source?: string;
}

export interface BoardStats {
  status: string;
  count: number;
  estimate: number;
}

export interface PlannerService {
  items(q: WorkItemQuery): Promise<WorkItem[]>;
  /** What is on one person's plate, soonest first. */
  mine(empId?: string): Promise<WorkItem[]>;
  board(projectId?: string): Promise<BoardStats[]>;
  iterations(): Promise<Iteration[]>;
  createItem(draft: NewWorkItem): Promise<WorkItem>;
  createIteration(draft: { name: string; goal?: string; from: string; to: string }): Promise<Iteration[]>;
  /**
   * Move a card. `afterId` names the card it should sit behind, so the caller
   * says where it was dropped rather than computing an index.
   */
  moveItem(id: string, status: string, afterId?: string | null): Promise<WorkItem>;
  updateItem(id: string, patch: WorkItemPatch): Promise<WorkItem>;
  comment(id: string, text: string): Promise<WorkItem>;
}

/* ---------- the registry ---------- */

export interface Services {
  employees: EmployeeService;
  attendance: AttendanceService;
  timesheet: TimesheetService;
  expenses: ExpenseService;
  payroll: PayrollService;
  shifts: ShiftService;
  loans: LoanService;
  letters: LetterService;
  hiring: HiringService;
  performance: PerformanceService;
  learning: LearningService;
  helpdesk: HelpdeskService;
  engagement: EngagementService;
  benefits: BenefitsService;
  noticeboard: NoticeboardService;
  exits: ExitService;
  staffing: StaffingService;
  recruitment: RecruitmentService;
  documents: DocumentService;
  assets: AssetService;
  security: SecurityService;
  onboarding: OnboardingService;
  config: ConfigService;
  leave: LeaveService;
  approvals: ApprovalsService;
  joiners: JoinersService;
  planner: PlannerService;
}
