/**
 * The rules that keep the role model from quietly coming undone.
 *
 * Two of them for now, both approved on 2026-10-17. The role-literal sweep —
 * no raw comparison against any role value outside the policy files, in
 * TypeScript or inside SQL strings — joins them here and subsumes
 * `sql-role-sweep.mjs`.
 *
 * ## 1. A listing of person-level data carries a scope clause
 *
 * This is the rule whose absence caused the onboarding exposure.
 * `listOnboarding` ran its projection with no WHERE clause at all while its
 * gate admitted anybody with a direct report, so every joiner in the company
 * came back with their offered salary attached. Nothing failed, because nothing
 * asserted that a listing restricts its rows.
 *
 * A listing passes if it either narrows its rows to the caller's scope, or
 * refuses anybody who does not already hold `all`. `listExitedEmployees` is the
 * second kind: its query says only `e.status = 'exited'`, which is fine because
 * it returns early unless the caller reaches `employees` read all. Unscoped is
 * safe exactly when unscoped is all the caller could have asked for.
 *
 * ## 2. Only company_admin changes a role
 *
 * `setEmployeeRole` was gated on who may *read* the directory, which let
 * hr_admin and finance_admin change anybody's role — including promoting an
 * account to company_admin, and so promoting themselves by way of a second
 * login. Asserted twice over: against the policy, and against the source, so
 * the gate cannot regress to a module that merely happens to grant the same
 * three roles today.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ROLES, effectiveFor, covers, mayAssignRole,
} from '../server/src/auth/policy';
import type { Role } from '../server/src/auth/policy';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `   ${detail}`}`);
};

/* Every caller shape the model admits. */
const CALLERS: { role: Role; hasReports: boolean; label: string }[] = [];
for (const role of ROLES) {
  for (const hasReports of [false, true]) {
    CALLERS.push({ role, hasReports, label: `${role}${hasReports ? ' +reports' : ''}` });
  }
}

/* ===========================================================================
 * 1. Listings carry a scope clause
 * ======================================================================== */

const SRC = 'server/src';
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.ts')) files.push(p);
  }
}(SRC));
files.sort();

/*
 * Tables and columns that make a query person-level: it returns rows *about*
 * named individuals, so who may see which rows is a question with an answer.
 */
/*
 * `FROM`, not `JOIN`. A projection that joins `employee` to put a name next to
 * a department head is reference data about departments; what makes a listing
 * person-level is that people are what it returns. Matching JOIN too — once
 * projection constants were being expanded — pulled in every listing in the
 * codebase that shows somebody's name, and the signal drowned.
 */
const PERSON_TABLES = /\bFROM\s+(employee|onboarding_journey|exit_record|payslip|leave_request|timesheet|attendance|expense_claim|tax_declaration|salary_structure|loan|performance_goal|dev_plan|training_record)\b/i;
const PERSON_COLUMN = /\bemployee_id\b/;

/*
 * What makes something a scope decision: it asks the policy.
 *
 * Detected structurally rather than by a list of helper names. Every module
 * spells its scoping differently — `scope`, `employeeScope`, `journeyScope`,
 * `actionable`, `maySee` — and a name list would have to be updated by whoever
 * adds the next one, which is the person least likely to. A helper that
 * consults `reaches`, `scopeOf` or `visibleIds` is a scope decision whatever it
 * is called.
 */
