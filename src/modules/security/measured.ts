/**
 * The security facts this application can actually observe.
 *
 * Kept separate from the screen, and named for what it is, because the failure
 * this file exists to prevent is a *plausible* number. The posture tab reported
 * MFA enrolment, managed devices, disk encryption and patch compliance as
 * percentages for months; all four came from a seeded random draw, and nothing
 * on the page distinguished them from a measurement. Somebody would have
 * quoted "94% encrypted" in a client security review.
 *
 * So the rule for anything rendered on that page: it is derived here, from a
 * table this product writes to, or it is not rendered as a figure at all.
 *
 * Sign-in method qualifies. `login_history.method` is recorded by this server
 * on every sign-in (migration 0038), so "who has used a second factor" is a
 * fact we own. Device state does not qualify and has no function here — there
 * is deliberately nothing to call.
 */

import { useMemo } from 'react';
import type { LoginEvent } from '../../services';

export interface SecondFactorReading {
  /** Accounts with at least one successful sign-in in the retained history. */
  signedIn: Set<string>;
  /** Of those, the ones that have used a second factor at least once. */
  withSecondFactor: Set<string>;
}

/**
 * Who has signed in, and who has done it with a second factor.
 *
 * **The denominator is people who have signed in, not every account.** An
 * invited account that has never been used has not declined to enrol a second
 * factor — it has done nothing at all, and counting it as a failure makes the
 * figure move when somebody is hired. The label on the tile says which
 * denominator this is, because a percentage without one is not a measurement.
 *
 * **"Has used" rather than "is enrolled".** Enrolment is a fact held by
 * Supabase Auth, which this application does not read. What it holds is what
 * happened at sign-in. Somebody who enrolled this morning and has not signed in
 * since is not counted, and the tile is worded so that is not a lie.
 *
 * Only successes count. A refused or locked-out row says the account was
 * stopped, not how its holder proves who they are.
 */
export function useSecondFactor(history: LoginEvent[]): SecondFactorReading {
  return useMemo(() => {
    const signedIn = new Set<string>();
    const withSecondFactor = new Set<string>();

    for (const e of history) {
      if (e.outcome !== 'success' || !e.employeeId) continue;
      signedIn.add(e.employeeId);
      // 'sso' is deliberately not counted: whether the identity provider
      // behind it demanded a second factor is its business, not ours, and
      // assuming either way would invent the number this file exists to avoid.
      if (e.method === 'mfa' || e.method === 'recovery_code') {
        withSecondFactor.add(e.employeeId);
      }
    }

    return { signedIn, withSecondFactor };
  }, [history]);
}
