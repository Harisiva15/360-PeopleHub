# Step A cutover runbook — expand

The migration that lets the database accept both role vocabularies, and the
deploy of the code that speaks the new one. **No row of data changes**; that is
step B.

Run it yourself, from your own machine. Render holds no migration credential by
design, so there is no "deploy and it migrates" path and there is not meant to
be one.

About 30 minutes end to end: four for the deploys, five for the smoke test, the
rest for the backup and the checks either side.

---

## 0 — Before you start

### 0.1 — The migration credential (STILL BLOCKED as of 2026-10-17)

`server/.env.migrate` is structurally correct and the host is reachable, but it
**does not authenticate**. The password has been changed once since the first
attempt and the new one is rejected as well.

| check | result |
|---|---|
| parses | yes |
| shape | `postgresql://postgres:<42>@db.<ref>.supabase.co:5432/postgres` — one `@`, no quotes, no CR |
| port | **5432** |
| database | `postgres` |
| host | the **direct** host, not the session pooler |
| DNS | IPv6 only, no A record. This machine has global IPv6 and working egress, so it resolves |
| TLS handshake | succeeds |
| **authentication** | **fails — `28P01 password authentication failed for user "postgres"`** |

What has been ruled out, so the search can go elsewhere:

- **Not an encoding problem.** 42 characters, letters and digits only, no
  URL-reserved characters, no percent-escapes, no stray quotes, no whitespace
  inside it.
- **Not a trailing-whitespace problem.** The line has one trailing space;
  `process.loadEnvFile` strips it, and so does every check here.
- **Not an API key pasted by mistake.** It matches none of the Supabase shapes —
  `sb_secret_`, `sb_publishable_`, a legacy `eyJ…` JWT, or `sbp_`.
- **Not a copy of anything in `server/.env`.** It matches no value in that file.
- **The value did change.** Fingerprints: the first attempt was 16 characters
  (`sha256:2b06ad28`), this one is 42 (`sha256:1826a219`).
- **The username is right for this host.** `postgres`, which is what a direct
  connection wants. The pooler would want `postgres.<ref>` instead.

So the string is fine and the password itself is being refused. Two things left
to check, in order:

1. **Is this the database password?** Supabase → Project Settings → Database →
   *Database password* → Reset. It is not any of the API keys and not the JWT
   secret. Copy the whole connection string from *Connection string → Session
   pooler* and replace the entire `MIGRATE_DATABASE_URL=` line with it.
2. **Does this project still accept direct connections for `postgres`?** Some
   projects route the `postgres` role through the pooler only. Switching to the
   session pooler tests both at once, and is what `server/.env.example` already
   recommends.

**A note on retrying.** Each attempt is a failed authentication against
production, which can trip rate limiting or an alert. Change the value, then
test once:

```
cd server
node -e "
const pg=require('pg');const fs=require('fs');
const u=fs.readFileSync('.env.migrate','utf8').split('\n').find(l=>l.startsWith('MIGRATE_DATABASE_URL=')).slice(21).trim();
const c=new pg.Client({connectionString:u,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query('SELECT current_user, current_database()'))
 .then(r=>{console.log(r.rows[0]);return c.end()})
 .catch(e=>{console.error(e.code, e.message);process.exit(1)});
"
```

Expect `{ current_user: 'postgres', current_database: 'postgres' }`. And the host
on its own, which prints nothing else:

```
node -e "import('./scripts/local-only.mjs').then(m=>console.log(m.hostOf(process.env.MIGRATE_DATABASE_URL)))"
```

**Direct host or pooler?** Either works from this machine. The pooler
(`aws-0-<region>.pooler.supabase.com:5432`, username `postgres.<ref>`) is IPv4
and therefore portable — it works from CI, another machine, or a network without
IPv6. The direct host depends on IPv6 wherever you run it.

Nothing loads `.env.migrate` automatically. Only `migrate.mjs --production`
reads it, and it is git-ignored.

### 0.2 — Confirm what is going out

```
git log origin/main..HEAD --oneline
git diff --stat origin/main...HEAD | tail -1
```

Expect the role-cutover commits and roughly 200 changed files. Anything
unrelated: stop and sort that out first.

### 0.3 — Everything green, locally

With the local cluster up and the local database variables exported:

```
cd server && npm run check        # check:localonly runs first, by design
cd ..     && npm run check:chain  # 54 suites
npx tsc -b
```

Expect **37 server suites** and **54 root suites** green. `check:localonly` runs
first because every database-backed suite writes, and it refuses anything but
localhost.