const ASKS_POLICY = /reaches\s*\(|scopeOf\s*\(|visibleIds|covers\s*\(/;

/**
 * Everything in brackets, removed — repeatedly, until nothing changes.
 *
 * A scalar subquery in the select list is not what the listing returns, so an
 * `employee_id` inside one does not make the query person-level. One pass is
 * not enough: `(SELECT count(*)::int FROM employee_schedule es ...)` has nested
 * brackets, and stripping only the innermost left the outer subquery's columns
 * in place — which read the work-schedule catalogue as a listing of people.
 */
function stripParens(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(/\([^()]*\)/g, ' ');
    if (next === out) return out;
    out = next;
  }
}

/** An all-scope gate: unscoped rows are safe when all is all the caller has. */
const ALL_GATE = /reaches\s*\(\s*caller\s*,\s*['"][a-z]+['"]\s*,\s*['"](?:read|write|approve)['"]\s*,\s*['"]all['"]\s*\)/;

/**
 * Listings deliberately left unscoped, each with the reason.
 *
 * Short on purpose: a new entry is a decision somebody writes down, and an
 * entry that no longer matches anything is reported so it gets removed.
 */
const REVIEWED_LISTINGS = new Map<string, string>([
  /*
   * Empty, and that is the finding.
   *
   * Five entries were written here while the detector was still being
   * sharpened — surveys, celebrations, two document writes and the praise
   * wall. Every one of them stopped matching once "person-level" meant "the
   * query's outermost FROM is a person table, or its outer select list is
   * keyed to a person", because none of them is a listing of people in that
   * sense. They are a survey catalogue, a noticeboard, two writes named for
   * their subject, and a kudos wall.
   *
   * So every genuine person-level listing in the tree is scoped. A new entry
   * here should be rare and should carry its argument, as those did.
   *
   * Known limit: the outermost FROM of a `WITH x AS (...) SELECT ... FROM x`
   * query is the CTE, so a listing built that way is not seen as
   * person-level. `listCelebrations` is one, and is public by policy anyway.
   */
]);
type Listing = {
  key: string; file: string; name: string; line: number;
  scoped: boolean; allOnly: boolean; person: string;
};

const listings: Listing[] = [];

/**
 * Every helper in the tree that makes a scope decision, by name.
 *
 * Global rather than per-file, because the canonical one — `employeeScope` in
 * `tenancy/scope.ts`, which calls `scopeOf` and returns a WHERE fragment — is
 * imported everywhere it is used. A per-file set saw only the modules that
 * happened to define their own `scope()` and called `listDevPlans` unscoped
 * when it is the best-behaved of the lot.
 */
const scopeDeriving = new Set<string>();
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(NL);
  const decls: { name: string; start: number; end?: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/);
    if (m) decls.push({ name: m[1] ?? m[2], start: i });
  }
  for (let d = 0; d < decls.length; d += 1) {
    const end = d + 1 < decls.length ? decls[d + 1].start : lines.length;
    if (ASKS_POLICY.test(lines.slice(decls[d].start, end).join(NL))) {
      scopeDeriving.add(decls[d].name);
    }
  }
}

