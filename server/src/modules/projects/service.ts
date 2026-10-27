/**
 * The projects work is booked against.
 *
 * `project` has been in the schema since 0002 and read by expenses, planner and
 * timesheet — always internally, to resolve a code to an id. Nothing ever
 * listed it, so every screen that had to *offer* a project read the static
 * array in `src/data/org.ts` instead.
 *
 * That is the same shape of bug as the location list: `addEntry` validates the
 * code against `project WHERE code = $1 AND active`, so a picker built from a
 * hand-written array offers values the server will refuse and omits ones it
 * would accept. The two lists agree today by luck, not by construction.
 *
 * ## Why this module now writes
 *
 * It used to be read-only, on the reasoning that creating a project is delivery
 * administration rather than timekeeping. That reasoning was sound and the
 * consequence was not: the only thing that ever inserted a project was the
 * demo seed. Strip the demo data for a production tenant and the table is
 * empty, so `addEntry` refuses every line with "choose a project" and the
 * timesheet module cannot be used at all. Nobody could fix that from inside the
 * product — there was no screen, no route and no service method.
 *
 * So the writes live here, with the read, because they are the same table and
 * splitting them would put half of a project's lifecycle in another module.
 *
 * Writes are admin-only, which is where the original reasoning survives: an
 * employee books time against a project, and deciding that a project exists is
 * somebody else's job. The module gate cannot express that — `/projects` maps
 * to the `timesheet` module so an employee can read the list for their own
 * week, and the timesheet rule allows an employee to write their own sheet — so
 * the check is here in the service, as it is for departments and locations.
 *
 * ## A project is closed, never deleted
 *
 * `timesheet_entry.project_id` is NOT NULL and references `project`, as does
 * `expense_item.project_id`, neither with an ON DELETE action. A project with
 * any booked time therefore cannot be deleted, and should not be: the hours
 * happened. `setProjectStatus` flips `active`, which is the flag `addEntry` and
 * every picker already honour, so closing a project stops new bookings and
 * leaves old ones resolving to a name.
 */

import { reaches } from '../../auth/can.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export interface Project {
  /** The code screens key entries by — `P-ATLAS`. The uuid stays server-side. */
  id: string;
  name: string;
  /** The client's name, or 'Internal' where the project has none. */
  client: string;
  billable: boolean;
  active: boolean;
  startsOn: string | null;
  endsOn: string | null;
}

/**
 * What a form sends.
 *
 * `client` is a client *code*, not a name and not an id: a code is what an
 * administrator can see on the Clients screen, and resolving it here means a
 * typo is refused rather than silently stored as Internal. Null or empty means
 * the project has no client, which is what 'Internal' renders from.
 */
export interface ProjectDraft {
  code?: string;
  name?: string;
  client?: string | null;
  billable?: boolean;
  startsOn?: string | null;
  endsOn?: string | null;
}

export class ProjectError extends Error {
  code: 'invalid' | 'forbidden' | 'conflict' | 'not_found';

  constructor(message: string, code: ProjectError['code']) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
  }
}

const ymd = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

const PROJECT_COLUMNS = `
  SELECT p.code, p.name, p.billable, p.active, p.starts_on, p.ends_on,
         COALESCE(c.name, 'Internal') AS client
    FROM project p
    LEFT JOIN client c ON c.id = p.client_id`;

const toProject = (r: Record<string, unknown>): Project => ({
  id: r.code as string,
  name: r.name as string,
  client: r.client as string,
  billable: Boolean(r.billable),
  active: Boolean(r.active),
  startsOn: ymd(r.starts_on),
  endsOn: ymd(r.ends_on),
});

/**
 * Every project, closed ones included.
 *
 * Closed projects come back because an entry booked last quarter still names
 * one and a screen has to resolve that code to something better than a dash.
 * `active` says which may be booked against — the pickers offer only those,
 * which is the same rule `addEntry` enforces server-side.
 *
 * Not scoped by role. A project name is not sensitive, every timesheet screen
 * needs the list, and the route is gated on the `timesheet` module, which an
 * employee reaches for their own week.
 */
