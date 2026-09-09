/**
 * HTTP layer.
 *
 * Deliberately built on node:http with no framework. This is a skeleton: the
 * routing here is a placeholder that a real service would replace with Fastify
 * or Hono. What is *not* a placeholder is the shape — every handler receives a
 * Caller resolved from the session and nothing else, so no route can be
 * written that takes a tenant id from the request.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { callerFromToken, AuthError } from '../auth/session.ts';
import { applyCors } from './cors.ts';
import type { Caller } from '../tenancy/context.ts';
import { TenantContextError } from '../tenancy/context.ts';
import { LeaveError } from '../modules/leave/service.ts';
import {
  getEmployee, getEmployeeProfile, getEmployeesByIds, getTeam,
  listActiveEmployees, listExitedEmployees, listVisibleEmployees, setEmployeeRole,
} from '../modules/employees/service.ts';
import { applyForLeave, approveLeave, cancelLeave } from '../modules/leave/service.ts';

type Handler = (
  caller: Caller,
  req: IncomingMessage,
  params: Record<string, string>,
  body: unknown,
) => Promise<unknown>;

interface Route {
  method: string;
  /** Path pattern with :name segments, e.g. /employees/:id/profile. */
  pattern: string;
  handler: Handler;
}

/**
 * The routes wired so far. The remaining endpoints in docs/api-contract.md
 * follow the same shape; these two modules are the pattern to copy.
 *
 * **Order matters.** Matching stops at the first hit, so a literal segment has
 * to precede the parameter that would also match it — `/employees/active`
 * before `/employees/:id`, or "active" is read as an employee id and every
 * request 404s with a confusing message. A router with proper specificity
 * ranking removes this hazard; until then, keep literals above parameters.
 */
const routes: Route[] = [
  {
    method: 'GET',
    pattern: '/employees',
    handler: (caller) => listVisibleEmployees(caller),
  },
  {
    method: 'GET',
    pattern: '/employees/active',
    handler: (caller) => listActiveEmployees(caller),
  },
  {
    method: 'GET',
    pattern: '/employees/exited',
    handler: (caller) => listExitedEmployees(caller),
  },
  {
    // ?ids=a,b,c — a POST would be tidier for a long list, but this is a read
    // and should stay cacheable and idempotent.
    method: 'GET',
    pattern: '/employees/by-ids',
    handler: (caller, req) => {
      const ids = new URL(req.url ?? '/', 'http://x').searchParams.get('ids');
      return getEmployeesByIds(caller, ids ? ids.split(',').filter(Boolean) : []);
    },
  },
  {
    method: 'GET',
    pattern: '/employees/:id/team',
    handler: (caller, req, params) => {
      const deep = new URL(req.url ?? '/', 'http://x').searchParams.get('deep') === 'true';
      return getTeam(caller, params.id!, deep);
    },
  },
  {
    method: 'PUT',
    pattern: '/employees/:id/role',
    handler: (caller, _req, params, body) =>
      setEmployeeRole(caller, params.id!, (body as { role: 'admin' | 'manager' | 'employee' }).role),
  },
  {
    method: 'GET',
    pattern: '/employees/:id',
    handler: async (caller, _req, params) => {
      const one = await getEmployee(caller, params.id!);
      if (!one) throw new NotFound('no such employee');
      return one;
    },
  },
  {
    method: 'GET',
    pattern: '/employees/:id/profile',
    handler: async (caller, _req, params) => {
      const profile = await getEmployeeProfile(caller, params.id!);
      if (!profile) throw new NotFound('no such employee');
      return profile;
    },
  },
  {
    method: 'POST',
    pattern: '/leave',
    handler: (caller, _req, _params, body) =>
      applyForLeave(caller, body as Parameters<typeof applyForLeave>[1]),
  },
  {
    method: 'POST',
    pattern: '/leave/:id/approve',
    handler: (caller, _req, params) => approveLeave(caller, params.id!),
  },
  {
    method: 'POST',
    pattern: '/leave/:id/cancel',
    handler: (caller, _req, params) => cancelLeave(caller, params.id!),
  },
];

export class NotFound extends Error {}

/** Match a concrete path against a pattern, extracting :params. */
function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const q = path.split('/').filter(Boolean);
  if (p.length !== q.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i]!;
    const value = q[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(value);
    else if (seg !== value) return null;
  }
  return params;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A body larger than this is not a form submission.
    if (size > 1_000_000) throw new BadRequest('request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}

export class BadRequest extends Error {}

const bearer = (req: IncomingMessage): string | undefined => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim();
};

/**
 * Turn an error into a status and a message.
 *
 * The default is 500 with no detail. Leaking a database error to a caller is
 * how table names and column names end up in somebody's notes.
 */
function statusFor(error: unknown): { status: number; message: string } {
  if (error instanceof AuthError) return { status: 401, message: error.message };
  if (error instanceof TenantContextError) return { status: 401, message: 'no tenant context' };
  if (error instanceof NotFound) return { status: 404, message: error.message };
  if (error instanceof BadRequest) return { status: 400, message: error.message };
  if (error instanceof LeaveError) {
    const status = error.code === 'forbidden' || error.code === 'self_approval' ? 403
      : error.code === 'not_found' ? 404
        : 409;
    return { status, message: error.message };
  }
  return { status: 500, message: 'internal error' };
}

const send = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // This API is called by a browser SPA on another origin; it must never be
    // reachable from a page the user did not open deliberately.
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
};

export function createApp() {
  return createServer((req, res) => {
    void (async () => {
      // Before anything else, including auth: a preflight carries no
      // credentials and must be answered whatever the route turns out to be.
      if (applyCors(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/health') {
        send(res, 200, { ok: true });
        return;
      }

      try {
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const params = match(route.pattern, url.pathname);
          if (!params) continue;

          const caller = await callerFromToken(bearer(req));
          const body = req.method === 'GET' ? undefined : await readJsonBody(req);
          const result = await route.handler(caller, req, params, body);
          send(res, 200, result);
          return;
        }
        send(res, 404, { error: 'no such route' });
      } catch (error) {
        const { status, message } = statusFor(error);
        if (status >= 500) console.error('[http] unhandled', error);
        send(res, status, { error: message });
      }
    })();
  });
}
