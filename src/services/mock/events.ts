/**
 * Company events, in memory.
 *
 * The rules that matter are all about the room. You cannot sign up to
 * something you were not invited to, you cannot sign up after the list closed,
 * and a full event puts you on the waitlist rather than pretending there is a
 * chair. When somebody withdraws, the first person on that list takes the seat
 * — automatically, because a waitlist somebody has to work by hand is a
 * waitlist that never moves.
 *
 * The event belongs to its organiser. An administrator can do anything, and
 * the person running the event can do everything to that event — which is what
 * lets a department run its own things without a ticket to HR.
 */

import { sortBy } from '../../lib/collections';
import { uid } from '../../lib/rng';
import { TODAY, ymd } from '../../lib/dates';
import { EMAP } from '../../data/employees';
import { DEPTS, SITES } from '../../data/org';
import {
  EVENTS, EVENT_TYPES, RSVPS, RSVP_CHOICES, attendanceRate, audienceOf, eventKPI,
  goingCount, isFull, isInvited, isPast, rsvpClosed, rsvpOf, rsvpsFor, seatsLeft, waitlist,
} from '../../data/events';
import type { CompanyEvent, Rsvp } from '../../data/events';
import { recordAudit } from '../../data/audit';
import type {
  Caller, EventDetail, EventDraft, EventFilter, EventRow, EventService, RsvpRow,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));


const eventOf = (id: string) => EVENTS.find((e) => e.id === id);

const rowOf = (e: CompanyEvent, meId: string): EventRow => ({
  event: e,
  organiser: EMAP[e.organiserId]?.name ?? e.organiserId,
  audience: audienceOf(e).length,
  going: goingCount(e.id),
  maybe: rsvpsFor(e.id).filter((r) => r.response === 'Maybe').length,
  waitlisted: waitlist(e.id).length,
  seatsLeft: seatsLeft(e),
  full: isFull(e),
  past: isPast(e),
  closed: rsvpClosed(e),
  attendance: attendanceRate(e.id),
  /* Where the signed-in person stands, so the list needs no second call. */
  myResponse: rsvpOf(e.id, meId)?.response ?? null,
  invited: isInvited(e, meId),
});

const rsvpRow = (r: Rsvp): RsvpRow => ({
  rsvp: r,
  name: EMAP[r.empId]?.name ?? r.empId,
  dept: EMAP[r.empId]?.dept ?? '',
});

/** An event this caller runs, or is allowed to run. */
const mayManage = (c: Caller, e: CompanyEvent) =>
  c.role === 'admin' || e.organiserId === c.meId;

/**
 * What this caller can see at all.
 *
 * A draft is the organiser's working copy — nobody else sees it, because half
 * the point of a draft is being able to change your mind about the date
 * without forty people putting it in their calendar. Everything published is
 * visible to the people it is for, and to anybody who can manage events.
 */
function visible(c: Caller): CompanyEvent[] {
  if (c.role === 'admin') return EVENTS;
  return EVENTS.filter((e) =>
    e.organiserId === c.meId
    || (e.status !== 'Draft' && (isInvited(e, c.meId) || c.role === 'manager')));
}

function matches(r: EventRow, f: EventFilter): boolean {
  const e = r.event;
  if (f.type && e.type !== f.type) return false;
  if (f.status && e.status !== f.status) return false;
  if (f.site && e.site !== f.site) return false;
  if (f.organiserId && e.organiserId !== f.organiserId) return false;
  if (f.when === 'upcoming' && r.past) return false;
  if (f.when === 'past' && !r.past) return false;
  if (f.mineOnly && !r.myResponse) return false;
  if (f.from && e.endsOn < f.from) return false;
  if (f.to && e.on > f.to) return false;
  if (f.q?.trim()) {
    const hay = `${e.title} ${e.type} ${e.venue} ${e.desc}`.toLowerCase();
    if (!hay.includes(f.q.trim().toLowerCase())) return false;
  }
  return true;
}

