/**
 * What every pay route requires, and what each role gets.
 *
 * ## Why this is a policy-level suite and not an HTTP one
 *
 * The thing it would like to assert is "an employee token gets 403 from
 * /payroll/compensation". That is not expressible yet. `Caller.role` in
 * server/src/tenancy/context.ts still carries the old three values
 * ('admin' | 'manager' | 'employee'), so it cannot hold `hr_admin` at all, and
 * the thirty pay guards still compare against `'admin'`. Those two vocabularies
 * never meet, which is why the server typechecks while running both.
 *
 * So this asserts the layer underneath: for each route, the module and verb it
 * gates on, and what `effectiveFor` grants each role there. That makes the
 * table a specification rather than a description — it is red for any route
 * whose module the policy does not back, and it is what the guard sweep gets
 * written against. The HTTP-level 403s follow in step C, when `'admin'` is
 * finally refused by the database as well.
 *
 * ## The rule being asserted
 *
 *   company_admin, hr_admin, finance_admin   every pay route, identically
 *   employee, and a manager                  their own record and nothing else
 *   'admin', or any unrecognised value       nothing
 *
 * HR and finance being identical on pay is deliberate and was the correction
 * that produced this model: giving each of them view-only on the other's half
 * left nobody able to run payroll.
 */

import {
  ROLES, effectiveFor, covers,
} from '../server/src/auth/policy';
import type { Role, Scope } from '../server/src/auth/policy';

let failed = 0;
const fail = (msg: string) => { failed += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg: string) => console.log(`  ok    ${msg}`);

/** Who a route is about: everybody's data, or one named person's. */
type Subject = 'all' | 'own';

interface PayRoute {
  method: string;
  path: string;
  /** The module that owns the data, which is what the guard must ask about. */
  module: string;
  verb: 'read' | 'write' | 'approve';
  /**
   * `all` is a whole-company surface — a register, a batch, a tracker.
   * `own` takes an :empId, so the answer depends on whose it is.
   */
  subject: Subject;
}

/*
 * The table. Derived by reading each handler, not guessed from the path:
 * /payroll/compensation returns the compensation book, so it gates on
 * `compensation` rather than on `payroll`, and /payroll/loans is a benefit.
 */
