/**
 * What counts as an acceptable password, and what the gate does about it.
 *
 * The rule set is small on purpose and the reasoning is in SetPassword.tsx:
 * length is the requirement that costs an attacker anything, and a long list
 * of symbol classes pushes people towards Password1! rather than a passphrase.
 * What this file guards is that the rules stay *rules* — that each one can
 * actually fail, and that a password meeting all of them passes.
 *
 * The case worth naming: a rule whose predicate always returns true is
 * invisible. The screen still draws the tick, somebody still reads it as a
 * requirement, and nothing is enforced. Every rule here is therefore checked
 * against a value that must fail it.
 */

import { RULES, passwordOk } from '../src/auth/SetPassword';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

console.log('\npassword rules\n');

ok(`${RULES.length} rules are defined`, RULES.length >= 3,
  'Fewer rules than expected — has the set been emptied?');

/* Every rule must be able to fail, and must be able to pass. */
const ALWAYS_FAIL = '';
const GOOD = 'Correct-Horse-7-Battery';

for (const r of RULES) {
  ok(`"${r.label}" rejects an empty password`, r.ok(ALWAYS_FAIL) === false,
    'This rule cannot fail, so it is decoration rather than a requirement.');
  ok(`"${r.label}" accepts a good password`, r.ok(GOOD) === true,
    `${GOOD} should satisfy this rule.`);
}

console.log('\nthe combined verdict\n');

/*
 * One counterexample per rule, so removing any single rule from the set makes
 * a case below start passing and this check fail.
 */
const REJECTED: { pw: string; why: string }[] = [
  { pw: '', why: 'empty' },
  { pw: 'short1A', why: 'too short' },
  { pw: 'Password1', why: 'nine characters is still too short' },
  { pw: 'alllowercase1234', why: 'no upper case' },
  { pw: 'ALLUPPERCASE1234', why: 'no lower case' },
  { pw: 'NoDigitsInHereAtAll', why: 'no number' },
];

for (const c of REJECTED) {
  ok(`rejected: ${c.why}`, passwordOk(c.pw) === false,
    `"${c.pw}" was accepted and should not have been.`);
}

const ACCEPTED = [
  'Correct-Horse-7-Battery',
  'Thirteen13Chars',
  'aB3aB3aB3aB3',
];

for (const pw of ACCEPTED) {
  ok(`accepted: ${pw.length} characters, mixed case, a digit`, passwordOk(pw) === true,
    `"${pw}" meets every stated rule and was rejected.`);
}

/*
 * The boundary. Twelve is the stated minimum, so eleven must fail and twelve
 * must pass — an off-by-one here is the kind of thing nobody notices because
 * both sides look reasonable.
 */
ok('eleven characters is rejected', passwordOk('aB3aB3aB3aB') === false);
ok('twelve characters is accepted', passwordOk('aB3aB3aB3aB3') === true);

console.log(`\n${failed ? `${failed} FAILED` : 'the password rules hold'}\n`);
process.exit(failed ? 1 : 0);
