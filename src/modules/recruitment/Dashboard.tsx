/**
 * The recruitment dashboard.
 *
 * Eight tiles, a funnel, and the orders that need attention — all narrowed by
 * one filter object. The filter is shared rather than per-panel deliberately:
 * a page where the tiles say 40 open jobs and the funnel says 12 is a page
 * nobody trusts again, and that happens the moment two panels narrow their own
 * way.
 *
 * Every figure is computed by the service, and every row carries its own SLA.
 * The screen adds nothing up.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { sortBy, uniq } from '../../lib/collections';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { clientOf, INDUSTRIES } from '../../data/staffing';
import { SKILLS } from '../../data/org';
import type { JobOrderRow, RecruitmentFilter } from '../../services';
import { Card, EmptyState, StatRow, Tile } from '../../components/ui';
import { HBar } from '../../components/charts';
import { useFunnel, useJobOrders, useRecruitmentKpi, useVisiblePeople } from './data';
import { Aging, Commercials, PriorityBadge, SlaBadge, jobNo } from './shared';
import { Icon } from '../../components/icons';

/* ---------------- the funnel ---------------- */

interface Step { k: string; v: number; c: string }

/**
 * The funnel, drawn as proportional bars rather than a tapering polygon.
 *
 * A taper encodes each number twice — once in the width and once in the label
 * — and the width is the half that lies, because a stage with three candidates
 * and one with two look identical at the bottom of a taper. Bars share one
 * scale, so the drop between two stages is the thing you actually see.
 */
