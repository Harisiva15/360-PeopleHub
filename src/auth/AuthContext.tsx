/**
 * Session state.
 *
 * Holds whatever Supabase says the current session is, and nothing else. It
 * deliberately does not decide what the signed-in user may *do* — that comes
 * from tenant_membership on the server, on every request. A role cached in the
 * browser is a suggestion, and treating it as an authority is how a demoted
 * manager keeps their access until their token expires.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { authConfigured, redirectTo, supabase } from './supabase';
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
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!authConfigured);

  useEffect(() => {
    if (!supabase) return;

    let cancelled = false;
    // An existing session may be in storage, or arriving in the URL fragment
    // after an OAuth redirect. Either way this resolves it once.
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      setReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

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

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
  }, []);

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
  }), [ready, session, signInWithPassword, signInWithSso, sendMagicLink, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
