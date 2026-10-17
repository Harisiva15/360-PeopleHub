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

### 0.1 — The migration credential (READY, verified 2026-10-17)

`server/.env.migrate` authenticates.

| check | result |
|---|---|
| host | `db.<ref>.supabase.co` — the direct host, not the session pooler |
| port | 5432 |
| database | `postgres` |
| `current_user` | `postgres` |
| server version | **17.6** |
| public tables | 135 |

**How it was fixed, because the reason matters.** The password had been split out
of the URL into a separate `MIGRATE_DB_PASSWORD=` line in `server/.env`, on the
belief that `migrate.mjs` read it from there. It never did: at all five of its
revisions it has taken a whole `MIGRATE_DATABASE_URL` straight into
`new pg.Client({ connectionString })`, `env.mjs` has never assembled one from
parts, and `.env.example` never documented the variable. So nothing had read
that line since the day it was written.

The *value* was right, though. Moving it back into the URL is what made the
credential work, which also explains how 0055 was applied: the URL was complete
then, and a later `.env` edit ate everything after the password — the same
failure that made the password get split out in the first place.

The lesson is in the shape of the file, not in anybody's memory: a URL with a
credential in it is fragile to edit, which is why it now lives alone in
`.env.migrate` with nothing else in the file and nothing loading it
automatically. Only `migrate.mjs --production` reads it.

`SUPABASE_DB_PASSWORD` and `MIGRATE_DB_PASSWORD` have been removed from
`server/.env`. They held the same value as each other, no code read either, and
a production credential should not sit in a file that every `loadEnv()` caller
loads.

**To re-check at any point** — the host alone, and then one authentication:

```
cd server
node -e "import('./scripts/local-only.mjs').then(m=>console.log(m.hostOf(process.env.MIGRATE_DATABASE_URL)))"
node -e "
const pg=require('pg');const fs=require('fs');
const u=fs.readFileSync('.env.migrate','utf8').split('\n').find(l=>l.startsWith('MIGRATE_DATABASE_URL=')).slice(21).trim();
const c=new pg.Client({connectionString:u,ssl:{rejectUnauthorized:false}});
c.connect().then(()=>c.query('SELECT current_user, current_database()'))
 .then(r=>{console.log(r.rows[0]);return c.end()})
 .catch(e=>{console.error(e.code, e.message);process.exit(1)});
"
```

Each failed attempt is a failed authentication against production, which can
trip rate limiting — so change a value, then test once rather than iterating.

**One loose end, not a blocker.** `DATABASE_URL` in `server/.env` is still
truncated in the same way the migration URL was: it ends at the password with no
`@host`. That is the *application's* runtime credential, and it does not matter
today — Render carries its own environment, and the local suites override it
with the local cluster. It would matter the moment somebody ran the API locally
against production, which would fail with `Invalid URL`. Worth repairing when
convenient, and worth not repairing by editing around it.

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

Measured on 2026-10-17: client **17.10**, server **17.6** — compatible.

Re-check before dumping, in case either has moved:

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
2. **The completion marker is present.** Check for it by name, not by position:

   ```
   grep -c "PostgreSQL database dump complete" "$OUT"   # expect 1
   ```

   It is **not** the last line with pg_dump 17.x, which appends a
   `\unrestrict <nonce>` line after it — a per-dump random token that stops a
   hostile dump smuggling psql meta-commands past you. Harmless, and not a
   credential, but it means a "last line is the marker" check fails on a
   perfectly good dump. The marker sits four non-empty lines from the end.

   A partial dump with a zero exit is the thing worth ruling out, which is what
   this check is for.
3. **The size is plausible.** Three users, so expect roughly **100 KB – 5 MB**.
   Under ~20 KB means it dumped almost nothing: wrong database, or a role that
   cannot read the tables.

   size: ______________ bytes    file: ______________________________

   **Run on 2026-10-17** — exit 0, 651,805 bytes, 16,952 lines, marker present.
   162 COPY blocks of which 53 carry rows, 710 data rows in total, and
   `schema_migration` holding 55 rows: 0001–0055 applied, 0056 not, which is
   what a pre-0056 backup should look like. Three rows each in
   `tenant_membership`, `employee` and `auth.users`, as expected. Written to
   `~/pg-backups/backup-pre-0056-20261017-1115.sql` — outside the repo and
   outside OneDrive, and `git status --untracked-files=all` stayed clean.

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

In a session with no terminal — an agent session, or a watched script — pass the
confirmation as an argument instead:

```
node scripts/migrate.mjs --production --confirm-host=db.<ref>.supabase.co
```

That is not a `--yes`. The exact host still has to be named, so the thing the
prompt protected — that somebody knows where this is pointed — still holds, and
it lands in shell history rather than vanishing into a prompt. A wrong or
missing value refuses exactly as a mistyped prompt does, and `--production`
without either still refuses outright.

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

### Run on 2026-10-17

