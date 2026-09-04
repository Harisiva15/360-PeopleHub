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
import type { WaConsent, WaLogEntry, WaTemplate } from '../data/whatsapp';
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
  Client, Consultant, Invoice, Placement, RateCard, Sow, StaffingKPI, StaffingRequirement,
  Submission, Vendor,
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
export type { WaConsent, WaLogEntry, WaTemplate } from '../data/whatsapp';
export type { LeaveRequest, LeaveStatus } from '../data/leave';
export type { AttRecord, AttStatus, Regularisation } from '../data/attendance';
export type { Timesheet, TSRow, TSStatus } from '../data/timesheet';
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
  Client, Consultant, Invoice, Placement, RateCard, Sow, StaffingKPI, StaffingRequirement,
  Submission, Vendor,
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
  lat: number | null;
  lng: number | null;
  /** Resolved site and whether the punch fell inside its fence. */
  site: string;
  geoOk: boolean;
  dist: number | null;
  src: string;
  /** WFH punches record a W day rather than P. */
  wfh: boolean;
  at: string;
}

export interface AttendanceService {
  list(q: AttendanceQuery): Promise<AttRecord[]>;
  forDay(empId: string, date: string): Promise<AttRecord | null>;
  /** Days worth regularising: absent, missing a punch, or outside the fence. */
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

export interface TimesheetService {
  list(q: TimesheetQuery): Promise<Timesheet[]>;
  /**
   * The sheet for one person's week, created as an empty draft if they have
   * not started it. Creation belongs here rather than in the editor, which
   * used to conjure the row mid-render.
   */
  forWeek(empId: string, weekStart: string): Promise<Timesheet>;
  addRow(id: string, proj: string, task: string): Promise<Timesheet>;
  removeRow(id: string, rowIndex: number): Promise<Timesheet>;
  /** Repoint a row at a different project or task. */
  setRow(id: string, rowIndex: number, patch: { proj?: string; task?: string }): Promise<Timesheet>;
  /** Sets one cell and returns the sheet with its total already recomputed. */
  setHours(id: string, rowIndex: number, dayIndex: number, hours: number): Promise<Timesheet>;
  submit(id: string): Promise<Timesheet>;
  recall(id: string): Promise<Timesheet>;
  approve(id: string, approverId: string): Promise<Timesheet>;
  reject(id: string, approverId: string, note: string): Promise<Timesheet>;
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

export interface ShiftService {
  overtime(empIds?: string[], status?: Overtime['status']): Promise<Overtime[]>;
  /**
   * Approving credits comp off when that is the compensation, which is why the
   * two happen together behind the service rather than in the screen.
   */
  approveOvertime(id: string, approverId: string): Promise<Overtime>;
  raiseOvertime(o: NewOvertime): Promise<Overtime>;
  /** The roster for a set of people, keyed by employee id then date. */
  roster(empIds: string[]): Promise<Record<string, Record<string, string>>>;
  /** Reassign one person's shift on one day. Refuses an unknown pattern. */
  setShift(empId: string, date: string, shiftId: string): Promise<{ empId: string; date: string; shiftId: string }>;
  /** How many people are on each shift pattern today. */
  todayCoverage(): Promise<Record<string, number>>;
}

export interface LoanService {
  list(status?: Loan['status']): Promise<Loan[]>;
  /** Sanctioning a loan puts it into recovery from the next payroll cycle. */
  approve(id: string): Promise<Loan>;
}

export interface LetterService {
  requests(status?: LetterRequest['status']): Promise<LetterRequest[]>;
  issue(id: string): Promise<LetterRequest>;
}

/* ---------- hiring ---------- */

/** An interview with the candidate and requisition it belongs to, resolved. */
export interface InterviewRow {
  interview: Interview;
  candidate: Candidate | null;
  requisitionTitle: string;
}

export interface HiringService {
  /** The panel member's own upcoming interviews. */
  interviewsFor(panelId: string, status?: Interview['status']): Promise<InterviewRow[]>;
  /** The whole interview schedule — the hiring screens filter it themselves. */
  interviews(): Promise<Interview[]>;
  /** Move a candidate to another pipeline stage. Refuses an unknown stage. */
  moveCandidate(candId: string, stage: string): Promise<Candidate>;
  candidates(): Promise<Candidate[]>;
  requisitions(): Promise<Requisition[]>;
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
  /** The eNPS score for one survey, computed from its promoter split. */
  enpsOf(surveyId: string): Promise<number>;
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

export interface NoticeboardService {
  announcements(): Promise<Announcement[]>;
  /** Birthdays and work anniversaries falling in the next `days` days. */
  celebrations(days: number): Promise<Celebration[]>;
}

export interface ExitService {
  list(): Promise<ExitRecord[]>;
  /** One exit with its settlement computed. */
  detail(exitId: string): Promise<ExitDetail | null>;
  /** Tick or untick one clearance line. */
  setClearance(exitId: string, index: number, done: boolean): Promise<ExitRecord>;
  /** Close an exit once clearance is complete and the settlement is paid. */
  settle(exitId: string): Promise<ExitRecord>;
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

export interface DocumentService {
  /** Employment documents on file, for one person or everyone. */
  documents(empIds?: string[]): Promise<EmpDoc[]>;
  documentTypes(): Promise<string[]>;
  /** The facts a generated letter asserts about one person. */
  letterContext(empId: string): Promise<LetterContext>;
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

export interface AssetService {
  list(): Promise<Asset[]>;
  requests(): Promise<AssetRequest[]>;
  openRequests(): Promise<AssetRequest[]>;
  /** Kit a leaver still holds — the exit clearance checklist. */
  pendingRecovery(): Promise<Asset[]>;
  actOnRequest(id: string, status: string): Promise<AssetRequest>;
  /** Issue a specific asset to someone; refuses anything not in stock. */
  allocate(assetId: string, empId: string): Promise<Asset>;
  /** Take an asset back and return it to stock. */
  markReturned(assetId: string): Promise<Asset>;
}

export interface OnboardingService {
  list(): Promise<Onboarding[]>;
  /**
   * Tick or untick one checklist item. The journey's status follows from the
   * checklist rather than being set alongside it.
   */
  setTask(id: string, key: string, done: boolean): Promise<Onboarding>;
  complete(id: string): Promise<Onboarding>;
}

/* ---------- WhatsApp notifications ---------- */

/** Delivery and consent health for the business account. */
export interface WaStats {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
  deliveryRate: number;
  readRate: number;
  cost: number;
  optIn: number;
  optInRate: number;
  active: number;
  /** How many people the consent numbers were computed over. */
  workforce: number;
}

/** One person's consent, with the employee it belongs to. */
export interface WaConsentRow {
  employee: Employee;
  consent: WaConsent;
}

export interface WhatsAppService {
  templates(): Promise<WaTemplate[]>;
  /** The send log, newest first, optionally narrowed to one person. */
  log(empId?: string): Promise<WaLogEntry[]>;
  stats(): Promise<WaStats>;
  consent(empId: string): Promise<WaConsent>;
  consentRows(): Promise<WaConsentRow[]>;
  /**
   * Turn one consent category on or off. Withdrawing HR updates withdraws the
   * marketing category with it, since marketing rides on the same number.
   */
  setConsent(empId: string, key: 'optIn' | 'marketing', on: boolean): Promise<WaConsent>;
  /** Pause or resume a template. A template Meta has not approved cannot go live. */
  setTemplateEnabled(id: string, on: boolean): Promise<WaTemplate>;
  /** Pause or resume an automation rule. */
  setRuleEnabled(id: string, on: boolean): Promise<{ id: string; on: boolean }>;
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

/* ---------- configuration ---------- */

export interface FenceUpdate {
  lat: number;
  lng: number;
  radius: number;
  shift: string;
}

/**
 * The settings writes. These are configuration changes with reach: moving a
 * fence repoints everyone at that site, and changing an entitlement reprices
 * every open balance — which is exactly why they belong on a server rather
 * than in a save handler.
 */
export interface ConfigService {
  sites(): Promise<Site[]>;
  holidays(): Promise<Holiday[]>;
  /** Updates the fence and pushes the shift to everyone based there. */
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
  documents: DocumentService;
  assets: AssetService;
  security: SecurityService;
  onboarding: OnboardingService;
  config: ConfigService;
  leave: LeaveService;
  whatsapp: WhatsAppService;
  approvals: ApprovalsService;
}
