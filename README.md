# 360 People Hub

HR, workforce and staffing platform for 360VHM Technology — React + TypeScript,
ported from the `360_HRMS` HTML prototype kept in [reference/](reference/).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build
npm run lint
```

Sign in as **Admin**, **Manager** or **Employee** using the switcher in the
top bar; every module changes what it shows based on the active role.

## Architecture

| Path | What lives there |
|---|---|
| `src/lib/` | Pure helpers — deterministic RNG, dates, money formatting, CSV export |
| `src/types/` | Domain models shared across modules |
| `src/data/` | The dataset and the business logic over it |
| `src/services/` | The API seam — contracts, the in-memory implementation, query hooks |
| `src/state/` | Session (role, theme), RBAC scoping, pending-approval counts |
| `src/components/` | UI primitives, charts, modal/drawer layer, tooltips |
| `src/shell/` | Sidebar, topbar, mobile tab bar |
| `src/modules/` | One folder per route |

### The service seam

Screens are not supposed to know where their data comes from. `src/services`
is where that promise is kept:

- `contracts.ts` — the interfaces. Everything touching *records* is async,
  because a network round trip cannot be retrofitted onto a synchronous call
  site. Derived figures a server would compute (balances, payslips, totals)
  are service calls too, so the business logic does not stay welded to the
  client.
- `mock/` — the implementation over `src/data`. It resolves immediately, but
  through a promise, so every call site is already written for latency.
- `index.ts` — the swap point. `setServices()` takes an HTTP implementation
  or a test double; no screen changes.
- `react.tsx` — `useQuery` / `useMutation`. Small on purpose: what they get
  right is out-of-order responses, responses after unmount, and refetching
  after a mutation so no screen hand-rolls cache updates.

Static configuration — departments, sites, grades, leave types, currencies —
stays a synchronous import from `src/data/org`. It is config, fetched once and
cached in any real deployment, and making it async would poison every
component for nothing.

`npm run check` exercises the seam end to end: role scoping, apply → approve
→ balance debit, cancellation crediting the days back, and refusal of a
double approval.

**Migration status.** On the seam: `leave`, `attendance`, `timesheet`,
`expenses`, `employees`, `payroll`, `approvals`, `reports`, `dashboard`, `people`,
`copilot`, `exec`, the staffing book, `documents`, `exit`, `security`, `assets`. Each has a `data.ts` holding its reads and writes as service
calls; `src/modules/leave/data.ts` is the reference to copy, including the
two-stage fetch (rows, then the people they reference) that a real client
needs when the API does not denormalise names into the row.

The remaining modules still import `src/data` directly. `AppProvider`
subscribes to service invalidations and re-renders them, which is the bridge
that keeps them correct until they are moved. Rough order of remaining work,
`settings`, then the smaller screens — `shifts`, `benefits`, `tax`,
`performance`, `onboarding`, `learning`, `hiring`, `helpdesk`, `engagement`,
`whatsapp`. Most of their services already exist, so the remaining work is
wiring rather than contract design.

**One constraint worth knowing before the next pass.** The module registry's
`subtitle` and `badge` callbacks are synchronous, so they cannot await a
service — several still read the dataset directly for that reason. Feeding
them from a single counts endpoint would fix that *and* unblock route-level
code splitting, which is currently blocked on the sidebar needing every
module registered before first paint.

Three shapes are worth copying. The employee profile is a single composite
(`EmployeeProfile`) rather than fourteen calls across as many domains,
because that is what a real `GET /employees/{id}/profile` returns. Payroll
computes payslips, cycle totals, the register and salary structures in the
service, because a payroll engine runs on the server and the screen should be
rendering its answer rather than deriving one of its own. And `approvals`
calls the *same* service methods the owning modules do, which is what
collapsed four hand-copied approve/reject implementations into one each —
the queue used to carry its own copy of the leave balance debit.

Each migration follows the same four steps: ground a contract in what the
module actually does, implement it in `services/mock`, add a module
`data.ts`, then replace the direct imports. Contracts are only added for
surfaces a screen actually exercises — an ungrounded interface is worse than
none.

### Building the backend

[docs/api-contract.md](docs/api-contract.md) expresses `services/contracts.ts` as
HTTP endpoints, with the rules the server has to own — scoping, field-level
redaction, and every state transition that must be refused rather than
repeated. Implementing it means writing one class that satisfies `Services`
and calling `setServices()`.

### The data layer

`src/data` generates the whole demo dataset — 139 employees across five legal
entities, 20,942 attendance records, payroll for eight cycles, an ATS pipeline,
and a full IT-staffing book of clients, placements and receivables.

Every generator draws from **one shared `mulberry32` stream seeded at 360360**
(`src/lib/rng.ts`), which is what makes the dataset byte-stable across reloads.
That makes module evaluation order load-bearing: each data module
side-effect-imports its predecessor to pin the order, and `src/data/index.ts`
pulls in the last one to evaluate the whole chain. **Reordering those imports
reshuffles the entire dataset.**

Two generators (off-cycle pay inputs and loan recovery) must run *after*
payroll but are read *by* it, so they install themselves through hooks
(`setPayInputHook`, `setLoanEmiHook`) rather than being imported.

The port was verified collection by collection against the prototype — same
names, dates, identifiers and totals throughout.

### Adding a module

Create `src/modules/<name>/index.tsx`, call `registerModule({ key, title,
subtitle?, badge?, Component })`, and add the import to `src/modules/index.ts`.
The sidebar, topbar and router all read from that registry. Routes without a
registered module fall back to a placeholder.

### Charts

`src/components/charts.tsx` provides bar (grouped/stacked), line/area,
horizontal bar, donut, sparkline and ring, over the `--s1`…`--s8` categorical
tokens. That palette is validated in both themes for lightness band, chroma,
colour-vision separation and contrast; three light-mode hues sit under 3:1
against the surface, which the legends, direct value labels and data tables
alongside every chart relieve. Assign hues in fixed order — never cycle them.

## Status

All 35 modules are ported and render for every role: the core HR suite
(dashboard, attendance and geo-fencing, shifts, timesheet, leave, expenses,
approvals), people (directory, org chart, celebrations, announcements,
engagement, IT assets, WhatsApp, helpdesk), money (payroll, tax, benefits),
talent (performance, learning, hiring, onboarding, exit), the staffing book
(clients, requirements, bench, placements, billing, vendors), the AI layer
(copilot and the executive view), and the admin surfaces (reports, documents,
security, settings).

`scratch/routecheck.tsx` walks every route for every role and reports what is
registered; `npx tsc --noEmit -p tsconfig.app.json` typechecks the app.
