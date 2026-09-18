/**
 * Celebrations — birthdays, anniversaries, joiners and festivals.
 *
 * Four kinds of occasion drawn from four different places, folded into one
 * shape so the calendar and the lists can treat them alike. Birthdays and
 * anniversaries come from the noticeboard service; joiners are derived from
 * joining dates, because nobody records "X joined" as an event; festivals are
 * the holiday calendar, which is already maintained for leave.
 *
 * **Recurring dates are projected, not stored.** A birthday is a day and month
 * that returns every year; the service gives the next occurrence, and the
 * calendar asks for whichever month is on screen. Storing one row per person
 * per year would be a table that has to be topped up every January.
 *
 * **Nothing here is invented.** The reference shows a feed of celebration
 * posts with photographs, likes and comments; there is no such record in this
 * system, and a wall of placeholder posts would be worse than its absence.
 * What is real — who is celebrating what, and when — is all here.
 */

import { useMemo, useState } from 'react';
import type { Celebration } from '../../services';
import type { Employee } from '../../types/employee';
import { sortBy } from '../../lib/collections';
import { addDays, daysBetween, DOW, fmtD, fmtDS, MONL, parseYmd, TODAY, ymd } from '../../lib/dates';
import { deptOf, HOLIDAYS, ORG } from '../../data/org';
import { Avatar, Badge, Card, EmptyState, StatRow, Tabs, Tile } from '../../components/ui';
import { ListRow } from '../../components/common';

export type CelebKind = 'birthday' | 'anniversary' | 'joiner' | 'festival';

export interface Occasion {
  kind: CelebKind;
  /** The day it falls on, in the year being looked at. */
  date: string;
  /** Absent for a festival, which belongs to everybody. */
  empId?: string;
  label: string;
  years?: number;
}

export const KIND: Record<CelebKind, { n: string; icon: string; tone: string }> = {
  birthday: { n: 'Birthday', icon: '🎂', tone: 'rose' },
  anniversary: { n: 'Work anniversary', icon: '🎉', tone: 'green' },
  joiner: { n: 'New joiner', icon: '👋', tone: 'violet' },
  festival: { n: 'Festival', icon: '🪔', tone: 'amber' },
};

/** Move a recurring day-and-month onto a given year. */
const onYear = (date: string, year: number) => `${year}${date.slice(4)}`;

/**
 * Every occasion falling in one calendar month.
 *
 * Birthdays and anniversaries are recurring, so their day-and-month is
 * projected onto the month being asked for. Joining dates and festivals are
 * actual dates and are matched as they are — someone joined once, and Deepavali
 * is on a different date each year.
 */
export function occasionsIn(
  monthKey: string,
  cel: Celebration[],
  people: Employee[],
  holidays: { d: string; n: string }[],
  nameOf: (id: string) => string,
): Occasion[] {
  const year = Number(monthKey.slice(0, 4));
  const out: Occasion[] = [];

  cel.forEach((c) => {
    const at = onYear(c.date, year);
    if (at.slice(0, 7) !== monthKey) return;
    out.push({
      kind: c.kind === 'birthday' ? 'birthday' : 'anniversary',
      date: at,
      empId: c.empId,
      label: nameOf(c.empId),
      ...(c.years === undefined ? {} : { years: c.years }),
    });
  });

  people.forEach((e) => {
    if (e.doj.slice(0, 7) !== monthKey) return;
    out.push({ kind: 'joiner', date: e.doj, empId: e.id, label: e.name });
  });

  holidays.forEach((h) => {
    if (h.d.slice(0, 7) !== monthKey) return;
    out.push({ kind: 'festival', date: h.d, label: h.n });
  });

  return sortBy(out, (o) => o.date);
}

