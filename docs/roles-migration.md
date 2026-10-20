# The role cutover

Three roles became four, and `manager` stopped being a role at all. This is the
state of that change: what is decided, what is done, what is left, and the order
the remaining steps have to happen in.

Kept current at each commit. If it disagrees with the code, the code is right
and this needs fixing.

---

> **What comes after this:** `docs/roadmap.md` holds phases 0–7 (storage,
> user management, removing seed data, branding, photos, PDFs, document
> requests, projects) and every decision taken on them. Phase 1 is gated on
> steps B and C of this document.

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

> **The runbook is `docs/step-a-runbook.md`** — backup, migration, deploy
> order, the five-minute smoke test, and what to do when something is wrong.
> Read that to run it; this section is what it does and why.

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

### Step B — migrate (written as `0058_role_vocabulary_migrate.sql`)

Data only.

| table | from | to |
|---|---|---|
| `tenant_membership.role` | `admin` | `company_admin` |
| `employee.app_role` | `admin` | `company_admin` |
| `role_permission.role` | `admin` | `company_admin` |
| `joining_request.requested_role` | `admin` | `company_admin` |

`employee` rows unchanged. `manager` rows in `role_permission` unchanged.
**No rows created for `hr_admin` or `finance_admin`** — `role_permission` only
ever narrows, so absent means "no narrowing" and they get the policy ceiling.

Production before: 3 memberships (`hari.siva@` admin, `hr@` admin,
`lakshmi.priya@` employee), `employee.app_role` admin 2 / employee 1,
`role_permission` 99 rows = 33 modules × {admin, manager, employee},
`joining_request` empty.

Expected after: Hari and hr@ → `company_admin`, Lakshmi → `employee`.

Two things the approved three-table mapping did not anticipate.

#### `joining_request` is included although it is empty

It held no rows when the mapping was written and holds none now, so the UPDATE
is a no-op. It is in the migration anyway, because the live code can create a
joining request with `requested_role = 'admin'` at any point before this
applies, and such a row would then be rejected by step C's narrowed constraint —
a failure mid-contract with no obvious cause.

#### Step A's deploy silently stopped applying 18 narrowings

`auth/overrides.ts` skips any `role_permission` row whose role is not one of the
four current names:

```ts
if (!(ROLE_NAMES as string[]).includes(r.role)) continue;
```

`'admin'` is not among them. So from the moment step A's code went live, all 33
`admin` rows stopped being applied, and **18 of them narrow something** — 11
withhold `approve`, 7 withhold `write`, across `billing`, `reports`, `security`,
`approvals`, `employees` and others.

Because this table only ever narrows, losing rows **widens** access rather than
restricting it: `company_admin` was getting the policy ceiling on those modules
instead of the configured limit. Nothing was exposed to a lower role — the two
affected accounts both hold `company_admin`, and the lost rows were a top role's
self-imposed limits — but it was a live, unintended widening introduced by the
step A deploy, and 0058 is what ends it. Once the rows say `company_admin`,
`overridesFor` reads them again. The dry-run confirmed 18 ignored → 18 applied.

This is the cost of expand → migrate → contract that the plan did not name:
between A and B the *data* is in the old vocabulary while the *code* reads only
the new one, so any table keyed by role value is inert in that window.
`role_permission` was the only such table, and because it only narrows, the
window failed open rather than shut.

#### The collision, and why `company_admin` wins

`role_permission` carries `UNIQUE (tenant_id, role, module)`, so a plain rename
fails wherever a `company_admin` row already exists for the same module.
Production had none at the time of writing, but the Access screen is live and
now writes the new vocabulary, so one save creates the conflict.

Where both exist, 0058 keeps the `company_admin` row and deletes the `admin`
one. The `admin` row is already being ignored by the running code per the filter
above, so nothing in effect is lost, and a `company_admin` row can only have
been written after step A shipped — it is the more recent intent.

#### Verification before production

