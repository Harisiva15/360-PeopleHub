import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { sum } from '../../lib/collections';
import { addDays, DOW, fmtD, fmtDS, fmtTime, hhmm, MON, monthKey, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { deptOf, ORG } from '../../data/org';
import type {
  AttRecord, AttStatus, Celebration, DayVerdict, Employee,
} from '../../services';
import {
  actualLabel, awaitingRecord, composeDays, expectedLabel,
} from '../attendance/day';
import { lookOfReason } from '../shifts/expected';
import type { Directory } from '../../services/people';
import { Avatar, Badge, EmptyState } from '../../components/ui';
import { ListRow } from '../../components/common';
import { Legend } from '../../components/charts';
import { usePendingItems } from './data';
import { Icon } from '../../components/icons';

/**
 * The greeting band at the top of every dashboard.
 *
 * Deliberately plain. The punch card already owns the brand gradient on this
 * page, and a second coloured block competing with it reads as decoration
 * rather than hierarchy — so this is type and a rule, nothing more.
 *
 * The salutation follows the reader's own clock rather than the tenant's
 * timezone: someone on the US shift opening this at 22:00 in Chennai is
 * starting their morning, and "Good evening" would be wrong for them twice
 * over.
 */
export function Greeting({ name, notes }: { name: string; notes?: ReactNode }) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  /* A single-word display name is common enough that the split has to survive it. */
  const first = name.trim().split(/\s+/)[0] || name;

  return (
    <div className="hero">
      <div style={{ minWidth: 0 }}>
        <div className="hi">{part}, {first}</div>
        <div className="sub">
          Here&rsquo;s what&rsquo;s happening at {ORG.name} today · {DOW[TODAY.getDay()]}, {fmtD(TODAY)}
        </div>
        {notes && <div className="hero-notes">{notes}</div>}
      </div>
      <div className="quote">&ldquo;Great organisations are built by great people.&rdquo;</div>
    </div>
  );
}

/** Today's attendance split, over records the caller has already fetched. */
export function attendanceToday(recs: AttRecord[]) {
  const c: Record<AttStatus, number> = { P: 0, W: 0, L: 0, A: 0, H: 0, O: 0 };
  recs.forEach((r) => c[r.status]++);
  return { recs, c, total: recs.length };
}

/**
 * Month-end headcount over the last `n` months, counted from the whole roster
 * — leavers included, since they were on the books until they left.
 */
export function headcountTrend(n: number, roster: Employee[]) {
  const labels: string[] = [];
  const data: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i + 1, 0);
    const k = ymd(d);
    labels.push(MON[d.getMonth()]);
    data.push(roster.filter((e) => e.doj <= k && (!e.dol || e.dol > k)).length);
  }
  return { labels, data };
}

export function ApprovalSummary() {
  const { data: items = [] } = usePendingItems();
  if (!items.length) return <EmptyState msg="Nothing waiting on you ✓" />;
  return (
    <>
      {items.map((i) => (
        <ListRow key={i.k} to={'/' + i.r}>
          <div><Icon n={i.ic} size="lg" /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 650, fontSize: 13 }}>{i.k}</div>
          </div>
          <Badge kind="warn">{i.n}</Badge>
          <span className="muted">›</span>
        </ListRow>
      ))}
    </>
  );
}

