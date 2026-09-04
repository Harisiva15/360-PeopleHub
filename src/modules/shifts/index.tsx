import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, DOW, dowOf, fmtD, fmtDS, isWeekend, mondayOf, TODAY, ymd } from '../../lib/dates';
import { inr } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { uid } from '../../lib/rng';
import { ACTIVE, EMAP, empName } from '../../data/employees';
import { LEAVE_BAL, leaveBalance } from '../../data/leave';
import { DEPTS, deptOf } from '../../data/org';
import { OVERTIME, ROSTER, SHIFTS, shiftOf } from '../../data/shifts';
import type { Overtime } from '../../data/shifts';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { Dot, StatusBadge } from '../../components/common';
import { BarChart, Legend } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

/** Flexible has no fixed timing, so it is excluded from coverage and legends. */
const ROSTERED = SHIFTS.filter((s) => s.id !== 'FLEX');

const NIGHT_ALLOWANCE = 350;
/** Indicative hourly rate used to price approved overtime. */
const OT_HOURLY = 450;

/* ---------------- Team roster ---------------- */

function ShRoster() {
  const app = useApp();
  const layer = useLayer();
  const [dept, setDept] = useState('SUP');

  const start = mondayOf(TODAY);
  const days: Date[] = [];
  for (let i = 0; i < 14; i++) days.push(addDays(start, i));

  const ids = visibleIds(app.role, app.meId);
  const people = ACTIVE().filter((e) => e.dept === dept && ids.includes(e.id));
  const coverage = days.map((d) => ROSTERED.map((s) => people.filter((p) => ROSTER[p.id]?.[ymd(d)] === s.id).length));

  const editCell = (id: string, ds: string) => {
    if (app.role === 'employee') return;
    layer.modal({
      title: 'Change shift',
      sub: empName(id) + ' · ' + fmtD(ds),
      size: 'narrow',
      body: (close) => <ShiftPicker id={id} ds={ds} close={close} />,
      footer: null,
    });
  };

  function ShiftPicker({ id, ds, close }: { id: string; ds: string; close: () => void }) {
    const [v, setV] = useState(ROSTER[id]?.[ds] || 'GEN');
    return (
      <>
        <div className="field">
          <label>Shift</label>
          <select className="input" value={v} onChange={(e) => setV(e.target.value)}>
            {SHIFTS.map((s) => <option key={s.id} value={s.id}>{s.n} ({s.start} – {s.end})</option>)}
            <option value="OFF">Week off</option>
          </select>
        </div>
        <Banner kind="info" icon="📧">The employee is notified of any roster change and must acknowledge it.</Banner>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => {
            ROSTER[id][ds] = v;
            close();
            app.toast('Roster updated and employee notified', 'ok');
            app.bump();
          }}>Save</button>
        </div>
      </>
    );
  }

  const exportCsv = () => {
    const ds = days.map((d) => ymd(d));
    downloadCSV(`roster_${dept}.csv`,
      [['Emp Code', 'Name', ...ds]].concat(
        ACTIVE().filter((e) => e.dept === dept).map((e) => [e.code, e.name, ...ds.map((d) => ROSTER[e.id]?.[d] || '')]),
      ));
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={dept} onChange={(e) => setDept(e.target.value)}>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {people.length} people · {fmtD(ymd(days[0]))} – {fmtD(ymd(days[13]))}
        </span>
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
        {app.role === 'admin' && (
          <button className="btn primary" onClick={() => app.toast('Roster auto-assigned for the next 2 weeks respecting all rules', 'ok')}>
            ⚡ Auto-assign
          </button>
        )}
      </div>

      <Card title="Roster" sub={`${deptOf(dept).name} · click a cell to change the shift`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl" style={{ fontSize: 11.5 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 180, position: 'sticky', left: 0, background: 'var(--surface-2)', zIndex: 2 }}>Employee</th>
                {days.map((d, i) => (
                  <th key={i} style={{ textAlign: 'center', minWidth: 58, ...(isWeekend(d) ? { background: 'var(--surface-3)' } : {}) }}>
                    {DOW[d.getDay()]}<br /><span style={{ opacity: 0.7 }}>{d.getDate()}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {people.map((e) => (
                <tr key={e.id}>
                  <td style={{ position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>
                    <PersonCell e={e} sub={false} />
                  </td>
                  {days.map((d, i) => {
                    const ds = ymd(d);
                    const s = ROSTER[e.id]?.[ds] || 'GEN';
                    if (s === 'OFF') {
                      return (
                        <td key={i} style={{ textAlign: 'center', background: 'var(--surface-3)', color: 'var(--ink-3)' }}
                          data-tip={`${e.name} · week off · ${fmtD(ds)}`}>OFF</td>
                      );
                    }
                    const sh = shiftOf(s);
                    return (
                      <td key={i} className="clickable" onClick={() => editCell(e.id, ds)}
                        style={{ textAlign: 'center', background: `color-mix(in srgb, ${sh.c} 16%, transparent)`, fontWeight: 650 }}
                        data-tip={`${e.name} · ${sh.n} ${sh.start}–${sh.end} · ${fmtD(ds)}`}>{s}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '12px 16px' }}>
          <Legend items={ROSTERED.map((s) => ({ k: `${s.n} (${s.start}–${s.end})`, c: s.c })).concat([{ k: 'Week off', c: 'var(--line-2)' }])} />
        </div>
      </Card>

      <Card title="Shift coverage" sub="Headcount per shift per day">
        <BarChart labels={days.map((d) => fmtDS(ymd(d)))} height={210} stacked
          series={ROSTERED.map((s, i) => ({ name: s.n, color: s.c, data: coverage.map((c) => c[i]) }))} />
        <Legend items={ROSTERED.map((s) => ({ k: s.n, c: s.c }))} />
      </Card>
    </div>
  );
}

/* ---------------- My roster ---------------- */

function ShMy() {
  const app = useApp();
  const me = app.me;
  const start = addDays(TODAY, -7);
  const days: Date[] = [];
  for (let i = 0; i < 28; i++) days.push(addDays(start, i));

  const mine = ROSTER[me.id] || {};
  const todayShift = mine[ymd(TODAY)];
  const nights = days.filter((d) => mine[ymd(d)] === 'NIGHT').length;
  const offs = days.filter((d) => mine[ymd(d)] === 'OFF').length;
  const lead = days[0].getDay();

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Current shift" value={shiftOf(todayShift === 'OFF' ? 'GEN' : todayShift || 'GEN').n}
          foot={todayShift === 'OFF'
            ? 'Today is a week off'
            : `${shiftOf(todayShift || 'GEN').start} – ${shiftOf(todayShift || 'GEN').end}`} />
        <Tile label="Night shifts" value={nights}
          foot={nights ? `Allowance ${inr(nights * NIGHT_ALLOWANCE)} for this window` : 'None rostered'} />
        <Tile label="Week offs" value={offs} foot="In the next 4 weeks" />
        <Tile label="Comp off balance" value={(leaveBalance(me.id, 'CO')?.avail ?? 0) + ' days'} foot="Earned from extra working days" />
      </div>

      <Card title="My roster" sub={`4-week view · ${fmtD(ymd(days[0]))} – ${fmtD(ymd(days[27]))}`}
        actions={<button className="btn sm" onClick={() => app.toast('Swap request sent to your shift lead', 'ok')}>⇄ Request a swap</button>}>
        <div className="cal">
          {DOW.map((d) => <div className="dow" key={d}>{d[0]}</div>)}
          {Array.from({ length: lead }, (_, i) => <div className="day mut" key={'l' + i} />)}
          {days.map((d) => {
            const ds = ymd(d);
            const s = mine[ds] || 'GEN';
            const sh = shiftOf(s === 'OFF' ? 'GEN' : s);
            const isToday = ds === ymd(TODAY);
            return (
              <div key={ds} className="day"
                style={{
                  ...(s === 'OFF'
                    ? { background: 'var(--surface-3)', color: 'var(--ink-3)' }
                    : { background: `color-mix(in srgb, ${sh.c} 15%, transparent)` }),
                  ...(isToday ? { outline: '2px solid var(--brand)', outlineOffset: -2 } : {}),
                }}
                data-tip={`${fmtD(ds)} · ${s === 'OFF' ? 'Week off' : `${sh.n} ${sh.start}–${sh.end}`}`}>
                {d.getDate()}<small>{s === 'OFF' ? 'OFF' : s}</small>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12 }}>
          <Legend items={ROSTERED.map((s) => ({ k: s.n, c: s.c })).concat([{ k: 'Week off', c: 'var(--line-2)' }])} />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Overtime & comp off ---------------- */

function OtTable({ list, act, onApprove }: { list: Overtime[]; act: boolean; onApprove: (o: Overtime) => void }) {
  if (!list.length) return <EmptyState msg="Nothing logged" icon="⏱️" />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {act && <th>Employee</th>}
            <th>Date</th><th className="num">Hours</th><th>Reason</th><th>Compensation</th><th>Status</th>
            {act && <th className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {sortBy(list, (o) => o.date, 'desc').map((o) => (
            <tr key={o.id}>
              {act && <td><PersonCell e={EMAP[o.empId]} /></td>}
              <td className="nowrap">{fmtD(o.date)} <span className="muted">{dowOf(o.date)}</span></td>
              <td className="num strong">{o.hours}</td>
              <td>{o.reason}</td>
              <td>
                <Badge kind={o.compensation === 'Comp Off' ? 'info' : 'good'}>
                  {o.compensation === 'Comp Off' ? 'Comp off' : 'Overtime pay'}
                </Badge>
              </td>
              <td><StatusBadge status={o.status} /></td>
              {act && (
                <td className="right">
                  {o.status === 'Pending'
                    ? <button className="btn sm primary" onClick={() => onApprove(o)}>Approve</button>
                    : <span className="muted">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ShOt() {
  const app = useApp();
  const layer = useLayer();
  const ids = visibleIds(app.role, app.meId);
  const mine = OVERTIME.filter((o) => o.empId === app.meId);
  const team = app.role === 'employee' ? [] : OVERTIME.filter((o) => ids.includes(o.empId) && o.empId !== app.meId);
  const pend = team.filter((o) => o.status === 'Pending');

  const approve = (o: Overtime) => {
    o.status = 'Approved';
    /* comp off is credited at one day per eight hours worked */
    if (o.compensation === 'Comp Off' && LEAVE_BAL[o.empId]?.CO) {
      LEAVE_BAL[o.empId].CO.quota += Math.round(o.hours / 8);
    }
    app.toast('Overtime approved' + (o.compensation === 'Comp Off' ? ' — comp off credited' : ''), 'ok');
    app.bump();
  };

  function LogForm({ close }: { close: () => void }) {
    const [date, setDate] = useState(ymd(addDays(TODAY, -1)));
    const [hours, setHours] = useState(4);
    const [reason, setReason] = useState('');
    const [comp, setComp] = useState<'Comp Off' | 'Overtime Pay'>('Comp Off');
    return (
      <>
        <div className="field"><label>Date</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="field">
          <label>Hours worked beyond your shift</label>
          <input type="number" className="input" min={1} max={12} value={hours} onChange={(e) => setHours(+e.target.value || 1)} />
        </div>
        <div className="field">
          <label>Reason</label>
          <textarea className="input" placeholder="Release support, escalation, migration window…" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="field">
          <label>Preferred compensation</label>
          <select className="input" value={comp} onChange={(e) => setComp(e.target.value as 'Comp Off' | 'Overtime Pay')}>
            <option>Comp Off</option><option>Overtime Pay</option>
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => {
            OVERTIME.unshift({
              id: uid('OT'), empId: app.meId, date, hours, reason: reason || 'Extra hours',
              status: 'Pending', compensation: comp, approverId: app.me.managerId,
            });
            close();
            app.toast('Submitted for approval', 'ok');
            app.bump();
          }}>Submit</button>
        </div>
      </>
    );
  }

  return (
    <div className="stack">
      <Banner kind="info" icon="⏱️" title="How extra hours are compensated">
        Work on a week off or beyond 10 hours on a working day can be claimed as comp off (1 day per 8 hours) or
        overtime pay at 1.5× the hourly rate. Comp off must be used within 60 days.
      </Banner>

      <div className="grid g4">
        <Tile label="My overtime" value={sum(mine.filter((o) => o.status === 'Approved'), (o) => o.hours) + ' h'} foot="Approved, last 45 days" />
        <Tile label="Comp off balance" value={(leaveBalance(app.meId, 'CO')?.avail ?? 0) + ' days'} foot="Use within 60 days" />
        <Tile label="Team pending" value={pend.length} foot="Awaiting your approval" />
        <Tile label="Overtime cost"
          value={inr(sum(team.filter((o) => o.status === 'Approved' && o.compensation === 'Overtime Pay'), (o) => o.hours * OT_HOURLY))}
          foot="Payable this cycle" />
      </div>

      <Card title="My overtime" sub={`${mine.length} entries`} flush
        actions={
          <button className="btn sm primary" onClick={() =>
            layer.modal({
              title: 'Log extra hours',
              sub: 'Sent to ' + empName(app.me.managerId || '') + ' for approval',
              size: 'narrow',
              body: (close) => <LogForm close={close} />,
              footer: null,
            })}>＋ Log extra hours</button>
        }>
        <OtTable list={mine} act={false} onApprove={approve} />
      </Card>

      {app.role !== 'employee' && (
        <Card title="Team overtime" sub={`${team.length} entries · ${pend.length} pending`} flush>
          <OtTable list={team} act onApprove={approve} />
        </Card>
      )}
    </div>
  );
}

/* ---------------- Shift definitions ---------------- */

const ROSTER_RULES: [string, string][] = [
  ['Weekly offs', 'Two consecutive offs per week wherever the roster allows.'],
  ['Night shift limits', 'No more than 5 consecutive nights; minimum 24 hours rest before switching.'],
  ['Rotation', 'Rotational teams move one shift forward each week.'],
  ['Minimum coverage', 'At least 3 people on the support desk during business hours, 2 at night.'],
  ['Notice', 'Roster published 14 days in advance; changes need employee acknowledgement.'],
  ['Night allowance', '₹350 per night shift, paid with the following payroll.'],
  ['Women on night shift', 'Voluntary, with transport provided door to door, as required by law.'],
];

function ShDef() {
  return (
    <div className="grid g-2-1">
      <Card title="Shift definitions" sub={`${SHIFTS.length} patterns configured`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Shift</th><th>Timing</th><th className="num">Break</th><th className="num">Grace</th><th className="num">Night allowance</th><th className="num">People</th></tr>
            </thead>
            <tbody>
              {SHIFTS.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Dot color={s.c} /> <b>{s.n}</b>
                    {s.night && <> <Badge kind="info">Night</Badge></>}
                  </td>
                  <td className="mono">{s.start} – {s.end}</td>
                  <td className="num">{s.brk} min</td>
                  <td className="num">{s.grace} min</td>
                  <td className="num">{s.allowance ? inr(s.allowance) + ' / night' : '—'}</td>
                  <td className="num">{ACTIVE().filter((e) => ROSTER[e.id]?.[ymd(TODAY)] === s.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Roster rules" sub="Applied when auto-assigning">
        <div className="stack" style={{ gap: 11, fontSize: 13 }}>
          {ROSTER_RULES.map(([k, v]) => (
            <div key={k}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{k}</div>
              <div className="muted">{v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'roster' | 'my' | 'ot' | 'def';

function Shifts() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'my', label: 'My Roster' }, { v: 'ot', label: 'Overtime & Comp Off' }, { v: 'def', label: 'Shift Definitions' }]
    : [
        { v: 'roster', label: 'Team Roster' }, { v: 'my', label: 'My Roster' },
        { v: 'ot', label: 'Overtime & Comp Off' }, { v: 'def', label: 'Shift Definitions' },
      ];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'roster' && <ShRoster />}
      {active === 'my' && <ShMy />}
      {active === 'ot' && <ShOt />}
      {active === 'def' && <ShDef />}
    </>
  );
}

registerModule({
  key: 'shifts',
  title: TITLES.shifts,
  subtitle: () => `${SHIFTS.length} shift patterns · rotational rosters, overtime and comp off`,
  Component: Shifts,
});
