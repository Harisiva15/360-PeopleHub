import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { fmtD, parseYmd, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { countryOf, money } from '../../data/countries';
import { clientOf, conOf, reqOf2, subStage, vendorOf } from '../../data/staffing';
import type { Vendor } from '../../services';
import { useConsultants, usePlacements, useSubmissions, useVendors } from './data';
import { Badge, Banner, Card, Tabs, Tile } from '../../components/ui';
import { HBar } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { TierBadge } from './shared';

/** Scorecard weights, shown to vendors so the number is not a black box. */
const SCORE_DIMS: [keyof NonNullable<Vendor['metrics']>, string, boolean][] = [
  ['sub2int', 'Submission quality', true],
  ['int2plc', 'Closing rate', true],
  ['speed', 'Speed of submission', false],
  ['fallout', 'Placement stability', false],
  ['compliance', 'Documentation compliance', false],
];

const scoreColor = (s: number) => (s >= 70 ? 'var(--good)' : s >= 50 ? 'var(--warn)' : 'var(--crit)');

const isCompliant = (v: Vendor) => v.w9 && v.coi && v.insuranceExpiry >= ymd(TODAY);

/* ---------------- Vendor register ---------------- */

function VnList() {
  const { data: VENDORS = [] } = useVendors();
  const { data: CONSULTANTS = [] } = useConsultants();
  const { data: PLACEMENTS = [] } = usePlacements();
  const act = VENDORS.filter((v) => v.status === 'Active');

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn" onClick={() =>
          downloadCSV('vendors.csv',
            [['ID', 'Name', 'Country', 'Type', 'Tier', 'Contact', 'Email', 'Submissions', 'Placements', 'Score', 'Terms', 'Markup %', 'Status']].concat(
              VENDORS.map((v) => [v.id, v.name, v.country, v.type, v.tier, v.contact, v.email,
                String(v.subs), String(v.placements), String(v.score ?? ''), String(v.paymentTerms), String(v.markup), v.status]),
            ))}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Active vendors" value={act.length} foot={`${VENDORS.length} onboarded in total`} />
        <Tile label="Vendor consultants" value={CONSULTANTS.filter((c) => c.external).length} foot="Currently supplied to us" />
        <Tile label="Vendor placements" value={PLACEMENTS.filter((p) => p.vendorId).length}
          foot={pct(PLACEMENTS.filter((p) => p.vendorId).length, Math.max(1, PLACEMENTS.length)) + '% of all placements'} />
        <Tile label="Average score" value={Math.round(sum(VENDORS, (v) => v.score ?? 0) / Math.max(1, VENDORS.length))} foot="Out of 100" />
        <Tile label="Compliance issues" value={VENDORS.filter((v) => !isCompliant(v)).length} foot="Missing or expired documents" />
      </div>

      <Card title="Vendor register" sub={`${VENDORS.length} partners`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Vendor</th><th>Country</th><th>Type</th><th>Tier</th><th className="num">Submissions</th>
                <th className="num">Placements</th><th className="num">Fill rate</th><th className="num">Score</th>
                <th>Terms</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(VENDORS, (v) => -(v.score ?? 0)).map((v) => (
                <tr key={v.id}>
                  <td>
                    <b>{v.name}</b>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {v.contact} · onboarded {parseYmd(v.onboarded).getFullYear()}
                    </div>
                  </td>
                  <td className="nowrap">{countryOf(v.country).flag} {v.country}</td>
                  <td>{v.type}</td>
                  <td><TierBadge tier={v.tier} /></td>
                  <td className="num">{v.subs}</td>
                  <td className="num">{v.placements}</td>
                  <td className="num">{pct(v.placements, Math.max(1, v.subs))}%</td>
                  <td className="num">
                    <div className="row" style={{ gap: 7 }}>
                      <div className="bar" style={{ flex: 1, minWidth: 44 }}>
                        <i style={{ width: (v.score ?? 0) + '%', background: scoreColor(v.score ?? 0) }} />
                      </div>
                      <b>{v.score}</b>
                    </div>
                  </td>
                  <td className="nowrap">Net {v.paymentTerms} · {v.markup}% markup</td>
                  <td><Badge kind={v.status === 'Active' ? 'good' : 'warn'}>{v.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Scorecard ---------------- */

function VnScore() {
  const { data: VENDORS = [] } = useVendors();
  return (
    <div className="stack">
      <Banner kind="info" icon="📊" title="How the vendor score is calculated">
        Submission quality 25% · closing rate 30% · speed 20% · placement stability 15% · compliance 10%. Vendors below
        50 move to <b>Watchlist</b> and stop receiving new requirements until they recover.
      </Banner>

      <Card title="Vendor scorecard" sub={`${VENDORS.length} partners ranked`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Vendor</th>
                {SCORE_DIMS.map(([k, label]) => <th key={k} className="num">{label}</th>)}
                <th className="num">Composite</th><th>Rating</th>
              </tr>
            </thead>
            <tbody>
              {sortBy(VENDORS, (v) => -(v.score ?? 0)).map((v) => (
                <tr key={v.id}>
                  <td><b>{v.name}</b></td>
                  {SCORE_DIMS.map(([k, , isPct]) => (
                    <td key={k} className="num">{v.metrics?.[k]}{isPct ? '%' : ''}</td>
                  ))}
                  <td className="num strong">{v.score}</td>
                  <td>
                    <Badge kind={(v.score ?? 0) >= 75 ? 'good' : (v.score ?? 0) >= 60 ? 'info' : (v.score ?? 0) >= 45 ? 'warn' : 'crit'}>
                      {(v.score ?? 0) >= 75 ? 'Excellent' : (v.score ?? 0) >= 60 ? 'Good' : (v.score ?? 0) >= 45 ? 'Needs improvement' : 'At risk'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Composite score" sub="All vendors">
          <HBar rows={sortBy(
            VENDORS.map((v) => ({
              k: v.name,
              c: (v.score ?? 0) >= 70 ? 'var(--s6)' : (v.score ?? 0) >= 50 ? 'var(--s4)' : 'var(--s8)',
              v: v.score ?? 0,
            })),
            (r) => -r.v,
          )} />
        </Card>
        <Card title="Average time to submit" sub="Days from requirement release">
          <HBar rows={sortBy(VENDORS.map((v) => ({ k: v.name, c: 'var(--s1)', v: v.avgSubmitDays })), (r) => r.v)}
            fmt={(v) => v + ' d'} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Compliance ---------------- */

function VnComp() {
  const { data: VENDORS = [] } = useVendors();
  const app = useApp();
  return (
    <div className="stack">
      <Card title="Vendor compliance" sub="Contract and insurance status" flush
        actions={<button className="btn sm" onClick={() => app.toast('Chase emails sent to non-compliant vendors', 'ok')}>📧 Chase missing documents</button>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Vendor</th><th>MSA signed</th><th>MSA expiry</th><th>W-9 / tax form</th>
                <th>Certificate of insurance</th><th>Insurance expiry</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {VENDORS.map((v) => {
                const insExpired = v.insuranceExpiry < ymd(TODAY);
                const ok = isCompliant(v);
                return (
                  <tr key={v.id}>
                    <td><b>{v.name}</b></td>
                    <td className="nowrap">{fmtD(v.msaSigned)}</td>
                    <td className="nowrap">{fmtD(v.msaExpiry)}</td>
                    <td>{v.w9 ? <Badge kind="good">On file</Badge> : <Badge kind="crit">Missing</Badge>}</td>
                    <td>{v.coi ? <Badge kind="good">On file</Badge> : <Badge kind="crit">Missing</Badge>}</td>
                    <td className="nowrap">
                      {fmtD(v.insuranceExpiry)}{insExpired && <> <Badge kind="crit">Expired</Badge></>}
                    </td>
                    <td><Badge kind={ok ? 'good' : 'crit'}>{ok ? 'Compliant' : 'Blocked'}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Banner kind="warn" icon="🚫" title="Automatic blocking">
        A vendor with an expired certificate of insurance or a missing tax form cannot submit candidates. The block
        lifts automatically once the document is uploaded and verified.
      </Banner>
    </div>
  );
}

/* ---------------- Vendor submissions ---------------- */

function VnSub() {
  const { data: VENDORS = [] } = useVendors();
  const { data: SUBMISSIONS = [] } = useSubmissions();
  const subs = SUBMISSIONS.filter((s) => s.vendorId);
  const byVendor = VENDORS.map((v) => ({ k: v.name, c: 'var(--s1)', v: subs.filter((s) => s.vendorId === v.id).length })).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Vendor submissions" value={subs.length} foot={pct(subs.length, Math.max(1, SUBMISSIONS.length)) + '% of all submissions'} />
        <Tile label="Vendor placements" value={subs.filter((s) => s.stage === 'placed').length} foot="Converted to billing" />
        <Tile label="Avg vendor margin" value={(sum(subs, (s) => s.margin) / Math.max(1, subs.length)).toFixed(1) + '%'} foot="After vendor markup" />
        <Tile label="Duplicate submissions blocked" value={6} foot="Same consultant from two vendors" />
      </div>

      <div className="grid g-2-1">
        <Card title="Vendor submissions" sub={`${subs.length} records`} flush>
          <div className="tbl-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Consultant</th><th>Vendor</th><th>Client</th><th className="num">Bill</th><th className="num">Pay</th><th className="num">Margin</th><th>Stage</th></tr>
              </thead>
              <tbody>
                {sortBy(subs, (s) => s.submittedOn, 'desc').map((s) => {
                  const c = conOf(s.consultantId);
                  const r = reqOf2(s.reqId);
                  const st = subStage(s.stage);
                  return (
                    <tr key={s.id}>
                      <td>{c ? c.name : '—'}</td>
                      <td className="nowrap">{vendorOf(s.vendorId || '')?.name || '—'}</td>
                      <td className="nowrap">{r ? clientOf(r.clientId).name : ''}</td>
                      <td className="num">{money(s.billRate, s.ccy)}</td>
                      <td className="num">{money(s.payRate, s.ccy)}</td>
                      <td className="num">{s.margin}%</td>
                      <td>
                        <span className="badge" style={{
                          background: `color-mix(in srgb, ${st.c} 15%, transparent)`,
                          color: st.c,
                          borderColor: `color-mix(in srgb, ${st.c} 35%, transparent)`,
                        }}>{st.n}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Submissions by vendor" sub="Volume">
          <HBar rows={sortBy(byVendor, (r) => -r.v)} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'list' | 'score' | 'comp' | 'sub';

const TABS: { v: Tab; label: string }[] = [
  { v: 'list', label: 'Vendors' }, { v: 'score', label: 'Scorecard' },
  { v: 'comp', label: 'Compliance' }, { v: 'sub', label: 'Submissions' },
];

function Vendors() {
  const [tab, setTab] = useState<Tab>('list');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'list' && <VnList />}
      {tab === 'score' && <VnScore />}
      {tab === 'comp' && <VnComp />}
      {tab === 'sub' && <VnSub />}
    </>
  );
}

registerModule({
  key: 'vendors',
  title: TITLES.vendors,
  subtitle: () => 'The supplier panel, scorecards and compliance',
  Component: Vendors,
});
