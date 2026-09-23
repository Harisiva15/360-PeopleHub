/**
 * The timesheet views that are not the week editor.
 *
 * Team Timesheets, Time Entries, Projects and Calendar. All four read the same
 * service the editor writes through, and none of them holds a list of its own —
 * a screen that keeps its own copy of the week is a screen that will eventually
 * disagree with the approver's.
 *
 * **Scope is the server's.** `list()` filters by the caller: an employee sees
 * their own rows, a manager their own plus their reporting tree, an admin
 * everything. These screens pass the ids they want to *show* and get back what
 * the caller is allowed to *see*, which is deliberately not the same question.
 * Nothing here decides who may read what.
 *
 * **Only figures the service returns.** A sheet carries `total`, `billable` and
 * `nonBillable`. There is no regular-versus-overtime split and no leave hours
 * in the timesheet model, so those are not shown — an empty card is better than
 * a computed one nobody can reconcile against a payslip.
 */

import { useMemo, useState } from 'react';
import { addDays, fmtD, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { Badge, Card, EmptyState, StatRow, Table, TableWrap, Tile } from '../../components/ui';
import { PersonCell } from '../../components/ui';
import { StatusBadge } from '../../components/common';
import { Icon } from '../../components/icons';
import { useApp } from '../../state/AppContext';
import type { Timesheet, TSStatus } from '../../services';
import { useBookableProjects, useSheets, useVisiblePeople } from './data';
import type { Directory } from './data';

const hrs = (n: number) => n.toFixed(2);

/** Mondays back from this one, newest first. */
function recentWeeks(n: number): string[] {
  const start = mondayOf(TODAY);
  return Array.from({ length: n }, (_, i) => ymd(addDays(start, -7 * i)));
}

const weekLabel = (ws: string) => `${fmtD(ws)} – ${fmtD(ymd(addDays(parseYmd(ws), 6)))}`;

/** How far back the team views look. Twelve weeks is a quarter. */
const WINDOW = 12;

/* ------------------------------------------------------------------ *
 * Team timesheets
 * ------------------------------------------------------------------ */

/**
 * Everybody the caller may see, by week.
 *
 * The employee ids come from the directory, which is itself scoped, and the
 * service scopes again on the way out. An employee never reaches this view —
 * the tab is not offered — but if they did, the list would come back holding
 * only their own rows.
 */
export function TeamTimesheets({ onOpen }: { onOpen: (empId: string, ws: string) => void }) {
  const dir = useVisiblePeople();
  const since = ymd(addDays(mondayOf(TODAY), -7 * (WINDOW - 1)));
  const { data: sheets = [], loading } = useSheets(dir.ids, { since });
  const [status, setStatus] = useState<'' | TSStatus>('');
  const [who, setWho] = useState('');

  const shown = sheets.filter((s) =>
    (!status || s.status === status) && (!who || s.empId === who));

  const totals = {
    hours: shown.reduce((n, s) => n + s.total, 0),
    billable: shown.reduce((n, s) => n + s.billable, 0),
    waiting: shown.filter((s) => s.status === 'Submitted').length,
  };

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Weeks in view" value={shown.length} foot={`Last ${WINDOW} weeks`} />
        <Tile label="Hours logged" value={hrs(totals.hours)} foot="Across everyone shown" />
        <Tile label="Billable hours" value={hrs(totals.billable)}
          foot={totals.hours ? `${Math.round((totals.billable / totals.hours) * 100)}% of logged` : '—'} />
        <Tile label="Awaiting a decision" value={totals.waiting} foot="Submitted, not yet decided" />
      </StatRow>

      <Card
        title="Team timesheets"
        sub={`${dir.list.length} people you may see`}
        flush
        actions={
          <div className="row" style={{ gap: 6 }}>
            <select className="input sm" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Everyone</option>
              {dir.list.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <select className="input sm" value={status}
              onChange={(e) => setStatus(e.target.value as '' | TSStatus)}>
              <option value="">Any status</option>
              {(['Draft', 'Submitted', 'Approved', 'Returned', 'Rejected'] as TSStatus[])
                .map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        }>
        {loading ? (
          <div style={{ padding: 16 }} className="muted">Loading…</div>
        ) : shown.length === 0 ? (
          <div style={{ padding: 16 }}>
            <EmptyState icon={<Icon n="note" size="lg" />}
              msg="No timesheets in this window. A week appears here once somebody opens it." />
          </div>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Employee</th><th>Week</th>
                  <th className="num">Total</th><th className="num">Billable</th>
                  <th>Status</th><th>Submitted</th><th className="right" />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id}>
                    <td><PersonCell e={dir.byId(s.empId)!} sub={dir.byId(s.empId)?.code} /></td>
                    <td className="nowrap">{weekLabel(s.weekStart)}</td>
                    <td className="num strong">{hrs(s.total)}</td>
                    <td className="num">{hrs(s.billable)}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="nowrap">{s.submittedOn ? fmtD(s.submittedOn) : '—'}</td>
                    <td className="right">
                      <button className="btn sm" onClick={() => onOpen(s.empId, s.weekStart)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Time entries
 * ------------------------------------------------------------------ */

/**
 * Every line, flattened out of the weeks that hold them.
 *
 * A timesheet is a list of entries rather than a grid, so this is the closest
 * view to what is actually stored. Read-only: a line is edited on its own week,
 * where the limits and the lifecycle apply.
 */
export function TimeEntries({ scope }: { scope: 'mine' | 'team' }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const proj = useBookableProjects();
  const ids = scope === 'mine' ? [app.meId] : dir.ids;
  const since = ymd(addDays(mondayOf(TODAY), -7 * (WINDOW - 1)));
  const { data: sheets = [], loading } = useSheets(ids, { since });

  const [project, setProject] = useState('');
  const [billable, setBillable] = useState<'' | 'yes' | 'no'>('');

  const rows = useMemo(() => sheets.flatMap((s) =>
    s.entries.map((e) => ({ sheet: s, entry: e }))), [sheets]);

  const shown = rows
    .filter((r) => (!project || r.entry.proj === project))
    .filter((r) => (!billable || (billable === 'yes') === r.entry.billable))
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date));

  return (
    <Card
      title={scope === 'mine' ? 'My time entries' : 'Time entries'}
      sub={`${shown.length} of ${rows.length} lines · last ${WINDOW} weeks`}
      flush
      actions={
        <div className="row" style={{ gap: 6 }}>
          <select className="input sm" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Any project</option>
            {proj.all.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input sm" value={billable}
            onChange={(e) => setBillable(e.target.value as '' | 'yes' | 'no')}>
            <option value="">Billable or not</option>
            <option value="yes">Billable</option>
            <option value="no">Non-billable</option>
          </select>
        </div>
      }>
      {loading ? (
        <div style={{ padding: 16 }} className="muted">Loading…</div>
      ) : shown.length === 0 ? (
        <div style={{ padding: 16 }}>
          <EmptyState icon={<Icon n="note" size="lg" />}
            msg="No time entries in this window." />
        </div>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                {scope === 'team' && <th>Employee</th>}
                <th>Project</th><th>Task</th>
                <th className="num">Hours</th><th>Billable</th><th>Notes</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ sheet, entry }) => (
                <tr key={entry.id}>
                  <td className="nowrap">{fmtD(entry.date)}</td>
                  {scope === 'team' && <td className="nowrap">{dir.name(sheet.empId)}</td>}
                  <td className="nowrap">{proj.name(entry.proj)}</td>
                  <td>{entry.task}</td>
                  <td className="num strong">{hrs(entry.hours)}</td>
                  <td>{entry.billable ? <Badge kind="good">Billable</Badge> : <Badge>Internal</Badge>}</td>
                  <td className="muted">{entry.remarks || '—'}</td>
                  <td><StatusBadge status={sheet.status} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

/**
 * The projects time can be booked against.
 *
 * Read-only, because nothing in this product creates a project yet — the table
 * is populated by the seed and `GET /projects` is the only thing that reads it
 * out. Saying so is better than a disabled Add button implying otherwise.
 */
export function TimesheetProjects() {
  const proj = useBookableProjects();
  const since = ymd(addDays(mondayOf(TODAY), -7 * (WINDOW - 1)));
  const dir = useVisiblePeople();
  const { data: sheets = [] } = useSheets(dir.ids, { since });

  /* Hours booked per project, from the weeks the caller may see. */
  const booked = new Map<string, number>();
  for (const s of sheets) {
    for (const e of s.entries) booked.set(e.proj, (booked.get(e.proj) ?? 0) + e.hours);
  }

  return (
    <div className="stack">
      <Card title="Projects" sub={`${proj.all.length} · ${proj.list.length} open for booking`} flush>
        {proj.loading ? (
          <div style={{ padding: 16 }} className="muted">Loading…</div>
        ) : proj.all.length === 0 ? (
          <div style={{ padding: 16 }}>
            <EmptyState icon={<Icon n="projects" size="lg" />}
              msg="No projects. Time cannot be booked until one exists." />
          </div>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Project</th><th>Code</th><th>Client</th><th>Billing</th>
                  <th>Runs</th><th className="num">Hours booked</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {proj.all.map((p) => (
                  <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                    <td><b>{p.name}</b></td>
                    <td className="mono">{p.id}</td>
                    <td>{p.client}</td>
                    <td>
                      {p.billable
                        ? <Badge kind="good">Billable</Badge>
                        : <Badge>Internal</Badge>}
                    </td>
                    <td className="nowrap muted">
                      {p.startsOn || p.endsOn
                        ? `${p.startsOn ? fmtD(p.startsOn) : '—'} → ${p.endsOn ? fmtD(p.endsOn) : 'open'}`
                        : 'No dates set'}
                    </td>
                    <td className="num">{booked.get(p.id) ? hrs(booked.get(p.id)!) : '—'}</td>
                    <td>{p.active ? 'Open' : <Badge kind="warn">Closed</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Hours booked counts only the weeks you may see, over the last {WINDOW} weeks.
        Projects are maintained outside this module; this view reads them.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Calendar
 * ------------------------------------------------------------------ */

const STATUS_DOT: Record<TSStatus, string> = {
  Draft: 'var(--t-mute-ink)',
  Submitted: 'var(--s1)',
  Approved: 'var(--t-green-ink)',
  Returned: 'var(--t-amber-ink)',
  Rejected: 'var(--t-red-ink)',
};

/**
 * One tile per week, so a gap is visible rather than inferred.
 *
 * A week nobody has opened has no row at all — `forWeek` creates it on first
 * sight — so an absent tile means "not started", which is the thing somebody
 * scanning for a missing week is actually looking for.
 */
export function TimesheetCalendar({ onOpen }: { onOpen: (ws: string) => void }) {
  const app = useApp();
  const weeks = recentWeeks(WINDOW);
  const { data: sheets = [], loading } = useSheets([app.meId], { since: weeks[weeks.length - 1] });
  const byWeek = new Map(sheets.map((s) => [s.weekStart, s] as const));
  const thisWeek = ymd(mondayOf(TODAY));

  return (
    <Card title="My timesheet calendar" sub={`Last ${WINDOW} weeks`}>
      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="grid g3" style={{ gap: 10 }}>
            {weeks.map((ws) => {
              const s: Timesheet | undefined = byWeek.get(ws);
              return (
                <button
                  key={ws}
                  className="ts-cal-week"
                  onClick={() => onOpen(ws)}
                  style={{
                    textAlign: 'left',
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--line)',
                    background: ws === thisWeek ? 'var(--surface-2)' : 'var(--surface)',
                    cursor: 'pointer',
                  }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{weekLabel(ws)}</span>
                    {ws === thisWeek && <Badge kind="info">This week</Badge>}
                  </div>
                  <div className="row" style={{ gap: 7, marginTop: 7, alignItems: 'center' }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: 99,
                      background: s ? STATUS_DOT[s.status] : 'var(--line)',
                      display: 'inline-block',
                    }} />
                    <span className="muted" style={{ fontSize: 12 }}>
                      {s ? `${s.status} · ${hrs(s.total)} h` : 'Not started'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="row wrap" style={{ gap: 14, marginTop: 14 }}>
            {(Object.keys(STATUS_DOT) as TSStatus[]).map((k) => (
              <span key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 99, background: STATUS_DOT[k],
                  display: 'inline-block',
                }} />
                <span className="muted" style={{ fontSize: 12 }}>{k}</span>
              </span>
            ))}
            <span className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span style={{
                width: 8, height: 8, borderRadius: 99, background: 'var(--line)',
                display: 'inline-block',
              }} />
              <span className="muted" style={{ fontSize: 12 }}>Not started</span>
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

export type { Directory };
