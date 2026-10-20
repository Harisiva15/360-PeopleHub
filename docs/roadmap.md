# Roadmap: phases 0–7

What comes after the role cutover, and every decision already taken on it.

**Nothing in this document has been started.** The role retry is still in
progress; see `docs/roles-migration.md` and `docs/step-a-runbook.md`. This file
exists so the decisions below are not re-litigated and not lost, and so a fresh
session can pick the work up without the chat history.

---

## Status and the gate

| | |
|---|---|
| `feature/roles` + migration 0057 | written, all suites green, **unpushed** |
| 0056 (expand) | **applied to production** 2026-10-17 |
| 0057 (`auth_has_reports`) | dry-run against production only |
| Step B (data: `admin` → `company_admin`) | not written |
| Step C (contract: narrow the CHECKs, drop the normaliser) | not written |

**Agreed order: step A retry → step B → step C → phase 1.**

Phase 1 is company_admin-only and its Access screen writes `role_permission`.
Production still holds 99 `role_permission` rows keyed `admin` / `manager` /
`employee` (33 each). An Access screen writing `company_admin` rows against that
data would narrow nothing and report success, so step B is a hard prerequisite
rather than a preference.

**Phase 0 may be built in parallel on its own branch, but ships after step C.**

---

## Decisions taken (2026-10-17)

Authoritative. Changing one of these is a new decision, recorded here with its
date, not an edit to the line.

### Ordering

1. Step A retry → step B → step C → phase 1. Phase 0 is built in parallel and
   ships after step C.

### Phase 0 — storage and PDF

2. **One private bucket**, keys prefixed `branding/`, `photos/`, `documents/`.
   One set of policies rather than three.
3. Uploads are **server-side**. The browser never holds the service-role key.
4. Signed URLs are minted server-side per request, short-lived, never stored.
5. **PDFs are generated server-side with `pdf-lib`.**

### Phase 1 — user management

6. **No one-time set-password link.** Email gets fixed instead: Supabase Auth
   custom SMTP via Resend. **Done, 2026-10-20** — see *Email* below.
7. Access screen covers **the four roles only**. The derived `manager` layer
   comes later.

### Phase 3 — company branding

8. Branding lives on **`legal_entity`**, not `tenant`.
9. Add explicit **`gstin`** and **`pan`** columns. Leave the existing `tax_id`
   and `registration_id` alone.
10. **Reject SVG.** PNG and JPG only, **max 1 MB**.

### Phase 4 — profile photo

11. A photo may be changed by **the person themselves, hr_admin, and
    company_admin**. Gated on **`employees` write**. Not finance_admin, not
    managers.
12. **Resize client-side.** The server enforces byte count and MIME type, and
    the code says plainly that pixel dimensions are client-asserted.

### Phase 5 — branded PDFs

13. Split by what the document is, rather than widening `documents`:

    | document | module | who may generate for anyone |
    |---|---|---|
    | Payslip, salary certificate | `payroll` / `compensation` | hr_admin, finance_admin, company_admin |
    | Employment verification, experience/relieving, address proof | `documents` | hr_admin, company_admin |

    `documents` is **not** widened for finance_admin: that would also hand them
    everyone's uploaded documents.

14. **Reference format** `360/<TYPE>/<tax year>/<4-digit counter>`, e.g.
    `360/SC/2026-27/0001`. Types: `PS` payslip, `SC` salary certificate, `EV`
    employment verification, `EX` experience/relieving, `AP` address proof.
15. A **reissue gets a new number**. The superseded one is marked as such and
    stays in the audit trail.

### Phase 6 — document requests

16. **In-app first.** Email notifications once SMTP works.

### Phase 2 — removing dummy data

17. The delete list is approved **after** the read-only inventory is reviewed.
18. **`audit_log` history is kept**, including for deleted records: it is the
    record that they existed.
19. Reference tables holding a mix of real and seeded rows get **row-level
    deletes**, not rebuilds.

### Phase 7 — projects

20. Add a `projects` row to `POLICY`, gate the service on it, and extend
    `check:rolegates` to catch route/service/policy mismatches.
21. Replacing the demo dataset across all 65 modules is **a separate project**.
    Phase 7 lists them ranked by how heavily they are used; scheduling comes
    later.

---

## One thing needed from the operator

**Add `SUPABASE_SERVICE_ROLE_KEY` to Render's environment** (Render → the API
service → Environment). That exact name — `server/src/config.ts:71` reads
`process.env.SUPABASE_SERVICE_ROLE_KEY`, and `auth/adminApi.ts` sends it as both
the `apikey` and `authorization: Bearer` header.

