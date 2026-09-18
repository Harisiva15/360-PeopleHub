/**
 * Timesheets — entry, history, approval, reporting.
 *
 * Four tabs, and which of them a person gets follows the policy rather than
 * their job title: everybody writes and reads their own week, approvers get
 * the queue their line feeds, and the reports read whatever the employee
 * service already scoped for the caller. Nothing here decides who may see
 * what — it only stops offering screens the server would refuse.
 */

import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { deptOf, PROJECTS, projOf, TASK_TYPES } from '../../data/org';
import type { Timesheet } from '../../services';
import { Badge, Card, EmptyState, PersonCell, StatRow, Tabs, Tile } from '../../components/ui';
import { Chip, Dot, StatusBadge } from '../../components/common';
import { BarChart, HBar, Legend, LineChart, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useDecideSheet, useMySheets, usePeople, useSheets, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { MyWeek, overtimeOf } from './MyWeek';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const hrs = (n: number) => n.toFixed(2);
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** One row per entry — a week flattened, which is how the storage holds it. */
function exportTS(list: Timesheet[], name: string, dir: Directory) {
  const rows: (string | number)[][] = [[
    'Emp Code', 'Name', 'Week Start', 'Date', 'Project', 'Client', 'Task',
    'Billable', 'Hours', 'Remarks', 'Status',
  ]];
  list.forEach((t) => {
    const e = dir.byId(t.empId);
    t.entries.forEach((x) => {
      const p = projOf(x.proj);
      rows.push([
        e?.code ?? t.empId, e?.name ?? '—', t.weekStart, x.date,
        p.name, p.client, x.task, x.billable ? 'Yes' : 'No', x.hours, x.remarks, t.status,
      ]);
    });
  });
  downloadCSV(name, rows);
}

/* ---------------- read-only sheet, with the decision on it ---------------- */

/**
 * At module scope so the textarea keeps its DOM node between renders — an
 * inline component remounts on every keystroke and drops focus.
 */
function DecideForm({
  t, kind, who, close,
}: {
  t: Timesheet;
  kind: 'Returned' | 'Rejected';
  who: string;
  close: () => void;
}) {
  const app = useApp();
  const decide = useDecideSheet();
  const [note, setNote] = useState(kind === 'Returned'
    ? 'Please split the hours by task type and resubmit.'
    : '');
  const [err, setErr] = useState('');

  const act = async () => {
    try {
      await decide.mutate(t.id, kind, note);
      close();
      app.toast(kind === 'Returned' ? `Returned to ${who}` : `Rejected ${who}'s week`, 'err');
    } catch (e) {
      setErr(msg(e, 'Could not record that decision'));
    }
  };

  return (
    <>
      <div className="field">
        <label>{kind === 'Returned' ? 'What needs fixing' : 'Why this is refused'}</label>
        <textarea className="input" rows={4} value={note} autoFocus
          onChange={(e) => setNote(e.target.value)} />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
          {who} sees this, so say what they should do next.
        </div>
      </div>
      {err && <div className="ts-err-box">⚠ {err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn danger" disabled={decide.pending || !note.trim()} onClick={act}>
          {kind === 'Returned' ? 'Return to employee' : 'Reject this week'}
        </button>
      </div>
    </>
  );
}

function useReviewTS(dir: Directory) {
  const layer = useLayer();
  const app = useApp();
  const decide = useDecideSheet();

  const ask = (t: Timesheet, kind: 'Returned' | 'Rejected') => layer.modal({
    title: kind === 'Returned' ? 'Return timesheet' : 'Reject timesheet',
    sub: `${dir.name(t.empId)} · week of ${fmtD(t.weekStart)}`,
    size: 'narrow',
    body: (close) => <DecideForm t={t} kind={kind} who={dir.name(t.empId)} close={close} />,
    footer: null,
  });

  return (t: Timesheet) => {
    const mine = t.empId === app.meId;
    layer.modal({
      title: `${dir.name(t.empId)} — timesheet`,
      sub: `${fmtD(t.weekStart)} – ${fmtD(ymd(addDays(parseYmd(t.weekStart), 6)))} · ${hrs(t.total)} h`,
      size: 'wide',
      body: (
        <div className="stack">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Project</th><th>Task</th>
                  <th>Billable</th><th className="num">Hours</th><th>Remarks</th>
                </tr>
              </thead>
              <tbody>
                {t.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{fmtDS(e.date)}</td>
                    <td>
                      <Dot color={projOf(e.proj).color} /> {projOf(e.proj).name}
                      <div className="muted" style={{ fontSize: 11 }}>{projOf(e.proj).client}</div>
                    </td>
                    <td>{e.task}</td>
                    <td>{e.billable ? <Badge kind="good">Billable</Badge> : <span className="muted">—</span>}</td>
                    <td className="num strong">{hrs(e.hours)}</td>
                    <td className="muted" style={{ maxWidth: 200 }}>{e.remarks || '—'}</td>
                  </tr>
                ))}
                {!t.entries.length && (
                  <tr><td colSpan={6}><EmptyState msg="No hours were logged this week" /></td></tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={4} className="right">Total</th>
                  <th className="num">{hrs(t.total)}</th>
                  <th />
                </tr>
              </tfoot>
            </table>
          </div>
          {t.note && (
            <div className="ts-note">
              <b>Comment</b>
              <div>{t.note}</div>
            </div>
          )}
        </div>
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Close</button>
          {t.status === 'Submitted' && !mine && (
            <>
              <button className="btn" onClick={() => { close(); ask(t, 'Rejected'); }}>Reject</button>
              <button className="btn" onClick={() => { close(); ask(t, 'Returned'); }}>Return</button>
              <button className="btn primary" disabled={decide.pending} onClick={async () => {
                try {
                  await decide.mutate(t.id, 'Approved');
                  close();
                  app.toast(`Approved ${dir.name(t.empId)}'s timesheet`, 'ok');
                } catch (e) {
                  app.toast(msg(e, 'Could not approve it'), 'err');
                }
              }}>Approve</button>
            </>
          )}
        </>
      ),
    });
  };
}

/* ---------------- My Timesheets ---------------- */

function TsHist({ setWs, setTab }: { setWs: (s: string) => void; setTab: (t: 'entry') => void }) {
  const app = useApp();
  const { data: mine = [], loading } = useMySheets(app.meId);
  const approvers = usePeople(mine.map((t) => t.approverId));
  const [status, setStatus] = useState('');

  const list = sortBy(mine, (t) => t.weekStart, 'desc')
    .filter((t) => !status || t.status === status);

  const open = (t: Timesheet) => { setWs(t.weekStart); setTab('entry'); };

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Weeks recorded" value={mine.length} foot="Everything you have logged" />
        <Tile label="Hours logged" value={hrs(sum(mine, (t) => t.total))} foot="Across every week" />
        <Tile label="Billable" value={hrs(sum(mine, (t) => t.billable))}
          foot={pct(sum(mine, (t) => t.billable), Math.max(1, sum(mine, (t) => t.total))) + '% of the total'} />
        <Tile label="Awaiting approval" value={mine.filter((t) => t.status === 'Submitted').length}
          foot="Sitting with your manager" />
      </StatRow>

      <Card title="My timesheets" sub={`${list.length} weeks`} flush
        actions={(
          <div className="row" style={{ gap: 8 }}>
            <select className="input sm" value={status} aria-label="Filter by status"
              onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {['Draft', 'Submitted', 'Approved', 'Returned', 'Rejected'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button className="btn sm" disabled={!list.length}
              onClick={() => exportTS(list, 'my_timesheets.csv', approvers)}>⤓ Export</button>
          </div>
        )}>
        {list.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Week</th><th>Projects</th><th className="num">Hours</th>
                  <th className="num">Billable</th><th className="num">Overtime</th>
                  <th>Status</th><th>Submitted</th><th>Approver</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => {
                  const projs = Array.from(new Set(t.entries.map((e) => e.proj)));
                  return (
                    <tr key={t.id} className="clickable" onClick={() => open(t)}>
                      <td className="nowrap">
                        {fmtD(t.weekStart)} – {fmtDS(ymd(addDays(parseYmd(t.weekStart), 6)))}
                      </td>
                      <td>
                        {projs.slice(0, 3).map((p) => <Chip key={p}>{projOf(p).name}</Chip>)}
                        {projs.length > 3 && <Chip>+{projs.length - 3}</Chip>}
                        {!projs.length && <span className="muted">—</span>}
                      </td>
                      <td className="num strong">{hrs(t.total)}</td>
                      <td className="num">{hrs(t.billable)}</td>
                      <td className="num">{hrs(overtimeOf(t.total))}</td>
                      <td><StatusBadge status={t.status} /></td>
                      <td className="nowrap">{t.submittedOn ? fmtD(t.submittedOn) : '—'}</td>
                      <td>{approvers.name(t.approverId)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="🗓"
            msg={loading ? 'Loading your weeks…' : 'No weeks match that filter'} />
        )}
      </Card>
    </div>
  );
}

/* ---------------- Approvals ---------------- */

function TsApprovals({ ws, setWs }: { ws: string; setWs: (s: string) => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const review = useReviewTS(dir);
  const decide = useDecideSheet();

  const ids = dir.ids.filter((i) => i !== app.meId);
  const { data: pend = [] } = useSheets(ids, { status: 'Submitted' });
  const { data: weekSheets = [] } = useSheets(ids, { weekStart: ws });

  const byEmp = new Map(weekSheets.map((t) => [t.empId, t]));
  const rows = ids.map((id) => ({ e: dir.byId(id)!, t: byEmp.get(id) })).filter((r) => r.e);
  const missing = rows.filter((r) => !r.t || r.t.total === 0);

  const totalH = sum(rows, (r) => r.t?.total ?? 0);
  const billH = sum(rows, (r) => r.t?.billable ?? 0);

  const approveAll = async () => {
    const failed: string[] = [];
    for (const t of pend) {
      try {
        await decide.mutate(t.id, 'Approved');
      } catch (e) {
        failed.push(`${dir.name(t.empId)}: ${msg(e, 'refused')}`);
      }
    }
    if (failed.length) app.toast(failed.join(' · '), 'err');
    else app.toast(`${pend.length} timesheets approved`, 'ok');
  };

  return (
    <div className="stack">
      <Card title="Awaiting your approval" sub={`${pend.length} submissions`} flush
        actions={pend.length
          ? <button className="btn primary sm" disabled={decide.pending}
            onClick={approveAll}>Approve all</button>
          : undefined}>
        {pend.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Employee</th><th>Week</th><th className="num">Hours</th>
                  <th className="num">Billable</th><th>Submitted</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortBy(pend, (t) => t.weekStart, 'desc').map((t) => (
                  <tr key={t.id}>
                    <td>{dir.byId(t.empId) && <PersonCell e={dir.byId(t.empId)!} />}</td>
                    <td className="nowrap">{fmtD(t.weekStart)}</td>
                    <td className="num strong">{hrs(t.total)}</td>
                    <td className="num">{hrs(t.billable)}</td>
                    <td className="nowrap">{t.submittedOn ? fmtD(t.submittedOn) : '—'}</td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => review(t)}>Review</button>{' '}
                      <button className="btn sm primary" disabled={decide.pending}
                        onClick={async () => {
                          try {
                            await decide.mutate(t.id, 'Approved');
                            app.toast(`Approved ${dir.name(t.empId)}'s timesheet`, 'ok');
                          } catch (e) {
                            app.toast(msg(e, 'Could not approve it'), 'err');
                          }
                        }}>Approve</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No timesheets waiting on you ✓" />}
      </Card>

      <div className="toolbar" style={{ marginTop: 4 }}>
        <button className="btn icon" title="Previous week" aria-label="Previous week"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), -7)))}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 14, minWidth: 210, textAlign: 'center' }}>
          {fmtD(ws)} – {fmtD(ymd(addDays(parseYmd(ws), 6)))}
        </div>
        <button className="btn icon" title="Next week" aria-label="Next week"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), 7)))}>›</button>
        <button className="btn sm" onClick={() => setWs(ymd(mondayOf(TODAY)))}>This week</button>
        <div className="spacer" />
        <button className="btn sm" disabled={!weekSheets.length}
          onClick={() => exportTS(weekSheets, `team_timesheet_${ws}.csv`, dir)}>⤓ Export</button>
      </div>

      <StatRow cols={4}>
        <Tile label="Sheets in"
          value={`${rows.filter((r) => r.t && r.t.status !== 'Draft').length} / ${ids.length}`}
          foot={`${missing.length} nothing logged`} />
        <Tile label="Team hours" value={hrs(totalH)} foot={`Expected ${ids.length * 40} h`} />
        <Tile label="Billable" value={hrs(billH)}
          foot={pct(billH, Math.max(1, totalH)) + '% of the total'} />
        <Tile label="Still open"
          value={rows.filter((r) => r.t?.status === 'Submitted').length}
          foot="Submitted, not yet decided" />
      </StatRow>

      <Card title="The team's week" sub={`Week of ${fmtD(ws)}`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th className="num">Hours</th>
                <th className="num">Billable</th><th>Projects</th><th>Status</th>
                <th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(rows, (r) => -(r.t?.total ?? 0)).map((r) => {
                const projs = r.t ? Array.from(new Set(r.t.entries.map((e) => e.proj))) : [];
                return (
                  <tr key={r.e.id}>
                    <td><PersonCell e={r.e} /></td>
                    <td className="nowrap">{deptOf(r.e.dept).name}</td>
                    <td className="num strong">{hrs(r.t?.total ?? 0)}</td>
                    <td className="num">{hrs(r.t?.billable ?? 0)}</td>
                    <td>
                      {projs.map((p) => (
                        <span key={p} className="dot"
                          style={{ display: 'inline-block', background: projOf(p).color, marginRight: 3 }}
                          title={projOf(p).name} />
                      ))}{' '}
                      <span className="muted">{projs.length || '—'}</span>
                    </td>
                    <td><StatusBadge status={r.t?.status ?? 'Missing'} /></td>
                    <td className="right nowrap">
                      {r.t
                        ? <button className="btn sm" onClick={() => review(r.t!)}>View</button>
                        : <button className="btn sm"
                          onClick={() => app.toast('Reminder sent to ' + r.e.name, 'ok')}>Remind</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Reports ---------------- */

function TsReports() {
  const dir = useVisiblePeople();
  const weeks: string[] = [];
  for (let w = 7; w >= 0; w--) weeks.push(ymd(mondayOf(addDays(TODAY, -w * 7))));

  const { data: recent = [] } = useSheets(dir.ids, { since: weeks[0] });
  const sheetsIn = (ws: string) => recent.filter((t) => t.weekStart === ws);

  const series = PROJECTS.map((p) => ({
    name: p.name,
    color: p.color,
    data: weeks.map((ws) => sum(
      sheetsIn(ws),
      (t) => sum(t.entries.filter((e) => e.proj === p.id), (e) => e.hours),
    )),
  })).filter((s) => sum(s.data) > 0);

  const totals = weeks.map((ws) => sum(sheetsIn(ws), (t) => t.total));
  const billable = weeks.map((ws) => sum(sheetsIn(ws), (t) => t.billable));

  /* Task types the catalogue names, plus whatever people actually typed. */
  const taskNames = Array.from(new Set([
    ...TASK_TYPES,
    ...recent.flatMap((t) => t.entries.map((e) => e.task)),
  ]));
  const lastFour = recent.filter((t) => t.weekStart >= weeks[4]);
  const byTask = taskNames.map((tt, i) => ({
    k: tt,
    c: PAL[i % PAL.length],
    v: sum(lastFour, (t) => sum(t.entries.filter((e) => e.task === tt), (e) => e.hours)),
  })).filter((r) => r.v > 0);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Hours logged (8 wks)" value={hrs(sum(totals))}
          foot={`Across ${dir.ids.length} ${dir.ids.length === 1 ? 'person' : 'people'}`} />
        <Tile label="Billable ratio" value={pct(sum(billable), Math.max(1, sum(totals))) + '%'}
          foot="Target 75%" />
        <Tile label="Avg per person / week"
          value={hrs(sum(totals) / Math.max(1, dir.ids.length) / 8)} foot="Standard week 40 h" />
        <Tile label="Active projects" value={series.length}
          foot={`${PROJECTS.filter((p) => p.billable).length} billable in the catalogue`} />
      </StatRow>

      <Card title="Effort by project" sub="Hours per week · last 8 weeks">
        {series.length ? (
          <>
            <BarChart labels={weeks.map((w) => fmtDS(w))} height={250} stacked series={series}
              fmt={(v) => v + ' h'} />
            <Legend items={series.map((s) => ({ k: s.name, c: s.color }))} />
          </>
        ) : <EmptyState msg="Nothing logged in the last eight weeks" />}
      </Card>

      <div className="grid g2">
        <Card title="Billable vs non-billable" sub="Weekly trend">
          <LineChart labels={weeks.map((w) => fmtDS(w))} height={210} area fmt={(v) => v + ' h'}
            series={[
              { name: 'Total', color: 'var(--brand)', data: totals },
              { name: 'Billable', color: 'var(--good)', data: billable },
            ]} />
          <Legend items={[
            { k: 'Total hours', c: 'var(--brand)' },
            { k: 'Billable hours', c: 'var(--good)' },
          ]} />
        </Card>
        <Card title="Effort by task type" sub="Last 4 weeks">
          {byTask.length
            ? <HBar rows={sortBy(byTask, (r) => -r.v).slice(0, 12)} fmt={(v) => v + ' h'} />
            : <EmptyState msg="No data" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'entry' | 'mine' | 'appr' | 'rep';

function TimesheetView() {
  const app = useApp();

  /*
   * An employee approves nothing — not even their own week — so the queue is
   * not offered to them. Everything else they get, scoped to themselves by the
   * employee service rather than by this list.
   */
  const tabs: { v: Tab; label: string }[] = [
    { v: 'entry', label: 'Timesheet Entry' },
    { v: 'mine', label: 'My Timesheets' },
    ...(app.role === 'employee' ? [] : [{ v: 'appr' as Tab, label: 'Approvals' }]),
    { v: 'rep', label: 'Reports' },
  ];

  const [tab, setTab] = useTabFromUrl<Tab>('entry', ['entry', 'mine', 'appr', 'rep']);
  const [ws, setWs] = useState(ymd(mondayOf(TODAY)));
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'entry' && <MyWeek ws={ws} setWs={setWs} />}
      {active === 'mine' && <TsHist setWs={setWs} setTab={setTab} />}
      {active === 'appr' && <TsApprovals ws={ws} setWs={setWs} />}
      {active === 'rep' && <TsReports />}
    </>
  );
}

registerModule({
  key: 'timesheet',
  title: TITLES.timesheet,
  Component: TimesheetView,
});
