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
  if (caller.role !== 'admin') {
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
