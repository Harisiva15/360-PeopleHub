/**
 * Every menu item, every role: is it offered, and would the server allow it?
 *
 * The question this answers is the one from the go-live review — "no button
 * leading to a 403". A menu is a promise. If the shell offers somebody a page
 * whose module the server will not let them read, the promise is broken at the
 * worst possible moment, after the click, and the person cannot tell a
 * permission from a bug.
 *
 * ## What is compared
 *
 * Both gates, computed from the same inputs the running app uses:
 *
 *   offered  — `can(role, k, hasReports)` and, where the item or its group
 *              declares `needs`, that the caller's read scope covers it. This
 *              is `Shell.tsx:95-100` transcribed; if that filter changes, this
 *              check has to change with it, which is the point.
 *
 *   allowed  — `effectiveFor(role, hasReports, module)` from the server's own
 *              policy, read verb, against the same `needs`.
 *
 * A failure is `offered && !allowed`. The reverse — allowed and not offered —
 * is reported but does not fail: a module somebody may read and cannot reach
 * from the menu is a scope decision, not a defect, and the launch scope makes
 * several of those deliberately.
 *
 * ## Why this is not already covered
 *
 * `checks/roles.ts` holds the client's `PERMS` and `MANAGER_LAYER` to the
 * server's `POLICY`, module by module and verb by verb, so the two models
 * agree. `role-gates.ts` holds listings to carrying a scope clause. Neither
 * looks at the menu. Agreement between the models says nothing about whether
 * the items drawn from them ask for a scope their caller has — `needs` is a
 * third input, written per item by hand, forty-four times.
 *
 * ## The configured-build gate
 *
 * `can()` carries a second condition that only bites in a real deployment:
 * `!apiConfigured || LIVE_MODULES.has(k)`. In a check there is no API, so that
 * term is always true and the demo menu is what gets computed. Production is
 * the configured build, so every visible item's module must also be in
 * `LIVE_MODULES` or the live menu is quietly narrower than the launch scope
 * says. That is asserted separately, because it is the one difference between
 * what this file can see and what the user will.
 */

