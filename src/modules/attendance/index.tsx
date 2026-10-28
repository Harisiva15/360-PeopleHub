import { useState } from 'react';
import { groupBy, sortBy, sum } from '../../lib/collections';
import { addDays, DOW, dowOf, fmtD, fmtDS, fmtTime, hhmm, monthKey, monthLabelLong, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import type { AttRecord, Employee } from '../../services';
import { DEPTS, deptOf, siteOf, SITES } from '../../data/org';
import { useHolidays } from '../../services/holidays';
import { Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile, StatRow } from '../../components/ui';
import { ListRow, StatusBadge } from '../../components/common';
import { BarChart, HBar, Legend, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { SCOPE } from '../../state/rbac';
import { useShowEmployee } from '../employees/Profile';
import { PunchWidget } from './Punch';
import { useOpenRegularisation } from './RegForm';
import {
  useActOnRegularisation, useApprovedLeave, useAttendance, useMonthCalendar,
  useMyAttendance, usePeople,
  useWorkSchedules,
  usePayRuns, useRegularisations, useUnclosedDays, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { MonthCalendar } from '../dashboard/shared';
import {
  actualLabel, awaitingRecord, composeDays, expectedLabel, leaveLabel,
  recordedDuringLeave, sourceLabel,
} from './day';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { Icon } from '../../components/icons';

const ATT_LABEL: Record<string, { kind: 'good' | 'info' | 'warn' | 'crit' | 'mute'; label: string }> = {
  P: { kind: 'good', label: 'Present' },
  W: { kind: 'info', label: 'WFH' },
  L: { kind: 'warn', label: 'Leave' },
  A: { kind: 'crit', label: 'Absent' },
  H: { kind: 'mute', label: 'Holiday' },
  O: { kind: 'mute', label: 'Week off' },
};

const STATUS_TEXT: Record<string, string> = {
  P: 'Present (in office)', W: 'Work from home', L: 'On leave', A: 'Absent', H: 'Holiday', O: 'Week off',
};

function useAttDetail(dir: Directory) {
  const layer = useLayer();
  return (r: AttRecord) => {
    const name = dir.name(r.empId);
    layer.modal({
      title: name + ' — ' + fmtD(r.date),
      sub: dowOf(r.date) + ' · ' + siteOf(r.site).name,
      body: (
        <>
          <KV rows={[
            ['Status', STATUS_TEXT[r.status]],
            ['Punch in', <span className="mono">{r.inT ? fmtTime(r.inT) + (r.late ? ' · late' : '') : '—'}</span>],
            ['Punch out', <span className="mono">{r.outT ? fmtTime(r.outT) : '—'}</span>],
            ['Net hours', r.mins ? hhmm(r.mins) + ' h (excl. 45 min break)' : '—'],
            ['Source', sourceLabel(r.src) || '—'],
            ['Work mode', siteOf(r.site).name],
            ...(r.notes ? [['Notes', r.notes]] as [string, React.ReactNode][] : []),
            ...(r.reg ? [['Regularisation', <><StatusBadge status={r.reg.status} /> — {r.reg.reason}</>]] as [string, React.ReactNode][] : []),
          ]} />
        </>
      ),
    });
  };
}

function AttRow({ r, person, onClick }: { r: AttRecord; person?: Employee; onClick: () => void }) {
  const b = ATT_LABEL[r.status];
  return (
    <tr className="clickable" onClick={onClick}>
      {person && <td><PersonCell e={person} /></td>}
      <td className="nowrap">{fmtD(r.date)} <span className="muted">{dowOf(r.date)}</span></td>
      <td>
        <Badge kind={b.kind}>{b.label}</Badge>
        {r.reg && <> <Badge kind="info" ><Icon n="refresh" size="lg" /> {r.reg.status}</Badge></>}
      </td>
      <td className="mono">
        {r.inT ? <>{fmtTime(r.inT)}{r.late && <span style={{ color: 'var(--crit)' }} title="Late"> •</span>}</> : '—'}
      </td>
      <td className="mono">{r.outT ? fmtTime(r.outT) : '—'}</td>
      <td className="num">{r.mins ? hhmm(r.mins) : '—'}</td>
      <td className="nowrap">{r.inT ? siteOf(r.site).name : '—'}</td>
      <td className="muted">{sourceLabel(r.src) || '—'}</td>
    </tr>
  );
}

/* ---------------- My attendance ---------------- */

function AttMe({ onRegularise }: { onRegularise: () => void }) {
  const app = useApp();
  const me = app.me;
  const self = usePeople([me.id]);
  const detail = useAttDetail(self);
  const { data: runs = [] } = usePayRuns();
  const months = runs.map((p) => p.mk).slice(-8);
  const [mk, setMk] = useState(monthKey(TODAY));

  const { data: recs = [] } = useMyAttendance(me.id, mk + '-01', mk + '-31');
  /* The server decides which of those days were working days. */
  const { data: monthCal = [] } = useMonthCalendar(me.id, mk);
  /* Their own approved leave for the month, in one range read. */
  const { data: monthLeave = [] } = useApprovedLeave([me.id], mk + '-01', mk + '-31');

  /*
   * The two answers, kept apart.
   *
   * `work` used to be `recs.filter(status in P/W/A/L)` and was labelled "working
   * days in month" — which counted *records*, not working days. A month where
   * nothing was recorded reported zero working days, and a month of absences
   * reported them as working days attended. The expected count comes from the
   * resolver, which is the only thing that knows the person's schedule.
   */
  const expectedDays = monthCal.filter((v) => v.workingDay).length;
  const days = composeDays(monthCal.map((v) => v.date), monthCal, recs, monthLeave);
  const today = ymd(TODAY);
  /* Expected in, nothing recorded, and the day has already happened. */
  const awaiting = days.filter((d) => awaitingRecord(d) && d.date <= today).length;
  /*
   * Working days covered by approved leave. Counted off the expected channel, so
   * a weekend inside a leave span is not counted as a leave day — which is the
   * same rule the leave service applied when it derived the stored day count.
   */
  const leaveDays = days.filter(
    (d) => d.leave !== null && d.expected?.reason === 'WORKING').length;
  /* What is expected of them today, where the month shown includes it. */
  const todayDay = days.find((d) => d.date === today) ?? null;
  const present = recs.filter((r) => r.status === 'P' || r.status === 'W').length;
  const late = recs.filter((r) => r.late).length;
  const hrs = sum(recs, (r) => r.mins) / 60;
  const avg = present ? hrs / present : 0;
  const unapproved = recs.filter((r) => r.status === 'A' && (!r.reg || r.reg.status !== 'Approved')).length;

  const exportCsv = () =>
    downloadCSV(
      `attendance_${me.code}_${mk}.csv`,
      [['Date', 'Day', 'Status', 'In', 'Out', 'Hours', 'Mode', 'Source', 'Notes']].concat(
        sortBy(recs, (r) => r.date).map((r) => [
          r.date, dowOf(r.date), r.status, r.inT || '', r.outT || '', (r.mins / 60).toFixed(2),
          siteOf(r.site).name, sourceLabel(r.src), r.notes || '',
        ]),
      ),
    );

  return (
    <div className="stack">
      <PunchWidget empId={me.id} />
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={mk} onChange={(e) => setMk(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{monthLabelLong(m)}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={onRegularise}><Icon n="add" size="lg" /> Request regularisation</button>
        <button className="btn" onClick={exportCsv}><Icon n="download" size="lg" /> Export</button>
      </div>

      {/*
        * Today, answered twice. The point of the phase in one line: what the
        * schedule expected, and what attendance holds — never merged, and a
        * missing record never called an absence.
        */}
      {todayDay && (
        <Banner kind="info" icon={<Icon n="calendar" size="lg" />} title={fmtD(today)}>
          <b>Expected:</b> {expectedLabel(todayDay) ?? 'Not known'}
          {todayDay.expected?.shift ? ` · shift ${todayDay.expected.shift}` : ''}
          {todayDay.expected?.schedule ? ` · pattern ${todayDay.expected.schedule}` : ''}
          {leaveLabel(todayDay) ? <> · <b>Leave:</b> {leaveLabel(todayDay)}</> : null}
          {' · '}<b>Recorded:</b> {actualLabel(todayDay)}
          {recordedDuringLeave(todayDay)
            ? <> · <Badge kind="warn">Attendance recorded during approved leave</Badge></>
            : null}
        </Banner>
      )}

      <StatRow cols={5}>
        <Tile label="Present days" value={present}
          foot={`of ${expectedDays} working day(s) your pattern expects`} />
        <Tile label="Total hours" value={hrs.toFixed(1) + ' h'} foot={`Avg ${avg.toFixed(1)} h / day`} />
        <Tile label="WFH days" value={recs.filter((r) => r.status === 'W').length} foot="Policy: up to 8 / month" />
        <Tile label="Leave / absent"
          value={`${recs.filter((r) => r.status === 'L').length} / ${recs.filter((r) => r.status === 'A').length}`}
          foot={`${unapproved} unapproved (LOP)`} />
        {/*
          * Both figures in one tile: StatRow takes at most five columns, and a
          * sixth tile strands itself on a row of its own. They belong together
          * anyway — approved leave is most of why the other figure is small, and
          * neither is an absence.
          */}
        <Tile label="Awaiting a record" value={awaiting}
          foot={`Expected in, no record · ${leaveDays} day(s) on approved leave`} />
      </StatRow>
      {late > 0 && (
        <Badge kind={late > 3 ? 'warn' : 'info'}>
          {late} late mark(s) this month{late > 3 ? ' — above the threshold of 3' : ''}
        </Badge>
      )}

      <div className="grid g-1-2">
        <Card title="Calendar" sub={monthLabelLong(mk)}>
          <MonthCalendar records={recs} mk={mk} calendar={monthCal} leave={monthLeave} />
        </Card>
        <Card title="Daily log" sub={`${recs.length} records`} flush>
          <div style={{ maxHeight: 520, overflow: 'auto' }} className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th className="num">Hours</th><th>Mode</th><th>Source</th></tr>
              </thead>
              <tbody>
                {sortBy(recs, (r) => r.date, 'desc').map((r) => (
                  <AttRow key={r.id} r={r} onClick={() => detail(r)} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Live board ---------------- */

function AttLive() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');

  const dir = useVisiblePeople();
  const ds = ymd(TODAY);
  const { data: recs = [] } = useAttendance(dir.ids, ds, ds);
  const c: Record<string, number> = { P: 0, W: 0, L: 0, A: 0, H: 0, O: 0 };
  recs.forEach((r) => c[r.status]++);

  const lateOnes = recs.filter((r) => r.late);
  const bySite = ['CHN', 'BLR', 'HYD', 'WFH', 'CLIENT']
    .map((s, i) => ({ k: siteOf(s).name, v: recs.filter((r) => r.inT && r.site === s).length, c: PAL[i] }))
    .filter((r) => r.v);

  const shown = recs.filter(
    (r) => (!q || dir.name(r.empId).toLowerCase().includes(q.toLowerCase())) && (!st || r.status === st),
  );

  const exportCsv = () =>
    downloadCSV(
      `attendance_${ds}.csv`,
      [['Emp Code', 'Name', 'Department', 'Status', 'In', 'Out', 'Hours', 'Mode']].concat(
        recs.map((r) => {
          const e = dir.byId(r.empId);
          return [e?.code ?? r.empId, e?.name ?? '—', e ? deptOf(e.dept).name : '—', r.status, r.inT || '', r.outT || '',
            (r.mins / 60).toFixed(2), siteOf(r.site).name];
        }),
      ),
    );

  const pendingRegs = recs.filter((r) => r.reg && r.reg.status === 'Pending').length;

  /*
   * Open days across this caller's scope: their own plus their line, decided by
   * the service rather than by passing an id. Newest first, so the stalest —
   * the one the subtitle names — is the last element.
   */
  const { data: unclosed = [] } = useUnclosedDays();
  const staleDays = unclosed.length ? unclosed[unclosed.length - 1]!.daysOpen : 0;

  return (
    <div className="stack">
      <StatRow cols={5}>
        <Tile label="In office" value={c.P} foot={pct(c.P, Math.max(1, recs.length - c.H - c.O)) + '% of expected'} />
        <Tile label="Work from home" value={c.W} foot="Declared work mode" />
        <Tile label="On leave" value={c.L} foot="Approved leave today" />
        <Tile label="Absent" value={c.A} foot={`${pendingRegs} regularisation pending`} />
        <Tile label="Late marks" value={lateOnes.length} trend={lateOnes.length ? 'down' : undefined}
          foot={lateOnes.length ? 'Past the shift grace period' : 'Everyone on time'} />
      </StatRow>

      <div className="grid g-2-1">
        <Card title="Live attendance board" sub={fmtD(TODAY) + ' · ' + SCOPE[app.role].label} flush
          actions={
            <div className="row">
              <input className="input" placeholder="Search employee…" style={{ width: 190 }} value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="input" style={{ width: 'auto' }} value={st} onChange={(e) => setSt(e.target.value)}>
                <option value="">All statuses</option>
                <option value="P">In office</option>
                <option value="W">WFH</option>
                <option value="L">On leave</option>
                <option value="A">Absent</option>
              </select>
              <button className="btn sm" onClick={exportCsv}><Icon n="download" size="lg" /> </button>
            </div>
          }>
          <div style={{ maxHeight: 560, overflow: 'auto' }} className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Department</th><th>Status</th><th>In</th><th>Out</th><th className="num">Hrs</th><th>Mode</th></tr>
              </thead>
              <tbody>
                {sortBy(shown, (r) => dir.name(r.empId)).map((r) => {
                  const e = dir.byId(r.empId);
                  const b = ATT_LABEL[r.status];
                  if (!e) return null;
                  return (
                    <tr key={r.id} className="clickable" onClick={() => showEmp(e.id)}>
                      <td><PersonCell e={e} /></td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td><Badge kind={b.kind}>{r.status === 'P' ? 'In office' : b.label}</Badge></td>
                      <td className="mono">
                        {r.inT ? <>{fmtTime(r.inT)}{r.late && <span style={{ color: 'var(--crit)' }}> •</span>}</> : '—'}
                      </td>
                      <td className="mono">{r.outT ? fmtTime(r.outT) : r.inT ? <Badge kind="info">Active</Badge> : '—'}</td>
                      <td className="num">{r.mins ? hhmm(r.mins) : '—'}</td>
                      <td className="nowrap">{r.inT ? siteOf(r.site).name : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Punches by location" sub="Today">
            {bySite.length ? <HBar rows={bySite} /> : <EmptyState msg="No punches yet" />}
          </Card>
          <Card title="Late arrivals" sub={`${lateOnes.length} today`} flush>
            <div style={{ maxHeight: 230, overflow: 'auto' }}>
              {lateOnes.length ? lateOnes.map((r) => (
                <ListRow key={r.id} onClick={() => showEmp(r.empId)}>
                  <Avatar name={dir.name(r.empId)} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(r.empId)}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{siteOf(r.site).name}</div>
                  </div>
                  <Badge kind="warn"><span className="mono">{fmtTime(r.inT)}</span></Badge>
                </ListRow>
              )) : <EmptyState msg="Everyone on time 🎉" />}
            </div>
          </Card>

          {/*
            * Days on this line that were punched into and never out of.
            *
            * Beside the late arrivals rather than inside the board, because the
            * board is today and these are not: the window has to have closed
            * before a missing punch out is a fact rather than somebody still at
            * work. The board shows those as "Active", which is correct for
            * today and becomes wrong overnight with nothing to say so.
            *
            * These are the rows payroll reads as a present day that earned
            * nothing, so they are the manager's queue — and the count is the
            * number they have to chase, not a figure to admire. The subtitle
            * says how stale the worst one is, because a day open for a week is
            * a different problem from one open since last night.
            */}
          <Card
            title="Days left open"
            sub={unclosed.length
              ? `${unclosed.length} to chase · oldest ${staleDays} day${staleDays === 1 ? '' : 's'}`
              : 'Nothing outstanding'}
            flush
          >
            <div style={{ maxHeight: 230, overflow: 'auto' }}>
              {unclosed.length ? unclosed.map((u) => (
                <ListRow key={`${u.empId}-${u.date}`} onClick={() => showEmp(u.empId)}>
                  <Avatar name={u.empName} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{u.empName}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {fmtD(u.date)} · in at {u.inT} ({u.tz})
                    </div>
                  </div>
                  {/*
                    * `crit` past a week. A day whose hours are unknown stops
                    * being a reminder and becomes a pay run's problem, and the
                    * boundary somebody actually feels is the next payroll
                    * cut-off rather than a number of hours.
                    */}
                  <Badge kind={u.daysOpen >= 7 ? 'crit' : 'warn'}>
                    {u.daysOpen === 0 ? 'Overnight' : `${u.daysOpen}d open`}
                  </Badge>
                </ListRow>
              )) : <EmptyState msg="Every day accounted for" />}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Log / muster roll ---------------- */

function AttLog() {
  const showEmp = useShowEmployee();
  const [from, setFrom] = useState(ymd(addDays(TODAY, -13)));
  const [to, setTo] = useState(ymd(TODAY));
  const [dept, setDept] = useState('');
  const [site, setSite] = useState('');

  const dir = useVisiblePeople();
  const { data: all = [] } = useAttendance(dir.ids, from, to);
  let recs = all;
  if (dept) recs = recs.filter((r) => dir.byId(r.empId)?.dept === dept);
  if (site) recs = recs.filter((r) => dir.byId(r.empId)?.site === site);

  const work = recs.filter((r) => ['P', 'W', 'A', 'L'].includes(r.status));
  const present = recs.filter((r) => r.status === 'P' || r.status === 'W');

  const byEmp = groupBy(recs, (r) => r.empId);
  const rows = Object.keys(byEmp).map((id) => {
    const rs = byEmp[id];
    const w = rs.filter((r) => ['P', 'W', 'A', 'L'].includes(r.status));
    const p = rs.filter((r) => r.status === 'P' || r.status === 'W');
    return {
      e: dir.byId(id)!, days: w.length, present: p.length,
      wfh: rs.filter((r) => r.status === 'W').length,
      leave: rs.filter((r) => r.status === 'L').length,
      absent: rs.filter((r) => r.status === 'A').length,
      late: rs.filter((r) => r.late).length,
      hrs: sum(rs, (r) => r.mins) / 60,
      rate: pct(p.length, Math.max(1, w.length)),
    };
  });

  const days: string[] = [];
  for (let d = parseYmd(from); ymd(d) <= to; d = addDays(d, 1)) days.push(ymd(d));
  const trend = days.map((ds) => {
    const rs = recs.filter((r) => r.date === ds);
    return {
      l: fmtDS(ds),
      p: rs.filter((r) => r.status === 'P').length,
      w: rs.filter((r) => r.status === 'W').length,
      a: rs.filter((r) => r.status === 'A').length,
      l2: rs.filter((r) => r.status === 'L').length,
    };
  });

  const exportCsv = () =>
    downloadCSV(
      `muster_roll_${from}_${to}.csv`,
      [['Emp Code', 'Name', 'Department', 'Location', 'Date', 'Status', 'In', 'Out', 'Hours', 'Mode', 'Source']].concat(
        sortBy(recs, (r) => r.date).map((r) => {
          const e = dir.byId(r.empId);
          return [e?.code ?? r.empId, e?.name ?? '—', e ? deptOf(e.dept).name : '—', e ? siteOf(e.site).name : '—', r.date, r.status,
            r.inT || '', r.outT || '', (r.mins / 60).toFixed(2), siteOf(r.site).name, sourceLabel(r.src)];
        }),
      ),
    );

  return (
    <div className="stack">
      <div className="toolbar">
        <input type="date" className="input" style={{ width: 'auto' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="muted">to</span>
        <input type="date" className="input" style={{ width: 'auto' }} value={to} onChange={(e) => setTo(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All locations</option>
          {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={exportCsv}><Icon n="download" size="lg" /> Export muster roll</button>
      </div>

      <StatRow cols={4}>
        <Tile label="Attendance rate" value={pct(present.length, Math.max(1, work.length)) + '%'}
          foot={`${present.length} of ${work.length} person-days`} />
        <Tile label="Total hours" value={Math.round(sum(recs, (r) => r.mins) / 60).toLocaleString('en-IN') + ' h'}
          foot={`Avg ${(sum(recs, (r) => r.mins) / 60 / Math.max(1, present.length)).toFixed(1)} h/day`} />
        <Tile label="WFH share" value={pct(recs.filter((r) => r.status === 'W').length, Math.max(1, present.length)) + '%'}
          foot={`${recs.filter((r) => r.status === 'W').length} WFH days logged`} />
        <Tile label="Late marks" value={recs.filter((r) => r.late).length} foot="Past the shift grace period" />
      </StatRow>

      <Card title="Daily attendance" sub={`${fmtD(from)} – ${fmtD(to)}`}>
        <BarChart labels={trend.map((t) => t.l)} height={210} stacked
          series={[
            { name: 'In office', color: 'var(--s1)', data: trend.map((t) => t.p) },
            { name: 'WFH', color: 'var(--s3)', data: trend.map((t) => t.w) },
            { name: 'Leave', color: 'var(--s4)', data: trend.map((t) => t.l2) },
            { name: 'Absent', color: 'var(--s8)', data: trend.map((t) => t.a) },
          ]} />
        <Legend items={[
          { k: 'In office', c: 'var(--s1)' }, { k: 'WFH', c: 'var(--s3)' },
          { k: 'Leave', c: 'var(--s4)' }, { k: 'Absent', c: 'var(--s8)' },
        ]} />
      </Card>

      <Card title="Muster roll" sub={`${rows.length} employees in range`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th>Location</th>
                <th className="num">Days</th><th className="num">Present</th><th className="num">WFH</th>
                <th className="num">Leave</th><th className="num">Absent</th><th className="num">Late</th>
                <th className="num">Hours</th><th className="num">Rate</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(rows, (r) => -r.rate).map((r) => (
                <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                  <td><PersonCell e={r.e} /></td>
                  <td className="nowrap">{deptOf(r.e.dept).name}</td>
                  <td className="nowrap">{siteOf(r.e.site).city === '—' ? siteOf(r.e.site).name : siteOf(r.e.site).city}</td>
                  <td className="num">{r.days}</td>
                  <td className="num">{r.present}</td>
                  <td className="num">{r.wfh}</td>
                  <td className="num">{r.leave}</td>
                  <td className="num">{r.absent ? <b style={{ color: 'var(--crit)' }}>{r.absent}</b> : '0'}</td>
                  <td className="num">{r.late}</td>
                  <td className="num">{r.hrs.toFixed(1)}</td>
                  <td className="num"><b>{r.rate}%</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Regularisation ---------------- */

function RegTable({ list, act, dir, onApprove, onReject }: {
  list: AttRecord[];
  act: boolean;
  onApprove: (r: AttRecord) => void;
  onReject: (r: AttRecord) => void;
  dir?: Directory;
}) {
  if (!list.length) return <EmptyState msg="Nothing here" icon={<Icon n="refresh" size="lg" />} />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {act && <th>Employee</th>}
            <th>Date</th><th>Reason</th><th>Proposed in/out</th><th>Raised on</th><th>Status</th>
            {act && <th className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {sortBy(list, (r) => r.date, 'desc').map((r) => (
            <tr key={r.id}>
              {act && dir?.byId(r.empId) && <td><PersonCell e={dir.byId(r.empId)!} /></td>}
              <td className="nowrap">{fmtD(r.date)}</td>
              <td>{r.reg!.reason}</td>
              <td className="mono nowrap">{fmtTime(r.reg!.inT)} – {fmtTime(r.reg!.outT)}</td>
              <td className="nowrap">{fmtD(r.reg!.raised)}</td>
              <td><StatusBadge status={r.reg!.status} /></td>
              {act && (
                <td className="right nowrap">
                  {r.reg!.status === 'Pending' ? (
                    <>
                      <button className="btn sm primary" onClick={() => onApprove(r)}>Approve</button>{' '}
                      <button className="btn sm" onClick={() => onReject(r)}>Reject</button>
                    </>
                  ) : <span className="muted">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttReg({ onRegularise }: { onRegularise: () => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const { data: regs = [] } = useRegularisations(dir.ids);
  const act = useActOnRegularisation();

  const mine = regs.filter((r) => r.empId === app.meId);
  const team = regs.filter((r) => r.empId !== app.meId);
  const pending = team.filter((r) => r.reg!.status === 'Pending');
  const canAct = app.role !== 'employee';

  const approve = async (r: AttRecord) => {
    await act.mutate(r, 'Approved');
    app.toast('Regularisation approved — day marked present', 'ok');
  };

  const reject = async (r: AttRecord) => {
    await act.mutate(r, 'Rejected');
    app.toast('Regularisation rejected', 'err');
  };

  return (
    <div className="stack">
      <Banner kind="info" icon={<span style={{ fontSize: 17 }}>ℹ️</span>} title="How regularisation works">
        Raise a request when a punch is missing or a day was marked absent by mistake. Your reporting manager approves
        it, and the day stops counting as Loss of Pay in payroll.
      </Banner>

      {canAct && pending.length > 0 && (
        <Card title="Pending your approval" sub={`${pending.length} requests`} flush>
          <RegTable list={pending} act dir={dir} onApprove={approve} onReject={reject} />
        </Card>
      )}

      <Card title="My requests" sub={`${mine.length} total`} flush
        actions={<button className="btn sm primary" onClick={onRegularise}><Icon n="add" size="lg" /> New request</button>}>
        <RegTable list={mine} act={false} onApprove={approve} onReject={reject} />
      </Card>

      {canAct && (
        <Card title="Team history" sub={`${team.length} requests`} flush>
          <RegTable list={team.filter((r) => r.reg!.status !== 'Pending')} act onApprove={approve} onReject={reject} />
        </Card>
      )}
    </div>
  );
}

/* ---------------- Holiday calendar ---------------- */

function AttCal() {
  const y = TODAY.getFullYear();
  /* Active patterns only: a withdrawn one is not the policy any more. */
  const { data: schedules = [] } = useWorkSchedules();
  const patterns = schedules.filter((w) => w.active);
  /*
   * From the server, not from `src/data/org`. This panel listed the bundled
   * demo calendar, so a tenant with no holidays configured saw a full and
   * convincing year — and an administrator who added one in Settings watched
   * this page not change, because it was never reading the database.
   */
  const { data: HOLIDAYS } = useHolidays();
  const exportCsv = () =>
    downloadCSV(
      `holiday_calendar_${y}.csv`,
      [['Date', 'Day', 'Holiday', 'Type', 'Applies to']].concat(
        HOLIDAYS.map((h) => [h.d, DOW[parseYmd(h.d).getDay()], h.n,
          h.opt ? 'Optional' : 'Fixed', h.site ?? 'All locations']),
      ),
    );

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <Card title={'Holiday calendar ' + y}
          sub={`${HOLIDAYS.filter((h) => !h.opt).length} fixed · ${HOLIDAYS.filter((h) => h.opt).length} optional`}
          actions={<button className="btn sm" onClick={exportCsv}><Icon n="download" size="lg" /> Export</button>} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Day</th><th>Holiday</th><th>Type</th><th>Applies to</th><th className="right">Status</th></tr>
              </thead>
              <tbody>
                {HOLIDAYS.map((h) => (
                  /* Keyed with the location: two sites may share a date and a name. */
                  <tr key={`${h.d}|${h.n}|${h.site ?? 'all'}`}>
                    <td className="nowrap">{fmtD(h.d)}</td>
                    <td>{DOW[parseYmd(h.d).getDay()]}</td>
                    <td><b>{h.n}</b></td>
                    <td>{h.opt ? <Badge kind="info">Optional</Badge> : <Badge>Fixed</Badge>}</td>
                    <td>{h.site ?? `All locations`}</td>
                    <td className="right">{h.d < ymd(TODAY) ? <span className="muted">Past</span> : <Badge kind="good">Upcoming</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Shift & work-week policy" sub="Applies to all sites">
          <KV rows={[
            /*
             * Read from the patterns the tenant actually has, not asserted.
             *
             * These two rows said "Monday – Friday (5 days)" and "Saturday,
             * Sunday" as flat text. That stopped being true the moment a tenant
             * could define a six-day or Sunday-to-Thursday pattern, and a policy
             * table stating a working week the product does not keep is worse
             * than one saying nothing.
             */
            ['Work week', patterns.length
              ? patterns.map((w) =>
                `${w.name} (${w.days.filter((d) => d.working).length} days)`).join(' · ')
              : 'No working pattern configured'],
            ['Week off', patterns.length
              ? 'Whatever each pattern leaves unworked — see Shifts & work schedules'
              : 'Monday – Friday is assumed until a pattern is set'],
            ...SITES.filter((s) => !s.remote).map((s) => [s.city + ' shift', s.shift + ' IST'] as [string, string]),
            ['Grace period', '20 minutes · 3 late marks = ½ day CL'],
            ['Full day', '≥ 8 h 0 m · Half day 4 h 0 m'],
            ['Optional holidays', 'Any 2 per calendar year'],
            ['Location tracking', 'None — punches record a work mode, not a place'],
          ]} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'me' | 'live' | 'log' | 'reg' | 'cal';

function Attendance() {
  const app = useApp();

  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'me', label: 'My Attendance' }, { v: 'reg', label: 'Regularisation' }, { v: 'cal', label: 'Holiday Calendar' }]
    : [
        { v: 'live', label: 'Live Board' }, { v: 'me', label: 'My Attendance' }, { v: 'log', label: 'Attendance Log' },
        { v: 'reg', label: 'Regularisation' }, { v: 'cal', label: 'Holiday Calendar' },
      ];

  const [tab, setTab] = useTabFromUrl<Tab>(tabs[0]!.v, tabs.map((t) => t.v));
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  const openReg = useOpenRegularisation();

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'me' && <AttMe onRegularise={openReg} />}
      {active === 'live' && <AttLive />}
      {active === 'log' && <AttLog />}
      {active === 'reg' && <AttReg onRegularise={openReg} />}
      {active === 'cal' && <AttCal />}
    </>
  );
}

registerModule({
  key: 'attendance',
  title: TITLES.attendance,
  Component: Attendance,
});
