/**
 * The sign-in page.
 *
 * Single sign-on comes first because it is what a company with a directory
 * actually uses, and because it is the option where this app never sees a
 * password. Email and password sits below it for the accounts SSO does not
 * cover — contractors, the break-glass admin — rather than as the default.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { logoFor } from '../assets/logo';
import { ORG } from '../data/org';
import { useAuth } from './AuthContext';
import { providerLabel, ssoProviders } from './supabase';
import type { SsoProvider } from './supabase';

const PROVIDER_MARK: Record<SsoProvider, string> = {
  google: 'G',
  azure: '⊞',
  github: '⌥',
};

export function LoginPage({ theme }: { theme: 'light' | 'dark' }) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (action: () => Promise<void>, after?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (after) setNotice(after);
    } catch (e) {
      /*
       * Supabase returns "Invalid login credentials" for both a wrong password
       * and an address that has no account, which is the correct behaviour —
       * distinguishing them tells an attacker which addresses are registered.
       * Pass it through rather than trying to be more helpful.
       */
      setError(e instanceof Error ? e.message : 'Could not sign you in');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email address and password');
      return;
    }
    void run(() => auth.signInWithPassword(email.trim(), password));
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <img className="login-logo" src={logoFor(theme)} alt={ORG.name} />
        <h1>{ORG.product}</h1>
        <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>
          Sign in to {ORG.legal}
        </p>

        {ssoProviders.length > 0 && (
          <>
            <div className="stack" style={{ gap: 9, marginTop: 22 }}>
              {ssoProviders.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn login-sso"
                  disabled={busy}
                  onClick={() => void run(() => auth.signInWithSso(p))}
                >
                  <span className="login-mark">{PROVIDER_MARK[p]}</span>
                  Continue with {providerLabel(p)}
                </button>
              ))}
            </div>
            <div className="login-or"><span>or</span></div>
          </>
        )}

        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="login-email">Work email</label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="login-msg err" role="alert">{error}</div>}
          {notice && <div className="login-msg ok" role="status">{notice}</div>}

          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <button
          type="button"
          className="btn ghost"
          disabled={busy || !email.trim()}
          style={{ width: '100%', marginTop: 9 }}
          onClick={() => void run(
            () => auth.sendMagicLink(email.trim()),
            'Check your inbox for a sign-in link.',
          )}
        >
          Email me a sign-in link instead
        </button>

        <p className="login-foot muted">
          Access is granted by your HR administrator. If you cannot sign in, ask them
          to check your account rather than creating a new one.
        </p>
      </div>
    </div>
  );
}
