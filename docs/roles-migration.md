# The role cutover

Three roles became four, and `manager` stopped being a role at all. This is the
state of that change: what is decided, what is done, what is left, and the order
the remaining steps have to happen in.

Kept current at each commit. If it disagrees with the code, the code is right
and this needs fixing.

---

## The model

```
admin      ->  company_admin
manager    ->  employee, with the layer derived from employee.manager_id
employee   ->  employee
(new)      ->  hr_admin, finance_admin
```

`manager` is not assignable and never was a title: answering for other people is
a fact about the reporting tree. It survives as a **layer**, which is additive:

```
effective = max(employee, hasReports ? manager : none, assignedRole)
```

per module, per verb. Scopes are `none | own | team | all`; `team` is the
reporting line at any depth.

Two consequences that caused most of the bugs in this change:

- **An administrator is also an employee.** `hr_admin` reaches 39 modules where
  its own layer covers 38 — the extra one comes from the employee baseline.
  Admin grants add; they never subtract.
- **A manager *is* an employee.** So `role === 'employee'` stopped meaning "has
  no privilege", and every site reading it that way silently excluded managers.

### Decided

| | |
|---|---|
| HR and Finance on pay | **identical** — `all/all/all` on payroll, compensation, tax, benefits, expenses. Giving each view-only on the other's half left nobody able to run payroll. |
| `settings` | `company_admin` only, both sides. Users, roles, departments, locations, leave policies, salary components are one job. |
| Manager on pay | `own` or nothing, except approving their reports' expense claims. |
| Manager on people-ops | `team` on leave, attendance, timesheet, performance, helpdesk, devplans. |
| `planner` write | `all` → `team`. A manager edited anybody's plan. |
| `software` read | `all` → `team`. The estate is not a catalogue: every seat carries `employee_id`, `full_name`, `dept_code`. |
| `exit`, `lifecycle` write | `team` → `none`. HR's act. **See the gap below.** |
| `onboarding` write | stays `team` — tasks for their own joiner. |
| `user.request` | A manager may ask for an account: lands Pending Approval, role forced to `employee`, no sign-in. Creating, approving and assigning stay `company_admin`. |
| Account acts | Deactivate and bulk update are `company_admin` only. |
| Employee exports | Their own data, caller-scoped only, asserted row by row. |
| `role_permission` manager rows | **Kept.** The layer is narrowable; a tenant that does not want managers approving leave needs somewhere to say so. |
| Unknown role | Fails closed everywhere — `none`, not the tree branch. |

### An open gap

`exit` and `lifecycle` write went to `none` with **nothing replacing it**. The
request flow (manager asks, hr_admin actions it) needs a pending state that
neither record has: `ExitRecord.status` is `'Notice Period' | 'In Clearance' |
'Settled'` and a `LifecycleTask` carries a `done` boolean. That is a schema
change, so it is on the backlog. Until it lands **a manager cannot assign a
lifecycle task at all** — a capability removed, not relocated.

---

## Expand, migrate, contract

The database, Render and Pages cannot switch in the same instant, and whichever
goes first the gap locks everybody out. Narrow the constraints first and the
live code's `'admin'` is refused on its next write; deploy first and the new
code writes names the constraint refuses.

### Step A — expand (written, dry-run, **not applied**)

`server/db/migrations/0056_role_vocabulary_expand.sql`. Widens four CHECK
constraints to accept **both** vocabularies. Touches no row, no default, no
function.

| table | column | constraint |
|---|---|---|
| `tenant_membership` | `role` | `tenant_membership_role_check` |
| `role_permission` | `role` | `role_permission_role_check` |
| `employee` | `app_role` | `employee_app_role_check` |
| `joining_request` | `requested_role` | `joining_request_requested_role_check` |

All four get `'admin', 'manager', 'employee', 'company_admin', 'hr_admin',
'finance_admin'`.

**`role_permission` is the exception in step C**: it keeps `'manager'`
permanently. The other three drop it.