Both shapes were run against a local cluster at migration 57, each inside a
rolled-back transaction: with 46 colliding rows (46 dropped, 0 moved) and in
production's shape with none (46 moved, 0 dropped, 22 narrowed rows preserved).
The production dry-run then applied and rolled back cleanly: 2 memberships, 2
employees and 33 `role_permission` rows moved, 0 dropped, totals unchanged,
`schema_migration` left at 57.

Guards are relative, not absolute — every row found is either moved or dropped
as a duplicate, nothing anywhere still holds `'admin'`, and the `manager` row
count is asserted unchanged — so they are as strict against a fresh local
cluster as against production.

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

## The step A outage, and the fix

Step A shipped on 2026-10-17 and was reverted about 40 minutes later. Sign-in
appeared to work and then sent everybody to "Set a new password", which did not
complete. Production was restored by reverting the code; the database was left
exactly as it was, which is the property the whole expand step was designed
around and the one part of the day that went to plan.

### What broke

`hasReportsFor` queried `employee` directly, inside `withoutTenantForAuth`:

```sql
WITH RECURSIVE line AS (
  SELECT id FROM employee WHERE manager_id = $1 AND tenant_id = $2
   UNION
  SELECT e.id FROM employee e JOIN line l ON e.manager_id = l.id WHERE e.tenant_id = $2
) SELECT EXISTS (SELECT 1 FROM line)
```

The row-level policy on `employee` calls `current_tenant_id()`, and that
function **raises** when nothing is set rather than returning null:

```
42501  no tenant in this session: set app.tenant_id, or sign in with a tenant claim
```

So every authenticated request threw inside `callerFromToken`. Reproduced
locally as `app_rw`, each probe in its own transaction:

```
THREW  the hasReportsFor CTE on employee     -> 42501 no tenant in this session
THREW  plain count on employee               -> 42501 no tenant in this session
THREW  tenant_membership                     -> 42501 no tenant in this session
ok     auth_membership()  (SECURITY DEFINER) -> {"n":0}
```

The old build made four no-tenant reads too — and every one went through
`auth_membership()` or `auth_membership_status()`, which are `SECURITY DEFINER`
and bypass RLS. The new build added a fifth that read a table directly.

### Why the symptom looked like a password problem

`AuthContext.refreshPasswordStatus` fails closed, deliberately:

```js
} catch {
  setMustChange(true);
  setMustEnrol(false);
}
```

An unanswered password obligation costs one screen somebody can complete, so
asking again is the safe default. Here the call was not merely unanswered but
failing for an unrelated reason, and the safe default became a locked door.

And `setPassword` swallows a failed `passwordChanged` — "the password did
change; the reminder simply stays" — then clears `mustChange` in local state
only. So a reset appeared to work and the next refresh re-blocked. That is the
loop, and it is why the cause looked like it was in the password flow.

Worth noting for its own sake: the fail-closed choice was right and the
asymmetry with MFA was reasoned about in a comment. What made it painful is
that the thing it failed closed *about* was not the thing that was broken. A
gate that fails closed on an error it cannot interpret will always point at
itself rather than at the cause.

### Why nothing caught it

Every database-backed suite builds `Caller` objects by hand, so not one of them
had ever executed `callerFromToken`. 203 files of green checks, and the function
that broke was never called.

Migration 0011 had already written the lesson down, in 2024:

> This was invisible until the first end-to-end test, because every earlier
> check ran as the owner, and the owner bypasses row-level security. A test that
> runs as a more privileged role than production does is a test that proves the
> wrong thing.

The 2026 version of the same mistake was narrower and worse: the suites *do*
run the services as `app_rw`, so the role was right — the path was never taken.

### The fix

Migration `0057_auth_has_reports.sql` adds `auth_has_reports(p_user_id uuid)`,
a `SECURITY DEFINER` function in the shape 0011 established. `session.ts` calls
it instead of querying `employee`.

Two details that are not incidental:

- **It takes the user id, not the employee id.** A caller supplies a token and
  the subject of a token is a user. The function resolves the employee and the
  tenant from the membership itself, so there is nothing for a caller holding
  `app_rw` to point at somebody else's line.
