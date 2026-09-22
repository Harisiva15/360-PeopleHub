/**
 * Company events.
 *
 * **The waitlist is the part that has to be right.** A full event does not
 * refuse a Going — it waitlists it — and when somebody gives up a seat the
 * person who has waited longest takes it, without anybody doing anything. A
 * waitlist worked by hand never moves.
 *
 * That promotion runs inside the same transaction as the withdrawal, and it
 * locks the event row first. Two people dropping out at the same instant would
 * otherwise both read "one free seat" and promote the same person twice, or
 * promote two people into one chair. `SELECT ... FOR UPDATE` on the event is
 * what serialises them; it is the only lock in this file and it is here for
 * exactly that.
 *
 * **A Maybe holds no seat.** Counting maybes makes the number look healthier
 * and the capacity wrong, which is the one thing a capacity must not be.
 *
 * **Counts are public, names are not.** Everybody sees how many are coming —
 * that is what tells you whether to bother. Who is at the wellness camp is the
 * organiser's business.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class EventError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'EventError';
    this.code = code;
  }
}

export interface CompanyEvent {
  id: string; title: string; type: string; desc: string;
  on: string; endsOn: string; startAt: string; endAt: string; allDay: boolean;
  site: string; venue: string; online: boolean; capacity: number | null;
  organiserId: string; forSites: string[]; forDepts: string[];
  status: string; rsvpBy: string | null; createdOn: string; cancelledReason: string;
}

export interface EventRow {
  event: CompanyEvent; organiser: string; audience: number;
  going: number; maybe: number; waitlisted: number;
  seatsLeft: number | null; full: boolean; past: boolean; closed: boolean;
  attendance: number | null; myResponse: string | null; invited: boolean;
}

export interface EventFilter {
  q?: string | undefined; type?: string | undefined; status?: string | undefined;
  site?: string | undefined; organiserId?: string | undefined;
  when?: 'upcoming' | 'past' | undefined; mineOnly?: boolean | undefined;
  from?: string | undefined; to?: string | undefined;
}

export interface EventDraft {
  title: string; type: string; desc?: string | undefined;
  on: string; endsOn?: string | undefined;
  startAt?: string | undefined; endAt?: string | undefined;
  allDay?: boolean | undefined; site?: string | undefined;
  venue?: string | undefined; online?: boolean | undefined;
  capacity?: number | null | undefined; organiserId?: string | undefined;
  forSites?: string[] | undefined; forDepts?: string[] | undefined;
  rsvpBy?: string | null | undefined;
}

/**
 * Whether somebody is invited, as a SQL predicate.
 *
 * Empty arrays mean everybody. Both narrow together: a Chennai engineering
 * event is for engineers in Chennai, not for every engineer and everyone in
 * Chennai. `@>` on an empty array is always true, which is why the
 * cardinality test comes first and reads the way the rule is written.
 */
const INVITED = (empAlias: string) => `(
  (cardinality(ev.for_sites) = 0 OR ${empAlias}.site_id = ANY(ev.for_sites))
  AND (cardinality(ev.for_departments) = 0 OR ${empAlias}.department_id = ANY(ev.for_departments))
  AND ${empAlias}.status <> 'exited'
)`;

interface Row {
  id: string; title: string; kind: string; description: string;
  starts_on: string; ends_on: string; start_at: string; end_at: string;
  all_day: boolean; site_code: string | null; venue: string; online: boolean;
  capacity: number | null; organiser_id: string; organiser: string;
  for_site_codes: string[]; for_dept_codes: string[];
  status: string; rsvp_by: string | null; created_on: string;
  cancelled_reason: string;
  audience: string; going: string; maybe: string; waitlisted: string;
  marked: string; attended: string; my_response: string | null; invited: boolean;
}

/*
 * Site and department are returned as *codes*, because every screen resolves
 * them against static config keyed by code. The uuid arrays stay server-side.
 */
