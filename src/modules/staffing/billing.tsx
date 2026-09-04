import { useState } from 'react';
import { groupBy, sortBy, sum } from '../../lib/collections';
import { addDays, fmtD, monthKey, monthLabel, monthLabelLong, TODAY } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { mbS, money, toBase } from '../../data/countries';
import { clientOf, invAgeing } from '../../data/staffing';
import { useClients, useInvoices, useKpi, usePayRuns, usePlacements, useVisiblePeople } from './data';
import { Badge, Banner, Card, EmptyState, Tabs, Tile } from '../../components/ui';
import { HBar } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { monthlyUnits } from './shared';

const INV_TONE: Record<string, 'good' | 'info' | 'crit' | 'warn' | 'mute'> = {
  Paid: 'good', Sent: 'info', Overdue: 'crit', Disputed: 'warn', Draft: 'mute',
};
const InvBadge = ({ s }: { s: string }) => <Badge kind={INV_TONE[s] || 'mute'}>{s}</Badge>;

/** VAT/GST rate applied by the client's country. */
const TAX_BY_COUNTRY: Record<string, number> = { US: 0, GB: 0.2, CA: 0.13, AE: 0.05, IN: 0.18 };

const OPEN = (s: string) => !['Paid', 'Draft'].includes(s);

/* ---------------- Invoices ---------------- */