Order within step A: **migration first, then the server and frontend deploy.**
Widening forbids nothing that is allowed today; the reverse fails on the first
write.

Step A ships only when the whole sweep is done and everything is green.

### Step B — migrate (approved, not written)

Data only.

| table | from | to |
|---|---|---|
| `tenant_membership.role` | `admin` | `company_admin` |
| `employee.app_role` | `admin` | `company_admin` |
| `role_permission.role` | `admin` | `company_admin` |

`employee` rows unchanged. `manager` rows in `role_permission` unchanged.
**No rows created for `hr_admin` or `finance_admin`** — `role_permission` only
ever narrows, so absent means "no narrowing" and they get the policy ceiling.

Production today: 3 memberships (`hari.siva@` admin, `hr@` admin,
`lakshmi.priya@` employee), `employee.app_role` admin 2 / employee 1,
`role_permission` 99 rows = 33 modules × {admin, manager, employee},
`joining_request` empty.

Expected after: Hari and hr@ → `company_admin`, Lakshmi → `employee`.

### Step C — contract (not written)

- Narrow the four CHECKs to the new vocabulary; `role_permission` keeps
  `'manager'`.
- Delete `normaliseRole` from `server/src/auth/session.ts`.
- Narrow the expand-phase `['admin', 'company_admin']` lists (see below) to
  `company_admin` alone.
- Drop `current_app_role()` — it exists since 0001 and **nothing calls it**.
- From here `'admin'` is refused by the database as well as the policy, which is
  when the HTTP-level "old value → 403" assertion becomes true.

Backlog, after step C: a DB-level trigger for the last-administrator invariant.
There is none today; the guard is service-side only.

---

## The SQL surface

Checked rather than assumed. **No RLS policy compares a role value**, the one
view (`export_run`) does not mention role, and `auth_membership` passes
`m.role` through verbatim and compares it to nothing — so the normaliser in
`session.ts` is sufficient and no function needs rewriting.

Three functions insert the literal `'employee'` (`0013`, `0046`, `0049`), valid
in both vocabularies, so unchanged.

