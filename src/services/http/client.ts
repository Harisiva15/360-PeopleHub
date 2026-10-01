/**
 * The HTTP transport.
 *
 * One place that knows how to reach the API, attach the caller's token, and
 * turn a failure into an Error the screens already handle. Everything above it
 * calls service methods and stays unaware there is a network at all.
 */

import { supabase } from '../../auth/supabase';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** True when this build has an API to talk to. Without one, screens use the mock. */
export const apiConfigured = Boolean(BASE);

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * The current access token.
 *
 * Read per request rather than cached: supabase-js refreshes in the background,
 * and a token captured at startup is the one that expires mid-session and
 * produces a mystery 401 an hour in.
 */
async function bearerToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Ids that belong to the demo dataset and nowhere near a real tenant.
 *
 * `src/data/employees.ts` numbers its people `E001`…`E0NN`. The real database
 * keys employees by uuid, so one of these reaching the API is not a permission
 * problem or a not-found — Postgres rejects it while parsing:
 *
 *     22P02  invalid input syntax for type uuid: "E008"
 *
 * That ran on every sign-in. `AppProvider` seeded `meId` from `ACCOUNTS()` and
 * `me` from `EMAP`, so for one render the signed-in person was the demo HR head
 * `E008` whose `managerId` is `E001`, and the screens that query on mount sent
 * them straight out.
 *
 * The real fix is upstream — `AuthGate` now renders nothing until the server
 * has said who you are, so there is no provisional identity to leak. This is
 * the net under that: a new screen reaching for the demo dataset fails here,
 * loudly, in the one place every request passes through, instead of producing a
 * 500 and a line in somebody's database log.
 */
const DEMO_ID = /^E\d{3}$/;

/**
 * Every string in a request, with the path it sits at, for the guard below.
 *
 * Walks arrays and objects rather than stringifying, so `{ids: ['E001']}` is
 * seen as the element it is. Depth is capped because a request body is a form,
 * not a graph, and a cycle here would hang the send.
 */
function strings(value: unknown, at = 'body', depth = 0): [string, string][] {
  if (depth > 6) return [];
  if (typeof value === 'string') return [[at, value]];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => strings(v, `${at}[${i}]`, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`, depth + 1));
  }
  return [];
}

/**
 * Refuse to send a demo id to a real API.
 *
 * Checks the path — its segments and every comma-separated query value, because
 * `byIds` sends `?ids=a,b,c` — and every string in the body.
 *
 * It throws rather than dropping the value. A dropped id turns into a request
 * for the wrong thing or for nothing, which is the class of quiet wrongness
 * this whole guard exists to stop; an exception names the call that did it.
 */
export function assertNoDemoIds(method: string, path: string, body?: unknown): void {
  const found: string[] = [];

  const [route, query = ''] = path.split('?');
  for (const seg of (route ?? '').split('/')) {
    if (DEMO_ID.test(decodeURIComponent(seg))) found.push(`path segment "${seg}"`);
  }
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    for (const one of decodeURIComponent(v).split(',')) {
      if (DEMO_ID.test(one)) found.push(`query ${k}="${one}"`);
    }
  }
  for (const [at, v] of strings(body)) {
    if (DEMO_ID.test(v)) found.push(`${at}="${v}"`);
  }

  if (found.length) {
    throw new ApiError(0,
      `Refusing to send demo data to the API: ${found.join(', ')} in ${method} ${path}. `
      + 'This id comes from src/data, not from the signed-in session — the screen '
      + 'that made this call is reading the demo dataset.');
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  assertNoDemoIds(method, path, body);

  const token = await bearerToken();
  if (!token) throw new ApiError(401, 'You are not signed in');

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // fetch rejects for network failure and for CORS. The browser deliberately
    // does not say which, so neither can this message.
    throw new ApiError(0, 'Could not reach the server');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const message = (payload as { error?: string } | undefined)?.error
      ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  /*
   * PATCH, not PUT, for a partial update.
   *
   * The distinction is load-bearing here rather than pedantic: every `update`
   * in these contracts takes a `Partial<Draft>`, and a PUT is defined as
   * replacing the whole resource. A server that treated one as the other would
   * blank every field the screen did not send — which is exactly what an edit
   * form that only shows half the record would do.
   */
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Query string from defined values only, so `?ids=` never appears empty. */
export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
};
