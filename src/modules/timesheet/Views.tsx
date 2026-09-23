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
 * **Filters narrow what is already loaded.** `list()` takes employee ids, a
 * week, a since-date and a status, and those go to the API; project, billing
 * and free text have no server-side filter, so they are applied here against
 * rows the caller already holds. Neither kind is a security boundary.
 *
 * **Only figures the service returns.** A sheet carries `total`, `billable` and
 * `nonBillable`. There is no regular-versus-overtime split and no leave in the
 * timesheet model, so those are absent rather than computed — a number the
 * payslip would not recognise is worse than none.
 */

import { useMemo, useState } from 'react';
import { addDays, fmtD, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { Badge, Card, PersonCell, StatRow, Table, TableWrap, Tile } from '../../components/ui';
import { StatusBadge } from '../../components/common';
import { useApp } from '../../state/AppContext';
import type { Timesheet, TSStatus } from '../../services';
import { useBookableProjects, useSheets, useVisiblePeople } from './data';
import type { Directory } from './data';
import { CalendarSkeleton, CardSkeleton, Loaded, Nothing, TableSkeleton } from './States';

const hrs = (n: number) => n.toFixed(2);

const STATUSES: TSStatus[] = ['Draft', 'Submitted', 'Approved', 'Returned', 'Rejected'];

/** How far back the list views look. Twelve weeks is a quarter. */
const WINDOW = 12;
const windowStart = () => ymd(addDays(mondayOf(TODAY), -7 * (WINDOW - 1)));

const weekLabel = (ws: string) => `${fmtD(ws)} – ${fmtD(ymd(addDays(parseYmd(ws), 6)))}`;

/** Mondays back from this one, newest first. */
function recentWeeks(n: number): string[] {
  const start = mondayOf(TODAY);
  return Array.from({ length: n }, (_, i) => ymd(addDays(start, -7 * i)));
}

/** A toolbar that can say when it has nothing left to clear. */
function Filters({ active, onClear, children }: {
  active: boolean;
  onClear: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
      {children}
      <button className="btn sm" disabled={!active} onClick={onClear}>Clear filters</button>
    </div>
  );
}

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
  const proj = useBookableProjects();
  const [week, setWeek] = useState('');
  const [status, setStatus] = useState<'' | TSStatus>('');
  const [who, setWho] = useState('');
  const [project, setProject] = useState('');

  /* Week and status are the API's to filter; the rest narrow what came back. */
  const q = useSheets(dir.ids, week ? { weekStart: week } : { since: windowStart() });
  const sheets = q.data ?? [];

  const shown = sheets
    .filter((s) => (!status || s.status === status))
    .filter((s) => (!who || s.empId === who))
    .filter((s) => (!project || s.entries.some((e) => e.proj === project)));

  const active = Boolean(week || status || who || project);
  const clear = () => { setWeek(''); setStatus(''); setWho(''); setProject(''); };

  const sum = (pick: (s: Timesheet) => number) => shown.reduce((n, s) => n + pick(s), 0);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Weeks in view" value={shown.length}
          foot={week ? weekLabel(week) : `Last ${WINDOW} weeks`} />
        <Tile label="Hours logged" value={hrs(sum((s) => s.total))} foot="Across everyone shown" />
        <Tile label="Billable" value={hrs(sum((s) => s.billable))}
          foot={sum((s) => s.total)
            ? `${Math.round((sum((s) => s.billable) / sum((s) => s.total)) * 100)}% of logged`
            : '—'} />
        <Tile label="Awaiting a decision" value={shown.filter((s) => s.status === 'Submitted').length}
          foot="Submitted, not yet decided" />
      </StatRow>

      <Card
        title="Team timesheets"
        sub={`${dir.list.length} people you may see`}
        flush
        actions={
          <Filters active={active} onClear={clear}>
            <select className="input sm" aria-label="Week" value={week}
              onChange={(e) => setWeek(e.target.value)}>
              <option value="">Last {WINDOW} weeks</option>
              {recentWeeks(WINDOW).map((w) => (
                <option key={w} value={w}>{weekLabel(w)}</option>
              ))}
            </select>
            <select className="input sm" aria-label="Employee" value={who}
              onChange={(e) => setWho(e.target.value)}>
              <option value="">Everyone</option>
              {dir.list.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <select className="input sm" aria-label="Status" value={status}
              onChange={(e) => setStatus(e.target.value as '' | TSStatus)}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="input sm" aria-label="Project" value={project}
              onChange={(e) => setProject(e.target.value)}>
              <option value="">Any project</option>
              {proj.all.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Filters>
        }>
        <Loaded
          q={q}
          what="the team's timesheets"
          skeleton={<TableSkeleton cols={7} />}
          empty={shown.length === 0}
          emptyState={
            <Nothing
              msg="No team timesheets found for this period."
              sub={active
                ? 'Try widening the filters — a week only appears once somebody opens it.'
                : 'A week appears here once somebody opens it.'}
              {...(active ? { action: { label: 'Clear filters', onClick: clear } } : {})}
            />
          }>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Employee</th><th>Week</th>
                  <th className="num">Total</th><th className="num">Billable</th>
                  <th className="num">Non-billable</th>
                  <th>Status</th><th>Submitted</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const e = dir.byId(s.empId);
                  return (
                    <tr key={s.id}>
                      <td>{e ? <PersonCell e={e} sub={e.code} /> : s.empId}</td>
                      <td className="nowrap">{weekLabel(s.weekStart)}</td>
                      <td className="num strong">{hrs(s.total)}</td>
                      <td className="num">{hrs(s.billable)}</td>
                      <td className="num">{hrs(s.nonBillable)}</td>
                      <td><StatusBadge status={s.status} /></td>
                      <td className="nowrap">{s.submittedOn ? fmtD(s.submittedOn) : '—'}</td>
                      <td className="right">
                        <button className="btn sm" onClick={() => onOpen(s.empId, s.weekStart)}>
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </Loaded>
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
 * where the limits and the lifecycle apply, and offering an edit here that
 * silently failed on an approved week would be worse than not offering one.
 */
export function TimeEntries({ scope, onOpenWeek }: {
  scope: 'mine' | 'team';
  onOpenWeek: (ws: string) => void;
}) {
  const app = useApp();
  const dir = useVisiblePeople();
  const proj = useBookableProjects();
  const ids = scope === 'mine' ? [app.meId] : dir.ids;
  const q = useSheets(ids, { since: windowStart() });
  const sheets = q.data ?? [];

  const [text, setText] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [project, setProject] = useState('');
  const [billable, setBillable] = useState<'' | 'yes' | 'no'>('');
  const [status, setStatus] = useState<'' | TSStatus>('');

  const rows = useMemo(() => sheets.flatMap((s) =>
    s.entries.map((e) => ({ sheet: s, entry: e }))), [sheets]);

  const needle = text.trim().toLowerCase();
  const shown = rows
    .filter((r) => (!from || r.entry.date >= from))
    .filter((r) => (!to || r.entry.date <= to))
    .filter((r) => (!project || r.entry.proj === project))
    .filter((r) => (!billable || (billable === 'yes') === r.entry.billable))
    .filter((r) => (!status || r.sheet.status === status))
    .filter((r) => !needle
      || r.entry.task.toLowerCase().includes(needle)
      || r.entry.remarks.toLowerCase().includes(needle)
      || proj.name(r.entry.proj).toLowerCase().includes(needle))
    .sort((a, b) => b.entry.date.localeCompare(a.entry.date));

  const active = Boolean(needle || from || to || project || billable || status);
  const clear = () => {
    setText(''); setFrom(''); setTo(''); setProject(''); setBillable(''); setStatus('');
  };

  return (
    <Card
      title="Time Entries"
      sub="View and manage your recorded work hours."
      flush
      actions={
        <Filters active={active} onClear={clear}>
          <input className="input sm" placeholder="Search task, note or project"
            aria-label="Search" style={{ width: 190 }}
            value={text} onChange={(e) => setText(e.target.value)} />
          <input className="input sm" type="date" aria-label="From"
            value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input sm" type="date" aria-label="To"
            value={to} onChange={(e) => setTo(e.target.value)} />
          <select className="input sm" aria-label="Project" value={project}
            onChange={(e) => setProject(e.target.value)}>
            <option value="">Any project</option>
            {proj.all.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input sm" aria-label="Billable" value={billable}
            onChange={(e) => setBillable(e.target.value as '' | 'yes' | 'no')}>
            <option value="">Billable or not</option>
            <option value="yes">Billable</option>
            <option value="no">Non-billable</option>
          </select>
          <select className="input sm" aria-label="Status" value={status}
            onChange={(e) => setStatus(e.target.value as '' | TSStatus)}>
            <option value="">Any status</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Filters>
      }>
      <Loaded
        q={q}
        what="your time entries"
        skeleton={<TableSkeleton cols={8} />}
        empty={shown.length === 0}
        emptyState={
          <Nothing
            msg="No time entries found."
            sub={active
              ? 'Nothing in the last 12 weeks matches these filters.'
              : 'Hours logged on your week appear here.'}
            action={active
              ? { label: 'Clear filters', onClick: clear }
              : { label: 'Go to My Timesheet', onClick: () => onOpenWeek(ymd(mondayOf(TODAY))) }}
          />
        }>
        <>
          <div className="muted" style={{ fontSize: 12, padding: '8px 14px 0' }}>
            {shown.length} of {rows.length} lines · last {WINDOW} weeks
          </div>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Date</th>
                  {scope === 'team' && <th>Employee</th>}
                  <th>Project</th><th>Task</th>
                  <th className="num">Hours</th><th>Billable</th><th>Notes</th>
                  <th>Status</th><th className="right">Action</th>
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
                    <td>
                      {entry.billable
                        ? <Badge kind="good">Billable</Badge>
                        : <Badge>Internal</Badge>}
                    </td>
                    <td className="muted">{entry.remarks || '—'}</td>
                    <td><StatusBadge status={sheet.status} /></td>
                    <td className="right">
                      {/* Editing happens on the week, where the limits apply. */}
                      <button className="btn sm" onClick={() => onOpenWeek(sheet.weekStart)}>
                        Open week
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </>
      </Loaded>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

/**
 * The projects time can be booked against.
 *
 * Read-only, because nothing in this product creates a project — the table is
 * populated by the seed and `GET /projects` is the only thing that reads it
 * out. Saying so is better than a disabled Add button implying otherwise.
 *
 * Every project currently reports its client as "Internal" because
 * `project.client_id` is null on every row. That is the truthful fallback the
 * service applies, not a placeholder this screen invented.
 */
export function TimesheetProjects() {
  const proj = useBookableProjects();
  const dir = useVisiblePeople();
  const q = useSheets(dir.ids, { since: windowStart() });
  const sheets = q.data ?? [];

  const [text, setText] = useState('');
  const [open, setOpen] = useState<'' | 'open' | 'closed'>('');
  const [billing, setBilling] = useState<'' | 'yes' | 'no'>('');

  /* Hours booked per project, from the weeks the caller may see. */
  const booked = new Map<string, number>();
  for (const s of sheets) {
    for (const e of s.entries) booked.set(e.proj, (booked.get(e.proj) ?? 0) + e.hours);
  }

  const needle = text.trim().toLowerCase();
  const shown = proj.all
    .filter((p) => !needle
      || p.name.toLowerCase().includes(needle)
      || p.id.toLowerCase().includes(needle)
      || p.client.toLowerCase().includes(needle))
    .filter((p) => (!open || (open === 'open') === p.active))
    .filter((p) => (!billing || (billing === 'yes') === p.billable));

  const active = Boolean(needle || open || billing);
  const clear = () => { setText(''); setOpen(''); setBilling(''); };

  return (
    <div className="stack">
      <Card
        title="Projects"
        sub={`${proj.all.length} · ${proj.list.length} open for booking`}
        flush
        actions={
          <Filters active={active} onClear={clear}>
            <input className="input sm" placeholder="Search name, code or client"
              aria-label="Search" style={{ width: 200 }}
              value={text} onChange={(e) => setText(e.target.value)} />
            <select className="input sm" aria-label="Status" value={open}
              onChange={(e) => setOpen(e.target.value as '' | 'open' | 'closed')}>
              <option value="">Any status</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
            <select className="input sm" aria-label="Billing" value={billing}
              onChange={(e) => setBilling(e.target.value as '' | 'yes' | 'no')}>
              <option value="">Billable or not</option>
              <option value="yes">Billable</option>
              <option value="no">Internal</option>
            </select>
          </Filters>
        }>
        <Loaded
          q={proj}
          what="the project list"
          skeleton={<CardSkeleton count={6} />}
          empty={shown.length === 0}
          emptyState={
            <Nothing
              msg={proj.all.length === 0 ? 'No projects available.' : 'No projects match these filters.'}
              sub={proj.all.length === 0
                ? 'Time cannot be booked until a project exists. Projects are maintained outside this module.'
                : undefined}
              {...(active ? { action: { label: 'Clear filters', onClick: clear } } : {})}
            />
          }>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Project</th><th>Code</th><th>Client</th><th>Billing</th>
                  <th>Runs</th><th className="num">Hours booked</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
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
        </Loaded>
      </Card>
      <div className="muted" style={{ fontSize: 12.5 }}>
        Hours booked counts only the weeks you may see, over the last {WINDOW} weeks.
        Assigned team is not shown: the project record holds no membership, and the
        only people it could be inferred from are those who happen to have booked time.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Calendar
 * ------------------------------------------------------------------ */

const STATUS_DOT: Record<TSStatus, string> = {
  Draft: 'var(--ink-3)',
  Submitted: 'var(--brand)',
  Approved: 'var(--good)',
  Returned: 'var(--warn)',
  Rejected: 'var(--crit)',
};

/**
 * The weeks, and the days inside the one being looked at.
 *
 * A week nobody has opened has no row at all — `forWeek` creates it on first
 * sight — so an absent tile means "not started", which is what somebody
 * scanning for a missing week is actually looking for.
 *
 * Day totals are summed from the entries of the week's sheet. That is the one
 * figure this screen derives, and it derives it from stored entries rather than
 * from a rule: no leave, no holidays, no expected hours, because the timesheet
 * service exposes none of those and inventing them here would put a number on
 * the screen nothing else in the product agrees with.
 */
export function TimesheetCalendar({ onOpen }: { onOpen: (ws: string) => void }) {
  const app = useApp();
  const [view, setView] = useState<'weeks' | 'days'>('weeks');
  const [anchor, setAnchor] = useState(ymd(mondayOf(TODAY)));

  const weeks = recentWeeks(WINDOW);
  const q = useSheets([app.meId], { since: weeks[weeks.length - 1] });
  const sheets = q.data ?? [];
  const byWeek = new Map(sheets.map((s) => [s.weekStart, s] as const));
  const thisWeek = ymd(mondayOf(TODAY));

  const step = (by: number) => setAnchor(ymd(addDays(parseYmd(anchor), by * 7)));
  const sheet = byWeek.get(anchor);
  const days = Array.from({ length: 7 }, (_, i) => ymd(addDays(parseYmd(anchor), i)));

  return (
    <Card
      title="Timesheet calendar"
      sub={view === 'weeks' ? `Last ${WINDOW} weeks` : weekLabel(anchor)}
      actions={
        <div className="row" style={{ gap: 6 }}>
          {view === 'days' && (
            <>
              <button className="btn icon sm" aria-label="Previous week"
                title="Previous week" onClick={() => step(-1)}>‹</button>
              <button className="btn icon sm" aria-label="Next week"
                title="Next week" onClick={() => step(1)}>›</button>
            </>
          )}
          <button className="btn sm" disabled={anchor === thisWeek && view === 'days'}
            onClick={() => { setAnchor(thisWeek); setView('days'); }}>Today</button>
          <button className="btn sm"
            onClick={() => setView(view === 'weeks' ? 'days' : 'weeks')}>
            {view === 'weeks' ? 'Week view' : 'All weeks'}
          </button>
        </div>
      }>
      <Loaded
        q={q}
        what="your timesheet calendar"
        skeleton={<CalendarSkeleton count={12} />}
        empty={false}
        emptyState={null}>
        {view === 'weeks' ? (
          <>
            <div className="ts-cal-grid">
              {weeks.map((ws) => {
                const s: Timesheet | undefined = byWeek.get(ws);
                return (
                  <button key={ws} className="ts-cal-week" onClick={() => onOpen(ws)}>
                    <div className="ts-cal-top">
                      <span className="ts-cal-range">{weekLabel(ws)}</span>
                      {ws === thisWeek && <Badge kind="info">This week</Badge>}
                    </div>
                    <div className="ts-cal-meta">
                      <span className="ts-dot" style={{ background: s ? STATUS_DOT[s.status] : 'var(--line)' }} />
                      <span>{s ? `${s.status} · ${hrs(s.total)} h` : 'Not started'}</span>
                    </div>
                    {s && (
                      <div className="ts-cal-sub">
                        {s.entries.length} {s.entries.length === 1 ? 'entry' : 'entries'}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <Legend />
          </>
        ) : (
          <>
            <div className="ts-cal-grid">
              {days.map((d) => {
                const entries = sheet?.entries.filter((e) => e.date === d) ?? [];
                const total = entries.reduce((n, e) => n + e.hours, 0);
                return (
                  <button key={d} className="ts-cal-week" onClick={() => onOpen(anchor)}>
                    <div className="ts-cal-top">
                      <span className="ts-cal-range">{fmtD(d)}</span>
                      {d === ymd(TODAY) && <Badge kind="info">Today</Badge>}
                    </div>
                    <div className="ts-cal-meta">
                      <span className="ts-dot"
                        style={{ background: total ? 'var(--brand)' : 'var(--line)' }} />
                      <span>{total ? `${hrs(total)} h` : 'Nothing logged'}</span>
                    </div>
                    {entries.length > 0 && (
                      <div className="ts-cal-sub">
                        {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              {sheet
                ? <>This week is <b>{sheet.status}</b> · {hrs(sheet.total)} h logged.</>
                : 'This week has not been started.'}
            </div>
          </>
        )}
      </Loaded>
    </Card>
  );
}

function Legend() {
  return (
    <div className="row wrap" style={{ gap: 14, marginTop: 14 }}>
      {(Object.keys(STATUS_DOT) as TSStatus[]).map((k) => (
        <span key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span className="ts-dot" style={{ background: STATUS_DOT[k] }} />
          <span className="muted" style={{ fontSize: 12 }}>{k}</span>
        </span>
      ))}
      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
        <span className="ts-dot" style={{ background: 'var(--line)' }} />
        <span className="muted" style={{ fontSize: 12 }}>Not started</span>
      </span>
    </div>
  );
}

export type { Directory };
