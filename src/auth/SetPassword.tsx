/**
 * Setting a new password, before anything else happens.
 *
 * One screen for two arrivals, because from the person's side they are the
 * same moment — "you need a new password before you can carry on":
 *
 *   a reset link, which Supabase reports as PASSWORD_RECOVERY and which hands
 *   back a real session; without this screen that session would drop somebody
 *   straight into the app and the link would have achieved nothing.
 *
 *   an administrator's reset, stored as `must_change_password` since migration
 *   0030. The user drawer has displayed "Must change password: At next
 *   sign-in" ever since, and until now the next sign-in did nothing whatever.
 *
 * **Rendered by the gate, not over it.** Nothing behind is mounted, so there is
 * no page to read underneath and no route that briefly rendered first.
 *
 * **The rules are stated before they are broken.** A checklist that turns green
 * as somebody types beats a form that accepts input and then rejects it — the
 * second one makes people guess what they did wrong, and they guess by
 * shortening the password.
 */

import { useState } from 'react';
import { useAuth } from './AuthContext';

/**
 * What a password has to clear.
 *
 * Length first, and weighted heaviest, because it is the requirement that
 * actually costs an attacker anything — a twelve-character passphrase beats
 * eight characters of punctuation, and the composition rules below exist
 * mostly because people expect to see them. NIST stopped recommending forced
 * symbol classes years ago; the compromise here is a modest set that does not
 * push people towards Password1!.
 */
export interface Rule {
  k: string;
  label: string;
  ok: (v: string) => boolean;
}

export const RULES: Rule[] = [
  { k: 'len', label: 'At least 12 characters', ok: (v) => v.length >= 12 },
  { k: 'case', label: 'Upper and lower case', ok: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { k: 'num', label: 'A number', ok: (v) => /\d/.test(v) },
];

export const passwordOk = (v: string): boolean => RULES.every((r) => r.ok(v));

export function SetPassword() {
  const { setPassword, signOut, email } = useAuth();
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = pw.length > 0 && pw === again;
  const ready = passwordOk(pw) && matches;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setPassword(pw);
      // No success screen: the gate re-renders into the application, which is
      // the clearest possible confirmation that it worked.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden="true">
        <span className="lb lb-1" />
        <span className="lb lb-2" />
        <span className="lb lb-3" />
      </div>

      <form className="login-card mfa-card" onSubmit={submit}>
        <h2>Set a new password</h2>
        <p className="login-lede">
          {email
            ? <>Choose a new password for <strong>{email}</strong>.</>
            : 'Choose a new password before continuing.'}
        </p>

        <label className="mfa-label" htmlFor="pw-new">New password</label>
        <input
          id="pw-new"
          className="input"
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete="new-password"
          autoFocus
          disabled={busy}
        />

        <ul className="pw-rules">
          {RULES.map((r) => {
            const met = r.ok(pw);
            return (
              <li key={r.k} data-met={met}>
                {/* aria-hidden on the glyph: the state is already in the text
                    through data-met and the list reads fine without it. */}
                <span aria-hidden="true">{met ? '✓' : '·'}</span>
                <span>{r.label}</span>
              </li>
            );
          })}
        </ul>

        <label className="mfa-label" htmlFor="pw-again">Type it again</label>
        <input
          id="pw-again"
          className="input"
          type="password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          autoComplete="new-password"
          disabled={busy}
        />
        {again.length > 0 && !matches && (
          <div className="pw-mismatch">The two do not match yet.</div>
        )}

        {error && <div className="mfa-error" role="alert">{error}</div>}

        <button type="submit" className="btn primary mfa-submit" disabled={busy || !ready}>
          {busy ? 'Saving…' : 'Set password and continue'}
        </button>

        {/*
          * A way out. Somebody who opened a reset link by mistake, or who is
          * not ready to choose, would otherwise be stuck on this screen with a
          * live session behind it.
          */}
        <button type="button" className="linkish mfa-out" onClick={() => { void signOut('manual'); }}>
          Sign out instead
        </button>
      </form>
    </div>
  );
}
