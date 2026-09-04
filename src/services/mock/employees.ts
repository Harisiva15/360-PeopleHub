import { ACTIVE, EMAP, EMP, teamOf } from '../../data/employees';
import type { AppRole, Employee } from '../../types/employee';
import type { Caller, EmployeeService } from '../contracts';
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

  team(managerId, deep) {
    return ok(teamOf(managerId, deep).map((id) => EMAP[id]).filter(Boolean) as Employee[]);
  },

  setRole(id, role: AppRole) {
    const e = EMAP[id];
    if (!e) return Promise.reject(new Error('No such employee: ' + id));
    e.role = role;
    return ok(e);
  },
};