export function CelebRows({ list, dir, onWish }: {
  list: Celebration[];
  dir: Directory;
  /**
   * Offered per row when given. Wishes are a thing you send to one person on
   * their day, so the action belongs on their line rather than on a header
   * button that would have to ask who you meant.
   */
  onWish?: (empId: string) => void;
}) {
  if (!list.length) return <EmptyState msg="Nothing coming up" icon={<Icon n="balloon" size="lg" />} />;
  return (
    <>
      {list.map((c, i) => {
        const e = dir.byId(c.empId);
        if (!e) return null;
        const when = c.inDays === 0 ? 'Today' : c.inDays === 1 ? 'Tomorrow' : fmtDS(c.date);
        return (
          <ListRow key={i} to={'/employees?emp=' + e.id}>
            <div style={{ fontSize: 17 }}>{c.kind === 'birthday' ? '🎂' : '🎉'}</div>
            <Avatar name={e.name} size="sm" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{e.name}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {c.kind === 'birthday'
                  ? 'Birthday'
                  : `${c.years} year${(c.years ?? 0) > 1 ? 's' : ''} at ${ORG.name}`}
                {' · '}
                {deptOf(e.dept).name}
              </div>
            </div>
            <Badge kind={c.inDays <= 1 ? 'good' : 'mute'}>{when}</Badge>
            {onWish && (
              <button className="btn sm" title={'Send wishes to ' + e.name}
                onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); onWish(e.id); }}>
                🎁 Send wishes
              </button>
            )}
          </ListRow>
        );
      })}
    </>
  );
}

/**
 * The expected channel's classes, written out rather than composed.
 *
 * `exp-${reason.toLowerCase()}` produced the same four strings and was shorter,
 * but `checks/styles.ts` walks the source for rendered class names and cannot see
 * a name that only exists at runtime — so it reported all four as defined-but-never-
 * rendered. Spelling them out keeps the stylesheet and the markup checkable
 * against each other, which is the point of that check.
 *
 * Deliberately not the single-letter status names: `exp-weekly_off` is not `O`.
 * One channel is what attendance holds, the other is what the schedule expected.
 */
const EXPECTED_CLASS: Record<DayVerdict['reason'], string> = {
  WORKING: 'exp-working',
  WEEKLY_OFF: 'exp-weekly_off',
  HOLIDAY: 'exp-holiday',
  NOT_EMPLOYED: 'exp-not_employed',
};

/**
 * One month of an employee's attendance, as a day grid.
 *
 * A day with no attendance row used to be filled in here, from `HOLIDAY_MAP` and
 * `isWeekend` — a holiday list compiled into the bundle and a hard-coded
 * Saturday/Sunday test. In a configured build that showed week-offs and holidays
 * no server data supported, and shaded days the tenant had never configured.
 *
 * `calendar` carries the server's verdicts for the month instead.
 *
 * ## Two channels, since Phase 2h-H
 *
 * The cell used to hold one glyph: the attendance status where there was a row,
 * otherwise `'H'` for a holiday or `'O'` for a week off. That collapsed two
 * different answers into one — a day off was drawn exactly like an attendance
 * record saying so, and a working day with no record was drawn as blank, which is
 * also what a day nobody was expected in looked like.
 *
 * Now the **tint is the expectation** and the **glyph is the record**. A working
 * day with no attendance is tinted as a working day and carries no glyph, and its
 * label says "Working · No attendance" — which is the truth, and is specifically
 * **not** an absence. `A` is a status something writes deliberately; a missing row
 * is missing information, and turning one into the other is a later phase's
 * decision with a payroll consequence attached.
*
 * **Nothing here writes.** No attendance row is created, updated or inferred.
 */