Applied with `--confirm-host`, exit 0, `1 migration(s) applied`.

Before and after were captured with the same script and diffed. The diff is
three blocks and nothing else: the header, the constraint value lists, and the
`schema_migration` lines.

| | before | after |
|---|---|---|
| the four CHECK constraints | 3 values each | **6 values each** |
| `schema_migration` rows | 55 | **56** |
| latest migration | `0055_public_role_exposure.sql` | `0056_role_vocabulary_expand.sql` |
| 0056 checksum recorded | — | `4cd3d851ab02a6141f911b5375b40bd032d5e62b68984519bb2c55be8987ddfb` |
| `tenant_membership.role` | admin 2, employee 1 | admin 2, employee 1 |
| `employee.app_role` | admin 2, employee 1 | admin 2, employee 1 |
| `role_permission` | 99 rows (33 each) | 99 rows (33 each) |
| VHM004 / VHM005 / VHM006 | admin / admin / employee | unchanged |

The recorded checksum matches the file on disk, so what ran is what is in the
repository.

The live API was unaffected: `GET /health` on the deployed server answered
`{"ok":true,…}` in 0.29s, and `https://360peoplehub.com/` returned 200. Its
`migrations` summary still reads `expected 55, applied 55, pending 0` — which
is correct and worth understanding rather than worrying about. That summary is
computed when the process starts, and the **currently deployed build does not
contain 0056 at all**, so 55 is all it knows to expect. After the step 5 deploy
it becomes 56/56. Nothing is behind.

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

### Run on 2026-10-17

Pushed `abdd175..c298269` as a fast-forward. Both GitHub workflows green:
"Deploy to GitHub Pages" success, "Server checks" success.

| | |
|---|---|
| Pages bundle | `index-CQPoOT3r.js` → **`index-DLiZsNjP.js`** |
| site | `https://360peoplehub.com/` HTTP 200 in 0.08s |
| API | `/health` → `{"ok":true, expected 56, applied 56, pending 0, drifted 0}` |

**The deploy window was real and visible.** Render went live about 15 seconds
after the push, while Pages took several minutes — so for a couple of minutes
the site served the *old* bundle against the *new* server. That is the
old-frontend/new-server direction: a stale bundle gets `company_admin` from
`/me/permissions` and has no entry for it. A reload after Pages lands clears
it. Worth knowing the order it happens in: Render first, Pages second, so the
window is always that way round and never the one that used to crash the
attendance screen.

The database was re-read after the deploy and is byte-identical to the
post-migration snapshot: the live server has written nothing.

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
- [ ] **People**: her own record, and no salary for anyone else

#### Reading somebody else's payslip — how to actually test it

**There is no URL to edit.** An earlier draft of this runbook said to take her
employee id out of the URL of her own payslip and substitute Hari's. That does
not work, because no frontend route carries an employee id: `/payroll?v=me`
shows your own, and a colleague's profile opens in a *drawer* from JavaScript
state. (`src/modules/dashboard/shared.tsx` links to `/employees?emp=<id>`, but
`/employees` never reads that parameter, so even that link does nothing.)

The refusal lives at the API, so test it there. Signed in **as Lakshmi**, open
the browser console on https://360peoplehub.com/ and paste this. It reuses her
live session, and prints status codes only — no token, no payslip content:

```js
(async () => {
  const k = Object.keys(localStorage).find(x => /^sb-.*-auth-token/.test(x));
  const raw = localStorage.getItem(k);
  const tok = JSON.parse(raw.startsWith('base64-')
    ? atob(raw.slice(7)) : raw).access_token;
  const API = 'https://three60-peoplehub-api.onrender.com';
  const HERS = '9c754d2a-a305-46ae-a71b-f254ff6ea9bf';  // VHM006 Lakshmi
  const HARI = 'b68c8dc4-73d3-42aa-b782-c4d6276c6f74';  // VHM004 Hari
  for (const [who, id] of [['her own', HERS], ["Hari's", HARI]]) {
    const r = await fetch(`${API}/payroll/payslips/${id}`,
      { headers: { authorization: `Bearer ${tok}` } });
    console.log(who.padEnd(8), r.status, r.status === 200 ? 'OK' : 'refused');
  }
})();
```

Expected, and the whole point of step A:

```
her own  200 OK
Hari's   403 refused
```

**A 200 on the second line is a live data exposure.** Revert the deploy
immediately (see below) and say so.

The route is `GET /payroll/payslips/:empId` — the id is a uuid, not the `VHM…`
code, which is why the codes are given alongside above. `…/payslips/:empId/:mk`
fetches one month and is guarded by the same `assertOwnOrAdmin`.

For the same test from a terminal instead, take the token from the same
localStorage key and:

```
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  https://three60-peoplehub-api.onrender.com/payroll/payslips/b68c8dc4-73d3-42aa-b782-c4d6276c6f74
```

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
