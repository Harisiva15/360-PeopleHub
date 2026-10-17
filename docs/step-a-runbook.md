# Step A cutover runbook — expand

The migration that lets the database accept both role vocabularies, and the
deploy of the code that speaks the new one. Nothing here changes a single row of
data; that is step B.

**Run this yourself, from your own machine.** Render holds no migration
credential by design, so there is no "deploy and it migrates" path and there is
not meant to be one.

Read it through once before starting. Roughly 25 minutes end to end, of which
about four are the deploys and five the smoke test.

---

## Before you start

### 0.1 — Complete the migration credential

`server/.env.migrate` holds `MIGRATE_DATABASE_URL`, and **the value currently in
it is truncated**: it ends at the password, with no `@host:port/database`. It
cannot connect, and `migrate.mjs` will refuse it as unparseable.

Get the session-pooler connection string from Supabase → Project Settings →
Database → Connection string → **Session pooler**, and replace the whole line.
Paste the line entire rather than pasting a password into the existing one — a
selection that runs a few characters too far takes the host with it, and the
result still looks like a URL.

Check it without printing it:

```
cd server
node -e "import('./scripts/local-only.mjs').then(m=>console.log(m.hostOf(process.env.MIGRATE_DATABASE_URL)))"
```

That should print a `…pooler.supabase.com` host. `null` means it is still
malformed. It prints the host and nothing else — do not reach for `new URL`,
which throws on a malformed string and quotes the password back at you.

`server/.env.migrate` is git-ignored and nothing loads it automatically. Only
`migrate.mjs --production` reads it.

### 0.2 — Confirm what is going out

```
git log origin/main..HEAD --oneline
git diff --stat origin/main...HEAD | tail -1
```

Expect the role-cutover commits and roughly 200 changed files. If anything
unrelated appears, stop and sort that out first.

### 0.3 — Everything green, locally

With the local cluster up and the local database variables exported:

```
cd server && npm run check          # includes check:localonly first
cd ..     && npm run check:chain    # 54 suites
npx tsc -b
```

All 36 suites should pass. `check:localonly` runs first on purpose: every
database-backed suite writes, and it refuses to run against anything but
localhost.

---

## 1 — Take a backup

Not optional, and not "there is point-in-time recovery". Take one you can see.

Supabase → Database → Backups → **Create backup**, and wait for it to report
complete. Note the timestamp here: ____________________

On a plan without on-demand backups, take a dump instead:

```
cd server
pg_dump --no-owner --no-privileges --schema=public "$MIGRATE_DATABASE_URL" \
  > ../backup-pre-0056-$(date +%Y%m%d-%H%M).sql
```

Check the file is a plausible size and ends with `-- PostgreSQL database dump
complete`. A dump that failed halfway is worse than no dump, because it looks
like one.

---

## 2 — Record the state you are changing

So that step 4 can be compared against something rather than eyeballed.

```
cd server
node -e "
const pg=require('pg');const c=new pg.Client({connectionString:process.env.MIGRATE_DATABASE_URL,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query(\`
  SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
   WHERE conname IN ('tenant_membership_role_check','role_permission_role_check',
                     'employee_app_role_check','joining_request_requested_role_check')
   ORDER BY tbl\`)).then(r=>{console.table(r.rows);return c.end()});
"
```

Four constraints, each naming `admin`, `manager`, `employee` only. Also record
who holds what, which is the before half of step B's evidence:

```
node -e "
const pg=require('pg');const c=new pg.Client({connectionString:process.env.MIGRATE_DATABASE_URL,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query(\`
  SELECT e.code, e.full_name, e.app_role, m.role AS membership_role, m.status
    FROM tenant_membership m JOIN employee e ON e.id = m.employee_id
   ORDER BY e.code\`)).then(r=>{console.table(r.rows);return c.end()});
"
```

Expect three people: Hari and hr@ as `admin`, Lakshmi as `employee`.

---

## 3 — Run the migration

```
cd server
node scripts/migrate.mjs --production
```

It prints the target host and asks you to type that host back. Read it before
you type: if it does not say the Supabase pooler host you expect, something is
pointing somewhere else and the answer is to stop.

Applying `0056_role_vocabulary_expand.sql` — 7,276 bytes, sha256
`4cd3d851ab02a6141f911b5375b40bd032d5e62b68984519bb2c55be8987ddfb`. It runs in
one transaction and widens four CHECK constraints to accept all six values. No
row is read or written.

**Why this is safe to run before the deploy, and only in this order.** Widening
a constraint cannot invalidate data that already satisfies the narrower one, so
the live code keeps working untouched — it writes `admin`, and `admin` is still
accepted. The reverse order is not safe: deploying first would give you a server
writing `company_admin` into a column that still refuses it, and every attempt
to create a user or change a role would fail until the migration landed.

---

## 4 — Verify the widening

Re-run the constraint query from step 2. All four definitions should now name
all six values. Then confirm nothing moved:

```
node -e "
const pg=require('pg');const c=new pg.Client({connectionString:process.env.MIGRATE_DATABASE_URL,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query(\`
  SELECT role, count(*)::int n FROM tenant_membership GROUP BY role ORDER BY role\`))
  .then(r=>{console.table(r.rows);return c.end()});
"
```

Still two `admin` and one `employee`. If any row now reads `company_admin`,
something other than 0056 has run and you should stop and work out what.

