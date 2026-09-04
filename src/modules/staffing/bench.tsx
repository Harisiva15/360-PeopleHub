import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { daysBetween, fmtD, fmtDS, MON, monthKey, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { countryOf, mb, mbS, money, toBase } from '../../data/countries';
import {
  CONSULTANTS, PLACEMENTS, benchCost, benchDays, benchList, clientOf, conOf, staffingKPI, vendorOf,
} from '../../data/staffing';
import type { Consultant } from '../../data/staffing';
import { Avatar, Badge, Card, EmptyState, Tabs, Tile } from '../../components/ui';
import { Chip, Divide } from '../../components/common';
import { BarChart, HBar, Legend, LineChart, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { monthlyUnits } from './shared';

/** Bench ageing bands — the colour escalates the longer someone sits idle. */
const BANDS: { k: string; c: string; lo: number; hi: number }[] = [
  { k: '0–14 days', c: 'var(--s6)', lo: 0, hi: 15 },
  { k: '15–29 days', c: 'var(--s3)', lo: 15, hi: 30 },
  { k: '30–59 days', c: 'var(--s4)', lo: 30, hi: 60 },
  { k: '60–89 days', c: 'var(--s2)', lo: 60, hi: 90 },
  { k: '90+ days', c: 'var(--s8)', lo: 90, hi: Infinity },
];

const bandOf = (d: number) => BANDS.find((b) => d >= b.lo && d < b.hi) || BANDS[BANDS.length - 1];

const supplierOf = (c: Consultant) => (c.external ? vendorOf(c.vendorId || '')?.name || 'Vendor' : 'In-house');

/* ---------------- Bench ---------------- */

function BnBench() {
  const app = useApp();
  const list = sortBy(benchList(), (c) => -benchDays(c));
  const k = staffingKPI();

  const bands = BANDS.map((b) => ({ k: b.k, c: b.c, v: list.filter((c) => bandOf(benchDays(c)).k === b.k).length }));
  const bySkill = uniq(list.flatMap((c) => c.skills))
    .map((s, i) => ({ k: s, c: PAL[i % 8], v: list.filter((c) => c.skills.includes(s)).length }))
    .filter((r) => r.v > 1);

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="On bench" value={list.length} foot={pct(list.length, Math.max(1, CONSULTANTS.length)) + '% of the consultant pool'} />
        <Tile label="Monthly bench cost" value={mbS(k.benchCostMonthly)} foot="Unrecovered delivery cost" />
        <Tile label="Average bench age" value={k.avgBenchDays + ' days'} foot="Target under 30 days" />
        <Tile label="Over 60 days" value={list.filter((c) => benchDays(c) >= 60).length} foot="Escalate for redeployment or exit" />
        <Tile label="Utilisation" value={k.utilisation + '%'} foot="Placed against total pool" />
      </div>

      <Card title="Bench register" sub={`${list.length} consultants available`} flush
        actions={
          <div className="row">
            <button className="btn sm" onClick={() => app.toast('AI matching runs from the Copilot module')}>✨ AI match to open roles</button>
            <button className="btn sm" onClick={() =>
              downloadCSV('bench.csv',
                [['ID', 'Name', 'Role', 'Skills', 'Country', 'Work auth', 'Bench since', 'Bench days', 'Cost to date', 'Redeployment']].concat(
                  list.map((c) => [c.id, c.name, c.role, c.skills.join(' / '), c.country, c.workAuth,
                    c.benchSince || '', String(benchDays(c)), String(benchCost(c)), c.redeployment || '']),
                ))}>⤓</button>
          </div>
        }>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Consultant</th><th>Role</th><th>Skills</th><th>Location</th><th>Work authorisation</th>
                <th className="num">Bench days</th><th className="num">Cost to date</th><th>Redeployment</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const d = benchDays(c);
                const b = bandOf(d);
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="person">
                        <Avatar name={c.name} size="sm" />
                        <div>
                          <div className="nm">{c.name}</div>
                          <div className="mt">{c.engagement}{c.external ? ' · ' + supplierOf(c) : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="nowrap">{c.role}</td>
                    <td>{c.skills.slice(0, 3).map((s) => <Chip key={s}>{s}</Chip>)}</td>
                    <td className="nowrap">{countryOf(c.country).flag} {countryOf(c.country).short}</td>
                    <td className="nowrap">{c.workAuth}</td>
                    <td className="num">
                      <span className="badge" style={{
                        background: `color-mix(in srgb, ${b.c} 16%, transparent)`,
                        color: b.c,
                        borderColor: `color-mix(in srgb, ${b.c} 34%, transparent)`,
                      }}>{d}d</span>
                    </td>
                    <td className="num">{money(benchCost(c), c.ccy)}</td>
                    <td className="nowrap muted">{c.redeployment || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Bench ageing" sub="Days since coming off a project"><HBar rows={bands} /></Card>
        <Card title="Available skills" sub="What we can market right now">
          {bySkill.length ? <HBar rows={sortBy(bySkill, (r) => -r.v).slice(0, 10)} /> : <EmptyState msg="No overlapping skills" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- All consultants ---------------- */

function BnAll() {
  const [f, setF] = useState('');
  const list = f ? CONSULTANTS.filter((c) => c.status === f) : CONSULTANTS;

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={f} onChange={(e) => setF(e.target.value)}>
          <option value="">All consultants</option>
          {['Placed', 'Bench', 'Internal'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {CONSULTANTS.filter((c) => c.external).length} vendor consultants · {CONSULTANTS.filter((c) => !c.external).length} on our payroll
        </span>
      </div>

      <div className="grid g4">
        <Tile label="Total consultants" value={CONSULTANTS.length} foot="Internal and vendor supplied" />
        <Tile label="Placed" value={CONSULTANTS.filter((c) => c.status === 'Placed').length} foot="Billing to a client" />
        <Tile label="On bench" value={CONSULTANTS.filter((c) => c.status === 'Bench').length} foot="Available for deployment" />
        <Tile label="Internal projects" value={CONSULTANTS.filter((c) => c.status === 'Internal').length} foot="Non-billable assignment" />
      </div>

      <Card title="Consultant register" sub={`${list.length} records`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 600, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Consultant</th><th>Role</th><th className="num">Experience</th><th>Engagement</th>
                <th>Supplier</th><th>Work authorisation</th><th className="num">Cost / day</th><th>Status</th><th>Client</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(list, (c) => c.name).map((c) => {
                const p = PLACEMENTS.find((x) => x.consultantId === c.id && ['Active', 'Ending Soon', 'Starting'].includes(x.status));
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="person">
                        <Avatar name={c.name} size="sm" />
                        <div><div className="nm">{c.name}</div><div className="mt">{c.id}</div></div>
                      </div>
                    </td>
                    <td className="nowrap">{c.role}</td>
                    <td className="num">{c.exp} yrs</td>
                    <td>{c.engagement}</td>
                    <td className="nowrap">
                      {c.external ? supplierOf(c) : <Badge kind="good">In-house</Badge>}
                    </td>
                    <td className="nowrap">{c.workAuth}</td>
                    <td className="num">{money(c.costPerDay, c.ccy)}</td>
                    <td>
                      <Badge kind={c.status === 'Placed' ? 'good' : c.status === 'Bench' ? 'warn' : 'mute'}>{c.status}</Badge>
                    </td>
                    <td className="nowrap">{p ? clientOf(p.clientId).name : '—'}</td>
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

/* ---------------- Bench cost & forecast ---------------- */

function BnForecast() {
  const list = benchList();
  const k = staffingKPI();

  const months: { k: string; l: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + i, 1);
    months.push({ k: monthKey(d), l: MON[d.getMonth()] });
  }

  /* people roll off as placements end; open positions absorb them evenly over the window */
  const rollOff = months.map((m) => PLACEMENTS.filter((p) => p.end.slice(0, 7) === m.k && p.status !== 'Completed').length);
  const absorbPerMonth = Math.round(k.openPositions / 6);
  const projBench: number[] = [];
  let running = list.length;
  months.forEach((_, i) => {
    running = Math.max(0, running + rollOff[i] - absorbPerMonth);
    projBench.push(running);
  });
  const perHeadCost = k.benchCostMonthly / Math.max(1, list.length);
  const cost = projBench.map((n) => Math.round(n * perHeadCost));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Bench cost this month" value={mbS(k.benchCostMonthly)} foot={`${list.length} consultants unassigned`} />
        <Tile label="Cost to date" value={mbS(sum(list, (c) => toBase(benchCost(c), c.ccy)))} foot="Cumulative for the current bench" />
        <Tile label="Break-even days" value="30 days" foot="Average recovery time once placed" />
        <Tile label="6-month projection" value={mbS(sum(cost))} foot="If placement rate holds" />
      </div>

      <Card title="Bench projection" sub="Next 6 months · headcount and cost">
        <LineChart labels={months.map((m) => m.l)} height={220} area
          series={[{ name: 'Projected bench headcount', color: 'var(--s2)', data: projBench }]} />
        <Divide />
        <BarChart labels={months.map((m) => m.l)} height={190} padLeft={58}
          fmt={(v) => mb(v)} tickFmt={(v) => mbS(v)}
          series={[{ name: 'Projected bench cost', color: 'var(--s8)', data: cost }]} />
        <Legend items={[
          { k: 'Projected bench headcount', c: 'var(--s2)' },
          { k: 'Projected bench cost (₹ base)', c: 'var(--s8)' },
        ]} />
      </Card>

      <Card title="Roll-off schedule" sub="Placements ending — redeployment runway" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Consultant</th><th>Client</th><th>Role</th><th>End date</th><th className="num">Days left</th><th className="num">Monthly revenue at risk</th><th>Status</th></tr>
            </thead>
            <tbody>
              {sortBy(PLACEMENTS.filter((p) => ['Active', 'Ending Soon'].includes(p.status)), (p) => p.end).slice(0, 15).map((p) => {
                const c = conOf(p.consultantId);
                const left = daysBetween(ymd(TODAY), p.end);
                return (
                  <tr key={p.id}>
                    <td>
                      {c ? (
                        <div className="person">
                          <Avatar name={c.name} size="sm" />
                          <div><div className="nm">{c.name}</div><div className="mt">{c.role}</div></div>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="nowrap">{clientOf(p.clientId).name}</td>
                    <td className="nowrap">{p.role}</td>
                    <td className="nowrap">{fmtD(p.end)}</td>
                    <td className="num" style={left < 45 ? { color: 'var(--crit)', fontWeight: 700 } : undefined}>{left}</td>
                    <td className="num">{money(p.billRate * monthlyUnits(p.unit), p.ccy)}</td>
                    <td>
                      <Badge kind={p.status === 'Ending Soon' ? 'warn' : 'good'}>{p.status}</Badge>
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

/* ---------------- entry ---------------- */

type Tab = 'bench' | 'all' | 'fc';

const TABS: { v: Tab; label: string }[] = [
  { v: 'bench', label: 'Bench' }, { v: 'all', label: 'All Consultants' }, { v: 'fc', label: 'Bench Cost & Forecast' },
];

function Bench() {
  const [tab, setTab] = useState<Tab>('bench');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'bench' && <BnBench />}
      {tab === 'all' && <BnAll />}
      {tab === 'fc' && <BnForecast />}
    </>
  );
}

registerModule({
  key: 'bench',
  title: TITLES.bench,
  subtitle: () => `${benchList().length} on bench · ${staffingKPI().utilisation}% utilisation`,
  badge: () => benchList().length,
  Component: Bench,
});

/* ============================================================
   Placements
   ============================================================ */

const MARGIN_BANDS: [string, number, number, string][] = [
  ['Below floor (<20%)', 0, 20, 'var(--s8)'],
  ['20–25%', 20, 25, 'var(--s4)'],
  ['25–30%', 25, 30, 'var(--s3)'],
  ['30%+', 30, Infinity, 'var(--s6)'],
];

function Placements() {
  const list = sortBy(PLACEMENTS, (p) => p.start, 'desc');
  const k = staffingKPI();
  const byClient = clientPlacementCounts();
  const marginBands = MARGIN_BANDS.map(([label, lo, hi, c]) => ({
    k: label, c, v: PLACEMENTS.filter((p) => p.margin >= lo && p.margin < hi).length,
  }));

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="Active placements" value={k.placements} foot={`${PLACEMENTS.filter((p) => p.status === 'Starting').length} starting soon`} />
        <Tile label="Monthly revenue" value={mbS(k.revenueMonthly)} foot="Billed through placements" />
        <Tile label="Gross margin" value={k.grossMargin + '%'} foot="Blended, target 28%" />
        <Tile label="Ending in 60 days"
          value={PLACEMENTS.filter((p) => ['Active', 'Ending Soon'].includes(p.status) && daysBetween(ymd(TODAY), p.end) <= 60).length}
          foot="Extension conversations due" />
        <Tile label="Below margin floor" value={PLACEMENTS.filter((p) => p.margin < 20).length} foot="Requires delivery-head approval" />
      </div>

      <Card title="Placements" sub={`${list.length} records`} flush
        actions={<button className="btn sm" onClick={() =>
          downloadCSV('placements.csv',
            [['ID', 'Consultant', 'Client', 'Role', 'Location', 'Start', 'End', 'Bill', 'Pay', 'Margin %', 'TS compliance', 'PO', 'Status']].concat(
              PLACEMENTS.map((p) => [p.id, conOf(p.consultantId)?.name || '', clientOf(p.clientId).name, p.role,
                p.location, p.start, p.end, String(p.billRate), String(p.payRate), String(p.margin),
                String(p.tsCompliance), p.poNumber, p.status]),
            ))}>⤓ Export</button>}>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Consultant</th><th>Client</th><th>Role</th><th>Period</th><th className="num">Bill</th>
                <th className="num">Pay</th><th className="num">Margin</th><th className="num">TS compliance</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const c = conOf(p.consultantId);
                return (
                  <tr key={p.id}>
                    <td>
                      {c ? (
                        <div className="person">
                          <Avatar name={c.name} size="sm" />
                          <div><div className="nm">{c.name}</div><div className="mt">{c.engagement}</div></div>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="nowrap">{clientOf(p.clientId).name}</td>
                    <td className="nowrap">{p.role}</td>
                    <td className="nowrap">
                      {fmtDS(p.start)} – {fmtD(p.end)}
                      {p.extensions > 0 && <> <Badge kind="info">+{p.extensions}</Badge></>}
                    </td>
                    <td className="num">{money(p.billRate, p.ccy)}</td>
                    <td className="num">{money(p.payRate, p.ccy)}</td>
                    <td className="num">
                      <b style={{ color: p.margin < 20 ? 'var(--crit)' : p.margin < 25 ? 'var(--warn)' : 'var(--good-text)' }}>
                        {p.margin}%
                      </b>
                    </td>
                    <td className="num">{p.tsCompliance}%</td>
                    <td>
                      <Badge kind={p.status === 'Ending Soon' ? 'warn' : p.status === 'Starting' ? 'info' : p.status === 'Active' ? 'good' : 'mute'}>
                        {p.status}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Active placements by client" sub="Delivery concentration">
          <HBar rows={sortBy(byClient, (r) => -r.v)} />
        </Card>
        <Card title="Margin distribution" sub="All placements">
          <HBar rows={marginBands} />
          <Divide />
          <div className="muted" style={{ fontSize: 12 }}>
            Placements below the client margin floor need documented approval. Review these at the weekly delivery call.
          </div>
        </Card>
      </div>
    </div>
  );
}

function clientPlacementCounts() {
  return sortBy(
    CONSULTANTS.length
      ? uniq(PLACEMENTS.map((p) => p.clientId)).map((id) => ({
          k: clientOf(id).name, c: 'var(--s1)',
          v: PLACEMENTS.filter((p) => p.clientId === id && ['Active', 'Ending Soon'].includes(p.status)).length,
        }))
      : [],
    (r) => -r.v,
  ).filter((r) => r.v);
}

registerModule({
  key: 'placements',
  title: TITLES.placements,
  subtitle: () => `${PLACEMENTS.filter((p) => p.status === 'Active').length} active assignments · ${staffingKPI().grossMargin}% blended margin`,
  Component: Placements,
});
