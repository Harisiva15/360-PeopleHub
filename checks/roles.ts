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
  MANAGER_ADDS,
  MANAGER_LAYER,
  PERMS,
  USER_ACTIONS as CLIENT_ACTIONS,
  actionScope as clientScope,
  can as clientCan,
  mayAssignRole as clientMayAssign,
  scopeOfDemo,
  visibleIds,
} from '../src/state/rbac';
import { HRHEAD } from '../src/data/employees';
import type { AppRole } from '../src/types/employee';
import {
  POLICY, ROLES, effectiveFor, effectiveModulesFor, modulesFor, ruleFor,
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
  /*
   * The union, not the layer in isolation. `modulesFor` answers what one
   * layer grants by itself, which is what the access screen lists; a person
   * navigates by what they actually reach. Comparing the menu against the
   * isolated figure reported six modules as over-offered when every one of
   * them was the employee baseline an administrator also holds.
   */
  const allowed = new Set(effectiveModulesFor(role, false));
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

  /*
   * The one rule the whole module rests on, in its stronger form.
   *
   * It used to ask whether a 'manager' could make an 'admin'. Neither value
   * exists: manager is not assignable and admin is not grantable, so after
   * the rename the question had no subject. It asks every role now, which
   * also covers the two the old form could not name - an HR or finance
   * administrator handing out company_admin is the privilege escalation
   * worth asserting against, and nothing used to.
   */
  let escalation = false;
  for (const role of ROLES) {
    if (role === 'company_admin') continue;
    /* Both layer states: having reports must not be a route to it either. */
    for (const hasReports of [false, true]) {
      const server = serverMayAssign(role, hasReports, 'company_admin');
      const client = clientMayAssign(role, hasReports, 'company_admin');
      if (server || client) {
        escalation = true;
        const who = `${role}${hasReports ? ' with reports' : ''}`;
        fail(`${who} can make a company administrator (server ${server}, client ${client})`);
      }
    }
  }
  if (!escalation) ok('no role but company_admin can make a company administrator');

  const adminMakesAdmin = serverMayAssign('company_admin', false, 'company_admin')
    && clientMayAssign('company_admin', false, 'company_admin');
  if (!adminMakesAdmin) fail('a company administrator cannot make a company administrator');
  else ok('and a company administrator can');

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

/* ------------------------------------------------------------------ *
 * The manager layer, mirrored
 * ------------------------------------------------------------------ */

console.log('\nthe manager layer says the same thing on both sides\n');

/*
 * MANAGER_ADDS is the frontend's copy of what having reports adds. It held
 * eight modules while the policy's manager layer granted thirty-five, so a
 * manager was refused the job-title catalogue, the software estate and the
 * lifecycle board - each of which the server would have served them.
 *
 * Nothing caught it, because the menu-vs-policy comparison below ran only
 * with hasReports false. The layer had no assertion of its own at all.
 */
const layer = modulesFor('manager');
const missing = layer.filter((m) => !MANAGER_ADDS.includes(m));
const extra = MANAGER_ADDS.filter((m) => !layer.includes(m));
if (missing.length) fail(`MANAGER_ADDS is missing: ${missing.join(', ')}`);
if (extra.length) fail(`MANAGER_ADDS claims what the layer does not grant: ${extra.join(', ')}`);
if (!missing.length && !extra.length) {
  ok(`MANAGER_ADDS matches the policy's manager layer, all ${layer.length} modules`);
}

/*
 * And the scopes, not just the names.
 *
 * MANAGER_LAYER was a flat list that scopeOfDemo read as 'team' everywhere.
 * The policy gives the layer 'own' on payroll and tax and nothing on
 * compensation, so the mirror was granting a manager their whole line's pay.
 */
/*
 * All three verbs, not just read.
 *
 * The mirror carried a read scope alone at first and the gates used it for
 * writes as well. jobtitles is read 'all' and write 'none', so a manager
 * could add a job title; software and events were the same shape. Checking
 * one verb is what let that through.
 */
let scopeDrift = false;
for (const m of layer) {
  const want = ruleFor('manager', m);
  const got = MANAGER_LAYER[m];
  for (const verb of ['read', 'write', 'approve'] as const) {
    if (got?.[verb] !== want[verb]) {
      scopeDrift = true;
      fail(`MANAGER_LAYER[${m}].${verb} is ${got?.[verb]}, the policy grants ${want[verb]}`);
    }
  }
}
if (!scopeDrift) ok(`and all three verbs match the policy, across ${layer.length} modules`);

/* ------------------------------------------------------------------ *
 * A manager answers for people, not for pay
 * ------------------------------------------------------------------ */

console.log('\nthe manager layer reaches a team on people, and only itself on pay\n');

/*
 * Having reports widens what somebody sees of their line. It must not widen
 * what they see of anybody's pay: a manager sees their own payslip and their
 * own tax, and the single carve-out is approving their reports' expense
 * claims, which is their job.
 */
const PEOPLE_OPS = ['leave', 'attendance', 'timesheet', 'performance', 'helpdesk', 'devplans'];
const PAY = ['payroll', 'compensation', 'tax', 'benefits', 'expenses'];
const VERBS = ['read', 'write', 'approve'] as const;

let payLeak = false;
for (const m of PAY) {
  for (const verb of VERBS) {
    const server = ruleFor('manager', m)[verb];
    /*
     * Expenses is the exception, and only for approving: a manager approves
     * what their reports claim, which needs to see them too. Writing one on
     * somebody else's behalf is still not theirs.
     */
    const allowed = m === 'expenses' && verb !== 'write' ? 'team' : 'own';
    if (RANK[server] > RANK[allowed]) {
      payLeak = true;
      fail(`the manager layer grants ${verb} ${server} on ${m}, past ${allowed}`);
    }
    /* The client mirror only carries a read scope, so that is what it answers for. */
    if (verb === 'read') {
      const client = MANAGER_LAYER[m]?.read ?? 'none';
      if (RANK[client] > RANK[allowed]) {
        payLeak = true;
        fail(`MANAGER_LAYER grants read ${client} on ${m}, past ${allowed}`);
      }
    }
  }
}
if (!payLeak) ok('no pay module reaches past the manager themselves, bar approving expenses');

let peopleShort = false;
for (const m of PEOPLE_OPS) {
  const server = ruleFor('manager', m).read;
  const client = MANAGER_LAYER[m]?.read ?? 'none';
  if (server !== 'team') {
    peopleShort = true;
    fail(`the manager layer reads ${server} on ${m}, not team`);
  }
  if (client !== 'team') {
    peopleShort = true;
    fail(`MANAGER_LAYER reads ${client} on ${m}, not team`);
  }
}
if (!peopleShort) ok(`and a team on all ${PEOPLE_OPS.length} people-ops modules`);

/* ------------------------------------------------------------------ *
 * An administrator is also an employee
 * ------------------------------------------------------------------ */

console.log('\nadmin grants add to the employee baseline, never subtract\n');

/*
 * The union is max(employee, manager-if-reports, assignedRole), so holding an
 * administrative role cannot cost somebody what every employee has: their own
 * leave, their own reviews, their own training, their own tickets, their own
 * shifts, their own development plan, a software request.
 *
 * This is not hypothetical. The menu-vs-policy check above was comparing
 * against `modulesFor`, which answers what one layer grants *in isolation*,
 * and reported six modules as over-offered for hr_admin and finance_admin.
 * They were the employee baseline, and acting on that reading would have
 * taken an HR administrator's own leave request away from them.
 */
let baselineLost = false;
for (const m of Object.keys(POLICY)) {
  const emp = effectiveFor('employee', false, m);
  for (const verb of ['read', 'write', 'approve'] as const) {
    if (emp[verb] === 'none') continue;
    for (const role of ROLES) {
      if (role === 'employee') continue;
      const got = effectiveFor(role, false, m)[verb];
      if (got === 'none') {
        baselineLost = true;
        fail(`${role} loses the employee baseline: ${verb} on ${m}` + ` (employee ${emp[verb]}, ${role} none)`);
      }
    }
  }
}
if (!baselineLost) ok('every module and verb an employee holds, every admin role holds too');

/* ------------------------------------------------------------------ *
 * A role that is not a role
 * ------------------------------------------------------------------ */

console.log('\nan unrecognised role reaches nothing\n');

/*
 * The old value, cast on purpose. `AppRole` is a compile-time promise and
 * these functions are reached from places that were never compiled against
 * it: a stored column, a token claim, a fixture in this very directory.
 *
 * Before the guard, 'admin' missed the administrator branch in visibleIds and
 * fell through to the reporting-tree branch - so an unknown role answered as
 * though it were a manager, silently, with the widest reading available short
 * of full access. That is the behaviour these three assertions exist to stop
 * coming back.
 */
const STALE = 'admin' as unknown as AppRole;
const STALE_SERVER = 'admin' as unknown as Role;

const seen = visibleIds(STALE, HRHEAD.id);
if (seen.length !== 1 || seen[0] !== HRHEAD.id) {
  fail(`an unrecognised role saw ${seen.length} people, not just itself`);
} else {
  ok('an unrecognised role sees only itself');
}

/* hasReports deliberately true: the fall-through took the team branch, so
 * passing true is what proves the guard runs before it. */
if (scopeOfDemo(STALE, true, 'employees') !== 'none') {
  fail('an unrecognised role with reports still has a scope');
} else {
  ok('and no scope on any module, reports or not');
}

if (clientCan(STALE, 'employees', true)) {
  fail('an unrecognised role may still open a module');
} else {
  ok('and may open nothing');
}

/* The server answers the same question, and must answer it the same way. */
const srv = effectiveFor(STALE_SERVER, true, 'employees');
if (srv.read !== 'none' || srv.write !== 'none' || srv.approve !== 'none') {
  fail(`the server grants an unrecognised role ${JSON.stringify(srv)}`);
} else {
  ok('and the server grants it nothing either');
}

console.log(`\n${Object.keys(POLICY).length} modules x ${ROLES.length} roles defined`);
if (failed) {
  console.error(`\n${failed} disagreement(s) between the navigation and the policy`);
  process.exit(1);
}
console.log('the navigation and the policy agree');