const validate = (d: Partial<EventDraft>, existing?: CompanyEvent): string | null => {
  const title = d.title ?? existing?.title;
  if (!title?.trim()) return 'Give the event a title';
  const type = d.type ?? existing?.type;
  if (!type || !EVENT_TYPES.includes(type)) return 'Choose a kind of event';
  const on = d.on ?? existing?.on;
  if (!on) return 'Give the event a date';
  const endsOn = d.endsOn ?? existing?.endsOn ?? on;
  if (endsOn < on) return 'It cannot end before it starts';
  const online = d.online ?? existing?.online ?? false;
  const site = d.site ?? existing?.site ?? '';
  if (!online && !site) return 'Say where it is, or mark it online';
  if (site && !SITES.some((s) => s.id === site)) return 'No such site';
  const cap = d.capacity === undefined ? existing?.capacity : d.capacity;
  if (cap != null && (!Number.isFinite(cap) || cap < 1)) return 'A capacity is one seat or more';
  const rsvpBy = d.rsvpBy === undefined ? existing?.rsvpBy : d.rsvpBy;
  if (rsvpBy && rsvpBy > on) return 'The list cannot close after the event';
  for (const s of d.forSites ?? []) {
    if (!SITES.some((x) => x.id === s)) return `No such site: ${s}`;
  }
  for (const dp of d.forDepts ?? []) {
    if (!DEPTS.some((x) => x.id === dp)) return `No such department: ${dp}`;
  }
  return null;
};

/**
 * Give the freed seat to whoever has waited longest.
 *
 * Called on every withdrawal and on every capacity increase. Doing it here
 * rather than on read means the promotion is a recorded event with a time on
 * it, which is what somebody asking "when did I get in" needs.
 */
function promoteFromWaitlist(c: Caller, e: CompanyEvent) {
  if (e.capacity == null) return;
  let free = e.capacity - goingCount(e.id);
  for (const r of waitlist(e.id)) {
    if (free <= 0) break;
    r.response = 'Going';
    r.at = ymd(TODAY);
    free -= 1;
    recordAudit.write(c, 'event.waitlist_promoted', 'event', e.id,
      `${e.title} · ${EMAP[r.empId]?.name ?? r.empId}`);
  }
}

