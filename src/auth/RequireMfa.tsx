/**
 * Enrolment demanded before the account may be used.
 *
 * An administrator can require a second factor (migration 0040, the "OTP
 * Enabled" field on the user form). They cannot *provide* one: enrolling means
 * holding the TOTP secret, and the only party who should ever hold it is the
 * person whose account it protects. So the requirement lands here, as a screen
 * the person completes themselves.
 *
 * **After the password screen, not before.** Somebody arriving with a
 * credential an administrator set is asked to replace it first; binding a
 * second factor to an account whose password is still the temporary one gets
 * the order backwards.
 *
 * **No skip, and nothing behind it.** A requirement with a "later" button is a
 * suggestion. What there is instead is a way out — signing out — because
 * somebody who cannot install an authenticator right now needs to leave rather
 * than be trapped on a screen with a live session behind it.
 */

import { MfaSetup } from './MfaSetup';
import { useAuth } from './AuthContext';

export function RequireMfa() {
  const { signOut, email } = useAuth();

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden="true">
        <span className="lb lb-1" />
        <span className="lb lb-2" />
        <span className="lb lb-3" />
      </div>

      <form className="login-card mfa-card" onSubmit={(e) => e.preventDefault()}>
        <h2>Set up two-factor sign-in</h2>
        <p className="login-lede">
          {email
            ? <>Your organisation requires a second factor on <strong>{email}</strong>.</>
            : 'Your organisation requires a second factor on this account.'}
        </p>

        {/*
          * The same component My Account uses, rather than a second copy of
          * the enrolment flow. There is one place that handles the QR code,
          * the secret and the verification, and one place to get it wrong.
          */}
        <MfaSetup />

        <p className="mfa-hint">
          You will need an authenticator app — Google Authenticator, Microsoft
          Authenticator, 1Password and others all work. Once it is set up you
          will be asked for a six-digit code each time you sign in.
        </p>

        <button type="button" className="linkish mfa-out" onClick={() => { void signOut('manual'); }}>
          Sign out instead
        </button>
      </form>
    </div>
  );
}