const PROJECTION = (meId: string) => `
  SELECT ev.id, ev.title, ev.kind, ev.description,
         ev.starts_on::text, ev.ends_on::text, ev.start_at, ev.end_at,
         ev.all_day, s.code AS site_code, ev.venue, ev.online, ev.capacity,
         ev.organiser_id, org.full_name AS organiser,
         COALESCE((SELECT array_agg(x.code) FROM site x WHERE x.id = ANY(ev.for_sites)), '{}')
           AS for_site_codes,
         COALESCE((SELECT array_agg(x.code) FROM department x WHERE x.id = ANY(ev.for_departments)), '{}')
           AS for_dept_codes,
         ev.status, ev.rsvp_by::text, ev.created_on::text, ev.cancelled_reason,
         (SELECT count(*) FROM employee a WHERE ${INVITED('a')})::text AS audience,
         c.going::text, c.maybe::text, c.waitlisted::text,
         c.marked::text, c.attended::text,
         (SELECT r.response FROM event_rsvp r
           WHERE r.event_id = ev.id AND r.employee_id = ${meId}) AS my_response,
         COALESCE((SELECT ${INVITED('me')} FROM employee me WHERE me.id = ${meId}), FALSE)
           AS invited
    FROM company_event ev
    JOIN employee org ON org.id = ev.organiser_id
    LEFT JOIN site s ON s.id = ev.site_id
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE r.response = 'Going')      AS going,
             count(*) FILTER (WHERE r.response = 'Maybe')      AS maybe,
             count(*) FILTER (WHERE r.response = 'Waitlisted') AS waitlisted,
             count(*) FILTER (WHERE r.attended IS NOT NULL)    AS marked,
             count(*) FILTER (WHERE r.attended)                AS attended
        FROM event_rsvp r WHERE r.event_id = ev.id
    ) c ON TRUE`;

const today = () => new Date().toISOString().slice(0, 10);

function toRow(r: Row): EventRow {
  const going = Number(r.going);
  const marked = Number(r.marked);
  const past = r.ends_on < today();
  const closed = r.status !== 'Published' || (r.rsvp_by ? r.rsvp_by < today() : r.starts_on < today());
  return {
    event: {
      id: r.id, title: r.title, type: r.kind, desc: r.description,
      on: r.starts_on, endsOn: r.ends_on, startAt: r.start_at, endAt: r.end_at,
      allDay: r.all_day, site: r.site_code ?? '', venue: r.venue, online: r.online,
      capacity: r.capacity, organiserId: r.organiser_id,
      forSites: r.for_site_codes ?? [], forDepts: r.for_dept_codes ?? [],
      status: r.status, rsvpBy: r.rsvp_by, createdOn: r.created_on,
      cancelledReason: r.cancelled_reason,
    },
    organiser: r.organiser,
    audience: Number(r.audience),
    going,
    maybe: Number(r.maybe),
    waitlisted: Number(r.waitlisted),
    seatsLeft: r.capacity === null ? null : Math.max(0, r.capacity - going),
    full: r.capacity !== null && going >= r.capacity,
    past,
    closed,
    /* Null rather than zero before the register is marked: "not answered" is
       a different thing from "nobody came". */
    attendance: marked ? Math.round((Number(r.attended) / marked) * 100) : null,
    myResponse: r.my_response,
    invited: r.invited,
  };
}

/**
 * What this caller can see at all.
 *
 * A draft is the organiser's working copy — half the point of a draft is being
 * able to change your mind about the date without forty people putting it in
 * their calendar.
 */
function visibility(caller: Caller, params: unknown[]): string {
  if (caller.role === 'admin') return 'TRUE';
  params.push(caller.employeeId);
  const me = `$${params.length}`;
  const invited = `EXISTS (SELECT 1 FROM employee me WHERE me.id = ${me} AND ${INVITED('me')})`;
  if (caller.role === 'manager') {
    return `(ev.organiser_id = ${me} OR ev.status <> 'Draft')`;
  }
  return `(ev.organiser_id = ${me} OR (ev.status <> 'Draft' AND ${invited}))`;
}

