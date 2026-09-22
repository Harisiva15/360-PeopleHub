/*
 * Last in the RNG chain, after the development plans.
 */
import './devplans';

import { sortBy } from '../lib/collections';
import { addDays, daysBetween, parseYmd, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import { DEPTS, SITES } from './org';

/**
 * Company events — the things people have to say whether they are coming to.
 *
 * **This is not the celebrations calendar and not the noticeboard**, and the
 * difference is the whole reason it exists. A birthday happens to somebody
 * whether or not anybody responds; an announcement is read and forgotten. An
 * event has a room with a number of chairs in it, and somebody has to know how
 * many people are coming before they order the food. Everything here follows
 * from that: an audience, a capacity, an RSVP and, afterwards, who actually
 * turned up.
 *
 * **A "Maybe" does not hold a seat.** It is tempting to count it — the number
 * looks healthier — but the point of a capacity is to be right about chairs,
 * and half the maybes never come. Only Going and Waitlisted occupy a place.
 */

export const EVENT_TYPES = [
  'Town hall', 'Training', 'Offsite', 'Celebration', 'Wellness',
  'Hackathon', 'Community', 'Social',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['Draft', 'Published', 'Cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/**
 * The four answers, of which somebody may only choose three.
 *
 * Waitlisted is never something a person picks: it is what a full event does
 * with a Going, and what a withdrawal undoes. Keeping it in the same field is
 * what lets one query answer "where do I stand" without the screen having to
 * join two tables to find out.
 */
export const RSVP_CHOICES = ['Going', 'Maybe', 'Not going'] as const;
export type RsvpChoice = (typeof RSVP_CHOICES)[number];
export type RsvpResponse = RsvpChoice | 'Waitlisted';

export interface CompanyEvent {
  id: string;
  title: string;
  type: EventType;
  desc: string;
  /** A calendar day; multi-day events carry an end date. */
  on: string;
  endsOn: string;
  /** 24-hour, local to the venue. Empty where the event runs all day. */
  startAt: string;
  endAt: string;
  allDay: boolean;
  /** A site id, or the empty string where it is online only. */
  site: string;
  venue: string;
  online: boolean;
  /** Null where there is no limit — a town hall on a call has no chairs. */
  capacity: number | null;
  organiserId: string;
  /** Empty lists mean everybody; a list narrows it. */
  forSites: string[];
  forDepts: string[];
  status: EventStatus;
  /** After this, the organiser needs a headcount and the list closes. */
  rsvpBy: string | null;
  createdOn: string;
  cancelledReason: string;
}

export interface Rsvp {
  id: string;
  eventId: string;
  empId: string;
  response: RsvpResponse;
  at: string;
  /** Null until somebody marks the register, which only happens afterwards. */
  attended: boolean | null;
}

export const EVENTS: CompanyEvent[] = [];
export const RSVPS: Rsvp[] = [];

/* ---------------- who an event is for ---------------- */

/**
 * Whether somebody is invited.
 *
 * Empty lists mean everybody, which is the common case and reads better than
 * seeding every event with all eight sites. A person must match on both axes
 * where both are narrowed — a Chennai engineering event is for engineers in
 * Chennai, not for every engineer and every person in Chennai.
 */
export function isInvited(e: CompanyEvent, empId: string): boolean {
  const emp = EMAP[empId];
  if (!emp || emp.status !== 'Active') return false;
  if (e.forSites.length && !e.forSites.includes(emp.site)) return false;
  if (e.forDepts.length && !e.forDepts.includes(emp.dept)) return false;
  return true;
}

export const audienceOf = (e: CompanyEvent) => ACTIVE().filter((x) => isInvited(e, x.id));

export const rsvpsFor = (eventId: string) => RSVPS.filter((r) => r.eventId === eventId);

export const rsvpOf = (eventId: string, empId: string) =>
  RSVPS.find((r) => r.eventId === eventId && r.empId === empId);

/** Going and Waitlisted take a chair; Maybe does not. */
export const holdsASeat = (r: Rsvp) => r.response === 'Going';

export const goingCount = (eventId: string) => rsvpsFor(eventId).filter(holdsASeat).length;

export const waitlist = (eventId: string) =>
  sortBy(rsvpsFor(eventId).filter((r) => r.response === 'Waitlisted'), (r) => r.at);

export const seatsLeft = (e: CompanyEvent): number | null =>
  e.capacity == null ? null : Math.max(0, e.capacity - goingCount(e.id));

export const isFull = (e: CompanyEvent): boolean =>
  e.capacity != null && goingCount(e.id) >= e.capacity;

export const isPast = (e: CompanyEvent, asOf = ymd(TODAY)): boolean => e.endsOn < asOf;

/** The list closes at the deadline, or when the day arrives if there is none. */
export const rsvpClosed = (e: CompanyEvent, asOf = ymd(TODAY)): boolean =>
  e.status !== 'Published' || (e.rsvpBy ? e.rsvpBy < asOf : e.on < asOf);

/**
 * Who turned up, of those who said they would.
 *
 * Only meaningful once the register has been marked, so it is null rather than
 * zero before that — a fresh event showing "0% attendance" would read as a
 * disaster rather than as an unanswered question.
 */
export function attendanceRate(eventId: string): number | null {
  const marked = rsvpsFor(eventId).filter((r) => r.attended !== null);
  if (!marked.length) return null;
  return Math.round((marked.filter((r) => r.attended).length / marked.length) * 100);
}

/* ---------------- the seed ---------------- */

const SEEDS: { title: string; type: EventType; desc: string; cap: number | null; online: boolean; hrs: [string, string]; depts?: string[] }[] = [
  {
    title: 'Quarterly all-hands',
    type: 'Town hall',
    desc: 'Results for the quarter, what changed in the plan, and the floor open for questions. Recorded for anyone who cannot make it live.',
    cap: null, online: true, hrs: ['16:00', '17:30'],
  },
  {
    title: 'Deepavali celebration',
    type: 'Celebration',
    desc: 'Lunch, rangoli and the annual best-dressed contest nobody admits to preparing for. Families welcome.',
    cap: 180, online: false, hrs: ['12:00', '16:00'],
  },
  {
    title: 'Engineering offsite',
    type: 'Offsite',
    desc: 'Two days away from the desk: the architecture we are committing to next year, and the parts of it nobody has agreed on yet.',
    cap: 60, online: false, hrs: ['09:00', '18:00'], depts: ['ENG', 'QA', 'DEVOPS'],
  },
  {
    title: 'POSH refresher workshop',
    type: 'Training',
    desc: 'The annual session, run by an external facilitator. Attendance is recorded against the compliance register.',
    cap: 40, online: false, hrs: ['10:00', '12:00'],
  },
  {
    title: 'Internal hackathon',
    type: 'Hackathon',
    desc: 'Thirty-six hours, any idea that touches a customer problem. Teams of up to four. Judging on the Saturday afternoon.',
    cap: 72, online: false, hrs: ['09:00', '21:00'], depts: ['ENG', 'QA', 'DEVOPS', 'PROD'],
  },
  {
    title: 'Health check-up camp',
    type: 'Wellness',
    desc: 'Full blood panel, BP and BMI, with a consultation slot. Reports go to you directly and to nobody else.',
    cap: 120, online: false, hrs: ['09:30', '16:30'],
  },
  {
    title: 'Blood donation drive',
    type: 'Community',
    desc: 'Run with the Rotary blood bank. Bring photo ID, eat beforehand, and take the rest of the afternoon off.',
    cap: 50, online: false, hrs: ['10:00', '15:00'],
  },
  {
    title: 'New joiner welcome breakfast',
    type: 'Social',
    desc: 'Everyone who joined in the last quarter, and whoever wants to come and say hello.',
    cap: 45, online: false, hrs: ['08:30', '10:00'],
  },
  {
    title: 'Manager essentials: difficult conversations',
    type: 'Training',
    desc: 'A half day on the conversations people put off. Bring a real situation; you will not have to name anybody.',
    cap: 24, online: false, hrs: ['14:00', '17:30'],
  },
  {
    title: 'Sales kick-off',
    type: 'Town hall',
    desc: 'Territory, targets and the compensation plan for the year, followed by dinner.',
    cap: 40, online: false, hrs: ['15:00', '20:00'], depts: ['SALES'],
  },
  {
    title: 'Family day',
    type: 'Celebration',
    desc: 'The one day a year the office belongs to the children. Games, food and a magician who is better than he needs to be.',
    cap: 250, online: false, hrs: ['10:00', '17:00'],
  },
  {
    title: 'Security awareness briefing',
    type: 'Training',
    desc: 'What phishing looks like this year, and the three things that would have stopped every incident we have had.',
    cap: null, online: true, hrs: ['11:00', '12:00'],
  },
];

const VENUES = [
  'Palladium auditorium, 5th floor', 'Training room A', 'The terrace',
  'Ecospace conference hall', 'Cyber Towers, room 402', 'Cafeteria',
];

(function genEvents() {
  const organisers = ACTIVE().filter((e) =>
    ['HR', 'SALES'].includes(e.dept) || /Manager|Head|Lead|Director/i.test(e.designation));
  const organiser = () => (organisers.length ? pick(organisers).id : ACTIVE()[0].id);

  /*
   * A calendar, not a list of one-offs.
   *
   * The things a company actually runs repeat — there are four all-hands a
   * year, not one — and a register with a single instance of each makes both
   * the past and the future look thin. The recurring ones appear three times,
   * the rest once.
   */
  const REPEAT: EventType[] = ['Town hall', 'Training', 'Wellness'];
  /* The kinds of event that only make sense in the room they happen in. */
  const LOCAL: EventType[] = ['Wellness', 'Community', 'Social', 'Celebration'];
  const occurrences = SEEDS.flatMap((seed) =>
    Array.from({ length: REPEAT.includes(seed.type) ? 3 : 1 }, () => seed));

  occurrences.forEach((seed, i) => {
    /*
     * Spread evenly across a year either side of today rather than drawn at
     * random. Eighteen random offsets cluster — the first version left one
     * published event ahead and five drafts, which is not a calendar — and an
     * even spread with jitter gives a past to mark and a future to sign up to.
     */
    const span = Math.max(1, occurrences.length - 1);
    const offset = -180 + Math.round((i / span) * 360) + ri(-14, 14);
    const on = ymd(addDays(TODAY, offset));
    const days = seed.type === 'Offsite' || seed.type === 'Hackathon' ? 1 : 0;

    const online = seed.online && chance(0.8);
    /*
     * The room is in an office somebody works in.
     *
     * Drawing uniformly from the site list put the family day in the Toronto
     * office, where four people work — a 250-seat event for an audience of
     * four, which is not a realistic register and not a useful screen. Sites
     * are weighted by headcount instead, so events land where the people are.
     */
    const staffed = SITES.filter((x) => !x.remote && ACTIVE().some((p) => p.site === x.id));
    const site = online ? '' : pick(
      staffed.flatMap((x) => Array(Math.max(1, Math.round(
        ACTIVE().filter((p) => p.site === x.id).length / 10))).fill(x.id) as string[]),
    );

    const e: CompanyEvent = {
      id: uid('EVT'),
      title: seed.title,
      type: seed.type,
      desc: seed.desc,
      on,
      endsOn: ymd(addDays(parseYmd(on), days)),
      startAt: seed.hrs[0],
      endAt: seed.hrs[1],
      allDay: days > 0,
      site,
      venue: online ? 'Online' : pick(VENUES),
      online,
      capacity: null,
      organiserId: organiser(),
      /*
       * Only local events are restricted to their site.
       *
       * A town hall is company-wide by definition, and restricting one to the
       * office it happens to be broadcast from produced an all-hands for five
       * people. The things that genuinely only make sense where they are held
       * — a health camp, a blood drive, a breakfast — are the ones that carry
       * the restriction.
       */
      forSites: site && LOCAL.includes(seed.type) && chance(0.8) ? [site] : [],
      forDepts: seed.depts ?? [],
      /* The two furthest out are still being planned. Deterministic rather
         than a coin flip: a state that exists only when the dice agree is a
         screen nobody can demonstrate and a branch nothing exercises. */
      status: i >= occurrences.length - 2 ? 'Draft' : 'Published',
      rsvpBy: seed.cap != null ? ymd(addDays(parseYmd(on), -3)) : null,
      createdOn: ymd(addDays(parseYmd(on), -ri(21, 60))),
      cancelledReason: '',
    };

    /*
     * An event nobody is invited to is a data error, not a quiet edge case.
     *
     * Narrowing on both axes at once produced exactly that — a sales kick-off
     * held at an office with no sales people, audience zero. Where the two
     * filters have no overlap the site restriction is the one to drop: the
     * department is what the event is *about*, and the room is only where it
     * happens.
     */
    if (e.forSites.length && !audienceOf(e).length) e.forSites = [];

    /*
     * Capacity is set against the audience, not in the abstract.
     *
     * The first version wrote the room sizes down as constants — 40 for the
     * workshop, 180 for Deepavali — and then narrowed half the events to one
     * office. A 50-seat blood drive invited to twenty people is never full,
     * and the whole waitlist mechanism sat there unreachable. Sizing the room
     * as a share of the people invited is what makes some events fill and
     * others not, which is the state this module is for. The seed figure
     * survives as a ceiling: no room here holds more than it did.
     */
    e.capacity = seed.cap == null
      ? null
      : Math.max(8, Math.min(seed.cap, Math.round(audienceOf(e).length * pick([0.2, 0.3, 0.45]))));

    EVENTS.push(e);
  });

  /* One cancelled event, because the state exists and needs to look like itself. */
  const toCancel = EVENTS.find((e) => e.status === 'Published' && !isPast(e));
  if (toCancel) {
    toCancel.status = 'Cancelled';
    toCancel.cancelledReason = 'The facilitator pulled out; being rescheduled for next quarter.';
  }

  /* RSVPs. Nobody responds to a draft, because nobody can see one. */
  EVENTS.filter((e) => e.status !== 'Draft').forEach((e) => {
    const invited = audienceOf(e);
    /* Interest varies by the kind of thing it is, which is what makes some
       events full and others half empty — the state the module exists to show. */
    const appetite = {
      'Town hall': 0.55, Training: 0.4, Offsite: 0.8, Celebration: 0.75,
      Wellness: 0.5, Hackathon: 0.3, Community: 0.25, Social: 0.45,
    }[e.type];

    invited.forEach((emp) => {
      if (!chance(appetite)) return;
      const choice: RsvpChoice = chance(0.7) ? 'Going' : chance(0.55) ? 'Maybe' : 'Not going';
      const at = ymd(addDays(parseYmd(e.on), -ri(1, 25)));

      /*
       * Capacity is applied as the answers arrive, exactly as the service
       * does it. Seeding past the limit and tidying up afterwards would
       * produce a register the live rules could never have created.
       */
      let response: RsvpResponse = choice;
      if (choice === 'Going' && e.capacity != null && goingCount(e.id) >= e.capacity) {
        response = 'Waitlisted';
      }

      RSVPS.push({
        id: uid('RSV'),
        eventId: e.id,
        empId: emp.id,
        response,
        at: at > ymd(TODAY) ? ymd(TODAY) : at,
        attended: null,
      });
    });
  });

  /*
   * The register, for events that have already happened — but not all of them.
   *
   * Marking every past event would make "registers still to mark" permanently
   * zero, which is a KPI that can never light up and therefore tells nobody
   * anything. Some organisers do not get round to it, and that is the number
   * the figure is for.
   */
  EVENTS.filter((e) => e.status === 'Published' && isPast(e) && chance(0.7)).forEach((e) => {
    rsvpsFor(e.id).forEach((r) => {
      if (r.response === 'Not going') { r.attended = false; return; }
      if (r.response === 'Maybe') { r.attended = chance(0.35); return; }
      /* Most people who said yes turned up, and some did not. */
      r.attended = chance(0.86);
    });
  });
})();

/* ---------------- the figures ---------------- */

export function eventKPI(scope: CompanyEvent[] = EVENTS, asOf = ymd(TODAY)) {
  const live = scope.filter((e) => e.status === 'Published');
  const upcoming = live.filter((e) => !isPast(e, asOf));
  const past = live.filter((e) => isPast(e, asOf));
  const rated = past.map((e) => attendanceRate(e.id)).filter((x): x is number => x !== null);

  return {
    upcoming: upcoming.length,
    thisMonth: upcoming.filter((e) => e.on.slice(0, 7) === asOf.slice(0, 7)).length,
    drafts: scope.filter((e) => e.status === 'Draft').length,
    cancelled: scope.filter((e) => e.status === 'Cancelled').length,
    /* Seats held across everything still to come — what the caterer needs. */
    going: upcoming.reduce((n, e) => n + goingCount(e.id), 0),
    waitlisted: upcoming.reduce((n, e) => n + waitlist(e.id).length, 0),
    full: upcoming.filter(isFull).length,
    past: past.length,
    /* The mean of the events, not of the people — a 300-person town hall
       should not drown out ten workshops when asking whether people show up. */
    attendance: rated.length
      ? Math.round(rated.reduce((n, x) => n + x, 0) / rated.length)
      : null,
    unmarked: past.filter((e) => attendanceRate(e.id) === null).length,
  };
}

/** Upcoming events, soonest first — the list everybody actually wants. */
export const upcomingEvents = (asOf = ymd(TODAY)) =>
  sortBy(EVENTS.filter((e) => e.status === 'Published' && !isPast(e, asOf)), (e) => e.on);

export const daysUntil = (e: CompanyEvent, asOf = ymd(TODAY)) => daysBetween(asOf, e.on);

export const deptName = (id: string) => DEPTS.find((d) => d.id === id)?.name ?? id;