export async function listProjects(caller: Caller): Promise<Project[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${PROJECT_COLUMNS} ORDER BY p.active DESC, p.name`);
    return rows.map(toProject);
  });
}

/* ---------------- writes ---------------- */

/** Only an administrator shapes the project list. */
function mayShape(caller: Caller, what: string): void {
  if (!reaches(caller, 'planner', 'write', 'all')) {
    throw new ProjectError(`only an admin may ${what}`, 'forbidden');
  }
}

/**
 * A code is what people type into a timesheet, so it is narrow on purpose:
 * upper-case letters, digits and hyphens, two to sixteen characters. The seed's
 * codes look like `P-ATLAS`, and nothing here requires that prefix — it is a
 * convention, not a rule.
 */
const CODE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;

const need = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate a draft and hand back the fields the statements use.
 *
 * `full` is true when a code is expected — on create. An update addresses the
 * project by its code in the path, so sending another one in the body would
 * either be ignored or rename it, and neither is worth the ambiguity.
 */
function checkProject(draft: ProjectDraft, full: boolean): {
  code: string | null;
  name: string;
  billable: boolean;
  startsOn: string | null;
  endsOn: string | null;
} {
  let code: string | null = null;
  if (full) {
    if (!need(draft.code)) throw new ProjectError('a project needs a code', 'invalid');
    code = draft.code.trim().toUpperCase();
    if (!CODE.test(code)) {
      throw new ProjectError(
        'a code is 2–16 letters, digits or hyphens, such as P-ATLAS', 'invalid');
    }
  }

  if (!need(draft.name)) throw new ProjectError('a project needs a name', 'invalid');

  const date = (v: string | null | undefined, which: string): string | null => {
    if (v === null || v === undefined || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw new ProjectError(`${which} is a date, as 2026-04-01`, 'invalid');
    }
    if (Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
      throw new ProjectError(`${v} is not a date`, 'invalid');
    }
    return v;
  };

  const startsOn = date(draft.startsOn, 'a start');
  const endsOn = date(draft.endsOn, 'an end');
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new ProjectError('a project cannot end before it starts', 'invalid');
  }

  return {
    code,
    name: draft.name.trim(),
    billable: draft.billable ?? true,
    startsOn,
    endsOn,
  };
}

/**
 * Resolve a client code to its id.
 *
 * Absent, null or empty means the project has no client, which is the
 * 'Internal' the list renders. A code that names no client is refused rather
 * than stored as null, because silently becoming Internal is exactly the kind
 * of quiet wrong answer this product tries not to give.
 */
async function clientIdFor(
  db: TenantClient,
  client: string | null | undefined,
): Promise<string | null> {
  if (!need(client)) return null;
  const code = client.trim().toUpperCase();
  const { rows } = await db.query('SELECT id FROM client WHERE upper(code) = $1', [code]);
  if (!rows[0]) throw new ProjectError(`no such client: ${client.trim()}`, 'not_found');
  return rows[0].id as string;
}

/** One audit row per project write, with the actor's name resolved. */
async function audit(
  db: TenantClient,
  caller: Caller,
  action: string,
  code: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, detail)
     SELECT 'config', $2, $1, COALESCE(e.full_name, 'system'), 'project',
            $4::jsonb || jsonb_build_object('project', $3::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, action, code, JSON.stringify(detail)]);
}

export async function createProject(caller: Caller, draft: ProjectDraft): Promise<Project> {
  mayShape(caller, 'add a project');
  const v = checkProject(draft, true);
  const code = v.code!;

  return withTenant(caller, async (db) => {
    const clash = await db.query('SELECT 1 FROM project WHERE code = $1', [code]);
    if (clash.rowCount) throw new ProjectError(`${code} is already a project`, 'conflict');

    const clientId = await clientIdFor(db, draft.client);

    await db.query(
      `INSERT INTO project (code, name, client_id, billable, starts_on, ends_on, active)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, true)`,
      [code, v.name, clientId, v.billable, v.startsOn, v.endsOn]);

    await audit(db, caller, 'project_created', code, { name: v.name, billable: v.billable });

    const back = await db.query(`${PROJECT_COLUMNS} WHERE p.code = $1`, [code]);
    return toProject(back.rows[0]!);
  });
}

/**
 * Change a project's details.
 *
 * Every field in the draft is written, not merged — the editor sends the whole
 * form, and a partial update that leaves `billable` alone because the caller
 * omitted it is a worse surprise than one that sets it to what the form showed.
 * The code is not among them: it is the path, and renaming a code would orphan
 * every entry that refers to it by that name on screen.
 */
export async function updateProject(
  caller: Caller,
  code: string,
  draft: ProjectDraft,
): Promise<Project> {
  mayShape(caller, 'change a project');
  const v = checkProject(draft, false);
  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const clientId = await clientIdFor(db, draft.client);

    const updated = await db.query(
      `UPDATE project
          SET name = $2, client_id = $3, billable = $4,
              starts_on = $5::date, ends_on = $6::date
        WHERE code = $1`,
      [key, v.name, clientId, v.billable, v.startsOn, v.endsOn]);
    if (updated.rowCount === 0) throw new ProjectError('no such project', 'not_found');

    await audit(db, caller, 'project_updated', key, { name: v.name, billable: v.billable });

    const back = await db.query(`${PROJECT_COLUMNS} WHERE p.code = $1`, [key]);
    return toProject(back.rows[0]!);
  });
}

/**
 * Open or close a project.
 *
 * Closing is how a project ends. It is not a delete: `timesheet_entry` and
 * `expense_item` both reference `project` with no ON DELETE action, so a
 * project with booked time cannot be removed, and the hours should not vanish
 * because the engagement finished. `active = false` is what `addEntry` checks
 * and what every picker filters on, so a closed project stops accepting new
 * time and keeps resolving old entries to a name.
 */
export async function setProjectStatus(
  caller: Caller,
  code: string,
  active: boolean,
): Promise<Project> {
  mayShape(caller, 'open or close a project');
  if (typeof active !== 'boolean') {
    throw new ProjectError('a project is either open or closed', 'invalid');
  }
  const key = code.trim().toUpperCase();

  return withTenant(caller, async (db) => {
    const updated = await db.query(
      'UPDATE project SET active = $2 WHERE code = $1', [key, active]);
    if (updated.rowCount === 0) throw new ProjectError('no such project', 'not_found');

    await audit(db, caller, active ? 'project_reopened' : 'project_closed', key, { active });

    const back = await db.query(`${PROJECT_COLUMNS} WHERE p.code = $1`, [key]);
    return toProject(back.rows[0]!);
  });
}

/* ---------------- membership ----------------
 *
 * Step one of three. The table exists and the service fills it; nothing
 * enforces membership yet, because production holds timesheet entries for
 * projects nobody is formally on and a rule added today would reject the next
 * edit to any of them. Step two backfills from those entries; step three
 * refuses a booking without a live row, and that is where the refusal message
 * lands.
 *
 * ## Who may change membership
 *
 * `planner` write at **team**, which is a manager through the layer, hr_admin
 * and company_admin — not a plain employee and not finance_admin, both of
 * whom hold `own`.
 *
 * Note what that means for `role = 'lead'`: it does **not** let somebody
 * manage their own project's team. A lead who also has reports qualifies as a
 * manager, and a lead who does not, does not. That is deliberate, and it is
 * the migration's own words — a lead grants nothing — but it is narrower than
 * the proposal's gloss, which said "a lead manages their own project's
 * membership". Making `lead` grant anything would make it a role, and 0060
 * has just spent a migration narrowing the vocabulary to four.
 */

export interface ProjectMember {
  projectCode: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  role: 'member' | 'lead';
  allocationPct: number | null;
  joinedOn: string;
}

/** A membership change, with anything the caller should see about it. */
export interface MembershipResult {
  member: ProjectMember;
  /**
   * Set when this person's live allocations now sum past 100%.
   *
   * A warning and not a refusal, by decision: somebody genuinely
   * over-committed is a thing to see rather than a write to block, and a
   * CHECK could not have expressed it anyway because it spans rows.
   */
  warning?: string;
}

const MEMBER_COLUMNS = `
  SELECT p.code AS project_code, e.id AS employee_id, e.code AS employee_code,
         e.full_name AS name, m.role, m.allocation_pct, m.joined_on::text AS joined_on
    FROM project_member m
    JOIN project p ON p.id = m.project_id
    JOIN employee e ON e.id = m.employee_id
   WHERE m.left_on IS NULL`;

const toMember = (r: Record<string, unknown>): ProjectMember => ({
  projectCode: r.project_code as string,
  employeeId: r.employee_id as string,
  employeeCode: r.employee_code as string,
  name: r.name as string,
  role: r.role as 'member' | 'lead',
  allocationPct: r.allocation_pct === null ? null : Number(r.allocation_pct),
  joinedOn: r.joined_on as string,
});

/** Only somebody who answers for a team puts people on projects. */
function mayManageMembers(caller: Caller, what: string): void {
  if (!reaches(caller, 'planner', 'write', 'team')) {
    throw new ProjectError(`only a manager or an administrator may ${what}`, 'forbidden');
  }
}

/**
 * A project's live team, leads first.
 *
 * ## Why the gate is written out rather than shared
 *
 * Both listings here return person-level rows with no WHERE clause narrowing
 * them to the caller, so each has to state the scope that makes unscoped rows
 * safe. `role-gates.ts` rule 1 requires it, and the rule exists because
 * `listOnboarding` once returned every joiner's offered salary with no WHERE
 * clause at all.
 *
 * It was a shared `mayListPeople(caller, …)` helper first, and the detector
 * could not see it: it accepts a gate in guard position — `if (!gate(…))` —
 * or the call written out in the body, and a helper that throws from inside
 * itself is neither. Which is the detector being right. A reader scanning
 * this function for what it requires should find it here, not two hops away.
 *
 * `planner` read is `all` for every role, because the project board is
 * tenant-public, so this refuses nobody today. That is not the inert guard
 * removed from `projectsOf` — that one asked for a narrower scope than
 * everyone already held and so could never fire. This asks for exactly what
 * unscoped rows amount to, which makes it a tripwire: narrow `planner` read
 * for any role and this listing refuses instead of handing that role the
 * whole tenant.
 */
export async function listMembers(
  caller: Caller, projectCode: string,
): Promise<ProjectMember[]> {
  if (!reaches(caller, 'planner', 'read', 'all')) {
    throw new ProjectError("your role cannot read a project's team", 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${MEMBER_COLUMNS} AND p.code = $1
        ORDER BY (m.role = 'lead') DESC, e.full_name`,
      [projectCode.trim().toUpperCase()]);
    return rows.map(toMember);
  });
}