export async function listEvents(caller: Caller, f: EventFilter = {}): Promise<EventRow[]> {
  const params: unknown[] = [];
  /* $1 is always the caller, because the projection refers to it by position. */
  params.push(caller.employeeId);
  const where: string[] = [visibility(caller, params)];
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.type) where.push(`ev.kind = ${bind(f.type)}`);
  if (f.status) where.push(`ev.status = ${bind(f.status)}`);
  if (f.site) where.push(`s.code = ${bind(f.site)}`);
  if (f.organiserId) where.push(`ev.organiser_id = ${bind(f.organiserId)}`);
  if (f.when === 'upcoming') where.push('ev.ends_on >= CURRENT_DATE');
  if (f.when === 'past') where.push('ev.ends_on < CURRENT_DATE');
  if (f.from) where.push(`ev.ends_on >= ${bind(f.from)}`);
  if (f.to) where.push(`ev.starts_on <= ${bind(f.to)}`);
  if (f.mineOnly) {
    where.push(`EXISTS (SELECT 1 FROM event_rsvp r
                         WHERE r.event_id = ev.id AND r.employee_id = $1)`);
  }
  if (f.q?.trim()) {
    const p = bind(`%${f.q.trim()}%`);
    where.push(`(ev.title ILIKE ${p} OR ev.venue ILIKE ${p} OR ev.description ILIKE ${p})`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION('$1')} WHERE ${where.join(' AND ')} ORDER BY ev.starts_on`, params);
    return rows.map(toRow);
  });
}

export interface EventDetail extends EventRow {
  attendees: { rsvp: { id: string; eventId: string; empId: string; response: string;
    at: string; attended: boolean | null }; name: string; dept: string }[];
  namesHidden: boolean;
  canManage: boolean;
  history: unknown[];
}

export async function getEvent(caller: Caller, id: string): Promise<EventDetail | null> {
  const params: unknown[] = [caller.employeeId];
  const vis = visibility(caller, params);
  params.push(id);
  const idP = `$${params.length}`;

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION('$1')} WHERE ev.id = ${idP} AND (${vis})`, params);
    if (!rows[0]) {
      const { rows: exists } = await db.query('SELECT 1 FROM company_event WHERE id = $1', [id]);
      if (exists.length) throw new EventError('That event is not open to you', 'forbidden');
      return null;
    }
    const row = toRow(rows[0]);
    const canManage = caller.role === 'admin' || row.event.organiserId === caller.employeeId;
    const canSeeNames = canManage || caller.role === 'manager';

    const attendees = canSeeNames
      ? (await db.query<{
        id: string; employee_id: string; response: string; responded_on: string;
        attended: boolean | null; name: string; dept_code: string | null;
      }>(
        `SELECT r.id, r.employee_id, r.response, r.responded_on::text, r.attended,
                e.full_name AS name, d.code AS dept_code
           FROM event_rsvp r
           JOIN employee e ON e.id = r.employee_id
           LEFT JOIN department d ON d.id = e.department_id
          WHERE r.event_id = $1 ORDER BY e.full_name`,
        [id],
      )).rows.map((a) => ({
        rsvp: {
          id: a.id, eventId: id, empId: a.employee_id, response: a.response,
          at: a.responded_on, attended: a.attended,
        },
        name: a.name,
        dept: a.dept_code ?? '',
      }))
      : [];

    return { ...row, attendees, namesHidden: !canSeeNames, canManage, history: [] };
  });
}

export async function myEvents(caller: Caller): Promise<EventRow[]> {
  return listEvents(caller, { mineOnly: true, status: 'Published' });
}

