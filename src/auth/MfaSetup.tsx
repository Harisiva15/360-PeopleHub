/**
 * Turning a second factor on, off, and — the part that matters — keeping a
 * spare.
 *
 * Lives under My Account, because it is the account holder's own control. An
 * administrator cannot enrol on somebody's behalf; the secret would pass
 * through them.
 *
 * **Nor can an administrator undo it, and that shapes this whole screen.**
 * Removing somebody else's factor is `supabase.auth.admin.mfa.deleteFactor`,
 * which needs the service key. This codebase holds none anywhere by design —
 * server/.env.example forbids it, because that key bypasses every row-level
 * policy in the schema. So a lost authenticator is not a support ticket; it is
 * a lockout that ends with somebody opening the Supabase dashboard.
 *
 * **Which is why recovery codes are not here.** They were the obvious next
 * thing to build and they would not have worked: a recovery code cannot raise
 * a session to aal2 and cannot delete a factor, and both of those are
 * Supabase's to do. A table of hashed codes that could not complete a recovery
 * would be a stored fact nothing acts on — the same shape as
 * `must_change_password` sitting unenforced for months, and this codebase has
 * turned up enough of those.
 *
 * What does work, entirely within what we control, is **more than one
 * authenticator**. Two devices, or one device and a password manager, and
 * losing either costs nothing. That is the recovery story, and this screen
 * pushes it hardest at the moment somebody has exactly one.
 *
 * **The order matters.** `enrol` creates an unverified factor; only a code
 * from it makes that factor count. Doing it the other way round — trusting the
 * enrolment and asking for proof afterwards — locks somebody out of their own
 * account the moment they mistype the setup or scan the wrong square.
 *
 * **The secret is shown once, beside the QR code, and never fetched again.**
 * Somebody on a desktop with the authenticator on their phone can scan it;
 * somebody entering it by hand needs the characters. After enrolment there is
 * nothing to re-display, which is why the screen says so rather than offering
 * a "show secret" control that would have to store it.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  MfaError, codeComplete, confirmEnrolment, enrol, listFactors, mfaAvailable,
  normaliseCode, unenrol,
} from './mfa';
import type { Factor, TotpEnrolment } from './mfa';
import { useAuth } from './AuthContext';

const msg = (e: unknown, fallback: string) =>
  (e instanceof MfaError || e instanceof Error ? e.message : fallback);

/** Suggested names, so a list of two is readable rather than two identical rows. */
const SUGGESTED = ['Phone', 'Backup', 'Second device'];

