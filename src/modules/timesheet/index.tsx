import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, DOW, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { deptOf, PROJECTS, projOf, TASK_TYPES } from '../../data/org';
import type { Timesheet } from '../../services';
import { Badge, Card, EmptyState, PersonCell, Tabs, Tile, StatRow } from '../../components/ui';
import { Chip, Dot, StatusBadge } from '../../components/common';
import { BarChart, HBar, Legend, LineChart, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useApproveSheet, useMySheets, usePeople, useRejectSheet, useSheets, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { MyWeek } from './MyWeek';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const billableHours = (t: Timesheet) =>
  sum(t.rows.filter((r) => projOf(r.proj).billable), (r) => sum(r.h));

function exportTS(list: Timesheet[], name: string, dir: Directory) {
  const rows: (string | number)[][] = [
    ['Emp Code', 'Name', 'Week Start', 'Project', 'Client', 'Task', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Total', 'Billable', 'Status'],
  ];
  list.forEach((t) =>
    t.rows.forEach((r) => {
      const e = dir.byId(t.empId);
      const p = projOf(r.proj);
      rows.push([e?.code ?? t.empId, e?.name ?? '—', t.weekStart, p.name, p.client, r.task, ...r.h, sum(r.h), p.billable ? 'Yes' : 'No', t.status]);
    }),
  );
  downloadCSV(name, rows);
}

/* ---------------- read-only timesheet modal ---------------- */

function useShowTS(dir: Directory) {
  const layer = useLayer();
  const app = useApp();
  const approve = useApproveSheet();
  return (t: Timesheet) => {
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(parseYmd(t.weekStart), i));
    layer.modal({
      title: dir.name(t.empId) + ' — timesheet',
      sub: `${fmtD(t.weekStart)} – ${fmtD(ymd(days[6]))} · ${t.total} h`,
      size: 'wide',
      body: (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Project</th><th>Task</th>
                {days.map((d, i) => <th key={i} className="num">{DOW[d.getDay()]}</th>)}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <Dot color={projOf(r.proj).color} /> {projOf(r.proj).name}
                    {projOf(r.proj).billable && <> <Badge kind="good">Billable</Badge></>}
                  </td>
                  <td>{r.task}</td>
                  {r.h.map((h, j) => <td key={j} className="num">{h || '—'}</td>)}
                  <td className="num strong">{sum(r.h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Close</button>
          {t.status === 'Submitted' && app.role !== 'employee' && (
            <button className="btn primary" onClick={async () => {
              await approve.mutate(t.id, app.meId);
              close();
              app.toast('Timesheet approved', 'ok');
            }}>Approve</button>
          )}
        </>
      ),
    });
  };
}

/* ---------------- week navigation ---------------- */

function WeekNav({ ws, setWs, children }: { ws: string; setWs: (s: string) => void; children?: React.ReactNode }) {
  const shift = (n: number) => setWs(ymd(addDays(parseYmd(ws), n * 7)));
  return (
    <div className="toolbar">
      <button className="btn icon" onClick={() => shift(-1)}>‹</button>
      <div style={{ fontWeight: 700, fontSize: 14, minWidth: 210, textAlign: 'center' }}>
        {fmtD(ws)} – {fmtD(ymd(addDays(parseYmd(ws), 6)))}
      </div>
      <button className="btn icon" onClick={() => shift(1)}>›</button>
      <button className="btn sm" onClick={() => setWs(ymd(mondayOf(TODAY)))}>This week</button>
      <div className="spacer" />
      {children}
    </div>
  );
}
function TsHist({ setWs, setTab }: { setWs: (s: string) => void; setTab: (t: 'my') => void }) {
  const app = useApp();
  const { data: mine = [] } = useMySheets(app.meId);
  const approvers = usePeople(mine.map((t) => t.approverId));
  const list = sortBy(mine, (t) => t.weekStart, 'desc');

  return (
    <Card title="Timesheet history" sub={`${list.length} weeks`} flush
      actions={<button className="btn sm" onClick={() => exportTS(list, 'my_timesheets.csv', approvers)}>⤓ Export</button>}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr><th>Week</th><th>Projects</th><th className="num">Hours</th><th className="num">Billable</th><th>Status</th><th>Submitted</th><th>Approver</th></tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className="clickable" onClick={() => { setWs(t.weekStart); setTab('my'); }}>
                <td className="nowrap">{fmtD(t.weekStart)} – {fmtDS(ymd(addDays(parseYmd(t.weekStart), 6)))}</td>
                <td>{t.rows.map((r, i) => <Chip key={i}>{projOf(r.proj).name}</Chip>)}</td>
                <td className="num strong">{t.total}</td>
                <td className="num">{billableHours(t)}</td>
                <td><StatusBadge status={t.status} /></td>
                <td className="nowrap">{t.submittedOn ? fmtD(t.submittedOn) : '—'}</td>
                <td>{approvers.name(t.approverId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ---------------- Team ---------------- */

function TsTeam({ ws, setWs }: { ws: string; setWs: (s: string) => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const showTS = useShowTS(dir);
  const ids = dir.ids.filter((i) => i !== app.meId);
  const { data: weekSheets = [] } = useSheets(ids, { weekStart: ws });
  const byEmp = new Map(weekSheets.map((t) => [t.empId, t]));
  const rows = ids.map((id) => ({ e: dir.byId(id)!, t: byEmp.get(id)! })).filter((r) => r.e && r.t);
  const missing = ids.filter((id) => !byEmp.get(id) || byEmp.get(id)!.total === 0);

  const totalH = sum(rows, (r) => r.t.total);
  const billH = sum(rows, (r) => billableHours(r.t));

  const approveSheet = useApproveSheet();
  const approve = async (t: Timesheet) => {
    await approveSheet.mutate(t.id, app.meId);
    app.toast('Approved ' + dir.name(t.empId) + "'s timesheet", 'ok');
  };

  return (
    <div className="stack">
      <WeekNav ws={ws} setWs={setWs}>
        <button className="btn" onClick={() => exportTS(weekSheets, `team_timesheet_${ws}.csv`, dir)}>
          ⤓ Export
        </button>
      </WeekNav>

      <StatRow cols={4}>
        <Tile label="Submitted" value={`${rows.filter((r) => r.t.status !== 'Draft' && r.t.status !== 'Missing').length} / ${ids.length}`}
          foot={`${missing.length} not started`} />
        <Tile label="Total hours" value={totalH + ' h'} foot={`Expected ${ids.length * 40} h`} />
        <Tile label="Billable" value={billH + ' h'} foot={pct(billH, Math.max(1, totalH)) + '% billable'} />
        <Tile label="Awaiting approval" value={rows.filter((r) => r.t.status === 'Submitted').length} foot="Review in the approvals tab" />
      </StatRow>

      <Card title="Team timesheets" sub={`${fmtD(ws)} week`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Employee</th><th>Department</th><th className="num">Hours</th><th className="num">Billable</th><th>Projects</th><th>Status</th><th className="right">Action</th></tr>
            </thead>
            <tbody>
              {sortBy(rows, (r) => -r.t.total).map((r) => (
                <tr key={r.t.id}>
                  <td><PersonCell e={r.e} /></td>
                  <td className="nowrap">{deptOf(r.e.dept).name}</td>
                  <td className="num strong">{r.t.total}</td>
                  <td className="num">{billableHours(r.t)}</td>
                  <td>
                    {r.t.rows.map((x, i) => (
                      <span key={i} className="dot" style={{ display: 'inline-block', background: projOf(x.proj).color, marginRight: 3 }} title={projOf(x.proj).name} />
                    ))}{' '}
                    <span className="muted">{r.t.rows.length}</span>
                  </td>
                  <td><StatusBadge status={r.t.status} /></td>
                  <td className="right nowrap">
                    <button className="btn sm" onClick={() => showTS(r.t)}>View</button>
                    {r.t.status === 'Submitted' && <> <button className="btn sm primary" onClick={() => approve(r.t)}>Approve</button></>}
                  </td>
                </tr>
              ))}
              {missing.map((id) => (
                <tr key={id}>
                  <td>{dir.byId(id) && <PersonCell e={dir.byId(id)!} />}</td>
                  <td>{deptOf(dir.byId(id)?.dept ?? '').name}</td>
                  <td className="num">0</td>
                  <td className="num">0</td>
                  <td>—</td>
                  <td><StatusBadge status="Missing" /></td>
                  <td className="right">
                    <button className="btn sm" onClick={() => app.toast('Reminder sent to ' + dir.name(id), 'ok')}>Remind</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Approvals ---------------- */

/**
 * At module scope so the textarea keeps its DOM node between renders — an
 * inline component would remount and drop focus on every keystroke.
 */
function ReturnForm({ t, close }: { t: Timesheet; close: () => void }) {
  const app = useApp();
  const rejectSheet = useRejectSheet();
  const [note, setNote] = useState('Please split the hours by task type and resubmit.');
  return (
    <>
      <div className="field">
        <label>Reason for returning</label>
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button
          className="btn danger"
          disabled={rejectSheet.pending}
          onClick={async () => {
            await rejectSheet.mutate(t.id, app.meId, note);
            close();
            app.toast('Timesheet returned', 'err');
          }}
        >
          Return to employee
        </button>
      </div>
    </>
  );
}

function TsApprovals() {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const showTS = useShowTS(dir);
  const ids = dir.ids.filter((i) => i !== app.meId);
  const { data: pend = [] } = useSheets(ids, { status: 'Submitted' });
  const approveSheet = useApproveSheet();

  const approve = async (t: Timesheet) => {
    await approveSheet.mutate(t.id, app.meId);
    app.toast('Approved ' + dir.name(t.empId) + "'s timesheet", 'ok');
  };

  const returnTs = (t: Timesheet) =>
    layer.modal({
      title: 'Return timesheet',
      sub: dir.name(t.empId) + ' · week of ' + fmtD(t.weekStart),
      size: 'narrow',
      body: (close) => <ReturnForm t={t} close={close} />,
      footer: null,
    });

  return (
    <div className="stack">
      <Card title="Timesheets awaiting approval" sub={`${pend.length} submissions`} flush
        actions={pend.length ? (
          <button className="btn primary sm" onClick={async () => {
            const n = pend.length;
            for (const x of pend) await approveSheet.mutate(x.id, app.meId);
            app.toast(n + ' timesheets approved', 'ok');
          }}>Approve all</button>
        ) : undefined}>
        {pend.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Week</th><th className="num">Hours</th><th className="num">Billable</th><th>Submitted</th><th className="right">Action</th></tr>
              </thead>
              <tbody>
                {sortBy(pend, (t) => t.weekStart, 'desc').map((t) => (
                  <tr key={t.id}>
                    <td>{dir.byId(t.empId) && <PersonCell e={dir.byId(t.empId)!} />}</td>
                    <td className="nowrap">{fmtD(t.weekStart)}</td>
                    <td className="num strong">{t.total}</td>
                    <td className="num">{billableHours(t)}</td>
                    <td className="nowrap">{fmtD(t.submittedOn)}</td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => showTS(t)}>Review</button>{' '}
                      <button className="btn sm primary" onClick={() => approve(t)}>Approve</button>{' '}
                      <button className="btn sm" onClick={() => returnTs(t)}>Return</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No timesheets waiting on you ✓" />}
      </Card>
    </div>
  );
}

/* ---------------- Utilisation ---------------- */

function TsUtil() {
  const dir = useVisiblePeople();
  const weeks: string[] = [];
  for (let w = 7; w >= 0; w--) weeks.push(ymd(mondayOf(addDays(TODAY, -w * 7))));

  const { data: recent = [] } = useSheets(dir.ids, { since: weeks[0] });
  const sheetsIn = (ws: string) => recent.filter((t) => t.weekStart === ws);

  const series = PROJECTS.map((p) => ({
    name: p.name, color: p.color,
    data: weeks.map((ws) => sum(sheetsIn(ws), (t) => sum(t.rows.filter((r) => r.proj === p.id), (r) => sum(r.h)))),
  })).filter((s) => sum(s.data) > 0);

  const totals = weeks.map((ws) => sum(sheetsIn(ws), (t) => t.total));
  const billable = weeks.map((ws) => sum(sheetsIn(ws), billableHours));

  const byTask = TASK_TYPES.map((tt, i) => ({
    k: tt, c: PAL[i % 8],
    v: sum(
      recent.filter((t) => t.weekStart >= weeks[4]),
      (t) => sum(t.rows.filter((r) => r.task === tt), (r) => sum(r.h)),
    ),
  })).filter((r) => r.v > 0);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Hours logged (8 wks)" value={sum(totals).toLocaleString('en-IN') + ' h'} foot={`Across ${dir.ids.length} employees`} />
        <Tile label="Billable ratio" value={pct(sum(billable), Math.max(1, sum(totals))) + '%'} foot="Target 75%" />
        <Tile label="Avg per person / week" value={(sum(totals) / Math.max(1, dir.ids.length) / 8).toFixed(1) + ' h'} foot="Standard week 40 h" />
        <Tile label="Active projects" value={series.length} foot={`${PROJECTS.filter((p) => p.billable).length} billable in catalogue`} />
      </StatRow>

      <Card title="Effort by project" sub="Hours per week · last 8 weeks">
        <BarChart labels={weeks.map((w) => fmtDS(w))} height={250} stacked series={series} fmt={(v) => v + ' h'} />
        <Legend items={series.map((s) => ({ k: s.name, c: s.color }))} />
      </Card>

      <div className="grid g2">
        <Card title="Billable vs non-billable" sub="Weekly trend">
          <LineChart labels={weeks.map((w) => fmtDS(w))} height={210} area fmt={(v) => v + ' h'}
            series={[
              { name: 'Total', color: 'var(--s1)', data: totals },
              { name: 'Billable', color: 'var(--s3)', data: billable },
            ]} />
          <Legend items={[{ k: 'Total hours', c: 'var(--s1)' }, { k: 'Billable hours', c: 'var(--s3)' }]} />
        </Card>
        <Card title="Effort by task type" sub="Last 4 weeks">
          {byTask.length ? <HBar rows={sortBy(byTask, (r) => -r.v)} fmt={(v) => v + ' h'} /> : <EmptyState msg="No data" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'my' | 'hist' | 'team' | 'appr' | 'util';

function TimesheetView() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'my', label: 'My Timesheet' }, { v: 'hist', label: 'History' }]
    : [
        { v: 'my', label: 'My Timesheet' }, { v: 'team', label: 'Team Timesheets' },
        { v: 'appr', label: 'Pending Approval' }, { v: 'util', label: 'Utilisation' },
      ];

  const [tab, setTab] = useState<Tab>('my');
  const [ws, setWs] = useState(ymd(mondayOf(TODAY)));
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'my' && <MyWeek ws={ws} setWs={setWs} />}
      {active === 'hist' && <TsHist setWs={setWs} setTab={setTab} />}
      {active === 'team' && <TsTeam ws={ws} setWs={setWs} />}
      {active === 'appr' && <TsApprovals />}
      {active === 'util' && <TsUtil />}
    </>
  );
}

registerModule({
  key: 'timesheet',
  title: TITLES.timesheet,
  Component: TimesheetView,
});
