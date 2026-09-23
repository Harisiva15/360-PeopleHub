/**
 * The sign-in page.
 *
 * Two panels: what the product is on the left, the way in on the right. The
 * left half is the only marketing surface this app has — everything past this
 * page is work — so it carries the name, the promise and the six things the
 * product actually does, and then gets out of the way.
 *
 * **Every control here is real.** A sign-in page is the worst possible place
 * for a button that does nothing: somebody who cannot get in will try all of
 * them. So the single-sign-on row renders only the providers this deployment
 * has configured — one button when one is set up, none at all when none is —
 * rather than a fixed row of logos where two are decoration.
 *
 * Single sign-on stays above the password fields because it is what a company
 * with a directory actually uses, and because it is the path where this app
 * never sees a password at all.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { LOGO_LIGHT } from '../assets/logo';
import { ORG } from '../data/org';
import { useAuth } from './AuthContext';
import { providerLabel, ssoProviders } from './supabase';
import type { SsoProvider } from './supabase';
import { Icon } from '../components/icons';

/** Drawn rather than fetched — a sign-in page should not wait on a CDN. */
const PROVIDER_MARK: Record<SsoProvider, string> = {
  google: 'G',
  azure: '⊞',
  github: '⌥',
};

/**
 * What the product does, in the customer's words rather than the module names.
 *
 * Six because that is what fits on one line at desktop and two at tablet
 * without a row of one. Each maps to a real area of the app; nothing here
 * promises something that is not behind the login.
 */
const CAPABILITIES: { k: string; ic: string; tone: string }[] = [
  { k: 'Employee\nManagement', ic: 'people', tone: 'blue' },
  { k: 'Leave &\nAttendance', ic: 'schedule', tone: 'green' },
  { k: 'Payroll &\nBenefits', ic: 'document', tone: 'violet' },
  { k: 'Performance\n& Growth', ic: 'chart', tone: 'teal' },
  { k: 'Engagement\n& Recognition', ic: 'star', tone: 'amber' },
  { k: 'IT Assets\n& Support', ic: 'laptop', tone: 'rose' },
];

export function LoginPage({ theme: _theme }: { theme: 'light' | 'dark' }) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
       * and an address with no account, which is correct — distinguishing them
       * tells an attacker which addresses are registered. Pass it through
       * rather than trying to be more helpful.
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
    <div className="login-page">
      {/* Decorative only — the shapes carry no information. */}
      <div className="login-bg" aria-hidden="true">
        <span className="lb lb-1" />
        <span className="lb lb-2" />
        <span className="lb lb-3" />
      </div>

      <div className="login-grid">
        <section className="login-pitch">
          <img className="login-brand" src={LOGO_LIGHT} alt={ORG.product} />

          <h1 className="login-head">
            People Today.
            <br />
            <span>A </span><em>Brighter Tomorrow.</em>
          </h1>

          <p className="login-sub">
            Simplify HR. Empower people. Build a stronger workplace
            with {ORG.product}.
          </p>

          <ul className="login-caps">
            {CAPABILITIES.map((c) => (
              <li key={c.k} data-tone={c.tone}>
                <span className="cap-ic" aria-hidden="true">{c.ic}</span>
                <span className="cap-k">{c.k}</span>
              </li>
            ))}
          </ul>

          <p className="login-script">Great people build great companies</p>
        </section>

        <section className="login-panel">
          <div className="login-card">
            <img className="login-logo" src={LOGO_LIGHT} alt="" />
            <h2>Welcome back</h2>
            <p className="login-lede">Sign in to access your {ORG.product}</p>

            <form onSubmit={onSubmit}>
              <div className="login-field">
                <span className="login-ic" aria-hidden="true"><Icon n="mail" size="lg" /> </span>
                <input
                  id="login-email"
                  className="input"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  placeholder="Email address"
                  aria-label="Email address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="login-field">
                <span className="login-ic" aria-hidden="true">🔒</span>
                <input
                  id="login-password"
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Password"
                  aria-label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="login-peek"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>

              {error && <div className="login-msg err" role="alert">{error}</div>}
              {notice && <div className="login-msg ok" role="status">{notice}</div>}

              <button className="btn primary login-go" type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            {/*
              * There was a second button here that emailed a sign-in link.
              *
              * It called `signInWithOtp` without `shouldCreateUser: false`, so
              * Supabase's default applied and *any* address typed into it got
              * an auth user and an email — including one belonging to nobody
              * who works here. The application still refused them (no
              * membership means no tenant, and the session resolver throws),
              * but an unauthenticated stranger could make rows in `auth.users`
              * and send mail from this domain, which is not a door worth
              * leaving open for a convenience.
              *
              * Password reset stays. It does not create users: an address with
              * no account simply gets nothing, and the message below says the
              * same thing either way so it cannot be used to find out who
              * works here.
              */}
            <div className="login-alts">
              <button
                type="button"
                className="login-forgot"
                disabled={busy || !email.trim()}
                onClick={() => void run(
                  () => auth.sendPasswordReset(email.trim()),
                  // Deliberately the same sentence whether or not the address
                  // has an account. Anything else turns this into a way to
                  // find out who works here.
                  'If that address has an account, a reset link is on its way.',
                )}
              >
                Forgot your password?
              </button>
            </div>

            {ssoProviders.length > 0 && (
              <>
                <div className="login-or"><span>Or continue with</span></div>
                <div className="login-ssos">
                  {ssoProviders.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="btn login-sso"
                      disabled={busy}
                      onClick={() => void run(() => auth.signInWithSso(p))}
                    >
                      <span className="login-mark">{PROVIDER_MARK[p]}</span>
                      {providerLabel(p)}
                    </button>
                  ))}
                </div>
              </>
            )}

            <p className="login-foot">
              New to {ORG.product}? Your HR administrator creates the account —
              ask them rather than signing up.
            </p>
          </div>
        </section>
      </div>

      <footer className="login-legal">
        <span>© {new Date().getFullYear()} {ORG.legal}</span>
        <span className="login-legal-sep">·</span>
        <span>{ORG.addr.split(',').slice(-2).join(',').trim()}</span>
      </footer>
    </div>
  );
}