/**
 * The projects somebody is on — theirs or anybody's.
 *
 * Which is the policy's answer rather than an omission: `planner` read is
 * `all` for every role. The first draft refused unless the row was the
 * caller's or they reached a narrower scope, and it could never fire, because
 * every role already held more than it asked for — an inert guard reading as
 * protection, the shape `hostOf()` and the unread `LAUNCH_LETTERS` had.
 *
 * The gate below asks for what unscoped rows actually amount to. If
 * who-is-on-what should become private, the change belongs in
 * `POLICY.planner`, where every module's answer is written down once and
 * `checks/roles.ts` holds the client to it — and this listing then refuses on
 * its own, without anybody remembering to come back here.
 */
export async function projectsOf(
  caller: Caller, employeeId: string,
): Promise<ProjectMember[]> {
  if (!reaches(caller, 'planner', 'read', 'all')) {
    throw new ProjectError("your role cannot read somebody's projects", 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${MEMBER_COLUMNS} AND m.employee_id = $1 ORDER BY p.name`, [employeeId]);
    return rows.map(toMember);
  });
}

/**
 * How much of somebody's time is already planned, across live memberships.
 *
 * A null allocation counts as nothing: it means "on the project, nobody
 * planned", not "zero per cent".
 */
async function plannedPct(db: TenantClient, employeeId: string): Promise<number> {
  const { rows } = await db.query<{ total: string | null }>(
    `SELECT sum(allocation_pct)::text AS total FROM project_member
      WHERE employee_id = $1 AND left_on IS NULL`, [employeeId]);
  return Number(rows[0]?.total ?? 0);
}

/**
 * Put somebody on a project, or change what they are doing on it.
 *
 * One live row per person per project, which `project_member_live_once`
 * enforces — so this updates the live row where there is one rather than
 * racing the index and reporting a duplicate to somebody who asked a
 * reasonable question.
 */
export async function addMember(
  caller: Caller,
  projectCode: string,
  employeeCode: string,
  role: 'member' | 'lead' = 'member',
  allocationPct: number | null = null,
): Promise<MembershipResult> {
  mayManageMembers(caller, 'put somebody on a project');

  if (role !== 'member' && role !== 'lead') {
    throw new ProjectError("a project role is 'member' or 'lead'", 'invalid');
  }
  if (allocationPct !== null
    && (!Number.isInteger(allocationPct) || allocationPct < 1 || allocationPct > 100)) {
    throw new ProjectError(
      'an allocation is a whole number from 1 to 100, or nothing', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const pKey = projectCode.trim().toUpperCase();
    const eKey = employeeCode.trim().toUpperCase();

    const { rows: found } = await db.query<{ pid: string; eid: string; active: boolean }>(
      `SELECT p.id AS pid, e.id AS eid, p.active
         FROM project p, employee e
        WHERE p.code = $1 AND e.code = $2`, [pKey, eKey]);
    const target = found[0];
    if (!target) throw new ProjectError('no such project or employee', 'not_found');
    if (!target.active) {
      throw new ProjectError(
        'that project is closed — reopen it before adding people', 'invalid');
    }

    await db.query(
      `INSERT INTO project_member (project_id, employee_id, role, allocation_pct)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, project_id, employee_id) WHERE left_on IS NULL
       DO UPDATE SET role = $3, allocation_pct = $4, updated_at = now()`,
      [target.pid, target.eid, role, allocationPct]);

    const planned = await plannedPct(db, target.eid);

    await audit(db, caller, 'project_member_added', pKey,
      { employee: eKey, role, allocationPct });

    const { rows } = await db.query(
      `${MEMBER_COLUMNS} AND p.code = $1 AND m.employee_id = $2`, [pKey, target.eid]);
    const member = toMember(rows[0]!);

    const result: MembershipResult = { member };
    if (planned > 100) {
      result.warning = `${member.name} is now planned at ${planned}% across their `
        + 'live projects, which is more than their time.';
    }
    return result;
  });
}

/**
 * Take somebody off a project.
 *
 * `left_on`, not a delete: who was on a project last quarter is why a
 * timesheet from last quarter looks the way it does.
 */
export async function removeMember(
  caller: Caller, projectCode: string, employeeCode: string,
): Promise<void> {
  mayManageMembers(caller, 'take somebody off a project');

  await withTenant(caller, async (db) => {
    const pKey = projectCode.trim().toUpperCase();
    const eKey = employeeCode.trim().toUpperCase();

    const { rowCount } = await db.query(
      `UPDATE project_member m SET left_on = CURRENT_DATE, updated_at = now()
         WHERE m.left_on IS NULL
           AND m.project_id = (SELECT id FROM project WHERE code = $1)
           AND m.employee_id = (SELECT id FROM employee WHERE code = $2)`,
      [pKey, eKey]);

    if (rowCount === 0) {
      throw new ProjectError('that person is not on that project', 'not_found');
    }

    await audit(db, caller, 'project_member_removed', pKey, { employee: eKey });
  });
}