export async function eventStats(caller: Caller) {
  const rows = await listEvents(caller);
  const live = rows.filter((r) => r.event.status === 'Published');
  const upcoming = live.filter((r) => !r.past);
  const past = live.filter((r) => r.past);
  const rated = past.map((r) => r.attendance).filter((x): x is number => x !== null);
  const month = today().slice(0, 7);
  return {
    upcoming: upcoming.length,
    thisMonth: upcoming.filter((r) => r.event.on.slice(0, 7) === month).length,
    drafts: rows.filter((r) => r.event.status === 'Draft').length,
    cancelled: rows.filter((r) => r.event.status === 'Cancelled').length,
    going: upcoming.reduce((n, r) => n + r.going, 0),
    waitlisted: upcoming.reduce((n, r) => n + r.waitlisted, 0),
    full: upcoming.filter((r) => r.full).length,
    past: past.length,
    /* The mean across events, not across people: a 300-person town hall should
       not drown out ten workshops when asking whether people show up. */
    attendance: rated.length
      ? Math.round(rated.reduce((n, x) => n + x, 0) / rated.length)
      : null,
    unmarked: past.filter((r) => r.attendance === null).length,
  };
}

const mayCreate = (caller: Caller) => {
  if (caller.role === 'employee') {
    throw new EventError('Your role cannot create events', 'forbidden');
  }
};

async function loadManageable(db: TenantClient, caller: Caller, id: string) {
  const { rows } = await db.query<{
    organiser_id: string; status: string; title: string; ends_on: string;
    capacity: number | null;
  }>(
    `SELECT organiser_id, status, title, ends_on::text, capacity
       FROM company_event WHERE id = $1`, [id]);
  const ev = rows[0];
  if (!ev) throw new EventError('No such event', 'not_found');
  if (caller.role !== 'admin' && ev.organiser_id !== caller.employeeId) {
    throw new EventError('Only the organiser can change this event', 'forbidden');
  }
  return ev;
}

/** Resolve a list of codes to ids, refusing any that does not exist. */
async function codesToIds(
  db: TenantClient,
  table: 'site' | 'department',
  codes: string[],
): Promise<string[]> {
  if (!codes.length) return [];
  const { rows } = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM ${table} WHERE code = ANY($1)`, [codes]);
  const missing = codes.filter((c) => !rows.some((r) => r.code === c));
  if (missing.length) throw new EventError(`No such ${table}: ${missing[0]}`, 'invalid');
  return rows.map((r) => r.id);
}

export async function createEvent(caller: Caller, d: EventDraft): Promise<CompanyEvent> {
  mayCreate(caller);
  if (!d.title?.trim()) throw new EventError('Give the event a title', 'invalid');
  if (!d.on) throw new EventError('Give the event a date', 'invalid');
  if (d.endsOn && d.endsOn < d.on) throw new EventError('It cannot end before it starts', 'invalid');
  if (!d.online && !d.site) throw new EventError('Say where it is, or mark it online', 'invalid');
  if (d.capacity != null && d.capacity < 1) throw new EventError('A capacity is one seat or more', 'invalid');
  if (d.rsvpBy && d.rsvpBy > d.on) throw new EventError('The list cannot close after the event', 'invalid');

  return withTenant(caller, async (db) => {
    const siteId = d.site
      ? (await db.query<{ id: string }>('SELECT id FROM site WHERE code = $1', [d.site])).rows[0]?.id
      : null;
    if (d.site && !siteId) throw new EventError('No such site', 'invalid');

    const forSites = await codesToIds(db, 'site', d.forSites ?? []);
    const forDepts = await codesToIds(db, 'department', d.forDepts ?? []);

    const organiser = d.organiserId && caller.role === 'admin' ? d.organiserId : caller.employeeId;
    if (!organiser) throw new EventError('An event needs an organiser', 'invalid');

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO company_event
         (title, kind, description, starts_on, ends_on, start_at, end_at, all_day,
          site_id, venue, online, capacity, organiser_id, for_sites, for_departments,
          status, rsvp_by)
       VALUES ($1,$2,$3,$4,COALESCE($5::date,$4::date),$6,$7,$8,$9,$10,$11,$12,$13,
               $14::uuid[],$15::uuid[],'Draft',$16)
       RETURNING id`,
      [d.title.trim(), d.type, d.desc ?? '', d.on, d.endsOn ?? null,
        d.startAt ?? '', d.endAt ?? '', d.allDay ?? false, siteId,
        d.venue?.trim() ?? (d.online ? 'Online' : ''), d.online ?? false,
        d.capacity ?? null, organiser, forSites, forDepts, d.rsvpBy ?? null],
    );
    const made = await getEvent(caller, rows[0]!.id);
    if (!made) throw new EventError('The event was not created', 'invalid');
    return made.event;
  });
}

