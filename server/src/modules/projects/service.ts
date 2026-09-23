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
 * Read-only, deliberately. Creating and editing projects is delivery
 * administration and belongs with whoever owns the staffing module; this
 * exists so a timesheet can name a real project.
 */

import { withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

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

const ymd = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

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
    const { rows } = await db.query(
      `SELECT p.code, p.name, p.billable, p.active, p.starts_on, p.ends_on,
              COALESCE(c.name, 'Internal') AS client
         FROM project p
         LEFT JOIN client c ON c.id = p.client_id
        ORDER BY p.active DESC, p.name`);
    return rows.map((r) => ({
      id: r.code as string,
      name: r.name as string,
      client: r.client as string,
      billable: Boolean(r.billable),
      active: Boolean(r.active),
      startsOn: ymd(r.starts_on),
      endsOn: ymd(r.ends_on),
    }));
  });
}
