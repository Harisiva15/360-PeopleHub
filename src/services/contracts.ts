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

/* Row shapes screens render. Re-exported so a view imports them from the
   service it calls, not from the dataset behind it. */
export type { Employee } from '../types/employee';
export type { LeaveRequest, LeaveStatus } from '../data/leave';
export type { AttRecord, AttStatus, Regularisation } from '../data/attendance';

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

/* ---------- the registry ---------- */

export interface Services {
  employees: EmployeeService;
  attendance: AttendanceService;
  leave: LeaveService;
}
