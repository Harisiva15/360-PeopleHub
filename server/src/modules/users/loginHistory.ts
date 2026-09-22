/**
 * A record of who signed in.
 *
 * **What this can honestly record, and what it cannot.** Supabase Auth checks
 * the password, not this server, so a wrong password is never observed here.
 * The obvious fix — have the login page report its own failures to an endpoint
 * — hands an unauthenticated caller a way to write rows against any address
 * they can guess, and if those rows drove a lockout it would hand them a way
 * to lock any account they can name. So the table records what this server
 * actually witnesses: a session that started, a session that ended, and a
 * token refused for the state of its account. Counting wrong passwords belongs
 * where the password is checked; until it lives there, the honest thing is an
 * empty column rather than a number sourced from the client.
 *
 * **The address is the socket's unless a proxy is trusted.** `x-forwarded-for`
 * is a header, and a header is written by whoever sent the request — behind no
 * proxy it is a free-text field the caller fills in. Same rule as the rate
 * limiter, and the same environment variable, so there is one answer to "do we
 * trust the hop in front of us" rather than two that can disagree.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { employeeScope } from '../../tenancy/scope.ts';
import { UserError } from './service.ts';

export interface Agent {
  ip: string | null;
  userAgent: string | null;
}

export interface LoginEvent {
  id: string;
  employeeId: string | null;
  at: string;
  outcome: string;
  method: string;
  reason: string;
  ip: string;
  userAgent: string;
}

/** A user-agent string is a label here, not a fingerprint. 0038 caps it. */
const AGENT_MAX = 400;

/**
 * Read the caller's address and client from the request.
 *
 * Kept as a free function taking the header values rather than a `req`, so the
 * trust rule can be tested without a socket.
 */
export function agentFrom(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  userAgent: string | undefined,
  trustProxy = process.env.TRUST_PROXY === '1',
): Agent {
  const forwarded = trustProxy && forwardedFor
    ? forwardedFor.split(',')[0]?.trim()
    : undefined;
  const ip = forwarded || socketAddress || '';
  return {
    // Node reports an IPv4 peer over IPv6 as ::ffff:a.b.c.d. Postgres's inet
    // accepts it, but nobody reading the screen wants to see it.
    ip: ip ? ip.replace(/^::ffff:/, '') : null,
    userAgent: userAgent ? userAgent.slice(0, AGENT_MAX) : null,
  };
}

const OUTCOMES = ['success', 'failed', 'refused', 'locked_out', 'signed_out'];
const METHODS = ['password', 'mfa', 'recovery_code', 'sso', 'magic_link'];

const SELECT_EVENT = `
  SELECT h.id, h.employee_id, h.at::text AS at, h.outcome, h.method,
         h.reason, host(h.ip) AS ip, h.user_agent
    FROM login_history h`;

interface EventRow {
  id: string; employee_id: string | null; at: string; outcome: string;
  method: string; reason: string | null; ip: string | null; user_agent: string | null;
}

const toEvent = (r: EventRow): LoginEvent => ({
  id: r.id,
  employeeId: r.employee_id,
  at: r.at,
  outcome: r.outcome,
  method: r.method,
  reason: r.reason ?? '',
  ip: r.ip ?? '',
  userAgent: r.user_agent ?? '',
});

/**
 * Record one event against the caller's own account.
 *
 * Takes no employee id, for the same reason `lastLoginNow` does not: there is
 * no row to name but your own, so there is nothing to guard. Writing history
 * about somebody else is not a permission anybody needs.
 */
export async function recordLoginEvent(
  caller: Caller,
  outcome: string,
  agent: Agent,
  method = 'password',
  reason?: string,
): Promise<void> {
  if (!caller.employeeId) return;
  if (!OUTCOMES.includes(outcome)) throw new UserError('Not an outcome', 'invalid');
  if (!METHODS.includes(method)) throw new UserError('Not a method', 'invalid');

  await withTenant(caller, async (db) => {
    await db.query(
      `INSERT INTO login_history
         (tenant_id, user_id, employee_id, outcome, method, reason, ip, user_agent)
       VALUES (current_setting('app.tenant_id')::uuid, $1::uuid, $2::uuid,
               $3, $4, $5, $6::inet, $7)`,
      [
        caller.userId, caller.employeeId, outcome, method,
        // 0038 requires a reason on everything but a success, and forbids one
        // on a success. Both halves are supplied here rather than hoped for.
        outcome === 'success' ? null : (reason ?? 'not stated'),
        agent.ip, agent.userAgent,
      ]);
  });
}

/**
 * One person's sign-ins, newest first.
 *
 * With no id this is your own, which every signed-in person may read — it is
 * the control that lets somebody notice a session they did not start, so
 * gating it behind an administrator would defeat the point of having it. With
 * an id it is somebody else's, and the same scope every other module uses
 * decides whether this caller may see it.
 */
export async function listLoginHistory(
  caller: Caller,
  employeeId?: string,
  limit = 50,
): Promise<LoginEvent[]> {
  const target = employeeId ?? caller.employeeId;
  if (!target) return [];
  const own = target === caller.employeeId;

  if (!own && caller.role === 'employee') {
    throw new UserError('You can only see your own sign-in history', 'forbidden');
  }

  return withTenantReadOnly(caller, async (db) => {
    const params: unknown[] = [target];
    // Your own row needs no predicate. Somebody else's is filtered in SQL, so
    // an id outside the caller's line is answered with no rows rather than a
    // thrown message that confirms the id exists.
    const scope = own || caller.role === 'admin'
      ? 'TRUE'
      : employeeScope(caller, 'h.employee_id', params);
    params.push(Math.min(Math.max(1, Math.trunc(limit)), 200));

    const { rows } = await db.query<EventRow>(
      `${SELECT_EVENT}
        WHERE h.employee_id = $1 AND ${scope}
        ORDER BY h.at DESC
        LIMIT $${params.length}`,
      params);
    return rows.map(toEvent);
  });
}

/**
 * Everybody's sign-ins, newest first.
 *
 * Separate from the per-person read rather than the same call with a null id,
 * because they answer different questions and only one of them is an
 * administrator's. A manager gets their own line; an employee is refused and
 * told so, rather than handed an empty list that reads as "no activity".
 */
export async function listTenantLoginHistory(
  caller: Caller,
  limit = 200,
): Promise<LoginEvent[]> {
  if (caller.role === 'employee') {
    throw new UserError('Only an administrator or a manager can read this', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const params: unknown[] = [];
    const scope = caller.role === 'admin'
      ? 'TRUE'
      : employeeScope(caller, 'h.employee_id', params);
    params.push(Math.min(Math.max(1, Math.trunc(limit)), 500));

    const { rows } = await db.query<EventRow>(
      `${SELECT_EVENT}
        WHERE ${scope}
        ORDER BY h.at DESC
        LIMIT $${params.length}`,
      params);
    return rows.map(toEvent);
  });
}
