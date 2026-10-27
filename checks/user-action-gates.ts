/**
 * Asking the server for the user-management gates grants exactly what the
 * local table granted.
 *
 * ## Why this check exists
 *
 * `PermissionGuard` used to answer from `ACTION_SCOPE` in `src/state/rbac.ts`
 * — a copy of the policy living in the frontend, keyed on the role the client
 * holds locally — while every other gate on the same screen (whether the
 * section appears, whether the route answers, what the service does) came from
 * the server's grant in `/me/permissions`. Two sources for one question, and
 * the client copy fails closed and silently, which presents as a permissions
 * bug with no error anywhere to read.
 *
 * It now asks the server through `ACTION_GATE`. That is a change to a
 * permission guard, so the thing worth proving is that it is *not* a change to
 * anybody's access: every act, for every role, with and without reports, must
 * come out the same as before.
 *
 * ## What it would catch
 *
 * A mapping sent to the wrong verb. `user.edit -> users.read` would hand every
 * hr_admin the Edit button, because hr_admin holds `users` read all and write
 * none — a one-word mistake that widens access to account administration.
 * That cell is asserted below and fails loudly.
 */

import {
  ACTION_GATE, APP_ROLES, USER_ACTIONS, effectiveActionScope, may,
} from '../src/state/rbac';
import type { UserAction } from '../src/state/rbac';
import { effectiveRule, widerScope } from '../src/state/policyMirror';
import type { AppRole } from '../src/types/employee';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

/**
 * What the new guard computes, in the demo build's terms.
 *
 * `useMay` calls `app.scopeOf(module, verb)`, which in a build with no API is
 * `scopeOfDemo` — `effectiveRule(role, hasReports, module)[verb]` out of the
 * generated mirror. Reproduced here rather than imported from `AppContext`,
 * which needs React and a provider to answer anything.
 */
const serverDriven = (role: AppRole, hasReports: boolean, action: UserAction): boolean => {
  const gate = ACTION_GATE[action];
  if (!gate) return false;
  return effectiveRule(role, hasReports, gate.module)[gate.verb] !== 'none';
};

console.log(`${NL}every act is classified${NL}`);

ok('0. the action list and the gate map are the same size',
  USER_ACTIONS.length === Object.keys(ACTION_GATE).length,
  `${USER_ACTIONS.length} acts, ${Object.keys(ACTION_GATE).length} mapped`);

const unmapped = USER_ACTIONS.filter((a) => !ACTION_GATE[a]);
ok('1. no act is left without a module and verb', unmapped.length === 0,
  unmapped.join(', '));

const badVerb = Object.entries(ACTION_GATE)
  .filter(([, g]) => !['read', 'write', 'approve'].includes(g.verb));
ok('2. every gate names one of the three verbs', badVerb.length === 0,
  badVerb.map(([a]) => a).join(', '));

/* ===========================================================================
 * The whole matrix, unchanged
 * ======================================================================== */

console.log(`${NL}and grants exactly what the local table granted${NL}`);

let compared = 0;
const moved: string[] = [];
for (const role of APP_ROLES) {
  for (const hasReports of [false, true]) {
    for (const action of USER_ACTIONS) {
      compared += 1;
      const before = may(role, hasReports, action);
      const after = serverDriven(role, hasReports, action);
      if (before !== after) {
        moved.push(`${role}${hasReports ? '+reports' : ''} ${action}: `
          + `${before ? 'allowed' : 'refused'} -> ${after ? 'allowed' : 'refused'}`);
      }
    }
  }
}

ok(`3. all ${compared} cells agree`, moved.length === 0,
  `${NL}        ${moved.slice(0, 12).join(`${NL}        `)}`);

/* ===========================================================================
 * The cells that matter most, named so a regression reads clearly
 * ======================================================================== */

console.log(`${NL}the cells a mapping mistake would move${NL}`);

ok('4. a company administrator may edit an account',
  serverDriven('company_admin', false, 'user.edit'));
