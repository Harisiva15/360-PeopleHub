/**
 * The HTTP transport.
 *
 * One place that knows how to reach the API, attach the caller's token, and
 * turn a failure into an Error the screens already handle. Everything above it
 * calls service methods and stays unaware there is a network at all.
 */

import { sessionSource } from './session';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** True when this build has an API to talk to. Without one, screens use the mock. */
export const apiConfigured = Boolean(BASE);

/**
 * What kind of failure this was, as something other code can branch on.
 *
 * It existed as prose in the message, and one caller — the toast suppressor in
 * `services/react.tsx` — matched on that prose with `/not signed in/i`. Which
 * meant the sentence was load-bearing: rewording it changed behaviour
 * somewhere else, silently. Worse, it could not express the distinction that
 * actually matters, because "not signed in" was the message for both a genuine
 * sign-out and a token being renewed.
 */
export type ApiErrorKind =
  /** There is no session. The auth layer is already handling it. */
  | 'no_session'
  /** Signed in, but the token was being renewed and the renewal did not land. */
  | 'session_renewing'
  /** Network or CORS. The browser will not say which. */
  | 'unreachable'
  /** Refused before sending — see `assertNoDemoIds`. */
  | 'refused'
  /** The server answered, with a status that is not ok. */
  | 'http';

export class ApiError extends Error {
  readonly status: number;

  readonly kind: ApiErrorKind;

  /**
   * The service's own refusal code, where the server sent one.
   *
   * `kind` above is about the transport — no session, unreachable, a renewal
   * that did not land. This is about the refusal: `outside_window`,
   * `already_in`, `no_punch_in`, `forbidden`. They are different questions and
   * a screen usually wants the second one.
   *
   * Before this existed the only machine-readable thing a refusal carried was
   * the status, which puts every 409 in one bucket, so the punch card had to
   * match the message text to decide whether to offer an attendance
   * correction. That works until somebody rewords a sentence, and then it
   * fails silently — the button simply stops appearing.
   *
   * Undefined for a transport failure and for a 500, both of which have no
   * service refusal behind them.
   */
  readonly code: string | undefined;

  /** Structured context the refusal is about — see the server's `detailOf`. */
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    status: number,
    message: string,
    kind: ApiErrorKind = 'http',
    code?: string,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.code = code;
    this.detail = detail;
  }
}


/** The structured context on an error, whatever threw it. */
export const errorDetail = (e: unknown): Record<string, unknown> | undefined => {
  const d = (e as { detail?: unknown } | null)?.detail;
  return d && typeof d === 'object' && !Array.isArray(d)
    ? d as Record<string, unknown>
    : undefined;
};

/** Is this the one failure that must not be reported? See `announceFailure`. */
export const isNoSessionError = (e: unknown): boolean =>
  e instanceof ApiError && e.kind === 'no_session';

export const SESSION_RENEWING_MESSAGE =
  'Your session was being renewed and this did not go through. Try again.';

/**
 * The token to send, waiting out a renewal if one is in progress.
 *
 * Read per request rather than cached: supabase-js refreshes in the background,
 * and a token captured at startup is the one that expires mid-session and
 * produces a mystery 401 an hour in.
 *
 * ## The retry, and why it is safe for a write
 *
 * When there is no token and a session has been seen, this waits for the
 * renewal and asks once more. That is a retry of the *whole request* and not
 * only of the token, because nothing has been sent yet — the throw it replaces
 * happened before `fetch`. So this cannot double-apply a PUT, and it needs no
 * idempotency key to be correct.
 *
 * A 401 *from the server* is deliberately not retried here. By then the
 * request has been sent and judged, and retrying on the server's own refusal
 * is a different decision with different consequences.
 */
async function bearerToken(): Promise<string> {
  const session = sessionSource();

  const first = await session.token();
  if (first) return first;

  /*
   * Nothing to wait for. Said plainly and kept quiet by `kind`, because the
   * login page is already on its way up and a toast would land on top of it,
   * once per in-flight query.
   */
  if (session.signedOut()) throw new ApiError(401, 'You are not signed in', 'no_session');

  const renewed = await session.refresh();
  if (renewed) return renewed;

  /*
   * Signed in, and the renewal still produced nothing. This is the case that
   * used to be indistinguishable from a sign-out and is the one worth saying
   * out loud: the person is signed in, the screen is missing data, and trying
   * again is a reasonable thing to ask of them.
   */
  throw new ApiError(401, SESSION_RENEWING_MESSAGE, 'session_renewing');
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
    /*
     * What this says, and what it must not claim.
     *
     * `DEMO_ID` matches a *shape*, not a list of real demo ids, so a value it
     * refuses has not been proved to come from anywhere in particular. The
     * message used to assert "This id comes from src/data" and that was wrong
     * the first time it fired in anger: the server's own `nextEmployeeCode`
     * minted `E007` for a tenant whose codes are VHM004-006, the guard refused
     * it, and the sentence sent the reader hunting through `src/data` for a
     * value that was never there.
     *
     * So it now describes what was observed and offers the demo dataset as the
     * likely cause rather than the established one. The refusal itself is
     * unchanged — a value of this shape is still never sent.
     */
    throw new ApiError(0,
      `Refusing to send: ${found.join(', ')} in ${method} ${path}. `
      + 'That value looks like a demo id (E followed by three digits), which is '
      + 'how src/data numbers its people — so the screen that made this call may '
      + 'be reading the demo dataset. If it is not, something upstream is '
      + 'generating ids in that shape.', 'refused');
  }
}

/**
 * A body that is bytes rather than a form.
 *
 * Only an uploaded file needs this. Sent as-is with its own content type, so
 * the server reads it with `readRawBody` instead of parsing JSON — base64 in a
 * JSON body would inflate 2 MB of image to 2.7 MB of request and spend the
 * difference on nothing. The content type is a claim and the server verifies
 * it against the file's magic number; it is not trusted here.
 */
export interface RawBody {
  blob: Blob;
  mimeType: string;
}

const isRaw = (b: unknown): b is RawBody =>
  typeof b === 'object' && b !== null && 'blob' in b && 'mimeType' in b;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  /* A Blob carries no ids to leak, and walking one is meaningless. */
  if (!isRaw(body)) assertNoDemoIds(method, path, body);

  /* Throws for both session cases, each with the `kind` that decides whether
     anybody is told about it. */
  const token = await bearerToken();

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : isRaw(body)
          ? { 'content-type': body.mimeType }
          : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : {
        body: isRaw(body) ? body.blob : JSON.stringify(body),
      }),
    });
  } catch {
    // fetch rejects for network failure and for CORS. The browser deliberately
    // does not say which, so neither can this message.
    throw new ApiError(0, 'Could not reach the server', 'unreachable');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const body = payload as {
      error?: string; code?: string; detail?: Record<string, unknown>;
    } | undefined;
    const message = body?.error ?? `Request failed (${response.status})`;
    throw new ApiError(response.status, message, 'http', body?.code, body?.detail);
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
