import { monthKey, TODAY } from '../../lib/dates';
import { ACTIVE, EMAP, EMP, empName, teamOf } from '../../data/employees';
import { ATT_IDX } from '../../data/attendance';
import { ASSETS, DOCS } from '../../data/announcements';
import { CLAIMS } from '../../data/expenses';
import { TICKETS } from '../../data/helpdesk';
import { ENROLL } from '../../data/learning';
import { LEAVE_BAL, leaveBalance } from '../../data/leave';
import { LIFECYCLE } from '../../data/lifecycle';
import { activeLoans } from '../../data/loans';
import { DECL } from '../../data/payroll';
import { GOALS, PRAISE } from '../../data/performance';
import { comp, compAllow, salaryStructure } from '../../data/salary';
import { exitOf } from '../../data/exit';
import type { AppRole, Employee } from '../../types/employee';
import type { Caller, EmployeeProfile, EmployeeService, LeaveBalanceRow } from '../contracts';
import { ok } from './util';

/**
 * Scoping lives here rather than in the screens: an admin sees everyone, a
 * manager their reporting tree, an employee only themselves. A real API would
 * derive exactly this from the caller's token, which is why `Caller` is passed
 * in rather than read from React context.
 */
function visibleIds(c: Caller): string[] {
  if (c.role === 'admin') return ACTIVE().map((e) => e.id);
  if (c.role === 'manager') return [c.meId, ...teamOf(c.meId, true)];
  return [c.meId];
}

export const employeeService: EmployeeService = {
  visible(c) {
    const allowed = new Set(visibleIds(c));
    return ok(ACTIVE().filter((e) => allowed.has(e.id)));
  },

  byId(id) {
    return ok(EMAP[id] ?? null);
  },

  byIds(ids) {
    const want = new Set(ids);
    return ok(EMP.filter((e) => want.has(e.id)));
  },

  active() {
    return ok(ACTIVE());
  },

  exited() {
    return ok(EMP.filter((e) => e.status === 'Exited'));
  },

  team(managerId, deep) {
    return ok(teamOf(managerId, deep).map((id) => EMAP[id]).filter(Boolean) as Employee[]);
  },

  profile(id) {
    const e = EMAP[id];
    if (!e) return ok(null);
    const s = salaryStructure(e);
    const mk = monthKey(TODAY);
    const decl = DECL[id];

    const out: EmployeeProfile = {
      employee: e,
      managerName: empName(e.managerId || ''),
      reports: (e.reports || []).map((r) => EMAP[r]).filter(Boolean),
      salary: s,
      compMonthly: { basic: comp(s, 0) / 12, allowance: compAllow(s) / 12 },
      taxRegime: decl?.regime ?? '—',
      taxStatus: decl?.status ?? '',
      attendanceThisMonth: Object.values(ATT_IDX[id] || {}).filter((r) => r.date.slice(0, 7) === mk),
      leaveBalances: Object.keys(LEAVE_BAL[id] || {})
        .map((type) => {
          const b = leaveBalance(id, type);
          return b ? { type, ...b } : null;
        })
        .filter(Boolean) as LeaveBalanceRow[],
      assets: ASSETS.filter((a) => a.empId === id),
      documents: DOCS.filter((d) => d.empId === id),
      claims: CLAIMS.filter((c) => c.empId === id),
      tickets: TICKETS.filter((t) => t.empId === id),
      coursesCompleted: ENROLL.filter((x) => x.empId === id && x.status === 'Completed').length,
      praiseReceived: PRAISE.filter((pr) => pr.toId === id).length,
      goals: GOALS.filter((g) => g.empId === id),
      loans: activeLoans(id),
      lifecycle: LIFECYCLE[id] || [],
      exit: exitOf(id) ?? null,
    };
    return ok(out);
  },

  setRole(id, role: AppRole) {
    const e = EMAP[id];
    if (!e) return Promise.reject(new Error('No such employee: ' + id));
    e.role = role;
    return ok(e);
  },
};