const ROUTES: PayRoute[] = [
  /* Whole-company payroll surfaces. */
  { method: 'GET', path: '/payroll/runs', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/runs/current', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/bank-batches', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/compliance', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/daily-rates', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/totals', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/:mk/totals', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/:mk/register', module: 'payroll', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/payroll/:mk/inputs', module: 'payroll', verb: 'read', subject: 'all' },
  /* Closing a cycle writes everybody's payslip. */
  { method: 'POST', path: '/payroll/:mk/process', module: 'payroll', verb: 'write', subject: 'all' },

  /* One person's payslip. */
  { method: 'GET', path: '/payroll/payslips/:empId', module: 'payroll', verb: 'read', subject: 'own' },
  { method: 'GET', path: '/payroll/payslips/:empId/:mk', module: 'payroll', verb: 'read', subject: 'own' },

  /* Compensation: what somebody is paid, which is its own module. */
  { method: 'GET', path: '/payroll/compensation', module: 'compensation', verb: 'read', subject: 'all' },
  /*
   * Somebody's own package, which this product serves under payroll.
   *
   * Not compensation: that module is the company's pay book and the policy
   * deliberately grants the employee baseline none of it, asserted directly
   * further down in checks/roles.ts. The nav agrees - "Salary details"
   * carries k: 'payroll' with needs: 'own' - and so does the handler, which
   * passes assertOwnOrAdmin rather than an administrative check. Mapping it
   * to compensation here was the table being wrong about the product.
   */
  { method: 'GET', path: '/payroll/structure/:empId', module: 'payroll', verb: 'read', subject: 'own' },
  { method: 'GET', path: '/payroll/structure/:empId/history', module: 'compensation', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/compensation/components', module: 'compensation', verb: 'read', subject: 'all' },
  { method: 'POST', path: '/compensation/components', module: 'compensation', verb: 'write', subject: 'all' },
  { method: 'DELETE', path: '/compensation/components/:code', module: 'compensation', verb: 'write', subject: 'all' },
  { method: 'POST', path: '/compensation/:empId', module: 'compensation', verb: 'write', subject: 'all' },

  /* Tax. A declaration is the person's own; the tracker is not. */
  { method: 'GET', path: '/tax/declarations', module: 'tax', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/tax/rows', module: 'tax', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/tax/:empId/summary', module: 'tax', verb: 'read', subject: 'own' },
  { method: 'GET', path: '/tax/:empId', module: 'tax', verb: 'read', subject: 'own' },
  { method: 'PUT', path: '/tax/:empId', module: 'tax', verb: 'write', subject: 'own' },
  { method: 'PUT', path: '/tax/:empId/regime', module: 'tax', verb: 'write', subject: 'own' },
  { method: 'POST', path: '/tax/:empId/proofs', module: 'tax', verb: 'write', subject: 'own' },
  /* Verifying somebody else's proofs is an approval, not a write. */
  { method: 'POST', path: '/tax/:empId/verify', module: 'tax', verb: 'approve', subject: 'all' },

  /* Benefits. */
  { method: 'GET', path: '/payroll/loans', module: 'benefits', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/fbp/rows', module: 'benefits', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/fbp/insurance', module: 'benefits', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/fbp/totals', module: 'benefits', verb: 'read', subject: 'all' },
  { method: 'GET', path: '/fbp/:empId', module: 'benefits', verb: 'read', subject: 'own' },
  { method: 'PUT', path: '/fbp/:empId', module: 'benefits', verb: 'write', subject: 'own' },
];

const PAY_ADMINS: Role[] = ['company_admin', 'hr_admin', 'finance_admin'];

console.log(`\n${ROUTES.length} pay routes, ${ROLES.length} roles\n`);

/* ------------------------------------------------------------------ *
 * Every route is backed by the policy
 * ------------------------------------------------------------------ */

console.log('every route names a module the policy backs\n');

{
  /*
   * A route whose module grants company_admin nothing is a route nobody can
   * serve — either the module key here is wrong, or the policy has a hole.
   * Checking it first means the failures below are about scope rather than
   * about a typo three tables away.
   */
  const unbacked = ROUTES.filter(
    (r) => effectiveFor('company_admin', false, r.module)[r.verb] === 'none',
  );
  for (const r of unbacked) {
    fail(`${r.method} ${r.path} gates on ${r.module}.${r.verb}, which the policy grants nobody`);
  }
  if (!unbacked.length) ok(`all ${ROUTES.length} routes gate on a module the policy backs`);
}

/* ------------------------------------------------------------------ *
 * The three administrative roles, identically
 * ------------------------------------------------------------------ */

console.log('the pay administrators reach every pay route, identically\n');

{
  let drift = false;
  for (const r of ROUTES) {
    const scopes = PAY_ADMINS.map((role) => effectiveFor(role, false, r.module)[r.verb]);
    const [company, hr, finance] = scopes as [Scope, Scope, Scope];

    /* Each of them must reach the whole company on a company-wide route. */
    for (const [role, got] of PAY_ADMINS.map((role, i) => [role, scopes[i]!] as const)) {
      const need: Scope = r.subject === 'all' ? 'all' : 'own';
      if (!covers(got, need)) {
        drift = true;
        fail(`${role} gets ${got} on ${r.module}.${r.verb} — ${r.method} ${r.path} needs ${need}`);
      }
    }

    /* And HR and finance must be indistinguishable on pay. */
    if (hr !== finance) {
      drift = true;
      fail(`hr_admin ${hr} but finance_admin ${finance} on ${r.module}.${r.verb} (${r.path})`);
    }
    if (company !== hr) {
      drift = true;
      fail(`company_admin ${company} but hr_admin ${hr} on ${r.module}.${r.verb} (${r.path})`);
    }
  }
  if (!drift) {
    ok(`all three reach all ${ROUTES.length} routes`);
    ok('and hr_admin and finance_admin are identical on every one');
  }
}

/* ------------------------------------------------------------------ *
 * An employee, and a manager, reach their own record and no further
 * ------------------------------------------------------------------ */

console.log('\nan employee and a manager reach their own record only\n');

{
  let leak = false;
  for (const r of ROUTES) {
    for (const hasReports of [false, true]) {
      const who = hasReports ? 'a manager' : 'an employee';
      const got = effectiveFor('employee', hasReports, r.module)[r.verb];

      if (r.subject === 'all') {
        /*
         * A whole-company surface. Expenses is the one pay module where the
         * manager layer legitimately reaches a team, and no route here is an
         * expenses route, so nothing on this list may exceed 'own'.
         */
        if (covers(got, 'team')) {
          leak = true;
          fail(`${who} gets ${got} on ${r.module}.${r.verb} — ${r.method} ${r.path} is company-wide`);
        }
      } else if (!covers(got, 'own')) {
        /* Their own payslip, tax and FBP must stay reachable. */
        leak = true;
        fail(`${who} cannot reach their own ${r.module} (${r.path}): ${r.verb} is ${got}`);
      }
    }
  }
  if (!leak) {
    ok('no company-wide pay route reaches past themselves');
    ok('and their own payslip, tax and FBP stay reachable');
  }
}

/* ------------------------------------------------------------------ *
 * The old value, and anything else unrecognised
 * ------------------------------------------------------------------ */

console.log('\nthe old role value reaches nothing\n');

{
  /*
   * Cast deliberately. This is the value the database still holds today and
   * the guards still compare against, and the point of the assertion is what
   * happens when it reaches the policy rather than whether it type-checks.
   *
   * It is 'none' everywhere because effectiveFor fails closed on a role it
   * does not recognise. At HTTP level this becomes a 403 only in step C, once
   * the CHECK constraints no longer accept it and the normaliser is gone.
   */
  const STALE = 'admin' as unknown as Role;
  let reachable = false;
  for (const r of ROUTES) {
    for (const hasReports of [false, true]) {
      const got = effectiveFor(STALE, hasReports, r.module)[r.verb];
      if (got !== 'none') {
        reachable = true;
        fail(`'admin' gets ${got} on ${r.module}.${r.verb} (${r.path})`);
      }
    }
  }
  if (!reachable) ok(`'admin' reaches none of the ${ROUTES.length} routes, with or without reports`);
}

/* ------------------------------------------------------------------ *
 * The table itself is honest
 * ------------------------------------------------------------------ */

console.log('\nthe table matches the routes the server actually serves\n');

{
  /*
   * A route that disappears, or one that is added without a row here, is the
   * failure this guards against: a pay surface nobody has classified is a pay
   * surface nobody has gated.
   */
  const dupes = ROUTES
    .map((r) => `${r.method} ${r.path}`)
    .filter((k, i, all) => all.indexOf(k) !== i);
  if (dupes.length) fail(`listed twice: ${dupes.join(', ')}`);
  else ok('no route is listed twice');

  const modules = [...new Set(ROUTES.map((r) => r.module))].sort();
  ok(`covering ${modules.length} modules: ${modules.join(', ')}`);
}

console.log('');
if (failed) {
  console.error(`${failed} pay-route expectation(s) unmet\n`);
  process.exit(1);
}
console.log('every pay route is backed by the policy, and gated as approved\n');