- **It is not granted to `authenticated`.** 0011 granted that for a PostgREST
  tenant picker; nothing needs this one that way. 0055's public-role exposure
  check refused the grant when it was copied across, which was correct —
  anything `authenticated` may execute is reachable by anybody holding the
  publishable key.

Proved as `app_rw` with no tenant, which is the condition that broke:

```
ok     auth_has_reports, a real user    -> {"any":false}
ok     auth_has_reports, unknown user   -> {"any":false}
THREW  the OLD direct employee query    -> 42501 no tenant in this session
```

### The check that would have caught it

`check:authnotenant` (`server/scripts/auth-no-tenant.test.mjs`). It checks the
rule rather than one path through it, because `callerFromToken` verifies a real
JWT and these suites deliberately never contact Supabase:

1. **Statically** — every query inside a `withoutTenantForAuth` block reads an
   `auth_*` function and never a table. Reintroducing the direct query makes it
   fail, which was confirmed by doing exactly that.
2. **At runtime, as `app_rw`** — each of those functions answers with no tenant
   set. It asserts the connection really is `app_rw` first, because the owner
   bypasses RLS and a check using the suites' admin connection would have
   passed with the bug present. That is 0011's lesson as an assertion.
3. **A floor** — a direct `employee` read in the same condition still raises
   42501. If that ever stops raising, the rule in (1) is no longer
   load-bearing and this suite has gone blind rather than the code having got
   safer.

### One more defect, found by the same work

`check:migrations` failed on 0057 with "no committed migration has been
modified". False positive: it built its set from `git ls-files`, which counts
the index, so a newly added migration was in it and `diff HEAD` listed it as
changed by definition. Its own comment said "a file staged but not committed is
fine" — the implementation could not deliver that. It now asks
`git ls-tree HEAD`, so "committed" means present in HEAD.

0057 was the first migration added since that check was written, so it was the
first to trip it. A real edit to 0055 is still caught — verified.

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
## The API vocabulary, and the last-administrator invariant

### The root cause nobody could see

`modules/users/service.ts` declared its own type:

```
type Role = 'admin' | 'manager' | 'employee';
```

shadowing the real one. Every role question in that file asked the old
question and typechecked perfectly while doing it. Importing the policy's
`Role` is what turned the rest of the file's mistakes into compile errors —
and then into `import.ts`'s as well.

### What was broken

| site | was | now |
|---|---|---|
| `users/service.ts` `validate` | `['admin','manager','employee']` | `ROLES` — **`company_admin` was refused as "Not a role", so creating an administrator was impossible on this branch** |
| `users/service.ts` `mayGrant` | `role === 'admin'` | `grantNeedsAuthority` + `mayAssignRole`; hr_admin and finance_admin were never guarded in either vocabulary |
| `users/service.ts` demotion guard | self only, `'admin'` only | both halves: self, and a **count** so the last administrator cannot be demoted by anybody |
| `users/import.ts` | same three, same `=== 'admin'` | same fixes, for the CSV path |
| `http/app.ts` role route | a cast that validated nothing | **400** naming the four valid roles |
| `employees/mapper.ts` | `role: 'admin'|'manager'|'employee'`, cast from the column | `Role`, via `normaliseRole` |
| `config/permissions.ts` | `p.role === 'company_admin'` | `ADMIN_LAYERS`, both spellings — a `role_permission` row may still be keyed `admin` until step B |

The demotion half deserves spelling out: it only ever asked "is this me", so
two administrators could take each other's role away and lock the tenant out
of its own settings — the same outcome the deactivation half exists to
prevent, reached by a different door. There is no database trigger behind
either; the guard is all there is.

### Two mistakes of my own, caught by the suites

**`mayGrant` moved the baseline.** Asking `mayAssignRole` unconditionally
refused a manager creating an ordinary employee, because that function bundles
"may you assign roles at all" with "may you assign an administrative one".
`check:provisioning` caught it. Whether somebody may create an account is
`mayAdminister`'s question; `mayGrant` is only about handing out more than the
baseline.

