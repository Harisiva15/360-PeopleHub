# 360 People Hub — backend contract

What the frontend needs from a server, derived from
[`src/services/contracts.ts`](../src/services/contracts.ts). That file is the
authority; this document is the same thing expressed as HTTP for whoever is
building the API.

Implementing this means writing one class that satisfies `Services` and calling
`setServices()` in [`src/services/index.ts`](../src/services/index.ts). No screen
changes.

---

## Before any endpoint: three things the mock cannot do

The frontend currently ships with an in-memory implementation. Three properties
it fakes are the server's job, and **none of the endpoints below are safe
without them**.

### 1. Authentication and the caller identity

Every scoped read takes a `Caller { role, meId }`. In the mock this comes from a
React state variable — the role switcher in the top bar. **A real deployment must
derive it from the session token and ignore anything the client sends.**

The client will keep passing scope hints. Treat them as hints only; re-derive
scope server-side from the token. Today the role switcher means any visitor is an
admin, which is why this app cannot go live as-is.

### 2. Authorisation, enforced server-side

`PERMS` in [`src/state/rbac.ts`](../src/state/rbac.ts) gates routes in the UI.
That is a navigation convenience, not a security boundary — the same table has
to be enforced on every endpoint.

The scoping rule the mock implements, and the server must:

| Role | May read |
|---|---|
| `admin` | every employee |
| `manager` | themselves plus their whole reporting sub-tree |
| `employee` | themselves only |

### 3. Field-level redaction

Compensation, bank details and national identifiers (PAN, UAN, SSN, SIN, NINO,
Emirates ID) are visible to HR administrators and the employee themselves — not
to a line manager. The UI hides them, but **the server must not send them** to a
caller who may not see them. Sending-and-hiding is a breach with extra steps.

---

## Conventions

- All responses JSON. Dates are `YYYY-MM-DD`; payroll periods are `YYYY-MM`
  (called `mk` throughout).
- A refused state transition returns **409** with `{ "error": "<message>" }`.
  The frontend surfaces that message directly to the user, so write it for a
  human.
- Unknown ids return **404**, except `GET /employees/{id}/profile`, which the
  client expects to resolve as `null`.
- Money is stored in the employee's own currency; INR is the reporting base.

---

## Employees

| Method | Path | Notes |
|---|---|---|
| GET | `/employees?scope=visible` | Scoped to the caller. The workhorse. |
| GET | `/employees?status=active` | |
| GET | `/employees?status=exited` | Leavers, for the directory toggle. |
| GET | `/employees?ids=a,b,c` | Bulk resolve. The client never fetches a directory one row at a time. |
| GET | `/employees/{id}` | |
| GET | `/employees/{id}/team?deep=true` | Direct reports, or the whole sub-tree. |
| GET | `/employees/{id}/profile` | **Composite** — see below. |
| PATCH | `/employees/{id}` | `{ role }`. Admin only. |

### The profile composite

`GET /employees/{id}/profile` returns one document rather than making the client
fan out across a dozen domains:

```
employee, managerName, reports[], salary, compMonthly {basic, allowance},
taxRegime, taxStatus, attendanceThisMonth[], leaveBalances[], assets[],
documents[], claims[], tickets[], coursesCompleted, praiseReceived,
goals[], loans[], lifecycle[], exit
```

Redaction applies here hardest — `salary`, `compMonthly` and the identifier
fields must be omitted for a manager viewing a report.

## Attendance

| Method | Path | Notes |
|---|---|---|
| GET | `/attendance?empIds=&from=&to=&regularisedOnly=` | |
| GET | `/attendance/{empId}/{date}` | |
| GET | `/attendance/{empId}/regularisable?since=` | Absent, missing a punch, or outside the fence. |
| POST | `/attendance/{empId}/{date}/punch-in` | Body: `PunchAt`. |
| POST | `/attendance/{empId}/{date}/punch-out` | Body: `PunchAt`. Server computes worked minutes. |
| POST | `/attendance/{empId}/{date}/regularisation` | `{ inT, outT, reason }`. |
| POST | `/attendance/{empId}/{date}/regularisation/decision` | `{ decision: "Approved" \| "Rejected" }`. |

**Server-side rules.** Punch-out computes minutes as out − in − 45 (unpaid
break); the client must not send a duration. An approved regularisation credits
a standard 495 minutes and marks the day present. A regularisation can be
decided **once** — a second decision is a 409.

`PunchAt` carries `{ lat, lng, site, geoOk, dist, src, wfh, at }`. The geo-fence
verdict is currently computed client-side; **a real deployment should recompute
it server-side** from the coordinates and the site fence, since it is the input
to a payroll-affecting flag.

## Leave

| Method | Path | Notes |
|---|---|---|
| GET | `/leave?empIds=&status=` | |
| GET | `/leave/balances/{empId}` | Each row carries `avail` computed. |
| GET | `/leave/balances?empIds=` | Batched, keyed by employee id. |
| POST | `/leave` | Body: `ApplyLeave`. Server sets approver from the reporting line. |
| POST | `/leave/{id}/approve` | **Debits the balance.** |
| POST | `/leave/{id}/reject` | `{ note? }` |
| POST | `/leave/{id}/cancel` | Credits the days back if it was approved. |

**Server-side rules.** Approval is the only thing that debits a balance, and it
must be idempotent-or-refused: a second approve is a 409. This is not
hypothetical — the pre-seam frontend had two copies of this logic and neither
guarded it, so one request could debit a balance twice.