export const eventService: EventService = {
  list(c, f = {}) {
    const rows = visible(c).map((e) => rowOf(e, c.meId)).filter((r) => matches(r, f));
    return ok(sortBy(rows, (r) => r.event.on));
  },

  get(c, id) {
    const e = eventOf(id);
    if (!e) return ok(null);
    if (!visible(c).some((x) => x.id === id)) {
      return refuse('That event is not open to you');
    }
    /*
     * The attendee list is the organiser's and an administrator's. Everybody
     * else gets the counts — a headcount is useful, a named list of who is at
     * the wellness camp is somebody's business and not yours.
     */
    const canSeeNames = mayManage(c, e) || c.role === 'manager';
    const detail: EventDetail = {
      ...rowOf(e, c.meId),
      attendees: canSeeNames
        ? sortBy(rsvpsFor(e.id), (r) => EMAP[r.empId]?.name ?? r.empId).map(rsvpRow)
        : [],
      namesHidden: !canSeeNames,
      canManage: mayManage(c, e),
      history: recordAudit.forSubject('event', e.id),
    };
    return ok(detail);
  },

  /** What the signed-in person has said yes to, soonest first. */
  mine(c) {
    const rows = RSVPS
      .filter((r) => r.empId === c.meId && r.response !== 'Not going')
      .map((r) => eventOf(r.eventId))
      .filter((e): e is CompanyEvent => !!e && e.status === 'Published')
      .map((e) => rowOf(e, c.meId));
    return ok(sortBy(rows, (r) => r.event.on));
  },

  stats(c) {
    return ok(eventKPI(visible(c)));
  },

  create(c, draft) {
    /*
     * Anybody who runs a team can run an event. Requiring an administrator for
     * a team lunch is how a module like this ends up unused — and the organiser
     * is recorded, so it is never unclear who to ask about it.
     */
    if (c.role === 'employee') return refuse('Your role cannot create events');
    const bad = validate(draft);
    if (bad) return refuse(bad);

    const e: CompanyEvent = {
      id: uid('EVT'),
      title: draft.title.trim(),
      type: draft.type,
      desc: draft.desc?.trim() ?? '',
      on: draft.on,
      endsOn: draft.endsOn ?? draft.on,
      startAt: draft.startAt ?? '',
      endAt: draft.endAt ?? '',
      allDay: draft.allDay ?? false,
      site: draft.site ?? '',
      venue: draft.venue?.trim() ?? (draft.online ? 'Online' : ''),
      online: draft.online ?? false,
      capacity: draft.capacity ?? null,
      organiserId: draft.organiserId && c.role === 'admin' ? draft.organiserId : c.meId,
      forSites: draft.forSites ?? [],
      forDepts: draft.forDepts ?? [],
      /* Everything starts as a draft, so nothing lands in a calendar by accident. */
      status: 'Draft',
      rsvpBy: draft.rsvpBy ?? null,
      createdOn: ymd(TODAY),
      cancelledReason: '',
    };
    EVENTS.push(e);
    recordAudit.write(c, 'event.created', 'event', e.id, `${e.title} · ${e.on}`);
    return ok(e);
  },

  update(c, id, patch) {
    const e = eventOf(id);
    if (!e) return refuse('No such event');
    if (!mayManage(c, e)) return refuse('Only the organiser can change this event');
    if (e.status === 'Cancelled') return refuse('That event was cancelled');
    const bad = validate(patch, e);
    if (bad) return refuse(bad);

    /*
     * Shrinking the room below the people already holding a seat would leave
     * somebody with a confirmed place and nowhere to sit. Uninviting them is a
     * decision, not a side effect of typing a smaller number.
     */
    const held = goingCount(e.id);
    if (patch.capacity != null && patch.capacity < held) {
      return refuse(`${held} people already have a seat — move them off the list before cutting capacity to ${patch.capacity}`);
    }

    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify((patch as Record<string, unknown>)[k])
        !== JSON.stringify((e as unknown as Record<string, unknown>)[k]),
    );
    Object.assign(e, patch);
    if (changed.length) {
      recordAudit.write(c, 'event.updated', 'event', e.id, `${e.title} · ${changed.join(', ')}`);
    }
    /* A bigger room lets the waitlist in. */
    if (changed.includes('capacity')) promoteFromWaitlist(c, e);
    return ok(e);
  },

  publish(c, id) {
    const e = eventOf(id);
    if (!e) return refuse('No such event');
    if (!mayManage(c, e)) return refuse('Only the organiser can publish this event');
    if (e.status === 'Cancelled') return refuse('That event was cancelled');
    if (e.status === 'Published') return ok(e);
    if (isPast(e)) return refuse('That date has already passed');
    if (!audienceOf(e).length) {
      return refuse('Nobody matches the audience — widen it before publishing');
    }
    e.status = 'Published';
    recordAudit.write(c, 'event.published', 'event', e.id,
      `${e.title} · ${audienceOf(e).length} invited`);
    return ok(e);
  },

  cancel(c, id, reason) {
    const e = eventOf(id);
    if (!e) return refuse('No such event');
    if (!mayManage(c, e)) return refuse('Only the organiser can cancel this event');
    if (!reason?.trim()) {
      /* People have put this in their calendar. They are owed a reason. */
      return refuse('Say why it is cancelled — the people who signed up will see it');
    }
    e.status = 'Cancelled';
    e.cancelledReason = reason.trim();
    recordAudit.write(c, 'event.cancelled', 'event', e.id, `${e.title} · ${reason.trim()}`);
    return ok(e);
  },

  remove(c, id) {
    const i = EVENTS.findIndex((e) => e.id === id);
    if (i < 0) return refuse('No such event');
    const e = EVENTS[i];
    if (!mayManage(c, e)) return refuse('Only the organiser can delete this event');
    /*
     * Once people have responded, deleting takes the record of who said what
     * with it. Cancelling keeps the history and tells them why, which is why
     * it exists.
     */
    if (rsvpsFor(id).length) return refuse('People have responded — cancel it rather than deleting it');
    EVENTS.splice(i, 1);
    recordAudit.write(c, 'event.removed', 'event', e.id, e.title);
    return ok(e);
  },

  rsvp(c, eventId, choice) {
    const e = eventOf(eventId);
    if (!e) return refuse('No such event');
    if (!RSVP_CHOICES.includes(choice)) return refuse('Not an answer you can give');
    if (e.status === 'Draft') return refuse('That event has not been published yet');
    if (e.status === 'Cancelled') return refuse('That event was cancelled');
    if (!isInvited(e, c.meId)) return refuse('That event is not open to you');
    if (rsvpClosed(e)) {
      return refuse(e.rsvpBy
        ? `The list closed on ${e.rsvpBy}`
        : 'The list is closed — the event has started');
    }

    const existing = rsvpOf(eventId, c.meId);
    const was = existing?.response ?? null;

    /*
     * A full event does not refuse you; it puts you on the waitlist. Refusing
     * would make people email the organiser, which is the list, kept worse.
     * Somebody already holding a seat keeps it — changing your mind twice
     * should not cost you your place.
     */
    let response = choice as Rsvp['response'];
    if (choice === 'Going' && was !== 'Going' && isFull(e)) response = 'Waitlisted';

    if (existing) {
      existing.response = response;
      existing.at = ymd(TODAY);
    } else {
      RSVPS.push({
        id: uid('RSV'), eventId, empId: c.meId, response, at: ymd(TODAY), attended: null,
      });
    }

    recordAudit.write(c, 'event.rsvp', 'event', eventId,
      `${e.title} · ${EMAP[c.meId]?.name ?? c.meId} · ${response}`);

    /* Giving up a seat hands it to whoever has waited longest. */
    if (was === 'Going' && response !== 'Going') promoteFromWaitlist(c, e);

    return ok(rsvpOf(eventId, c.meId)!);
  },

  /** Somebody leaves the list entirely, rather than answering differently. */
  withdraw(c, eventId) {
    const i = RSVPS.findIndex((r) => r.eventId === eventId && r.empId === c.meId);
    if (i < 0) return refuse('You have not responded to that event');
    const e = eventOf(eventId);
    if (!e) return refuse('No such event');
    if (rsvpClosed(e)) return refuse('The list is closed');
    const [r] = RSVPS.splice(i, 1);
    recordAudit.write(c, 'event.rsvp_withdrawn', 'event', eventId,
      `${e.title} · ${EMAP[c.meId]?.name ?? c.meId}`);
    if (r.response === 'Going') promoteFromWaitlist(c, e);
    return ok(r);
  },

  markAttendance(c, eventId, empId, attended) {
    const e = eventOf(eventId);
    if (!e) return refuse('No such event');
    if (!mayManage(c, e)) return refuse('Only the organiser can mark the register');
    /*
     * A register for something that has not happened is a guess. Refusing it
     * is what keeps the attendance figure meaning what it says.
     */
    if (!isPast(e)) return refuse('That event has not happened yet');
    const r = rsvpOf(eventId, empId);
    if (!r) return refuse('That person did not respond to this event');
    r.attended = attended;
    recordAudit.write(c, 'event.attendance', 'event', eventId,
      `${e.title} · ${EMAP[empId]?.name ?? empId} · ${attended ? 'attended' : 'did not attend'}`);
    return ok(r);
  },
};
