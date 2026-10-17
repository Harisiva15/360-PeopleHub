/**
 * The noticeboard — announcements and celebrations.
 *
 * **The audience filter is applied in SQL, not in the browser.** An
 * announcement can be addressed to one department, and the obvious shortcut is
 * to send the whole board and let the screen hide what does not apply. That is
 * not hiding, it is decoration: the rows are still in the response, and anyone
 * who opens the network tab reads the post about their own team's
 * restructuring. So the `WHERE` clause decides, and an employee is never sent
 * a post they are not an audience for.
 *
 * The same argument covers `expires_on`. An expired post is not shown *and not
 * sent*, so "taken down" means taken down.
 *
 * **Celebrations are computed from dates the server already holds** — the
 * birthday and joining date — and deliberately return no year of birth, only
 * the day. A leaver's dates disappear with them, because the query only reads
 * active employees.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class NoticeboardError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'NoticeboardError';
    this.code = code;
  }
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  by: string;
  dept: string;
  on: string;
  pin: boolean;
  tag: string;
}

export interface Celebration {
  kind: 'birthday' | 'anniversary';
  empId: string;
  date: string;
  inDays: number;
  years?: number;
}

export interface NewAnnouncement {
  title: string;
  body: string;
  tag: string;
  pin: boolean;
  dept: string;
}

/**
 * Everything the caller is an audience for.
 *
 * `$1` is the reader's employee id. A post with no department is for everyone;
 * a post with one is for that department only. Admins read the whole board,
 * which is the one case where the audience is widened rather than narrowed —
 * and it is widened by the caller's role, not by anything they can send.
 */
const PROJECTION = `
  SELECT a.id, a.title, a.body, a.published_on, a.pinned, a.category,
         COALESCE(auth.full_name, 'System') AS author_name,
         COALESCE(d.code, 'All') AS dept_code
    FROM announcement a
    LEFT JOIN employee auth ON auth.id = a.author_id
    LEFT JOIN department d ON d.id = a.department_id
   WHERE (a.expires_on IS NULL OR a.expires_on >= CURRENT_DATE)
     AND ($2::boolean
          OR a.department_id IS NULL
          OR a.department_id = (SELECT e.department_id FROM employee e WHERE e.id = $1))
   ORDER BY a.pinned DESC, a.published_on DESC, a.title`;

const toAnnouncement = (r: Record<string, unknown>): Announcement => ({
  id: r.id as string,
  title: r.title as string,
  body: r.body as string,
  by: r.author_name as string,
  dept: r.dept_code as string,
  on: r.published_on as string,
  pin: Boolean(r.pinned),
  tag: (r.category as string) ?? 'General',
});

async function board(db: TenantClient, caller: Caller): Promise<Announcement[]> {
  const { rows } = await db.query(PROJECTION, [caller.employeeId, caller.role === 'admin']);
  return rows.map(toAnnouncement);
}

export async function listAnnouncements(caller: Caller): Promise<Announcement[]> {
  return withTenantReadOnly(caller, (db) => board(db, caller));
}

/**
 * Post to the board.
 *
 * The author is the session, never the request. A field the client could fill
 * in is a field it could fill in with somebody else's name, and an
 * announcement carries the weight of whoever appears to have written it.
 */