**Production is now in a valid resting state.** The constraints accept both
vocabularies and the live code still writes the old one. If you stop here and
go no further today, nothing is broken and nothing is half-done.

---

## 5 — Deploy

```
git checkout main
git merge --ff-only feature/roles
git push origin main
```

One push moves both halves:

| | what watches it | roughly |
|---|---|---|
| Frontend | GitHub Actions → Pages (`pages.yml`, every push to main) | 2–3 min |
| Server | Render, watching main itself | 3–4 min |
| CI | GitHub Actions → `server.yml` (checks only, deploys nothing) | 4–6 min |

**Wait for both to finish before testing anything.** They complete at different
times and cannot be ordered from the repository, so for a minute or two one half
is newer than the other. Both directions are survivable:

- *New frontend, old server* — the frontend takes its scopes from the grant the
  server computed, never from the role name, so access is unaffected. The role
  value is used for a couple of display labels, and an unrecognised one is now
  read as `employee` for that purpose rather than crashing the screen. (It did
  crash it until this branch; see `AppContext.tsx` where the role is set.)
- *Old frontend, new server* — a browser still holding the old bundle gets
  `company_admin` from `/me/permissions`, which that bundle has no entry for. A
  reload picks up the new bundle and the problem goes with it.

So: wait for both, then hard-refresh. With three users, that is a sentence in a
message rather than a migration plan.

Confirm the frontend actually changed, rather than trusting the green tick:

```
curl -s https://360peoplehub.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

The hash should differ from before the push.

---

## 6 — The five-minute smoke test

In order. Stop at the first failure and go to §7.

### Hari — company_admin

- [ ] Sign in at https://360peoplehub.com/
- [ ] The full menu appears, Settings included
- [ ] Open **Settings → Access**: the four roles are listed, `manager` is not
      among them
- [ ] Open somebody else's payslip (People → a person → Payroll). It shows
      figures
- [ ] Open **People → directory**: salary figures are visible

### hr@ — company_admin

- [ ] Sign in, in a different browser or a private window
- [ ] The full menu appears
- [ ] Open somebody else's payslip. It shows figures

### Lakshmi — employee, the one that matters

- [ ] Sign in, in a third window
- [ ] The menu is her own record and what the company shares. **No Settings, no
      Payroll section for other people**
- [ ] Her own payslip opens and shows her figures
- [ ] **Somebody else's payslip is refused.** Take her employee id from the URL
      of her own payslip, substitute Hari's, and reload. Expect a refusal, not
      a page with somebody else's numbers
- [ ] Open **People**: she sees her own record, and no salary for anyone else

The last two are the point of the exercise. Everything else confirms nobody was
locked out; those two confirm nobody was let in.

### Then, from your own machine

- [ ] Change a role and change it back: Settings → Users → Lakshmi → set
      `hr_admin`, save, set `employee`, save. This is the first write in the new
      vocabulary, and the one most likely to find a constraint you missed
- [ ] Try to set your own role to `employee`. Expect "You cannot remove your own
      administrator role"

---

## 7 — If something is wrong

### The migration failed

It runs in one transaction, so it either applied or it did not. Re-run the
constraint query from step 2: if the definitions still name three values, the
migration did not land and production is exactly as it was. Nothing to undo.

### The deploy is wrong but the migration is fine

Revert the code and leave the database alone. The widened constraints are
harmless to the old code — that is the property the whole expand step is built
on.

```
git revert --no-commit <merge-sha>..HEAD
git commit -m "Revert the role cutover deploy"
git push origin main
```

Or, faster, if main was a fast-forward and nothing else has landed since:

```
git reset --hard <sha-of-main-before-the-merge>
git push --force-with-lease origin main
```

**Ask before running either of the two commands above** — a force push to main
is exactly the kind of thing this project's rules say to confirm first.

### Somebody is locked out

Most likely a stale bundle. Hard-refresh, then sign out and in. If an
administrator genuinely cannot reach Settings, check what their membership
holds — `admin` is still valid and still works, and the normaliser maps it to
`company_admin` at the one entry point.

### Rolling the database back

You should not need to: step A writes no data. If you must, narrowing the
constraints again requires that no row holds a new value, so check first:

```
SELECT role, count(*) FROM tenant_membership GROUP BY role;
```

If a `company_admin` row exists, a write has already happened in the new
vocabulary and narrowing would refuse it. That is when the backup earns its
keep.

---

## What step A deliberately does not do

- **No data is converted.** Hari and hr@ still read `admin` in the database.
  That is step B, with its own dry-run and its own approval.
- **`admin` still works.** The normaliser accepts it, so the assertion that an
  old role value gets a 403 is not true yet at the HTTP level. It becomes true
  at step C, when the constraints narrow and the normaliser goes.
- **The `role_permission` rows are untouched.** They keep `manager` through
  step C.

## After step A has settled

Leave it a day or two under real use before step B. Things worth watching:

- Can an administrator create a user? That path was broken on the branch until
  `validate` was fixed — `company_admin` was refused as "Not a role" — and it is
  the single most likely thing to have been missed elsewhere.
- Does anybody appear with an empty menu? That is the fail-closed path, and it
  means a role value nobody recognises reached the policy.
- `docs/roles-migration.md` holds the plan, every decision, and the known issue
  on main that this branch fixes.