function Funnel({ steps }: { steps: Step[] }) {
  const top = Math.max(1, steps[0]?.v ?? 1);
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const prev = i === 0 ? null : steps[i - 1].v;
        /* Conversion from the stage above — the number a desk acts on. */
        const conv = prev === null ? null : pct(s.v, Math.max(1, prev));
        return (
          <div className="funnel-row" key={s.k}>
            <div className="funnel-k">{s.k}</div>
            <div className="funnel-bar">
              <i style={{ width: Math.max(1.5, (s.v / top) * 100) + '%', background: s.c }} />
            </div>
            <div className="funnel-v mono">{s.v.toLocaleString('en-IN')}</div>
            <div className="funnel-c muted mono">{conv === null ? '' : `${conv}%`}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- filters ---------------- */

const PERIODS = [
  { k: '30', n: 'Last 30 days' },
  { k: '90', n: 'Last 90 days' },
  { k: '180', n: 'Last 6 months' },
  { k: '', n: 'All time' },
];

export function Filters({
  f, set, book,
}: {
  f: RecruitmentFilter;
  set: (next: RecruitmentFilter) => void;
  /** The whole book, so choosing a client does not empty the client list. */
  book: JobOrderRow[];
}) {
  const dir = useVisiblePeople();
  const [period, setPeriod] = useState(f.from ? '90' : '');

  /*
   * The choices come from the book rather than a constant, so a filter can
   * never name a client with no orders — an empty result somebody has to
   * discover by trying it.
   */
  const orders = book.map((x) => x.order);
  const clients = uniq(orders.map((r) => r.clientId));
  const locations = sortBy(uniq(orders.map((r) => r.location)), (x) => x);
  const techs = sortBy(uniq(orders.map((r) => r.primaryTech).filter(Boolean)), (x) => x);
  const recruiters = uniq(orders.map((r) => r.recruiterId).filter(Boolean));

  const setPeriodK = (k: string) => {
    setPeriod(k);
    set({ ...f, from: k ? ymd(addDays(TODAY, -Number(k))) : undefined, to: undefined });
  };
  const one = (key: keyof RecruitmentFilter) => (v: string) =>
    set({ ...f, [key]: v || undefined });

  return (
    <div className="toolbar">
      <select className="input sm" value={period} aria-label="Period"
        onChange={(e) => setPeriodK(e.target.value)}>
        {PERIODS.map((p) => <option key={p.k} value={p.k}>{p.n}</option>)}
      </select>

      <select className="input sm" value={f.clientId ?? ''} aria-label="Client"
        onChange={(e) => one('clientId')(e.target.value)}>
        <option value="">All clients</option>
        {clients.map((id) => <option key={id} value={id}>{clientOf(id).name}</option>)}
      </select>

      <select className="input sm" value={f.recruiterId ?? ''} aria-label="Recruiter"
        onChange={(e) => one('recruiterId')(e.target.value)}>
        <option value="">All recruiters</option>
        {recruiters.map((id) => <option key={id} value={id}>{dir.name(id)}</option>)}
      </select>

      <select className="input sm" value={f.industry ?? ''} aria-label="Industry"
        onChange={(e) => one('industry')(e.target.value)}>
        <option value="">All industries</option>
        {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
      </select>

      <select className="input sm" value={f.tech ?? ''} aria-label="Technology"
        onChange={(e) => one('tech')(e.target.value)}>
        <option value="">All technologies</option>
        {(techs.length ? techs : SKILLS).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <select className="input sm" value={f.location ?? ''} aria-label="Location"
        onChange={(e) => one('location')(e.target.value)}>
        <option value="">All locations</option>
        {locations.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>

      <div className="spacer" />
      {Object.values(f).some(Boolean) && (
        <button className="btn sm" onClick={() => { setPeriod(''); set({}); }}>Clear filters</button>
      )}
    </div>
  );
}

/* ---------------- a table of orders ---------------- */

export function OrderTable({ rows, empty }: { rows: JobOrderRow[]; empty: string }) {
  const dir = useVisiblePeople();
  if (!rows.length) return <EmptyState icon={<Icon n="goal" size="lg" />} msg={empty} />;

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Job order</th><th>Priority</th>
            <th className="num">Positions</th><th className="num">Subs</th>
            <th className="num">Days open</th><th>Target fill</th>
            <th>Recruiter</th><th>Rates</th><th className="right">SLA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ order: r, sla, counts }) => (
            <tr key={r.id}>
              <td>
                <Link to={`/recruitment?v=job&id=${r.id}`} className="jo-link">
                  <span className="mono muted" style={{ fontSize: 11 }}>{jobNo(r)}</span>
                  <div className="jo-t">{r.title}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {clientOf(r.clientId).name} · {r.location} · {r.jobType} · {r.employmentType}
                  </div>
                </Link>
              </td>
              <td><PriorityBadge p={r.priority} /></td>
              <td className="num">{r.filled} / {r.positions}</td>
              <td className="num">{counts.submissions}</td>
              <td className="num"><Aging sla={sla} /></td>
              <td className="nowrap">{fmtD(r.targetFillOn)}</td>
              <td className="nowrap">{r.recruiterId ? dir.name(r.recruiterId) : <span className="muted">Unassigned</span>}</td>
              <td><Commercials r={r} /></td>
              <td className="right"><SlaBadge sla={sla} detail /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- the page ---------------- */

export function RecruitmentDashboard() {
  const [f, setF] = useState<RecruitmentFilter>({ from: ymd(addDays(TODAY, -90)) });

  const { data: kpi } = useRecruitmentKpi(f);
  const { data: funnel } = useFunnel(f);
  const { data: rows = [] } = useJobOrders(f);
  const { data: book = [] } = useJobOrders({});

  const steps: Step[] = useMemo(() => (funnel ? [
    { k: 'Open requirements', v: funnel.openRequirements, c: 'var(--brand)' },
    { k: 'Candidates sourced', v: funnel.sourced, c: 'var(--s1)' },
    { k: 'Candidates screened', v: funnel.screened, c: 'var(--s7)' },
    { k: 'Candidates submitted', v: funnel.submitted, c: 'var(--s4)' },
    { k: 'Client review', v: funnel.clientReview, c: 'var(--s2)' },
    { k: 'Interview', v: funnel.interview, c: 'var(--s5)' },
    { k: 'Offer', v: funnel.offer, c: 'var(--s6)' },
    { k: 'Hired', v: funnel.hired, c: 'var(--good)' },
  ] : []), [funnel]);

  const open = rows.filter((x) => x.order.status === 'Open');
  const weekOut = ymd(addDays(TODAY, 7));
  const closingSoon = sortBy(
    open.filter((x) => x.order.targetFillOn >= ymd(TODAY) && x.order.targetFillOn <= weekOut),
    (x) => x.order.targetFillOn);
  const late = sortBy(open.filter((x) => x.sla.state === 'Overdue'), (x) => -x.sla.aging);

  /* Where the demand actually is. */
  const byClient = sortBy(
    uniq(open.map((x) => x.order.clientId)).map((id) => ({
      k: clientOf(id).name,
      v: open.filter((x) => x.order.clientId === id).length,
      c: 'var(--brand)',
    })),
    (x) => -x.v,
  ).slice(0, 8);

  return (
    <div className="stack">
      <Filters f={f} set={setF} book={book} />

      <StatRow cols={4}>
        <Tile icon={<Icon n="goal" size="lg" />} label="Open jobs" value={kpi?.openJobs ?? '—'}
          foot="Currently taking submissions" />
        <Tile icon={<Icon n="person" size="lg" />} label="Jobs assigned" value={kpi?.assignedJobs ?? '—'}
          foot={kpi ? `${kpi.openJobs - kpi.assignedJobs} with nobody on the desk` : ''} />
        <Tile icon={<Icon n="submission" size="lg" />} label="Total submissions" value={kpi?.submissions ?? '—'}
          foot="Profiles put to clients" />
        <Tile icon={<Icon n="schedule" size="lg" />} label="Interviews" value={kpi?.interviews ?? '—'}
          foot="Scheduled with the client" />
      </StatRow>

      <StatRow cols={4}>
        <Tile icon={<Icon n="send" size="lg" />} label="Offers" value={kpi?.offers ?? '—'} foot="Released to candidates" />
        <Tile icon={<Icon n="done" size="lg" />} label="Hires" value={kpi?.hires ?? '—'}
          foot={kpi && kpi.submissions
            ? `${pct(kpi.hires, kpi.submissions)}% of submissions`
            : 'Successful placements'} />
        <Tile icon={<Icon n="hourglass" size="lg" />} label="Jobs closing soon" value={kpi?.closingSoon ?? '—'}
          foot="Fill target inside a week" />
        <Tile icon={<Icon n="warn" size="lg" />} label="Aging jobs" value={kpi?.aging ?? '—'}
          foot="Past a target and still open" />
      </StatRow>

      <div className="grid g-2-1">
        <Card title="Recruitment funnel"
          sub="Each stage counts what reached it or went further">
          {steps.length ? <Funnel steps={steps} /> : <EmptyState msg="Nothing in this period" />}
        </Card>

        <Card title="Open demand by client" sub={`${open.length} open orders`}>
          {byClient.length
            ? <HBar rows={byClient} />
            : <EmptyState msg="No open orders match this filter" />}
        </Card>
      </div>

      <Card title="Closing soon" sub="Fill target inside the next seven days" flush>
        <OrderTable rows={closingSoon} empty="Nothing is due inside the week ✓" />
      </Card>

      <Card title="Aging jobs" sub="Open past a target — the badge names which one" flush>
        <OrderTable rows={late} empty="Nothing is past its target ✓" />
      </Card>
    </div>
  );
}