export function MfaSetup() {
  const { refreshMfa } = useAuth();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [pending, setPending] = useState<TotpEnrolment | null>(null);
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFactors(await listFactors());
    } catch (e) {
      setError(msg(e, 'Could not read your security settings.'));
      setFactors([]);
    }
  }, []);

  useEffect(() => { if (mfaAvailable()) void load(); else setFactors([]); }, [load]);

  if (!mfaAvailable()) {
    return (
      <p className="hint">
        Two-factor sign-in needs a configured sign-in provider. This build is
        running on demonstration data and has none.
      </p>
    );
  }

  if (factors === null) {
    return <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>;
  }

  const verified = factors.filter((f) => f.verified);
  /* Enrolments somebody walked away from, cleared rather than left to block a
     fresh one for a reason nobody can see. */
  const stale = factors.filter((f) => !f.verified);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const f of stale) await unenrol(f.id);
      const name = label.trim()
        || SUGGESTED[verified.length]
        || `Authenticator ${verified.length + 1}`;
      setPending(await enrol(name));
    } catch (e) {
      setError(msg(e, 'Could not start setup.'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending || !codeComplete(code) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmEnrolment(pending.factorId, normaliseCode(code));
      setPending(null);
      setCode('');
      setLabel('');
      await load();
      // The session is now at aal2. Telling the rest of the app avoids the
      // gate asking for a code somebody has just this second provided.
      await refreshMfa();
    } catch (err) {
      setError(msg(err, 'That code was not accepted.'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: Factor) => {
    /*
     * The consequence differs entirely depending on whether this is the last
     * one, so the question does too. "Are you sure?" on both would be the same
     * dialog for turning off a security control and for tidying up a spare.
     */
    const ask = verified.length === 1
      ? 'This is your only authenticator. Removing it turns two-factor sign-in '
        + 'off, and your account will be protected by its password alone. Continue?'
      : `Remove "${f.friendlyName}"? You will still have ${verified.length - 1} other.`;
    if (!window.confirm(ask)) return;
    setBusy(true);
    setError(null);
    try {
      await unenrol(f.id);
      await load();
      await refreshMfa();
    } catch (e) {
      setError(msg(e, 'Could not remove it.'));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- mid-enrolment ---------------- */

  if (pending) {
    return (
      <form className="stack" onSubmit={confirm}>
        <p>
          Scan this with your authenticator app, then type the code it shows to
          prove it worked.
        </p>
        <div className="mfa-qr">
          {/* Supabase returns an SVG, usually as a data: URI. Rendered as an
              image rather than injected as markup — it arrives over the network
              and nothing that arrives over the network becomes HTML here. */}
          <img src={pending.qrCode} alt="QR code for your authenticator app" width={180} height={180} />
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <span className="mfa-label">Or type this in by hand</span>
          <code className="mfa-secret">{pending.secret}</code>
          <span className="hint">
            Shown once. After setup there is nothing to show again — the app
            holds it from here.
          </span>
        </div>

        <label className="mfa-label" htmlFor="mfa-enrol-code">Code from the app</label>
        <input
          id="mfa-enrol-code"
          className="mfa-code"
          value={code}
          onChange={(e) => setCode(normaliseCode(e.target.value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          disabled={busy}
        />
        {error && <div className="mfa-error" role="alert">{error}</div>}
        <div className="row" style={{ gap: 8 }}>
          <button type="submit" className="btn primary" disabled={busy || !codeComplete(code)}>
            {busy ? 'Checking…' : 'Turn it on'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => { setPending(null); setCode(''); setError(null); void load(); }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  /* ---------------- the list ---------------- */

  return (
    <div className="stack">
      {verified.length === 0 ? (
        <>
          <div className="kv-row"><span>Authenticator app</span><strong>Off</strong></div>
          <p className="hint">
            A second factor means a stolen password is not enough on its own. You
            will need an authenticator app — Google Authenticator, Microsoft
            Authenticator, 1Password and others all work.
          </p>
          {/*
            * Before the button, because this is the moment somebody can still
            * decide. Nobody inside this application can undo a lockout.
            */}
          <div className="mfa-error" role="note">
            <strong>Before you turn this on:</strong> if you lose the
            authenticator, nobody inside 360&nbsp;People&nbsp;Hub can let you
            back in — the factor has to be cleared from the Supabase dashboard.
            Set it up on a device you will keep, and add a second one straight
            afterwards.
          </div>
        </>
      ) : (
        <>
          <ul className="factor-list">
            {verified.map((f) => (
              <li key={f.id}>
                <span className="factor-name">{f.friendlyName}</span>
                <button
                  type="button"
                  className="linkish factor-remove"
                  disabled={busy}
                  onClick={() => void remove(f)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {verified.length === 1 ? (
            /*
             * The single most useful thing on this screen. One authenticator is
             * one lost phone away from an account nobody in this product can
             * recover, and somebody is far likelier to add a second now — while
             * they are already here — than after they need it.
             */
            <div className="mfa-error" role="note">
              <strong>Add a second authenticator.</strong> With only one, losing
              that device locks you out permanently — the factor can only be
              cleared from the Supabase dashboard. A second app, on another
              device or in a password manager, removes that risk entirely.
            </div>
          ) : (
            <div className="mfa-good" role="status">
              {verified.length} authenticators. Losing one still leaves you a way in.
            </div>
          )}
        </>
      )}

      {error && <div className="mfa-error" role="alert">{error}</div>}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {verified.length > 0 && (
          <input
            className="input"
            style={{ maxWidth: 190 }}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={SUGGESTED[verified.length] ?? 'Name it'}
            aria-label="Name for this authenticator"
            disabled={busy}
          />
        )}
        <button
          type="button"
          className={verified.length === 0 ? 'btn primary' : 'btn'}
          disabled={busy}
          onClick={() => void start()}
        >
          {busy
            ? 'Starting…'
            : verified.length === 0
              ? 'Set up two-factor sign-in'
              : 'Add another authenticator'}
        </button>
      </div>
    </div>
  );
}