**The normaliser dragged `config.ts` into a pure mapper.** `employees/mapper.ts`
reads `app_role` from a row too, and importing `normaliseRole` from
`session.ts` pulled the environment in behind it — `check:payvisibility` could
not load for want of `DATABASE_URL`. The function now lives in `policy.ts`,
the vocabulary's home, which has no environment of its own; `session.ts`
re-exports it so it is still the one entry point for a token's role. A
deliberate departure from "the normaliser lives only in session.ts", for that
reason.

### Rule 3: nobody compares against a role value by hand

Covers TypeScript and SQL strings, and retires `sql-role-sweep.mjs`. Both
forms are proven to fail: `caller.role !== 'admin'` in a service, and
`WHERE role = 'company_admin'` in a query.

Allowed, each with its reason in the file: `policy.ts` and `session.ts` (the
vocabulary and the normaliser), and three named lists of *database* values for
the expand window — `ADMIN_ROLES` in `users/service.ts`, `ADMIN_LAYERS` in
`config/permissions.ts`, and the owner-preference parameter in
`helpdesk/service.ts`. Step C narrows all three.

Migrations are scanned only from 0057 onward. An applied migration is history
and cannot be edited — the runner refuses a file whose checksum changed — so
flagging 0001, 0002, 0003 and 0012 for declaring the original CHECK
constraints asks for something impossible. What those constraints say *now* is
0056's business.

Writing `role !== 'employee'` in a service would itself have broken this rule,
which is how `grantNeedsAuthority` came to live in `policy.ts`: the comparison
is against the vocabulary, so it belongs where the vocabulary is.

### Both halves, now tested

`server/scripts/last-admin.test.mjs` (`check:lastadmin`). There was no
coverage of this invariant at all before — no suite, and no database trigger
behind it either, so the service guard was the whole safeguard and nothing
checked it.

It proves four things, each against a scratch tenant:

1. with two administrators, one may be demoted; the last one may not;
2. the last one may not be deactivated either;
3. an administrator spelled `admin` **counts** — demoting the other one is
   allowed because the count finds the legacy row, and the legacy row is then
   protected in turn under the old name;
4. nobody removes their own role, with another administrator in place, so the
   self clause is what refuses rather than the count.

Three reverts, each confirmed to make it fail: narrowing `ADMIN_ROLES` to
`company_admin` alone, deleting the demotion count, and putting the demotion
guard back to self-only.

**One thing worth knowing about reaching the count at all.** The demotion
count only fires when the caller is not the account being demoted — otherwise
the self clause goes first — and the caller has to be an administrator to call
`updateUser`. So the only caller who can reach it is an administrator whose
own membership is not active. The scratch tenant's membership is `invited`,
which makes it exactly that, and it is a real situation rather than a
contrivance: an invited administrator, or one whose membership was
deactivated while their token still says company_admin.

The suite creates rows in `auth.users`, which the other suites avoid. They are
plain rows in a local table, not Supabase accounts — only `id` is required —
and they are deleted by hand, because the tenant cascade runs the other way.
The census counts them so a leak shows.
### The one expectation that changed (approved 2026-10-17)

`hierarchy.test.mjs:225` asserted `mgrAccount.role === 'manager'` after
creating a manager. There is no manager role to assign, so:

| | |
|---|---|
| was | `ok('  with the manager role on the membership', mgrAccount.role === 'manager')` |
| now | `ok('  with the employee role on the membership', mgrAccount.role === 'employee')` |
| added | after the report is created: `which is what makes the first account a manager`, counting `employee WHERE manager_id = MGR_ID` |

The added assertion is the point. The old one checked a label; the new pair
checks the model — the membership carries `employee`, and the person is a
manager because somebody reports to them. The `hasReports: true` that
`sweep-fixtures.mjs` had put in the `createUser` body is gone too; that
function does not accept it, and whether somebody answers for other people is
read from the reporting tree rather than declared when their account is made.

