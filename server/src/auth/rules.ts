/**
 * The refusals, as functions over values.
 *
 * Separated from session.ts because that module opens a database pool the
 * moment it is imported, and a decision about two strings should not need one.
 * The practical consequence is that these can be checked — scripts/auth-rules
 * imports this file and nothing else, with no DATABASE_URL in the environment.
 *
 * That is not a tidying convenience. The rule below is the only thing standing
 * between a stolen password and this API, and a rule that cannot be tested
 * without a database is a rule that does not get tested.
 */

export class AuthRuleError extends Error {}

/**
 * A token from an account with a second factor must say the factor was used.
 *
 * **This is the whole of the second factor, as far as the API is concerned.**
 * The browser has a gate that refuses to render at aal1, and that gate is a
 * courtesy: the token behind it is a valid bearer token, and before this check
 * every endpoint on this server accepted it. Somebody with a stolen password
 * could reach aal1, never open the code screen, and read the directory with
 * curl. A second factor enforced on the client is a screen, not a factor.
 *
 * Both inputs are needed and neither decides alone:
 *
 *   `aal` alone cannot. An account with no factor enrolled sits at aal1
 *   permanently and is entitled to; refusing on aal1 would lock out everybody
 *   who has not enrolled, which is most people.
 *
 *   `hasVerifiedFactor` alone cannot. It says a factor exists, not that this
 *   session went through it.
 *
 * Fails closed on an absent or unrecognised claim. A token with no `aal`, or
 * one carrying a value this code does not know, is either from a Supabase
 * version that does not issue one or is not what we think it is — and for an
 * account that has enrolled a factor, neither is a reason to let it past.
 */
export function assertSecondFactorSatisfied(
  aal: string | undefined,
  hasVerifiedFactor: boolean,
): void {
  if (!hasVerifiedFactor) return;
  if (aal === 'aal2') return;
  throw new AuthRuleError('this account requires a second factor for this session');
}

/**
 * Why somebody with a valid token was refused.
 *
 * `auth_membership` filters to active memberships, so deactivating an account
 * takes effect on the very next request — the gate is the SQL, and it fails
 * closed whatever the application forgets. What it cost was the message: every
 * non-active status produced "no active membership for this user", so somebody
 * suspended and somebody awaiting approval both saw a sentence that reads like
 * a fault in the software, and each needs a different action from the person
 * reading it.
 *
 * Every status in the CHECK constraint on tenant_membership needs an entry
 * here. scripts/auth-rules reads that constraint out of the migration and
 * fails if one is missing, because the symptom otherwise is silent: a person
 * told their account does not exist when it plainly does.
 */
export const REFUSED: Record<string, string> = {
  pending_approval: 'this account is waiting for an administrator to approve it',
  invited: 'this invitation has not been accepted yet',
  inactive: 'this account has been deactivated',
  suspended: 'this account is suspended',
  locked: 'this account is locked after too many failed sign-in attempts',
  deleted: 'this account has been removed',
};
