/**
 * The one place this server acts as Supabase rather than as a caller of it.
 *
 * Everywhere else, the server verifies a token against a public JWKS endpoint
 * and talks to Postgres as `app_rw`, which row-level security constrains. It
 * holds no signing secret and can mint nothing. This module is the exception:
 * it carries the service-role key, which bypasses RLS and creates accounts.
 *
 * So it is deliberately small, and it does exactly two things.
 *
 * **Why REST rather than the SDK.** `@supabase/supabase-js` would be a new
 * dependency and a client object with far more reach than this needs — a whole
 * database and storage API on the same credential. Two `fetch` calls are the
 * entire requirement, and a narrow surface is the point of a module like this.
 *
 * **The seam exists for the tests, not for flexibility.** Everything worth
 * testing about invitations — who may send one, which memberships are
 * eligible, that a failure does not mark an invitation sent — is authorisation
 * and state, and none of it should require an email to be delivered to prove.
 * `setAuthAdmin` lets a test substitute this; nothing in production calls it.
 *
 * **The key never leaves this file.** It is read from config here, put in a
 * header here, and appears in no return value, no error message and no log
 * line. `checks/` asserts it is absent from the frontend entirely.
 */

import { config } from '../config.ts';

export class AdminApiError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
  }
}

/** What happened to the address, as far as the caller needs to know. */
export type InviteResult =
  /** No auth user existed; one was created and an invitation email sent. */
  | { kind: 'invited' }
  /**
   * An auth user already existed for the address — a re-invitation, or
   * somebody who has signed in before. A password-recovery email is sent
   * instead, which is the supported way to let them set one, and no second
   * auth user is created.
   */
  | { kind: 'recovered' };

export interface AuthAdmin {
  /**
   * Invite `email` to set a password, sending them to `redirectTo`.
   *
   * Resolves only when Supabase confirmed it accepted the request. Anything
   * else throws, because the caller's next act is to record that an invitation
   * was sent and that record must not be a guess.
   */
  inviteToSetPassword(email: string, redirectTo: string): Promise<InviteResult>;
}

/* ------------------------------------------------------------------ *
 * The real implementation
 * ------------------------------------------------------------------ */

const post = async (path: string, body: unknown): Promise<Response> => {
  if (!config.supabaseServiceKey) {
    throw new AdminApiError(
      'this server is not configured to send invitations '
      + '(SUPABASE_SERVICE_ROLE_KEY is not set)',
      'not_configured');
  }
  return fetch(`${config.supabaseUrl}${path}`, {
    method: 'POST',
    headers: {
      /* Both are required by GoTrue. Neither is ever logged or returned. */
      apikey: config.supabaseServiceKey,
      authorization: `Bearer ${config.supabaseServiceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
};

/**
 * Read an error out of a Supabase response without carrying anything secret.
 *
 * The body is the provider's own message. The request is not echoed, because
 * the request carried the key.
 */
const reasonFrom = async (res: Response): Promise<string> => {
  let detail = '';
  try {
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      detail = String(o.msg ?? o.message ?? o.error_description ?? o.error ?? '').trim();
    }
    if (!detail) detail = text.slice(0, 200);
  } catch { /* a body that is not JSON is not worth a second failure */ }
  return detail || `Supabase returned ${res.status}`;
};

/** Whether Supabase is saying "that address already has an account". */
const alreadyRegistered = (status: number, reason: string): boolean =>
  status === 422
  && /already been registered|already registered|already exists/i.test(reason);

export const supabaseAuthAdmin: AuthAdmin = {
  async inviteToSetPassword(email, redirectTo) {
    const invite = await post('/auth/v1/invite', { email, redirect_to: redirectTo });
    if (invite.ok) return { kind: 'invited' };

    const reason = await reasonFrom(invite);

    /*
     * An address that already has an auth user is the ordinary case for a
     * resend, and for anybody who has signed in before. Creating a second user
     * is impossible and would be wrong anyway, so they are sent a recovery
     * link, which is how Supabase lets an existing user set a new password.
     */
    if (alreadyRegistered(invite.status, reason)) {
      const recover = await post('/auth/v1/recover', { email, redirect_to: redirectTo });
      if (recover.ok) return { kind: 'recovered' };
      throw new AdminApiError(
        `the address already has an account and the reset email was refused: ${await reasonFrom(recover)}`,
        'send_failed');
    }

    if (invite.status === 401 || invite.status === 403) {
      /* Deliberately not saying which key, and never showing it. */
      throw new AdminApiError(
        'Supabase rejected this server\'s credentials', 'not_authorised');
    }
    throw new AdminApiError(`Supabase refused the invitation: ${reason}`, 'send_failed');
  },
};

/* ------------------------------------------------------------------ *
 * The seam
 * ------------------------------------------------------------------ */

let current: AuthAdmin = supabaseAuthAdmin;

/** The implementation in force. Production never changes this. */
export const authAdmin = (): AuthAdmin => current;

/**
 * Substitute the admin API, for tests.
 *
 * Returns the previous one so a test can put it back. Nothing in the running
 * server calls this — the invite path asks `authAdmin()` at the moment it
 * needs it rather than capturing it, so a substitution takes effect.
 */
export function setAuthAdmin(next: AuthAdmin): AuthAdmin {
  const was = current;
  current = next;
  return was;
}

/**
 * Where an invitation sends somebody.
 *
 * `APP_BASE_URL`, and nothing derived from the request: the API and the app
 * are different hosts in production, so the admin's Origin is the wrong
 * answer, and an invitation must not point wherever the caller happened to be.
 */
export function inviteRedirect(): string {
  if (!config.appBaseUrl) {
    throw new AdminApiError(
      'this server has no APP_BASE_URL, so an invitation has nowhere to send anybody',
      'not_configured');
  }
  return config.appBaseUrl;
}