export async function postAnnouncement(
  caller: Caller,
  draft: NewAnnouncement,
): Promise<Announcement[]> {
  if (caller.role === 'employee') {
    throw new NoticeboardError('only a manager or admin may post', 'forbidden');
  }
  const title = (draft.title ?? '').trim();
  const body = (draft.body ?? '').trim();
  if (!title) throw new NoticeboardError('an announcement needs a title', 'invalid');
  if (!body) throw new NoticeboardError('an announcement needs a body', 'invalid');

  return withTenant(caller, async (db) => {
    // 'All' and an unknown code both mean everyone. An unknown code failing
    // loudly would be defensible; silently narrowing the audience would not,
    // so the fallback is the wider one.
    const dept = draft.dept && draft.dept !== 'All'
      ? (await db.query('SELECT id FROM department WHERE code = $1', [draft.dept])).rows[0]?.id
      : null;

    await db.query(
      `INSERT INTO announcement (title, body, category, pinned, author_id, department_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [title, body, draft.tag || 'General', Boolean(draft.pin), caller.employeeId, dept ?? null]);

    return board(db, caller);
  });
}

/** Only the author or an admin may change a post after it is up. */
async function ownPost(db: TenantClient, caller: Caller, id: string): Promise<void> {
  const { rows } = await db.query(
    'SELECT author_id FROM announcement WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new NoticeboardError('no such announcement', 'not_found');
  if (caller.role !== 'admin' && rows[0].author_id !== caller.employeeId) {
    throw new NoticeboardError('you can only change your own posts', 'forbidden');
  }
}

export async function setPinned(
  caller: Caller,
  id: string,
  pinned: boolean,
): Promise<Announcement[]> {
  if (caller.role === 'employee') {
    throw new NoticeboardError('only a manager or admin may pin a post', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    await ownPost(db, caller, id);
    await db.query('UPDATE announcement SET pinned = $2 WHERE id = $1', [id, pinned]);
    return board(db, caller);
  });
}

export async function removeAnnouncement(caller: Caller, id: string): Promise<Announcement[]> {
  if (caller.role === 'employee') {
    throw new NoticeboardError('only a manager or admin may take a post down', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    await ownPost(db, caller, id);
    await db.query('DELETE FROM announcement WHERE id = $1', [id]);
    return board(db, caller);
  });
}

/**
 * Birthdays and work anniversaries in the next `days` days.
 *
 * The arithmetic is in SQL because "the next occurrence of this month and day"
 * has to cross the year boundary, and doing it here would mean shipping every
 * employee's date of birth to the caller to find the handful that fall soon.
 * Only the day and month are returned; the year of birth stays in the table.
 */
export async function listCelebrations(caller: Caller, days: number): Promise<Celebration[]> {
  const window = Number.isFinite(days) ? Math.max(0, Math.min(366, Math.trunc(days))) : 30;

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `WITH occ AS (
         SELECT e.id,
                e.date_of_birth,
                e.joined_on,
                -- This year's occurrence, rolled forward if it has passed.
                CASE WHEN e.date_of_birth IS NULL THEN NULL
                     WHEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int,
                                    EXTRACT(MONTH FROM e.date_of_birth)::int,
                                    EXTRACT(DAY FROM e.date_of_birth)::int) >= CURRENT_DATE
                     THEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int,
                                    EXTRACT(MONTH FROM e.date_of_birth)::int,
                                    EXTRACT(DAY FROM e.date_of_birth)::int)
                     ELSE make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1,
                                    EXTRACT(MONTH FROM e.date_of_birth)::int,
                                    EXTRACT(DAY FROM e.date_of_birth)::int)
                END AS next_birthday,
                CASE WHEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int,
                                    EXTRACT(MONTH FROM e.joined_on)::int,
                                    EXTRACT(DAY FROM e.joined_on)::int) >= CURRENT_DATE
                     THEN make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int,
                                    EXTRACT(MONTH FROM e.joined_on)::int,
                                    EXTRACT(DAY FROM e.joined_on)::int)
                     ELSE make_date(EXTRACT(YEAR FROM CURRENT_DATE)::int + 1,
                                    EXTRACT(MONTH FROM e.joined_on)::int,
                                    EXTRACT(DAY FROM e.joined_on)::int)
                END AS next_anniversary
           FROM employee e
          -- Deliberately not status = 'active': someone serving notice is
          -- still here, and the directory already counts them as active.
          -- Only leavers drop out.
          WHERE e.status <> 'exited'
       )
       SELECT 'birthday' AS kind, id, next_birthday AS date,
              (next_birthday - CURRENT_DATE)::int AS in_days, NULL::int AS years
         FROM occ
        WHERE next_birthday IS NOT NULL
          AND next_birthday - CURRENT_DATE <= $1
       UNION ALL
       SELECT 'anniversary', id, next_anniversary,
              (next_anniversary - CURRENT_DATE)::int,
              (EXTRACT(YEAR FROM age(next_anniversary, joined_on))::int)
         FROM occ
        WHERE next_anniversary - CURRENT_DATE <= $1
          -- Nobody celebrates their zeroth year on the day they join.
          AND EXTRACT(YEAR FROM age(next_anniversary, joined_on))::int > 0
        ORDER BY 4, 2`, [window]);

    return rows.map((r) => ({
      kind: r.kind as 'birthday' | 'anniversary',
      empId: r.id as string,
      date: r.date as string,
      inDays: Number(r.in_days),
      ...(r.years === null ? {} : { years: Number(r.years) }),
    }));
  });
}
