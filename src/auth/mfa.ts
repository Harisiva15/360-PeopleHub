/**
 * Two-factor sign-in, over Supabase Auth's TOTP factors.
 *
 * **Nothing here stores or checks a code.** Supabase holds the shared secret,
 * decides whether a six-digit code is right, and rate-limits the attempts. That
 * is the whole reason for using it: a hand-rolled OTP table is a list of live
 * credentials, and the hard parts — constant-time comparison, replay of a code
 * inside its window, throttling per account rather than per request — are the
 * parts that get skipped. This file is a boundary, not an implementation.
 *
 * **What the brief asked for, and what TOTP actually does.** Worth being exact,
 * because three of the requirements do not translate and building something
 * that looks like them would be worse than not having them:
 *
 *   *Six digits* — yes. TOTP is six digits by definition.
 *
 *   *Five-minute expiry* — no, and shorter. A TOTP code is valid for its
 *   30-second step, and Supabase accepts the adjacent step for clock drift, so
 *   roughly a minute. The five-minute figure belongs to a code somebody is
 *   emailed; nothing is emailed here.
 *
 *   *Resend, with a cooldown* — does not exist. An authenticator app is not
 *   sent anything; it computes the code from a secret and the clock. A "resend"
 *   button would be a control that cannot do anything, which is worse than its
 *   absence. The way out of a lost authenticator is a recovery code or an
 *   administrator, and the screens say so.
 *
 *   *Maximum five attempts* — Supabase throttles verification server-side. The
 *   limit is theirs and is not five, and a counter in the browser would be a
 *   number an attacker simply does not send. Not reimplemented.
 *
 * **Enrolment is not the gate.** A verified factor only matters because
 * `assuranceLevel` is checked on every render of the gate — see AuthContext.
 * Enrolling a factor and then letting the app run at aal1 would be a padlock
 * hanging open.
 */

import { supabase } from './supabase';

export interface TotpEnrolment {
  factorId: string;
  /** An SVG, usually as a data: URI. Rendered, never parsed. */
  qrCode: string;
  /** For somebody typing it into an app by hand rather than scanning. */
  secret: string;
}

export interface Factor {
  id: string;
  friendlyName: string;
  /** Supabase keeps unverified factors from an abandoned enrolment. */
  verified: boolean;
}

export type Assurance = 'none' | 'aal1' | 'aal2';

export class MfaError extends Error {}

/**
 * Supabase's message, or a sentence somebody can act on.
 *
 * The raw errors here are short and unhelpful at exactly the moment somebody
 * is anxious — "Invalid TOTP code entered" tells a person nothing about the
 * clock on their phone, which is the usual cause after a correct-looking code
 * fails twice.
 */
function readable(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid totp') || m.includes('invalid code')) {
    return 'That code was not accepted. Codes change every 30 seconds — wait for '
      + 'the next one and try again. If it keeps failing, check the time on your '
      + 'phone is set automatically.';
  }
  if (m.includes('rate') || m.includes('too many')) {
    return 'Too many attempts. Wait a minute before trying again.';
  }
  if (m.includes('expired')) {
    return 'That took too long. Start again and enter the code as it appears.';
  }
  return message;
}

function client() {
  if (!supabase) {
    throw new MfaError(
      'Two-factor sign-in needs a configured Supabase project. This build has none.');
  }
  return supabase;
}

/** Whether this build can offer it at all. Demo mode cannot. */
export const mfaAvailable = (): boolean => Boolean(supabase);

/**
 * The factors on this account.
 *
 * Unverified ones are included: an enrolment somebody abandoned halfway leaves
 * a factor behind, and the screen has to be able to offer to clear it rather
 * than refusing to enrol a second one for a reason nobody can see.
 */
export async function listFactors(): Promise<Factor[]> {
  const { data, error } = await client().auth.mfa.listFactors();
  if (error) throw new MfaError(readable(error.message));
  return (data?.all ?? [])
    .filter((f) => f.factor_type === 'totp')
    .map((f) => ({
      id: f.id,
      friendlyName: f.friendly_name ?? 'Authenticator app',
      verified: f.status === 'verified',
    }));
}