`check:calschedules` has failed once under back-to-back load and passed on its
own and on a clean sweep. If it fails, re-run it alone before treating it as
real.

---

## 1 — Back up production

A `pg_dump` to a local file, **outside the repository**, with its size recorded.

### 1.0 — Two things to get right first

**`pg_dump` is not on PATH, and the wrong one will refuse.** A `pg_dump` older
than the server will not dump it. Two are installed on this machine:

| binary | version | use |
|---|---|---|
| `/c/Program Files/PostgreSQL/17/bin/pg_dump.exe` | **17.10** | **this one** |
| `/c/Program Files/PostgreSQL/13/bin/pg_dump.exe` | 13.23 | too old — refuses a 15 or 17 server |

Print both versions and compare before dumping:

```
cd server
PGDUMP="/c/Program Files/PostgreSQL/17/bin/pg_dump.exe"
"$PGDUMP" --version
node -e "
const pg=require('pg');const fs=require('fs');
const u=fs.readFileSync('.env.migrate','utf8').split('\n').find(l=>l.startsWith('MIGRATE_DATABASE_URL=')).slice(21).trim();
const c=new pg.Client({connectionString:u,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query('SHOW server_version'))
 .then(r=>{console.log('server:', r.rows[0].server_version);return c.end()})
 .catch(e=>{console.error(e.code, e.message);process.exit(1)});
"
```

The rule is **client major >= server major**. 17.10 dumping a 15.x or 17.x
server is fine; 13.23 is not. If the server is newer than 17, install a
matching client rather than forcing it — `--no-sync` and friends do not help
with a version refusal.

**The file must go outside the repository.** The repo lives under OneDrive, so a
dump written anywhere inside it is both committable *and* synced to the cloud —
and a dump of this database is every employee's personal data. Note that `../`
from `server/` is the **repo root**, which is inside both. Write it somewhere
that is neither:

```
mkdir -p ~/pg-backups
cd ~/pg-backups && pwd
# expect /c/Users/haris/pg-backups — not under OneDrive, not in the repo
```

`.gitignore` also ignores `/backup-*.sql`, `/backup-*.sql.gz`, `/*.dump` and
`/pg_dump-*.sql` at the repo root, so a dump written there by mistake cannot be
committed. That is the second line of defence; the first is writing it somewhere
else entirely.

### 1.1 — Take the dump

```
cd /c/Users/haris/OneDrive/Documents/GitHub/360-PeopleHub-v2/server
PGDUMP="/c/Program Files/PostgreSQL/17/bin/pg_dump.exe"
OUT="$HOME/pg-backups/backup-pre-0056-$(date +%Y%m%d-%H%M).sql"
URL=$(grep "^MIGRATE_DATABASE_URL=" .env.migrate | cut -d= -f2- | tr -d "[:space:]")

"$PGDUMP" --no-owner --no-privileges \
          --schema=public --schema=auth \
          --file="$OUT" "$URL"
echo "exit: $?"

ls -l "$OUT" | awk '{print $5 " bytes"}'
tail -1 "$OUT"
unset URL
```

`--schema=auth` is included deliberately: `tenant_membership.user_id` is a
foreign key into `auth.users`, so a public-only dump cannot be restored on its
own. `unset URL` keeps the credential out of the rest of the shell session; it
is never echoed.

### 1.2 — Three checks, in order

1. **`pg_dump` exited 0.** A version mismatch says so explicitly.
2. **The last line is `-- PostgreSQL database dump complete`.** If it is not,
   the file is truncated — delete it and start again. A partial dump with a zero
   exit is the thing worth ruling out, which is what this check is for.
3. **The size is plausible.** Three users, so expect roughly **100 KB – 5 MB**.
   Under ~20 KB means it dumped almost nothing: wrong database, or a role that
   cannot read the tables.

   size: ______________ bytes    file: ______________________________

Then confirm it is where it should be, and invisible to git:

```
cd /c/Users/haris/OneDrive/Documents/GitHub/360-PeopleHub-v2
git status --short --untracked-files=all | grep -i backup || echo "git cannot see it — correct"
```

Also take the Supabase backup if your plan has them (Database → Backups →
Create backup) and note the time: ______________. The dashboard restore is far
quicker than a manual one.

### Rollback at this stage

Nothing has changed, so there is nothing to undo.

Keep the dump until step B has been through and settled, then delete it. It is a
standing copy of everyone's personal data and should not outlive its purpose.

---

## 2 — Record the state you are changing

So step 4 compares against something rather than being eyeballed.

