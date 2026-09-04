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
import type { LeaveBalance, LeaveRequest, LeaveStatus } from '../data/leave';
import type { AttRecord } from '../data/attendance';
import type { Timesheet, TSStatus } from '../data/timesheet';
import type { Advance, Claim, ClaimStatus, ExpItem } from '../data/expenses';

/* Row shapes screens render. Re-exported so a view imports them from the
   service it calls, not from the dataset behind it. */
export type { Employee } from '../types/employee';
export type { LeaveRequest, LeaveStatus } from '../data/leave';
export type { AttRecord, AttStatus, Regularisation } from '../data/attendance';
export type { Timesheet, TSRow, TSStatus } from '../data/timesheet';
export type { Advance, Claim, ClaimStatus, ExpItem } from '../data/expenses';

/** Who is asking. Every read is scoped to this, the way an API would scope to a token. */
export interface Caller {
  role: AppRole;
  meId: string;
}

/* ---------- employees ---------- */

export interface EmployeeService {
  /** Everyone the caller may see — the whole company, their tree, or themselves. */
  visible(c: Caller): Promise<Employee[]>;
  byId(id: string): Promise<Employee | null>;
  /** Resolved in bulk; screens should not fetch a directory one row at a time. */
  byIds(ids: string[]): Promise<Employee[]>;
  active(): Promise<Employee[]>;
  /** Direct reports, or the whole sub-tree when `deep`. */
  team(managerId: string, deep?: boolean): Promise<Employee[]>;
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

/* ---------- the registry ---------- */

export interface Services {
  employees: EmployeeService;
  attendance: AttendanceService;
  timesheet: TimesheetService;
  expenses: ExpenseService;
  leave: LeaveService;
}
