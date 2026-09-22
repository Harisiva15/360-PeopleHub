/**
 * Company events.
 *
 * The screen is built around the one thing an event asks of you: say whether
 * you are coming. So the answer is the largest control on every card, the
 * consequence of pressing it is written next to it — "3 seats left", "you will
 * be 4th on the waitlist" — and a closed list shows why rather than a dead
 * button.
 *
 * Counts are public; names are not. Everybody sees how many are coming,
 * because that is what tells you whether to bother. Who is coming to the
 * wellness camp is the organiser's business and not the company's.
 */

import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { fmtD, fmtDS, fmtTime } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { DEPTS, SITES, deptOf, siteOf } from '../../data/org';
import { EVENT_TYPES, RSVP_CHOICES } from '../../services';
import type {
  EventDetail, EventDraft, EventFilter, EventRow, EventStatus, EventType,
  RsvpChoice, RsvpResponse,
} from '../../services';
import {
  Avatar, Badge, Banner, Bar, Card, EmptyState, KV, StatRow, Tabs, Tile,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useCancelEvent, useCreateEvent, useEvent, useEventStats, useEvents, useMarkAttendance,
  useMyEvents, usePublishEvent, useRemoveEvent, useRsvp, useUpdateEvent,
  useWithdraw,
} from './data';

type Tab = 'upcoming' | 'mine' | 'past';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const STATUS_TONE: Record<EventStatus, 'good' | 'warn' | 'mute'> = {
  Published: 'good', Draft: 'warn', Cancelled: 'mute',
};

const RSVP_TONE: Record<RsvpResponse, 'good' | 'warn' | 'info' | 'mute'> = {
  Going: 'good', Waitlisted: 'info', Maybe: 'warn', 'Not going': 'mute',
};

const when = (e: EventRow['event']) => {
  const day = e.on === e.endsOn ? fmtDS(e.on) : `${fmtDS(e.on)} – ${fmtDS(e.endsOn)}`;
  if (e.allDay || !e.startAt) return day;
  return `${day} · ${fmtTime(e.startAt)}–${fmtTime(e.endAt)}`;
};

const place = (e: EventRow['event']) =>
  e.online ? 'Online' : `${e.venue}${e.site ? ` · ${siteOf(e.site).name}` : ''}`;

/* ---------------- saying whether you are coming ---------------- */

/**
 * The answer buttons, with the consequence written underneath.
 *
 * A "Going" on a full event does not put you in the room, and finding that out
 * after pressing it is the sort of thing people remember about software. The
 * line below the buttons says what will happen before it happens.
 */
