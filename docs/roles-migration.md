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

## Tools

| | |
|---|---|
| `server/scripts/sweep-roles.mjs` | the directory→module map, key-checked against `POLICY` |
| `server/scripts/sql-role-sweep.mjs` | role mentions inside SQL strings; exits non-zero on a hard-coded old value |
| `checks/pay-routes.ts` | 33 pay routes, their module and verb, and what each role gets |
| `checks/roles.ts` | menu vs policy, the manager layer verb by verb, the employee baseline, fail-closed |
| `checks/role-gates.ts` | **not written yet** — see Left (4) |

Delete the two sweep scripts once `role-gates.ts` is what keeps the comparisons
from coming back.

---

## Standing constraints

Nothing is pushed. No migration runs against production without a dry-run
approved first, and a fresh backup before any step. `.env` values are never
printed.
