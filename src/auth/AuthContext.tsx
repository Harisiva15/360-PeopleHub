/**
 * Session state.
 *
 * Holds whatever Supabase says the current session is, and nothing else. It
 * deliberately does not decide what the signed-in user may *do* — that comes
 * from tenant_membership on the server, on every request. A role cached in the
 * browser is a suggestion, and treating it as an authority is how a demoted
 * manager keeps their access until their token expires.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { authConfigured, redirectTo, supabase } from './supabase';
import { clearLastActivity } from './idle';
import { assurance, blocksOn, mfaAvailable, usedFactor } from './mfa';
import type { SsoProvider } from './supabase';

export interface AuthState {
  /** False in demo mode: there is nothing to sign in to. */
  configured: boolean;
  /** Null until the first session check resolves, so nothing flashes. */
  ready: boolean;
  session: Session | null;
  email: string | null;
  displayName: string | null;

  signInWithPassword: (email: string, password: string) => Promise<void>;
  signInWithSso: (provider: SsoProvider) => Promise<void>;
  sendMagicLink: (email: string) => Promise<void>;
  /**
   * Ends the session and records why.
   *
   * The reason is a parameter rather than something the caller records
   * separately, so there is exactly one place a sign-out is written down.
   * Two recorders meant two rows for one event the first time this was
   * built — an idle timeout showed up as an idle timeout *and* somebody
   * pressing the button.
   */
  signOut: (reason?: 'manual' | 'idle') => Promise<void>;

  /**
   * True while a session exists that has not yet satisfied its second factor.
   *
   * Null until the answer is known, so the gate can wait rather than guess —
   * rendering the app for the instant before the check resolves would be the
   * whole bypass.
   */
  mfaRequired: boolean | null;
  /** Re-reads the assurance level after a challenge is answered. */
  refreshMfa: () => Promise<void>;

  /**
   * Emails a password-reset link.
   *
   * Resolves the same way whether or not the address has an account. Telling
   * somebody "no such user" turns the form into a way to find out who works
   * here, and the reassurance is worth nothing against the cost.
   */
  sendPasswordReset: (email: string) => Promise<void>;
  /** Sets a new password on the current session. */
  setPassword: (password: string) => Promise<void>;

  /**
   * True while this account owes a new password — either an administrator
   * reset it, or Supabase brought the session back through a recovery link.
   * Null until known, so the gate waits rather than guessing.
   */
  passwordChangeRequired: boolean | null;
  /**
   * True while an administrator requires a second factor and none exists.
   * Satisfied by the person enrolling one; nobody can do it for them.
   */
  mfaEnrolmentRequired: boolean | null;
  /** Re-reads both obligations, after one has been met. */
  refreshPasswordStatus: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!authConfigured);
  const [mfaRequired, setMfaRequired] = useState<boolean | null>(null);
  const [mustChange, setMustChange] = useState<boolean | null>(null);
  const [mustEnrol, setMustEnrol] = useState<boolean | null>(null);
  /*
   * Supabase reports a recovery link as its own event. The session it hands
   * back is real and would otherwise drop somebody straight into the app
   * without ever asking for the new password the link was for.
   */
  const [recovering, setRecovering] = useState(false);
  /*
   * Set when a sign-in begins and cleared when it is recorded, so the
   * history gets exactly one row per sign-in — written after the second
   * factor rather than before it, because until then the sign-in has not
   * actually happened and the method is not yet known.
   */
  const signingIn = useRef(false);

  /**
   * Read how far this session has been proven, and act on the answer.
   *
   * Two things come out of one call, and they have to come from the same one:
   * whether the gate blocks, and — once it does not — which method to record.
   * Asking twice would let a factor verified in between produce a row saying
   * "password".
   *
   * Fails closed. If the level cannot be read, the session is treated as owing
   * a factor: a network error must not be a way past the gate. The cost of the
   * strict direction is somebody seeing the code screen when they need not;
   * the cost of the lax one is no second factor at all.
   */
  const settleAssurance = useCallback(async () => {
    if (!mfaAvailable()) { setMfaRequired(false); return; }

    let outstanding = true;
    let viaFactor = false;
    try {
      const level = await assurance();
      // Both answers from one read. Asking twice would let a factor verified
      // in between produce a history row that says "password".
      outstanding = blocksOn(level);
      viaFactor = usedFactor(level);
    } catch {
      /* Left outstanding. See above. */
    }
    setMfaRequired(outstanding);

    /*
     * One row per sign-in, written only once the sign-in is complete.
     * Swallowed: nobody should be held out of the app because a history row
     * did not write.
     */
    if (!outstanding && signingIn.current) {
      signingIn.current = false;
      try {
        const { getServices } = await import('../services');
        const { data } = await supabase!.auth.getSession();
        await getServices().users.lastLoginNow(
          { role: 'employee', meId: data.session?.user?.id ?? '' },
          viaFactor ? 'mfa' : 'password');
      } catch { /* see above */ }
    }
  }, []);

  const refreshMfa = useCallback(async () => { await settleAssurance(); }, [settleAssurance]);

  /**
   * Whether this account owes a new password.
   *
   * Two sources, and either is enough. `recovering` is a session that arrived
   * through a reset link, which has to end in a new password or the link did
   * nothing. `mustChange` is the flag an administrator set — stored since 0030,
   * displayed in the user drawer since, and until now enforced nowhere.
   *
   * Fails closed on an error, like the assurance check: if we cannot tell, the
   * safe answer is to ask.
   */
  const refreshPasswordStatus = useCallback(async () => {
    if (!authConfigured) { setMustChange(false); setMustEnrol(false); return; }
    try {
      const { getServices } = await import('../services');
      const { data } = await supabase!.auth.getSession();
      const r = await getServices().users.accountStatus({
        role: 'employee', meId: data.session?.user?.id ?? '',
      });
      setMustChange(Boolean(r.mustChangePassword));
      setMustEnrol(Boolean(r.mustEnrolMfa));
    } catch {
      /*
       * Fails closed on the password and *open* on the enrolment, and the
       * asymmetry is deliberate. An unanswered password obligation costs one
       * screen somebody can complete. An unanswered enrolment obligation would
       * strand every account behind a QR code the moment this call failed —
       * including accounts with no requirement at all — and the way out of
       * that is an administrator who cannot help.
       */
      setMustChange(true);
      setMustEnrol(false);
    }
  }, []);

  const sendPasswordReset = useCallback(async (email: string) => {
    if (!supabase) throw new Error('authentication is not configured for this build');
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo(),
    });
    /*
     * Swallowed on purpose, with one exception below. Surfacing "user not
     * found" would make this form an address checker; the screen says the same
     * sentence either way.
     */
    if (error && /rate|too many/i.test(error.message)) throw new Error(error.message);
  }, []);

  const setPassword = useCallback(async (password: string) => {
    if (!supabase) throw new Error('authentication is not configured for this build');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message);
    /*
     * Supabase owns the password, so the flag is cleared by telling this
     * application the change happened. See the note on passwordChanged in the
     * users service for why that is acceptable here and what would replace it.
     */
    try {
      const { getServices } = await import('../services');
      const { data } = await supabase.auth.getSession();
      await getServices().users.passwordChanged({
        role: 'employee', meId: data.session?.user?.id ?? '',
      });
    } catch { /* The password did change; the reminder simply stays. */ }
    setRecovering(false);
    setMustChange(false);
  }, []);

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;
    // An existing session may be in storage, or arriving in the URL fragment
    // after an OAuth redirect. Either way this resolves it once.
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setReady(true);
      // A reload lands here rather than on SIGNED_IN, and a reloaded tab owes
      // its second factor exactly as much as a fresh sign-in does.
      if (data.session) { void settleAssurance(); void refreshPasswordStatus(); }
      else { setMfaRequired(false); setMustChange(false); setMustEnrol(false); }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setReady(true);

      /*
       * Mark the sign-in, and settle the second factor before recording it.
       *
       * Only on SIGNED_IN — not on TOKEN_REFRESHED, which fires every hour,
       * and not on the initial getSession above, which fires on every tab and
       * every reload. Either would turn "last signed in" into "last opened a
       * tab", and that figure is what an administrator uses to decide an
       * account is dormant.
       *
       * The row itself is written by settleAssurance, not here. A sign-in that
       * still owes a second factor has not happened yet, and writing it at this
       * point would also record every one of them as a password sign-in — which
       * is the figure the security screen now reports.
       */
      if (event === 'SIGNED_IN') signingIn.current = true;
      if (event === 'SIGNED_OUT') {
        signingIn.current = false;
        setMfaRequired(null);
      }
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      if (next) { void settleAssurance(); void refreshPasswordStatus(); }
      else { setMustChange(false); setMustEnrol(false); }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [settleAssurance, refreshPasswordStatus]);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    if (!supabase) throw new Error('authentication is not configured for this build');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }, []);

  const signInWithSso = useCallback(async (provider: SsoProvider) => {
    if (!supabase) throw new Error('authentication is not configured for this build');
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: redirectTo() },
    });
    if (error) throw new Error(error.message);
    // On success the browser navigates away; nothing after this runs.
  }, []);

  const sendMagicLink = useCallback(async (email: string) => {
    if (!supabase) throw new Error('authentication is not configured for this build');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo() },
    });
    if (error) throw new Error(error.message);
  }, []);

  const signOut = useCallback(async (reason: 'manual' | 'idle' = 'manual') => {
    if (!supabase) return;
    /*
     * Recorded before the token goes: afterwards there is no caller to
     * attribute it to, and an unattributed row is not worth writing.
     *
     * Swallowed, and deliberately: somebody pressing Sign out must end up
     * signed out whatever the network is doing. A sign-out that can fail is
     * worse than a history with a gap in it.
     */
    const uid = session?.user?.id;
    if (uid) {
      try {
        const { getServices } = await import('../services');
        await getServices().users.signOut({ role: 'employee', meId: uid }, reason);
      } catch { /* see above */ }
    }
    clearLastActivity();
    await supabase.auth.signOut();
    setSession(null);
    setMfaRequired(null);
    setMustChange(null);
    setMustEnrol(null);
    setRecovering(false);
    signingIn.current = false;
  }, [session]);

  const value = useMemo<AuthState>(() => ({
    configured: authConfigured,
    ready,
    session,
    email: session?.user.email ?? null,
    displayName:
      (session?.user.user_metadata?.full_name as string | undefined)
      ?? (session?.user.user_metadata?.name as string | undefined)
      ?? session?.user.email
      ?? null,
    signInWithPassword,
    signInWithSso,
    sendMagicLink,
    signOut,
    mfaRequired,
    refreshMfa,
    sendPasswordReset,
    setPassword,
    // A recovery link is a pending password change even before the flag is read.
    passwordChangeRequired: recovering ? true : mustChange,
    mfaEnrolmentRequired: mustEnrol,
    refreshPasswordStatus,
  }), [
    ready, session, signInWithPassword, signInWithSso, sendMagicLink, signOut,
    mfaRequired, refreshMfa, sendPasswordReset, setPassword, recovering, mustChange,
    mustEnrol, refreshPasswordStatus,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