function BlInv() {
  const { data: k } = useKpi();
  const { data: INVOICES = [] } = useInvoices();
  const [f, setF] = useState('');
  if (!k) return <EmptyState msg="Loading the staffing book…" icon="◷" />;
  const list = sortBy(f ? INVOICES.filter((i) => i.status === f) : INVOICES, (i) => i.issuedOn, 'desc');

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={f} onChange={(e) => setF(e.target.value)}>
          <option value="">All statuses</option>
          {['Draft', 'Sent', 'Paid', 'Overdue', 'Disputed'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() =>
          downloadCSV('invoices.csv',
            [['ID', 'Client', 'Period', 'Lines', 'Amount', 'Tax', 'Total', 'Currency', 'Issued', 'Due', 'Status', 'Paid on']].concat(
              INVOICES.map((i) => [i.id, clientOf(i.clientId).name, i.period, String(i.lines.length),
                String(i.amount), String(i.tax), String(i.total), i.ccy, i.issuedOn, i.dueOn, i.status, i.paidOn || '']),
            ))}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Invoiced (6 months)" value={mbS(sum(INVOICES, (i) => toBase(i.total, i.ccy)))} foot={`${INVOICES.length} invoices`} />
        <Tile label="Outstanding" value={mbS(k.ar)} foot={`${INVOICES.filter((i) => OPEN(i.status)).length} raised and unpaid`} />
        <Tile label="Overdue" value={mbS(k.arOverdue)} foot={`${INVOICES.filter((i) => i.status === 'Overdue').length} past due date`} />
        <Tile label="Disputed" value={INVOICES.filter((i) => i.status === 'Disputed').length} foot="Blocking collection" />
        <Tile label="DSO" value={k.dso + ' days'} foot="Target 45 days" />
      </div>

      <Card title="Invoices" sub={`${list.length} records`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 600, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Invoice</th><th>Client</th><th>Period</th><th className="num">Lines</th><th className="num">Amount</th>
                <th className="num">Tax</th><th className="num">Total</th><th>Due</th><th className="num">Ageing</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => {
                const age = invAgeing(i);
                return (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td className="nowrap">
                      {clientOf(i.clientId).name}
                      <div className="muted" style={{ fontSize: 11 }}>{i.submittedVia}</div>
                    </td>
                    <td className="nowrap">{monthLabel(i.period)}</td>
                    <td className="num">{i.lines.length}</td>
                    <td className="num">{money(i.amount, i.ccy)}</td>
                    <td className="num">
                      {i.tax ? <>{money(i.tax, i.ccy)} <span className="muted">({i.taxRate * 100}%)</span></> : '—'}
                    </td>
                    <td className="num strong">{money(i.total, i.ccy)}</td>
                    <td className="nowrap">{fmtD(i.dueOn)}</td>
                    <td className="num">
                      {i.status === 'Paid'
                        ? <span className="muted">—</span>
                        : age > 0
                          ? <b style={{ color: 'var(--crit)' }}>{age}d late</b>
                          : <span className="muted">in {-age}d</span>}
                    </td>
                    <td><InvBadge s={i.status} /></td>
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

/* ---------------- AR & ageing ---------------- */

const BUCKETS: [string, number, number][] = [
  ['Not yet due', -9999, 0], ['1–30 days', 1, 30], ['31–60 days', 31, 60],
  ['61–90 days', 61, 90], ['90+ days', 91, 9999],
];

function BlAr() {
  const { data: INVOICES = [] } = useInvoices();
  const { data: CLIENTS = [] } = useClients();
  const owners = useVisiblePeople();
  const app = useApp();
  const open = INVOICES.filter((i) => OPEN(i.status));

  const rows = BUCKETS.map((b, i) => ({
    k: b[0], c: ['var(--s6)', 'var(--s3)', 'var(--s4)', 'var(--s2)', 'var(--s8)'][i],
    v: sum(open.filter((x) => {
      const a = invAgeing(x);
      return a >= b[1] && a <= b[2];
    }), (x) => toBase(x.total, x.ccy)),
  }));

  const byClient = CLIENTS.map((c) => ({
    k: c.name, c: 'var(--s1)',
    v: sum(open.filter((i) => i.clientId === c.id), (i) => toBase(i.total, i.ccy)),
  })).filter((r) => r.v);

  const total = sum(rows, (r) => r.v);
  const overdue = sum(rows.slice(1), (r) => r.v);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Total receivable" value={mbS(total)} foot={`${open.length} open invoices`} />
        <Tile label="Overdue" value={mbS(overdue)} foot={pct(overdue, Math.max(1, total)) + '% of AR'} />
        <Tile label="Beyond 60 days" value={mbS(sum(rows.slice(3), (r) => r.v))} foot="Escalate to the account owner" />
        <Tile label="Collection efficiency"
          value={pct(INVOICES.filter((i) => i.status === 'Paid').length, Math.max(1, INVOICES.length)) + '%'}
          foot="Invoices settled" />
      </div>

      <div className="grid g2">
        <Card title="AR ageing" sub="₹ base"><HBar rows={rows} fmt={(v) => mbS(v)} /></Card>
        <Card title="Receivable by client" sub="Who owes us">
          <HBar rows={sortBy(byClient, (r) => -r.v)} fmt={(v) => mbS(v)} />
        </Card>
      </div>

      <Card title="Collection worklist" sub="Ordered by ageing and value" flush
        actions={<button className="btn sm" onClick={() => app.toast('Chase emails are drafted from the Copilot module')}>✨ Draft chase emails</button>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Invoice</th><th>Client</th><th className="num">Total</th><th>Due</th><th className="num">Days overdue</th><th>Issue</th><th>Owner</th><th className="right">Action</th></tr>
            </thead>
            <tbody>
              {sortBy(open.filter((i) => invAgeing(i) > 0), (i) => -invAgeing(i)).slice(0, 15).map((i) => {
                const c = clientOf(i.clientId);
                return (
                  <tr key={i.id}>
                    <td className="mono">{i.id}</td>
                    <td className="nowrap">{c.name}</td>
                    <td className="num strong">{money(i.total, i.ccy)}</td>
                    <td className="nowrap">{fmtD(i.dueOn)}</td>
                    <td className="num"><b style={{ color: 'var(--crit)' }}>{invAgeing(i)}</b></td>
                    <td>
                      {i.dispute
                        ? <><Badge kind="warn">Disputed</Badge> <span className="muted" style={{ fontSize: 11 }}>{i.dispute}</span></>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="nowrap">{owners.name(c.ownerId)}</td>
                    <td className="right">
                      <button className="btn sm" onClick={() => app.toast('Chase sent to ' + c.contacts[1].n, 'ok')}>Chase</button>
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

/* ---------------- Generate billing ---------------- */

function BlGen() {
  const { data: PLACEMENTS = [] } = usePlacements();
  const { data: PAYRUNS = [] } = usePayRuns();
  const { data: INVOICES = [] } = useInvoices();
  const app = useApp();
  const [mk, setMk] = useState(monthKey(addDays(TODAY, -30)));
  const pls = PLACEMENTS.filter((p) => ['Active', 'Ending Soon', 'Completed'].includes(p.status) && p.start.slice(0, 7) <= mk);
  const byClient = groupBy(pls, (p) => p.clientId);

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={mk} onChange={(e) => setMk(e.target.value)}>
          {PAYRUNS.map((r) => <option key={r.mk} value={r.mk}>{monthLabelLong(r.mk)}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn primary" onClick={() => app.toast(`Draft invoices generated for ${monthLabel(mk)}`, 'ok')}>
          ⚡ Generate invoices for {monthLabel(mk)}
        </button>
      </div>

      <Banner kind="info" icon="🧾" title="How billing is generated">
        Approved client timesheets for the period are matched to the placement rate and the SOW purchase order, tax is
        applied by client country, and a draft invoice is created per client. Invoices for VMS clients are pushed to
        Fieldglass or Beeline instead of being emailed.
      </Banner>

      <Card title={'Billing preview — ' + monthLabelLong(mk)}
        sub={`${Object.keys(byClient).length} clients · ${pls.length} billable placements`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th><th className="num">Consultants</th><th className="num">Units</th>
                <th className="num">Gross value</th><th className="num">Tax</th><th className="num">Invoice total</th>
                <th>Route</th><th>Existing invoice</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(byClient).map((cid) => {
                const c = clientOf(cid);
                const list = byClient[cid];
                const units = sum(list, (p) => monthlyUnits(p.unit));
                const amt = sum(list, (p) => p.billRate * monthlyUnits(p.unit));
                const taxRate = TAX_BY_COUNTRY[c.country];
                const exist = INVOICES.find((i) => i.clientId === cid && i.period === mk);
                return (
                  <tr key={cid}>
                    <td><b>{c.name}</b></td>
                    <td className="num">{list.length}</td>
                    <td className="num">{units}</td>
                    <td className="num">{money(amt, c.ccy)}</td>
                    <td className="num">{money(amt * taxRate, c.ccy)}</td>
                    <td className="num strong">{money(amt * (1 + taxRate), c.ccy)}</td>
                    <td>{c.vms ? <Badge kind="info">{c.vms}</Badge> : <Badge>Email / AP portal</Badge>}</td>
                    <td>{exist ? <InvBadge s={exist.status} /> : <span className="muted">Not generated</span>}</td>
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

type Tab = 'inv' | 'ar' | 'gen';

const TABS: { v: Tab; label: string }[] = [
  { v: 'inv', label: 'Invoices' }, { v: 'ar', label: 'AR & Ageing' }, { v: 'gen', label: 'Generate Billing' },
];

function Billing() {
  const [tab, setTab] = useState<Tab>('inv');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'inv' && <BlInv />}
      {tab === 'ar' && <BlAr />}
      {tab === 'gen' && <BlGen />}
    </>
  );
}

registerModule({
  key: 'billing',
  title: TITLES.billing,
  subtitle: () => 'Invoices, receivables ageing and the billing run',
  Component: Billing,
});