function RsvpControl({ r, onDone }: { r: EventRow; onDone?: () => void }) {
  const app = useApp();
  const rsvp = useRsvp();
  const withdraw = useWithdraw();

  if (!r.invited) {
    return <span className="muted" style={{ fontSize: 12 }}>Not open to you</span>;
  }
  if (r.event.status === 'Cancelled') {
    return <Badge kind="mute">Cancelled</Badge>;
  }
  if (r.closed) {
    return (
      <div className="stack" style={{ gap: 4 }}>
        {r.myResponse
          ? <Badge kind={RSVP_TONE[r.myResponse]}>{r.myResponse}</Badge>
          : <span className="muted" style={{ fontSize: 12 }}>You did not respond</span>}
        <span className="muted" style={{ fontSize: 11 }}>
          {r.past ? 'This has happened' : `The list closed${r.event.rsvpBy ? ` on ${fmtD(r.event.rsvpBy)}` : ''}`}
        </span>
      </div>
    );
  }

  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); onDone?.(); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  /* What pressing Going will actually do, said before it is pressed. */
  const goingLands = r.myResponse === 'Going'
    ? null
    : r.full
      ? `Full — you would be ${r.waitlisted + 1}${r.waitlisted === 0 ? 'st' : r.waitlisted === 1 ? 'nd' : r.waitlisted === 2 ? 'rd' : 'th'} on the waitlist`
      : r.seatsLeft != null ? `${r.seatsLeft} seat${r.seatsLeft === 1 ? '' : 's'} left` : null;

  return (
    <div className="stack" style={{ gap: 5 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {RSVP_CHOICES.map((choice: RsvpChoice) => (
          <button
            key={choice}
            className={'btn sm' + (r.myResponse === choice ? ' primary' : '')}
            aria-pressed={r.myResponse === choice}
            disabled={rsvp.pending}
            onClick={() => act(() => rsvp.mutate(r.event.id, choice), `Marked ${choice}`)}
          >
            {choice}
          </button>
        ))}
        {r.myResponse && (
          <button className="btn ghost sm" disabled={withdraw.pending}
            onClick={() => act(() => withdraw.mutate(r.event.id), 'Response withdrawn')}>
            Clear
          </button>
        )}
      </div>
      {r.myResponse === 'Waitlisted' && (
        <span className="muted" style={{ fontSize: 11 }}>
          You are on the waitlist — a seat comes to you if somebody drops out.
        </span>
      )}
      {goingLands && (
        <span className="muted" style={{ fontSize: 11 }}>{goingLands}</span>
      )}
    </div>
  );
}

/* ---------------- the form ---------------- */

function EventForm({ existing, close }: { existing?: EventDetail; close: () => void }) {
  const app = useApp();
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const e = existing?.event;

  const [d, setD] = useState<EventDraft>({
    title: e?.title ?? '',
    type: e?.type ?? 'Town hall',
    desc: e?.desc ?? '',
    on: e?.on ?? '',
    endsOn: e?.endsOn ?? '',
    startAt: e?.startAt ?? '',
    endAt: e?.endAt ?? '',
    allDay: e?.allDay ?? false,
    site: e?.site ?? '',
    venue: e?.venue ?? '',
    online: e?.online ?? false,
    capacity: e?.capacity ?? null,
    forSites: e?.forSites ?? [],
    forDepts: e?.forDepts ?? [],
    rsvpBy: e?.rsvpBy ?? null,
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof EventDraft>(k: K, v: EventDraft[K]) => setD({ ...d, [k]: v });

  const toggle = (k: 'forSites' | 'forDepts', v: string) => {
    const cur = d[k] ?? [];
    set(k, cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };

  const save = async () => {
    setErr('');
    try {
      if (e) await update.mutate(e.id, d);
      else await create.mutate(d);
      app.toast(e ? 'Event updated' : 'Event created as a draft', 'ok');
      close();
    } catch (x) { setErr(msg(x, 'Could not save the event')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not saved">{err}</Banner>}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <label>Title <span className="req">*</span></label>
          <input className="input" value={d.title} autoFocus placeholder="Quarterly all-hands"
            onChange={(x) => set('title', x.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Kind <span className="req">*</span></label>
          <select className="input" value={d.type}
            onChange={(x) => set('type', x.target.value as EventType)}>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label>What it is</label>
        <textarea className="input" rows={3} value={d.desc ?? ''}
          placeholder="What will happen, and anything people need to bring or know."
          onChange={(x) => set('desc', x.target.value)} />
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Date <span className="req">*</span></label>
          <input className="input" type="date" value={d.on}
            onChange={(x) => set('on', x.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Ends</label>
          <input className="input" type="date" value={d.endsOn ?? ''}
            onChange={(x) => set('endsOn', x.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>From</label>
          <input className="input" type="time" value={d.startAt ?? ''}
            onChange={(x) => set('startAt', x.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>To</label>
          <input className="input" type="time" value={d.endAt ?? ''}
            onChange={(x) => set('endAt', x.target.value)} />
        </div>
      </div>

      <div className="field">
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={d.online ?? false}
            onChange={(x) => set('online', x.target.checked)} />
          <span>It happens online</span>
        </label>
      </div>

      {!d.online && (
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Office <span className="req">*</span></label>
            <select className="input" value={d.site ?? ''}
              onChange={(x) => set('site', x.target.value)}>
              <option value="">Choose an office</option>
              {SITES.filter((s) => !s.remote).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>Room</label>
            <input className="input" value={d.venue ?? ''} placeholder="Training room A"
              onChange={(x) => set('venue', x.target.value)} />
          </div>
        </div>
      )}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Seats</label>
          <input className="input" type="number" min={1} value={d.capacity ?? ''}
            placeholder="No limit"
            onChange={(x) => set('capacity', x.target.value ? Number(x.target.value) : null)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>List closes</label>
          <input className="input" type="date" value={d.rsvpBy ?? ''}
            onChange={(x) => set('rsvpBy', x.target.value || null)} />
        </div>
      </div>

      {d.capacity != null && (
        <Banner kind="info" icon={<Icon n="info" size="lg" />} title="What happens when it fills">
          Once {d.capacity} people have a seat, anybody else saying Going joins a
          waitlist. If somebody drops out the seat goes to whoever has waited
          longest, without anybody having to do anything.
        </Banner>
      )}

      <div className="field">
        <label>Who it is for</label>
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
          Choose nothing and it is for everybody. Choosing from both lists means
          both must match — engineers in Chennai, not every engineer and everyone
          in Chennai.
        </div>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginBottom: 8 }}>
          {SITES.filter((s) => !s.remote).map((s) => (
            <button key={s.id} type="button"
              className={'chip' + ((d.forSites ?? []).includes(s.id) ? ' on' : '')}
              aria-pressed={(d.forSites ?? []).includes(s.id)}
              onClick={() => toggle('forSites', s.id)}>
              {s.city}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
          {DEPTS.map((dp) => (
            <button key={dp.id} type="button"
              className={'chip' + ((d.forDepts ?? []).includes(dp.id) ? ' on' : '')}
              aria-pressed={(d.forDepts ?? []).includes(dp.id)}
              onClick={() => toggle('forDepts', dp.id)}>
              {dp.name}
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={create.pending || update.pending} onClick={save}>
          {e ? 'Save event' : 'Create draft'}
        </button>
      </div>
    </div>
  );
}

function CancelForm({ id, title, close }: { id: string; title: string; close: () => void }) {
  const app = useApp();
  const cancel = useCancelEvent();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');

  const run = async () => {
    setErr('');
    try { await cancel.mutate(id, reason); app.toast('Event cancelled', 'ok'); close(); }
    catch (e) { setErr(msg(e, 'Could not cancel')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not cancelled">{err}</Banner>}
      <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="People have this in their calendar">
        Everybody who responded to {title} will see this reason. Say what happened
        and whether it is coming back.
      </Banner>
      <div className="field">
        <label>Why <span className="req">*</span></label>
        <textarea className="input" rows={3} value={reason} autoFocus
          placeholder="The facilitator pulled out; being rescheduled for next quarter."
          onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Keep it</button>
        <button className="btn danger" disabled={!reason.trim() || cancel.pending} onClick={run}>
          Cancel the event
        </button>
      </div>
    </div>
  );
}

/* ---------------- the detail ---------------- */

function EventDetailView({ id }: { id: string }) {
  const app = useApp();
  const layer = useLayer();
  const { data: d, loading, error } = useEvent(id);
  const publish = usePublishEvent();
  const remove = useRemoveEvent();
  const mark = useMarkAttendance();
  const [tab, setTab] = useState<'about' | 'who' | 'history'>('about');

  if (error) return <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />;
  if (!d) return <EmptyState msg={loading ? 'Loading…' : 'No such event'} />;

  const e = d.event;
  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); }
    catch (x) { app.toast(msg(x, 'That did not work'), 'err'); }
  };

  const going = d.attendees.filter((a) => a.rsvp.response === 'Going');
  const waiting = sortBy(d.attendees.filter((a) => a.rsvp.response === 'Waitlisted'),
    (a) => a.rsvp.at);

  return (
    <div className="stack">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <Badge kind={STATUS_TONE[e.status]}>{e.status}</Badge>
        <Badge kind="mute">{e.type}</Badge>
        {d.full && <Badge kind="warn">Full</Badge>}
        {d.past && <Badge kind="mute">Has happened</Badge>}
      </div>

      {e.status === 'Cancelled' && (
        <Banner kind="warn" icon={<Icon n="blocked" size="lg" />} title="This was cancelled">
          {e.cancelledReason}
        </Banner>
      )}

      {e.status === 'Draft' && (
        <Banner kind="info" icon={<Icon n="pending" size="lg" />} title="Nobody can see this yet">
          A draft is yours alone. Publishing puts it in front of the {d.audience}
          {' '}people it is for, and they can start responding.
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'about' as const, label: 'Details' },
          { v: 'who' as const, label: `Who is coming (${d.going})` },
          { v: 'history' as const, label: 'History' },
        ]}
        onChange={setTab}
      />

      {tab === 'about' && (
        <>
          {e.desc && <p style={{ fontSize: 13, lineHeight: 1.55 }}>{e.desc}</p>}
          <KV rows={[
            ['When', when(e)],
            ['Where', place(e)],
            ['Organised by', d.organiser],
            ['Invited', `${d.audience} people`],
            ['For', [
              e.forSites.length ? e.forSites.map((s) => siteOf(s).city).join(', ') : null,
              e.forDepts.length ? e.forDepts.map((x) => deptOf(x).name).join(', ') : null,
            ].filter(Boolean).join(' · ') || 'Everybody'],
            ['Seats', e.capacity == null ? 'No limit' : `${d.going} of ${e.capacity} taken`],
            ['Waitlist', d.waitlisted || '—'],
            ['Saying maybe', d.maybe || '—'],
            ['List closes', e.rsvpBy ? fmtD(e.rsvpBy) : 'When the event starts'],
            ['Turnout', d.attendance != null ? `${d.attendance}%` : 'Register not marked'],
          ]} />

          {!d.past && e.status === 'Published' && (
            <Card title="Are you coming?">
              <RsvpControl r={d} />
            </Card>
          )}

          {d.canManage && (
            <div className="row" style={{ gap: 9, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {e.status === 'Draft' && (
                <button className="btn primary" disabled={publish.pending}
                  onClick={() => act(() => publish.mutate(e.id), 'Event published')}>
                  <Icon n="send" size="lg" /> Publish
                </button>
              )}
              {e.status !== 'Cancelled' && (
                <button className="btn" onClick={() => layer.modal({
                  title: 'Edit the event',
                  sub: e.title,
                  body: (close) => <EventForm existing={d} close={close} />,
                  footer: null,
                })}>
                  <Icon n="tool" size="lg" /> Edit
                </button>
              )}
              {e.status === 'Published' && !d.past && (
                <button className="btn danger" onClick={() => layer.modal({
                  title: 'Cancel this event',
                  sub: e.title,
                  size: 'narrow',
                  body: (close) => <CancelForm id={e.id} title={e.title} close={close} />,
                  footer: null,
                })}>
                  <Icon n="blocked" size="lg" /> Cancel
                </button>
              )}
              {!d.going && !d.maybe && !d.waitlisted && (
                <button className="btn danger" disabled={remove.pending}
                  onClick={() => act(() => remove.mutate(e.id), 'Event deleted')}>
                  <Icon n="remove" size="lg" /> Delete
                </button>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'who' && (
        d.namesHidden ? (
          <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="Counts, not names">
            {d.going} coming, {d.maybe} maybe{d.waitlisted ? `, ${d.waitlisted} waiting` : ''}.
            Who is on the list is the organiser&rsquo;s to see.
          </Banner>
        ) : (
          <div className="stack">
            {d.past && d.canManage && (
              <Banner kind="info" icon={<Icon n="ok" size="lg" />} title="Mark the register">
                Tick everybody who turned up. The turnout figure is the mean across
                events, so an unmarked register does not drag it down — it simply
                leaves the question open.
              </Banner>
            )}
            {d.attendees.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Person</th><th>Department</th><th>Answered</th>
                      <th>On</th>{d.past && d.canManage && <th>Turned up</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.attendees.map((a) => (
                      <tr key={a.rsvp.id}>
                        <td>
                          <div className="row" style={{ gap: 9, alignItems: 'center' }}>
                            <Avatar name={a.name} />
                            <span style={{ fontWeight: 650, fontSize: 13 }}>{a.name}</span>
                          </div>
                        </td>
                        <td className="nowrap">{a.dept ? deptOf(a.dept).name : '—'}</td>
                        <td><Badge kind={RSVP_TONE[a.rsvp.response]}>{a.rsvp.response}</Badge></td>
                        <td className="nowrap">{fmtD(a.rsvp.at)}</td>
                        {d.past && d.canManage && (
                          <td>
                            <input
                              type="checkbox"
                              checked={a.rsvp.attended === true}
                              aria-label={`${a.name} attended`}
                              onChange={(x) => act(
                                () => mark.mutate(e.id, a.rsvp.empId, x.target.checked),
                                `${a.name} marked`,
                              )}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={<Icon n="people" size="xl" />} msg="Nobody has responded yet" />
            )}
            {waiting.length > 0 && (
              <Banner kind="info" icon={<Icon n="pending" size="lg" />} title="The waitlist, in order">
                {waiting.map((a) => a.name).join(', ')} — in that order. A seat freed
                by a withdrawal goes to the first of them automatically.
              </Banner>
            )}
            {going.length > 0 && e.capacity != null && (
              <div>
                <Bar value={Math.round((going.length / e.capacity) * 100)} />
                <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
                  {going.length} of {e.capacity} seats taken
                </div>
              </div>
            )}
          </div>
        )
      )}

      {tab === 'history' && (
        d.history.length ? (
          <div className="tl"><div className="tl-day">
            {d.history.map((h) => (
              <div className="tl-row" key={h.id}>
                <div className="tl-time mono">{h.at.slice(5, 10)}</div>
                <div className="tl-mark" aria-hidden="true">
                  <i style={{ background: 'var(--brand)' }} />
                </div>
                <div className="tl-body">
                  <div className="tl-k">{h.action.replace('event.', '').replace(/_/g, ' ')}</div>
                  <div className="tl-s">{h.summary}</div>
                  <div className="tl-who muted">{h.actorLabel}</div>
                </div>
              </div>
            ))}
          </div></div>
        ) : (
          <EmptyState icon={<Icon n="clock" size="xl" />} msg="Nothing has happened to this event yet" />
        )
      )}
    </div>
  );
}

/* ---------------- one card ---------------- */

function EventCard({ r, onOpen }: { r: EventRow; onOpen: () => void }) {
  const e = r.event;
  return (
    <Card
      title={<button className="linkish" onClick={onOpen}>{e.title}</button>}
      sub={<>{when(e)} · {place(e)}</>}
      actions={
        <div className="row" style={{ gap: 6 }}>
          {e.status !== 'Published' && <Badge kind={STATUS_TONE[e.status]}>{e.status}</Badge>}
          <Badge kind="mute">{e.type}</Badge>
        </div>
      }
    >
      <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          {e.desc && (
            <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 8px' }}>
              {e.desc.length > 160 ? `${e.desc.slice(0, 160)}…` : e.desc}
            </p>
          )}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <Badge kind="info">{r.going} coming</Badge>
            {r.maybe > 0 && <Badge kind="mute">{r.maybe} maybe</Badge>}
            {r.waitlisted > 0 && <Badge kind="warn">{r.waitlisted} waiting</Badge>}
            {e.capacity != null && !r.full && (
              <Badge kind="mute">{r.seatsLeft} of {e.capacity} left</Badge>
            )}
            {r.full && <Badge kind="warn">Full</Badge>}
            {r.attendance != null && <Badge kind="good">{r.attendance}% turned up</Badge>}
          </div>
        </div>
        <div style={{ flex: '0 0 auto' }}>
          <RsvpControl r={r} />
        </div>
      </div>
    </Card>
  );
}

/* ---------------- the page ---------------- */

function EventsView() {
  const app = useApp();
  const layer = useLayer();
  const [tab, setTab] = useTabFromUrl<Tab>('upcoming', ['upcoming', 'mine', 'past']);
  const [f, setF] = useState<EventFilter>({});

  const scoped: EventFilter = tab === 'past' ? { ...f, when: 'past' } : { ...f, when: 'upcoming' };
  const { data: listed = [], loading, error } = useEvents(scoped);
  const { data: mine = [] } = useMyEvents();
  const { data: stats } = useEventStats();

  if (error) {
    return (
      <Card title="Company events">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const rows = tab === 'mine' ? mine : listed;

  const open = (r: EventRow) => layer.drawer({
    title: r.event.title,
    sub: when(r.event),
    body: <EventDetailView id={r.event.id} />,
  });

  const exportCsv = () => downloadCSV('company_events.csv', [
    ['Title', 'Kind', 'Date', 'Ends', 'Where', 'Organiser', 'Status', 'Invited',
      'Going', 'Maybe', 'Waitlisted', 'Capacity', 'Turnout %'],
    ...rows.map((r) => [
      r.event.title, r.event.type, r.event.on, r.event.endsOn, place(r.event),
      r.organiser, r.event.status, r.audience, r.going, r.maybe, r.waitlisted,
      r.event.capacity ?? '—', r.attendance ?? '—',
    ]),
  ]);

  const one = (k: keyof EventFilter) => (v: string) => setF({ ...f, [k]: v || undefined });
  const filtered = Object.values(f).some((v) => v != null && v !== '' && v !== false);

  return (
    <div className="stack">
      <PageActions>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          <Icon n="download" size="lg" /> Export
        </button>
        {app.role !== 'employee' && (
          <button className="btn primary" onClick={() => layer.modal({
            title: 'Create an event',
            body: (close) => <EventForm close={close} />,
            footer: null,
          })}>
            <Icon n="add" size="lg" /> New event
          </button>
        )}
      </PageActions>

      <StatRow cols={5}>
        <Tile icon={<Icon n="calendar" size="lg" />} label="Coming up"
          value={stats?.upcoming ?? '—'}
          foot={stats ? `${stats.thisMonth} this month` : ''} />
        <Tile icon={<Icon n="people" size="lg" />} label="Seats taken"
          value={stats?.going ?? '—'} foot="Across everything ahead" />
        <Tile icon={<Icon n="pending" size="lg" />} label="On waitlists"
          value={stats?.waitlisted ?? '—'}
          foot={stats ? `${stats.full} event(s) full` : ''} />
        <Tile icon={<Icon n="ok" size="lg" />} label="Turnout"
          value={stats?.attendance != null ? `${stats.attendance}%` : '—'}
          foot="Mean across past events" />
        <Tile icon={<Icon n="note" size="lg" />} label="Registers to mark"
          value={stats?.unmarked ?? '—'} foot="Past events, unanswered" />
      </StatRow>

      {stats != null && stats.unmarked > 0 && app.role !== 'employee' && (
        <Banner kind="info" icon={<Icon n="note" size="lg" />} title="Turnout is only as good as the registers">
          {stats.unmarked} past event(s) have nobody ticked off. Those are left out of
          the {stats.attendance ?? 0}% above rather than counted as zero — but until
          they are marked, the figure is answering a smaller question than it looks.
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'upcoming' as const, label: 'Coming up' },
          { v: 'mine' as const, label: `Mine (${mine.length})` },
          { v: 'past' as const, label: 'Been and gone' },
        ]}
        onChange={setTab}
      />

      {tab !== 'mine' && (
        <div className="toolbar">
          <div className="gsearch" style={{ width: 230, flex: '0 0 auto' }}>
            <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
            <input className="gsearch-in" type="search" value={f.q ?? ''}
              placeholder="Title or venue…" aria-label="Search events"
              onChange={(e) => one('q')(e.target.value)} />
          </div>
          <select className="input sm" value={f.type ?? ''} aria-label="Kind"
            onChange={(e) => one('type')(e.target.value)}>
            <option value="">All kinds</option>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="input sm" value={f.site ?? ''} aria-label="Office"
            onChange={(e) => one('site')(e.target.value)}>
            <option value="">Anywhere</option>
            {SITES.filter((s) => !s.remote).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          {app.role !== 'employee' && (
            <select className="input sm" value={f.status ?? ''} aria-label="Status"
              onChange={(e) => one('status')(e.target.value)}>
              <option value="">All statuses</option>
              {(['Draft', 'Published', 'Cancelled'] as const).map((sv) => (
                <option key={sv} value={sv}>{sv}</option>
              ))}
            </select>
          )}
          <div className="spacer" />
          {filtered && <button className="btn sm" onClick={() => setF({})}>Reset</button>}
        </div>
      )}

      {rows.length ? (
        <div className="stack">
          {rows.map((r) => <EventCard key={r.event.id} r={r} onOpen={() => open(r)} />)}
        </div>
      ) : (
        <Card title={tab === 'mine' ? 'Your events' : 'Events'}>
          <EmptyState
            icon={<Icon n="calendar" size="xl" />}
            msg={loading
              ? 'Loading the calendar…'
              : tab === 'mine'
                ? 'You have not said yes to anything yet'
                : tab === 'past'
                  ? 'Nothing has happened yet'
                  : 'Nothing coming up that matches'}
          />
        </Card>
      )}

      {tab === 'mine' && mine.length > 0 && (
        <Banner kind="info" icon={<Icon n="calendar" size="lg" />} title="Everything you said yes to">
          Including anything you are waitlisted for. Changing your mind is fine — clear the answer and the seat goes to somebody waiting.
        </Banner>
      )}
    </div>
  );
}

registerModule({
  key: 'events',
  title: TITLES.events,
  Component: EventsView,
});

export { EventsView };