export function MonthCalendar(
  { records, mk, calendar = [] }:
  { records: AttRecord[]; mk: string; calendar?: DayVerdict[] },
) {
  const [Y, M] = mk.split('-').map(Number);
  const first = new Date(Y, M - 1, 1);
  const dim = new Date(Y, M, 0).getDate();
  const lead = first.getDay();

  /* Every date in the month, joined against both answers in one pass. */
  const dates = Array.from({ length: dim }, (_, i) =>
    `${Y}-${String(M).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
  const days = composeDays(dates, calendar, records);

  const cells = [];
  DOW.forEach((d) => cells.push(<div className="dow" key={'h' + d}>{d[0]}</div>));
  for (let i = 0; i < lead; i++) cells.push(<div className="day mut" key={'l' + i} />);

  for (const day of days) {
    const r = day.actual;
    const look = lookOfReason(day.expected?.reason);
    /*
     * The class carries the *actual* status, which is what the palette was built
     * for. Where there is no record it carries the expectation instead, prefixed
     * so the two can never be confused in CSS either: `exp-off` is not `O`.
     */
    const cls = r ? r.status
      : look ? EXPECTED_CLASS[day.expected!.reason] : '';

    const expected = expectedLabel(day);
    const actual = actualLabel(day);
    /* Both answers, always, in that order — the point of the phase. */
    const tip = `${fmtD(day.date)} · ${expected ? `Expected: ${expected} · ` : ''}`
      + `Actual: ${actual}`
      + (r && r.inT ? ` · ${fmtTime(r.inT)}–${fmtTime(r.outT)} (${hhmm(r.mins)} h)` : '')
      + (r?.late ? ' · late' : '')
      + (day.expected?.shift ? ` · shift ${day.expected.shift}` : '');

    cells.push(
      <div key={day.date}
        className={'day ' + cls + (day.date > ymd(TODAY) ? ' mut' : '')}
        data-tip={tip} aria-label={tip}>
        {Number(day.date.slice(8))}
        {/*
          * The glyph is the record and nothing else. A day awaiting one shows a
          * faint dot rather than a letter: it marks the cell as worth a look
          * without naming a status nobody has written.
          */}
        {r && r.mins
          ? <small>{(r.mins / 60).toFixed(1)}h</small>
          : r
            ? <small>{r.status}</small>
            : awaitingRecord(day) && day.date <= ymd(TODAY)
              ? <small className="muted" aria-hidden="true">·</small>
              : null}
      </div>,
    );
  }

  return (
    <>
      <div className="cal">{cells}</div>
      {/*
        * Two legends, because there are two channels. Each entry is a word as
        * well as a colour — a grid read in greyscale still has to say which days
        * were expected and what was recorded.
        */}
      <div className="muted" style={{ fontSize: 11, marginTop: 8, fontWeight: 650 }}>
        Recorded
      </div>
      <Legend
        items={[
          { k: 'Present', c: 'var(--good)' },
          { k: 'WFH', c: 'var(--s1)' },
          { k: 'Leave', c: 'var(--warn)' },
          { k: 'Absent', c: 'var(--crit)' },
        ]}
      />
      <div className="muted" style={{ fontSize: 11, marginTop: 6, fontWeight: 650 }}>
        Expected, where nothing was recorded
      </div>
      <Legend
        items={[
          { k: 'Working · no attendance', c: 'var(--surface-3)' },
          { k: 'Week off', c: 'var(--line-2)' },
          { k: 'Holiday', c: 'var(--surface-2)' },
          { k: 'Not employed', c: 'transparent' },
        ]}
      />
    </>
  );
}

/** Attendance percentage and WFH share by month, skipping months with no data. */
export function attendanceTrend(months: number, ATT: { date: string; status: AttStatus }[]) {
  const labels: string[] = [];
  const rate: number[] = [];
  const wfh: number[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    const k = monthKey(d);
    const recs = ATT.filter((r) => r.date.slice(0, 7) === k && ['P', 'W', 'A', 'L'].includes(r.status));
    if (!recs.length) continue;
    labels.push(MON[d.getMonth()]);
    rate.push(pct(recs.filter((r) => r.status === 'P' || r.status === 'W').length, recs.length));
    wfh.push(pct(recs.filter((r) => r.status === 'W').length, recs.length));
  }
  return { labels, rate, wfh };
}

/** Joiners and exits per month over the last `n` months. */
export function joinersExits(n: number, roster: Employee[]) {
  const lb: string[] = [];
  const j: number[] = [];
  const x: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    const k = monthKey(d);
    lb.push(MON[d.getMonth()]);
    j.push(roster.filter((e) => e.doj.slice(0, 7) === k).length);
    x.push(roster.filter((e) => e.dol && e.dol.slice(0, 7) === k).length);
  }
  return { lb, j, x };
}

export function GoLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link className="btn sm" to={'/' + to}>
      {children}
    </Link>
  );
}

export { sum, addDays };
