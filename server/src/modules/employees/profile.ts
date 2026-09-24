/**
 * The profile drawer's composite.
 *
 * `GET /employees/:id/profile` already existed and answered three fields —
 * the employee, their manager's name and their reports. The contract asks for
 * eighteen, so the frontend deliberately never mapped the method and the
 * drawer showed "the full profile is not available yet" against a real tenant.
 * This fills the remaining fifteen.
 *
 * **Nothing here queries a table.** Every part is fetched through the service
 * that owns it, so each piece arrives already scoped by that module's own
 * rules. Writing fifteen fresh SELECTs would have meant re-deciding, fifteen
 * times, who may see what — and the first one to get it wrong would leak
 * across a tenant or across a reporting line with nothing to catch it.
 *
 * That choice costs a fan-out of queries on one drawer open. It is the trade
 * the contract already describes ("one response, not fourteen calls"): the
 * fan-out moves from the browser to the server, where it is one round trip for
 * the client and the connection is local to the pool.
 *
 * ## Pay is not part of what a manager may read
 *
 * `salaryStructureOf` and `declarationFor` both assert own-or-admin, and the
 * drawer independently gates the same fields with `canSeeComp`. This mirrors
 * that rule rather than catching the refusal, because a caught 403 and a
 * genuine failure look identical once flattened into a composite.
 *
 * For a manager reading a report, the pay fields come back *empty* — no
 * earnings lines, a dash for the regime. Empty is not a claim that somebody
 * earns nothing: `earnings: []` cannot be rendered as a figure, which is
 * exactly why it is used here instead of a zeroed structure. `compMonthly`
 * carries zeroes because the contract types it as numbers, and the drawer
 * never reaches it for such a caller.
 */

import type { Caller } from '../../tenancy/context.ts';
import { getEmployee, getTeam } from './service.ts';
import type { Employee } from './mapper.ts';

import { salaryStructureOf } from '../payroll/service.ts';
import type { Structure } from '../payroll/rules.ts';
import { declarationFor } from '../tax/service.ts';
import { listAttendance } from '../attendance/service.ts';
import { balancesFor } from '../leave/service.ts';
import { listAssets } from '../assets/service.ts';
import { listDocuments } from '../documents/service.ts';
import { listClaims } from '../expenses/service.ts';
import { listTickets } from '../helpdesk/service.ts';
import { enrolments } from '../learning/service.ts';
import { listGoals, listPraise } from '../performance/service.ts';
import { listLoans } from '../loans/service.ts';
import { getLifecycle } from '../lifecycle/service.ts';
import { listExits } from '../exits/service.ts';

/** Matches `EmployeeProfile` in `src/services/contracts.ts`, field for field. */
export interface EmployeeProfile {
  employee: Employee;
  managerName: string;
  reports: Employee[];
  salary: Structure;
  compMonthly: { basic: number; allowance: number };
  taxRegime: string;
  taxStatus: string;
  attendanceThisMonth: Awaited<ReturnType<typeof listAttendance>>;
  leaveBalances: Awaited<ReturnType<typeof balancesFor>>;
  assets: Awaited<ReturnType<typeof listAssets>>;
  documents: Awaited<ReturnType<typeof listDocuments>>;
  claims: Awaited<ReturnType<typeof listClaims>>;
  tickets: Awaited<ReturnType<typeof listTickets>>;
  coursesCompleted: number;
  praiseReceived: number;
  goals: Awaited<ReturnType<typeof listGoals>>;
  loans: Awaited<ReturnType<typeof listLoans>>;
  lifecycle: { on: string; type: string; note: string; from: string | null; to: string | null }[];
  exit: Awaited<ReturnType<typeof listExits>>[number] | null;
}

/** The same test `assertOwnOrAdmin` makes, asked before the call rather than after. */
const maySeePay = (caller: Caller, empId: string) =>
  caller.role === 'admin' || caller.employeeId === empId;

/** A structure that renders as nothing, for a caller who may not see pay. */
const noPay = (e: Employee): Structure => ({
  ctc: 0,
  ccy: e.ccy,
  country: e.country as Structure['country'],
  earnings: [],
  benefits: [],
  grossA: 0,
  pfEmpr: 0,
  gratuity: 0,
  medIns: 0,
});

/** First and last day of the month `today` falls in, as `YYYY-MM-DD`. */
function thisMonth(today = new Date()): { from: string; to: string } {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
}

/**
 * A part of the profile that is allowed to be absent.
 *
 * One module having no rows, or refusing this caller, must not cost the whole
 * drawer — the person's name and reporting line are worth showing even when
 * the helpdesk is unreachable. The fallback is always empty, never invented.
 */
const optional = <T>(run: Promise<T>, fallback: T): Promise<T> =>
  run.catch(() => fallback);

export async function buildEmployeeProfile(
  caller: Caller,
  id: string,
): Promise<EmployeeProfile | null> {
  /*
   * The visibility decision for the whole composite. `getEmployee` applies the
   * caller's scope, so somebody outside this person's tree gets null here and
   * nothing below ever runs.
   */
  const employee = await getEmployee(caller, id);
  if (!employee) return null;

  const month = thisMonth();
  const pay = maySeePay(caller, id);

  const [
    manager, reports, salary, declaration, attendanceThisMonth, leaveBalances,
    assets, documents, claims, tickets, enrolled, praise, goals, loans,
    lifecycleDetail, exits,
  ] = await Promise.all([
    employee.managerId ? optional(getEmployee(caller, employee.managerId), null) : Promise.resolve(null),
    optional(getTeam(caller, id), []),
    pay ? optional(salaryStructureOf(caller, id), noPay(employee)) : Promise.resolve(noPay(employee)),
    pay ? optional(declarationFor(caller, id), null) : Promise.resolve(null),
    optional(listAttendance(caller, { empIds: [id], from: month.from, to: month.to }), []),
    optional(balancesFor(caller, id), []),
    optional(listAssets(caller), []),
    optional(listDocuments(caller, [id]), []),
    optional(listClaims(caller, { empIds: [id] }), []),
    optional(listTickets(caller, [id]), []),
    optional(enrolments(caller, [id]), []),
    optional(listPraise(caller), []),
    optional(listGoals(caller, [id]), []),
    optional(listLoans(caller), []),
    optional(getLifecycle(caller, id), null),
    optional(listExits(caller), []),
  ]);

  /*
   * Three services answer for everyone the caller may see rather than for one
   * person, because that is the shape their screens need. Narrowing happens
   * here, and only ever removes rows.
   */
  const mine = <T extends { empId: string | null }>(rows: T[]) => rows.filter((r) => r.empId === id);

  const basicAnnual = salary.earnings[0]?.a ?? 0;
  const allowanceAnnual = salary.earnings.slice(1).reduce((n, l) => n + l.a, 0);

  return {
    employee,
    managerName: manager?.name ?? '',
    reports,
    salary,
    compMonthly: { basic: basicAnnual / 12, allowance: allowanceAnnual / 12 },
    /* The mock's idiom for "nothing on file", kept so the drawer reads the same. */
    taxRegime: declaration?.regime ?? '—',
    taxStatus: declaration?.status ?? '',
    attendanceThisMonth,
    leaveBalances,
    assets: mine(assets),
    documents,
    claims,
    tickets,
    coursesCompleted: enrolled.filter((e) => e.status === 'Completed').length,
    praiseReceived: praise.filter((p) => p.toId === id).length,
    goals,
    loans: mine(loans),
    lifecycle: lifecycleDetail?.events ?? [],
    exit: exits.find((x) => x.empId === id) ?? null,
  };
}