Two `'manager'` literals are **other domains** and must be left alone:
`0006_talent.sql:186` (a task owner: `hr`, `it`, `finance`, `candidate`) and
`0029_job_order.sql:185` (a recruiter's part: `primary`, `backup`).

### Embedded SQL

SQL also lives in template literals. `server/scripts/sql-role-sweep.mjs`
extracts string literals, keeps the SQL ones and looks inside those — line-based
searching misses `WHERE role = 'admin'` on a keyword-less line of a multi-line
query. 12 role mentions across 72 files; 10 are parameterised or insert
`'employee'`.

Two hard-coded old values, both now accepting `['admin', 'company_admin']` for
the expand phase:

- `users/service.ts` — **the last-administrator guard**, in two places
  (`row.role === 'admin'` and `WHERE role = 'admin'`). After step B it would
  have counted zero, so the guard would pass silently and the final
  administrator could be removed.
- `helpdesk/service.ts` — default-assignee ordering, `ORDER BY (e.app_role =
  'admin') DESC`.

---

## The sweep

`Caller.role` carried the old three values while `policy.Role` carried the new
four — two vocabularies in one process that never met, which is why the server
typechecked while the guards asked a question the policy could not answer.

`Caller.role` is `Role` now and `Caller` carries `hasReports`.
`callerFromToken` is the only place a Caller is built, so it is the only place
that maps the database value, and it reads the reporting tree once per sign-in.

`server/src/auth/can.ts` answers what the sites need:

- `reaches(caller, module, verb, needed)`
- `scopeOf(caller, module, verb)`
- `reachesPerson(caller, module, verb, empId)` — what `assertOwnOrAdmin` was

It does **not** read `role_permission`, and that is the design: the HTTP layer
applies the tenant's narrowing once per request and refuses the whole module
before any handler runs. The boundary answers "may this role open this module";
the service answers whether a particular act inside it is allowed.

`server/scripts/sweep-roles.mjs` holds the directory-to-module map and checks
every key against `POLICY` before writing. A wrong key is worse than a missed
site: an unknown module answers `none`, so a typo denies everybody in silence.
Several differ from their directory — `config`→`settings`, `exits`→`exit`,
`joiners`→`onboarding`, `projects`→`planner`, `schedules`→`shifts`,
`calendar`→`attendance`, `noticeboard`→`announcements`, `letters`→`documents`,
`loans`→`benefits`, `people`→`employees`, `staffing`→`bench`.

### Done

- 192 `caller.role` comparisons → policy questions. Server and frontend
  typecheck at 0.
- Frontend swept: 134 compiler-visible sites plus ~65 `role === 'employee'`
  sites, three duplicate `ROLE_LABEL` copies consolidated, reports/exports/nav
  pointed at their module instead of carrying a role list.
- `MANAGER_LAYER` carries the full rule per verb, **generated** from
  `ruleFor('manager', m)`. It held 8 module names where the layer grants 35, and
  then a single read scope the gates used for writes.
- Both SQL scope helpers take a scope rather than a role.
- `checks/` is typechecked (`tsconfig.checks.json`) — it was not, which is how
  two dozen stale fixtures stayed invisible.
- `check:all` runs every suite and reports at the end
  (`scripts/check-all.mjs`); it derives its list, which found `check:shape`
  defined and never run.

### Left

1. **API input** - `http/app.ts:287` types a request body as the old three
   values, so the API would accept them from a client;
   `employees/mapper.ts:59` carries the same union. Three more read role from
   input: `users/service.ts:281`, `users/service.ts:497` (the demotion half of
   the last-administrator invariant) and `users/import.ts:164` (CSV). From
   step A, request bodies accept only the new vocabulary and old values get a
   400. The normaliser is for database values only.
2. **`checks/role-gates.ts`** - must fail on a raw comparison against **any**
   role literal, `'employee'` included, outside the policy files, in
   TypeScript **and** inside SQL strings. It has to subsume
   `sql-role-sweep.mjs` or the two can disagree.
3. The step A runbook: backup, migration, deploy order, smoke test.
4. The four database-backed server suites (`check:claim`, `check:invite`,
   `check:provisioning`, `check:profile`) need a local Postgres to run; they
   fail on an empty connection string, not on anything in this change.

---

## Keeping the tests off production

Done before the rest of task 0, because the suites that prove the cutover are
the same suites that could have performed it on the live tenant.

Every database-backed suite in `server/scripts` reads `MIGRATE_DATABASE_URL`,
and every one of them writes — employees, invitations, schedules, payroll runs.
That variable sat in `server/.env`, which `loadEnv()` loads for anything that
asks. Nothing stood between `npm run check:invite` and production except the
person running it remembering to override the variable first.

It never did fire, and the reason is not reassuring: both URLs in `.env` are
truncated to `postgresql://user.ref:password`, with no `@host:port/database` at
all, so the suites died on `Invalid URL` instead of connecting. Luck, not a
safeguard — and the same truncation is why `MIGRATE_DATABASE_URL` could not
have run a migration either.

Two layers now:

1. **`server/scripts/local-only.mjs`** — `assertLocalDatabase()` exits unless
   every connection string it is given resolves to `localhost`, `127.0.0.1`,
   `::1` or a Unix socket. It prints the variable name and the host, never the
   URL, the user or the password. Inserted into **27 suites** by
   `add-local-guard.mjs`; tested by `check:localonly`, which runs first in the
   server `check` chain.

   The host is parsed by hand on purpose. `new URL` throws on a malformed
   string and puts the whole string — password included — into `error.input`,
   which is how a password got printed in this project once already. Two
   commands in `db/MIGRATION_RUNBOOK.md` used exactly that pattern to "confirm
   the target without printing a credential"; both now call `hostOf`.

2. **`server/.env.migrate`** — the production migration credential moved out of
   `.env` into a file nothing loads automatically. `scripts/env.mjs` exports a
   separate `loadMigrateEnv()`, and only `migrate.mjs --production` calls it.
   Without the flag the runner refuses any non-local host; with it, it prints
   the host and makes the operator type that host back. Git-ignored via
   `.env.*` with `!.env.example`.

Consequence worth knowing: six tools that are allowed to reach production and
read `MIGRATE_DATABASE_URL` from `.env` — `seed.mjs`, `retention.mjs`,
`inspect.mjs`, `verify-backfill.mjs`, `verify-isolation.mjs`, `ci-bootstrap.mjs`
— no longer find it there. They need it exported in the shell, or the same
`--production` treatment. CI is unaffected: the workflow sets its own localhost
value.

---
## Known issue on main, fixed by this branch

**Any holder of the `manager` role sees every joiner's offered CTC.**

Recorded here because it is live code, not a branch defect, and because the
thing keeping it harmless is a fact about who holds which role rather than
anything in the code.

| | |
|---|---|
| Where | `server/src/modules/onboarding/service.ts` — `mayOnboard` and `listOnboarding` |
| On main | `mayOnboard` is `caller.role === 'admin' || caller.role === 'manager'`, and `listOnboarding` runs `PROJECTION` with **no WHERE clause** |
| What leaks | every `onboarding_journey` row in the tenant, including `annual_ctc` — the joiner's offered salary |
| Who | anybody with the `manager` role. The manager layer holds no `compensation` grant at all |
| Reachable today | **No.** None of the three production users holds `manager`: Hari and hr@ are admins, Lakshmi is an employee |
| Severity if assigned | a manager would see the whole company's joiner salaries, not just their own team's |

### Mitigation until this branch ships

Do not assign the `manager` role in production. Agreed with the owner on
2026-10-17; the fix ships with the roles work rather than as a separate
hotfix, because on this branch the manager layer is derived from the reporting
tree and a one-line patch to main would not carry forward.

### The fix on this branch

1. `journeyScope(caller)` applies the `team` scope the policy always specified
   (`onboarding: rule(NO, ['team', 'team', 'none'], ...)`). The subtree is
   walked over `j.manager_id`, not over the joiner, because a joiner usually
   has no `employee` row yet.
2. `toJourney` and `load` take a pay flag set from `compensation` read all, so
   `ctc` is `0` for anyone who is not a compensation reader — including a
   manager looking at their own team's journey.

Note the two are independent: the scope fix alone would still have shown a
manager their own joiner's salary, and the pay-flag fix alone would still have
shown them every journey in the company. Both were needed.

### Why no test caught it

There was no assertion that a listing of person-level data carries a scope
clause, and `check:paycensus` structurally cannot see one going missing — it
reasons about gates, not about WHERE clauses. That rule is now in
`role-gates.ts`, which is what closes the hole that let this happen.

---
## The pay-data census

The sweep turned `caller.role === 'admin'` into a policy question, and where
it had to choose a module it took the one from the file's own directory. For
pay that is the wrong question: a salary read from `modules/employees` is
compensation's to grant, not the directory's.

Five instances, all on this branch, all in `modules/employees/service.ts`:

| site | was | now |
|---|---|---|
| `maySeePay` | `employees` read all | `compensation` read all |
| `listVisibleEmployees` | passed `employees` read all as the pay flag | `maySeePay(caller)` |
| `listExitedEmployees` | pay flag hardcoded `true` | `maySeePay(caller)` |
| `getTeam` | passed `employees` read all as the pay flag | `maySeePay(caller)` |
| `setEmployeeRole` | `employees` **read** all | `users` **write** all |

None of the first four was an exposure, and the reason is worth writing down:
exactly the three administrative roles hold `employees` read all, and exactly
the same three hold `compensation` read all. The two sets coincide, so no test
that compared role names could have seen the difference. What was wrong was the
*question*, and it stops being equivalent the moment anybody is given the
directory without the payroll. `check:payvisibility` asserts the coincidence
explicitly, so the day it stops holding, something fails.

`setEmployeeRole` is the exception and was a real escalation path: gated on who
may *read* the directory, hr_admin and finance_admin could change anybody's
role, including promoting an account to company_admin. Now `users` write all —
company_admin alone, which is the approved rule. `mayAssignRole` is the finer
test and is still not wired in, because `Employee['role']` carries the old
three values; that lands with the API vocabulary change.

### Onboarding, which was a real exposure

`listOnboarding` ran its projection with **no scope clause at all**, and
`mayOnboard` admits anybody with a direct report. Every onboarding journey in
the tenant came back, `annual_ctc` included. The projection carries the
joiner's offered CTC and the manager layer holds no compensation grant
whatsoever.

This one is **not** branch-only. On main, `mayOnboard` is
`caller.role === 'admin' || caller.role === 'manager'` and the listing is
equally unscoped, so any holder of the `manager` role sees every joiner's CTC.
It is not reachable in production today only because none of the three live
users holds `manager`. On this branch the layer is derived from the reporting
tree, so one direct report would have been enough.

Fixed in two places: `journeyScope` applies the `team` scope the policy always
meant, walking the subtree over `j.manager_id` because a joiner usually has no
employee row yet; and `toJourney` takes a pay flag set from `compensation` read
all.

### What main was right about

`maySeePay` on main is correct. Both copies read
`caller.role === 'admin' || own`, which in the three-role model is exactly
"an administrator, or the person themselves". The pay-gate defect is entirely
a product of the sweep.

### The tools

`scripts/pay-census.mjs` (`check:paycensus`) finds every pay read, walks the
call graph to the nearest gating ancestor along *every* path, and fails if any
path resolves to a non-pay module. Reviewed exceptions live in a `REVIEWED` map
with the argument for each, so a new one is a finding rather than a silence.
It also asserts that a mapper handed a pay flag consults it on every pay field
taken from the row — the invariant that the call-graph half structurally cannot
see.

Four bugs in the census itself, each found by reverting a real fix and checking
it went red:

- it stopped at the first gating ancestor it liked, so a read reachable from
  both a correct and an incorrect gate looked clean — which hid the very bug it
  was built to find;
- `db.query(...)` matched the module-level `query` helper, making every service
  that runs SQL a caller of the directory mapper;
- an `interface` body ended at its first `;`, so `ctc: number` in a type
  declaration counted as a read;
- bare function names matched across the whole tree, attributing an onboarding
  salary read to a gate in helpdesk.

`scripts/pay-visibility.test.mjs` (`check:payvisibility`) is the behavioural
half: given a row with every pay field populated, the mapper must emit nothing
for a caller who may not see pay, and the policy must give no employee —
with or without reports — any compensation read.

Reverting each of the five fixes one at a time: four of five are caught by
`check:paycensus`, and the mapper-flag revert too. Two things it does **not**
catch, stated so nobody assumes otherwise:

1. `setEmployeeRole` reaching a non-pay gate — correctly, since after the
   call-graph fix it reaches no pay read. It is a privilege finding and belongs
   in `role-gates.ts`.
2. A listing *losing its scope clause*, which is how the onboarding exposure
   happened in the first place. That is a row-scope invariant, not a pay-gate
   one, and nothing asserts it yet. **It should go in `role-gates.ts`.**

---
## The local database suites

All three asked for are green, and 25 of the 26 database-backed suites pass
against the local cluster with 0056 applied. Only `check:hierarchy` fails, and
what it fails on is real — see below.

### Two bugs in `sweep-fixtures.mjs`, found by running the suites

The sweep rewrote `role: 'manager'` as `role: 'employee', hasReports: true`
wherever it found it. That is right for a `Caller` and wrong for anything else,
and it could not tell the difference:

| site | what it actually is | effect |
|---|---|---|
| `invite.test.mjs:319` | a `tenant_membership` **row** | changed what the row holds, breaking the assertion that the audit detail carries the role |
| `hierarchy.test.mjs:221` | a `createUser` **request body** | asked for an employee where the test means to create a manager |

The invite one is reverted: `manager` is a legitimate membership value during
expand, since 0056 accepts both vocabularies. It has to change at step C.

### A third sweep gap: the `caller(role)` factories

Six suites do not write `role: 'admin'` at all — they have a factory and pass
the value at the call site as `caller('admin', id)`. `sweep-fixtures.mjs`
matched the literal, so it never saw them, and 42 call sites still handed the
policy an old role. The policy fails closed on a value it does not recognise,
which is correct, and which is why the failures read as real refusals:
`check:profile` reported that an administrator could not read their own record.

Worth noting for its own sake: `caller('employee', ...)` still works, because
`employee` is a valid value in both vocabularies. So these suites half-failed
rather than falling over, and the passing half made the failures look like
access bugs rather than stale fixtures.

`sweep-caller-factories.mjs` converts them — factory gains a trailing
`hasReports = false`, `admin` becomes `company_admin`, `manager` becomes
`employee` with `true` appended at the call site — and exits non-zero if any
old value is left. No expectation was touched.

### What `check:hierarchy` is actually telling us

**1. `users/service.ts:294` still validates against the old vocabulary.**

```
if (d.role !== undefined && !['admin', 'manager', 'employee'].includes(d.role)) {
  throw new UserError('Not a role', 'invalid');
}
```

So `role: 'company_admin'` is refused as "Not a role": **creating an
administrator is impossible on this branch.** This is item 3's job — the API
accepting only the new vocabulary — and it is a hard blocker for step A, since
the deploy would ship a server that cannot make an admin.

**2. `users/service.ts:281` compares an old literal.**

```
if (role === 'admin' && !reaches(caller, 'users', 'write', 'all')) {
```

`mayGrant` only guards the string `admin`. Once validate accepts the new
names, granting `company_admin` walks straight past it — so fixing (1) without
(2) opens a privilege escalation. **They must land together.**

**3. One genuine expectation change, awaiting approval.**

`hierarchy.test.mjs:225` asserts `mgrAccount.role === 'manager'` after
creating a manager. Under the approved model there is no manager role to
assign: a manager is an employee with reports. The expectation has to become
`=== 'employee'`, and that is a decision, not a rename.

---
## role-gates.ts

Two rules so far, both approved on 2026-10-17. The role-literal sweep joins
them and subsumes `sql-role-sweep.mjs`.

### Rule 1 — a listing of person-level data carries a scope clause

The rule whose absence caused the onboarding exposure. A listing passes if it
narrows its rows to the caller, restricts to one subject named in the call, or
refuses anybody who does not already hold `all`.

It found **three more listings of the same shape**, all gated at `team` or
looser and then queried company-wide. All three are fixed here, each by
applying the scope the policy table already specified:

| listing | gate | what a manager saw | fix |
|---|---|---|---|
| `assets/pendingRecovery` | `assets` read **team** | every leaver's outstanding kit, company-wide, with names | `scope(caller, 'a.employee_id', params)` |
| `exits/listExits` | `exit` read all **|| hasReports** | every exit record in the company | `employeeScope(..., 'exit')` |
| `hiring/recruiterTracker` | `hiring` read all **|| hasReports** | every recruiter's numbers | `employeeScope(..., 'hiring')` |

An all-scope reader gets `TRUE` from the scope helper, so HR, finance and
company_admin see exactly what they saw before. What narrows is the manager
layer, to the `team` the table always gave it.

### The pattern underneath all four

Five gates are written `reaches(caller, <module>, 'read', 'all') ||
caller.hasReports`:

| gate | module | manager's scope in the table |
|---|---|---|
| `documents/mayChase` | documents | `own` |
| `exits/mayHandle` | exit | `team` |
| `helpdesk` (line 353) | helpdesk | `team` |
| `hiring/mayRecruit` | hiring | `team` |
| `onboarding/mayOnboard` | onboarding | `team` |

Each grants **all-scope entry** to anybody with one direct report, and the
table grants them `team` or `own`. Where the query behind such a gate was
unscoped, the gate's breadth became the query's breadth — which is the whole
onboarding bug in one sentence. The three listings above are fixed; the gates
themselves still read this way and are **left as they are for now**, because
changing what a manager may *enter* is a different decision from what a query
may *return*, and rule 1 now makes the dangerous combination fail.

`mayChase` is worth a separate look: a manager may request documents from
anybody in the company, which is a write-breadth question rather than a
listing one.

### Rule 2 — only company_admin changes a role

Asserted twice: against the policy, for all eight caller shapes
(`users` write all, and `mayAssignRole(..., 'company_admin')`), and against
the source, because the policy assertions alone would still pass if the gate
were changed back to a module that happens to grant the same three roles —
which is exactly the mistake that was made, and exactly why it was invisible.

### Four bugs in the rule itself

Each found by reverting a real fix and checking the check went red. Worth
recording because every one of them made the rule *pass* while the bug it
exists for sat in front of it:

- a per-file list of scope helpers missed `employeeScope`, the canonical one,
  which is imported rather than defined locally;
- the paren-depth scan ran over the enclosing JavaScript instead of the SQL,
  so it never returned to depth zero. The count went from 26 listings to **0**
  and the suite reported "every one is scoped" and went green. There is now a
  floor assertion, because a detector whose silence looks like success
  protects nothing;
- `${PROJECTION}` constants were not expanded, so `listOnboarding` — the
  listing the rule was written for — was not seen as person-level at all;
- the all-gate escape accepted any all-scope check, including
  `maySeeJoinerPay`, a *pay* flag that refuses nobody. That waved through an
  onboarding listing with its WHERE clause deleted. An all-gate now counts
  only in guard position, `if (!gate(...))`.

One revert is not caught and does not need to be: removing the scope helper
while leaving `WHERE ${scope.sql}` in the query fails `tsc` with "Cannot find
name 'scope'" twice. The realistic shape — removing both — is caught.

Known limit: the outermost `FROM` of a `WITH x AS (...) SELECT ... FROM x`
query is the CTE, so a listing built that way is not seen as person-level.
`listCelebrations` is one, and is public by policy anyway.

---
## Tools

| | |
|---|---|
| `server/scripts/sweep-roles.mjs` | the directory→module map, key-checked against `POLICY` |
| `server/scripts/sql-role-sweep.mjs` | role mentions inside SQL strings; exits non-zero on a hard-coded old value |
| `checks/pay-routes.ts` | 33 pay routes, their module and verb, and what each role gets |
| `checks/roles.ts` | menu vs policy, the manager layer verb by verb, the employee baseline, fail-closed |
| `server/scripts/pay-census.mjs` | every pay read, the gate on every path to it, and whether mappers use their pay flag |
| `server/scripts/pay-visibility.test.mjs` | the behavioural half: no pay field for anyone else |
| `server/scripts/local-only.mjs` | refuses a non-local database; `check:localonly` tests it |
| `checks/role-gates.ts` | listings carry a scope clause; roles are company_admin's alone. The role-literal sweep still to come |

Delete the two sweep scripts once `role-gates.ts` is what keeps the comparisons
from coming back.

---

## Standing constraints

Nothing is pushed. No migration runs against production without a dry-run
approved first, and a fresh backup before any step. `.env` values are never
printed — and as of task 0 the tooling enforces that rather than relying on it:
the suites refuse a non-local host, and the only script that can reach
production needs a flag, prints the host and asks.
