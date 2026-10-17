/**
 * What is waiting on you.
 *
 * Every queue counted here already has a live service of its own; this is the
 * one place that asks all of them at once. It matters that it is one place: the
 * sidebar renders on every route change, and a badge per module would mean nine
 * requests every time somebody clicks anything.
 *
 * **Nobody approves their own.** Each count excludes the caller's own records,
 * the same way each module's own approve refuses self-approval. A badge that
 * counted your own leave request would send you to a queue with a button you
 * cannot press.
 *
 * **Scope is the caller's line, not the whole company.** A manager sees their
 * reports however deep; an admin sees everyone. The scoping is repeated per
 * query rather than factored into a view, because each table names the employee
 * differently and a shared helper would have to take the column name anyway.
 */

import { withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export interface PendingItem {
  ic: string;
  k: string;
  n: number;
  /** Route the row opens. */
  r: string;
}

/**
 * SQL fragment for "employees this caller may act on, excluding themselves".
 *
 * An admin gets everyone but themselves; a manager their subtree; an employee
 * nobody, because approving is not something they do. Returns a fragment that
 * slots into `WHERE <col> IN (...)`.
 */
function actionable(caller: Caller): { sql: string; params: unknown[] } | null {
  if (!caller.employeeId && caller.role !== 'admin') return null;
  if (caller.role === 'employee') return null;

  if (caller.role === 'admin') {
    /* Every active person except the caller — an admin with no employee row
       still sees the whole queue, hence the null-safe comparison. */
    return {
      sql: `SELECT id FROM employee
             WHERE status <> 'exited' AND id IS DISTINCT FROM $1::uuid`,
      params: [caller.employeeId],
    };
  }
  return {
    sql: `WITH RECURSIVE t AS (
            SELECT id FROM employee WHERE manager_id = $1
            UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
          ) SELECT id FROM t`,
    params: [caller.employeeId],
  };
}

/**
 * The queues, in the order the inbox lists them.
 *
 * `core` marks the ones the sidebar pill counts. It is deliberately narrower
 * than the inbox: a pill that included every advisory row would sit at a
 * permanent double digit and stop meaning anything.
 */
const QUEUES: {
  key: string; ic: string; label: string; route: string; core: boolean;
  sql: (scope: string) => string;
}[] = [
  {
    key: 'leave', ic: '🌴', label: 'Leave requests', route: '/leave', core: true,
    sql: (s) => `SELECT count(*)::int n FROM leave_request
                  WHERE status = 'pending' AND employee_id IN (${s})`,
  },
  {
    key: 'timesheet', ic: '⏱', label: 'Timesheets', route: '/timesheet', core: true,
    sql: (s) => `SELECT count(*)::int n FROM timesheet
                  WHERE status = 'submitted' AND employee_id IN (${s})`,
  },
  {
    key: 'attendance', ic: '📍', label: 'Regularisations', route: '/attendance', core: true,
    sql: (s) => `SELECT count(*)::int n FROM regularisation r
                   JOIN attendance a ON a.id = r.attendance_id
                  WHERE r.status = 'pending' AND a.employee_id IN (${s})`,
  },
  {
    key: 'expenses', ic: '🧾', label: 'Expense claims', route: '/expenses', core: true,
    sql: (s) => `SELECT count(*)::int n FROM expense_claim
                  WHERE status = 'submitted' AND employee_id IN (${s})`,
  },
  {
    key: 'shifts', ic: '🌙', label: 'Overtime', route: '/shifts', core: true,
    sql: (s) => `SELECT count(*)::int n FROM overtime
                  WHERE status = 'pending' AND employee_id IN (${s})`,
  },
  {
    key: 'assets', ic: '💻', label: 'Asset requests', route: '/assets', core: true,
    sql: (s) => `SELECT count(*)::int n FROM asset_request
                  WHERE status = 'pending' AND employee_id IN (${s})`,
  },
  {
    key: 'documents', ic: '✉️', label: 'Letter requests', route: '/documents', core: false,
    sql: (s) => `SELECT count(*)::int n FROM letter_request
                  WHERE status = 'pending' AND employee_id IN (${s})`,
  },
  {
    key: 'hiring', ic: '🎯', label: 'Interview feedback', route: '/hiring', core: false,
    sql: () => `SELECT count(*)::int n FROM interview
                 WHERE status = 'scheduled' AND scheduled_at < now()`,
  },
  {
    key: 'onboarding', ic: '🚀', label: 'Joiners in progress', route: '/onboarding', core: false,
    sql: () => `SELECT count(*)::int n FROM onboarding_journey
                 WHERE status <> 'completed'`,
  },
];

/** Every queue's count in one round trip, keyed by queue. */
async function counts(
  db: TenantClient,
  caller: Caller,
): Promise<Record<string, number>> {
  const scope = actionable(caller);
  if (!scope) return {};

  /*
   * One statement rather than nine. Each queue becomes a scalar subquery, so
   * the nine counts cost a single round trip and cannot disagree with each
   * other about when "now" was.
   */
  const parts = QUEUES.map((q) => `(${q.sql(scope.sql)}) AS ${q.key}`);
  const { rows } = await db.query(`SELECT ${parts.join(', ')}`, scope.params);

  const row = rows[0] ?? {};
  return Object.fromEntries(QUEUES.map((q) => [q.key, Number(row[q.key] ?? 0)]));
}

export async function pending(caller: Caller): Promise<PendingItem[]> {
  return withTenantReadOnly(caller, async (db) => {
    const n = await counts(db, caller);
    /* Empty queues are dropped — an inbox of zeroes is a list of nothing. */
    return QUEUES
      .filter((q) => (n[q.key] ?? 0) > 0)
      .map((q) => ({ ic: q.ic, k: q.label, n: n[q.key]!, r: q.route }));
  });
}

export async function pendingCount(caller: Caller): Promise<number> {
  return withTenantReadOnly(caller, async (db) => {
    const n = await counts(db, caller);
    return QUEUES.filter((q) => q.core).reduce((a, q) => a + (n[q.key] ?? 0), 0);
  });
}

/**
 * Sidebar pills, keyed by the module they sit against.
 *
 * Same counts, different shape — the navigation wants them by route, and
 * computing them twice from one query is cheaper than two queries.
 */
export async function navBadges(caller: Caller): Promise<Record<string, number>> {
  return withTenantReadOnly(caller, async (db) => {
    const n = await counts(db, caller);
    const out: Record<string, number> = {};
    for (const q of QUEUES) {
      if ((n[q.key] ?? 0) > 0) out[q.key] = n[q.key]!;
    }
    return out;
  });
}
