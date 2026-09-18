/**
 * Recruitment — the operations desk.
 *
 * The twelve submenus in the brief are one module rather than twelve, because
 * they are twelve views of one object: a job order, the people on it, and what
 * has happened. Splitting them into separate routes would mean a job order
 * opened from the dashboard and a job order opened from a recruiter's list
 * were different pages with the same content.
 *
 * **Only what is specified is built.** Sections 1–10 of the brief cover the
 * dashboard, the funnel, job creation, details, commercials, the SLA,
 * recruiter assignment, the assigned-job page and the activity tracker. The
 * remaining submenus point at the screens that already serve them; where
 * nothing serves them yet, the tab says so rather than rendering an empty
 * shell that looks broken.
 */

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { sortBy } from '../../lib/collections';
import { clientOf } from '../../data/staffing';
import type { JobStatus, RecruitmentFilter } from '../../services';
import { Banner, Card, EmptyState, StatRow, Tabs, Tile } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useTabFromUrl } from '../tabParam';
import { Filters, OrderTable, RecruitmentDashboard } from './Dashboard';
import { CreateJobOrder } from './CreateJobOrder';
import { JobOrderPage } from './JobOrder';
import { useJobOrders, useMyJobs, useVisiblePeople } from './data';
import { Icon } from '../../components/icons';

/* ---------------- job requisitions ---------------- */

const STATUSES: JobStatus[] =
  ['Draft', 'Open', 'On Hold', 'Filled', 'Closed', 'Lost', 'Cancelled'];

function JobRequisitions({ onNew }: { onNew: () => void }) {
  const app = useApp();
  const [f, setF] = useState<RecruitmentFilter>({});
  const [q, setQ] = useState('');
  const { data: rows = [], loading } = useJobOrders(f);
  const { data: book = [] } = useJobOrders({});

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((x) =>
      (x.order.title + ' ' + x.order.role + ' ' + clientOf(x.order.clientId).name
        + ' ' + x.order.location + ' ' + x.order.skills.join(' '))
        .toLowerCase().includes(needle))
    : rows;

  const count = (s: JobStatus) => book.filter((x) => x.order.status === s).length;

  return (
    <div className="stack">
      {app.role !== 'employee' && (
        <PageActions>
          <button className="btn primary" onClick={onNew}>+ Create job order</button>
        </PageActions>
      )}

      <StatRow cols={4}>
        <Tile label="Open" value={count('Open')} foot="Taking submissions" />
        <Tile label="Draft" value={count('Draft')} foot="Not on a desk yet" />
        <Tile label="On hold" value={count('On Hold')} foot="Paused by the client" />
        <Tile label="Filled" value={count('Filled')} foot="Every position closed" />
      </StatRow>

      <Filters f={f} set={setF} book={book} />

      <Card title="Job requisitions" sub={`${shown.length} orders`} flush
        actions={(
          <div className="row" style={{ gap: 8 }}>
            <select className="input sm" value={f.status ?? ''} aria-label="Status"
              onChange={(e) => setF({ ...f, status: (e.target.value || undefined) as JobStatus })}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input className="input sm" style={{ width: 210 }} value={q}
              placeholder="Search title, client, skill…"
              aria-label="Search job orders"
              onChange={(e) => setQ(e.target.value)} />
          </div>
        )}>
        <OrderTable rows={shown}
          empty={loading ? 'Loading job orders…' : 'No job orders match this filter'} />
      </Card>
    </div>
  );
}

/* ---------------- my assigned jobs ---------------- */

function MyAssignedJobs() {
  const app = useApp();
  const { data: rows = [], loading } = useMyJobs(app.meId);

  const open = rows.filter((x) => x.order.status === 'Open');
  const late = open.filter((x) => x.sla.state === 'Overdue');
  const subs = rows.reduce((n, x) => n + x.counts.submissions, 0);
  const hires = rows.reduce((n, x) => n + x.counts.hires, 0);

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="On my desk" value={open.length} foot="Open orders assigned to me" />
        <Tile label="Behind" value={late.length} foot="Past a target" />
        <Tile label="My submissions" value={subs} foot="Across every order" />
        <Tile label="My hires" value={hires} foot="Placements made" />
      </StatRow>

      {late.length > 0 && (
        <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title={`${late.length} of your orders are behind`}>
          {late.map((x) => x.order.title).slice(0, 3).join(', ')}
          {late.length > 3 && ` and ${late.length - 3} more`}.
        </Banner>
      )}

      <Card title="My assigned jobs" sub={`${rows.length} orders, open and closed`} flush>
        <OrderTable rows={sortBy(rows, (x) => x.order.status === 'Open' ? 0 : 1)}
          empty={loading ? 'Loading your desk…' : 'Nothing is assigned to you yet'} />
      </Card>
    </div>
  );
}

/* ---------------- recruiter activity ---------------- */

/**
 * What each desk has produced.
 *
 * Built from the orders each recruiter holds rather than from a separate
 * activity table, so it cannot disagree with the job lists — which is the same
 * reason the dashboard's tiles and funnel share one filter.
 */
