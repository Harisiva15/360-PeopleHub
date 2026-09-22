/**
 * The room has a number of chairs in it, and the register says so.
 *
 * The capacity rules are the ones worth testing hardest, because every one of
 * them has a failure that looks fine on screen: a Maybe counted as a seat, a
 * waitlist that never moves, an over-subscribed event that nobody noticed
 * until the caterer arrived. Each is asserted against the underlying rows
 * rather than against the figure the module itself computes.
 */

import { getServices } from '../src/services';
import {
  EVENTS, RSVPS, attendanceRate, audienceOf, goingCount, isFull, isInvited,
  isPast, rsvpClosed, rsvpOf, rsvpsFor, seatsLeft, waitlist,
} from '../src/data/events';
import { ACTIVE, DEMO_EMP, DEMO_MGR, EMAP, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import { addDays, TODAY, ymd } from '../src/lib/dates';
import type { Caller, EventDraft } from '../src/services';

const s = getServices();
let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const refused = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'accepted', 'refused'); }
  catch { check(label, 'refused', 'refused'); }
};
const allowed = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'allowed', 'allowed'); }
  catch (e) { check(label, `refused: ${(e as Error).message}`, 'allowed'); }
};

const ADMIN: Caller = { role: 'admin', meId: HRHEAD.id };
const MANAGER: Caller = { role: 'manager', meId: DEMO_MGR.id };
const EMPLOYEE: Caller = { role: 'employee', meId: DEMO_EMP.id };
const NOW = ymd(TODAY);
const SOON = ymd(addDays(TODAY, 30));

