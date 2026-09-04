import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, fmtD, MON, mondayOf, monthLabel, monthLabelLong, TODAY, ymd } from '../../lib/dates';
import { inr, lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { countryOf, mb, mbS, money, moneyShort, sumBase, toBase } from '../../data/countries';
import { ACTIVE, EMAP, empName, teamOf } from '../../data/employees';
import { CLAIMS } from '../../data/expenses';
import { LOANS, LOAN_TYPES, loanEmiFor } from '../../data/loans';
import { BANKS, DEPTS, deptOf, GRADES, ORG, projOf, siteOf } from '../../data/org';
import { BANK_BATCHES, COMPLIANCE_PAYS, PAY_INPUTS } from '../../data/payinputs';
import { CUR_RUN, DECL, PAYRUNS, payrollTotals, payslip } from '../../data/payroll';
import { comp, compAllow, salaryStructure } from '../../data/salary';
import { TS } from '../../data/timesheet';
import { Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile } from '../../components/ui';
import { ListRow, StatusBadge } from '../../components/common';
import { BarChart, Donut, HBar, Legend, LineChart, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { useShowPayslip } from './Payslip';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import type { Employee } from '../../types/employee';
import type { Grade } from '../../types/country';

const m = (e: Employee, a: number) => money(a, e.ccy);
const mS = (e: Employee, a: number) => moneyShort(a, e.ccy);

/** Deductions split into statutory vs income tax, by label. */
const TAX_RE = /Tax|TDS|PAYE/;

/* ---------------- Payroll runs ---------------- */

function PyRuns({ goRegister }: { goRegister: (mk: string) => void }) {
  const app = useApp();
  const cur = payrollTotals(CUR_RUN.mk);
  const trend = PAYRUNS.map((r) => ({ mk: r.mk, t: payrollTotals(r.mk) }));

  return (
    <div className="stack">
      <Banner kind={CUR_RUN.status === 'Paid' ? 'good' : 'info'}
        icon={<span style={{ fontSize: 19 }}>{CUR_RUN.status === 'Paid' ? '✅' : '🧾'}</span>}
        title={`${monthLabelLong(CUR_RUN.mk)} payroll — ${CUR_RUN.status}`}
        actions={CUR_RUN.status !== 'Paid'
          ? <button className="btn primary" onClick={() => app.toast('Payroll processing is simulated in this build')}>Process payroll</button>
          : undefined}>
        {cur.count} employees · gross {inr(cur.gross)} · deductions {inr(cur.ded)} · <b>net payable {inr(cur.net)}</b>
      </Banner>

      <div className="grid g5">
        <Tile label="Net payable" value={lakh(cur.net)} foot={`${monthLabel(CUR_RUN.mk)} · ${cur.count} employees`} />
        <Tile label="Gross earnings" value={lakh(cur.gross)} foot="Before statutory deductions" />
        <Tile label="PF (EE + ER)" value={lakh(cur.pf)} foot="Due to EPFO by 15th" />
        <Tile label="TDS" value={lakh(cur.tds)} foot="Due to IT dept by 7th" />
        <Tile label="LOP days" value={cur.lop} foot="Unapproved absences this month" />
      </div>

      <div className="grid g-2-1">
        <Card title="Payroll cost trend" sub="Last 8 months · gross vs net">
          <BarChart labels={trend.map((t) => monthLabel(t.mk).split(' ')[0])} height={230} padLeft={56}
            fmt={(v) => inr(v)} tickFmt={(v) => lakh(v)}
            series={[
              { name: 'Gross', color: 'var(--s1)', data: trend.map((t) => t.t.gross) },
              { name: 'Net paid', color: 'var(--s3)', data: trend.map((t) => t.t.net) },
            ]} />
          <Legend items={[{ k: 'Gross earnings', c: 'var(--s1)' }, { k: 'Net paid', c: 'var(--s3)' }]} />
        </Card>

        <Card title="This month split" sub={monthLabelLong(CUR_RUN.mk)}>
          <Donut size={160} center={lakh(cur.gross)} centerSub="gross" fmt={(v) => inr(v)}
            slices={[
              { k: 'Net pay', v: cur.net, c: 'var(--s1)' },
              { k: 'PF (employee)', v: cur.pf / 2, c: 'var(--s3)' },
              { k: 'TDS', v: cur.tds, c: 'var(--s4)' },
              { k: 'PT + ESI', v: cur.pt + cur.esi, c: 'var(--s2)' },
            ]} />
          <Legend fmt={(v) => inr(v as number)}
            items={[
              { k: 'Net pay', v: cur.net, c: 'var(--s1)' },
              { k: 'PF', v: Math.round(cur.pf / 2), c: 'var(--s3)' },
              { k: 'TDS', v: cur.tds, c: 'var(--s4)' },
              { k: 'PT + ESI', v: cur.pt + cur.esi, c: 'var(--s2)' },
            ]} />
        </Card>
      </div>

      <Card title="Payroll runs" sub={`${PAYRUNS.length} cycles`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Period</th><th className="num">Employees</th><th className="num">Gross</th>
                <th className="num">Deductions</th><th className="num">Net payable</th>
                <th>Status</th><th>Processed by</th><th className="right">Action</th>
              </tr>
            </thead>
            <tbody>
              {trend.slice().reverse().map((t) => {
                const r = PAYRUNS.find((x) => x.mk === t.mk)!;
                return (
                  <tr key={t.mk}>
                    <td><b>{monthLabelLong(t.mk)}</b></td>
                    <td className="num">{t.t.count}</td>
                    <td className="num">{inr(t.t.gross)}</td>
                    <td className="num">{inr(t.t.ded)}</td>
                    <td className="num strong">{inr(t.t.net)}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td>{r.runOn ? `${r.by} · ${fmtD(r.runOn)}` : '—'}</td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => goRegister(t.mk)}>Register</button>{' '}
                      <button className="btn sm" onClick={() => {
                        app.toast('Publishing payslips for ' + monthLabelLong(t.mk) + '…');
                        setTimeout(() => app.toast(ACTIVE().length + ' payslips published to employee self-service', 'ok'), 700);
                      }}>Payslips</button>
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

/* ---------------- Salary register ---------------- */

function PyRegister({ mk, setMk }: { mk: string; setMk: (s: string) => void }) {
  const showSlip = useShowPayslip();
  const [q, setQ] = useState('');
  const list = ACTIVE().filter((e) => e.doj <= mk + '-28');
  const slips = list.map((e) => ({ e, p: payslip(e, mk) }));
  const t = payrollTotals(mk);

  const shown = q
    ? slips.filter((s) => (s.e.name + ' ' + s.e.code).toLowerCase().includes(q.toLowerCase()))
    : slips;

  const exportCsv = () =>
    downloadCSV(
      `salary_register_${mk}.csv`,
      [['Code', 'Name', 'Entity', 'Currency', 'Pay days', 'LOP', 'Basic', 'Allowances', 'Gross', 'Statutory', 'Tax', 'Net (local)', 'Net (INR)']].concat(
        sortBy(slips, (s) => s.e.name).map((s) => {
          const statEE = sum(s.p.ded.filter((d) => !TAX_RE.test(d.k) && !/Loan/.test(d.k)), (d) => d.a);
          const tax = sum(s.p.ded.filter((d) => TAX_RE.test(d.k)), (d) => d.a);
          return [s.e.code, s.e.name, s.e.country, s.e.ccy, String(s.p.payDays), String(s.p.lop),
            String(s.p.earn[0].a), String(sum(s.p.earn.slice(1), (x) => x.a)), String(s.p.gross),
            String(statEE), String(tax), String(s.p.net), String(toBase(s.p.net, s.e.ccy))];
        }),
      ),
    );

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={mk} onChange={(e) => setMk(e.target.value)}>
          {PAYRUNS.map((r) => <option key={r.mk} value={r.mk}>{monthLabelLong(r.mk)}</option>)}
        </select>
        <input className="input" placeholder="Search employee…" style={{ width: 210 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <span className="muted mono">Net {inr(t.net)}</span>
        <button className="btn" onClick={exportCsv}>⤓ Export register</button>
      </div>

      <Card title={'Salary register — ' + monthLabelLong(mk)} sub={`${list.length} employees`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 640, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Employee</th><th>Entity</th><th>Ccy</th><th className="num">Pay days</th>
                <th className="num">Basic</th><th className="num">Allowances</th><th className="num">Gross</th>
                <th className="num">Statutory</th><th className="num">Tax</th>
                <th className="num">Net (local)</th><th className="num">Net (₹ base)</th><th className="right" />
              </tr>
            </thead>
            <tbody>
              {sortBy(shown, (s) => s.e.name).map((s) => {
                const allow = sum(s.p.earn.slice(1), (x) => x.a);
                const statEE = sum(s.p.ded.filter((d) => !TAX_RE.test(d.k) && !/Loan/.test(d.k)), (d) => d.a);
                const tax = sum(s.p.ded.filter((d) => TAX_RE.test(d.k)), (d) => d.a);
                return (
                  <tr key={s.e.id}>
                    <td><PersonCell e={s.e} sub={s.e.code} /></td>
                    <td className="nowrap">{countryOf(s.e.country).flag} {s.e.country}</td>
                    <td>{s.e.ccy}</td>
                    <td className="num">
                      {s.p.payDays}/{s.p.dim}
                      {s.p.lop > 0 && <> <Badge kind="crit">{s.p.lop} LOP</Badge></>}
                    </td>
                    <td className="num">{m(s.e, s.p.earn[0].a)}</td>
                    <td className="num">{m(s.e, allow)}</td>
                    <td className="num strong">{m(s.e, s.p.gross)}</td>
                    <td className="num">{m(s.e, statEE)}</td>
                    <td className="num">{m(s.e, tax)}</td>
                    <td className="num strong">{m(s.e, s.p.net)}</td>
                    <td className="num muted">{mb(toBase(s.p.net, s.e.ccy))}</td>
                    <td className="right">
                      <button className="btn sm" onClick={() => showSlip(s.e.id, mk)}>Payslip</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                <td colSpan={6}>Total — {list.length} employees (converted to ₹ base)</td>
                <td className="num">{mb(t.gross)}</td>
                <td className="num">{mb(t.pf)}</td>
                <td className="num">{mb(t.tds)}</td>
                <td className="num">—</td>
                <td className="num">{mb(t.net)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Payroll inputs ---------------- */

function PyInputs({ mk, setMk }: { mk: string; setMk: (s: string) => void }) {
  const app = useApp();
  const showEmp = useShowEmployee();
  const run = PAYRUNS.find((r) => r.mk === mk) || CUR_RUN;
  const list = ACTIVE().filter((e) => e.doj <= mk + '-28');
  const inputs = PAY_INPUTS[mk] || (PAY_INPUTS[mk] = {});
  const withInput = list.filter((e) => inputs[e.id]);
  const tot = (k: 'bonus' | 'arrears' | 'incentive' | 'other' | 'reimb') => sum(withInput, (e) => inputs[e.id][k] || 0);
  const totalEmi = sum(list, (e) => loanEmiFor(e.id, mk));

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={mk} onChange={(e) => setMk(e.target.value)}>
          {PAYRUNS.map((r) => (
            <option key={r.mk} value={r.mk}>{monthLabelLong(r.mk)}{r.status === 'Paid' ? ' (locked)' : ''}</option>
          ))}
        </select>
        <StatusBadge status={run.status} />
        <div className="spacer" />
        <button className="btn" onClick={() => app.toast('Bulk upload is not wired in this build')}>⤒ Bulk upload</button>
        <button className="btn" onClick={() =>
          downloadCSV(`payroll_input_template_${mk}.csv`,
            [['Emp Code', 'Name', 'Bonus', 'Arrears', 'Incentive', 'Overtime/Other', 'Reimbursement']].concat(
              list.map((e) => [e.code, e.name, '', '', '', '', '']),
            ))}>⤓ Export template</button>
      </div>

      {run.status === 'Paid' && (
        <Banner kind="good" icon="🔒">
          {monthLabelLong(mk)} is locked. Corrections flow into the next cycle as arrears.
        </Banner>
      )}

      <div className="grid g5">
        <Tile label="Employees with inputs" value={withInput.length} foot={`Out of ${list.length} on payroll`} />
        <Tile label="Bonus & incentive" value={inr(tot('bonus') + tot('incentive'))} foot="One-time payments" />
        <Tile label="Arrears" value={inr(tot('arrears'))} foot="Retrospective revisions" />
        <Tile label="Overtime & other" value={inr(tot('other'))} foot="Approved extra hours" />
        <Tile label="Reimbursements" value={inr(tot('reimb'))} foot="Non-taxable, paid with salary" />
      </div>

      <Card title={'Payroll inputs — ' + monthLabelLong(mk)} sub="Anything on top of the standard salary structure" flush>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Employee</th><th>Department</th><th className="num">Bonus</th><th className="num">Arrears</th>
                <th className="num">Incentive</th><th className="num">Overtime / other</th>
                <th className="num">Reimbursement</th><th className="num">Loan recovery</th><th className="num">Net impact</th>
              </tr>
            </thead>
            <tbody>
              {withInput.length ? sortBy(withInput, (e) => e.name).map((e) => {
                const i = inputs[e.id];
                const emi = loanEmiFor(e.id, mk);
                const net = i.bonus + i.arrears + i.incentive + i.other + i.reimb - emi;
                return (
                  <tr key={e.id} className="clickable" onClick={() => showEmp(e.id)}>
                    <td><PersonCell e={e} sub={e.code} /></td>
                    <td className="nowrap">{deptOf(e.dept).name}</td>
                    <td className="num">{i.bonus ? inr(i.bonus) : '—'}</td>
                    <td className="num">{i.arrears ? inr(i.arrears) : '—'}</td>
                    <td className="num">{i.incentive ? inr(i.incentive) : '—'}</td>
                    <td className="num">{i.other ? inr(i.other) : '—'}</td>
                    <td className="num">{i.reimb ? inr(i.reimb) : '—'}</td>
                    <td className="num">{emi ? <span style={{ color: 'var(--crit)' }}>-{inr(emi)}</span> : '—'}</td>
                    <td className="num strong">{inr(net)}</td>
                  </tr>
                );
              }) : <tr><td colSpan={9}><EmptyState msg="No additional inputs for this cycle" icon="➕" /></td></tr>}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                <td colSpan={2}>Total</td>
                <td className="num">{inr(tot('bonus'))}</td>
                <td className="num">{inr(tot('arrears'))}</td>
                <td className="num">{inr(tot('incentive'))}</td>
                <td className="num">{inr(tot('other'))}</td>
                <td className="num">{inr(tot('reimb'))}</td>
                <td className="num">{inr(totalEmi)}</td>
                <td className="num">{inr(tot('bonus') + tot('arrears') + tot('incentive') + tot('other') + tot('reimb') - totalEmi)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Loan & advance recovery" sub="Automatically deducted this cycle" flush>
          <div className="tbl-wrap" style={{ maxHeight: 300, overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Scheme</th><th className="num">EMI</th><th className="num">Instalment</th><th className="num">Outstanding</th></tr></thead>
              <tbody>
                {LOANS.filter((l) => l.status === 'Active').length ? LOANS.filter((l) => l.status === 'Active').map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => showEmp(l.empId)}>
                    <td><PersonCell e={EMAP[l.empId]} /></td>
                    <td>{LOAN_TYPES.find((t) => t.id === l.type)?.n || l.type}</td>
                    <td className="num">{inr(l.emi)}</td>
                    <td className="num">{l.paidN + 1} / {l.tenure}</td>
                    <td className="num">{inr(l.outstanding)}</td>
                  </tr>
                )) : <tr><td colSpan={5}><EmptyState msg="No active loans" /></td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Reimbursements queued" sub="Approved expense claims flowing into payroll" flush>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {CLAIMS.filter((c) => c.status === 'Approved').length ? CLAIMS.filter((c) => c.status === 'Approved').slice(0, 12).map((c) => (
              <ListRow key={c.id}>
                <Avatar name={empName(c.empId)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{empName(c.empId)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{c.title}</div>
                </div>
                <span className="strong">{inr(c.total)}</span>
              </ListRow>
            )) : <EmptyState msg="Nothing pending reimbursement" />}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Bank & disbursal ---------------- */

function PyBank() {
  const app = useApp();
  const batches = sortBy(BANK_BATCHES, (b) => b.mk, 'desc');
  const totalPaid = sum(batches.filter((b) => b.status === 'Paid'), (b) => b.amount);
  const byBank = BANKS.map((b, i) => ({ k: b, c: PAL[i], v: ACTIVE().filter((e) => e.bank === b).length })).filter((r) => r.v);

  return (
    <div className="stack">
      <Banner kind={CUR_RUN.status === 'Paid' ? 'good' : 'info'} icon={<span style={{ fontSize: 19 }}>🏦</span>}
        title={'Salary disbursal — ' + monthLabelLong(CUR_RUN.mk)}
        actions={<button className="btn primary" onClick={() => app.toast('Bank advice generated', 'ok')}>⤓ Generate bank advice</button>}>
        {CUR_RUN.status === 'Paid'
          ? `Bank advice uploaded to ${BANKS[0]} · ${ACTIVE().length} beneficiaries · ${inr(payrollTotals(CUR_RUN.mk).net)} credited`
          : `Payroll is still in draft. Process the run to generate the NEFT advice file for ${ACTIVE().length} beneficiaries.`}
      </Banner>

      <div className="grid g4">
        <Tile label="Disbursed (8 cycles)" value={lakh(totalPaid)} foot={`${batches.filter((b) => b.status === 'Paid').length} successful batches`} />
        <Tile label="Beneficiaries" value={ACTIVE().length} foot="Active bank mandates" />
        <Tile label="Failed credits" value={0} foot="Returned by the bank" />
        <Tile label="Avg credit time" value="Same day" foot="NEFT before 4 PM cut-off" />
      </div>

      <div className="grid g-2-1">
        <Card title="Disbursal history" sub={`${batches.length} batches`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Period</th><th>Bank</th><th>Mode</th><th className="num">Beneficiaries</th>
                  <th className="num">Amount</th><th>Value date</th><th>UTR</th><th>Status</th><th className="right">File</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.mk}>
                    <td><b>{monthLabelLong(b.mk)}</b></td>
                    <td>{b.bank}</td>
                    <td>{b.mode}</td>
                    <td className="num">{b.count}</td>
                    <td className="num strong">{inr(b.amount)}</td>
                    <td className="nowrap">{fmtD(b.valueDate)}</td>
                    <td className="mono muted">{b.utr || '—'}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td className="right">
                      <button className="btn sm" onClick={() => app.toast('Advice file downloaded', 'ok')}>⤓</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Beneficiaries by bank" sub="Salary account distribution">
            <HBar rows={sortBy(byBank, (r) => -r.v)} />
          </Card>
          <Card title="Payout controls" sub="How money leaves the account">
            <KV rows={[
              ['Source account', `${BANKS[0]} · Current A/c ****4417`],
              ['Payment mode', 'NEFT bulk upload (IMPS above ₹2 L)'],
              ['Approval', 'Maker–checker: Finance prepares, CFO releases'],
              ['Cut-off', '4 PM on the last working day'],
              ['Reconciliation', 'UTR matched against the advice file next morning'],
            ]} />
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Compliance payments ---------------- */

function PyComply() {
  const app = useApp();
  const rows = sortBy(COMPLIANCE_PAYS, (c) => c.dueDate, 'desc');
  const overdue = rows.filter((c) => c.status === 'Overdue');
  const scheduled = rows.filter((c) => c.status === 'Scheduled');

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Paid this year" value={inr(sum(rows.filter((c) => c.status === 'Paid'), (c) => c.amount))}
          foot={`${rows.filter((c) => c.status === 'Paid').length} challans filed`} />
        <Tile label="Overdue" value={overdue.length} trend={overdue.length ? 'down' : undefined}
          foot={overdue.length ? inr(sum(overdue, (c) => c.amount)) + ' outstanding' : 'All up to date'} />
        <Tile label="Scheduled" value={scheduled.length} foot="Upcoming remittances" />
        <Tile label="Authorities" value={uniq(rows.map((c) => c.authority)).length} foot="Portals filed against" />
      </div>

      <Card title="Statutory remittances" sub={`${rows.length} entries across ${PAYRUNS.length} cycles`} flush
        actions={<button className="btn sm" onClick={() =>
          downloadCSV('compliance_payments.csv',
            [['Period', 'Type', 'Name', 'Amount', 'Due', 'Authority', 'Status', 'Challan', 'Paid on']].concat(
              rows.map((c) => [c.mk, c.type, c.name, String(c.amount), c.dueDate, c.authority, c.status, c.challan || '', c.paidOn || '']),
            ))}>⤓ Export</button>}>
        <div className="tbl-wrap" style={{ maxHeight: 600, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Period</th><th>Head</th><th className="num">Amount</th><th>Due date</th><th>Authority</th><th>Status</th><th>Challan</th><th className="right">Action</th></tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={i}>
                  <td className="nowrap">{monthLabelLong(c.mk)}</td>
                  <td><b>{c.name}</b></td>
                  <td className="num strong">{inr(c.amount)}</td>
                  <td className="nowrap">{fmtD(c.dueDate)}</td>
                  <td className="nowrap">{c.authority}</td>
                  <td>
                    <Badge kind={c.status === 'Paid' ? 'good' : c.status === 'Overdue' ? 'crit' : 'warn'}>{c.status}</Badge>
                  </td>
                  <td className="mono muted">{c.challan || '—'}</td>
                  <td className="right">
                    {c.status === 'Paid'
                      ? <span className="muted">{fmtD(c.paidOn)}</span>
                      : <button className="btn sm primary" onClick={() => app.toast('Challan generated for ' + c.name, 'ok')}>Pay</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Statutory ---------------- */

function PyStatutory({ mk, setMk }: { mk: string; setMk: (s: string) => void }) {
  const t = payrollTotals(mk);
  const list = ACTIVE().filter((e) => e.doj <= mk + '-28');
  const esiEligible = list.filter((e) => payslip(e, mk).gross <= 21000);
  const bySite = ['CHN', 'BLR', 'HYD', 'WFH']
    .map((s) => ({ site: siteOf(s), n: list.filter((e) => e.site === s).length, pt: list.filter((e) => e.site === s).length * siteOf(s).ptax }))
    .filter((r) => r.n);

  const stateOf = (id: string) => (id === 'CHN' || id === 'WFH' ? 'Tamil Nadu' : id === 'BLR' ? 'Karnataka' : 'Telangana');

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={mk} onChange={(e) => setMk(e.target.value)}>
          {PAYRUNS.map((r) => <option key={r.mk} value={r.mk}>{monthLabelLong(r.mk)}</option>)}
        </select>
        <div className="spacer" />
      </div>

      <div className="grid g4">
        <Tile label="EPF total" value={inr(t.pf)} foot={`ECR due 15 ${MON[+mk.split('-')[1] % 12]}`} />
        <Tile label="ESI total" value={inr(t.esi)} foot={`${esiEligible.length} employees under ₹21,000 gross`} />
        <Tile label="Professional tax" value={inr(t.pt)} foot="State-wise, remitted monthly" />
        <Tile label="TDS (24Q)" value={inr(t.tds)} foot="Quarterly return + Form 16 at year end" />
      </div>

      <div className="grid g2">
        <Card title="Provident Fund — EPFO" sub={'Establishment ' + ORG.cin.slice(0, 12)} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                <tr><td>Employee contribution (12% of basic, capped ₹15,000)</td><td className="num strong">{inr(Math.round(t.pf / 2))}</td></tr>
                <tr><td>Employer contribution — EPS 8.33% + EPF 3.67%</td><td className="num strong">{inr(Math.round(t.pf / 2))}</td></tr>
                <tr><td>EDLI + admin charges (0.5% + 0.5%)</td><td className="num strong">{inr(Math.round(t.pf * 0.04))}</td></tr>
                <tr><td><b>Total remittance</b></td><td className="num strong"><b>{inr(Math.round(t.pf * 1.04))}</b></td></tr>
              </tbody>
            </table>
          </div>
          <div style={{ padding: '11px 16px', borderTop: '1px solid var(--line)' }} className="muted">
            ECR file to be uploaded on the EPFO Unified Portal before the 15th of the following month.
          </div>
        </Card>

        <Card title="Employee State Insurance" sub="Applicable below ₹21,000 monthly gross" flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                <tr><td>Covered employees</td><td className="num strong">{esiEligible.length}</td></tr>
                <tr><td>Employee share (0.75%)</td><td className="num strong">{inr(Math.round((t.esi * 0.75) / 4))}</td></tr>
                <tr><td>Employer share (3.25%)</td><td className="num strong">{inr(Math.round((t.esi * 3.25) / 4))}</td></tr>
                <tr><td><b>Total remittance</b></td><td className="num strong"><b>{inr(t.esi)}</b></td></tr>
              </tbody>
            </table>
          </div>
          <div style={{ padding: '11px 16px', borderTop: '1px solid var(--line)' }} className="muted">
            Contribution period: April–September and October–March. Due by the 15th.
          </div>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Professional tax by state" sub="Monthly deduction per employee" flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Location</th><th>State</th><th className="num">Employees</th><th className="num">Rate</th><th className="num">Total</th></tr></thead>
              <tbody>
                {bySite.map((r) => (
                  <tr key={r.site.id}>
                    <td>{r.site.name}</td>
                    <td>{stateOf(r.site.id)}</td>
                    <td className="num">{r.n}</td>
                    <td className="num">{inr(r.site.ptax)}</td>
                    <td className="num strong">{inr(r.pt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Income tax (TDS) summary" sub={`${ORG.fy} · TAN ${ORG.tan}`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {([
                  ['Employees on New Regime', ACTIVE().filter((e) => DECL[e.id]?.regime === 'New').length],
                  ['Employees on Old Regime', ACTIVE().filter((e) => DECL[e.id]?.regime === 'Old').length],
                  ['Declarations submitted', `${ACTIVE().filter((e) => DECL[e.id]?.status !== 'Draft').length} / ${ACTIVE().length}`],
                  ['Proofs verified', ACTIVE().filter((e) => DECL[e.id]?.status === 'Verified').length],
                  ['TDS deducted this month', inr(t.tds)],
                  ['Projected annual TDS', inr(t.tds * 12)],
                ] as [string, string | number][]).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td className="num strong">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Salary structures (admin) ---------------- */

function PyStructures() {
  const layer = useLayer();
  const [q, setQ] = useState('');
  const list = sortBy(ACTIVE(), (e) => -e.ctc);
  const shown = q ? list.filter((e) => (e.name + ' ' + e.code).toLowerCase().includes(q.toLowerCase())) : list;

  const byGrade = (Object.keys(GRADES) as Grade[]).map((g, i) => ({
    k: GRADES[g].label, c: PAL[i], v: ACTIVE().filter((e) => e.grade === g).length,
  }));
  const costByDept = DEPTS.map((d) => ({
    k: d.name, c: d.color, v: sumBase(ACTIVE().filter((e) => e.dept === d.id), (e) => e.ctc),
  }));
  const medianBase = sortBy(ACTIVE().map((e) => toBase(e.ctc, e.ccy)))[Math.floor(ACTIVE().length / 2)];

  const showBreakup = (e: Employee) =>
    layer.modal({
      title: 'Salary breakup — ' + e.name,
      sub: `${countryOf(e.country).wage} ${m(e, e.ctc)} · ${GRADES[e.grade].label}`,
      size: 'wide',
      body: <StructureTable e={e} />,
    });

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Total annual cost" value={mbS(sumBase(ACTIVE(), (e) => e.ctc))}
          foot={`${ACTIVE().length} employees across ${uniq(ACTIVE().map((e) => e.country)).length} countries`} />
        <Tile label="Median package (₹ base)" value={mbS(medianBase)} foot="Normalised for comparison" />
        <Tile label="Highest band" value={GRADES.L6.label.split('·')[1]}
          foot={`Leadership · ${ACTIVE().filter((e) => e.grade === 'L6').length} employees`} />
        <Tile label="Avg employer burden"
          value={mbS(sumBase(ACTIVE(), (e) => sum(salaryStructure(e).benefits, (b) => b.a)) / ACTIVE().length)}
          foot="Statutory + benefits, per employee" />
      </div>

      <div className="grid g2">
        <Card title="CTC cost by department" sub="Annual">
          <HBar rows={sortBy(costByDept, (r) => -r.v)} fmt={(v) => mbS(v)} />
        </Card>
        <Card title="Headcount by grade" sub="Compensation bands">
          <HBar rows={byGrade} />
        </Card>
      </div>

      <Card title="Compensation master" sub={`${list.length} employees`} flush
        actions={
          <div className="row">
            <input className="input" placeholder="Search…" style={{ width: 190 }} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        }>
        <div className="tbl-wrap" style={{ maxHeight: 600, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Employee</th><th>Grade</th><th>Dept</th><th>Entity</th>
                <th className="num">Annual package</th><th className="num">₹ base</th>
                <th className="num">Basic</th><th className="num">Allowances</th>
                <th className="num">Employer cost</th><th className="num">Monthly gross</th><th className="right" />
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => {
                const s = salaryStructure(e);
                const ct = countryOf(e.country);
                return (
                  <tr key={e.id}>
                    <td><PersonCell e={e} sub={e.code} /></td>
                    <td><Badge>{e.grade}</Badge></td>
                    <td className="nowrap">{deptOf(e.dept).name}</td>
                    <td className="nowrap">{ct.flag} {e.ccy}</td>
                    <td className="num strong">{m(e, e.ctc)}</td>
                    <td className="num muted">{mbS(toBase(e.ctc, e.ccy))}</td>
                    <td className="num">{m(e, comp(s, 0))}</td>
                    <td className="num">{m(e, compAllow(s))}</td>
                    <td className="num">{m(e, sum(s.benefits, (b) => b.a))}</td>
                    <td className="num">{m(e, Math.round(s.grossA / 12))}</td>
                    <td className="right"><button className="btn sm" onClick={() => showBreakup(e)}>Breakup</button></td>
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

/* ---------------- My salary structure ---------------- */

function StructureTable({ e }: { e: Employee }) {
  const s = salaryStructure(e);
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr><th>Component</th><th className="num">Annual</th><th className="num">Monthly</th><th className="num">% of CTC</th></tr>
        </thead>
        <tbody>
          {s.earnings.map((x) => (
            <tr key={x.k}>
              <td>{x.k}</td><td className="num">{m(e, x.a)}</td>
              <td className="num">{m(e, x.a / 12)}</td><td className="num">{pct(x.a, e.ctc)}%</td>
            </tr>
          ))}
          <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
            <td>Gross salary</td><td className="num">{m(e, s.grossA)}</td>
            <td className="num">{m(e, s.grossA / 12)}</td><td className="num">{pct(s.grossA, e.ctc)}%</td>
          </tr>
          {s.benefits.map((x) => (
            <tr key={x.k}>
              <td>{x.k}</td><td className="num">{m(e, x.a)}</td>
              <td className="num">{m(e, x.a / 12)}</td><td className="num">{pct(x.a, e.ctc)}%</td>
            </tr>
          ))}
          <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
            <td>Total CTC</td><td className="num">{m(e, e.ctc)}</td>
            <td className="num">{m(e, e.ctc / 12)}</td><td className="num">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PyMyStructure() {
  const app = useApp();
  const e = app.me;
  const s = salaryStructure(e);
  const ct = countryOf(e.country);

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <Card title="Salary structure" sub={`${ct.flag} ${ct.wage} ${m(e, e.ctc)} · ${GRADES[e.grade].label}`} flush>
          <StructureTable e={e} />
        </Card>
        <Card title="CTC composition" sub={GRADES[e.grade].label}>
          <Donut size={160} center={mS(e, e.ctc)} centerSub={'annual ' + e.ccy} fmt={(v) => m(e, v)}
            slices={s.earnings.map((x, i) => ({ k: x.k, v: x.a, c: PAL[i] }))
              .concat(s.benefits.map((x, i) => ({ k: x.k, v: x.a, c: PAL[i + 4] })))} />
          <Legend items={s.earnings.map((x, i) => ({ k: x.k, c: PAL[i] }))
            .concat(s.benefits.map((x, i) => ({ k: x.k, c: PAL[i + 4] })))} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- My payslips ---------------- */

function PyMe() {
  const app = useApp();
  const showSlip = useShowPayslip();
  const e = app.me;
  const ct = countryOf(e.country);

  const runs = PAYRUNS.filter((r) => r.status === 'Paid' && r.mk >= e.doj.slice(0, 7));
  const slips = runs.map((r) => ({ r, p: payslip(e, r.mk) }));
  const fyStart = (TODAY.getMonth() >= 3 ? TODAY.getFullYear() : TODAY.getFullYear() - 1) + '-04';
  const ytd = slips.filter((s) => s.r.mk >= fyStart);

  const docs: [string, string][] = [
    ['Form 16 — ' + ORG.fy, 'Provisional, live computation'],
    ['Form 12BB declaration', DECL[e.id]?.status || 'Draft'],
    ['Salary certificate', 'For loans and visas'],
    [`PF passbook (UAN ${e.uan || '—'})`, 'EPFO portal'],
  ];

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Monthly net (latest)" value={m(e, slips.length ? slips[slips.length - 1].p.net : 0)}
          foot={slips.length ? monthLabelLong(slips[slips.length - 1].r.mk) : '—'} />
        <Tile label="YTD gross" value={mS(e, sum(ytd, (s) => s.p.gross))} foot={`${ytd.length} months this financial year`} />
        <Tile label="YTD tax withheld"
          value={m(e, sum(ytd, (s) => sum(s.p.ded.filter((d) => TAX_RE.test(d.k)), (d) => d.a)))}
          foot={ct.empTax} />
        <Tile label={ct.wage} value={mS(e, e.ctc)} foot={`${GRADES[e.grade].label} · ${ct.flag} ${e.ccy}`} />
      </div>

      <div className="grid g-2-1">
        <Card title="My payslips" sub={`${slips.length} available`} flush>
          <div className="tbl-wrap" style={{ maxHeight: 480, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Period</th><th className="num">Pay days</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net pay</th><th>Status</th><th className="right">Action</th></tr>
              </thead>
              <tbody>
                {slips.slice().reverse().map((s) => (
                  <tr key={s.r.mk}>
                    <td><b>{monthLabelLong(s.r.mk)}</b></td>
                    <td className="num">{s.p.payDays}/{s.p.dim}</td>
                    <td className="num">{m(e, s.p.gross)}</td>
                    <td className="num">{m(e, s.p.totalDed)}</td>
                    <td className="num strong">{m(e, s.p.net)}</td>
                    <td><StatusBadge status="Paid" /></td>
                    <td className="right nowrap"><button className="btn sm" onClick={() => showSlip(e.id, s.r.mk)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Net pay trend" sub={`Last ${slips.length} months`}>
            {slips.length > 0 && (
              <LineChart labels={slips.map((s) => monthLabel(s.r.mk).split(' ')[0])} height={180} padLeft={52} area
                fmt={(v) => m(e, v)} tickFmt={(v) => mS(e, v)}
                series={[{ name: 'Net pay', color: 'var(--s1)', data: slips.map((s) => s.p.net) }]} />
            )}
          </Card>
          <Card title="Tax documents" sub={ORG.fy} flush>
            {docs.map(([t, sub]) => (
              <ListRow key={t} onClick={() => app.toast('Opening ' + t)}>
                <span>📄</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{t}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>
                </div>
                <span className="muted">⤓</span>
              </ListRow>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Team cost (manager) ---------------- */

function PyTeamCost() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const team = teamOf(app.meId, true).map((i) => EMAP[i]);
  const ids = team.map((x) => x.id);
  const mk = PAYRUNS[PAYRUNS.length - 2].mk;
  const total = sum(team, (e) => e.ctc);

  const byGrade = (Object.keys(GRADES) as Grade[]).map((g, i) => ({
    k: GRADES[g].label, c: PAL[i], v: sum(team.filter((e) => e.grade === g), (e) => e.ctc),
  })).filter((r) => r.v);

  const recent = TS.filter((t) => ids.includes(t.empId) && t.weekStart >= ymd(mondayOf(addDays(TODAY, -28))));
  const billableCoverage = pct(
    sum(recent, (t) => sum(t.rows.filter((r) => projOf(r.proj).billable), (r) => sum(r.h))),
    Math.max(1, sum(recent, (t) => t.total)),
  );

  return (
    <div className="stack">
      <Banner icon="🔒" title="Aggregate view only">
        Individual salary details are visible to HR administrators and the employee. Managers see team cost in aggregate
        for budget planning.
      </Banner>

      <div className="grid g4">
        <Tile label="Team annual CTC" value={lakh(total)} foot={`${team.length} employees`} />
        <Tile label="Average CTC" value={lakh(total / Math.max(1, team.length))} foot="Per employee" />
        <Tile label="Monthly run rate" value={lakh(total / 12)} foot={monthLabelLong(mk)} />
        <Tile label="Billable coverage" value={billableCoverage + '%'} foot="Last 4 weeks" />
      </div>

      <div className="grid g2">
        <Card title="Cost by grade" sub="Annual CTC">
          <HBar rows={sortBy(byGrade, (r) => -r.v)} fmt={(v) => lakh(v)} />
        </Card>
        <Card title="Team composition" sub={`${team.length} people`} flush>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {sortBy(team, (e) => e.name).map((e) => (
              <ListRow key={e.id} onClick={() => showEmp(e.id)}>
                <Avatar name={e.name} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{e.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{e.designation}</div>
                </div>
                <Badge>{e.grade}</Badge>
              </ListRow>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'runs' | 'inputs' | 'reg' | 'bank' | 'comply' | 'stat' | 'struct' | 'me' | 'team';

function Payroll() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] =
    app.role === 'admin'
      ? [
          { v: 'runs', label: 'Payroll Runs' }, { v: 'inputs', label: 'Payroll Inputs' },
          { v: 'reg', label: 'Salary Register' }, { v: 'bank', label: 'Bank & Disbursal' },
          { v: 'comply', label: 'Compliance Payments' }, { v: 'stat', label: 'Statutory' },
          { v: 'struct', label: 'Salary Structures' }, { v: 'me', label: 'My Payslips' },
        ]
      : app.role === 'manager'
        ? [{ v: 'me', label: 'My Payslips' }, { v: 'team', label: 'Team Cost' }]
        : [{ v: 'me', label: 'My Payslips' }, { v: 'struct', label: 'My Salary Structure' }];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const [mk, setMk] = useState(PAYRUNS[PAYRUNS.length - 2].mk);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  const goRegister = (m2: string) => { setMk(m2); setTab('reg'); };

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'runs' && <PyRuns goRegister={goRegister} />}
      {active === 'inputs' && <PyInputs mk={mk} setMk={setMk} />}
      {active === 'reg' && <PyRegister mk={mk} setMk={setMk} />}
      {active === 'bank' && <PyBank />}
      {active === 'comply' && <PyComply />}
      {active === 'stat' && <PyStatutory mk={mk} setMk={setMk} />}
      {active === 'struct' && (app.role === 'admin' ? <PyStructures /> : <PyMyStructure />)}
      {active === 'me' && <PyMe />}
      {active === 'team' && <PyTeamCost />}
    </>
  );
}

registerModule({
  key: 'payroll',
  title: TITLES.payroll,
  subtitle: () => 'India payroll · PF, ESI, Professional Tax and TDS',
  Component: Payroll,
});