Never in a `VITE_` variable, never in the frontend bundle, never printed. The
repo already enforces part of this: `checks/auth-gate.tsx` fails the build if a
`VITE_` variable ever carries a secret.

**Worth knowing before phase 0 or 1:** the value in local `server/.env` is a
**placeholder** — 24 characters beginning `you…`. So invitations have never
worked from a local server, and whether Render holds a real value is unverified
from here. Confirm it there before phase 1 depends on it.

### A contradiction in the repo's own notes, recorded rather than resolved

`server/.env.example` says:

> NEVER put SUPABASE_SECRET_KEY (sb_secret_…) here or anywhere this app reads.
> It is the service_role equivalent: it bypasses every row-level security
> policy in the schema. Nothing in this codebase wants it.

But `auth/adminApi.ts` already needs a service-role-equivalent key to send
invitations, and decisions 3 and 4 above deepen that dependency: server-side
uploads to a private bucket need a credential that storage RLS does not
constrain.

Both things are true. The reconciliation is that the key is held **only** by the
Render process, is never in a `VITE_` variable or the bundle, and is used only by
`adminApi` and the storage adapter. The narrower alternative — uploading with the
signed-in user's own JWT under storage RLS policies — was considered and rejected
with decision 3, because it moves uploads into the browser.

`.env.example`'s warning should be rewritten in phase 0 to say what is actually
true: that the service-role key belongs in the server's environment and nowhere
else, rather than that nothing wants it.

---

## Phase 0 — storage adapter and PDF foundation

Built first, in parallel, shipped after step C. Phases 3, 4 and 6 all depend on
it.

**The adapter does not exist.** `document` was designed for one — it has
`storage_key`, `mime_type`, `size_bytes`, `checksum`, `purged_at`, and a comment
reading *"Bytes live in object storage, not here… `storage_key` is opaque to
everything but the storage adapter"* — and nothing in `src/` or `server/src/`
calls Supabase Storage. Building it inside a feature branch would bury a shared
foundation, so it gets its own.

| | |
|---|---|
| **Migrations** | None for storage itself; `document` already has the columns. Storage bucket and its policies are created in the Supabase dashboard or by a one-off script in `db/manual`, not by `migrate.mjs`. |
| **Server** | `server/src/storage/` — `put`, `signedUrl`, `remove`. Every `put` computes the sha256 into `document.checksum`, enforces the byte cap and checks declared MIME against magic bytes. Keys are `<prefix>/<tenant>/<uuid>`, opaque and never guessable from a person's id. |
| **PDF** | `pdf-lib`, pinned. A letterhead renderer taking entity name, address, logo bytes, signatory, date and reference. |
| **Screens** | None. |
| **Checks** | A byte cap and a wrong-MIME upload are both refused; a signed URL expires and a stale one is refused; a key for tenant A is unreachable from tenant B; `checksum` matches the bytes; `purged_at` hides a document from every read path. |

**Open items**

- Bucket name. Suggest `tenant-files`, with the three key prefixes.
- Whether `storage.objects` gets RLS policies as a second layer even though the
  server uses the service-role key. Recommended: yes, deny-by-default, so a
  leaked anon key cannot read the bucket.

---

## Phase 1 — user management

| | |
|---|---|
| **Already exists** | `createUser`, `updateUser`, `setUserStatus`, `inviteUser`, bulk import, `mayAdminister`, `mayGrant`, both halves of the last-administrator guard. `tenant_membership` carries every column needed. Screens exist at `src/modules/users/{index,Drawers,shared}.tsx` and `src/modules/settings/access.tsx`. |
| **Migrations** | Likely none. Possibly an index on `role_permission (tenant_id, role)`. Step C narrows the CHECK separately. |
| **Screens** | Users list and create/edit drawer, wired to the real API. Access settings grid, four roles across the policy's modules and three verbs. |
| **Permissions** | `users: rule(NO, ['team','none','none'], ALL_R, NO, ALL_RWA)` — create, edit and deactivate are **company_admin only**; hr_admin reads; a manager sees their line; finance_admin nothing. `settings: rule(NO,NO,NO,NO,ALL_RWA)` — the Access screen is company_admin only. |
| **Checks** | The role-assignment matrix, extending `check:rolegates` rule 2. `role_permission` can only ever narrow, never widen. The Settings-lockout guard (`ADMIN_LAYERS` in `config/permissions.ts`) gets a check of its own. Both last-administrator halves are already covered by `check:lastadmin`. |