All 36 suites now pass.

---
## The five manager gates

Each was written `reaches(caller, <module>, 'read', 'all') || caller.hasReports`.
That grants **all-scope entry** to anybody with one direct report, and where
the query behind the gate was unscoped the gate's breadth became the query's
breadth. All five now match the table.

### What the table actually says, which is not the same for all five

| gate | module row | the manager layer gets |
|---|---|---|
| `onboarding/mayOnboard` | `rule(NO, ['team','team','none'], …)` | team read and write |
| `exits/mayHandle` | `rule(SELF, ['team','none','none'], …)` | team read, **no write** |
| `hiring/mayRecruit` | `rule(NO, ['team','team','team'], …)` | team on all three verbs |
| `documents/mayChase` | `rule(SELF, SELF, …)` | **own** — not team |
| `helpdesk` (knowledge base) | `rule(SELF, LINE, …)` | write **own** — their tickets, not the KB |

So three confine a manager to their team, and two take the act away:

- **documents** — chasing a document is HR's. A manager cannot request one
  even from a direct report, because the table gives the layer `own`. If they
  should be able to, that is a grant on the module, not a special case in the
  gate.
- **helpdesk** — an unpublished knowledge-base article is editorial state and
  has no team to belong to, so drafts are visible to whoever reaches
  `helpdesk` write all. The manager layer's `own` is their own tickets.

### exits had an approved decision that had never reached the code

The table gives the manager layer `exit` write `none` — the decision that a
manager raises a *request* and HR actions it. Every write in the module was
gated on `mayHandle`, the read gate, so a manager could raise an exit, sign
off clearance and record an interview on **anybody in the company**. There is
now a separate `mayRecordExit` asking for `exit` write all.

The request flow that would give a manager the act back needs a pending state
the exit record does not have, so it stays on the backlog.

### The new helper

`tenancy/scope.ts` gains `personInScope(db, caller, employeeId, module, verb)`,
which answers all three scopes properly — the team case by walking
`employee.manager_id`, which is the only way it can be answered.
`reachesPerson` in `auth/can.ts` returns false for that case on purpose and
says to come to the database; this is that. It replaces a synchronous stub of
the same intent that nothing called and that silently refused every team case.

Hiring needed two more, because a hiring record's line is not an employee's:
a requisition belongs to its `hiring_manager_id` (not its `recruiter_id`, which
is the HR person running the search), a candidate to its requisition, and an
interview to its requisition. `reqScope` is the SQL fragment and
`mayTouchRequisition` / `mayTouchCandidate` the per-record checks.

### The checks, and what they do and do not catch

`server/scripts/manager-gates.test.mjs` (`check:managergates`). A scratch
tenant with a manager, a direct report and an outsider; every gate asks the
same two questions.

Reverting each change one at a time:

| revert | caught |
|---|---|
| onboarding per-journey check removed | yes |
| exit writes back on the read gate | yes |
| hiring per-requisition check removed | yes |
| `mayChase` back to `all || hasReports` | yes |
| helpdesk editor back to `all || hasReports` | yes |
| `mayOnboard` back to `all || hasReports` | **no** |
| `mayHandle` back to `all || hasReports` | **no** |
| `mayRecruit` back to `all || hasReports` | **no** |

The three misses are correct, and the reason is worth keeping. Under the union
model anybody with reports picks up the manager layer, and that layer grants
`team` in exactly those three modules — so `reaches(…, 'team')` and
`all || caller.hasReports` admit **the same callers** there. For those three
the gate change is a clarity fix, not a security fix; the confinement is the
scope behind it, and that is what the suite catches.

Where the gate *was* load-bearing is documents and helpdesk, because the layer
grants `own` there rather than `team` — and both of those are caught.

### One fixture changed

`kb.test.mjs` asserted "but whoever may edit it still does" using a *manager*
as the editor. The assertion is unchanged; the fixture is now an `hr_admin`,
who is actually an editor, plus a new assertion that a manager is not. The old
fixture encoded the old model rather than testing the new one.

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
