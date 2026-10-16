/**
 * The frontend's navigation agrees with the server's policy.
 *
 * `PERMS` in `src/state/rbac.ts` decides which modules a role can open. It is
 * a convenience — the services do the enforcing — but a convenience that
 * disagrees with the enforcement is worse than none: it either offers somebody
 * a screen that answers 403 to everything, or hides one they are entitled to
 * and nobody can find.
 *
 * Both of those were live when this check was written. Managers were offered
 * the five staffing screens and the staffing service refuses anybody but an
 * admin, so every one of them was a page of refusals. Employees were not
 * offered Shifts while the shift service happily served them their own — the
 * "My shift" tab existed and could not be reached.
 *
 * So: a role may navigate to exactly the modules the policy lets it read.
 * Nothing more, nothing less.
 */

import {
  PERMS,
  USER_ACTIONS as CLIENT_ACTIONS,
  actionScope as clientScope,
  mayAssignRole as clientMayAssign,
} from '../src/state/rbac';
import {
  POLICY, ROLES, effectiveFor, modulesFor,
  USER_ACTIONS as SERVER_ACTIONS,
  actionScope as serverScope,
  mayAssignRole as serverMayAssign,
} from '../server/src/auth/policy';
import type { Role, Scope, UserAction } from '../server/src/auth/policy';

/** Typed once here so both loops below agree about what they are iterating. */
const SERVER_SIDE_ACTIONS: UserAction[] = SERVER_ACTIONS;
const RANK: Record<Scope, number> = { none: 0, own: 1, team: 2, all: 3 };

let failed = 0;
const fail = (msg: string) => { failed += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg: string) => console.log(`  ok    ${msg}`);

console.log('\nroles\n');

/* ---- the policy is internally coherent ---- */

for (const [module, byRole] of Object.entries(POLICY)) {
  for (const role of ROLES) {
    const r = byRole[role];
    const rank = { none: 0, own: 1, team: 2, all: 3 };
    if (rank[r.write] > rank[r.read]) {
      fail(`${role} can write ${module} (${r.write}) beyond what it reads (${r.read})`);
    }
    if (rank[r.approve] > rank[r.read]) {
      fail(`${role} can approve ${module} (${r.approve}) beyond what it reads (${r.read})`);
    }
  }
}
if (!failed) ok('nobody can write or approve further than they can read');

/*
 * The lattice, which replaced a ladder.
 *
 * This used to assert `employee ≤ manager ≤ admin` on the raw columns, because
 * the three roles were a straight line. Two things broke that, and the
 * assertion is inverted rather than dropped because the property underneath it
 * — nobody outranks the ceiling — is still the one that matters.
 *
 * **There is no total order any more.** `hr_admin` and `finance_admin` are
 * deliberately incomparable: HR is wider on `compensation`, finance on
 * `payroll` and `expenses`. Demanding a line between them would reject the
 * access table as written.
 *
 * **The columns are layers, not grants.** A role's column is what it *adds* to
 * employee and, where there are reports, the manager layer. Three cells are
 * narrower than an employee's on purpose — `software` for hr_admin, `shifts`
 * for finance_admin, `expenses` for hr_admin — so comparing columns would
 * report a role taking access away from somebody for being promoted. Every
 * comparison below is therefore on `effectiveFor`, the union.
 *
 * What is left to assert is the part that is still a hierarchy: company_admin
 * is the ceiling, and no role or layer reaches past it.
 */
{
  const rank = { none: 0, own: 1, team: 2, all: 3 };
  let broken = 0;
  for (const module of Object.keys(POLICY)) {
    for (const k of ['read', 'write', 'approve'] as const) {
      /* With the manager layer on, which is the widest anybody gets. */
      const ceiling = effectiveFor('company_admin', true, module)[k];
      for (const role of ROLES) {
        const reach = effectiveFor(role, true, module)[k];
        if (rank[reach] > rank[ceiling]) {
          fail(`${module}: ${role} ${k} (${reach}) exceeds company_admin (${ceiling})`);
          broken += 1;
        }
      }
    }
  }
  if (!broken) ok('company_admin is the ceiling — no role reaches past it');
}

/*
 * And the union adds. A role must never leave somebody with less than the
 * employee floor, which is the whole meaning of "admin roles add to the
 * person's own access, never replace it".
 */
{
  const rank = { none: 0, own: 1, team: 2, all: 3 };
  let lost = 0;
  for (const [module, byLayer] of Object.entries(POLICY)) {
    for (const k of ['read', 'write', 'approve'] as const) {
      for (const role of ROLES) {
        if (rank[effectiveFor(role, false, module)[k]] < rank[byLayer.employee[k]]) {
          fail(`${module}: ${role} ${k} falls below the employee floor (${byLayer.employee[k]})`);
          lost += 1;
        }
      }
    }
  }
  if (!lost) ok('every role keeps the employee floor — the columns add, never replace');
}

