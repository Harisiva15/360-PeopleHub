/**
 * Timesheets — entry, history, approval, reporting.
 *
 * Eight views, and which of them a person gets follows the policy rather than
 * their job title: everybody writes and reads their own week, approvers get
 * the queue their line feeds, and the reports read whatever the employee
 * service already scoped for the caller. Nothing here decides who may see
 * what — it only stops offering screens the server would refuse.
 */

import { useState } from 'react';
import { addDays, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import type { Timesheet, TSStatus } from '../../services';
import {
  Badge, Card, EmptyState, PersonCell, StatRow, Table, TableWrap, Tabs, Tile,
} from '../../components/ui';
import { Dot, StatusBadge } from '../../components/common';
import { BarChart, HBar, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useBookableProjects, useDecideSheet, useMySheets, useSheets, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { MyWeek } from './MyWeek';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import {
  TeamTimesheets, TimeEntries, TimesheetCalendar, TimesheetProjects,
} from './Views';
import { CardSkeleton, Loaded, Nothing, TableSkeleton } from './States';
import { TITLES } from '../titles';
import { Icon } from '../../components/icons';

const hrs = (n: number) => n.toFixed(2);
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

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
      {err && <div className="ts-err-box"><Icon n="warn" size="lg" /> {err}</div>}
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
  /* Project names from the service, so a review shows what the entry books to. */
  const proj = useBookableProjects();
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
                      <Dot color={PAL[0]} /> {proj.name(e.proj)}
                      <div className="muted" style={{ fontSize: 11 }}>{proj.byId(e.proj)?.client ?? '—'}</div>
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

/* ---------------- History ---------------- */

/**
 * Every week the caller has had, newest first.
 *
 * `submittedOn` and `actedOn` are the only two dates the sheet carries, and
 * `actedOn` is the day a decision was recorded — a decision date for a week
 * that has had one, and nothing at all for a draft. It is shown only where it
 * means something rather than back-filled with whatever date is to hand.
 */
function TsHist({ setWs, setTab }: { setWs: (s: string) => void; setTab: (t: 'entry') => void }) {
  const app = useApp();
  const q = useMySheets(app.meId);
  const sheets = q.data ?? [];

  const [status, setStatus] = useState<'' | TSStatus>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const shown = sheets
    .filter((t) => (!status || t.status === status))
    .filter((t) => (!from || t.weekStart >= from))
    .filter((t) => (!to || t.weekStart <= to))
    .slice()
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

  const active = Boolean(status || from || to);
  const clear = () => { setStatus(''); setFrom(''); setTo(''); };
  const open = (week: string) => { setWs(week); setTab('entry'); };

  return (
    <Card
      title="Timesheet History"
      sub={`${shown.length} of ${sheets.length} weeks`}
      flush
      actions={
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <input className="input sm" type="date" aria-label="From week"
            value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input sm" type="date" aria-label="To week"
            value={to} onChange={(e) => setTo(e.target.value)} />
          <select className="input sm" aria-label="Status" value={status}
            onChange={(e) => setStatus(e.target.value as '' | TSStatus)}>
            <option value="">Any status</option>
            {(['Draft', 'Submitted', 'Approved', 'Returned', 'Rejected'] as TSStatus[])
              .map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="btn sm" disabled={!active} onClick={clear}>Clear filters</button>
        </div>
      }>
      <Loaded
        q={q}
        what="your previous timesheets"
        skeleton={<TableSkeleton cols={8} />}
        empty={shown.length === 0}
        emptyState={
          <Nothing
            msg="No previous timesheets found."
            sub={active
              ? 'No week in your history matches these filters.'
              : 'A week appears here once you open it.'}
            action={active
              ? { label: 'Clear filters', onClick: clear }
              : { label: 'Go to My Timesheet', onClick: () => open(ymd(mondayOf(TODAY))) }}
          />
        }>
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Week</th><th>Date range</th>
                <th className="num">Total</th><th className="num">Billable</th>
                <th className="num">Non-billable</th>
                <th>Status</th><th>Submitted</th><th>Decided</th><th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td className="nowrap"><b>{fmtD(t.weekStart)}</b></td>
                  <td className="nowrap muted">
                    {fmtD(t.weekStart)} – {fmtD(ymd(addDays(parseYmd(t.weekStart), 6)))}
                  </td>
                  <td className="num strong">{hrs(t.total)}</td>
                  <td className="num">{hrs(t.billable)}</td>
                  <td className="num">{hrs(t.nonBillable)}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td className="nowrap">{t.submittedOn ? fmtD(t.submittedOn) : '—'}</td>
                  <td className="nowrap">
                    {t.actedOn ? fmtD(t.actedOn) : <span className="muted">—</span>}
                  </td>
                  <td className="right">
                    <button className="btn sm" onClick={() => open(t.weekStart)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Loaded>
    </Card>
  );
}

/* ---------------- Pending approvals ---------------- */

/**
 * The weeks waiting on the caller.
 *
 * Only `Submitted` is genuinely pending. The approved and rejected counts
 * beside it are over the same window this screen already loads, and the tiles
 * say so — "approved this period" with no period named is the kind of figure
 * somebody quotes in a meeting and then cannot reproduce.
 *
 * Deciding goes through `/decide`, which requires a note for a return or a
 * rejection and refuses the caller's own week. None of that is re-implemented
 * here: the review dialog collects the note, the service enforces the rest.
 */
function TsApprovals({ ws, setWs }: { ws: string; setWs: (s: string) => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const review = useReviewTS(dir);
  const decide = useDecideSheet();
  const [acting, setActing] = useState<string | null>(null);

  const since = ymd(addDays(mondayOf(TODAY), -7 * 11));
  const q = useSheets(dir.ids, { since });
  const sheets = q.data ?? [];

  const [who, setWho] = useState('');
  const [week, setWeek] = useState(ws && sheets.some((t) => t.weekStart === ws) ? ws : '');

  const pending = sheets
    .filter((t) => t.status === 'Submitted')
    .filter((t) => t.empId !== app.meId)
    .filter((t) => (!who || t.empId === who))
    .filter((t) => (!week || t.weekStart === week))
    .sort((a, b) => (a.submittedOn ?? '').localeCompare(b.submittedOn ?? ''));

  const approvedHere = sheets.filter((t) => t.status === 'Approved').length;
  const rejectedHere = sheets.filter((t) => t.status === 'Rejected').length;

  const active = Boolean(who || week);
  const clear = () => { setWho(''); setWeek(''); setWs(ymd(mondayOf(TODAY))); };

  /*
   * One decision at a time. The service would refuse the second — a decided
   * week is no longer submitted — but that refusal would surface as an error
   * for something the person did not knowingly do twice.
   */
  const approve = async (t: Timesheet) => {
    if (acting) return;
    setActing(t.id);
    try {
      await decide.mutate(t.id, 'Approved');
      app.toast(`Approved ${dir.name(t.empId)}'s week`, 'ok');
    } catch (e) {
      app.toast(msg(e, 'Could not approve it'), 'err');
    } finally { setActing(null); }
  };

  return (
    <div className="stack">
      <StatRow cols={3}>
        <Tile label="Pending" value={pending.length} foot="Submitted, waiting on you" />
        <Tile label="Approved" value={approvedHere} foot="In the last 12 weeks" />
        <Tile label="Rejected" value={rejectedHere} foot="In the last 12 weeks" />
      </StatRow>

      <Card
        title="Pending Approvals"
        sub={`${pending.length} waiting`}
        flush
        actions={
          <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            <select className="input sm" aria-label="Employee" value={who}
              onChange={(e) => setWho(e.target.value)}>
              <option value="">Everyone</option>
              {dir.list.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <select className="input sm" aria-label="Week" value={week}
              onChange={(e) => setWeek(e.target.value)}>
              <option value="">Any week</option>
              {[...new Set(sheets.map((t) => t.weekStart))].sort().reverse().map((w) => (
                <option key={w} value={w}>{fmtD(w)}</option>
              ))}
            </select>
            <button className="btn sm" disabled={!active} onClick={clear}>Clear filters</button>
          </div>
        }>
        <Loaded
          q={q}
          what="the approval queue"
          skeleton={<TableSkeleton cols={7} />}
          empty={pending.length === 0}
          emptyState={
            <Nothing
              msg="No pending approvals."
              sub={active
                ? 'Nothing matches these filters.'
                : 'No action required. A week appears here when somebody submits it.'}
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
                  <th>Submitted</th><th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((t) => {
                  const e = dir.byId(t.empId);
                  const busy = acting === t.id;
                  return (
                    <tr key={t.id}>
                      <td>{e ? <PersonCell e={e} sub={e.code} /> : t.empId}</td>
                      <td className="nowrap">
                        {fmtD(t.weekStart)} – {fmtD(ymd(addDays(parseYmd(t.weekStart), 6)))}
                      </td>
                      <td className="num strong">{hrs(t.total)}</td>
                      <td className="num">{hrs(t.billable)}</td>
                      <td className="num">{hrs(t.nonBillable)}</td>
                      <td className="nowrap">{t.submittedOn ? fmtD(t.submittedOn) : '—'}</td>
                      <td className="right nowrap">
                        <button className="btn sm" onClick={() => review(t)}>View</button>{' '}
                        <button className="btn sm primary" disabled={busy || decide.pending}
                          onClick={() => approve(t)}>
                          {busy ? 'Approving…' : 'Approve'}
                        </button>{' '}
                        <button className="btn sm" disabled={busy} onClick={() => review(t)}>
                          Reject
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

      <div className="muted" style={{ fontSize: 12.5 }}>
        Returning or rejecting a week needs a reason, which the review dialog
        collects. You cannot decide your own week — the service refuses it.
      </div>
    </div>
  );
}

/* ---------------- Reports ---------------- */

/**
 * What the weeks add up to, and nothing more.
 *
 * Every figure is a sum of stored entries: hours by project, billable against
 * non-billable, hours by person, hours by week, and how many weeks sit in each
 * status. There is no utilisation, because that needs a capacity the timesheet
 * model does not hold, and no overtime, because that needs a contracted week it
 * does not hold either.
 */
function TsReports() {
  const dir = useVisiblePeople();
  const proj = useBookableProjects();
  const weeks: string[] = [];
  for (let w = 7; w >= 0; w--) weeks.push(ymd(mondayOf(addDays(TODAY, -w * 7))));

  const q = useSheets(dir.ids, { since: weeks[0] });
  const sheets = q.data ?? [];

  const [project, setProject] = useState('');
  const [who, setWho] = useState('');

  const scoped = sheets.filter((s) => (!who || s.empId === who));
  const entries = scoped
    .flatMap((s) => s.entries.map((e) => ({ s, e })))
    .filter((r) => (!project || r.e.proj === project));

  const active = Boolean(project || who);
  const clear = () => { setProject(''); setWho(''); };

  const total = entries.reduce((n, r) => n + r.e.hours, 0);
  const billable = entries.filter((r) => r.e.billable).reduce((n, r) => n + r.e.hours, 0);

  const byProject = [...entries.reduce((m, r) => {
    m.set(r.e.proj, (m.get(r.e.proj) ?? 0) + r.e.hours); return m;
  }, new Map<string, number>())].sort((a, b) => b[1] - a[1]);

  const byPerson = [...entries.reduce((m, r) => {
    m.set(r.s.empId, (m.get(r.s.empId) ?? 0) + r.e.hours); return m;
  }, new Map<string, number>())].sort((a, b) => b[1] - a[1]);

  const byWeek = weeks.map((w) => ({
    w,
    v: entries.filter((r) => r.s.weekStart === w).reduce((n, r) => n + r.e.hours, 0),
  }));

  const byStatus = (['Draft', 'Submitted', 'Approved', 'Returned', 'Rejected'] as TSStatus[])
    .map((s) => ({ k: s, v: scoped.filter((x) => x.status === s).length }))
    .filter((r) => r.v);

  const nothing = (
    <Nothing
      msg="Not enough timesheet data to generate this report."
      sub={active
        ? 'Nothing in the last eight weeks matches these filters.'
        : 'Reports fill in as weeks are logged.'}
      {...(active ? { action: { label: 'Clear filters', onClick: clear } } : {})}
    />
  );

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
        <select className="input sm" aria-label="Project" value={project}
          onChange={(e) => setProject(e.target.value)}>
          <option value="">Any project</option>
          {proj.all.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input sm" aria-label="Employee" value={who}
          onChange={(e) => setWho(e.target.value)}>
          <option value="">Everyone you may see</option>
          {dir.list.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <button className="btn sm" disabled={!active} onClick={clear}>Clear filters</button>
      </div>

      <Loaded
        q={q}
        what="the timesheet reports"
        skeleton={<CardSkeleton count={4} />}
        empty={entries.length === 0}
        emptyState={nothing}>
        <div className="stack">
          <StatRow cols={4}>
            <Tile label="Hours logged" value={hrs(total)} foot="Last 8 weeks" />
            <Tile label="Billable" value={hrs(billable)}
              foot={total ? `${pct(billable, total)}% of logged` : '—'} />
            <Tile label="Non-billable" value={hrs(total - billable)} foot="Internal and unbilled" />
            <Tile label="Weeks in view" value={scoped.length} foot="Across everyone shown" />
          </StatRow>

          <div className="grid g2">
            <Card title="Hours by project" sub="Last 8 weeks">
              <HBar rows={byProject.map(([id, v], i) => ({
                k: proj.name(id), v, c: PAL[i % PAL.length],
              }))} fmt={(v) => hrs(v)} />
            </Card>
            <Card title="Billable against non-billable" sub="Last 8 weeks">
              <HBar rows={[
                { k: 'Billable', v: billable, c: 'var(--good)' },
                { k: 'Non-billable', v: total - billable, c: 'var(--brand)' },
              ]} fmt={(v) => hrs(v)} />
            </Card>
          </div>

          <Card title="Hours by week" sub="Last 8 weeks">
            <BarChart labels={byWeek.map((r) => fmtD(r.w))} height={210} padLeft={44}
              fmt={(v) => hrs(v)} tickFmt={(v) => String(Math.round(v))}
              series={[{ name: 'Hours', color: 'var(--brand)', data: byWeek.map((r) => r.v) }]} />
          </Card>

          <div className="grid g2">
            <Card title="Hours by person" sub="Everyone you may see">
              {byPerson.length ? (
                <HBar rows={byPerson.map(([id, v], i) => ({
                  k: dir.name(id), v, c: PAL[i % PAL.length],
                }))} fmt={(v) => hrs(v)} />
              ) : nothing}
            </Card>
            <Card title="Timesheet status" sub="Weeks in the window">
              {byStatus.length ? (
                <HBar rows={byStatus.map((r, i) => ({ ...r, c: PAL[i % PAL.length] }))} />
              ) : nothing}
            </Card>
          </div>
        </div>
      </Loaded>
    </div>
  );
}


type Tab =
  | 'entry' | 'entries' | 'cal' | 'hist'
  | 'team' | 'appr' | 'proj' | 'rep';

/**
 * Which views a role is offered.
 *
 * `policy.ts` grants `timesheet` as employee `own`, manager `team`, admin
 * `all`, and `seesOthers` below is that line mirrored — the same mirroring
 * every other module does, kept honest by `checks/roles.ts`, which compares
 * the client's table against the server's policy and fails when they drift.
 *
 * This decides what is *offered*, never what is *allowed*. `scope()` in the
 * timesheet service filters every read by the caller in SQL, so an employee who
 * reached the team view by editing the URL would get their own rows back and
 * nothing else. The tabs are a courtesy; the boundary is the server's.
 */
const SELF: { v: Tab; label: string }[] = [
  { v: 'entry', label: 'My Timesheet' },
  { v: 'entries', label: 'Time Entries' },
  { v: 'cal', label: 'Calendar' },
  { v: 'hist', label: 'History' },
];

const TEAM: { v: Tab; label: string }[] = [
  { v: 'team', label: 'Team Timesheets' },
  { v: 'appr', label: 'Pending Approvals' },
  { v: 'proj', label: 'Projects' },
  { v: 'rep', label: 'Reports' },
];

const ALL_TABS: Tab[] = [...SELF, ...TEAM].map((t) => t.v);

function TimesheetView() {
  const app = useApp();

  /*
   * An employee approves nothing and sees nobody else's week, so the four team
   * views are not offered to them. The policy is the source: employee 'own',
   * manager 'team', admin 'all'.
   */
  const seesOthers = app.role !== 'employee';
  const tabs = seesOthers ? [...SELF, ...TEAM] : SELF;

  const [tab, setTab] = useTabFromUrl<Tab>('entry', ALL_TABS);
  const [ws, setWs] = useState(ymd(mondayOf(TODAY)));
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  /* Opening somebody's week from a team view lands on the approval queue for
     that week, which is where a decision is actually made. */
  const openWeek = (_empId: string, weekStart: string) => { setWs(weekStart); setTab('appr'); };

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'entry' && <MyWeek ws={ws} setWs={setWs} />}
      {active === 'entries' && <TimeEntries scope={seesOthers ? 'team' : 'mine'}
          onOpenWeek={(w) => { setWs(w); setTab('entry'); }} />}
      {active === 'cal' && <TimesheetCalendar onOpen={(w) => { setWs(w); setTab('entry'); }} />}
      {active === 'hist' && <TsHist setWs={setWs} setTab={() => setTab('entry')} />}
      {active === 'team' && <TeamTimesheets onOpen={openWeek} />}
      {active === 'appr' && <TsApprovals ws={ws} setWs={setWs} />}
      {active === 'proj' && <TimesheetProjects />}
      {active === 'rep' && <TsReports />}
    </>
  );
}

registerModule({
  key: 'timesheet',
  title: TITLES.timesheet,
  Component: TimesheetView,
});