import {
  can, covers, scopeOfDemo, LIVE_MODULES, APP_ROLES, ROLE_LABEL,
} from '../src/state/rbac';
import type { Scope } from '../src/state/rbac';
import type { AppRole } from '../src/types/employee';
import { VISIBLE_NAV } from '../src/nav';
import { effectiveFor } from '../server/src/auth/policy';
import type { Role } from '../server/src/auth/policy';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`);
};

/* Every caller shape the model admits: four roles, with and without reports. */
const SHAPES: { role: AppRole; hasReports: boolean; label: string }[] = [];
for (const role of APP_ROLES) {
  for (const hasReports of [false, true]) {
    SHAPES.push({ role, hasReports, label: role + (hasReports ? '+reports' : '') });
  }
}

interface Entry {
  group: string;
  groupKey: string;
  groupNeeds?: Scope;
  name: string;
  module: string;
  needs?: Scope;
  to?: string;
}

const ENTRIES: Entry[] = [];
for (const g of VISIBLE_NAV) {
  for (const i of g.items) {
    ENTRIES.push({
      group: g.group,
      groupKey: g.k,
      groupNeeds: g.needs as Scope | undefined,
      name: i.n,
      module: i.k,
      needs: i.needs as Scope | undefined,
      to: i.to,
    });
  }
}

/** Shell.tsx's filter, transcribed: the group's gate and then the item's. */
const offered = (e: Entry, s: { role: AppRole; hasReports: boolean }): boolean => {
  const reaches = (k: string, needed: Scope) =>
    covers(scopeOfDemo(s.role, s.hasReports, k, 'read'), needed);
  if (!can(s.role, e.groupKey, s.hasReports)) return false;
  if (e.groupNeeds && !reaches(e.groupKey, e.groupNeeds)) return false;
  if (!can(s.role, e.module, s.hasReports)) return false;
  if (e.needs && !reaches(e.module, e.needs)) return false;
  return true;
};

/** The server's answer for the same item and the same caller. */
const allowed = (e: Entry, s: { role: AppRole; hasReports: boolean }): boolean => {
  const read = (k: string) => effectiveFor(s.role as Role, s.hasReports, k).read;
  if (read(e.groupKey) === 'none' && read(e.module) === 'none') return false;
  if (e.groupNeeds && !covers(read(e.groupKey), e.groupNeeds)) return false;
  if (read(e.module) === 'none') return false;
  if (e.needs && !covers(read(e.module), e.needs)) return false;
  return true;
};

/* ===========================================================================
 * 1. The matrix
 * ======================================================================== */

console.log(`${NL}  ${ENTRIES.length} visible items x ${SHAPES.length} caller shapes`
  + ` = ${ENTRIES.length * SHAPES.length} cells${NL}`);

const wouldFourOhThree: string[] = [];
const allowedNotOffered: string[] = [];

for (const s of SHAPES) {
  let shown = 0;
  for (const e of ENTRIES) {
    const o = offered(e, s);
    const a = allowed(e, s);
    if (o) shown += 1;
    if (o && !a) wouldFourOhThree.push(`${s.label} :: ${e.group} > ${e.name} (${e.module}`
      + `${e.needs ? ' needs ' + e.needs : ''})`);
    if (!o && a) allowedNotOffered.push(`${s.label} :: ${e.group} > ${e.name}`);
  }
  console.log(`    ${s.label.padEnd(24)} sees ${String(shown).padStart(2)} of ${ENTRIES.length}`);
}

console.log('');
ok(`no item is offered to a caller the server would refuse (${wouldFourOhThree.length} found)`,
  wouldFourOhThree.length === 0, NL + wouldFourOhThree.map((l) => '          ' + l).join(NL));

/* ===========================================================================
 * 2. Nothing in the menu is unreachable by everybody
 * ======================================================================== */

const deadItems = ENTRIES.filter((e) => !SHAPES.some((s) => offered(e, s)));
ok(`every visible item is reachable by at least one role (${deadItems.length} dead)`,
  deadItems.length === 0, deadItems.map((e) => `${e.group} > ${e.name}`).join(', '));

/* ===========================================================================
 * 3. An employee with no reports sees only self-service
 * ======================================================================== */

const plain = { role: 'employee' as AppRole, hasReports: false };
const plainSees = ENTRIES.filter((e) => offered(e, plain));
const plainTeamItems = plainSees.filter((e) => e.needs === 'team' || e.needs === 'all'
  || e.groupNeeds === 'team' || e.groupNeeds === 'all');
ok('an employee with no reports is offered nothing that needs team or all',
  plainTeamItems.length === 0, plainTeamItems.map((e) => e.name).join(', '));

ok('...and is offered no Administration or Company Setup item',
  !plainSees.some((e) => e.group === 'Administration' || e.group === 'Company Setup'),
  plainSees.filter((e) => e.group === 'Administration' || e.group === 'Company Setup')
    .map((e) => e.name).join(', '));

/* ===========================================================================
 * 4. Having reports adds, and only adds
 * ======================================================================== */

for (const role of APP_ROLES) {
  const without = ENTRIES.filter((e) => offered(e, { role, hasReports: false })).map((e) => e.name);
  const with_ = ENTRIES.filter((e) => offered(e, { role, hasReports: true })).map((e) => e.name);
  const lost = without.filter((n) => !with_.includes(n));
  ok(`${ROLE_LABEL[role].padEnd(22)} gains ${with_.length - without.length} item(s) from reports and loses none`,
    lost.length === 0, lost.join(', '));
}

/* ===========================================================================
 * 5. The configured build draws the same menu as the demo
 * ======================================================================== */

/*
 * `can()` ignores LIVE_MODULES when there is no API, which is every check and
 * no deployment. An item whose module is missing from that set is in the
 * launch scope, passes every assertion above, and is still absent from the
 * live menu — which is how a module ends up built, permitted and unreachable.
 */
const notLive = [...new Set(ENTRIES.filter((e) => !LIVE_MODULES.has(e.module))
  .map((e) => `${e.name} (${e.module})`))];
ok(`every visible item's module is in LIVE_MODULES (${notLive.length} missing)`,
  notLive.length === 0, notLive.join(', '));

const groupsNotLive = [...new Set(VISIBLE_NAV.filter((g) => !LIVE_MODULES.has(g.k))
  .map((g) => `${g.group} (${g.k})`))];
ok(`...and every visible group's own module too (${groupsNotLive.length} missing)`,
  groupsNotLive.length === 0, groupsNotLive.join(', '));

/* ===========================================================================
 * 6. The detector works
 * ======================================================================== */

/*
 * A fabricated item that needs more than any employee has. If the comparison
 * above were inert — a typo in a scope name, `offered` returning false for
 * everything — this would pass unnoticed, and so would a real mismatch.
 */
const trap: Entry = {
  group: 'Trap', groupKey: 'leave', name: 'Everybody\'s leave',
  module: 'leave', needs: 'all',
};
ok('the detector catches a fabricated item that needs more than the role has',
  offered(trap, plain) === false && allowed(trap, plain) === false);

const trapOffered: Entry = { ...trap, needs: undefined };
ok('  and agrees on one the role does have',
  offered(trapOffered, plain) === true && allowed(trapOffered, plain) === true);

/* ===========================================================================
 * Reported, not failed
 * ======================================================================== */

if (allowedNotOffered.length) {
  const byShape = new Map<string, number>();
  for (const l of allowedNotOffered) {
    const k = l.split(' :: ')[0]!;
    byShape.set(k, (byShape.get(k) ?? 0) + 1);
  }
  console.log(`${NL}  permitted but not in the menu, by caller — the launch scope's`
    + ` own doing, listed so it stays deliberate:`);
  for (const [k, n] of byShape) console.log(`    ${k.padEnd(24)} ${n}`);
}

console.log('');
if (failed) {
  console.log(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('permissions matrix: every offered item is one the server would allow');