**Owed at the start of this phase:** nothing on email — it is live. See *Email*
below. What is still owed is the invite path itself, which has never worked (see
*The invitation that was never sent*).

---

## Email

**Settled 2026-10-20. Supabase Auth custom SMTP, through Resend.**

| | |
|---|---|
| Host | `smtp.resend.com:465` |
| Username | `resend` |
| Sender | `peoplehub@360technologyllc.com` |
| Covers | password recovery, invitations, magic links, email change — every Auth email |
| Code changes | **none.** Supabase sends the mail; this application never touches SMTP |

Password-recovery emails arrive, confirmed by test.

### Routes considered and retired

**Office 365 SMTP AUTH — retired.** Microsoft blocks SMTP AUTH on these
tenants, so there was nothing to configure.

**Microsoft Graph `sendMail` — planned, never built.** The fallback for the
above was to register a Send Email Hook on Supabase Auth, verify its Standard
Webhooks signature at a new unauthenticated endpoint, render the four templates
ourselves and post them to Graph `/users/{sender}/sendMail` with
client-credentials OAuth. It was fully planned, including the Exchange Online
RBAC-for-Applications commands to confine the app to the one mailbox. Resend
removed the need for all of it.

Keep the plan in mind only if app-level notifications later want a sender this
application controls. Auth email does not need one, and the Graph route costs
four secrets, an unauthenticated endpoint and a signature implementation that
Resend costs nothing to avoid.

### What this does *not* fix

Auth email working is not the invite flow working. Supabase only sends an
invitation if something asks it to, and nothing does — see below.

---

## The invitation that was never sent

Read-only audit, 2026-10-20. Nothing here is fixed yet; it is written down so
phase 1 starts from the real state rather than the assumed one.

### 1. `createUser` claims an invitation it never sends

`authAdmin()` is called in exactly one place in the users service — inside
`inviteUser`. `createUser` never calls it. But its `tenant_membership` INSERT
sets, unconditionally for an administrator:

```sql
invite_sent_at = CASE WHEN $3 = 'invited' THEN now() ELSE NULL END,
invited_count  = 1,
```

and the form's `sendInvitation` flag feeds **only** `must_change_password`:

```ts
[d.role, emp[0]!.id, status, d.sendInvitation === false, …]
```

So ticking *Send invitation* on the create-user form does nothing an email
could come out of, while the row records that an invitation was sent and the
drawer displays *Invitations sent: 1* and *Invitation sent: &lt;date&gt;*.

This is the same defect the comment on `resendInvitation` already describes as
fixed — *"This used to increment a counter and stamp a time while sending
nothing, which is how every account came to look invited without anybody having
been told"* — fixed on the resend path and left in place on the create path.

**Latent rather than already damaging.** Production has one `user.created`
audit row, no `user.invited` or `user.invite_resent` row at all, and
`invite_sent_at` is NULL on all three memberships: those accounts came through
the joiner and onboarding flows, not this path. It will fire the first time an
administrator creates a user from the Users screen, which is phase 1's opening
action.

### 2. The service-role key may be the wrong shape for the header it is sent in

`SUPABASE_SERVICE_ROLE_KEY` in Render is an `sb_secret_…` key. `adminApi.post`
sends it in two headers at once:

```ts
apikey: config.supabaseServiceKey,
authorization: `Bearer ${config.supabaseServiceKey}`,
```

The legacy `service_role` key was a JWT, and the GoTrue admin endpoints
authorise by decoding it and reading the `role` claim. The new keys are opaque
tokens, not JWTs, and Supabase's guidance is to send them on `apikey` and
**not** on `Authorization: Bearer`, because anything that tries to verify one as
a JWT fails.

Consistent with the evidence above: no invitation has ever succeeded in
production. Not proof — the path has also never been exercised — so it needs
one live call to settle, and the fix is a one-line change to which header
carries the key.

### 3. Every way the invite path can fail quietly

Ranked. The server side is better than expected: `inviteUser` calls the
provider *inside* the transaction, so a refused send rolls back the counter and
the timestamp, and `AdminApiError` is mapped to 503/502 with its real message.

| | where | behaviour |
|---|---|---|
| **A** | `createUser` | records an invitation, sends nothing, reports success — item 1 above |
| **B** | `adminApi.post` | `fetch` is not wrapped, so DNS/TLS/timeout throws a bare `TypeError: fetch failed`, which no branch of `statusFor` matches and which therefore surfaces as a generic 500 rather than "could not reach Supabase" |
| **C** | Supabase → Resend | GoTrue can answer 2xx and the message still not arrive. `inviteToSetPassword` resolves, the counter commits, the audit says invited. Nothing server-side can know; the mitigations are the Resend dashboard and the fact that `status` stays `invited` until accepted |
| **D** | the key | item 2 — fails *loudly* if rejected (`'Supabase rejected this server's credentials'`), so this one is a correctness bug, not a silent one |

