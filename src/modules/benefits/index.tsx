import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { inr, lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { FBP_COMPONENTS, INSURANCE, PERKS } from '../../data/benefits';
import { LOAN_TYPES } from '../../data/loans';
import type { Loan } from '../../services';
import { GRADES, ORG } from '../../data/org';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { Divide, ListRow } from '../../components/common';
import { Donut, HBar, Legend, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import {
  useApproveLoan, useDeclareFbp, useFbpPlan, useFbpRows, useInsuranceCover, useLoans,
  useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import type { Grade } from '../../types/country';

const CLAIM_HOW: [string, string][] = [
  ['Cashless hospitalisation', 'Show your e-card at any network hospital. Pre-authorisation is done by the hospital desk — allow 4 hours for planned admissions.'],
  ['Reimbursement claim', 'Pay first, then submit the discharge summary, bills and prescriptions within 30 days through the insurer portal.'],
  ['OPD & wellness wallet', 'Consultations, diagnostics, dental and vision. Upload the bill in the Practo Care app; credited within 7 days.'],
];

const FBP_GUIDE: [string, string][] = [
  ['1. Declare once a year', 'You choose how much of your Special Allowance to route into each component. Declarations lock on 30 April.'],
  ['2. Claim monthly against bills', 'Upload bills through the FBP claim window each month. Unclaimed amounts are paid as taxable salary in March.'],
  ['3. Tax benefit', 'Components claimed with valid bills are exempt from tax, so your take-home rises without changing your CTC.'],
  ['4. New Tax Regime note', 'Most FBP exemptions do not apply under the New Regime — check the regime comparison before allocating.'],
];

const LOAN_ELIGIBILITY: Record<string, string> = {
  SALADV: 'Confirmed employees, once per financial year',
  PERSONAL: 'Two years of service, no active personal loan',
  EMERGENCY: 'Any employee, with supporting documents',
};

/* ---------------- My benefits ---------------- */

function BnMine() {
  const app = useApp();
  const e = app.me;

  return (
    <div className="stack">
      <div className="grid g4">
        {INSURANCE.map((p) => (
          <div className="tile" key={p.id}>
            <div className="lbl">{p.ic} {p.n}</div>
            <div className="val">{lakh(p.sum[e.grade])}</div>
            <div className="foot">{p.insurer}</div>
          </div>
        ))}
      </div>

      <div className="grid g-2-1">
        <Card title="Insurance cover" sub={'Premium fully paid by ' + ORG.name} flush
          actions={<button className="btn sm" onClick={() => app.toast('E-cards downloaded', 'ok')}>🪪 Download e-cards</button>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Policy</th><th>Insurer</th><th>Who is covered</th><th className="num">Sum insured</th><th>Premium</th></tr>
              </thead>
              <tbody>
                {INSURANCE.map((p) => (
                  <tr key={p.id}>
                    <td><span style={{ marginRight: 7 }}>{p.ic}</span><b>{p.n}</b></td>
                    <td>{p.insurer}</td>
                    <td>{p.covers}</td>
                    <td className="num strong">{inr(p.sum[e.grade])}</td>
                    <td>{p.premiumEmployer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '14px 16px' }}>
            <Banner kind="info" icon="👨‍👩‍👧" title="Dependents on your policy">
              Self · Spouse · 2 children · Parents (₹3,00,000 shared floater). Additions are allowed within 30 days of
              joining, marriage or childbirth — raise a Helpdesk ticket under Insurance &amp; Benefits.
            </Banner>
          </div>
        </Card>

        <Card title="Perks & allowances" sub={`${PERKS.length} benefits`} flush>
          <div style={{ maxHeight: 520, overflow: 'auto' }}>
            {PERKS.map((p) => (
              <ListRow key={p.n} style={{ alignItems: 'flex-start' }}>
                <span style={{ fontSize: 16 }}>{p.ic}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{p.n}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{p.d}</div>
                </div>
              </ListRow>
            ))}
          </div>
        </Card>
      </div>

      <Card title="How to claim" sub="Insurance & wellness">
        <div className="grid g3">
          {CLAIM_HOW.map(([t, d]) => (
            <div key={t}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5 }}>{t}</div>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>{d}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Flexi benefits ---------------- */

function BnFbp() {
  const app = useApp();
  const e = app.me;
  const { data: row } = useFbpPlan(e.id);
  const declareFbp = useDeclareFbp();

  /* Edits are local until saved, so the pool check can run live. */
  const [draft, setDraft] = useState<Record<string, number> | null>(null);

  /* After every hook. */
  if (!row) return <Card><EmptyState msg="Loading your benefit plan…" icon="🎁" /></Card>;

  const f = row.plan;
  const alloc = draft ?? f.alloc;
  const setAlloc = (fn: (a: Record<string, number>) => Record<string, number>) =>
    setDraft((d) => fn(d ?? f.alloc));
  const used = sum(Object.values(alloc));
  const left = f.pool - used;
  const over = used > f.pool;
  /* indicative saving at the 30% marginal slab */
  const taxSaved = Math.round(used * 0.3);

  const allocated = FBP_COMPONENTS.filter((c) => alloc[c.id]);

  return (
    <div className="stack">
      <Banner kind={f.status === 'Declared' ? 'good' : 'info'}
        icon={<span style={{ fontSize: 19 }}>{f.status === 'Declared' ? '✅' : '💡'}</span>}
        title={`Flexible Benefit Plan — ${ORG.fy}`}
        actions={<Badge kind={f.status === 'Declared' ? 'good' : 'warn'}>{f.status}</Badge>}>
        You can restructure up to <b>{inr(f.pool)}</b> of your Special Allowance into tax-friendly components.
        Declared: <b>{inr(used)}</b> · estimated tax saved <b>{inr(taxSaved)}</b> per year.
      </Banner>

      <div className="grid g4">
        <Tile label="FBP pool" value={inr(f.pool)} foot="45% of your Special Allowance" />
        <Tile label="Allocated" value={inr(used)} foot={pct(used, Math.max(1, f.pool)) + '% of pool'} />
        <Tile label="Unallocated" value={inr(Math.max(0, left))} foot="Paid as taxable Special Allowance" />
        <Tile label="Estimated tax saved" value={inr(taxSaved)} foot="At your marginal rate" />
      </div>

      <div className="grid g-2-1">
        <Card title="Declare your components"
          sub={`Locks on ${fmtD(f.lockedOn || '2027-03-31')} · claim against bills each month`} flush
          actions={
            <button className="btn sm primary" disabled={over} onClick={async () => {
              try {
                await declareFbp.mutate(e.id, alloc);
                setDraft(null);
                app.toast('FBP declaration saved', 'ok');
              } catch (err) {
                app.toast(err instanceof Error ? err.message : 'Could not save the declaration', 'err');
              }
            }}>Save declaration</button>
          }>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Component</th><th className="num">Annual cap</th><th className="num">Your allocation</th><th>Tax treatment</th></tr>
              </thead>
              <tbody>
                {FBP_COMPONENTS.map((c) => (
                  <tr key={c.id}>
                    <td><span style={{ marginRight: 7 }}>{c.ic}</span><b>{c.n}</b></td>
                    <td className="num">{inr(c.cap)}</td>
                    <td className="num">
                      <input type="number" className="input" step={1200} min={0} max={c.cap}
                        style={{ width: 120, padding: '5px 7px', textAlign: 'right' }}
                        value={alloc[c.id] || 0}
                        onChange={(ev) => setAlloc((a) => ({ ...a, [c.id]: +ev.target.value || 0 }))} />
                    </td>
                    <td className="muted">{c.note}</td>
                  </tr>
                ))}
                <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                  <td colSpan={2}>Total allocated</td>
                  <td className="num">{inr(used)}</td>
                  <td className="muted">
                    {over
                      ? <span style={{ color: 'var(--crit)' }}>Exceeds your pool by {inr(used - f.pool)}</span>
                      : `${inr(left)} left in pool`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Allocation" sub="Where your FBP pool goes">
            {used ? (
              <>
                <Donut size={155} center={lakh(used)} centerSub="allocated" fmt={(v) => inr(v)}
                  slices={allocated.map((c, i) => ({ k: c.n, v: alloc[c.id], c: PAL[i % 8] }))} />
                <Legend items={allocated.map((c, i) => ({ k: c.n, v: alloc[c.id], c: PAL[i % 8] }))} fmt={(v) => inr(v as number)} />
              </>
            ) : <EmptyState msg="Nothing allocated yet" icon="🧩" />}
          </Card>

          <Card title="How FBP works" sub="Quick guide">
            <div className="stack" style={{ gap: 10, fontSize: 12.5 }}>
              {FBP_GUIDE.map(([t, d]) => (
                <div key={t}>
                  <div style={{ fontWeight: 700 }}>{t}</div>
                  <div className="muted">{d}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Loans ---------------- */

function LoanTable(
  { list, dir, act, onApprove }:
  { list: Loan[]; dir: Directory; act: boolean; onApprove: (l: Loan) => void },
) {
  if (!list.length) return <EmptyState msg="No loans on record" icon="🏦" />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {act && <th>Employee</th>}
            <th>Reference</th><th>Type</th><th className="num">Principal</th><th className="num">EMI</th>
            <th className="num">Paid</th><th className="num">Outstanding</th><th>Status</th>
            {act && <th className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((l) => (
            <tr key={l.id}>
              {act && <td><PersonCell e={dir.byId(l.empId)!} /></td>}
              <td className="mono">{l.id}</td>
              <td>{LOAN_TYPES.find((t) => t.id === l.type)?.n || l.type}</td>
              <td className="num">{inr(l.principal)}</td>
              <td className="num">{inr(l.emi)}</td>
              <td className="num">{l.paidN} / {l.tenure}</td>
              <td className="num strong">{inr(l.outstanding)}</td>
              <td>
                <Badge kind={l.status === 'Active' ? 'good' : l.status === 'Closed' ? 'mute' : 'warn'}>{l.status}</Badge>
              </td>
              {act && (
                <td className="right">
                  {l.status === 'Pending Approval'
                    ? <button className="btn sm primary" onClick={() => onApprove(l)}>Approve</button>
                    : <span className="muted">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BnLoans() {
  const app = useApp();
  const dir = useVisiblePeople();
  const { data: loans = [] } = useLoans();
  const approveLoan = useApproveLoan();

  const visible = loans.filter((l) => dir.ids.includes(l.empId));
  const mine = visible.filter((l) => l.empId === app.meId);
  const team = app.role === 'employee' ? [] : visible.filter((l) => l.empId !== app.meId);
  const active = mine.filter((l) => l.status === 'Active');
  const eligible = Math.round(((app.me.ctc / 12) * 3) / 1000) * 1000;

  /* Sanctioning puts the loan into recovery, so the service owns it. */
  const approve = async (l: Loan) => {
    try {
      await approveLoan.mutate(l.id);
      app.toast('Loan approved', 'ok');
    } catch (err) {
      app.toast(err instanceof Error ? err.message : 'Could not approve the loan', 'err');
    }
  };

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Eligible amount" value={inr(eligible)} foot="Up to 3× monthly CTC" />
        <Tile label="Active loans" value={active.length} foot="EMI recovered from payroll" />
        <Tile label="Outstanding" value={inr(sum(active, (l) => l.outstanding))} foot="Across your loans" />
        <Tile label="Monthly EMI" value={inr(sum(active, (l) => l.emi))} foot="Deducted from salary" />
      </div>

      <Card title="My loans & advances" sub={`${mine.length} records`} flush
        actions={<button className="btn sm primary" onClick={() => app.toast('Loan application form is not wired in this build')}>＋ Apply for a loan</button>}>
        <LoanTable list={mine} dir={dir} act={false} onApprove={approve} />
      </Card>

      {app.role !== 'employee' && (
        <Card title="Team loans"
          sub={`${team.length} records · ${inr(sum(team.filter((l) => l.status === 'Active'), (l) => l.outstanding))} outstanding`} flush>
          <LoanTable list={team} dir={dir} act={app.role === 'admin'} onApprove={approve} />
        </Card>
      )}

      <Card title="Loan schemes" sub="What you can apply for" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Scheme</th><th className="num">Maximum</th><th className="num">Max tenure</th><th className="num">Interest</th><th>Eligibility</th></tr>
            </thead>
            <tbody>
              {LOAN_TYPES.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.n}</b></td>
                  <td className="num">{t.maxMult}× monthly CTC</td>
                  <td className="num">{t.maxTenure} months</td>
                  <td className="num">{t.rate ? t.rate + '% p.a.' : 'Interest free'}</td>
                  <td className="muted">{LOAN_ELIGIBILITY[t.id]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Administration ---------------- */

function BnAdmin() {
  const showEmp = useShowEmployee();
  const { data: rows = [] } = useFbpRows();
  const { data: cover } = useInsuranceCover();
  const active = rows.map((r) => r.employee);
  const totalCover = cover?.totalSumAssured ?? 0;
  const grades = Object.keys(GRADES) as Grade[];
  const byGrade = grades.map((g, i) => ({ k: GRADES[g].label, c: PAL[i], v: active.filter((e) => e.grade === g).length })).filter((r) => r.v);
  const declared = rows.filter((r) => r.plan.status === 'Declared');

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Employees covered" value={active.length} foot="Group medical, GPA and GTL" />
        <Tile label="Total medical cover" value={lakh(totalCover)} foot="Aggregate sum insured" />
        <Tile label="Annual premium" value={lakh(active.length * 14500)} foot="Employer funded" />
        <Tile label="FBP declared" value={`${declared.length} / ${active.length}`} foot={pct(declared.length, active.length) + '% completion'} />
      </div>

      <div className="grid g2">
        <Card title="Policy configuration" sub="Sum insured by grade" flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Grade</th>
                  {INSURANCE.map((p) => <th key={p.id} className="num">{p.n.split(' ')[1] || p.n}</th>)}
                  <th className="num">Employees</th>
                </tr>
              </thead>
              <tbody>
                {grades.map((g) => (
                  <tr key={g}>
                    <td><b>{GRADES[g].label}</b></td>
                    {INSURANCE.map((p) => <td key={p.id} className="num">{lakh(p.sum[g])}</td>)}
                    <td className="num">{active.filter((e) => e.grade === g).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Covered headcount by grade" sub="Drives premium">
          <HBar rows={byGrade} />
          <Divide />
          <div className="muted" style={{ fontSize: 12 }}>
            Policy renewal: 1 April each year. Mid-year additions are endorsed monthly; the insurer pro-rates the premium.
          </div>
        </Card>
      </div>

      <Card title="FBP declaration status" sub={`${active.length} employees`} flush
        actions={<button className="btn sm" onClick={() =>
          downloadCSV('fbp_status.csv',
            [['Emp Code', 'Name', 'Grade', 'FBP pool', 'Allocated', 'Status']].concat(
              rows.map(({ employee: e, plan: f, allocated }) =>
                [e.code, e.name, e.grade, String(f.pool), String(allocated), f.status]),
            ))}>⤓ Export</button>}>
        <div className="tbl-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Employee</th><th>Grade</th><th className="num">FBP pool</th><th className="num">Allocated</th><th className="num">Utilisation</th><th>Status</th></tr>
            </thead>
            <tbody>
              {sortBy(rows, (r) => r.employee.name).map(({ employee: e, plan: f, allocated: u }) => {
                return (
                  <tr key={e.id} className="clickable" onClick={() => showEmp(e.id)}>
                    <td><PersonCell e={e} sub={e.code} /></td>
                    <td><Badge>{e.grade}</Badge></td>
                    <td className="num">{inr(f.pool)}</td>
                    <td className="num">{inr(u)}</td>
                    <td className="num">{pct(u, Math.max(1, f.pool))}%</td>
                    <td>
                      <Badge kind={f.status === 'Declared' ? 'good' : 'warn'}>
                        {f.status === 'Declared' ? 'Declared' : 'Not declared'}
                      </Badge>
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

type Tab = 'mine' | 'fbp' | 'loans' | 'admin';

function Benefits() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'admin'
    ? [
        { v: 'mine', label: 'My Benefits' }, { v: 'fbp', label: 'Flexi Benefits' },
        { v: 'loans', label: 'Loans & Advances' }, { v: 'admin', label: 'Benefits Administration' },
      ]
    : [{ v: 'mine', label: 'My Benefits' }, { v: 'fbp', label: 'Flexi Benefits' }, { v: 'loans', label: 'Loans & Advances' }];

  const [tab, setTab] = useState<Tab>('mine');
  const active = tabs.some((t) => t.v === tab) ? tab : 'mine';

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'mine' && <BnMine />}
      {active === 'fbp' && <BnFbp />}
      {active === 'loans' && <BnLoans />}
      {active === 'admin' && <BnAdmin />}
    </>
  );
}

registerModule({
  key: 'benefits',
  title: TITLES.benefits,
  Component: Benefits,
});
