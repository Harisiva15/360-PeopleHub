import { Link } from 'react-router-dom';
import { sum } from '../../lib/collections';
import { addDays, DOW, fmtD, fmtDS, fmtTime, hhmm, isWeekend, MON, monthKey, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { deptOf, HOLIDAY_MAP, ORG } from '../../data/org';
import type { AttRecord, AttStatus, Celebration, Employee } from '../../services';
import type { Directory } from '../../services/people';
import { Avatar, Badge, EmptyState } from '../../components/ui';
import { ListRow } from '../../components/common';
import { Legend } from '../../components/charts';
import { usePendingItems } from './data';

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
          <div style={{ fontSize: 16 }}>{i.ic}</div>
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

export function CelebRows({ list, dir }: { list: Celebration[]; dir: Directory }) {
  if (!list.length) return <EmptyState msg="Nothing coming up" icon="🎈" />;
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
          </ListRow>
        );
      })}
    </>
  );
}

const DAY_LABEL: Record<string, string> = {
  P: 'Present', W: 'WFH', L: 'Leave', A: 'Absent', H: 'Holiday', O: 'Week off',
};

/** One month of an employee's attendance, as a day grid. */
export function MonthCalendar({ records, mk }: { records: AttRecord[]; mk: string }) {
  const [Y, M] = mk.split('-').map(Number);
  const first = new Date(Y, M - 1, 1);
  const dim = new Date(Y, M, 0).getDate();
  const lead = first.getDay();

  const byDate = new Map(records.map((r) => [r.date, r]));
  const cells = [];
  DOW.forEach((d) => cells.push(<div className="dow" key={'h' + d}>{d[0]}</div>));
  for (let i = 0; i < lead; i++) cells.push(<div className="day mut" key={'l' + i} />);

  for (let d = 1; d <= dim; d++) {
    const ds = Y + '-' + String(M).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const r = byDate.get(ds);
    const st = r ? r.status : HOLIDAY_MAP[ds] ? 'H' : isWeekend(parseYmd(ds)) ? 'O' : '';
    const lbl = st === 'H' ? HOLIDAY_MAP[ds] || 'Holiday' : DAY_LABEL[st] || 'No record';
    const tip =
      fmtD(ds) + ' · ' + lbl +
      (r && r.inT ? ` · ${fmtTime(r.inT)}–${fmtTime(r.outT)} (${hhmm(r.mins)} h)` : '');
    cells.push(
      <div key={ds} className={'day ' + st + (ds > ymd(TODAY) ? ' mut' : '')} data-tip={tip}>
        {d}
        {r && r.mins ? <small>{(r.mins / 60).toFixed(1)}h</small> : st === 'L' ? <small>L</small> : st === 'A' ? <small>A</small> : null}
      </div>,
    );
  }

  return (
    <>
      <div className="cal">{cells}</div>
      <Legend
        items={[
          { k: 'Present', c: 'var(--good)' },
          { k: 'WFH', c: 'var(--s1)' },
          { k: 'Leave', c: 'var(--warn)' },
          { k: 'Absent', c: 'var(--crit)' },
          { k: 'Holiday / week off', c: 'var(--line-2)' },
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