/*
 * The manager layer has to be a layer: it must widen something for somebody
 * who holds no administrative role, or it is not doing anything and the
 * reporting tree has stopped mattering.
 */
{
  const rank = { none: 0, own: 1, team: 2, all: 3 };
  const widened = Object.keys(POLICY).filter((m) =>
    (['read', 'write', 'approve'] as const).some((k) =>
      rank[effectiveFor('employee', true, m)[k]]
      > rank[effectiveFor('employee', false, m)[k]]));
  if (widened.length === 0) {
    fail('having reports grants nothing anywhere — the manager layer is inert');
  } else {
    ok(`having reports widens ${widened.length} modules without any assigned role`);
  }
}

/*
 * The one addition the manager layer must never make.
 *
 * "Managers never see their team's pay" is a product decision rather than a
 * consequence of the table, so it is asserted directly: somebody with reports
 * and no administrative role reads their own payslip and no compensation at
 * all, however deep their line goes.
 */
{
  const pay = effectiveFor('employee', true, 'payroll');
  const comp = effectiveFor('employee', true, 'compensation');
  if (pay.read !== 'own' || comp.read !== 'none') {
    fail(`having reports reaches pay: payroll ${pay.read}, compensation ${comp.read}`);
  } else {
    ok('having reports never reaches anybody else\'s pay');
  }
}

/* ---- the navigation matches ---- */

for (const role of ROLES) {
  const allowed = new Set(modulesFor(role));
  const navigable = new Set(PERMS[role as Role]);

  const offered = [...navigable].filter((m) => !allowed.has(m));
  const hidden = [...allowed].filter((m) => !navigable.has(m));

  if (offered.length) {
    fail(`${role} is offered ${offered.join(', ')} — the policy grants no read, `
      + 'so every call on those screens is refused');
  }
  if (hidden.length) {
    fail(`${role} may read ${hidden.join(', ')} but cannot navigate there`);
  }
  if (!offered.length && !hidden.length) {
    ok(`${role}: ${navigable.size} modules, matching the policy exactly`);
  }
}

/* ---- every navigable module is a module ---- */
{
  const known = new Set(Object.keys(POLICY));
  const unknown = new Set<string>();
  for (const role of ROLES) {
    for (const m of PERMS[role as Role]) if (!known.has(m)) unknown.add(m);
  }
  if (unknown.size) {
    fail(`navigable but absent from the policy: ${[...unknown].sort().join(', ')}`);
  } else {
    ok('every navigable module has a policy');
  }
}

/* ---- the two action tables say the same thing ---- */

/*
 * The frontend mirrors the server's user-administration policy rather than
 * importing it, because it ships to a browser and the boundary is the point.
 * A mirror that drifts is worse than no mirror: it hides a button somebody may
 * press, or offers one the service will refuse. So the tables are compared
 * cell by cell.
 */
{
  const serverActions = new Set(SERVER_ACTIONS as readonly string[]);
  const clientActions = new Set(CLIENT_ACTIONS as readonly string[]);

  const onlyServer = [...serverActions].filter((a) => !clientActions.has(a));
  const onlyClient = [...clientActions].filter((a) => !serverActions.has(a));
  if (onlyServer.length || onlyClient.length) {
    fail(`the action lists differ — server only: [${onlyServer.join(', ')}], `
      + `client only: [${onlyClient.join(', ')}]`);
  } else {
    ok(`both sides name the same ${serverActions.size} administrative acts`);
  }

  let drift = 0;
  for (const action of SERVER_SIDE_ACTIONS) {
    for (const role of ROLES) {
      const server = serverScope(role as Role, action);
      const client = clientScope(role as Role, action);
      if (server !== client) {
        drift++;
        fail(`${action} for ${role}: server says ${server}, the screens say ${client}`);
      }
    }
  }
  if (!drift) ok('every act reaches exactly as far on both sides');

  /* The one rule the whole module rests on. */
  const managerMakesAdmin = serverMayAssign('manager', 'admin') || clientMayAssign('manager', 'admin');
  if (managerMakesAdmin) fail('a manager can make an administrator');
  else ok('only an administrator can make an administrator');

  const adminMakesAdmin = serverMayAssign('admin', 'admin') && clientMayAssign('admin', 'admin');
  if (!adminMakesAdmin) fail('an administrator cannot make an administrator');
  else ok('an administrator can');

  /* Nobody administers accounts without being able to see them. */
  for (const role of ROLES) {
    for (const action of SERVER_SIDE_ACTIONS) {
      if (action === 'user.view') continue;
      const acts = serverScope(role as Role, action);
      const sees = serverScope(role as Role, 'user.view');
      if (acts !== 'none' && RANK[sees] < RANK[acts]) {
        fail(`${role} may ${action} further (${acts}) than it may see (${sees})`);
      }
    }
  }
  ok('nobody may act on an account further than they may see one');
}

console.log(`\n${Object.keys(POLICY).length} modules x ${ROLES.length} roles defined`);
if (failed) {
  console.error(`\n${failed} disagreement(s) between the navigation and the policy`);
  process.exit(1);
}
console.log('the navigation and the policy agree');
