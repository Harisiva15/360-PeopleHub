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
import { api } from './client';
import type { Employee, EmployeeProfile, LeaveRequest } from '../contracts';

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
      profile: (id: string) => api.get<EmployeeProfile | null>(`/employees/${id}/profile`),
    },

    leave: {
      apply: (req) => api.post<LeaveRequest>('/leave', req),
      approve: (id: string) => api.post<LeaveRequest>(`/leave/${id}/approve`),
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
