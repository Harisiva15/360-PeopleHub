import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, DOW, fmtD, fmtDS, isWeekend, MON, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { uid } from '../../lib/rng';
import { EMAP, empName } from '../../data/employees';
import { LEAVE_BAL, leaveBalance, LEAVES } from '../../data/leave';
import type { LeaveRequest } from '../../data/leave';
import { BANKABLE, HOLIDAY_MAP, LEAVE_TYPES, ltOf, ORG } from '../../data/org';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { Divide, Dot, ListRow, StatusBadge } from '../../components/common';
import { Donut, HBar, Legend } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const exportLeaves = (list: LeaveRequest[], name: string) =>
  downloadCSV(
    name,
    [['Emp Code', 'Name', 'Leave Type', 'From', 'To', 'Days', 'Reason', 'Status', 'Applied On', 'Approver']].concat(
      sortBy(list, (l) => l.from, 'desc').map((l) => {
        const e = EMAP[l.empId];
        return [e.code, e.name, ltOf(l.type).name, l.from, l.to, String(l.days), l.reason, l.status, l.appliedOn, empName(l.approverId || '')];
      }),
    ),
  );

/** Inline colour swatch for a leave type. */
function TypeDot({ type }: { type: string }) {
  return <span className="dot" style={{ display: 'inline-block', background: ltOf(type).color, marginRight: 6 }} />;
}

/* ---------------- apply modal ---------------- */