/** The month grid, with a dot for each kind of occasion falling on a day. */
export function CelebCalendar({
  monthKey, onMonth, occasions,
}: {
  monthKey: string;
  onMonth: (k: string) => void;
  occasions: Occasion[];
}) {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7)) - 1;
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  const today = ymd(TODAY);

  const byDay = new Map<string, Set<CelebKind>>();
  occasions.forEach((o) => {
    const set = byDay.get(o.date) ?? new Set<CelebKind>();
    set.add(o.kind);
    byDay.set(o.date, set);
  });

  const shift = (n: number) => {
    const d = new Date(year, month + n, 1);
    onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };

  /* Leading blanks so the first of the month lands under its weekday. */
  const cells: (string | null)[] = Array.from({ length: first.getDay() }, () => null);
  for (let d = 1; d <= days; d += 1) {
    cells.push(`${monthKey}-${String(d).padStart(2, '0')}`);
  }

  return (
    <Card
      title="Celebration calendar"
      sub={`${MONL[month]} ${year}`}
      actions={
        <div className="row" style={{ gap: 4 }}>
          <button className="btn icon sm" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
          <button className="btn icon sm" onClick={() => shift(1)} aria-label="Next month">›</button>
        </div>
      }>
      <div className="cal">
        {DOW.map((d) => <div key={d} className="cal-h">{d}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={'b' + i} />;
          const kinds = byDay.get(date);
          return (
            <div key={date} className={'cal-d' + (date === today ? ' now' : '')}>
              <span>{Number(date.slice(8))}</span>
              {kinds && (
                <div className="cal-dots">
                  {(['birthday', 'anniversary', 'joiner', 'festival'] as CelebKind[])
                    .filter((k) => kinds.has(k))
                    .map((k) => <i key={k} className={'cal-dot t-' + KIND[k].tone} />)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
        {(Object.keys(KIND) as CelebKind[]).map((k) => (
          <span key={k} className="row" style={{ gap: 5, fontSize: 11.5 }}>
            <i className={'cal-dot t-' + KIND[k].tone} />
            {KIND[k].n}
          </span>
        ))}
      </div>
    </Card>
  );
}

function OccasionCard({ o, onOpen, onWish }: {
  o: Occasion;
  onOpen: (id: string) => void;
  onWish: (o: Occasion) => void;
}) {
  const k = KIND[o.kind];
  const message = o.kind === 'birthday'
    ? 'Happy birthday — wishing you a wonderful year ahead.'
    : o.kind === 'anniversary'
      ? `Thank you for ${o.years} year${o.years === 1 ? '' : 's'} with us.`
      : o.kind === 'joiner'
        ? `Welcome to ${ORG.name} — glad to have you aboard.`
        : 'Wishing everyone a happy and safe celebration.';

  return (
    <div className={'celeb-card t-' + k.tone}>
      <div className="celeb-ic">{k.icon}</div>
      {o.empId
        ? <button className="celeb-who" onClick={() => onOpen(o.empId!)}>
            <Avatar name={o.label} size="lg" />
            <b>{o.label}</b>
          </button>
        : <div className="celeb-who"><div className="celeb-fest">{k.icon}</div><b>{o.label}</b></div>}
      <div className="celeb-k">
        {k.n}{o.kind === 'anniversary' && o.years ? ` · ${o.years} year${o.years === 1 ? '' : 's'}` : ''}
      </div>
      <div className="celeb-msg">{message}</div>
      {o.empId && (
        <button className="btn sm" onClick={() => onWish(o)}>🎁 Send wishes</button>
      )}
    </div>
  );
}

const TABS: { v: 'all' | CelebKind; label: string }[] = [
  { v: 'all', label: 'Overview' },
  { v: 'birthday', label: 'Birthdays' },
  { v: 'anniversary', label: 'Work anniversaries' },
  { v: 'joiner', label: 'New joiners' },
  { v: 'festival', label: 'Festivals' },
];

export function CelebrationsView({
  cel, everyone, onOpen, onWish, onAdd, canPost,
}: {
  cel: Celebration[];
  everyone: Employee[];
  onOpen: (id: string) => void;
  onWish: (o: Occasion) => void;
  onAdd: () => void;
  canPost: boolean;
}) {
  const [tab, setTab] = useState<'all' | CelebKind>('all');
  const thisMonth = ymd(TODAY).slice(0, 7);
  const [monthKey, setMonthKey] = useState(thisMonth);

  const nameOf = useMemo(() => {
    const m = new Map(everyone.map((e) => [e.id, e.name]));
    return (id: string) => m.get(id) ?? '—';
  }, [everyone]);

  /* The calendar shows whichever month is on screen; the lists look ahead. */
  const monthOccasions = useMemo(
    () => occasionsIn(monthKey, cel, everyone, HOLIDAYS, nameOf),
    [monthKey, cel, everyone, nameOf]);

  const upcoming = useMemo(() => {
    const today = ymd(TODAY);
    const horizon = ymd(addDays(TODAY, 90));
    const out: Occasion[] = [];
    [thisMonth, ymd(addDays(parseYmd(thisMonth + '-01'), 32)).slice(0, 7),
      ymd(addDays(parseYmd(thisMonth + '-01'), 64)).slice(0, 7),
      ymd(addDays(parseYmd(thisMonth + '-01'), 96)).slice(0, 7)]
      .forEach((k) => out.push(...occasionsIn(k, cel, everyone, HOLIDAYS, nameOf)));
    return sortBy(out.filter((o) => o.date >= today && o.date <= horizon), (o) => o.date);
  }, [cel, everyone, nameOf, thisMonth]);

  const today = ymd(TODAY);
  const todays = upcoming.filter((o) => o.date === today);
  const inMonth = (k: CelebKind) => monthOccasions.filter((o) => o.kind === k).length;

  const listed = tab === 'all' ? upcoming : upcoming.filter((o) => o.kind === tab);

  return (
    <div className="stack">
      <div className="celeb-hero">
        <div>
          <h2>Great people make a greater {ORG.name}</h2>
          <p>Let&rsquo;s celebrate the efforts, milestones and moments that make this a good place to work.</p>
        </div>
        {canPost && (
          <button className="btn solid celeb-add" onClick={onAdd}>＋ Add celebration</button>
        )}
      </div>

      <StatRow cols={4}>
        <Tile icon="🎂" label="Birthdays" value={inMonth('birthday')}
          foot={`In ${MONL[Number(monthKey.slice(5, 7)) - 1]}`} />
        <Tile icon="🎉" label="Work anniversaries" value={inMonth('anniversary')}
          foot="Milestones this month" />
        <Tile icon="👋" label="New joiners" value={inMonth('joiner')}
          foot="Started this month" />
        <Tile icon="⭐" label="Total occasions" value={monthOccasions.length}
          foot="Everything on the calendar" />
      </StatRow>

      <Tabs value={tab} onChange={setTab} options={TABS} />

      {tab === 'all' && (
        <Card title="Today" sub={todays.length ? `${todays.length} to mark` : 'Nothing today'} flush>
          {todays.length ? (
            <div className="celeb-row">
              {todays.map((o, i) => (
                <OccasionCard key={o.kind + o.empId + i} o={o} onOpen={onOpen} onWish={onWish} />
              ))}
            </div>
          ) : (
            <EmptyState icon="🎈"
              msg={`Nothing falls today — the next is ${upcoming[0]
                ? `${upcoming[0].label} on ${fmtD(upcoming[0].date)}`
                : 'further out than three months'}.`} />
          )}
        </Card>
      )}

      <div className="grid g-2-1">
        <Card
          title={tab === 'all' ? 'Coming up' : TABS.find((t) => t.v === tab)!.label}
          sub={`${listed.length} in the next 90 days`}
          flush>
          {listed.length ? listed.slice(0, 40).map((o, i) => {
            const k = KIND[o.kind];
            const away = daysBetween(today, o.date);
            return (
              <ListRow key={o.kind + (o.empId ?? o.label) + i}
                {...(o.empId ? { onClick: () => onOpen(o.empId!) } : {})}>
                <span style={{ fontSize: 16 }}>{k.icon}</span>
                {o.empId ? <Avatar name={o.label} size="sm" /> : null}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{o.label}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {k.n}
                    {o.kind === 'anniversary' && o.years ? ` · ${o.years} year${o.years === 1 ? '' : 's'}` : ''}
                    {o.empId ? ` · ${deptOf(everyone.find((e) => e.id === o.empId)?.dept ?? '').name}` : ''}
                  </div>
                </div>
                <Badge kind={away === 0 ? 'good' : away <= 7 ? 'info' : 'mute'}>
                  {away === 0 ? 'Today' : away === 1 ? 'Tomorrow' : fmtDS(o.date)}
                </Badge>
              </ListRow>
            );
          }) : <EmptyState msg="Nothing in the next 90 days" icon="🎈" />}
        </Card>

        <CelebCalendar monthKey={monthKey} onMonth={setMonthKey} occasions={monthOccasions} />
      </div>
    </div>
  );
}
