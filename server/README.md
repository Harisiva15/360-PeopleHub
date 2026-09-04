# 360 People Hub — server

The multi-tenant backend for [`docs/api-contract.md`](../docs/api-contract.md).
A schema, the tenancy enforcement, and two vertical slices showing the pattern
the remaining modules follow.

**Status: skeleton.** The schema is complete and checked; the API has five
endpoints wired of the 112 in the contract. Nothing here has been run against a
live PostgreSQL — see [What is verified](#what-is-verified) before you trust it.

```bash
cd server
npm install
npm run check          # schema checks, checker self-test, typecheck
```

---

## The tenancy model

**One database, one schema, a `tenant_id` on every business table, and
PostgreSQL row-level security enforcing it.**

The application never writes `WHERE tenant_id = $1`. It sets the tenant for the
transaction and the database refuses to return anything else:

```sql
CREATE POLICY tenant_isolation ON employee
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
```

### Why not a schema or a database per tenant

There are 112 tables. Per-tenant schemas multiply that by the tenant count, so
every migration becomes a loop that can half-fail and leave customers on
different versions of the schema. Connection pooling turns into `search_path`
juggling on every checkout, which is a correctness problem rather than a
performance one — get it wrong and a request reads someone else's data with no
error anywhere.

Shared tables with RLS keep one copy of the schema, one migration path, and
make isolation something the database enforces rather than something the
application has to remember.

### What that costs, stated plainly

- A noisy tenant shares your buffer cache and your autovacuum.
- Per-tenant restore means filtering rows out of a backup, not restoring a
  database. That is materially harder, and worth building before you need it.
- One bad migration touches every customer at once.
- The largest tables (`attendance`, `roster_entry`) grow with the *sum* of all
  tenants, so partitioning arrives sooner than it would otherwise.

A customer who needs physical separation gets their own deployment. This schema
does not change to accommodate that — it is the same schema with one tenant in
it, which is precisely why the model is worth the costs above.

---

## The four things that make it hold

### 1. The application role cannot bypass RLS

Migrations run as the owner. The API connects as `app_rw`, created
`NOBYPASSRLS`. A policy the connecting role can switch off is decoration.

Tables are also set `FORCE ROW LEVEL SECURITY`, because a table's owner bypasses
its policies by default — so a migration, a console session or a misconfigured
pool connecting as the owner would otherwise see every tenant at once.

### 2. The tenant is set per transaction, never per connection

[`src/tenancy/context.ts`](src/tenancy/context.ts) is the only place
`app.tenant_id` is set, and it uses `set_config(..., is_local => true)` — `SET
LOCAL`. The setting is discarded on `COMMIT` or `ROLLBACK`, so a pooled
connection cannot carry one request's tenant into the next request that borrows
it. That leak is the classic failure of this architecture and it is invisible
when it happens.

`current_tenant_id()` **raises** when the setting is absent rather than
returning null. An unset tenant is a bug, and a bug that returns no rows is one
you find; a bug that returns everyone's rows is one you find later.

### 3. Foreign keys carry the tenant

This is the subtle one. A plain reference:

```sql
employee_id uuid REFERENCES employee (id)     -- wrong
```

is satisfied by **any** tenant's employee. RLS filters what you can *read*; it
does not stop you writing a row that points across the boundary. So every
reference between tenant-scoped tables is composite:

```sql
FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
```

which makes a cross-tenant reference unrepresentable rather than merely
prohibited. Every scoped table carries `UNIQUE (tenant_id, id)` so it can be the
target of one.

### 4. A new table cannot quietly miss the policy

The policy is applied by a loop over `pg_class` in
[`0010_row_level_security.sql`](db/migrations/0010_row_level_security.sql),
not written out 105 times. A hand-maintained list is exactly the thing that
acquires a gap when someone adds a table in a hurry, and a gap here is a
cross-tenant read.

Two backstops:

- `npm run check:schema` parses every migration and fails the build if a new
  table is neither tenant-scoped nor explicitly listed as global.
- `SELECT * FROM tenancy_gaps()` checks the *live* database and should always
  return zero rows. The server calls it at boot and refuses to start otherwise.

---

## The three kinds of table

| Kind | Policy | Why |
|---|---|---|
| **Tenant-scoped** (105) | `tenant_isolation` | Everything a customer owns. |
| **Platform** (1) — `tenant_membership` | Its own | Read to *discover* which tenant a session belongs to, so the isolation policy would be circular. It is not unprotected: a user sees their own memberships and no one else's. |
| **Global** (4) — `tenant`, `country`, `currency`, `fx_rate` | None | Facts about the world, or about the platform rather than a customer. |

Identity itself lives in Supabase's `auth.users`. There is no `app_user` table:
duplicating the identity Supabase already owns would give two answers to "who
is this".

The lists live in two places that must agree —
[`check-schema.mjs`](scripts/check-schema.mjs) and `is_platform_table()` in
migration 0010. That duplication is deliberate: the checker must not read its
rules from the thing it is checking.

---

## Layout

```
db/migrations/
  0001_tenancy.sql                    tenants, logins, sessions, reference data
  0002_org_config.sql                 per-tenant config: departments, grades, leave types
  0003_people.sql                     employees, effective-dated terms, identifiers
  0004_time_and_absence.sql           attendance, rosters, overtime, timesheets, leave
  0005_pay_and_money.sql              salary, payroll, tax, expenses, loans, benefits
  0006_talent.sql                     hiring, onboarding, performance, learning
  0007_workplace.sql                  helpdesk, engagement, documents, assets, exits
  0008_staffing.sql                   clients, demand, bench, placements, billing
  0009_security_and_notifications.sql audit, retention, consent, outbound messages
  0010_row_level_security.sql         the policies, and the gap detector

scripts/
  check-schema.mjs                    parse + assert the tenancy invariants
  check-schema.test.mjs               proves the checker rejects what it should
  migrate.mjs                         ordered, checksummed, transactional

src/
  tenancy/context.ts                  withTenant — the only place the tenant is set
  auth/session.ts                     opaque tokens; the only place a Caller is built
  db/pool.ts                          pool, not exported for direct use
  modules/employees/service.ts        reference slice: scoped reads, field redaction
  modules/leave/service.ts            reference slice: a guarded state transition
  http/app.ts                         routing placeholder; the shape is the point
```

---

## Decisions worth knowing about

**Employment terms are effective-dated.** `employee` holds current pointers for
the directory screens; `employment_record` holds one row per change. Payroll has
to answer "what was their grade in August", and a system that only stores the
present cannot.

**Payslips are stored documents, not queries.** Once a run is locked its lines
never move, so changing a salary component next year does not silently rewrite
last year's payslip.

**Regulated identifiers live in their own table.** `employee_identifier` and
`employee_bank_account` keep PAN, national insurance numbers and account numbers
out of `employee`. The value column is `bytea`, so you cannot accidentally write
plaintext into it and have it look right, and a `value_hint` holds the last four
characters in clear for `****1234` display. A redacting read simply does not
join them — the contract's rule is *redact, do not send and hide*.

**Money is `numeric`, and `pg` is configured to return it as a string.** A
payroll total in a JavaScript double is how a figure ends up a cent out and
nobody can explain why. Dates likewise come back as `YYYY-MM-DD` strings, because
a `Date` is a timestamp and turning a joining date into one shifts it across a
timezone boundary.

**Guards live in three layers where they matter.** Approving leave debits the
balance under `SELECT ... FOR UPDATE`, in one transaction, against a partial
unique index that makes a second debit impossible. The mock could not race; a
real API does, and "check then write" without a lock is where double-debits come
from.

**The JWT is trusted for identity and nothing else.** Supabase signs it, so
`sub` is reliable — but the tenant and the role are read from
`tenant_membership` on every request. A JWT is a cached copy of a decision, and
a manager demoted an hour ago still holds a token that says "manager". The
lookup is one indexed read inside a transaction that was opening anyway, and it
means revocation takes effect on the next request rather than at expiry. The
token's `tenant_id` claim only chooses *which* membership when someone belongs
to several; it can never widen access beyond what the table says.

**`app_metadata`, never `user_metadata`.** The tenant claim goes in
`app_metadata`, which only the service role can write. `user_metadata` is
editable by the user themselves — a tenant id kept there could be edited into
somebody else's.

---

## What is verified

There is no PostgreSQL, Docker or `psql` on the machine this was written on, so
**none of this has been executed against a real database.** What that means for
each claim:

| Claim | How far it is checked |
|---|---|
| The SQL is syntactically valid | **Verified.** Parsed with `libpg-query` — PostgreSQL's own grammar compiled to WASM, not an approximation. |
| Every table is tenant-scoped or deliberately not | **Verified** by `check:schema`. |
| No foreign key can point across tenants | **Verified** by `check:schema`. |
| The checker actually catches these | **Verified** by `check:schema:test` — nine deliberately broken schemas, each rejected for the right reason. |
| The TypeScript compiles | **Verified** by `tsc --noEmit`, strict. |
| The policies behave correctly at runtime | **Not verified.** Needs a live database. |
| The migrations apply cleanly in order | **Not verified.** Parsing is not execution: it cannot catch a type mismatch, a function that does not exist, or an index on a column added later in the same file. |
| The queries return what they claim | **Not verified.** |

**The first thing to do with a database available** is run `npm run migrate`,
then `SELECT * FROM tenancy_gaps()`, then this — the test that matters most:

```sql
-- Two tenants, one table. Set tenant A, count rows. You must see only A's.
SET LOCAL app.tenant_id = '<tenant-a>';
SELECT count(*) FROM employee;          -- A's employees
SET LOCAL app.tenant_id = '<tenant-b>';
SELECT count(*) FROM employee;          -- B's, and no overlap

-- And the one people forget: WITH CHECK on insert.
SET LOCAL app.tenant_id = '<tenant-a>';
INSERT INTO employee (tenant_id, ...) VALUES ('<tenant-b>', ...);  -- must fail
```

Until that has run, treat the isolation as designed rather than proven.

---

## Wiring the frontend to it

The frontend already has the seam. Implement the `Services` interface against
these endpoints and call `setServices()` in
[`src/services/index.ts`](../src/services/index.ts). No screen changes — that
was the point of the seam.

The contract's three preconditions still apply and are what this server exists
to satisfy: derive the caller from the session token and ignore anything the
client sends; enforce role scope server-side; and redact compensation and
national identifiers rather than sending them and hiding them.
