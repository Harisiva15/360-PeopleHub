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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Query string from defined values only, so `?ids=` never appears empty. */
export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
};