```
cd server
node -e "
const pg=require('pg');const fs=require('fs');
const u=fs.readFileSync('.env.migrate','utf8').split('\n').find(l=>l.startsWith('MIGRATE_DATABASE_URL=')).slice(21).trim();
const c=new pg.Client({connectionString:u,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query(\`
  SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
   WHERE conname IN ('tenant_membership_role_check','role_permission_role_check',
                     'employee_app_role_check','joining_request_requested_role_check')
   ORDER BY tbl\`)).then(r=>{console.table(r.rows);return c.end()});
"
```

Four constraints, each naming `admin`, `manager`, `employee` only.

Then who holds what — the "before" half of step B's evidence:

```
node -e "
const pg=require('pg');const fs=require('fs');
const u=fs.readFileSync('.env.migrate','utf8').split('\n').find(l=>l.startsWith('MIGRATE_DATABASE_URL=')).slice(21).trim();
const c=new pg.Client({connectionString:u,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query(\`
  SELECT e.code, e.full_name, e.app_role, m.role AS membership_role, m.status
    FROM tenant_membership m JOIN employee e ON e.id = m.employee_id
   ORDER BY e.code\`)).then(r=>{console.table(r.rows);return c.end()});
"
```

Expect three people: Hari and hr@ as `admin`, Lakshmi as `employee`. Save this
output — step B's dry-run is checked against it.

### Rollback at this stage

Still nothing to undo.

---

## 3 — Run the migration

```
cd server
node scripts/migrate.mjs --production
```

It prints the target host and makes you type that host back. **Read it before
you type.** If it is not the host you expect, something points elsewhere and the
answer is to stop.

Applying `0056_role_vocabulary_expand.sql` — 7,276 bytes, sha256
`4cd3d851ab02a6141f911b5375b40bd032d5e62b68984519bb2c55be8987ddfb`. One
transaction. It widens four CHECK constraints to accept all six values:

```
tenant_membership.role            admin, manager, employee,
role_permission.role         +    company_admin, hr_admin, finance_admin
employee.app_role
joining_request.requested_role
```

No row is read or written.

**Why the migration comes before the deploy, and only in that order.** Widening
a constraint cannot invalidate data that already satisfies the narrower one, so
the live code keeps working untouched — it writes `admin`, and `admin` is still
accepted. The reverse order is not safe: deploying first gives you a server
writing `company_admin` into a column that still refuses it, and every attempt
to create a user or change a role fails until the migration lands.

### Rollback at this stage

The migration is one transaction, so it either applied or it did not. Re-run the
constraint query from step 2:

- **Still three values** — it did not land. Production is exactly as it was.
  Nothing to undo.
- **Six values** — it landed. You can stop here safely and indefinitely; see
  step 4. To undo it anyway, narrow the constraints back, which is only possible
  while no row holds a new value:

```
node -e "/* check first */" # SELECT role, count(*) FROM tenant_membership GROUP BY role;
```

  If every row still reads `admin` / `manager` / `employee`, re-applying the
  pre-0056 definitions is safe. If a `company_admin` row exists, a write has
  already happened in the new vocabulary and narrowing will refuse it — that is
  when the step 1 backup earns its keep.

---

## 4 — Verify the widening

Re-run the constraint query. All four definitions should now name all six
values. Then confirm nothing moved:

```
node -e "
const pg=require('pg');const fs=require('fs');
const u=fs.readFileSync('.env.migrate','utf8').split('\n').find(l=>l.startsWith('MIGRATE_DATABASE_URL=')).slice(21).trim();
const c=new pg.Client({connectionString:u,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query('SELECT role, count(*)::int n FROM tenant_membership GROUP BY role ORDER BY role'))
 .then(r=>{console.table(r.rows);return c.end()});
"
```

Still two `admin` and one `employee`. If any row reads `company_admin`,
something other than 0056 has run — stop and find out what.

**Production is now in a valid resting state.** The constraints accept both
vocabularies and the live code still writes the old one. Stop here and nothing
is broken and nothing is half-done. This is the safe place to pause if the day
gets away from you.

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
| CI | GitHub Actions → `server.yml` — **checks only, deploys nothing** | 4–6 min |

**Wait for both before testing.** They finish at different times and cannot be
ordered from the repository, so for a minute or two one half is newer. Both
directions survive it:

- *New frontend, old server* — the frontend takes its scopes from the grant the
  server computed, never from the role name, so access is unaffected. An
  unrecognised role is read as `employee` for the two display labels that use
  it. (Until this branch that crashed the attendance and expenses screens,
  because `SCOPE['admin'].label` is undefined.)