function ApplyForm({ close }: { close: () => void }) {
  const app = useApp();
  const me = app.me;
  const bals = Object.keys(LEAVE_BAL[me.id] || {}).map((t) => ({ t, ...leaveBalance(me.id, t)! }));

  const [type, setType] = useState(bals[0]?.t || 'CL');
  const [dur, setDur] = useState('full');
  const [from, setFrom] = useState(ymd(addDays(TODAY, 3)));
  const [to, setTo] = useState(ymd(addDays(TODAY, 3)));
  const [reason, setReason] = useState('');
  const [phone, setPhone] = useState(me.phone);

  /* the sandwich rule excludes week-offs and holidays between two leave days */
  const invalid = !from || !to || to < from;
  let days = 0;
  let excluded = 0;
  if (!invalid) {
    for (let d = parseYmd(from); ymd(d) <= to; d = addDays(d, 1)) {
      if (isWeekend(d) || HOLIDAY_MAP[ymd(d)]) excluded++;
      else days++;
    }
    if (dur !== 'full') days = 0.5;
  }
  const bal = leaveBalance(me.id, type);
  const enough = !bal || bal.avail >= days;

  const submit = () => {
    if (invalid || !days) {
      app.toast('Check the dates', 'err');
      return;
    }
    LEAVES.push({
      id: uid('LV'), empId: me.id, type, from, to, days,
      half: dur === 'full' ? null : dur,
      reason: reason || 'Personal',
      status: 'Pending', approverId: me.managerId, appliedOn: ymd(TODAY), actedOn: null, note: '',
    });
    close();
    app.toast('Leave request sent to ' + empName(me.managerId || ''), 'ok');
    app.bump();
  };

  return (
    <>
      <div className="grid g2" style={{ gap: '0 14px' }}>
        <div className="field">
          <label>Leave type</label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {bals.map((b) => <option key={b.t} value={b.t}>{ltOf(b.t).name} — {b.avail} available</option>)}
          </select>
        </div>
        <div className="field">
          <label>Duration</label>
          <select className="input" value={dur} onChange={(e) => setDur(e.target.value)}>
            <option value="full">Full day(s)</option>
            <option value="First Half">First half</option>
            <option value="Second Half">Second half</option>
          </select>
        </div>
        <div className="field"><label>From</label><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <div className="field">
        <label>Reason</label>
        <textarea className="input" placeholder="Briefly describe the reason…" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="field">
        <label>Contact during leave</label>
        <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>

      {invalid ? (
        <Banner kind="warn" icon="⚠️">End date must be on or after the start date.</Banner>
      ) : (
        <Banner kind={enough ? 'info' : 'warn'} icon={enough ? 'ℹ️' : '⚠️'} title={`${days} day(s) will be deducted`}>
          {excluded > 0 && `${excluded} week-off/holiday day(s) excluded by the sandwich rule. `}
          {bal && (
            <>
              Balance after approval: <b>{(bal.avail - days).toFixed(1)} day(s)</b>
              {!enough && ' — insufficient balance, excess will be Loss of Pay.'}
            </>
          )}
        </Banner>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={submit}>Submit request</button>
      </div>
    </>
  );
}

function useApplyLeave() {
  const layer = useLayer();
  const app = useApp();
  return () =>
    layer.modal({
      title: 'Apply for leave',
      sub: 'Approver: ' + empName(app.me.managerId || ''),
      body: (close) => <ApplyForm close={close} />,
      footer: null,
    });
}

/* ---------------- My leave ---------------- */

function LvMe() {
  const app = useApp();
  const apply = useApplyLeave();
  const me = app.me;

  const bals = Object.keys(LEAVE_BAL[me.id] || {}).map((t) => ({ t, ...leaveBalance(me.id, t)! }));
  const mine = sortBy(LEAVES.filter((l) => l.empId === me.id), (l) => l.from, 'desc');
  const upcoming = mine.filter((l) => l.from >= ymd(TODAY) && l.status !== 'Rejected' && l.status !== 'Cancelled');

  const bank = bals.filter((b) => BANKABLE.includes(b.t) && b.avail > 0);
  const other = bals.filter((b) => !BANKABLE.includes(b.t) && b.quota > 0);

  const cancel = (l: LeaveRequest) => {
    l.status = 'Cancelled';
    app.toast('Request cancelled');
    app.bump();
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={apply}>＋ Apply for leave</button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>Approver: {empName(me.managerId || '')}</span>
      </div>

      <div className="grid g4">
        {bals.filter((b) => b.quota + b.carry > 0).slice(0, 4).map((b) => (
          <div className="tile" key={b.t}>
            <div className="lbl">{ltOf(b.t).name}</div>
            <div className="val">
              {b.avail} <span style={{ fontSize: 14, color: 'var(--ink-3)', fontWeight: 600 }}>/ {b.quota + b.carry}</span>
            </div>
            <div className="foot">{b.used} used{b.carry ? ` · ${b.carry} carried forward` : ''}</div>
            <div className="bar" style={{ marginTop: 8 }}>
              <i style={{ width: pct(b.used, b.quota + b.carry) + '%', background: ltOf(b.t).color }} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid g-2-1">
        <Card title="My leave requests" sub={`${mine.length} total`} flush
          actions={<button className="btn sm" onClick={() => exportLeaves(mine, 'my_leave.csv')}>⤓ Export</button>}>
          <div className="tbl-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Reason</th><th>Status</th><th className="right">Action</th></tr>
              </thead>
              <tbody>
                {mine.length ? mine.map((l) => (
                  <tr key={l.id}>
                    <td><TypeDot type={l.type} />{ltOf(l.type).name}{l.half && <> <Badge>{l.half}</Badge></>}</td>
                    <td className="nowrap">{fmtD(l.from)}</td>
                    <td className="nowrap">{fmtD(l.to)}</td>
                    <td className="num">{l.days}</td>
                    <td>{l.reason}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td className="right">
                      {l.status === 'Pending'
                        ? <button className="btn sm" onClick={() => cancel(l)}>Cancel</button>
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                )) : <tr><td colSpan={7}><EmptyState msg="No leave requests yet" /></td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Upcoming leave" sub={`${upcoming.length} planned`} flush>
            {upcoming.length ? upcoming.map((l) => (
              <ListRow key={l.id}>
                <Dot color={ltOf(l.type).color} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{ltOf(l.type).name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{fmtD(l.from)}{l.days > 1 ? ' – ' + fmtD(l.to) : ''}</div>
                </div>
                <StatusBadge status={l.status} />
              </ListRow>
            )) : <EmptyState msg="Nothing planned" icon="🌴" />}
          </Card>

          <Card title="Balance breakdown" sub={ORG.fy}>
            <Donut size={150} center={sum(bank, (b) => b.avail).toFixed(0)} centerSub="days left"
              slices={bank.map((b) => ({ k: ltOf(b.t).name, v: b.avail, c: ltOf(b.t).color }))} />
            <Legend items={bank.map((b) => ({ k: ltOf(b.t).name, v: b.avail, c: ltOf(b.t).color }))} />
            {other.length > 0 && (
              <>
                <Divide />
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Statutory event leave (not part of the annual bank): {other.map((b) => `${ltOf(b.t).name} ${b.quota} d`).join(' · ')}
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Approvals ---------------- */

function LvAppr() {
  const app = useApp();
  const layer = useLayer();
  const ids = visibleIds(app.role, app.meId).filter((i) => i !== app.meId);
  const pend = sortBy(LEAVES.filter((l) => l.status === 'Pending' && ids.includes(l.empId)), (l) => l.from);

  const approve = (l: LeaveRequest) => {
    l.status = 'Approved';
    l.actedOn = ymd(TODAY);
    if (LEAVE_BAL[l.empId]?.[l.type]) LEAVE_BAL[l.empId][l.type].used += l.days;
    app.toast('Leave approved for ' + empName(l.empId), 'ok');
    app.bump();
  };

  const approveAll = () => {
    pend.forEach((l) => {
      l.status = 'Approved';
      l.actedOn = ymd(TODAY);
      if (LEAVE_BAL[l.empId]?.[l.type]) LEAVE_BAL[l.empId][l.type].used += l.days;
    });
    app.toast(pend.length + ' leave requests approved', 'ok');
    app.bump();
  };

  const reject = (l: LeaveRequest) =>
    layer.modal({
      title: 'Reject leave request',
      sub: empName(l.empId) + ' · ' + ltOf(l.type).name,
      size: 'narrow',
      body: (close) => <RejectForm l={l} close={close} />,
      footer: null,
    });

  function RejectForm({ l, close }: { l: LeaveRequest; close: () => void }) {
    const [note, setNote] = useState('Critical release week — please re-plan these dates.');
    return (
      <>
        <div className="field">
          <label>Reason (shared with the employee)</label>
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn danger" onClick={() => {
            l.status = 'Rejected';
            l.note = note;
            l.actedOn = ymd(TODAY);
            close();
            app.toast('Leave rejected', 'err');
            app.bump();
          }}>Reject request</button>
        </div>
      </>
    );
  }

  return (
    <div className="stack">
      <Card title="Leave requests awaiting approval" sub={`${pend.length} requests`} flush
        actions={pend.length ? <button className="btn sm primary" onClick={approveAll}>Approve all</button> : undefined}>
        {pend.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Type</th><th>Dates</th><th className="num">Days</th><th className="num">Balance</th><th>Reason</th><th>Applied</th><th className="right">Action</th></tr>
              </thead>
              <tbody>
                {pend.map((l) => {
                  const b = leaveBalance(l.empId, l.type);
                  /* flag when teammates are already away over the same dates */
                  const conflict = LEAVES.filter(
                    (x) => x.status === 'Approved' && x.empId !== l.empId && ids.includes(x.empId) && !(x.to < l.from || x.from > l.to),
                  ).length;
                  return (
                    <tr key={l.id}>
                      <td><PersonCell e={EMAP[l.empId]} /></td>
                      <td><TypeDot type={l.type} />{ltOf(l.type).name}</td>
                      <td className="nowrap">
                        {fmtD(l.from)}{l.days > 1 ? ' – ' + fmtD(l.to) : ''}{l.half && <> <Badge>{l.half}</Badge></>}
                      </td>
                      <td className="num">{l.days}</td>
                      <td className="num">
                        {b ? <Badge kind={b.avail >= l.days ? 'good' : 'crit'}>{b.avail}</Badge> : '—'}
                      </td>
                      <td>
                        {l.reason}
                        {conflict > 0 && <div className="muted" style={{ fontSize: 11 }}>⚠ {conflict} teammate(s) also away</div>}
                      </td>
                      <td className="nowrap">{fmtD(l.appliedOn)}</td>
                      <td className="right nowrap">
                        <button className="btn sm primary" onClick={() => approve(l)}>Approve</button>{' '}
                        <button className="btn sm" onClick={() => reject(l)}>Reject</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No leave requests waiting on you ✓" />}
      </Card>
    </div>
  );
}

/* ---------------- Team leave ---------------- */

function LvTeam() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const ids = visibleIds(app.role, app.meId);
  const list = sortBy(LEAVES.filter((l) => ids.includes(l.empId)), (l) => l.from, 'desc');
  const approved = LEAVES.filter((l) => ids.includes(l.empId) && l.status === 'Approved');

  const byType = LEAVE_TYPES.map((t) => ({
    k: t.name, c: t.color,
    v: sum(approved.filter((l) => l.type === t.id), (l) => l.days),
  })).filter((r) => r.v);

  /* unused earned leave, valued at current CTC — the accrued encashment liability */
  const liability = sum(ids.map((id) => {
    const b = leaveBalance(id, 'EL');
    return b ? b.avail * Math.round(EMAP[id].ctc / 365) : 0;
  }));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Leave days taken" value={sum(approved, (l) => l.days)} foot={`Across ${ids.length} employees`} />
        <Tile label="Pending requests" value={LEAVES.filter((l) => ids.includes(l.empId) && l.status === 'Pending').length}
          foot="Awaiting manager action" />
        <Tile label="Avg leave / employee" value={(sum(approved, (l) => l.days) / Math.max(1, ids.length)).toFixed(1) + ' d'}
          foot="Company average" />
        <Tile label="EL encashment liability" value={lakh(liability)} foot="Unused earned leave at current CTC" />
      </div>

      <div className="grid g-2-1">
        <Card title="All leave records" sub={`${list.length} requests`} flush
          actions={<button className="btn sm" onClick={() => exportLeaves(list, 'team_leave.csv')}>⤓ Export</button>}>
          <div className="tbl-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Type</th><th>Dates</th><th className="num">Days</th><th>Status</th><th>Approver</th></tr>
              </thead>
              <tbody>
                {list.slice(0, 300).map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => showEmp(l.empId)}>
                    <td><PersonCell e={EMAP[l.empId]} /></td>
                    <td className="nowrap"><TypeDot type={l.type} />{ltOf(l.type).name}</td>
                    <td className="nowrap">{fmtDS(l.from)}{l.days > 1 ? ' – ' + fmtDS(l.to) : ''}</td>
                    <td className="num">{l.days}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td className="nowrap">{empName(l.approverId || '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Leave by type" sub="Approved days">
          {byType.length ? <HBar rows={sortBy(byType, (r) => -r.v)} fmt={(v) => v + ' d'} /> : <EmptyState msg="No data" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Team calendar ---------------- */

function LvCal() {
  const app = useApp();
  const ids = visibleIds(app.role, app.meId);
  const start = mondayOf(TODAY);
  const days: Date[] = [];
  for (let i = 0; i < 28; i++) days.push(addDays(start, i));
  const people = ids.map((i) => EMAP[i]).slice(0, 40);

  return (
    <Card title="Team leave calendar"
      sub={`${fmtD(ymd(days[0]))} – ${fmtD(ymd(days[27]))} · ${people.length} people`} flush>
      <div className="tbl-wrap" style={{ maxHeight: 620, overflow: 'auto' }}>
        <table className="tbl" style={{ fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ minWidth: 170, position: 'sticky', left: 0, zIndex: 2, background: 'var(--surface-2)' }}>Employee</th>
              {days.map((d, i) => (
                <th key={i} style={{ textAlign: 'center', padding: '6px 2px', minWidth: 26 }}>
                  {d.getDate() === 1 || i === 0
                    ? <>{MON[d.getMonth()]}<br /></>
                    : <><span style={{ opacity: 0.55 }}>{DOW[d.getDay()][0]}</span><br /></>}
                  {d.getDate()}
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
                  const l = LEAVES.find((x) => x.empId === e.id && x.status === 'Approved' && x.from <= ds && x.to >= ds);
                  if (l) {
                    return (
                      <td key={i} style={{ background: ltOf(l.type).color, opacity: 0.85 }}
                        data-tip={`${e.name} · ${ltOf(l.type).name} · ${fmtD(l.from)}${l.days > 1 ? ' – ' + fmtD(l.to) : ''}`} />
                    );
                  }
                  if (HOLIDAY_MAP[ds]) return <td key={i} style={{ background: 'var(--surface-3)' }} data-tip={HOLIDAY_MAP[ds]} />;
                  if (isWeekend(d)) return <td key={i} style={{ background: 'var(--surface-3)', opacity: 0.6 }} />;
                  return <td key={i} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '12px 16px' }}>
        <Legend items={LEAVE_TYPES.slice(0, 5).map((t) => ({ k: t.name, c: t.color })).concat([{ k: 'Holiday / week off', c: 'var(--line-2)' }])} />
      </div>
    </Card>
  );
}

/* ---------------- Policy ---------------- */

const KEY_RULES: [string, string][] = [
  ['Notice period', 'Casual leave: 2 working days. Earned leave: 7 working days for 3+ days.'],
  ['Sick leave', 'Medical certificate required for 3 or more consecutive days.'],
  ['Half day', 'Available on Casual and Sick leave only.'],
  ['Sandwich rule', 'Week-offs and holidays between two leave days are not counted.'],
  ['Negative balance', 'Not permitted — excess days are treated as Loss of Pay.'],
  ['Probation', 'Employees on probation accrue leave but may only avail Sick and Casual leave.'],
  ['Encashment', 'Earned leave above 30 days is encashed with the March payroll at Basic + DA.'],
  ['Comp off', 'Must be availed within 60 days of the approved extra working day.'],
];

function LvPol() {
  return (
    <div className="grid g-2-1">
      <Card title="Leave policy" sub={ORG.name + ' · effective April 2026'} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Leave type</th><th className="num">Annual quota</th><th>Accrual</th><th>Carry forward</th><th>Encashment</th><th>Approval</th></tr>
            </thead>
            <tbody>
              {LEAVE_TYPES.map((t) => (
                <tr key={t.id}>
                  <td>
                    <TypeDot type={t.id} /><b>{t.name}</b>
                    {t.gender && <> <Badge>{t.gender === 'F' ? 'Female' : 'Male'}</Badge></>}
                  </td>
                  <td className="num">{t.quota || '—'}</td>
                  <td>{t.id === 'EL' ? 'Monthly 1.25 d' : t.id === 'CO' ? 'On approval' : t.quota ? 'Upfront, pro-rated' : 'As applicable'}</td>
                  <td>{t.carry ? `Yes, up to ${t.cap} d` : 'No — lapses 31 Mar'}</td>
                  <td>{t.encash ? 'Yes, at exit' : 'No'}</td>
                  <td>{t.id === 'ML' || t.id === 'LOP' ? 'Manager + HR' : 'Reporting manager'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Key rules" sub="Summary">
        <div className="stack" style={{ gap: 11, fontSize: 13 }}>
          {KEY_RULES.map(([k, v]) => (
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

type Tab = 'me' | 'appr' | 'team' | 'cal' | 'pol';

function Leave() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'me', label: 'My Leave' }, { v: 'cal', label: 'Team Calendar' }, { v: 'pol', label: 'Policy' }]
    : [
        { v: 'me', label: 'My Leave' }, { v: 'appr', label: 'Approvals' }, { v: 'team', label: 'Team Leave' },
        { v: 'cal', label: 'Team Calendar' }, { v: 'pol', label: 'Policy' },
      ];

  const [tab, setTab] = useState<Tab>('me');
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'me' && <LvMe />}
      {active === 'appr' && <LvAppr />}
      {active === 'team' && <LvTeam />}
      {active === 'cal' && <LvCal />}
      {active === 'pol' && <LvPol />}
    </>
  );
}

registerModule({
  key: 'leave',
  title: TITLES.leave,
  subtitle: () => 'Balances, requests and the company holiday calendar',
  Component: Leave,
});