ok('5.  and still may with reports of their own',
  serverDriven('company_admin', true, 'user.edit'),
  'the manager layer must widen, never narrow — this is the live bug shape');
ok('6. an HR administrator may NOT edit an account',
  !serverDriven('hr_admin', false, 'user.edit'),
  'hr_admin holds users read all and write none; read would have widened this');
ok('7.  but may see the list',
  serverDriven('hr_admin', false, 'user.view'));
ok('8. somebody with reports may see their line',
  serverDriven('employee', true, 'user.view'));
ok('9.  and may not create an account',
  !serverDriven('employee', true, 'user.create'));
ok('10. a finance administrator reaches none of it',
  !serverDriven('finance_admin', false, 'user.view')
  && !serverDriven('finance_admin', false, 'user.edit'));
ok('11. an ordinary employee reaches none of it',
  !serverDriven('employee', false, 'user.view')
  && !serverDriven('employee', false, 'user.edit'));

/* The manager layer composes by widening on both sides. */
ok('12. the mirror widens the manager layer, as the table does',
  widerScope('all', 'none') === 'all' && widerScope('none', 'team') === 'team');

/* ===========================================================================
 * The source rule
 * ======================================================================== */

console.log(`${NL}and the guard asks the server, not the copy${NL}`);

const { readFileSync } = await import('node:fs');
const shared = readFileSync('src/modules/users/shared.tsx', 'utf8');

ok('13. useMay reads the granted scope', /app\.scopeOf\(gate\.module, gate\.verb\)/.test(shared));
ok('14.  through the gate map', /ACTION_GATE\[action\]/.test(shared));
/*
 * Asserted on the import binding, not on the text. The comment above `useMay`
 * quotes the old call on purpose — it explains what changed — and a rule that
 * forbids the words cannot tell an explanation from a regression. What must
 * not come back is the dependency.
 */
const bindings = (shared.match(/import \{([^}]*)\} from '\.\.\/\.\.\/state\/rbac';/)?.[1] ?? '')
  .split(',').map((s) => s.trim());
ok('15.  and no longer imports the local table',
  bindings.length > 0 && !bindings.includes('may'),
  `imports: ${bindings.join(', ') || 'none found'} — that copy is keyed on a `
  + 'role the client holds, and fails closed in silence');
ok('16. PermissionGuard and useMay answer the same way',
  /const mayDo = useMay\(\)/.test(shared),
  'two implementations of one question is how they diverge');

/* `effectiveActionScope` stays exported: the demo table is still the thing
   this check compares against, and deleting it would delete the comparison. */
ok('17. the local table is still there to be compared against',
  typeof effectiveActionScope === 'function');

/* ===========================================================================
 * The wiring, not just the mapping
 *
 * Everything above models what `useMay` *should* resolve to and compares two
 * models of the policy. That is not the same as checking the path the running
 * app takes, and the difference mattered: `scopeOfDemo` takes a `verb` that
 * defaults to `'read'`, and both call sites in `AppContext` omitted it — so in
 * the demo build every write and approve question was answered with the read
 * scope, and an hr_admin was offered the Edit button. The assertions above all
 * passed while that was true. An end-to-end test caught it.
 *
 * So these two assert the call itself.
 * ======================================================================== */

console.log(`${NL}and the demo fallback is asked about the right verb${NL}`);

const ctx = readFileSync('src/state/AppContext.tsx', 'utf8');

const threeArg = ctx.match(/scopeOfDemo\(role, hasReports, module\)/g) ?? [];
ok('18. no call to scopeOfDemo drops the verb', threeArg.length === 0,
  `${threeArg.length} call(s) fall back to 'read' for every verb`);

const withVerb = ctx.match(/scopeOfDemo\(role, hasReports, module, verb\)/g) ?? [];
ok('19.  and both scopeOf and reaches pass it', withVerb.length === 2,
  `${withVerb.length} of 2 call sites pass verb`);

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`the gates come from the server and nobody's access moved${NL}`);
process.exit(0);
