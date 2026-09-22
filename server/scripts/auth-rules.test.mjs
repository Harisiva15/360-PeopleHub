/**
 * The refusals `callerFromToken` makes, over every combination.
 *
 * These are the checks that decide whether a valid bearer token gets to act,
 * and none of them can be reached by using the application — they are the
 * paths somebody takes deliberately, with curl and a token they should not be
 * using. So they are pure functions and this is where they are held down.
 *
 * The one that matters most is the second factor. For a while it existed only
 * in the browser: `AuthGate` refused to render at aal1 and the API happily
 * served the same token. A second factor enforced on the client is not a
 * second factor, it is a screen. If `assertSecondFactorSatisfied` ever stops
 * throwing for (aal1, hasFactor), that is the state the product returns to,
 * and nothing on any screen would look different.
 */

import { readFileSync } from 'node:fs';
import { assertSecondFactorSatisfied, REFUSED } from '../src/auth/rules.ts';

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/** Did it refuse? */
const refuses = (fn) => {
  try { fn(); return false; } catch { return true; }
};

console.log('\nthe second factor, server side\n');

const CASES = [
  { aal: 'aal2', factor: true, refuse: false, what: 'enrolled and used it' },
  { aal: 'aal1', factor: true, refuse: true, what: 'enrolled and skipped it' },
  { aal: undefined, factor: true, refuse: true, what: 'enrolled, token carries no aal at all' },
  { aal: '', factor: true, refuse: true, what: 'enrolled, aal is empty' },
  { aal: 'aal3', factor: true, refuse: true, what: 'enrolled, aal is a value we do not know' },
  { aal: 'aal1', factor: false, refuse: false, what: 'no factor — aal1 is where they live' },
  { aal: 'aal2', factor: false, refuse: false, what: 'no factor, somehow at aal2' },
  { aal: undefined, factor: false, refuse: false, what: 'no factor, no claim' },
];

for (const c of CASES) {
  const got = refuses(() => assertSecondFactorSatisfied(c.aal, c.factor));
  ok(`${c.refuse ? 'refuses' : 'allows '} — ${c.what}`, got === c.refuse,
    `aal=${JSON.stringify(c.aal)} hasFactor=${c.factor} → ${got ? 'refused' : 'allowed'}, expected ${c.refuse ? 'refused' : 'allowed'}`);
}

/* Vacuity: the table has to contain both outcomes, or it proves nothing. */
ok('the table exercises both outcomes',
  CASES.some((c) => c.refuse) && CASES.some((c) => !c.refuse));

/*
 * Stated on its own as well as in the table, so deleting a row cannot quietly
 * remove the one case the function exists for.
 */
ok('an enrolled account at aal1 is always refused',
  refuses(() => assertSecondFactorSatisfied('aal1', true)),
  'A stolen password alone would reach every endpoint on this server.');

ok('an account with no factor is never refused for aal',
  !refuses(() => assertSecondFactorSatisfied('aal1', false)),
  'Everybody who has not enrolled would be locked out.');

console.log('\nevery refusal has words somebody can act on\n');

/*
 * `auth_membership` filters to active, so a non-active account gets no row at
 * all and never reaches the application. The only thing left to get right is
 * the sentence, and the failure mode is silent: add a status to the CHECK in a
 * later migration, forget the message here, and that person is told there is
 * no membership when there plainly is one. They ask an administrator, who can
 * see the account perfectly well, and nobody can explain it.
 *
 * So the statuses are read out of the migration rather than restated. A list
 * typed in two places is a list that drifts.
 */
const sql = readFileSync(new URL('../db/migrations/0038_login_history.sql', import.meta.url), 'utf8');
const block = sql.match(/CHECK \(status IN \(([\s\S]*?)\)\)/);
const statuses = block ? [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];

ok(`read ${statuses.length} statuses out of migration 0038`, statuses.length >= 7,
  'The CHECK constraint has changed shape, so this check is now blind.');

for (const st of statuses) {
  if (st === 'active') continue;
  ok(`"${st}" has a message of its own`,
    typeof REFUSED[st] === 'string' && REFUSED[st].length > 10,
    `Somebody whose account is ${st} would be told "no active membership", which reads as a bug.`);
}

ok('active is deliberately absent from the map', REFUSED.active === undefined,
  'An active account is never refused, so a message for it would be unreachable.');

console.log(`\n${failed ? `${failed} FAILED` : 'the auth refusals hold'}\n`);
process.exit(failed ? 1 : 0);
