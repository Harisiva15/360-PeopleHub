/**
 * The second factor, asked for at sign-in.
 *
 * Reached only from `AuthGate`, and only while `mfaRequired` is true — a
 * session that has not satisfied its factor renders this instead of the app,
 * not on top of it. Nothing behind it is mounted, so there is no half-loaded
 * page to read underneath and no route that briefly rendered before the check
 * came back.
 *
 * **There is no resend, and no cooldown on one.** An authenticator app is sent
 * nothing — it computes the code from a secret and the clock. The brief asked
 * for both; a button that cannot do anything is worse than its absence, so
 * what stands in their place is the sentence explaining why the code changed
 * on its own and what to do when the app is gone.
 *
 * **And the way out is outside this application.** An earlier draft of this
 * screen said an administrator could clear the factor. They cannot: clearing
 * somebody else's factor needs the Supabase service key, and this codebase
 * deliberately holds none anywhere — see server/.env.example, which forbids it
 * because that key bypasses every row-level policy in the schema. Losing the
 * authenticator means the Supabase dashboard, and the copy says so rather than
 * sending somebody to an administrator who will not be able to help.
 */

import { useState } from 'react';
import { useAuth } from './AuthContext';
import { MfaError, codeComplete, normaliseCode, verifyChallenge, listFactors } from './mfa';
import type { Factor } from './mfa';
import { useEffect } from 'react';

export function MfaChallenge({ theme: _theme }: { theme: 'light' | 'dark' }) {
  const { refreshMfa, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Factor[]>([]);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void listFactors()
      .then((fs) => {
        if (!alive) return;
        // Verified only. An abandoned enrolment leaves an unverified factor
        // behind, and challenging that would fail for a reason nobody could see.
        const usable = fs.filter((f) => f.verified);
        setChoices(usable);
        setFactorId(usable[0]?.id ?? null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Could not read your security settings.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factorId || !codeComplete(code) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await verifyChallenge(factorId, normaliseCode(code));
      // Re-read from Supabase rather than assuming success moved the level.
      // The gate is only allowed to open on what the server says.
      await refreshMfa();
    } catch (err) {
      setError(err instanceof MfaError || err instanceof Error
        ? err.message
        : 'That did not work.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      {/* The same decorative frame as the sign-in page: this is the second
          half of signing in, not a different place. */}
      <div className="login-bg" aria-hidden="true">
        <span className="lb lb-1" />
        <span className="lb lb-2" />
        <span className="lb lb-3" />
      </div>

      <form className="login-card mfa-card" onSubmit={submit}>
        <h2>Enter your code</h2>
        <p className="login-lede">
          Open your authenticator app and type the six-digit code for
          360&nbsp;People&nbsp;Hub.
        </p>

        {loading ? (
          <div className="muted" style={{ fontSize: 13 }}>Checking your security settings…</div>
        ) : !factorId ? (
          <div className="mfa-error" role="alert">
            This account needs a second factor but no authenticator is set up on
            it. Whoever administers the Supabase project has to clear the factor
            from the dashboard before you can sign in.
          </div>
        ) : (
          <>
            {/*
              * Only when there is a choice to make. Each authenticator holds a
              * different secret, so a code from the spare will not verify
              * against the primary — and the error for that says "invalid
              * code", which sends somebody looking for a problem with the app
              * rather than with which app they opened.
              */}
            {choices.length > 1 && (
              <>
                <label className="mfa-label" htmlFor="mfa-factor">Which authenticator</label>
                <select
                  id="mfa-factor"
                  className="input"
                  value={factorId ?? ''}
                  onChange={(e) => { setFactorId(e.target.value); setError(null); }}
                  disabled={busy}
                >
                  {choices.map((f) => (
                    <option key={f.id} value={f.id}>{f.friendlyName}</option>
                  ))}
                </select>
              </>
            )}

            <label className="mfa-label" htmlFor="mfa-code">Six-digit code</label>
            <input
              id="mfa-code"
              className="mfa-code"
              value={code}
              onChange={(e) => setCode(normaliseCode(e.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={6}
              placeholder="000000"
              aria-describedby="mfa-hint"
              disabled={busy}
            />

            {error && <div className="mfa-error" role="alert">{error}</div>}

            <button
              type="submit"
              className="btn primary mfa-submit"
              disabled={busy || !codeComplete(code)}
            >
              {busy ? 'Checking…' : 'Verify'}
            </button>

            <p id="mfa-hint" className="mfa-hint">
              The code changes every 30 seconds — nothing is sent to you, so
              there is nothing to resend.
              {choices.length > 1
                ? ' If one of your authenticators is unavailable, pick the other above.'
                : ' If you no longer have the app, nobody inside 360 People Hub can'
                  + ' let you past this: the factor has to be cleared from the'
                  + ' Supabase dashboard by whoever administers the project.'}
            </p>
          </>
        )}

        {/*
          * A way out that is not the back button. Somebody who cannot produce a
          * code is otherwise stuck on a screen with a live session behind it.
          */}
        <button type="button" className="linkish mfa-out" onClick={() => { void signOut('manual'); }}>
          Sign out instead
        </button>
      </form>
    </div>
  );
}
