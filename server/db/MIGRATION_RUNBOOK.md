# Applying 0031–0037

Seven migrations are written, parse against the real PostgreSQL grammar and
pass the schema invariant checks. **None has been applied to any database.**

This is the order to apply them in and what to verify at each step. It is
written to be followed by a person, not run as a script, because two of the
steps are decisions.

---

## 0. Before anything: the credential

The database password has been exposed since **8 September** and, as far as
this repository can tell, has not been rotated.

**Do not apply these migrations with the exposed credential.** A migration
applied with a credential somebody else may hold is a migration you cannot
later prove was yours. Rotate it in Supabase → Project Settings → Database,
then update `server/.env` (gitignored) and re-run `npm run connect` if you use
that helper.

Nothing below should be run until that is done.

To confirm which database you are about to touch without printing a
credential:

```
cd server
node -e "const u=new URL(process.env.MIGRATE_DATABASE_URL);console.log(u.hostname+u.pathname)"
```

That prints the host and database name and nothing else.

---

## 1. Take a backup

Supabase keeps point-in-time recovery on paid plans; confirm the window covers
the next hour. On a free plan, take a manual dump first:

```
pg_dump --no-owner --no-privileges --schema=public "$MIGRATE_DATABASE_URL" > backup-pre-0031.sql
```

`0032` alters `employee` and backfills it. Everything else only adds. `0032` is
the one that needs the backup.

---

## 2. Forecast the 0032 backfill — *before* migrating

```
cd server
node scripts/verify-backfill.mjs
```

Run against the real database this reports, before 0032 has been applied:

- total employees, and how many have a designation at all
- how many distinct designations exist exactly, and after folding case and
  whitespace — the second number is how many catalogue rows 0032 will create
- every designation written more than one way, listed in full

**Read the variants list.** 0032 folds on `lower(name)`, so
`Senior Software Engineer` and `Sr. Software Engineer` stay *separate* (they
are different strings, not different cases) while `Senior Engineer` and
`senior engineer` collapse into one. If the list contains genuine synonyms that
should be one job, fix the `designation` values first — it is far easier than
merging catalogue rows afterwards.

This step is a decision, not a check. Do not skip it.

---

## 3. Apply, on a staging copy first

Restore the backup into a scratch database, point `MIGRATE_DATABASE_URL` at it,
and:

```
npm run migrate
```

The runner applies each file once, in name order, inside a transaction, and
records what it applied in `schema_migration`. It runs as the *owning* role,
not `app_rw`, because it creates policies `app_rw` must not be able to drop.

Then, against staging:

```
npm run check:schema        # the invariants, as text
node scripts/verify-backfill.mjs    # what the backfill actually did
node scripts/verify-isolation.mjs   # tenant isolation, against a real database
```

`verify-isolation.mjs` is the one that matters most here. It creates two
throwaway tenants and proves PostgreSQL genuinely refuses to hand one tenant's
rows to the other — including, since 0031, that tenant B cannot read tenant A's
export records through the `export_run` view, and that the view's
`security_invoker` setting is honoured rather than merely written down.

---

## 4. Read the backfill report properly

After migrating, `verify-backfill.mjs` reports:

```
Successfully mapped:     <n>
Unmatched:               <n>
Ambiguous:               <n>
Mapped to a different title: <n>      <- must be 0
Duplicate codes:             <n>      <- must be 0
```

**`Mapped to a different title` must be zero.** It compares every employee's
`designation` text against the `job_title.name` they now point at. Anything
above zero means somebody is counted under the wrong job and headcount-by-title
is not trustworthy; the script exits non-zero and names the rows.

`Unmatched` is not a failure. Those people keep their `designation` text and
have a null `job_title_id` — they still have a job, it is simply not in the
catalogue yet. Add catalogue entries for them, or correct the text.

---

## 5. Production

Only after steps 0–4 have all succeeded on staging.

```
cd server
node -e "const u=new URL(process.env.MIGRATE_DATABASE_URL);console.log('target: '+u.hostname+u.pathname)"
npm run migrate
```

Then, against production:

```
npm run check:schema
node scripts/verify-backfill.mjs
node scripts/verify-isolation.mjs
```

Confirm all seven are recorded:

```
psql "$MIGRATE_DATABASE_URL" -c "SELECT filename, applied_at FROM schema_migration WHERE filename >= '0031' ORDER BY filename"
```

Expected: `0031_export_register`, `0032_job_title`, `0033_lifecycle_task`,
`0034_software_estate`, `0035_development_plan`, `0036_company_event`,
`0037_reports_and_integrations`.

---

## 6. What to look at afterwards

- **Table count** — 129 by the parser's count. Treat a difference as something
  to explain, not as a failure: legitimate changes move it.
- **`job_title`** — row count should match the folded-designation count from
  step 2.
- **`employee.job_title_id`** — null count should match `Unmatched`.
- **The `export_run` view** — `\d+ export_run` must show
  `security_invoker=true`. Without it the view reads every tenant.
- **New tables' RLS** — every one of `job_title`, `lifecycle_task`,
  `software_product`, `software_seat`, `development_plan`,
  `development_action`, `company_event`, `event_rsvp`, `saved_report`,
  `webhook_endpoint`, `api_key` should appear in:

```
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class WHERE relname IN (...) ;
```

Both flags true. `apply_tenant_isolation()` sets them; if one is false that
table is outside the policy.

---

## Rolling back

There is no down-migration, deliberately: a down-migration that drops a table
is a loaded gun in a repository, and these are additive.

`0031`–`0037` add tables, a view, indexes and constraints. Undoing them is
`DROP TABLE` / `DROP VIEW` on exactly what each file created, which is listed
at the top of each file.

**`0032` is the exception.** It adds a column to `employee` and writes to it.
Undoing it means dropping `employee.job_title_id` and the `job_title` table —
the `designation` text it was built from is untouched and still correct, so
nothing is lost. That is why 0032 leaves the text column in place.