### 4. The role picker still offers the old vocabulary

`src/modules/users/Drawers.tsx` builds the assignable-role list as:

```ts
const roles = (['employee', 'manager', 'admin'] as AppRole[])
```

`AppRole` is `'employee' | 'hr_admin' | 'finance_admin' | 'company_admin'`, so
two of those three values are not members of it. The `as AppRole[]` assertion
is what let it through: the sweep found no type error because the cast silences
one, and `check:rolegates` rule 3 looks for *comparisons* against role values,
not literals in an array.

The practical effect is a gap, not an exposure — `mayAssignRole` fails closed on
the two unrecognised values, so the picker offers `employee` and nothing else,
and `hr_admin`, `finance_admin` and `company_admin` cannot be assigned from this
screen at all. Phase 1 replaces the screen; the check should grow a rule for
role literals in array position regardless, because the next cast will hide the
next one.

---

## Phase 2 — remove dummy data from production

Two steps, with approval between them.

### 2a — read-only inventory

135 public tables. Per table: total rows, rows reachable from VHM004 / VHM005 /
VHM006, rows reachable from real company config, and the remainder — with a
shape sample giving column names and value *types*, never raw personal data.

**Defining "real" is the hard part, and it is evidence-based.** The audit log
shows configuration genuinely created by hand — `department_created`,
`business_unit_created`, `work_schedule_created`,
`tenant_display_name_updated` on 2026-10-13, and `role_changed` entries since.
Some reference data is real and some is seeded. The inventory separates them by
audit evidence and creation date rather than by guessing from names.

### 2b — guarded delete

`db/manual/`, one transaction, before and after counts, aborting unless zero
real-person rows are in scope, with a row-count guard in the shape of
`clear-must-change-password-VHM004.sql`. Run only after a fresh `pg_dump` —
`docs/step-a-runbook.md` §1 has the procedure, the correct `pg_dump` binary and
the version rule.

| | |
|---|---|
| **Migrations** | None. `db/manual` is ignored by both `migrate.mjs` and `check:migrations`. |
| **Checks** | A new `check:noseed` asserting production-shaped invariants: exactly one tenant, three active memberships, no `ZZ`-prefixed employee codes, no `zz-scratch-` tenant. Read-only, runs against any database. |

---

## Phase 3 — company branding

Most of this already has columns. `legal_entity` holds `legal_name`,
`registered_address`, `tax_id`, `registration_id`, `pf_code`, `esi_code`.

| | |
|---|---|
| **Migrations** | Add `gstin`, `pan`, `signatory_name`, `signatory_title`, `logo_document_id` (FK → `document`) to `legal_entity`. |
| **Screens** | Settings → Company: a form over the existing and new fields, plus logo upload with preview, replace and remove. |
| **Permissions** | `settings` → **company_admin only**. hr_admin holds nothing on `settings`, by the earlier decision that users, roles and settings are one job. |
| **Checks** | Over 1 MB refused; anything but PNG or JPG refused by declared type **and** magic bytes; SVG refused explicitly, with the reason in the message; signed URLs expire; a non-company_admin gets 403 on both read and write. |

---

## Phase 4 — profile photo

| | |
|---|---|
| **Migrations** | `employee.photo_document_id` (FK → `document`). Reuse `document` with `kind='photo'` rather than a parallel table: it already carries checksum, size, MIME and retention. |
| **Screens** | Own photo on the account screen: upload, replace, remove. Display in `shell/TopBar.tsx`, the directory and the org chart — `Avatar` renders initials today and needs a `src` with an initials fallback. |
| **Permissions** | Own photo: `account: rule(SELF,…)` — everyone. Somebody else's: **`employees` write**, which is hr_admin and company_admin (decision 11). |
| **Checks** | Employee A cannot write B's photo; hr_admin and company_admin can; **finance_admin and a manager cannot**; byte count and MIME enforced server-side; removal clears the pointer and marks the document purged; the fallback to initials renders when there is no photo. |

Decision 12 means the server cannot verify pixel dimensions without an image
decoder. The code says so where the resize is trusted, rather than implying a
guarantee it does not make.

---

## Phase 5 — branded PDFs

