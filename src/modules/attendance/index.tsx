import { useState } from 'react';
import { Link } from 'react-router-dom';
import { groupBy, sortBy, sum } from '../../lib/collections';
import { addDays, DOW, dowOf, fmtD, fmtDS, fmtTime, hhmm, monthKey, monthLabelLong, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import type { AttRecord, Employee } from '../../services';
import { DEPTS, deptOf, HOLIDAYS, siteOf, SITES } from '../../data/org';
import { PAYRUNS } from '../../data/payroll';
import { Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile } from '../../components/ui';
import { ListRow, StatusBadge } from '../../components/common';
import { BarChart, HBar, Legend, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { SCOPE } from '../../state/rbac';
import { useShowEmployee } from '../employees/Profile';
import { MapBox, PunchWidget } from './Punch';
import {
  useActOnRegularisation, useAttendance, useMyAttendance, usePeople,
  useRaiseRegularisation, useRegularisableDays, useRegularisations, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { MonthCalendar } from '../dashboard/shared';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

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

/** Geo-fence cell — WFH and client punches are logged but not enforced. */
function GeoCell({ r }: { r: AttRecord }) {
  if (!r.inT) return <>—</>;
  if (r.site === 'WFH' || r.site === 'CLIENT') return <Badge>Logged</Badge>;
  return r.geoOk
    ? <Badge kind="good">✓ {r.dist == null ? 'OK' : r.dist + ' m'}</Badge>
    : <Badge kind="crit">⚠ {r.dist} m</Badge>;
}

function useAttDetail(dir: Directory) {
  const layer = useLayer();
  return (r: AttRecord) => {
    const name = dir.name(r.empId);
    const s = siteOf(r.site);
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
            ['Source', r.src || '—'],
            ...(r.lat ? [['Coordinates', <span className="mono">{r.lat}, {r.lng}</span>]] as [string, React.ReactNode][] : []),
            ...(r.dist != null ? [['Distance from site', `${r.dist} m (fence ${s.radius} m)`]] as [string, React.ReactNode][] : []),
            ['Geo-fence', r.site === 'WFH' || r.site === 'CLIENT'
              ? 'Not enforced — location logged for audit'
              : r.geoOk ? <Badge kind="good">Verified</Badge> : <Badge kind="crit">Exception — outside radius</Badge>],
            ...(r.notes ? [['Notes', r.notes]] as [string, React.ReactNode][] : []),
            ...(r.reg ? [['Regularisation', <><StatusBadge status={r.reg.status} /> — {r.reg.reason}</>]] as [string, React.ReactNode][] : []),
          ]} />
          {r.lat && (
            <MapBox
              points={[{ lat: r.lat, lng: r.lng, label: name, me: true, bad: !r.geoOk }]}
              site={r.site === 'WFH' || r.site === 'CLIENT' ? null : s}
              height={220}
            />
          )}
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
        {r.reg && <> <Badge kind="info" >⟳ {r.reg.status}</Badge></>}
      </td>
      <td className="mono">
        {r.inT ? <>{fmtTime(r.inT)}{r.late && <span style={{ color: 'var(--crit)' }} title="Late"> •</span>}</> : '—'}
      </td>
      <td className="mono">{r.outT ? fmtTime(r.outT) : '—'}</td>
      <td className="num">{r.mins ? hhmm(r.mins) : '—'}</td>
      <td className="nowrap">{r.inT ? siteOf(r.site).name : '—'}</td>
      <td><GeoCell r={r} /></td>
      <td className="muted">{r.src || '—'}</td>
    </tr>
  );
}

/* ---------------- My attendance ---------------- */

function AttMe({ onRegularise }: { onRegularise: () => void }) {
  const app = useApp();
  const me = app.me;
  const self = usePeople([me.id]);
  const detail = useAttDetail(self);
  const months = PAYRUNS.map((p) => p.mk).slice(-8);
  const [mk, setMk] = useState(monthKey(TODAY));

  const { data: recs = [] } = useMyAttendance(me.id, mk + '-01', mk + '-31');
  const work = recs.filter((r) => ['P', 'W', 'A', 'L'].includes(r.status));
  const present = recs.filter((r) => r.status === 'P' || r.status === 'W').length;
  const late = recs.filter((r) => r.late).length;
  const hrs = sum(recs, (r) => r.mins) / 60;
  const avg = present ? hrs / present : 0;
  const unapproved = recs.filter((r) => r.status === 'A' && (!r.reg || r.reg.status !== 'Approved')).length;

  const exportCsv = () =>
    downloadCSV(
      `attendance_${me.code}_${mk}.csv`,
      [['Date', 'Day', 'Status', 'In', 'Out', 'Hours', 'Mode', 'Distance (m)', 'Geo OK', 'Source', 'Notes']].concat(
        sortBy(recs, (r) => r.date).map((r) => [
          r.date, dowOf(r.date), r.status, r.inT || '', r.outT || '', (r.mins / 60).toFixed(2),
          siteOf(r.site).name, r.dist == null ? '' : String(r.dist), r.inT ? (r.geoOk ? 'Yes' : 'No') : '', r.src || '', r.notes || '',
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
        <button className="btn" onClick={onRegularise}>＋ Request regularisation</button>
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Present days" value={present} foot={`${work.length} working days in month`} />
        <Tile label="Total hours" value={hrs.toFixed(1) + ' h'} foot={`Avg ${avg.toFixed(1)} h / day`} />
        <Tile label="WFH days" value={recs.filter((r) => r.status === 'W').length} foot="Policy: up to 8 / month" />
        <Tile label="Leave / absent"
          value={`${recs.filter((r) => r.status === 'L').length} / ${recs.filter((r) => r.status === 'A').length}`}
          foot={`${unapproved} unapproved (LOP)`} />
        <Tile label="Late marks" value={late} trend={late > 3 ? 'down' : undefined}
          foot={late > 3 ? 'Above threshold (3)' : 'Within policy'} />
      </div>

      <div className="grid g-1-2">
        <Card title="Calendar" sub={monthLabelLong(mk)}>
          <MonthCalendar records={recs} mk={mk} />
        </Card>
        <Card title="Daily log" sub={`${recs.length} records`} flush>
          <div style={{ maxHeight: 520, overflow: 'auto' }} className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th className="num">Hours</th><th>Mode</th><th>Geo-fence</th><th>Source</th></tr>
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

  const flagged = recs.filter((r) => r.geoOk === false);
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
      [['Emp Code', 'Name', 'Department', 'Status', 'In', 'Out', 'Hours', 'Mode', 'Distance (m)', 'Geo OK']].concat(
        recs.map((r) => {
          const e = dir.byId(r.empId);
          return [e?.code ?? r.empId, e?.name ?? '—', e ? deptOf(e.dept).name : '—', r.status, r.inT || '', r.outT || '',
            (r.mins / 60).toFixed(2), siteOf(r.site).name, r.dist == null ? '' : String(r.dist),
            r.inT ? (r.geoOk ? 'Yes' : 'No') : ''];
        }),
      ),
    );

  const pendingRegs = recs.filter((r) => r.reg && r.reg.status === 'Pending').length;

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="In office" value={c.P} foot={pct(c.P, Math.max(1, recs.length - c.H - c.O)) + '% of expected'} />
        <Tile label="Work from home" value={c.W} foot="Location logged, fence not enforced" />
        <Tile label="On leave" value={c.L} foot="Approved leave today" />
        <Tile label="Absent" value={c.A} foot={`${pendingRegs} regularisation pending`} />
        <Tile label="Geo exceptions" value={flagged.length} trend={flagged.length ? 'down' : undefined}
          foot={flagged.length ? 'Needs review' : 'All punches verified'} />
      </div>

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
              <button className="btn sm" onClick={exportCsv}>⤓</button>
            </div>
          }>
          <div style={{ maxHeight: 560, overflow: 'auto' }} className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Department</th><th>Status</th><th>In</th><th>Out</th><th className="num">Hrs</th><th>Mode</th><th>Geo-fence</th></tr>
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
                      <td><GeoCell r={r} /></td>
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
      flags: rs.filter((r) => r.geoOk === false).length,
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
      [['Emp Code', 'Name', 'Department', 'Location', 'Date', 'Status', 'In', 'Out', 'Hours', 'Mode', 'Geo OK', 'Source']].concat(
        sortBy(recs, (r) => r.date).map((r) => {
          const e = dir.byId(r.empId);
          return [e?.code ?? r.empId, e?.name ?? '—', e ? deptOf(e.dept).name : '—', e ? siteOf(e.site).name : '—', r.date, r.status,
            r.inT || '', r.outT || '', (r.mins / 60).toFixed(2), siteOf(r.site).name,
            r.inT ? (r.geoOk ? 'Yes' : 'No') : '', r.src || ''];
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
        <button className="btn" onClick={exportCsv}>⤓ Export muster roll</button>
      </div>

      <div className="grid g4">
        <Tile label="Attendance rate" value={pct(present.length, Math.max(1, work.length)) + '%'}
          foot={`${present.length} of ${work.length} person-days`} />
        <Tile label="Total hours" value={Math.round(sum(recs, (r) => r.mins) / 60).toLocaleString('en-IN') + ' h'}
          foot={`Avg ${(sum(recs, (r) => r.mins) / 60 / Math.max(1, present.length)).toFixed(1)} h/day`} />
        <Tile label="WFH share" value={pct(recs.filter((r) => r.status === 'W').length, Math.max(1, present.length)) + '%'}
          foot={`${recs.filter((r) => r.status === 'W').length} WFH days logged`} />
        <Tile label="Geo exceptions" value={recs.filter((r) => r.geoOk === false).length} foot="Punches outside fence radius" />
      </div>

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
                <th className="num">Hours</th><th className="num">Flags</th><th className="num">Rate</th>
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
                  <td className="num">{r.flags ? <Badge kind="crit">{r.flags}</Badge> : '—'}</td>
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

/* ---------------- Geo map ---------------- */

function AttGeo() {
  const app = useApp();
  const dir = useVisiblePeople();
  const detail = useAttDetail(dir);
  const [focusSite, setFocusSite] = useState('CHN');
  const [ds, setDs] = useState(ymd(TODAY));

  const { data: dayRows = [] } = useAttendance(dir.ids, ds, ds);
  const { data: recent = [] } = useAttendance(dir.ids, ymd(addDays(TODAY, -30)), ymd(TODAY));
  const recs = dayRows.filter((r) => r.lat != null);
  const flagged = recent.filter((r) => r.geoOk === false);
  const site = siteOf(focusSite);
  const pts = recs.filter((r) => r.site === focusSite).map((r) => ({
    lat: r.lat, lng: r.lng, label: dir.name(r.empId),
    sub: fmtTime(r.inT) + ' · ' + (r.dist == null ? '' : r.dist + ' m'),
    bad: !r.geoOk,
  }));

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="seg">
          {['CHN', 'BLR', 'HYD'].map((s) => (
            <button key={s} className={focusSite === s ? 'on' : ''} onClick={() => setFocusSite(s)}>{siteOf(s).city}</button>
          ))}
        </div>
        <input type="date" className="input" style={{ width: 'auto' }} value={ds} onChange={(e) => setDs(e.target.value)} />
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>{pts.length} punches plotted · fence radius {site.radius} m</span>
      </div>

      <div className="grid g-2-1">
        <Card title={site.name + ' — punch map'} sub={`${site.addr} · ${site.lat}, ${site.lng}`}>
          <MapBox points={pts} site={site} height={380} />
          <div className="legend" style={{ marginTop: 10 }}>
            <span>🏢 Office centre</span>
            <span>👤 Punch inside fence</span>
            <span>❗ Punch outside fence</span>
            <span style={{ color: 'var(--ink-3)' }}>Hover a pin for details</span>
          </div>
        </Card>

        <div className="stack">
          <Card title="Fence configuration" sub="Configured sites" flush>
            {SITES.filter((s) => s.lat).map((s) => (
              <ListRow key={s.id}>
                <span>📍</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{s.name}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>{s.lat}, {s.lng}</div>
                </div>
                <Badge kind="info">{s.radius} m</Badge>
              </ListRow>
            ))}
            {app.role === 'admin' && (
              <ListRow><Link className="btn sm" to="/settings">⚙ Edit geo-fences</Link></ListRow>
            )}
          </Card>

          <Card title="Exceptions — last 30 days" sub={`${flagged.length} flagged punches`} flush>
            <div style={{ maxHeight: 330, overflow: 'auto' }}>
              {flagged.length ? sortBy(flagged, (r) => r.date, 'desc').slice(0, 40).map((r) => (
                <ListRow key={r.id} onClick={() => detail(r)}>
                  <Avatar name={dir.name(r.empId)} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(r.empId)}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{fmtD(r.date)} · {fmtTime(r.inT)} · {siteOf(r.site).name}</div>
                  </div>
                  <Badge kind="crit">{r.dist} m</Badge>
                </ListRow>
              )) : <EmptyState msg="No geo-fence exceptions 🎯" />}
            </div>
          </Card>
        </div>
      </div>
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
  if (!list.length) return <EmptyState msg="Nothing here" icon="⟳" />;
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
        Raise a request when a punch is missing or was recorded outside the geo-fence. Your reporting manager approves it,
        and the day stops counting as Loss of Pay in payroll.
      </Banner>

      {canAct && pending.length > 0 && (
        <Card title="Pending your approval" sub={`${pending.length} requests`} flush>
          <RegTable list={pending} act dir={dir} onApprove={approve} onReject={reject} />
        </Card>
      )}

      <Card title="My requests" sub={`${mine.length} total`} flush
        actions={<button className="btn sm primary" onClick={onRegularise}>＋ New request</button>}>
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
  const exportCsv = () =>
    downloadCSV(
      `holiday_calendar_${y}.csv`,
      [['Date', 'Day', 'Holiday', 'Type']].concat(
        HOLIDAYS.map((h) => [h.d, DOW[parseYmd(h.d).getDay()], h.n, h.opt ? 'Optional' : 'Fixed']),
      ),
    );

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <Card title={'Holiday calendar ' + y}
          sub={`${HOLIDAYS.filter((h) => !h.opt).length} fixed · ${HOLIDAYS.filter((h) => h.opt).length} optional`}
          actions={<button className="btn sm" onClick={exportCsv}>⤓ Export</button>} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Date</th><th>Day</th><th>Holiday</th><th>Type</th><th>Applies to</th><th className="right">Status</th></tr>
              </thead>
              <tbody>
                {HOLIDAYS.map((h) => (
                  <tr key={h.d + h.n}>
                    <td className="nowrap">{fmtD(h.d)}</td>
                    <td>{DOW[parseYmd(h.d).getDay()]}</td>
                    <td><b>{h.n}</b></td>
                    <td>{h.opt ? <Badge kind="info">Optional</Badge> : <Badge>Fixed</Badge>}</td>
                    <td>All locations</td>
                    <td className="right">{h.d < ymd(TODAY) ? <span className="muted">Past</span> : <Badge kind="good">Upcoming</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Shift & work-week policy" sub="Applies to all sites">
          <KV rows={[
            ['Work week', 'Monday – Friday (5 days)'],
            ['Week off', 'Saturday, Sunday'],
            ...SITES.filter((s) => s.lat).map((s) => [s.city + ' shift', s.shift + ' IST'] as [string, string]),
            ['Grace period', '20 minutes · 3 late marks = ½ day CL'],
            ['Full day', '≥ 8 h 0 m · Half day 4 h 0 m'],
            ['Optional holidays', 'Any 2 per calendar year'],
            ['Geo-fence', 'Enforced for in-office punches only'],
          ]} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- regularisation request modal ---------------- */

function RegForm({ close }: { close: () => void }) {
  const app = useApp();
  const me = app.me;
  const { data: missing = [] } = useRegularisableDays(me.id, ymd(addDays(TODAY, -30)));
  const raise = useRaiseRegularisation();

  const [picked, setPicked] = useState('');
  const [inT, setInT] = useState('09:30');
  const [outT, setOutT] = useState('18:30');
  const [reason, setReason] = useState('Forgot to punch in');
  const [note, setNote] = useState('');

  /* The candidate days arrive asynchronously, so default once they are in. */
  const date = picked || missing[0]?.date || ymd(addDays(TODAY, -1));
  const setDate = setPicked;

  const submit = async () => {
    await raise.mutate(me.id, date, inT, outT, reason + (note ? ' — ' + note : ''));
    close();
    app.toast('Regularisation request submitted', 'ok');
  };

  return (
    <>
      <div className="field">
        <label>Date</label>
        <select className="input" value={date} onChange={(e) => setDate(e.target.value)}>
          {missing.length ? missing.map((r) => (
            <option key={r.date} value={r.date}>
              {fmtD(r.date)} — {r.status === 'A' ? 'Absent' : 'Geo-fence exception'}
            </option>
          )) : <option value={ymd(addDays(TODAY, -1))}>{fmtD(addDays(TODAY, -1))}</option>}
        </select>
      </div>
      <div className="grid g2">
        <div className="field"><label>Punch in</label><input type="time" className="input" value={inT} onChange={(e) => setInT(e.target.value)} /></div>
        <div className="field"><label>Punch out</label><input type="time" className="input" value={outT} onChange={(e) => setOutT(e.target.value)} /></div>
      </div>
      <div className="field">
        <label>Reason</label>
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
          {['Forgot to punch in', 'Forgot to punch out', 'Biometric device down', 'Working from client location',
            'Network / app issue', 'On official travel', 'Other'].map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Additional notes</label>
        <textarea className="input" placeholder="Give your manager context…" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={submit}>Submit request</button>
      </div>
    </>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'me' | 'live' | 'log' | 'geo' | 'reg' | 'cal';

function Attendance() {
  const app = useApp();
  const layer = useLayer();

  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'me', label: 'My Attendance' }, { v: 'reg', label: 'Regularisation' }, { v: 'cal', label: 'Holiday Calendar' }]
    : [
        { v: 'live', label: 'Live Board' }, { v: 'me', label: 'My Attendance' }, { v: 'log', label: 'Attendance Log' },
        { v: 'geo', label: 'Geo Map & Exceptions' }, { v: 'reg', label: 'Regularisation' }, { v: 'cal', label: 'Holiday Calendar' },
      ];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;
  const approver = usePeople([app.me.managerId]);

  const openReg = () =>
    layer.modal({
      title: 'Request attendance regularisation',
      sub: 'Goes to ' + approver.name(app.me.managerId) + ' for approval',
      body: (close) => <RegForm close={close} />,
      footer: null,
    });

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'me' && <AttMe onRegularise={openReg} />}
      {active === 'live' && <AttLive />}
      {active === 'log' && <AttLog />}
      {active === 'geo' && <AttGeo />}
      {active === 'reg' && <AttReg onRegularise={openReg} />}
      {active === 'cal' && <AttCal />}
    </>
  );
}

registerModule({
  key: 'attendance',
  title: TITLES.attendance,
  subtitle: () => 'Punch in/out with location verification against site geo-fences',
  Component: Attendance,
});