for (const file of files) {
  const rel = relative('.', file).split('\\').join('/');
  const lines = readFileSync(file, 'utf8').split(NL);

  /* Every declaration at column 0, so helpers can be looked up by name. */
  const decls: { name: string; start: number; end?: number; exported: boolean }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/);
    if (!m) continue;
    decls.push({ name: m[2] ?? m[3], start: i, exported: Boolean(m[1]) });
  }
  for (let d = 0; d < decls.length; d += 1) {
    decls[d].end = d + 1 < decls.length ? decls[d + 1].start : lines.length;
  }

  const bodyOf = new Map<string, string>();
  for (const d of decls) bodyOf.set(d.name, lines.slice(d.start, d.end).join(NL));

  /*
   * Module-level SQL constants, so `${PROJECTION}` can be read through.
   *
   * Without this the person-level test looks at `${PROJECTION} ORDER BY ...`
   * and sees no table and no employee_id, because both live in the constant.
   * `listOnboarding` — the listing this whole rule exists because of — was
   * invisible for exactly that reason, and the rule passed while the bug it was
   * written to catch sat in front of it.
   */
  const sqlConst = new Map<string, string>();
  for (const d of decls) {
    const text = lines.slice(d.start, d.end).join(NL);
    if (!/^[A-Z][A-Z0-9_]*$/.test(d.name)) continue;
    if (/\b(?:SELECT|FROM)\b/i.test(text)) sqlConst.set(d.name, text);
  }
  const expand = (text: string): string => text.replace(
    /\$\{([A-Z][A-Z0-9_]*)\}/g,
    (whole, name) => sqlConst.get(name) ?? whole,
  );

  /* Scope-deriving helpers, local or imported — see `scopeDeriving`. */
  const scopeHelpers = scopeDeriving;

  for (const d of decls) {
    if (!d.exported) continue;
    const sig = lines.slice(d.start, d.start + 8).join(' ');
    if (!/Promise<\s*\w[\w<>.' |]*\[\]/.test(sig)) continue;
    /*
     * Scope is a question about a caller. A function handed a `TenantClient`
     * and an explicit id — `openJoinerChecklist(db, journeyId, ...)` — has no
     * caller to scope to, and is judged at the call site that does.
     */
    if (!/\bcaller\s*:\s*Caller\b/.test(sig)) continue;

    const body = bodyOf.get(d.name)!;
    /* Projections resolved, so a listing cannot hide its table in a constant. */
    /*
     * The SQL, not the function.
     *
     * The paren-depth scan below has to run over a query, because the enclosing
     * JavaScript opens brackets of its own — `withTenantReadOnly(caller, async
     * (db) => {` — and a depth counter started at the top of the function never
     * comes back to zero inside the SQL. Scanning the body wholesale made every
     * listing in the tree look like no listing at all, and the check reported
     * "0 person-level listings" and passed.
     */
    const tickCh = String.fromCharCode(96);
    const sqlTexts = [...body.matchAll(new RegExp(`${tickCh}([^${tickCh}]+)${tickCh}`, 'g'))]
      .map((m) => expand(m[1]))
      .filter((q) => /\b(?:SELECT|FROM)\b/i.test(q));
    const resolved = sqlTexts.join(`${NL}-- next statement${NL}`);
    /*
     * The outermost FROM, and the outer select list.
     *
     * `listDepartments` resolves to a projection whose first FROM is
     * `department`, with `FROM employee` inside a LATERAL that counts heads.
     * A headcount is not a listing of people, so a person table reached only
     * through a subquery does not make one — and neither does an `employee_id`
     * that appears only in such a subquery.
     */
    /*
     * At paren-depth zero, because a scalar subquery can sit in the select
     * list *before* the main FROM: `SELECT d.*, (SELECT count(*) FROM employee
     * ...) AS heads FROM department d`. Taking the first FROM by position read
     * the department catalogue as a listing of people.
     */
    const personOf = (sql: string): string => {
      let depth = 0;
      let at = -1;
      for (let i = 0; i < sql.length; i += 1) {
        const ch = sql[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        else if (depth === 0 && at < 0 && /^FROM\b/i.test(sql.slice(i, i + 5))) at = i;
      }
      const selectList = at < 0 ? sql : sql.slice(0, at);
      const outer = at < 0 ? null : sql.slice(at).match(/\bFROM\s+(\w+)/i);
      if (outer && PERSON_TABLES.test(`FROM ${outer[1]}`)) return outer[1];
      /* An employee_id in the outer select list: rows keyed to a person. */
      return PERSON_COLUMN.test(stripParens(selectList)) ? 'employee_id' : '';
    };

    const person = sqlTexts.map(personOf).find(Boolean) ?? '';
    if (!person) continue;
    /* No query of its own: a composer, judged where it actually reads. */
    if (!/\.query\s*[<(]/.test(body)) continue;

    /*
     * Scoped means: it called something that asks the policy, *and* used what
     * came back. A helper whose result is assigned and then dropped is the
     * failure mode worth catching — the query still runs, unrestricted, and
     * the call site reads as though it were guarded.
     */
    /*
     * Does the query actually restrict its rows?
     *
     * Calling a policy-asking helper is not enough, and assuming it was is a
     * hole with a name: `maySeeJoinerPay` asks the policy too, so a listing
     * that gated *pay* and scoped *nothing* looked scoped. What distinguishes a
     * row restriction is that it reaches the SQL — so require the query to
     * carry an interpolation that is not just a projection constant.
     *
     * `${PROJECTION}` and friends are ALL_CAPS by convention here, which is
     * what makes them separable from `${where}` and `${scope.sql}`.
     */
    const interpolations = [...body.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    const dynamicWhere = interpolations.some((x) => !/^[A-Z][A-Z0-9_]*$/.test(x));

    /*
     * Restricting to one subject handed in as a parameter.
     *
     * `balancesFor(caller, empId)` checks `maySee(db, caller, empId)` and then
     * selects `WHERE lb.employee_id = $1`. There is no scope clause because
     * there is no range of rows — one person was asked for, and whether the
     * caller may see that person was decided before the query. A bound
     * parameter leaves no interpolation to find, which is why this needs
     * naming separately.
     */
    const subject = sig.match(/\b(empId|employeeId|subjectId)\s*:/)?.[1];
    const perSubject = Boolean(subject) && [...scopeHelpers].some(
      (h) => new RegExp(`\\b${h}\\s*\\([^)]*\\b${subject}\\b`).test(body),
    );

    /*
     * Or restricting to the caller themselves, as a bound parameter — but only
     * if *every* query in the function restricts its rows.
     *
     * `listExits` has two branches: the caller's own exit when the gate says
     * no, and `PROJECTION ORDER BY last_working_day` when it says yes. Reading
     * the self branch and calling the function scoped let the company-wide
     * branch through, which is the same mistake as trusting the first gate the
     * pay census found. A listing is scoped when there is no way through it
     * that is not.
     */
    const tick = String.fromCharCode(96);
    const queries = [...body.matchAll(new RegExp(`${tick}([^${tick}]+)${tick}`, 'g'))]
      .map((m) => m[1])
      .filter((q) => /\b(?:SELECT|FROM)\b/i.test(q) || /^\s*\$\{[A-Z][A-Z0-9_]*\}/.test(q));
    const everyQueryRestricts = queries.length > 0
      && queries.every((q) => /\bWHERE\b/i.test(q));

    const toSelf = /caller\.employeeId/.test(body) && everyQueryRestricts;

    /*
     * An all-only gate makes unscoped rows safe: `all` is all the caller could
     * have asked for.
     *
     * The distinction that matters is between `maySeeAll`, which is purely
     * `reaches(caller, 'payroll', 'read', 'all')`, and `mayOnboard`, which is
     * `reaches(..., 'all') || caller.hasReports`. Both are gates; only the
     * first justifies an unrestricted query. The second is how a manager came
     * to see every joiner in the company — so a gate that also admits anybody
     * with a report, or that mentions a narrower scope, does not count.
     */
    const isAllOnly = (text: string): boolean => ALL_GATE.test(text)
      && !/hasReports/.test(text)
      && !/['"](?:team|own)['"]/.test(text);

    /*
     * And it has to be in guard position — `if (!gate(...))` turning the
     * caller away — not merely called.
     *
     * `maySeeJoinerPay` is purely `reaches(caller, 'compensation', 'read',
     * 'all')`, so it satisfies "all-only" on its face. But it is assigned to a
     * flag that blanks a salary; it does not refuse anybody, and it says
     * nothing about which journeys may be listed. Accepting it let the
     * onboarding listing drop its WHERE clause and still pass — the regression
     * this rule exists for, waved through by the rule's own escape hatch.
     */
    const guards = (name: string): boolean => new RegExp(
      `if\\s*\\(\\s*!\\(?\\s*(?:await\\s+)?${name}\\s*\\(`,
    ).test(body);

    let allOnlyGate = isAllOnly(body) && /if\s*\(\s*!\s*reaches\s*\(/.test(body);
    if (!allOnlyGate) {
      for (const helper of scopeHelpers) {
        if (!guards(helper)) continue;
        const h = bodyOf.get(helper);
        if (h && isAllOnly(h)) { allOnlyGate = true; break; }
      }
    }

    let scoped = perSubject || toSelf || allOnlyGate;
    for (const helper of scopeHelpers) {
      if (scoped) break;
      if (helper === d.name) continue;
      if (!new RegExp(`\\b${helper}\\s*\\(`).test(body)) continue;
      /*
       * Called. If its result was bound to a name, that name has to be used
       * again — a scope clause computed and then dropped is the failure mode
       * worth catching, because the query still runs unrestricted while the
       * call site reads as though it were guarded.
       *
       * The result may also be consumed where it is produced, as in
       * `const where = [employeeScope(caller, ...)]`, so only a plain
       * `const x = helper(...)` assignment is held to the use test.
       */
      const bound = body.match(
        new RegExp(`(?:const|let)\\s+(\\w+)(?:\\s*:[^=]+)?\\s*=\\s*(?:await\\s+)?${helper}\\s*\\(`),
      );
      if (!bound) { if (dynamicWhere) { scoped = true; break; } continue; }
      const uses = body.split(new RegExp(`\\b${bound[1]}\\b`)).length - 1;
      if (uses > 1 && dynamicWhere) { scoped = true; break; }
    }
    /* Or it asks the policy inline. */
    if (!scoped && dynamicWhere && ASKS_POLICY.test(body.replace(/^export[^{]*\{/, ''))) {
      scoped = true;
    }

    listings.push({
      key: `${rel}#${d.name}`,
      file: rel,
      name: d.name,
      line: d.start + 1,
      scoped,
      allOnly: ALL_GATE.test(body),
      person,
    });
  }
}

console.log(`${NL}a listing of person-level data narrows its rows, or admits only 'all'${NL}`);

const unscoped = listings.filter((l) => !l.scoped && !REVIEWED_LISTINGS.has(l.key));

/*
 * A floor, because a detector that finds nothing passes.
 *
 * While this was being sharpened, one bad refinement — counting parentheses
 * across the enclosing JavaScript rather than the SQL — took the count from 26
 * to 0, and the suite reported "every one is scoped" and went green. A check
 * whose silence is indistinguishable from success protects nothing, so the
 * number it finds is asserted too. Raise the floor when listings are added;
 * a drop means the detector stopped seeing, not that the code got safer.
 */
const FLOOR = 25;
ok(`the detector still sees the listings (${listings.length} >= ${FLOOR})`,
  listings.length >= FLOOR,
  'it found almost nothing, which means it has stopped working rather than that '
  + 'everything is scoped');

ok(`${listings.length} person-level listings found, and every one is scoped or all-only`,
  unscoped.length === 0,
  `unscoped: ${unscoped.map((l) => `${l.file}:${l.line} ${l.name} (${l.person})`).join(', ')}`);

if (unscoped.length) {
  console.log('');
  for (const l of unscoped) {
    console.log(`        ${l.file}:${l.line}  ${l.name}  — reads ${l.person}, no scope and no all-gate`);
  }
}

/* A reviewed entry that matches nothing is stale and should go. */
for (const [key, why] of REVIEWED_LISTINGS) {
  const present = listings.some((l) => l.key === key);
  ok(`reviewed exception still applies: ${key.split('#')[1]}`, present,
    `nothing matches ${key} any more — drop the entry. (${why.slice(0, 40)}…)`);
}

/* ===========================================================================
 * 2. Only company_admin changes a role
 * ======================================================================== */

console.log(`${NL}changing somebody's role is company_admin's alone${NL}`);

/** The question `setEmployeeRole` asks: users, write, all. */
const mayChangeRoles = (role: Role, hasReports: boolean): boolean =>
  covers(effectiveFor(role, hasReports, 'users').write, 'all');

for (const c of CALLERS) {
  const expected = c.role === 'company_admin';
  ok(`${c.label.padEnd(24)} may change roles: ${mayChangeRoles(c.role, c.hasReports)}`,
    mayChangeRoles(c.role, c.hasReports) === expected,
    `expected ${expected}`);
}

ok('hr_admin cannot change anyone\'s role', !mayChangeRoles('hr_admin', false));
ok('finance_admin cannot change anyone\'s role', !mayChangeRoles('finance_admin', false));
ok('...nor with reports', !mayChangeRoles('hr_admin', true) && !mayChangeRoles('finance_admin', true));

console.log(`${NL}...and nobody but company_admin grants company_admin${NL}`);

for (const c of CALLERS) {
  const expected = c.role === 'company_admin';
  ok(`${c.label.padEnd(24)} may assign company_admin: ${mayAssignRole(c.role, c.hasReports, 'company_admin')}`,
    mayAssignRole(c.role, c.hasReports, 'company_admin') === expected,
    `expected ${expected}`);
}

/*
 * The source-level half. The policy assertions above would still pass if the
 * gate were changed back to a module that happens to grant the same three
 * roles — which is exactly the mistake that was made, and exactly why it was
 * invisible. So pin the question the code asks, not only its answer today.
 */
console.log(`${NL}and the gate in the code asks about users/write${NL}`);

const svc = readFileSync('server/src/modules/employees/service.ts', 'utf8');
const fn = svc.slice(svc.indexOf('export async function setEmployeeRole'));
const body = fn.slice(0, fn.indexOf(NL + '}'));

ok('setEmployeeRole gates on `users` write all',
  /reaches\(\s*caller\s*,\s*'users'\s*,\s*'write'\s*,\s*'all'\s*\)/.test(body),
  'the gate must be users/write/all, not a module that merely grants the same roles');

ok('...and not on the directory',
  !/reaches\(\s*caller\s*,\s*'employees'\s*,/.test(body),
  'gating a privilege write on who may read the staff list is how hr_admin got it');

ok('it still refuses changing your own role',
  /id === caller\.employeeId/.test(body));

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`listings are scoped, and roles are company_admin's alone${NL}`);