## Timesheets

| Method | Path | Notes |
|---|---|---|
| GET | `/timesheets?empIds=&weekStart=&since=&status=` | |
| GET | `/timesheets/{empId}/week/{weekStart}` | Creates an empty draft if absent. |
| POST | `/timesheets/{id}/rows` | `{ proj, task }` |
| DELETE | `/timesheets/{id}/rows/{index}` | |
| PATCH | `/timesheets/{id}/rows/{index}` | `{ proj?, task? }` |
| PUT | `/timesheets/{id}/rows/{rowIndex}/hours/{dayIndex}` | `{ hours }` |
| POST | `/timesheets/{id}/submit` | 409 if the sheet is empty. |
| POST | `/timesheets/{id}/recall` | 409 unless currently submitted. |
| POST | `/timesheets/{id}/approve` | 409 if already approved. |
| POST | `/timesheets/{id}/reject` | `{ note }` |

**The weekly total is derived by the server** and returned on every mutating
response. The client renders it; it does not compute it.

## Expenses

| Method | Path | Notes |
|---|---|---|
| GET | `/claims?empIds=&status=` | |
| POST | `/claims` | Body: `NewClaim`. Server assigns the id and total. |
| POST | `/claims/{id}/approve` | 409 unless submitted. |
| POST | `/claims/{id}/reject` | `{ note }`. 409 unless submitted. |
| POST | `/claims/{id}/reimburse` | **409 unless approved.** Stamps the payroll month. |
| GET | `/advances?empIds=` | |
| POST | `/advances` | `{ empId, amount, reason }` |
| POST | `/advances/{id}/approve` | 409 if already approved. |

## Payroll

Everything here is **computed server-side**. A payroll engine belongs on the
server; the client renders its answer.

| Method | Path | Notes |
|---|---|---|
| GET | `/payroll/runs` | |
| GET | `/payroll/runs/current` | |
| GET | `/payroll/{mk}/totals` | Gross, deductions, statutory splits, per-country. |
| GET | `/payroll/totals?mks=a,b,c` | Batched for trend charts. |
| GET | `/payroll/{mk}/register` | Every person paid, with their payslip and loan EMI. |
| GET | `/payroll/{mk}/inputs` | Off-cycle bonus, arrears, incentive. |
| GET | `/payroll/{empId}/{mk}/payslip` | |
| GET | `/payroll/{empId}/payslips` | Every paid cycle since joining. |
| GET | `/payroll/{empId}/structure` | |
| GET | `/payroll/daily-rates?empIds=` | Drives leave-encashment liability. |
| GET | `/payroll/compensation` | Salary structures across the workforce. Admin only. |
| GET | `/payroll/declarations` | Tax regime and proof status. |
| GET | `/payroll/bank-batches` | |
| GET | `/payroll/compliance-payments` | |
| GET | `/loans?status=` | |
| POST | `/payroll/{mk}/process` | **409 if already paid.** |

**Invariant worth testing on both sides:** the sum of register gross must equal
the cycle's total gross, converted to base. `npm run check` asserts this against
the mock; the server should assert it too.

## Approval surfaces

| Method | Path | Notes |
|---|---|---|
| GET | `/overtime?empIds=&status=` | |
| POST | `/overtime/{id}/approve` | 409 if already approved. |
| POST | `/loans/{id}/approve` | Moves to Active. 409 otherwise. |
| GET | `/letter-requests?status=` | |
| POST | `/letter-requests/{id}/issue` | 409 if already issued. Stamps the date. |

## Hiring

| Method | Path |
|---|---|
| GET | `/hiring/interviews?panelId=&status=` |
| GET | `/hiring/candidates` |
| GET | `/hiring/requisitions` |

Interviews come back with the candidate and requisition title resolved — the
client does not join them.

## People operations

| Method | Path |
|---|---|
| GET | `/performance/goals?empIds=` |
| GET | `/performance/reviews?empIds=` |
| GET | `/performance/praise` |
| GET | `/performance/cycle/current` |
| GET | `/learning/courses` |
| GET | `/learning/enrolments?empIds=` |
| GET | `/helpdesk/tickets?empIds=` |
| GET | `/engagement/surveys` |
| GET | `/engagement/enps-history` |
| GET | `/engagement/surveys/{id}/enps` |
| GET | `/benefits/fbp-totals?empIds=` |
| GET | `/announcements` |
| GET | `/celebrations?days=` |
| GET | `/exits` |

---

## Not in this contract

Static configuration — departments, sites, grades, leave types, currencies,
expense categories, rating scales, the nine-box grid — stays a synchronous
import in the client ([`src/data/org.ts`](../src/data/org.ts) and friends). It
is fetched-once config in any real deployment.

If the server wants to own it, add a single `GET /config` returning the lot and
hydrate it at boot. Do **not** make each lookup a round trip: that would poison
every component for nothing.

## Still client-side, and shouldn't stay that way

Two things the mock computes in the browser that a real deployment should move:

1. **The geo-fence verdict.** Currently `evalFence` in the attendance module. It
   decides whether a punch is flagged, which affects payroll.
2. **The staffing match score** ([`src/data/matching.ts`](../src/data/matching.ts)).
   Deterministic and explainable, so it ports cleanly — but it reads pay rates
   and cost bases, which is not data every caller should hold.