/**
 * Begin enrolment. Produces a secret; does not yet protect anything.
 *
 * The factor exists in an unverified state until a code from it is accepted.
 * That is the right order — a factor that counted before it was proven would
 * lock somebody out of their own account the moment they mistyped the setup.
 */
export async function enrol(friendlyName = 'Authenticator app'): Promise<TotpEnrolment> {
  const { data, error } = await client().auth.mfa.enroll({
    factorType: 'totp',
    friendlyName,
  });
  if (error) throw new MfaError(readable(error.message));
  if (!data) throw new MfaError('Supabase returned no enrolment.');
  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

/**
 * Prove the new factor works, which is what makes it count.
 *
 * `challengeAndVerify` rather than a separate challenge and verify: the two
 * are one act from the person's side, and holding a challenge id across a
 * render is a way to send a stale one.
 */
export async function confirmEnrolment(factorId: string, code: string): Promise<void> {
  const { error } = await client().auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw new MfaError(readable(error.message));
}

/** The step-up at sign-in. Same call; different moment, so it is named twice. */
export async function verifyChallenge(factorId: string, code: string): Promise<void> {
  const { error } = await client().auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw new MfaError(readable(error.message));
}

/**
 * Remove a factor.
 *
 * Deliberately has no confirmation of its own here — the screen asks, because
 * that is where the consequence can be spelled out. What this must never
 * become is something reachable without a current session at aal2, and it is
 * not: Supabase refuses to unenrol a verified factor from an aal1 session.
 */
export async function unenrol(factorId: string): Promise<void> {
  const { error } = await client().auth.mfa.unenroll({ factorId });
  if (error) throw new MfaError(readable(error.message));
}

/**
 * How far this session has been proven, and how far it could be.
 *
 * `next` above `current` is the whole signal: it means a verified factor exists
 * and this session has not satisfied it. That is the condition the gate blocks
 * on, and it comes from Supabase rather than from anything this app stores, so
 * it cannot be turned off by editing local state.
 */
export async function assurance(): Promise<{ current: Assurance; next: Assurance }> {
  const { data, error } = await client().auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw new MfaError(readable(error.message));
  return {
    current: (data?.currentLevel ?? 'none') as Assurance,
    next: (data?.nextLevel ?? 'none') as Assurance,
  };
}

/**
 * The gate's decision, as a function of two strings.
 *
 * Pulled out of the effect that calls it so it can be checked exhaustively —
 * every pair of levels, including the ones that only occur when something has
 * gone wrong. The bug this shape prevents is the one that cannot be reproduced
 * by using the application: a session that renders the app for the instant
 * before an async check comes back.
 *
 * `next` above `current` is the whole signal. Supabase sets `next` to 'aal2'
 * when a verified factor exists on the account, and `current` to 'aal2' once
 * this particular session has satisfied it.
 */
export function blocksOn(level: { current: Assurance; next: Assurance }): boolean {
  return level.next === 'aal2' && level.current !== 'aal2';
}

/** Whether this sign-in went through a factor — what gets recorded as method. */
export function usedFactor(level: { current: Assurance; next: Assurance }): boolean {
  return level.next === 'aal2' && level.current === 'aal2';
}

/**
 * Does this session still owe a second factor?
 *
 * Fails *closed* on an error. If we cannot tell whether a factor is required,
 * the safe answer is that it is — an exception here would otherwise be a way
 * past the gate, and a network blip must not be one.
 */
export async function challengeOutstanding(): Promise<boolean> {
  if (!supabase) return false;
  try {
    return blocksOn(await assurance());
  } catch {
    return true;
  }
}

/** Six digits, nothing else. Trimmed of the spaces authenticator apps show. */
export const normaliseCode = (raw: string): string => raw.replace(/\D/g, '').slice(0, 6);
export const codeComplete = (raw: string): boolean => normaliseCode(raw).length === 6;