| | |
|---|---|
| **Migrations** | A reference-counter table keyed `(tenant_id, doc_type, tax_year)` with the counter and a unique constraint. A `superseded_by` pointer for reissues (decision 15). Output bytes go in `document`. `letter_type` already exists. |
| **Screens** | Download on the payslip; a "Generate document" action for HR and Finance within their split (decision 13). |
| **Permissions** | Per decision 13. An employee downloads only their own, which `checks/pay-routes.ts` already covers for payslips. |
| **Checks** | Employee downloads only their own; reference numbers unique and gapless per tenant, type and tax year; every generation writes an audit row; a reissue produces a new number and marks the old superseded; the PDF genuinely contains the entity name, address, signatory, date and reference — asserted on extracted text, not on bytes. |

**Open items**

- The **tax year** must derive from `tenant.fiscal_year_start_month`, which is
  `4` today, not from a hardcoded April. The column exists; use it.
- A four-digit counter caps at 9999 per type per year. Fine for this tenant, but
  the behaviour at overflow should be a refusal with a clear message rather than
  a wrap or a collision.

---

## Phase 6 — document requests

Much smaller than it looks. `letter_request` already exists with `employee_id`,
`letter_type_id`, `purpose`, `status`, `requested_on`, `issued_on`, `issued_by`,
`document_id` and `reference`. `requestLetter` and `factsFor` are implemented,
including the guard that you may only request your own.

| | |
|---|---|
| **Migrations** | Add `decision_note`, `decided_by`, `decided_at`; extend the `status` CHECK to admit `rejected`. The current CHECK needs reading before this is final. |
| **Screens** | Employee: request form (type + purpose) and their own request list with status. HR: an inbox with approve and reject, each taking a comment. |
| **Permissions** | Requesting: `documents` write own — everyone. Actioning: `documents` approve all — hr_admin and company_admin. The approvals inbox inherits each module's `approve`, so the queue appears without being wired separately. |
| **Checks** | An employee cannot action a request, including their own; a rejected request produces no document; an approval generates exactly one PDF and one audit row; the employee can download only after approval. |

In-app only for now (decision 16).

---

## Phase 7 — projects

Confirming the area is empty after phase 2 is straightforward. The rest is not.

**"What is a project" currently has three different answers:**

| | says |
|---|---|
| `server/src/auth/policy.ts` | **no `projects` row at all** — so `effectiveFor` fails closed and nobody reaches it |
| `server/src/http/route-modules.ts:67` | `projects: 'timesheet'` — the boundary admits it as timesheet |
| `server/src/modules/projects/service.ts:135` | `reaches(caller, 'planner', 'write', 'all')` — writes gated on the task board |

Writes therefore require `planner` write-all, which happens to be hr_admin and
company_admin — the intended answer, reached by accident through an unrelated
module. This is the same shape of defect the pay census found: a gate asking
about the wrong module and being right only by coincidence.

| | |
|---|---|
| **Migrations** | Confirm `project` carries a timesheet code column; add one if not. |
| **Screens** | Create a project, add members, manage timesheet codes. |
| **Permissions** | Add to `POLICY`: `projects: rule(OWN_R, ['team','none','none'], ALL_RWA, ALL_R, ALL_RWA)` — employees see projects they are on, managers their line, HR and company_admin manage, finance reads for billing. Gate `projects/service.ts` on `projects`, not `planner`. |
| **Checks** | Extend `check:rolegates` with a rule that every module a service gates on exists in `POLICY`, and that a route's `route-modules` mapping matches the module its service actually asks about. That rule would have caught this. |

**Still hard-coded:** `src/modules/dashboard/index.tsx` and
`src/modules/expenses/index.tsx` import `PROJECTS` from `src/data/org`, while the
`project` table from migration 0002 goes unused by those screens.

**Scope honesty:** 65 modules under `src/modules/` import from `src/data/`.
Phase 7 covers the project-specific ones and produces the ranked list; the rest
is decision 21's separate project.

---

## Standing rules for every phase

Carried over from the role cutover, and unchanged.

- Each phase is its own small branch and its own deploy.
- Nothing is pushed and no migration runs against production without an
  explicit go, per step.
- A fresh `pg_dump` before any production data change, with its size recorded.
- Secrets are never printed. Credentials are reported as a length and a sha256
  prefix.
- A guard is never relaxed without asking first — including a confirmation
  prompt, a refusal path or a local-only check.
- After each deploy: sign in as a real user within two minutes, with the revert
  ready. `/health` answers before authentication and proves nothing about it.
