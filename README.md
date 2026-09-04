# 360 People Hub

HR, workforce and staffing platform for 360 Technology — React + TypeScript,
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
| `src/state/` | Session (role, theme), RBAC scoping, pending-approval counts |
| `src/components/` | UI primitives, charts, modal/drawer layer, tooltips |
| `src/shell/` | Sidebar, topbar, mobile tab bar |
| `src/modules/` | One folder per route |

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
