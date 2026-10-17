/**
 * Per-tenant overrides can only take access away.
 *
 * That single property is the entire safety argument for reading permissions
 * out of a table at all. If a row in `role_permission` could widen a grant,
 * then:
 *
 *   privilege escalation becomes a database write — by a bad screen, a bad
 *   migration, or anybody with direct access — instead of a code change that
 *   goes through review;
 *
 *   `checks/roles.ts` becomes decorative. It holds policy.ts to the frontend
 *   mirror cell by cell, and it would be comparing two ceilings while the real
 *   answer came from a third place nobody was checking.
 *
 * So this file does not test a few examples. It tests the property over every
 * module, every role and every scope an override could possibly carry — which
 * is small enough to enumerate completely, and the completeness is the point.
 */

import {
  POLICY, ROLES, effectiveRule, effectiveModulesFor, narrower, ruleFor,
} from '../src/auth/policy.ts';

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const SCOPES = ['none', 'own', 'team', 'all'];
const RANK = { none: 0, own: 1, team: 2, all: 3 };
const modules = Object.keys(POLICY);

console.log('\nnarrowing\n');

ok(`${modules.length} modules x ${ROLES.length} roles in the policy`,
  modules.length >= 40,
  'Far fewer modules than expected — is POLICY still the authority?');

/* narrower() itself, over the whole 4x4. */
let wrong = 0;
for (const a of SCOPES) {
  for (const b of SCOPES) {
    const got = narrower(a, b);
    if (RANK[got] !== Math.min(RANK[a], RANK[b])) wrong += 1;
  }
}
ok('narrower() returns the tighter of any two scopes', wrong === 0, `${wrong} pairs wrong`);

/*
 * The exhaustive one. For every module, every role, and every scope an
 * override row could name in each of the three fields, the effective rule must
 * never exceed what the code grants.
 */
let widened = [];
let checked = 0;
for (const module of modules) {
  for (const role of ROLES) {
    const base = ruleFor(role, module);
    for (const s of SCOPES) {
      const overrides = { [module]: { [role]: { read: s, write: s, approve: s } } };
      const eff = effectiveRule(role, module, overrides);
      checked += 1;
      for (const field of ['read', 'write', 'approve']) {
        if (RANK[eff[field]] > RANK[base[field]]) {
          widened.push(`${module}/${role}/${field}: override '${s}' produced '${eff[field]}' over base '${base[field]}'`);
        }
      }
    }
  }
}

ok(`${checked} module/role/scope combinations checked`, checked >= 500,
  'Too few combinations — the loop is not covering the space.');
ok('no override widens any grant', widened.length === 0,
  widened.slice(0, 5).join('\n        '));

/*
 * And the converse: an override that names a *wider* scope than the code must
 * be ignored entirely, not merely capped in one field. This is the row
 * somebody writes by hand meaning to grant something.
 */
const adminAll = { read: 'all', write: 'all', approve: 'all' };
let ignoredCorrectly = 0;
for (const module of modules) {
  const base = ruleFor('employee', module);
  const eff = effectiveRule('employee', module, { [module]: { employee: adminAll } });
  if (eff.read === base.read && eff.write === base.write && eff.approve === base.approve) {
    ignoredCorrectly += 1;
  }
}
ok('an override granting everything to an employee changes nothing',
  ignoredCorrectly === modules.length,
  `${modules.length - ignoredCorrectly} module(s) moved.`);

console.log('\nabsent rows\n');

/*
 * A missing row means "no narrowing", never "no access". A tenant seeded
 * before a module shipped must not lose it the day it arrives, and an empty
 * table must not lock everybody out of the product.
 */
for (const role of ROLES) {
  const withNothing = effectiveModulesFor(role, null);
  const fromCode = modules.filter((m) => POLICY[m][role].read !== 'none');
  ok(`${role}: no overrides at all gives the full ${fromCode.length} modules`,
    withNothing.length === fromCode.length,
    `got ${withNothing.length}`);
  const withEmpty = effectiveModulesFor(role, {});
  ok(`${role}: an empty override table gives the same`,
    withEmpty.length === fromCode.length,
    `got ${withEmpty.length}`);
}

console.log('\nnarrowing actually narrows\n');

/*
 * The feature has to do something, or it is a no-op dressed as a control. One
 * concrete case: a tenant that does not want managers seeing team cost.
 */
/*
 * The module is found rather than named. Naming one meant asserting what the
 * policy says about it, and the first attempt asserted managers read payroll
 * at 'team' when they read it at 'own' — a wrong premise that made the check
 * fail for a reason that had nothing to do with narrowing.
 */
const wide = modules.find((m) => POLICY[m].manager.read === 'team');
ok('the policy still has a module a manager reads across their team', Boolean(wide),
  'Nothing left to narrow from — this section can no longer prove anything.');

if (wide) {
  const before = ruleFor('manager', wide);
  const after = effectiveRule('manager', wide, { [wide]: { manager: { read: 'own' } } });
  ok(`a manager narrowed on "${wide}" drops from team to own`,
    before.read === 'team' && after.read === 'own',
    `before=${before.read} after=${after.read}`);
  ok('and write and approve are untouched',
    after.write === before.write && after.approve === before.approve,
    `write ${before.write}->${after.write}, approve ${before.approve}->${after.approve}`);

  const hidden = { [wide]: { manager: { read: 'none' } } };
  ok(`narrowing "${wide}" to none removes it from the menu`,
    !effectiveModulesFor('manager', hidden).includes(wide));
  ok('and leaves every other module alone',
    effectiveModulesFor('manager', hidden).length
      === effectiveModulesFor('manager', null).length - 1);
}

console.log(`\n${failed ? `${failed} FAILED` : 'overrides can only narrow'}\n`);
process.exit(failed ? 1 : 0);