(async () => {
  console.log(`\n${EVENTS.length} events, ${RSVPS.length} responses\n`);

  /*
   * Every state this module can be in has to exist in the data, or the checks
   * below pass while testing nothing. Counted out loud for the same reason.
   */
  const full = EVENTS.filter(isFull);
  const waitlisted = EVENTS.filter((e) => waitlist(e.id).length);
  const unmarked = EVENTS.filter((e) => e.status === 'Published' && isPast(e)
    && attendanceRate(e.id) === null);
  console.log(`  ${full.length} full, ${waitlisted.length} with a waitlist, `
    + `${EVENTS.filter((e) => e.status === 'Draft').length} drafts, `
    + `${EVENTS.filter((e) => e.status === 'Cancelled').length} cancelled, `
    + `${unmarked.length} registers unmarked\n`);

  check('at least one event is full', full.length > 0, true);
  check('at least one has a waitlist', waitlisted.length > 0, true);
  check('at least one is a draft',
    EVENTS.some((e) => e.status === 'Draft'), true);
  check('at least one register is unmarked', unmarked.length > 0, true);

  /* ---- the seat rules ---- */

  /*
   * The load-bearing one. A Maybe that quietly holds a chair would make every
   * capacity figure in the module wrong in the same direction.
   */
  check('a Maybe never holds a seat',
    EVENTS.filter((e) => goingCount(e.id)
      !== rsvpsFor(e.id).filter((r) => r.response === 'Going').length).length, 0);

  check('nothing is over-subscribed',
    EVENTS.filter((e) => e.capacity != null && goingCount(e.id) > e.capacity).length, 0);

  /*
   * A waitlist on an event with room to spare means somebody was left out of a
   * seat that existed — the failure the promotion logic is there to prevent.
   */
  check('nobody waits while a seat is free',
    EVENTS.filter((e) => waitlist(e.id).length && !isFull(e)).length, 0);

  check('an uncapped event has nobody waiting',
    EVENTS.filter((e) => e.capacity == null && waitlist(e.id).length).length, 0);

  check('seats left never goes negative',
    EVENTS.filter((e) => (seatsLeft(e) ?? 0) < 0).length, 0);

  check('nobody responds twice to one event',
    RSVPS.length, new Set(RSVPS.map((r) => `${r.eventId}:${r.empId}`)).size);

  check('every response belongs to an event that exists',
    RSVPS.filter((r) => !EVENTS.some((e) => e.id === r.eventId)).length, 0);

  check('nobody responded to an event they were not invited to',
    RSVPS.filter((r) => {
      const e = EVENTS.find((x) => x.id === r.eventId);
      return e && !isInvited(e, r.empId);
    }).length, 0);

  check('nobody responded to a draft',
    RSVPS.filter((r) => EVENTS.find((e) => e.id === r.eventId)?.status === 'Draft').length, 0);

  check('every event has somebody it is for',
    EVENTS.filter((e) => e.status !== 'Draft' && !audienceOf(e).length).length, 0);

  check('nothing ends before it starts',
    EVENTS.filter((e) => e.endsOn < e.on).length, 0);

  check('no list closes after its event',
    EVENTS.filter((e) => e.rsvpBy && e.rsvpBy > e.on).length, 0);

  check('nothing was answered in the future',
    RSVPS.filter((r) => r.at > NOW).length, 0);

  /*
   * A register marked on an event that has not happened would be a guess
   * presented as a record.
   */
  check('no future event has a marked register',
    EVENTS.filter((e) => !isPast(e) && rsvpsFor(e.id).some((r) => r.attended !== null)).length, 0);

  /* ---- the figures ---- */

  const rows = await s.events.list(ADMIN, {});
  check('an administrator sees every event', rows.length, EVENTS.length);
  check('the going figure matches the rows',
    rows.filter((r) => r.going !== goingCount(r.event.id)).length, 0);
  check('the full flag matches the rows',
    rows.filter((r) => r.full !== isFull(r.event)).length, 0);
  check('the closed flag matches the rules',
    rows.filter((r) => r.closed !== rsvpClosed(r.event)).length, 0);

  const stats = await s.events.stats(ADMIN);
  check('the waitlist figure is the sum of the waitlists',
    stats.waitlisted,
    EVENTS.filter((e) => e.status === 'Published' && !isPast(e))
      .reduce((n, e) => n + waitlist(e.id).length, 0));

  /*
   * Turnout is the mean across events rather than across people, so a
   * three-hundred-person town hall cannot drown out ten workshops.
   */
  const rated = EVENTS.filter((e) => e.status === 'Published' && isPast(e))
    .map((e) => attendanceRate(e.id)).filter((x): x is number => x !== null);
  check('turnout is the mean of the events, not of the people',
    stats.attendance, Math.round(rated.reduce((n, x) => n + x, 0) / rated.length));
  check('an unmarked register is left out rather than counted as zero',
    stats.unmarked, unmarked.length);

  /* ---- who sees what ---- */

  const empRows = await s.events.list(EMPLOYEE, {});
  check('an employee sees no drafts',
    empRows.filter((r) => r.event.status === 'Draft'
      && r.event.organiserId !== DEMO_EMP.id).length, 0);
  check('and nothing they are not invited to',
    empRows.filter((r) => !r.invited && r.event.organiserId !== DEMO_EMP.id).length, 0);

  const someoneElses = EVENTS.find((e) => e.status === 'Published' && !isInvited(e, DEMO_EMP.id));
  if (someoneElses) {
    await refused('an employee cannot open an event they are not invited to',
      () => s.events.get(EMPLOYEE, someoneElses.id));
  }

  const open = EVENTS.find((e) =>
    e.status === 'Published' && isInvited(e, DEMO_EMP.id) && !rsvpClosed(e))!;
  check('there is an open event to respond to', !!open, true);

  const detail = (await s.events.get(EMPLOYEE, open.id))!;
  check('an employee gets counts, not names', detail.namesHidden, true);
  check('and no attendee list', detail.attendees.length, 0);
  const asAdmin = (await s.events.get(ADMIN, open.id))!;
  check('an administrator gets the names', asAdmin.namesHidden, false);
  check('and the list matches the rows', asAdmin.attendees.length, rsvpsFor(open.id).length);

  const missing = await s.events.get(ADMIN, 'EVT-does-not-exist');
  check('an id that does not exist is null, not a refusal', missing, null);

  /* ---- responding ---- */

  await refused('not an answer anybody can give',
    () => s.events.rsvp(EMPLOYEE, open.id, 'Waitlisted' as never));

  const draft = EVENTS.find((e) => e.status === 'Draft')!;
  await refused('nobody can respond to a draft', () => s.events.rsvp(ADMIN, draft.id, 'Going'));

  const done = EVENTS.find((e) => e.status === 'Published' && isPast(e))!;
  await refused('nor to something that has happened',
    () => s.events.rsvp(ADMIN, done.id, 'Going'));

  const cancelled = EVENTS.find((e) => e.status === 'Cancelled');
  if (cancelled) {
    await refused('nor to something cancelled',
      () => s.events.rsvp(ADMIN, cancelled.id, 'Going'));
  }

  /* ---- the waitlist, which is the point ---- */

  const mkDraft = (over: Partial<EventDraft> = {}): EventDraft => ({
    title: `Check event ${Math.random().toString(36).slice(2, 7)}`,
    type: 'Training',
    on: SOON,
    online: true,
    capacity: 1,
    ...over,
  });

  await refused('an employee cannot create an event', () => s.events.create(EMPLOYEE, mkDraft()));
  const seat1 = await s.events.create(ADMIN, mkDraft());
  check('a new event starts as a draft', seat1.status, 'Draft');
  await refused('nobody can respond before it is published',
    () => s.events.rsvp(ADMIN, seat1.id, 'Going'));
  await allowed('the organiser publishes it', () => s.events.publish(ADMIN, seat1.id));

  /* One seat, two people. */
  const first = ACTIVE()[0];
  const second = ACTIVE()[1];
  const FIRST: Caller = { role: 'employee', meId: first.id };
  const SECOND: Caller = { role: 'employee', meId: second.id };

  const a = await s.events.rsvp(FIRST, seat1.id, 'Going');
  check('the first person gets the seat', a.response, 'Going');
  const b = await s.events.rsvp(SECOND, seat1.id, 'Going');
  check('the second is waitlisted rather than refused', b.response, 'Waitlisted');
  check('the event is full', isFull(EVENTS.find((e) => e.id === seat1.id)!), true);

  /* A Maybe on a full event is still just a Maybe — it takes no chair. */
  const third = ACTIVE()[2];
  const THIRD: Caller = { role: 'employee', meId: third.id };
  const m = await s.events.rsvp(THIRD, seat1.id, 'Maybe');
  check('a Maybe on a full event stays a Maybe', m.response, 'Maybe');
  check('and does not take the seat', goingCount(seat1.id), 1);

  /* The promotion, which is the whole reason the waitlist is worth having. */
  await s.events.rsvp(FIRST, seat1.id, 'Not going');
  check('giving up a seat promotes whoever waited longest',
    rsvpOf(seat1.id, second.id)?.response, 'Going');
  check('and the waitlist is empty again', waitlist(seat1.id).length, 0);

  /* Withdrawing entirely does the same. */
  const fourth = ACTIVE()[3];
  const FOURTH: Caller = { role: 'employee', meId: fourth.id };
  await s.events.rsvp(FOURTH, seat1.id, 'Going');
  check('the next person waits', rsvpOf(seat1.id, fourth.id)?.response, 'Waitlisted');
  await s.events.withdraw(SECOND, seat1.id);
  check('a withdrawal promotes them too',
    rsvpOf(seat1.id, fourth.id)?.response, 'Going');

  /* A bigger room lets the waitlist in. */
  const fifth = ACTIVE()[4];
  await s.events.rsvp({ role: 'employee', meId: fifth.id }, seat1.id, 'Going');
  check('and waits, because the room is still one seat',
    rsvpOf(seat1.id, fifth.id)?.response, 'Waitlisted');
  await s.events.update(ADMIN, seat1.id, { capacity: 2 });
  check('adding a seat promotes from the waitlist',
    rsvpOf(seat1.id, fifth.id)?.response, 'Going');

  /* And a smaller room does not throw anybody out silently. */
  await refused('capacity cannot be cut below the people holding a seat',
    () => s.events.update(ADMIN, seat1.id, { capacity: 1 }));

  /* ---- attendance ---- */

  await refused('the register cannot be marked before the event',
    () => s.events.markAttendance(ADMIN, seat1.id, fourth.id, true));
  await refused('nor for somebody who did not respond',
    () => s.events.markAttendance(ADMIN, done.id, 'EMP-nobody', true));
  await allowed('but can be, afterwards',
    () => s.events.markAttendance(ADMIN, done.id, rsvpsFor(done.id)[0].empId, true));

  /* ---- cancelling and deleting ---- */

  await refused('cancelling without a reason is refused',
    () => s.events.cancel(ADMIN, seat1.id, '   '));
  await refused('an event people have answered cannot be deleted',
    () => s.events.remove(ADMIN, seat1.id));
  await allowed('it is cancelled instead',
    () => s.events.cancel(ADMIN, seat1.id, 'Cancelled by the check'));

  const empty = await s.events.create(ADMIN, mkDraft());
  await allowed('an event nobody has answered can be deleted',
    () => s.events.remove(ADMIN, empty.id));

  /* ---- who may manage ---- */

  const mgrEvent = await s.events.create(MANAGER, mkDraft({ capacity: null }));
  check('a manager can run an event', mgrEvent.organiserId, DEMO_MGR.id);
  await refused("a manager cannot edit somebody else's event",
    () => s.events.update(MANAGER, done.id, { title: 'Not theirs to rename' }));
  await allowed('but can edit their own',
    () => s.events.update(MANAGER, mgrEvent.id, { title: 'Check event renamed' }));

  const noAudience = await s.events.create(ADMIN, mkDraft({
    forDepts: ['ENG'], forSites: ['LON'], online: false, site: 'CHN', venue: 'Nowhere',
  }));
  if (!audienceOf(EVENTS.find((e) => e.id === noAudience.id)!).length) {
    await refused('an event nobody matches cannot be published',
      () => s.events.publish(ADMIN, noAudience.id));
  }

  /* ---- the audit trail ---- */

  const trail = (await s.events.get(ADMIN, seat1.id))!.history.map((h) => h.action);
  check('creating is recorded', trail.includes('event.created'), true);
  check('publishing is recorded', trail.includes('event.published'), true);
  check('a response is recorded', trail.includes('event.rsvp'), true);
  check('a promotion is recorded', trail.includes('event.waitlist_promoted'), true);
  check('cancelling is recorded', trail.includes('event.cancelled'), true);

  /* ---- clean up ---- */

  const mine = new Set(EVENTS.filter((e) => e.title.startsWith('Check event')).map((e) => e.id));
  for (const r of RSVPS.filter((x) => mine.has(x.eventId))) RSVPS.splice(RSVPS.indexOf(r), 1);
  for (const e of EVENTS.filter((x) => mine.has(x.id))) EVENTS.splice(EVENTS.indexOf(e), 1);
  const marked = rsvpsFor(done.id)[0];
  if (marked) marked.attended = null;
  check('the check left no events behind',
    EVENTS.filter((e) => e.title.startsWith('Check event')).length, 0);
  check('and no orphaned responses',
    RSVPS.filter((r) => !EVENTS.some((e) => e.id === r.eventId)).length, 0);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} event checks failed`);
    process.exit(1);
  }
  console.log('the register is right about the chairs');
})();
