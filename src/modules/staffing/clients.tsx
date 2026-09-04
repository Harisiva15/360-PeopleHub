import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { daysBetween, fmtD, fmtDS, MON, monthKey, parseYmd, TODAY, ymd } from '../../lib/dates';
import { clamp, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { COUNTRIES, countryOf, mb, mbS, money, sumBase, toBase } from '../../data/countries';
import { clientOf } from '../../data/staffing';
import type { Placement } from '../../services';
import {
  useClients, useInvoices, useKpi, usePlacements, useRateCards, useSows, useVisiblePeople,
} from './data';
import { Badge, Banner, Card, EmptyState, Tabs, Tile } from '../../components/ui';
import { StatusBadge } from '../../components/common';
import { BarChart, Donut, HBar, PAL } from '../../components/charts';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { monthlyUnits, Rate, TierBadge } from './shared';

/** Active placements are the ones that carry revenue. */
const LIVE = ['Active', 'Ending Soon'];

/** Monthly billed value for one client, over placements already fetched. */
const monthlyRevenue = (clientId: string, placements: Placement[]) =>
  sum(
    placements.filter((p) => p.clientId === clientId && LIVE.includes(p.status)),
    (p) => toBase(p.billRate * monthlyUnits(p.unit), p.ccy),
  );

/* ---------------- Clients ---------------- */

function ClList() {
  const { data: k } = useKpi();
  const { data: CLIENTS = [] } = useClients();
  const { data: PLACEMENTS = [] } = usePlacements();
  const owners = useVisiblePeople();
  if (!k) return <EmptyState msg="Loading the staffing book…" icon="◷" />;
  const act = CLIENTS.filter((c) => c.status === 'Active');
  const byCountry = COUNTRIES.map((c, i) => ({ k: c.name, c: PAL[i], v: CLIENTS.filter((x) => x.country === c.id).length })).filter((r) => r.v);
  const rev = CLIENTS.map((c) => ({ k: c.name, c: 'var(--s1)', v: monthlyRevenue(c.id, PLACEMENTS) })).filter((r) => r.v);
  const largest = Math.max(...rev.map((r) => r.v), 0);

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn" onClick={() =>
          downloadCSV('clients.csv',
            [['ID', 'Name', 'Country', 'Industry', 'Tier', 'Payment terms', 'Since', 'MSA expiry', 'Owner', 'Status']].concat(
              CLIENTS.map((c) => [c.id, c.name, c.country, c.industry, c.tier, String(c.paymentTerms),
                c.since, c.msaExpiry, owners.name(c.ownerId), c.status]),
            ))}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Active clients" value={act.length} foot={`${CLIENTS.filter((c) => c.status === 'Prospect').length} in pipeline`} />
        <Tile label="Monthly revenue" value={mbS(k.revenueMonthly)} foot="Run rate from active placements" />
        <Tile label="Gross margin" value={k.grossMargin + '%'} foot="Blended across all placements" />
        <Tile label="Concentration risk" value={pct(largest, Math.max(1, sum(rev, (r) => r.v))) + '%'} foot="Largest client share of revenue" />
        <Tile label="MSAs expiring"
          value={CLIENTS.filter((c) => daysBetween(ymd(TODAY), c.msaExpiry) < 180 && c.msaExpiry > ymd(TODAY)).length}
          foot="Within 180 days" />
      </div>

      <Card title="Client portfolio" sub={`${CLIENTS.length} accounts`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th><th>Country</th><th>Industry</th><th>Tier</th><th className="num">Placements</th>
                <th className="num">Monthly revenue</th><th className="num">Margin</th><th>Account owner</th>
                <th>MSA expiry</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(CLIENTS, (c) => -PLACEMENTS.filter((p) => p.clientId === c.id).length).map((c) => {
                const pls = PLACEMENTS.filter((p) => p.clientId === c.id && LIVE.includes(p.status));
                const r = sum(pls, (p) => p.billRate * monthlyUnits(p.unit));
                const co = sum(pls, (p) => p.payRate * monthlyUnits(p.unit));
                const renewSoon = daysBetween(ymd(TODAY), c.msaExpiry) < 180;
                return (
                  <tr key={c.id}>
                    <td>
                      <b>{c.name}</b>{c.riskFlag && <> <Badge kind="crit">At risk</Badge></>}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {c.id} · since {parseYmd(c.since).getFullYear()}{c.vms ? ` · ${c.vms}` : ''}
                      </div>
                    </td>
                    <td className="nowrap">{countryOf(c.country).flag} {c.country}</td>
                    <td className="nowrap">{c.industry.split(' & ')[0]}</td>
                    <td><TierBadge tier={c.tier} /></td>
                    <td className="num">{pls.length}</td>
                    <td className="num strong">{r ? money(r, c.ccy) : '—'}</td>
                    <td className="num">{r ? (((r - co) / r) * 100).toFixed(1) + '%' : '—'}</td>
                    <td className="nowrap">{owners.name(c.ownerId)}</td>
                    <td className="nowrap">
                      {fmtD(c.msaExpiry)}{renewSoon && <> <Badge kind="warn">Renew</Badge></>}
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Revenue by client" sub="Monthly run rate, ₹ base">
          <HBar rows={sortBy(rev, (r) => -r.v).slice(0, 10)} fmt={(v) => mbS(v)} />
        </Card>
        <Card title="Clients by geography" sub={`${CLIENTS.length} accounts`}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Donut size={150} center={CLIENTS.length} centerSub="clients" slices={byCountry} />
            <div style={{ flex: 1, minWidth: 140 }}>
              <div className="legend" style={{ flexDirection: 'column', gap: 6 }}>
                {byCountry.map((i) => (
                  <span key={i.k}><i style={{ background: i.c }} />{i.k} <b className="mono">{i.v}</b></span>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- SOWs ---------------- */

function ClSow() {
  const { data: SOWS = [] } = useSows();
  const { data: PLACEMENTS = [] } = usePlacements();
  const list = sortBy(SOWS, (s) => s.end);
  const activeSows = SOWS.filter((s) => s.status === 'Active');

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Active SOWs" value={activeSows.length} foot={`${SOWS.length} total contracts`} />
        <Tile label="Contract value"
          value={mbS(sumBase(SOWS.filter((s) => s.status !== 'Expired').map((s) => ({ ccy: s.ccy, v: s.value })), (x) => x.v))}
          foot="Signed and in force" />
        <Tile label="Renewal due" value={SOWS.filter((s) => s.status === 'Renewal Due').length} foot="Ending within 60 days" />
        <Tile label="Avg burn"
          value={Math.round(sum(activeSows, (s) => pct(s.burned, s.value)) / Math.max(1, activeSows.length)) + '%'}
          foot="Value consumed against contract" />
      </div>

      <Card title="Statements of work" sub={`${SOWS.length} contracts`} flush
        actions={<button className="btn sm" onClick={() =>
          downloadCSV('sows.csv',
            [['ID', 'Title', 'Client', 'Type', 'Start', 'End', 'Value', 'Burned', 'Headcount', 'Filled', 'PO', 'Status']].concat(
              SOWS.map((s) => [s.id, s.title, clientOf(s.clientId).name, s.type, s.start, s.end,
                String(s.value), String(s.burned), String(s.headcount), String(s.filled), s.po, s.status]),
            ))}>⤓ Export</button>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>SOW</th><th>Client</th><th>Type</th><th>Period</th><th className="num">Value</th>
                <th style={{ minWidth: 130 }}>Burn</th><th className="num">Headcount</th><th>PO</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const c = clientOf(s.clientId);
                const filled = PLACEMENTS.filter((p) => p.sowId === s.id && LIVE.includes(p.status)).length;
                const burn = pct(s.burned, s.value);
                return (
                  <tr key={s.id}>
                    <td><b>{s.title}</b><div className="muted" style={{ fontSize: 11 }}>{s.id}</div></td>
                    <td className="nowrap">{c.name}</td>
                    <td className="nowrap">{s.type}</td>
                    <td className="nowrap">{fmtDS(s.start)} – {fmtD(s.end)}</td>
                    <td className="num">{money(s.value, s.ccy)}</td>
                    <td>
                      <div className="row" style={{ gap: 7 }}>
                        <div className="bar" style={{ flex: 1 }}>
                          <i style={{ width: clamp(burn, 0, 100) + '%', background: burn > 90 ? 'var(--crit)' : burn > 70 ? 'var(--warn)' : 'var(--brand)' }} />
                        </div>
                        <span className="mono" style={{ fontSize: 11 }}>{burn}%</span>
                      </div>
                    </td>
                    <td className="num">{filled} / {s.headcount}</td>
                    <td className="mono muted">{s.po}</td>
                    <td>
                      <Badge kind={s.status === 'Active' ? 'good' : s.status === 'Renewal Due' ? 'warn' : 'mute'}>{s.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Banner kind="info" icon="📄" title="Renewal governance">
        SOWs move to <b>Renewal Due</b> 60 days before expiry. The account owner and delivery head are notified at 90, 60
        and 30 days. Placements linked to an expired SOW are blocked from timesheet submission until a new SOW or
        amendment is attached.
      </Banner>
    </div>
  );
}

/* ---------------- Rate cards ---------------- */

function ClRates() {
  const { data: RATE_CARDS = [] } = useRateCards();
  const { data: CLIENTS = [] } = useClients();
  const { data: PLACEMENTS = [] } = usePlacements();
  const [cid, setCid] = useState(CLIENTS[0].id);
  const c = clientOf(cid);
  const cards = RATE_CARDS.filter((r) => r.clientId === cid);

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto', maxWidth: 320 }} value={cid} onChange={(e) => setCid(e.target.value)}>
          {CLIENTS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <TierBadge tier={c.tier} />
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          Minimum margin {cards[0].minMargin}% · effective {fmtD(cards[0].effective)}
        </span>
      </div>

      <Card title={'Rate card — ' + c.name} sub={`${cards.length} roles · ${c.ccy} ${cards[0].unit}`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Role</th><th className="num">Bill rate</th><th className="num">Max pay rate at floor</th>
                <th className="num">Min margin</th><th className="num">Placements</th><th className="num">Actual avg margin</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((r) => {
                const pls = PLACEMENTS.filter((p) => p.clientId === cid && p.role === r.role);
                const avg = pls.length ? sum(pls, (p) => p.margin) / pls.length : null;
                /* the highest pay rate that still clears the client's margin floor */
                const maxPay = Math.round(r.billRate * (1 - r.minMargin / 100));
                return (
                  <tr key={r.id}>
                    <td><b>{r.role}</b></td>
                    <td className="num strong"><Rate v={r.billRate} ccy={r.ccy} unit={r.unit} /></td>
                    <td className="num">{money(maxPay, r.ccy)}</td>
                    <td className="num">{r.minMargin}%</td>
                    <td className="num">{pls.length || '—'}</td>
                    <td className="num">
                      {avg != null
                        ? <b style={{ color: avg < r.minMargin ? 'var(--crit)' : 'var(--good-text)' }}>{avg.toFixed(1)}%</b>
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Banner kind="warn" icon="⚠️" title="Margin floor enforcement">
        A submission priced below the client margin floor cannot be sent without an explicit approval from the delivery
        head. Every override is recorded against the placement and reported in the margin exception report.
      </Banner>
    </div>
  );
}

/* ---------------- Revenue & margin ---------------- */

function ClRev() {
  const { data: CLIENTS = [] } = useClients();
  const { data: PLACEMENTS = [] } = usePlacements();
  const { data: INVOICES = [] } = useInvoices();
  const { data: k } = useKpi();
  if (!k) return <EmptyState msg="Loading the staffing book…" icon="◷" />;
  const months: { k: string; l: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    months.push({ k: monthKey(d), l: MON[d.getMonth()] });
  }
  const revS = months.map((m) => sum(INVOICES.filter((i) => i.period === m.k), (i) => toBase(i.amount, i.ccy)));

  const byInd = uniq(CLIENTS.map((c) => c.industry)).map((ind, i) => ({
    k: ind, c: PAL[i % 8],
    v: sum(
      PLACEMENTS.filter((p) => clientOf(p.clientId).industry === ind && LIVE.includes(p.status)),
      (p) => toBase(p.billRate * monthlyUnits(p.unit), p.ccy),
    ),
  })).filter((r) => r.v);

  const marginByClient = CLIENTS.map((c) => {
    const pls = PLACEMENTS.filter((p) => p.clientId === c.id && LIVE.includes(p.status));
    const r = sum(pls, (p) => p.billRate);
    const co = sum(pls, (p) => p.payRate);
    return { k: c.name, c: 'var(--s3)', v: r ? +(((r - co) / r) * 100).toFixed(1) : 0 };
  }).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Monthly revenue" value={mbS(k.revenueMonthly)} foot={`From ${k.placements} active placements`} />
        <Tile label="Monthly delivery cost" value={mbS(k.costMonthly)} foot="Consultant pay and vendor cost" />
        <Tile label="Gross margin" value={k.grossMargin + '%'} foot="Target 28%" />
        <Tile label="Revenue per consultant" value={mbS(k.revenueMonthly / Math.max(1, k.placements))} foot="Monthly average" />
      </div>

      <Card title="Invoiced revenue" sub="Last 6 months · ₹ base">
        <BarChart labels={months.map((m) => m.l)} height={220} padLeft={58}
          fmt={(v) => mb(v)} tickFmt={(v) => mbS(v)}
          series={[{ name: 'Invoiced', color: 'var(--s1)', data: revS }]} />
      </Card>

      <div className="grid g2">
        <Card title="Revenue by industry" sub="Monthly run rate">
          <HBar rows={sortBy(byInd, (r) => -r.v)} fmt={(v) => mbS(v)} />
        </Card>
        <Card title="Gross margin by client" sub="Active placements">
          <HBar rows={sortBy(marginByClient, (r) => -r.v)} fmt={(v) => v + '%'} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'list' | 'sow' | 'rates' | 'rev';

const TABS: { v: Tab; label: string }[] = [
  { v: 'list', label: 'Clients' }, { v: 'sow', label: 'SOW & Contracts' },
  { v: 'rates', label: 'Rate Cards' }, { v: 'rev', label: 'Revenue & Margin' },
];

function Clients() {
  const [tab, setTab] = useState<Tab>('list');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'list' && <ClList />}
      {tab === 'sow' && <ClSow />}
      {tab === 'rates' && <ClRates />}
      {tab === 'rev' && <ClRev />}
    </>
  );
}

registerModule({
  key: 'clients',
  title: TITLES.clients,
  Component: Clients,
});