export async function updateEvent(
  caller: Caller,
  id: string,
  patch: Partial<EventDraft>,
): Promise<CompanyEvent> {
  return withTenant(caller, async (db) => {
    const ev = await loadManageable(db, caller, id);
    if (ev.status === 'Cancelled') throw new EventError('That event was cancelled', 'invalid');

    if (patch.capacity != null) {
      const { rows } = await db.query<{ going: string }>(
        `SELECT count(*)::text AS going FROM event_rsvp
          WHERE event_id = $1 AND response = 'Going'`, [id]);
      const held = Number(rows[0]?.going ?? 0);
      /*
       * Shrinking below the people already seated would leave somebody with a
       * confirmed place and nowhere to sit. Uninviting them is a decision, not
       * a side effect of typing a smaller number.
       */
      if (patch.capacity < held) {
        throw new EventError(
          `${held} people already have a seat — move them off the list before cutting capacity to ${patch.capacity}`,
          'in_use');
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.title !== undefined) set('title', patch.title.trim());
    if (patch.type !== undefined) set('kind', patch.type);
    if (patch.desc !== undefined) set('description', patch.desc);
    if (patch.on !== undefined) set('starts_on', patch.on);
    if (patch.endsOn !== undefined) set('ends_on', patch.endsOn);
    if (patch.startAt !== undefined) set('start_at', patch.startAt);
    if (patch.endAt !== undefined) set('end_at', patch.endAt);
    if (patch.allDay !== undefined) set('all_day', patch.allDay);
    if (patch.venue !== undefined) set('venue', patch.venue);
    if (patch.online !== undefined) set('online', patch.online);
    if (patch.capacity !== undefined) set('capacity', patch.capacity);
    if (patch.rsvpBy !== undefined) set('rsvp_by', patch.rsvpBy);
    if (patch.site !== undefined) {
      const { rows } = await db.query<{ id: string }>(
        'SELECT id FROM site WHERE code = $1', [patch.site]);
      if (!rows[0]) throw new EventError('No such site', 'invalid');
      set('site_id', rows[0].id);
    }
    if (patch.forSites !== undefined) {
      params.push(await codesToIds(db, 'site', patch.forSites));
      sets.push(`for_sites = $${params.length}::uuid[]`);
    }
    if (patch.forDepts !== undefined) {
      params.push(await codesToIds(db, 'department', patch.forDepts));
      sets.push(`for_departments = $${params.length}::uuid[]`);
    }

    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE company_event SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    /* A bigger room lets the waitlist in. */
    if (patch.capacity !== undefined) await promote(db, id);

    const after = await getEvent(caller, id);
    if (!after) throw new EventError('No such event', 'not_found');
    return after.event;
  });
}

export async function publishEvent(caller: Caller, id: string): Promise<CompanyEvent> {
  return withTenant(caller, async (db) => {
    const ev = await loadManageable(db, caller, id);
    if (ev.status === 'Cancelled') throw new EventError('That event was cancelled', 'invalid');
    if (ev.ends_on < today()) throw new EventError('That date has already passed', 'invalid');

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM employee a, company_event ev
        WHERE ev.id = $1 AND ${INVITED('a')}`, [id]);
    /*
     * An event nobody matches is a data error, not a quiet edge case — and the
     * moment to catch it is before forty people fail to be invited.
     */
    if (Number(rows[0]?.n ?? 0) === 0) {
      throw new EventError('Nobody matches the audience — widen it before publishing', 'invalid');
    }

    await db.query(`UPDATE company_event SET status = 'Published' WHERE id = $1`, [id]);
    const after = await getEvent(caller, id);
    if (!after) throw new EventError('No such event', 'not_found');
    return after.event;
  });
}

export async function cancelEvent(
  caller: Caller,
  id: string,
  reason: string,
): Promise<CompanyEvent> {
  /* People have put this in their calendar. They are owed a reason. */
  if (!reason?.trim()) {
    throw new EventError('Say why it is cancelled — the people who signed up will see it', 'invalid');
  }
  return withTenant(caller, async (db) => {
    await loadManageable(db, caller, id);
    await db.query(
      `UPDATE company_event SET status = 'Cancelled', cancelled_reason = $1 WHERE id = $2`,
      [reason.trim(), id]);
    const after = await getEvent(caller, id);
    if (!after) throw new EventError('No such event', 'not_found');
    return after.event;
  });
}

export async function removeEvent(caller: Caller, id: string): Promise<CompanyEvent> {
  /* Read it before deleting: the contract hands the removed event back. */
  const existing = await getEvent(caller, id);
  if (!existing) throw new EventError('No such event', 'not_found');

  return withTenant(caller, async (db) => {
    await loadManageable(db, caller, id);
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM event_rsvp WHERE event_id = $1', [id]);
    /*
     * Deleting takes the record of who said what with it. Cancelling keeps the
     * history and tells them why, which is why it exists.
     */
    if (Number(rows[0]?.n ?? 0) > 0) {
      throw new EventError('People have responded — cancel it rather than deleting it', 'in_use');
    }
    await db.query('DELETE FROM company_event WHERE id = $1', [id]);
    return existing.event;
  });
}

/**
 * Give the freed seats to whoever has waited longest.
 *
 * The caller must already hold the event row's lock. Called after every
 * withdrawal and every capacity increase.
 */
async function promote(db: TenantClient, eventId: string): Promise<void> {
  await db.query(
    `WITH ev AS (
       SELECT capacity,
              capacity - (SELECT count(*) FROM event_rsvp r
                           WHERE r.event_id = $1 AND r.response = 'Going') AS free
         FROM company_event WHERE id = $1
     ),
     next AS (
       SELECT r.id FROM event_rsvp r, ev
        WHERE r.event_id = $1 AND r.response = 'Waitlisted'
          AND ev.capacity IS NOT NULL AND ev.free > 0
        ORDER BY r.responded_on, r.id
        LIMIT (SELECT GREATEST(free, 0) FROM ev)
     )
     UPDATE event_rsvp SET response = 'Going', responded_on = CURRENT_DATE
      WHERE id IN (SELECT id FROM next)`,
    [eventId]);
}

export async function rsvp(caller: Caller, eventId: string, choice: string) {
  if (!['Going', 'Maybe', 'Not going'].includes(choice)) {
    throw new EventError('Not an answer you can give', 'invalid');
  }
  if (!caller.employeeId) throw new EventError('You have no employee record', 'forbidden');

  return withTenant(caller, async (db) => {
    /*
     * Lock the event before reading the seat count. Without this, two people
     * answering at the same instant both read "one seat left" and both get it.
     */
    const { rows: evs } = await db.query<{
      status: string; capacity: number | null; rsvp_by: string | null; starts_on: string;
    }>(
      `SELECT status, capacity, rsvp_by::text, starts_on::text
         FROM company_event WHERE id = $1 FOR UPDATE`, [eventId]);
    const ev = evs[0];
    if (!ev) throw new EventError('No such event', 'not_found');
    if (ev.status === 'Draft') throw new EventError('That event has not been published yet', 'invalid');
    if (ev.status === 'Cancelled') throw new EventError('That event was cancelled', 'invalid');

    const closed = ev.rsvp_by ? ev.rsvp_by < today() : ev.starts_on < today();
    if (closed) {
      throw new EventError(
        ev.rsvp_by ? `The list closed on ${ev.rsvp_by}` : 'The list is closed — the event has started',
        'closed');
    }

    const { rows: inv } = await db.query(
      `SELECT 1 FROM employee me, company_event ev
        WHERE ev.id = $1 AND me.id = $2 AND ${INVITED('me')}`,
      [eventId, caller.employeeId]);
    if (!inv.length) throw new EventError('That event is not open to you', 'forbidden');

    const { rows: mine } = await db.query<{ response: string }>(
      'SELECT response FROM event_rsvp WHERE event_id = $1 AND employee_id = $2',
      [eventId, caller.employeeId]);
    const was = mine[0]?.response ?? null;

    let response = choice;
    if (choice === 'Going' && was !== 'Going' && ev.capacity !== null) {
      const { rows: c } = await db.query<{ going: string }>(
        `SELECT count(*)::text AS going FROM event_rsvp
          WHERE event_id = $1 AND response = 'Going'`, [eventId]);
      /*
       * A full event does not refuse you; it puts you on the waitlist.
       * Refusing would make people email the organiser, which is the list,
       * kept worse. Somebody already holding a seat keeps it.
       */
      if (Number(c[0]!.going) >= ev.capacity) response = 'Waitlisted';
    }

    const { rows } = await db.query<{
      id: string; response: string; responded_on: string; attended: boolean | null;
    }>(
      `INSERT INTO event_rsvp (event_id, employee_id, response)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, event_id, employee_id)
       DO UPDATE SET response = EXCLUDED.response, responded_on = CURRENT_DATE
       RETURNING id, response, responded_on::text, attended`,
      [eventId, caller.employeeId, response]);

    /* Giving up a seat hands it to whoever has waited longest. */
    if (was === 'Going' && response !== 'Going') await promote(db, eventId);

    const r = rows[0]!;
    return {
      id: r.id, eventId, empId: caller.employeeId!, response: r.response,
      at: r.responded_on, attended: r.attended,
    };
  });
}

export async function withdrawRsvp(caller: Caller, eventId: string) {
  return withTenant(caller, async (db) => {
    const { rows: evs } = await db.query<{ rsvp_by: string | null; starts_on: string; status: string }>(
      `SELECT rsvp_by::text, starts_on::text, status
         FROM company_event WHERE id = $1 FOR UPDATE`, [eventId]);
    const ev = evs[0];
    if (!ev) throw new EventError('No such event', 'not_found');
    const closed = ev.status !== 'Published'
      || (ev.rsvp_by ? ev.rsvp_by < today() : ev.starts_on < today());
    if (closed) throw new EventError('The list is closed', 'closed');

    const { rows } = await db.query<{
      id: string; response: string; responded_on: string; attended: boolean | null;
    }>(
      `DELETE FROM event_rsvp WHERE event_id = $1 AND employee_id = $2
       RETURNING id, response, responded_on::text, attended`,
      [eventId, caller.employeeId]);
    const r = rows[0];
    if (!r) throw new EventError('You have not responded to that event', 'not_found');

    if (r.response === 'Going') await promote(db, eventId);
    return {
      id: r.id, eventId, empId: caller.employeeId!, response: r.response,
      at: r.responded_on, attended: r.attended,
    };
  });
}

export async function markAttendance(
  caller: Caller,
  eventId: string,
  empId: string,
  attended: boolean,
) {
  return withTenant(caller, async (db) => {
    const ev = await loadManageable(db, caller, eventId);
    /* A register for something that has not happened is a guess. */
    if (ev.ends_on >= today()) throw new EventError('That event has not happened yet', 'invalid');

    const { rows } = await db.query<{
      id: string; response: string; responded_on: string; attended: boolean | null;
    }>(
      `UPDATE event_rsvp SET attended = $1
        WHERE event_id = $2 AND employee_id = $3
       RETURNING id, response, responded_on::text, attended`,
      [attended, eventId, empId]);
    const r = rows[0];
    if (!r) throw new EventError('That person did not respond to this event', 'not_found');
    return {
      id: r.id, eventId, empId, response: r.response,
      at: r.responded_on, attended: r.attended,
    };
  });
}
