import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { inr, lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { ORG } from '../../data/org';
import { comp } from '../../data/salary';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { Divide, StatusBadge } from '../../components/common';
import { BarChart, Donut, Legend, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useSaveDeclaration, useSetRegime, useSubmitProofs, useTaxRows, useTaxSummary,
  useVerifyDeclaration,
} from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

/** Metro cities get a 50% HRA cap rather than 40%. */
const METRO = ['CHN', 'BLR', 'HYD'];

const NEW_SLABS: [string, string][] = [
  ['Up to ₹4,00,000', 'Nil'],
  ['₹4,00,001 – ₹8,00,000', '5%'],
  ['₹8,00,001 – ₹12,00,000', '10%'],
  ['₹12,00,001 – ₹16,00,000', '15%'],
  ['₹16,00,001 – ₹20,00,000', '20%'],
  ['₹20,00,001 – ₹24,00,000', '25%'],
  ['Above ₹24,00,000', '30%'],
];

const PROOF_DOCS = [
  'Rent receipts (Apr–Mar)', 'LIC premium receipt', 'ELSS statement',
  'Mediclaim policy', 'NPS transaction statement', 'Home loan interest certificate',
];

/**
 * A single 12BB amount input. Defined at module scope so it keeps its DOM node
 * between renders — an inline component would remount and drop focus on every
 * keystroke.
 */
function NumField({ id, label, hint, items, setItem }: {
  id: string;
  label: string;
  hint?: string;
  items: Record<string, number | string>;
  setItem: (k: string, v: number | string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" className="input" value={(items[id] as number) || 0}
        onChange={(ev) => setItem(id, +ev.target.value || 0)} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/* ---------------- My declaration ---------------- */


function TaxMe() {
  const app = useApp();
  const layer = useLayer();
  const e = app.me;
  const { data: tax } = useTaxSummary(e.id);
  const saveDeclaration = useSaveDeclaration();
  const setRegime = useSetRegime();
  const submitProofs = useSubmitProofs();

  /* Local edits are held until Save, then sent as one declaration. */
  const [items, setItems] = useState<Record<string, number | string> | null>(null);
  const setItem = (k: string, v: number | string) => setItems((x) => ({ ...(x ?? {}), [k]: v }));

  /* After every hook: the tax position is computed by the service. */
  if (!tax) return <Card><EmptyState msg="Loading your tax position…" icon="🧾" /></Card>;

  const d = tax.declaration;
  const s = tax.salary;
  const t = tax.totals;
  const hx = tax.hraExemption;
  const oldR = tax.oldRegime;
  const newR = tax.newRegime;
  const better = tax.better;
  const draft = items ?? d.items;
  const saving = Math.abs(oldR.total - newR.total);
  const onBest = d.regime === better;
  const annual = d.regime === 'Old' ? oldR.total : newR.total;

  const save = async () => {
    try {
      await saveDeclaration.mutate(e.id, draft);
      setItems(null);
      app.toast('Declaration saved and submitted to Finance', 'ok');
    } catch (err) {
      app.toast(err instanceof Error ? err.message : 'Could not save the declaration', 'err');
    }
  };

  const uploadProofs = () =>
    layer.modal({
      title: 'Upload investment proofs',
      sub: ORG.fy,
      size: 'narrow',
      body: (
        <>
          <div className="stack">
            {PROOF_DOCS.map((x) => (
              <label key={x} className="row" style={{ gap: 9, cursor: 'pointer' }}>
                <input type="checkbox" defaultChecked />
                <span style={{ flex: 1 }}>{x}</span>
                <Badge kind="good">Uploaded</Badge>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <Banner kind="info" icon="📎">
              Accepted formats: PDF, JPG, PNG up to 5 MB each. Finance verifies within 5 working days.
            </Banner>
          </div>
        </>
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            try {
              await submitProofs.mutate(e.id);
              close();
              app.toast('Proofs submitted for verification', 'ok');
            } catch (err) {
              app.toast(err instanceof Error ? err.message : 'Could not submit the proofs', 'err');
            }
          }}>Submit proofs</button>
        </>
      ),
    });

  return (
    <div className="stack">
      <Banner kind={onBest ? 'good' : 'warn'} icon={<span style={{ fontSize: 19 }}>{onBest ? '✅' : '💡'}</span>}
        title={onBest ? `You are on the optimal regime (${d.regime})` : `The ${better} Regime would save you ${inr(saving)} this year`}
        actions={
          <button className={'btn' + (onBest ? '' : ' primary')} onClick={async () => {
            const next = d.regime === 'Old' ? 'New' : 'Old';
            try {
              await setRegime.mutate(e.id, next);
              app.toast('Switched to ' + next + ' Regime — TDS will be recomputed', 'ok');
            } catch (err) {
              app.toast(err instanceof Error ? err.message : 'Could not switch regime', 'err');
            }
          }}>Switch to {d.regime === 'Old' ? 'New' : 'Old'} Regime</button>
        }>
        Old Regime tax: {inr(oldR.total)} · New Regime tax: {inr(newR.total)} · Declaration status: {d.status}
      </Banner>

      <div className="grid g4">
        <Tile label="Gross annual salary" value={lakh(s.grossA)} foot="Excludes employer PF & gratuity" />
        <Tile label="Total exemptions claimed" value={lakh(t.total + hx)}
          foot={`HRA ${lakh(hx)} + deductions ${lakh(t.total)}`} />
        <Tile label="Estimated annual tax" value={inr(annual)} foot={`${d.regime} Regime incl. 4% cess`} />
        <Tile label="Monthly TDS" value={inr(annual / 12)} foot="Deducted from your salary" />
      </div>

      <div className="grid g-2-1">
        <Card title="Form 12BB — investment declaration" sub={`${ORG.fy} · ${ORG.ay}`}
          actions={
            <div className="row">
              <StatusBadge status={d.status} />
              <button className="btn sm primary" onClick={save}>Save declaration</button>
            </div>
          }>
          <h4 style={{ margin: '0 0 10px', fontSize: 13 }}>Section 80C — maximum ₹1,50,000</h4>
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <NumField id="80C_pf" label="Employee Provident Fund" hint="Auto-populated from payroll" items={draft} setItem={setItem} />
            <NumField id="80C_elss" label="ELSS / Mutual funds" items={draft} setItem={setItem} />
            <NumField id="80C_lic" label="Life insurance premium" items={draft} setItem={setItem} />
            <NumField id="80C_tuition" label="Children's tuition fees" items={draft} setItem={setItem} />
          </div>
          <div className="hint" style={{ marginBottom: 16 }}>Claimed: <b>{inr(t.c80)}</b> of ₹1,50,000</div>

          <Divide />
          <h4 style={{ margin: '0 0 10px', fontSize: 13 }}>Health, pension &amp; other deductions</h4>
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <NumField id="80D_self" label="80D — Medical insurance (self & family)" hint="Max ₹25,000" items={draft} setItem={setItem} />
            <NumField id="80D_parents" label="80D — Medical insurance (parents)" hint="Max ₹50,000 if senior citizen" items={draft} setItem={setItem} />
            <NumField id="80CCD1B" label="80CCD(1B) — NPS additional" hint="Max ₹50,000 over and above 80C" items={draft} setItem={setItem} />
            <NumField id="80E" label="80E — Education loan interest" hint="No upper limit" items={draft} setItem={setItem} />
            <NumField id="80G" label="80G — Donations" hint="50% or 100% deduction depending on institution" items={draft} setItem={setItem} />
            <NumField id="home_loan" label="Section 24(b) — Home loan interest" hint="Max ₹2,00,000 for self-occupied" items={draft} setItem={setItem} />
          </div>

          <Divide />
          <h4 style={{ margin: '0 0 10px', fontSize: 13 }}>House Rent Allowance exemption</h4>
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <NumField id="hra_rent" label="Monthly rent paid" hint={'Annual rent: ' + inr(Number(draft.hra_rent) * 12)} items={draft} setItem={setItem} />
            <div className="field">
              <label>Landlord PAN (mandatory if annual rent &gt; ₹1,00,000)</label>
              <input className="input" placeholder="AAAPZ1234C" value={String(draft.landlord_pan ?? '')}
                onChange={(ev) => setItem('landlord_pan', ev.target.value)} />
            </div>
          </div>

          <Banner kind="info" icon="🧮">
            <b>HRA exemption: {inr(hx)}</b> — least of: actual HRA {inr(comp(s, 1))}, rent paid − 10% of basic{' '}
            {inr(Math.max(0, t.hra - 0.1 * comp(s, 0)))}, {METRO.includes(e.site) ? '50%' : '40%'} of basic{' '}
            {inr((METRO.includes(e.site) ? 0.5 : 0.4) * comp(s, 0))}
          </Banner>

          <Divide />
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn" onClick={uploadProofs}>📎 Upload proofs</button>
            <span className="muted" style={{ fontSize: 12.5 }}>{d.proofs || 'No proofs uploaded yet'}</span>
          </div>
        </Card>

        <div className="stack">
          <Card title="Regime comparison" sub={ORG.fy + ' projection'}>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th /><th className="num">Old Regime</th><th className="num">New Regime</th></tr></thead>
                <tbody>
                  <tr><td>Gross salary</td><td className="num">{inr(s.grossA)}</td><td className="num">{inr(s.grossA)}</td></tr>
                  <tr><td>Standard deduction</td><td className="num">{inr(50000)}</td><td className="num">{inr(75000)}</td></tr>
                  <tr><td>HRA exemption</td><td className="num">{inr(hx)}</td><td className="num">—</td></tr>
                  <tr><td>Chapter VI-A deductions</td><td className="num">{inr(t.total)}</td><td className="num">—</td></tr>
                  <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                    <td>Taxable income</td><td className="num">{inr(oldR.taxable)}</td><td className="num">{inr(newR.taxable)}</td>
                  </tr>
                  <tr><td>Income tax</td><td className="num">{inr(oldR.tax)}</td><td className="num">{inr(newR.tax)}</td></tr>
                  <tr><td>Health &amp; education cess (4%)</td><td className="num">{inr(oldR.cess)}</td><td className="num">{inr(newR.cess)}</td></tr>
                  <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                    <td>Total tax</td>
                    <td className="num">{inr(oldR.total)}{better === 'Old' ? ' ✅' : ''}</td>
                    <td className="num">{inr(newR.total)}{better === 'New' ? ' ✅' : ''}</td>
                  </tr>
                  <tr><td>Monthly TDS</td><td className="num">{inr(oldR.total / 12)}</td><td className="num">{inr(newR.total / 12)}</td></tr>
                </tbody>
              </table>
            </div>
            <Divide />
            <BarChart labels={['Old', 'New']} height={150} padLeft={54} width={300}
              fmt={(v) => inr(v)} tickFmt={(v) => lakh(v)}
              series={[{ name: 'Annual tax', color: 'var(--s1)', data: [oldR.total, newR.total] }]} />
          </Card>

          <Card title="New Regime slabs" sub={ORG.fy} flush>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Income slab</th><th className="num">Rate</th></tr></thead>
                <tbody>{NEW_SLABS.map(([a, b]) => <tr key={a}><td>{a}</td><td className="num">{b}</td></tr>)}</tbody>
              </table>
            </div>
            <div style={{ padding: '11px 16px' }} className="muted">
              Standard deduction ₹75,000. Rebate under section 87A makes tax nil for taxable income up to ₹12,00,000.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- All declarations (admin) ---------------- */

function TaxAll() {
  const app = useApp();
  const [q, setQ] = useState('');
  const { data: list = [] } = useTaxRows();
  const verify = useVerifyDeclaration();
  const needle = q.toLowerCase();
  const shown = q ? list.filter((r) => r.employee.name.toLowerCase().includes(needle)) : list;

  const byStatus = ['Draft', 'Submitted', 'Verified'].map((st, i) => ({
    k: st, c: PAL[i], v: list.filter((r) => r.declaration.status === st).length,
  }));
  const submitted = list.filter((r) => r.declaration.status !== 'Draft').length;
  const onNew = list.filter((r) => r.declaration.regime === 'New').length;

  const exportCsv = () =>
    downloadCSV('tax_declarations.csv',
      [['Emp Code', 'Name', 'Regime', 'Status', '80C', '80D', '80CCD1B', '80E', '80G', 'Annual Rent', 'Home Loan Interest', 'Total Deductions']].concat(
        list.map(({ employee: e, declaration: d, totals: t }) =>
          [e.code, e.name, d.regime, d.status, String(t.c80), String(t.d80), String(t.nps),
            String(t.e80), String(t.g80), String(t.hra), String(t.loan), String(t.total)]),
      ));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Declarations submitted" value={`${submitted} / ${list.length}`} foot={pct(submitted, list.length) + '% completion'} />
        <Tile label="Proofs verified" value={list.filter((r) => r.declaration.status === 'Verified').length} foot="Finance team verification" />
        <Tile label="On New Regime" value={onNew} foot={pct(onNew, list.length) + '% of employees'} />
        <Tile label="Total 80C claimed" value={lakh(sum(list, (r) => r.totals.c80))} foot="Across all employees" />
      </div>

      <div className="grid g-2-1">
        <Card title="Employee declarations" sub={`${list.length} employees`} flush
          actions={
            <div className="row">
              <input className="input" placeholder="Search…" style={{ width: 180 }} value={q} onChange={(e) => setQ(e.target.value)} />
              <button className="btn sm" onClick={exportCsv}>⤓</button>
            </div>
          }>
          <div className="tbl-wrap" style={{ maxHeight: 600, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Employee</th><th>Regime</th><th className="num">80C</th><th className="num">80D</th>
                  <th className="num">NPS</th><th className="num">HRA rent (annual)</th><th className="num">Home loan</th>
                  <th>Status</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortBy(shown, (r) => r.employee.name).map(({ employee: e, declaration: d, totals: t }) => {
                  return (
                    <tr key={e.id}>
                      <td><PersonCell e={e} sub={e.code} /></td>
                      <td><Badge kind={d.regime === 'New' ? 'info' : 'warn'}>{d.regime}</Badge></td>
                      <td className="num">{inr(t.c80)}</td>
                      <td className="num">{inr(t.d80)}</td>
                      <td className="num">{inr(t.nps)}</td>
                      <td className="num">{inr(t.hra)}</td>
                      <td className="num">{inr(t.loan)}</td>
                      <td><StatusBadge status={d.status} /></td>
                      <td className="right">
                        {d.status === 'Submitted' ? (
                          <button className="btn sm primary" onClick={async () => {
                            try {
                              await verify.mutate(e.id);
                              app.toast('Declaration verified', 'ok');
                            } catch (err) {
                              app.toast(err instanceof Error ? err.message : 'Could not verify it', 'err');
                            }
                          }}>Verify</button>
                        ) : <span className="muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Declaration status" sub="Company-wide">
          <Donut size={160} center={list.length} centerSub="employees" slices={byStatus} />
          <Legend items={byStatus} />
          <Divide />
          <Banner kind="warn" icon="⏰" title="Proof submission window">
            Closes 31 January. Unverified declarations are dropped from February TDS.
          </Banner>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

function Tax() {
  const app = useApp();
  const tabs: { v: 'me' | 'all'; label: string }[] = app.role === 'admin'
    ? [{ v: 'me', label: 'My Declaration' }, { v: 'all', label: 'All Declarations' }]
    : [{ v: 'me', label: 'My Declaration' }];
  const [tab, setTab] = useState<'me' | 'all'>('me');
  const active = tabs.some((t) => t.v === tab) ? tab : 'me';

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'me' ? <TaxMe /> : <TaxAll />}
    </>
  );
}

registerModule({
  key: 'tax',
  title: TITLES.tax,
  subtitle: () => `${ORG.fy} · ${ORG.ay} · Form 12BB investment declaration`,
  Component: Tax,
});
