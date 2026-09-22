/**
 * The second-factor gate, over every pair of assurance levels.
 *
 * `checks/auth-gate.tsx` proves no route renders without a session. It cannot
 * prove this one: the level is read in an effect, and effects do not run under
 * `renderToStaticMarkup`, so a server render always sees the undecided state.
 * The decision is therefore a pure function, and this is where it is held to
 * account.
 *
 * The case that matters is aal1-with-aal2-available. That is a real session,
 * with a real token, held by somebody who has not produced their code — and if
 * `blocksOn` ever returns false for it, every account with a second factor is
 * protected by its password alone, silently, with nothing on screen to show it.
 */

import { blocksOn, usedFactor, normaliseCode, codeComplete } from '../src/auth/mfa';
import type { Assurance } from '../src/auth/mfa';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const LEVELS: Assurance[] = ['none', 'aal1', 'aal2'];

console.log('\nthe second-factor gate\n');

/*
 * The whole matrix, named rather than generated, so each row states what it
 * means. `next` is what the account could reach; `current` is what this
 * session has proven.
 */
const CASES: { current: Assurance; next: Assurance; blocks: boolean; what: string }[] = [
  { current: 'aal1', next: 'aal1', blocks: false, what: 'no factor on the account — password is the whole of it' },
  { current: 'aal1', next: 'aal2', blocks: true, what: 'a factor exists and this session has not answered it' },
  { current: 'aal2', next: 'aal2', blocks: false, what: 'answered — this is the signed-in state' },
  { current: 'none', next: 'none', blocks: false, what: 'no session; the session gate handles this one' },
  { current: 'none', next: 'aal2', blocks: true, what: 'a factor exists and nothing has been proven at all' },
  { current: 'none', next: 'aal1', blocks: false, what: 'no factor to answer' },
  { current: 'aal2', next: 'aal1', blocks: false, what: 'cannot occur; must not block if it does' },
  { current: 'aal1', next: 'none', blocks: false, what: 'no factor to reach; nothing to answer' },
  { current: 'aal2', next: 'none', blocks: false, what: 'cannot occur; must not block if it does' },
];

for (const c of CASES) {
  ok(`${c.current} → ${c.next}: ${c.blocks ? 'blocks' : 'passes'} — ${c.what}`,
    blocksOn({ current: c.current, next: c.next }) === c.blocks,
    `blocksOn returned ${blocksOn({ current: c.current, next: c.next })}, expected ${c.blocks}`);
}

/* Vacuity guard: the matrix has to actually cover the space. */
ok(`all ${LEVELS.length * LEVELS.length} level pairs are covered`,
  new Set(CASES.map((c) => `${c.current}>${c.next}`)).size === LEVELS.length * LEVELS.length,
  'A pair is missing, so some state has never been decided.');

/*
 * The one that must never regress. Stated twice, deliberately: once inside the
 * matrix and once on its own, so deleting a row from the table above cannot
 * quietly remove it.
 */
ok('an unanswered factor always blocks',
  blocksOn({ current: 'aal1', next: 'aal2' }) === true,
  'A session holding a valid token without its second factor would reach the app.');

console.log('\nwhat gets recorded as the method\n');

ok('answering a factor records mfa', usedFactor({ current: 'aal2', next: 'aal2' }) === true);
ok('no factor records password', usedFactor({ current: 'aal1', next: 'aal1' }) === false);
ok('an unanswered factor records nothing yet',
  usedFactor({ current: 'aal1', next: 'aal2' }) === false,
  'It would record a sign-in that has not finished, as a password sign-in.');

/*
 * blocksOn and usedFactor must never both be true: that would be a session
 * both blocked and counted as complete, and the history would gain a row for
 * somebody still staring at the code screen.
 */
let overlap = 0;
for (const current of LEVELS) {
  for (const next of LEVELS) {
    if (blocksOn({ current, next }) && usedFactor({ current, next })) overlap += 1;
  }
}
ok('nothing is both blocked and recorded', overlap === 0, `${overlap} pair(s) are both`);

console.log('\nthe code field\n');

ok('spaces from an authenticator are stripped', normaliseCode('123 456') === '123456');
ok('letters cannot be entered', normaliseCode('12a3b4c5') === '12345');
ok('longer input is cut to six', normaliseCode('1234567890') === '123456');
ok('six digits is complete', codeComplete('123456') === true);
ok('five is not', codeComplete('12345') === false);
ok('six digits with a space is complete', codeComplete('123 456') === true);
ok('an empty field is not', codeComplete('') === false);

console.log(`\n${failed ? `${failed} FAILED` : 'the second-factor gate holds'}\n`);
process.exit(failed ? 1 : 0);