function RecruiterActivity() {
  const dir = useVisiblePeople();
  const { data: rows = [] } = useJobOrders({});

  const ids = Array.from(new Set(rows.map((x) => x.order.recruiterId).filter(Boolean)));
  const desks = sortBy(ids.map((id) => {
    const mine = rows.filter((x) => x.order.recruiterId === id);
    const open = mine.filter((x) => x.order.status === 'Open');
    return {
      id,
      open: open.length,
      behind: open.filter((x) => x.sla.state === 'Overdue').length,
      sourced: mine.reduce((n, x) => n + x.counts.sourced, 0),
      submissions: mine.reduce((n, x) => n + x.counts.submissions, 0),
      interviews: mine.reduce((n, x) => n + x.counts.interviews, 0),
      hires: mine.reduce((n, x) => n + x.counts.hires, 0),
    };
  }), (d) => -d.submissions);

  return (
    <Card title="Recruiter activity" sub={`${desks.length} desks`} flush>
      {desks.length ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Recruiter</th>
                <th className="num">Open jobs</th><th className="num">Behind</th>
                <th className="num">Sourced</th><th className="num">Submissions</th>
                <th className="num">Interviews</th><th className="num">Hires</th>
              </tr>
            </thead>
            <tbody>
              {desks.map((d) => (
                <tr key={d.id}>
                  <td className="nowrap">{dir.name(d.id)}</td>
                  <td className="num strong">{d.open}</td>
                  <td className="num">
                    {d.behind ? <span className="sla-over">{d.behind}</span> : '—'}
                  </td>
                  <td className="num">{d.sourced}</td>
                  <td className="num">{d.submissions}</td>
                  <td className="num">{d.interviews}</td>
                  <td className="num strong">{d.hires}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <EmptyState msg="No recruiter has an order assigned yet" />}
    </Card>
  );
}

/**
 * A submenu the brief names but has not specified yet.
 *
 * Says so plainly, and points at whatever already serves that job, rather than
 * rendering an empty table that reads as a bug.
 */
function NotYetSpecified({ what, goes }: { what: string; goes?: { to: string; n: string }[] }) {
  return (
    <Card title={what} sub="Not built yet">
      <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.6 }}>
        The brief names this screen but stops before specifying it — the
        requirements end partway through the activity tracker. Rather than guess
        at what it should show, it is left until the spec arrives.
      </p>
      {goes?.length ? (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 7 }}>
            In the meantime, this work lives here:
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {goes.map((g) => (
              <Link key={g.to} className="btn sm" to={g.to}>{g.n}</Link>
            ))}
          </div>
        </>
      ) : null}
    </Card>
  );
}

/* ---------------- the module ---------------- */

type Tab =
  | 'dash' | 'reqs' | 'mine' | 'new' | 'job'
  | 'cands' | 'subs' | 'ivs' | 'offers' | 'placements' | 'activity' | 'pool' | 'reports';

const ALL_TABS: Tab[] = [
  'dash', 'reqs', 'mine', 'new', 'job',
  'cands', 'subs', 'ivs', 'offers', 'placements', 'activity', 'pool', 'reports',
];

function RecruitmentView() {
  const app = useApp();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useTabFromUrl<Tab>('dash', ALL_TABS);
  const jobId = params.get('id') ?? '';

  const desk = app.role !== 'employee';

  const tabs: { v: Tab; label: string }[] = [
    { v: 'dash', label: 'Dashboard' },
    { v: 'reqs', label: 'Job Requisitions' },
    { v: 'mine', label: 'My Assigned Jobs' },
    { v: 'cands', label: 'Candidates' },
    { v: 'subs', label: 'Submissions' },
    { v: 'ivs', label: 'Interviews' },
    { v: 'offers', label: 'Offers' },
    { v: 'placements', label: 'Placements' },
    ...(desk ? [{ v: 'activity' as Tab, label: 'Recruiter Activity' }] : []),
    { v: 'pool', label: 'Talent Pool' },
    { v: 'reports', label: 'Reports' },
  ];

  const open = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('v', 'job');
    next.set('id', id);
    setParams(next);
  };
  const closeJob = () => {
    const next = new URLSearchParams(params);
    next.set('v', 'reqs');
    next.delete('id');
    setParams(next);
  };

  /* The job page and the create form are reached from a list, not the tab bar. */
  if (tab === 'job' && jobId) {
    return <JobOrderPage id={jobId} back={closeJob} />;
  }
  if (tab === 'new') {
    return <CreateJobOrder done={open} />;
  }

  const active = tabs.some((t) => t.v === tab) ? tab : 'dash';

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'dash' && <RecruitmentDashboard />}
      {active === 'reqs' && <JobRequisitions onNew={() => setTab('new')} />}
      {active === 'mine' && <MyAssignedJobs />}
      {active === 'activity' && <RecruiterActivity />}

      {active === 'cands' && (
        <NotYetSpecified what="Candidates"
          goes={[{ to: '/bench', n: 'Bench & consultants' }, { to: '/hiring?v=cands', n: 'Internal candidates' }]} />
      )}
      {active === 'subs' && (
        <NotYetSpecified what="Candidate submissions"
          goes={[{ to: '/requirements', n: 'Requirements & submissions' }]} />
      )}
      {active === 'ivs' && (
        <NotYetSpecified what="Interviews"
          goes={[{ to: '/hiring?v=ivs', n: 'Internal interviews' }]} />
      )}
      {active === 'offers' && (
        <NotYetSpecified what="Offers"
          goes={[{ to: '/hiring?v=offers', n: 'Internal offers' }]} />
      )}
      {active === 'placements' && (
        <NotYetSpecified what="Placements / hires"
          goes={[{ to: '/placements', n: 'Placements' }]} />
      )}
      {active === 'pool' && <NotYetSpecified what="Talent pool" />}
      {active === 'reports' && (
        <NotYetSpecified what="Recruitment reports"
          goes={[{ to: '/reports', n: 'Reports' }]} />
      )}
    </>
  );
}

registerModule({
  key: 'recruitment',
  title: TITLES.recruitment,
  Component: RecruitmentView,
});