- *Old frontend, new server* — a browser still holding the old bundle gets
  `company_admin` from `/me/permissions`, which that bundle has no entry for. A
  reload fixes it.

So: wait for both, then have each of the three hard-refresh.

Confirm the frontend actually changed rather than trusting the green tick:

```
curl -s https://360peoplehub.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

The hash should differ from before the push.

### Rollback at this stage

Revert the code and **leave the database alone**. Widened constraints are
harmless to the old code — that is the property the whole expand step rests on.

```
git revert --no-commit <merge-sha>..HEAD
git commit -m "Revert the role cutover deploy"
git push origin main
```

Or, if main was a fast-forward and nothing else has landed since:

```
git reset --hard <sha-of-main-before-the-merge>
git push --force-with-lease origin main
```

**Check with me before running either of those** — a force push to main is
exactly what this project's rules say to confirm first.

Both deploys re-run on the revert push, so allow the same four minutes before
re-testing.

---

## 6 — The five-minute smoke test

In order. Stop at the first failure and go to §7.

### Hari — company_admin

- [ ] Sign in at https://360peoplehub.com/
- [ ] Full menu, Settings included
- [ ] **Settings → Access**: four roles listed, `manager` not among them
- [ ] Open somebody else's payslip (People → a person → Payroll): figures show
- [ ] **People → directory**: salary figures visible

### hr@ — company_admin

- [ ] Sign in, in a different browser or private window
- [ ] Full menu
- [ ] Open somebody else's payslip: figures show

### Lakshmi — employee, the one that matters

- [ ] Sign in, in a third window
- [ ] Her own record and what the company shares. **No Settings. No payroll for
      anyone else**
- [ ] Her own payslip opens, with her figures
- [ ] **Somebody else's payslip is refused.** Take her employee id from the URL
      of her own payslip, substitute Hari's, reload. Expect a refusal — not a
      page with somebody else's numbers
- [ ] **People**: her own record, and no salary for anyone else

Those last two are the point. Everything above them confirms nobody was locked
out; those two confirm nobody was let in.

### Then, from your own machine

- [ ] Change a role and change it back: Settings → Users → Lakshmi → `hr_admin`,
      save, → `employee`, save. This is the first write in the new vocabulary and
      the most likely thing to find a constraint that was missed
- [ ] Try to set your own role to `employee`. Expect "You cannot remove your own
      administrator role"

### Rollback at this stage

Same as §5 — revert the code, leave the database. Any role you changed during
the smoke test stays changed; set it back by hand, and note that the old code
only understands `admin` / `manager` / `employee`, so a membership left reading
`hr_admin` will fail closed on the reverted server. Check with the step 2 output
and set anything odd back to `admin` or `employee`.

---

## 7 — If something is wrong

| symptom | what it means | what to do |
|---|---|---|
| Migration refused the host you typed | you typed a different host from the one printed | re-read it; the string may point somewhere unexpected |
| `28P01` on the migration | the password is rejected — today's blocker | §0.1 |
| Constraints still name three values | the migration did not land | nothing to undo; try again |
| An administrator has an empty menu | a role value nobody recognises reached the policy | check what their membership holds; `admin` is still valid and maps to `company_admin` |
| Somebody sees a stale UI | old bundle | hard-refresh, then sign out and in |
| Lakshmi can read somebody's payslip | a real access failure | revert the deploy immediately (§5), then tell me |

---

## What step A deliberately does not do

- **No data is converted.** Hari and hr@ still read `admin` in the database.
  That is step B, with its own dry-run and approval.
- **`admin` still works.** The normaliser accepts it, so "an old role value gets
  a 403" is not true yet at the HTTP level. That becomes true at step C, when the
  constraints narrow and the normaliser goes.
- **`role_permission` rows are untouched.** They keep `manager` through step C.

## After it has settled

Leave it a day or two under real use before step B. Worth watching:

- **Can an administrator create a user?** That path was broken on the branch
  until `validate` was fixed — `company_admin` was refused as "Not a role" — and
  it is the most likely thing to have been missed elsewhere.
- **Does anybody appear with an empty menu?** That is the fail-closed path, and
  it means an unrecognised role value reached the policy.
- **Does a manager see more than their team?** Five gates were narrowed to the
  access table on this branch; `check:managergates` covers them, but production
  has reporting lines the local fixture does not.

`docs/roles-migration.md` holds the plan, every decision, the known issue on
main that this branch fixes, and what each check proves.
