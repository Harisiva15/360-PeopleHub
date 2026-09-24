import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { fmtD, MON, monthLabel, monthLabelLong, TODAY } from '../../lib/dates';
import { inr, lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { countryOf, mb, mbS, money, moneyShort, sumBase, toBase } from '../../data/countries';
import { LOAN_TYPES } from '../../data/loans';
import { BANKS, DEPTS, deptOf, GRADES, ORG, siteOf } from '../../data/org';
import {
  useActiveLoans, useApprovedClaims, useBankBatches, useCompensation, useCompliancePayments,
  useCurrentRun, useDeclarations, usePayInputs, usePayRuns, usePayrollTotals,
  useProcessRun, usePayrollTotalsFor, usePayslipHistory, useRegister, useStructure,
  useVisiblePeople,
} from './data';
import { Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile, StatRow } from '../../components/ui';
import { ListRow, StatusBadge } from '../../components/common';
import { BarChart, Donut, HBar, Legend, LineChart, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { notBacked } from '../../components/NotBacked';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { useShowPayslip } from './Payslip';
import { useTabFromUrl } from '../tabParam';
import { ProcessConfirmation } from './ProcessConfirm';
import { CompensationPanel, ReviseForm } from './Compensation';
import type { StructureRow } from '../../services';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import type { Employee } from '../../types/employee';
import type { SalaryStructure } from '../../services';
import type { Grade } from '../../types/country';
import { Icon } from '../../components/icons';

const m = (e: Employee, a: number) => money(a, e.ccy);
const mS = (e: Employee, a: number) => moneyShort(a, e.ccy);

/** Deductions split into statutory vs income tax, by label. */
const TAX_RE = /Tax|TDS|PAYE/;

/* ---------------- Payroll runs ---------------- */

function PyRuns({ goRegister }: { goRegister: (mk: string) => void }) {
  const app = useApp();
  const layer = useLayer();
  const { data: runs = [] } = usePayRuns();
  const { data: curRun } = useCurrentRun();
  const { data: cur } = usePayrollTotals(curRun?.mk ?? '');
  const processRun = useProcessRun();
  const { data: allTotals = {} } = usePayrollTotalsFor(runs.map((r) => r.mk));
  if (!curRun || !cur) return <EmptyState msg="Loading payroll…" icon={<Icon n="rupee" size="lg" />} />;

  /*
   * Nothing processed yet, said plainly.
   *
   * A draft cycle's figures are a projection computed from today's structures
   * and stored nowhere — that is deliberate, so finance can see the month
   * before committing to it. But tiles reading "Net payable" over a cycle
   * nobody has run describe a payment that is not going to happen, and a chart
   * of zeros looks like a payroll that paid nothing rather than one that has
   * not been run. So the projection is labelled, and a company with no
   * employees to project from gets a sentence instead of a dashboard.
   */
  const nothingToPay = cur.count === 0;
  if (nothingToPay) {
    return (
      <div className="stack">
        <EmptyState
          icon={<Icon n="rupee" size="lg" />}
          msg={`No payroll records for ${monthLabelLong(curRun.mk)}. `
            + 'Nobody is on the payroll for this period, so there is nothing to '
            + 'process, project or pay.'}
        />
      </div>
    );
  }

  const CUR_RUN = curRun;
  const PAYRUNS = runs;
  const trend = runs.filter((r) => allTotals[r.mk]).map((r) => ({ mk: r.mk, t: allTotals[r.mk] }));

  /*
   * Processing is irreversible — it locks the cycle, freezes payslips and
   * generates a bank advice — so it goes through a confirmation that names the
   * month and the head count. It used to be one click, and a live September
   * cycle was processed that way by accident.
   *
   * The dialog is not the protection. The server refuses a paid, locked,
   * cancelled or in-progress cycle while holding the row, so a second request
   * is declined rather than overwriting the first one's payslips.
   */
  const confirmProcess = (mk: string, totals: { count: number; gross: number; net: number }) =>
    layer.modal({
      title: 'Process payroll',
      sub: monthLabelLong(mk),
      size: 'narrow',
      body: (close: () => void) => (
        <ProcessConfirmation
          run={{ mk, count: totals.count, gross: totals.gross, net: totals.net }}
          close={close}
          onConfirm={async () => {
            await processRun.mutate(mk);
            app.toast(`${monthLabelLong(mk)} payroll processed — bank advice generated`, 'ok');
          }}
        />
      ),
      footer: null,
    });

  return (
    <div className="stack">
      <Banner kind={CUR_RUN.status === 'Paid' ? 'good' : 'info'}
        icon={<span style={{ fontSize: 19 }}>{CUR_RUN.status === 'Paid' ? '✅' : '🧾'}</span>}
        title={`${monthLabelLong(CUR_RUN.mk)} payroll — ${CUR_RUN.status}`}
        actions={CUR_RUN.locked || CUR_RUN.status === 'Paid'
          ? <Badge kind="good"><Icon n="lock" /> Locked</Badge>
          : <button className="btn primary" disabled={processRun.pending}
              onClick={() => confirmProcess(CUR_RUN.mk, cur)}>Process payroll</button>}>
        {cur.count} employees · gross {inr(cur.gross)} · deductions {inr(cur.ded)} · <b>net payable {inr(cur.net)}</b>
        {CUR_RUN.status !== 'Paid' && (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            A projection from today&rsquo;s salary structures. Nothing is stored
            until the cycle is processed, and the figures will move if a
            compensation or an attendance record changes before then.
          </div>
        )}
      </Banner>

      <StatRow cols={5}>
        <Tile label="Net payable" value={lakh(cur.net)} foot={`${monthLabel(CUR_RUN.mk)} · ${cur.count} employees`} />
        <Tile label="Gross earnings" value={lakh(cur.gross)} foot="Before statutory deductions" />
        <Tile label="PF (EE + ER)" value={lakh(cur.pf)} foot="Due to EPFO by 15th" />
        <Tile label="TDS" value={lakh(cur.tds)} foot="Due to IT dept by 7th" />
        <Tile label="LOP days" value={cur.lop} foot="Unapproved absences this month" />
      </StatRow>

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
                    <td className="nowrap">
                      <StatusBadge status={r.status} />
                      {/*
                        * Locked is a separate fact from the status. The schema's
                        * CHECK only runs one way — a paid run is always locked —
                        * so a cycle can be closed without being paid, and a
                        * screen showing only the status would not say so.
                        */}
                      {r.locked && (
                        <> <Badge kind="good"><Icon n="lock" /> Locked</Badge></>
                      )}
                    </td>
                    <td>{r.runOn ? `${r.by} · ${fmtD(r.runOn)}` : '—'}</td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => goRegister(t.mk)}>Register</button>{' '}
                      <button className="btn sm"
                        {...notBacked('a payslip is visible to its owner as soon as the cycle is processed — there is no separate publish step')}
                      >Payslips</button>
                      {/* Processing is offered per row only where it is possible. */}
                      {!r.locked && r.status !== 'Paid' && (
                        <> <button className="btn sm primary" disabled={processRun.pending}
                          onClick={() => confirmProcess(t.mk, t.t)}>Process</button></>
                      )}
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
  const { data: rows = [] } = useRegister(mk);
  const { data: runs = [] } = usePayRuns();
  const { data: totals } = usePayrollTotals(mk);
  const slips = rows.map((r) => ({ e: r.employee, p: r.payslip }));
  const list = slips.map((x) => x.e);
  if (!totals) return <EmptyState msg="Loading the register…" icon={<Icon n="rupee" size="lg" />} />;
  const t = totals;

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
          {runs.map((r) => <option key={r.mk} value={r.mk}>{monthLabelLong(r.mk)}</option>)}
        </select>
        <input className="input" placeholder="Search employee…" style={{ width: 210 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="spacer" />
        <span className="muted mono">Net {inr(t.net)}</span>
        <button className="btn" onClick={exportCsv}><Icon n="download" size="lg" /> Export register</button>
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
  const showEmp = useShowEmployee();
  const { data: runs = [] } = usePayRuns();
  const { data: curRun } = useCurrentRun();
  const { data: rows = [] } = useRegister(mk);
  const { data: inputs = {} } = usePayInputs(mk);
  const { data: loans = [] } = useActiveLoans();
  const { data: claims = [] } = useApprovedClaims();
  const dir = useVisiblePeople();
  const PAYRUNS = runs;
  const run = runs.find((r) => r.mk === mk) || curRun;
  const list = rows.map((r) => r.employee);
  const withInput = list.filter((e) => inputs[e.id]);
  const tot = (k: 'bonus' | 'arrears' | 'incentive' | 'other' | 'reimb') => sum(withInput, (e) => inputs[e.id][k] || 0);
  const totalEmi = sum(rows, (r) => r.loanEmi);
  const emiFor = (id: string) => rows.find((r) => r.employee.id === id)?.loanEmi ?? 0;
  if (!run) return <EmptyState msg="Loading payroll inputs…" icon={<Icon n="rupee" size="lg" />} />;

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
        <button className="btn" onClick={() =>
          downloadCSV(`payroll_input_template_${mk}.csv`,
            [['Emp Code', 'Name', 'Bonus', 'Arrears', 'Incentive', 'Overtime/Other', 'Reimbursement']].concat(
              list.map((e) => [e.code, e.name, '', '', '', '', '']),
            ))}><Icon n="download" size="lg" /> Export template</button>
      </div>

      {run.status === 'Paid' && (
        <Banner kind="good" icon={<Icon n="lock" size="lg" />}>
          {monthLabelLong(mk)} is locked. Corrections flow into the next cycle as arrears.
        </Banner>
      )}

      <Banner kind="info" icon={<Icon n="add" size="lg" />} title="Inputs are entered outside the app for now">
        This is a read-only view of what payroll will pick up. Bonus, arrears and
        incentive rows are keyed straight into the pay run; entering or importing
        them here is not built yet, and the export below gives you the template in
        the meantime.
      </Banner>

      <StatRow cols={5}>
        <Tile label="Employees with inputs" value={withInput.length} foot={`Out of ${list.length} on payroll`} />
        <Tile label="Bonus & incentive" value={inr(tot('bonus') + tot('incentive'))} foot="One-time payments" />
        <Tile label="Arrears" value={inr(tot('arrears'))} foot="Retrospective revisions" />
        <Tile label="Overtime & other" value={inr(tot('other'))} foot="Approved extra hours" />
        <Tile label="Reimbursements" value={inr(tot('reimb'))} foot="Non-taxable, paid with salary" />
      </StatRow>

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
                const emi = emiFor(e.id);
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
              }) : <tr><td colSpan={9}><EmptyState msg="No additional inputs for this cycle" icon={<Icon n="add" size="lg" />} /></td></tr>}
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
                {loans.length ? loans.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => showEmp(l.empId)}>
                    <td>{dir.byId(l.empId) && <PersonCell e={dir.byId(l.empId)!} />}</td>
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
            {claims.length ? claims.slice(0, 12).map((c) => (
              <ListRow key={c.id}>
                <Avatar name={dir.name(c.empId)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(c.empId)}</div>
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
  const { data: rawBatches = [] } = useBankBatches();
  const { data: curRun } = useCurrentRun();
  const { data: curTotals } = usePayrollTotals(curRun?.mk ?? '');
  const everyone = useVisiblePeople().list;
  const batches = sortBy(rawBatches, (b) => b.mk, 'desc');
  const totalPaid = sum(batches.filter((b) => b.status === 'Paid'), (b) => b.amount);
  const byBank = BANKS.map((b, i) => ({ k: b, c: PAL[i], v: everyone.filter((e) => e.bank === b).length })).filter((r) => r.v);
  if (!curRun || !curTotals) return <EmptyState msg="Loading disbursal…" icon={<Icon n="bank" size="lg" />} />;
  const CUR_RUN = curRun;

  return (
    <div className="stack">
      <Banner kind={CUR_RUN.status === 'Paid' ? 'good' : 'info'} icon={<span style={{ fontSize: 19 }}>🏦</span>}
        title={'Salary disbursal — ' + monthLabelLong(CUR_RUN.mk)}
        actions={<button className="btn primary"
          {...notBacked('the advice is built when the cycle is processed, and appears in the history below')}
        ><Icon n="download" size="lg" /> Generate bank advice</button>}>
        {CUR_RUN.status === 'Paid'
          ? `Bank advice uploaded to ${BANKS[0]} · ${curTotals.count} beneficiaries · ${inr(curTotals.net)} credited`
          : `Payroll is still in draft. Process the run to generate the NEFT advice file for ${curTotals.count} beneficiaries.`}
      </Banner>

      <StatRow cols={4}>
        <Tile label="Disbursed (8 cycles)" value={lakh(totalPaid)} foot={`${batches.filter((b) => b.status === 'Paid').length} successful batches`} />
        <Tile label="Beneficiaries" value={curTotals.count} foot="Active bank mandates" />
        <Tile label="Failed credits" value={0} foot="Returned by the bank" />
        <Tile label="Avg credit time" value="Same day" foot="NEFT before 4 PM cut-off" />
      </StatRow>

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
                      {/*
                        * The batch summary, not the NEFT file. What is held is
                        * one row per cycle — bank, mode, count, amount, UTR —
                        * so that is what downloads and what the label says.
                        * Calling it the advice file would promise the payment
                        * instruction itself, which is not stored here.
                        */}
                      <button className="btn sm" title="Download this batch as CSV"
                        onClick={() => {
                          downloadCSV(`bank_batch_${b.mk}.csv`, [
                            ['Period', 'Bank', 'Mode', 'Beneficiaries', 'Amount', 'Value date', 'UTR', 'Status'],
                            [monthLabelLong(b.mk), b.bank, b.mode, b.count, b.amount, b.valueDate ?? '', b.utr || '', b.status],
                          ]);
                          app.toast('Batch summary downloaded', 'ok');
                        }}>⤓</button>
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
  const { data: pays = [] } = useCompliancePayments();
  const { data: runs = [] } = usePayRuns();
  const rows = sortBy(pays, (c) => c.dueDate, 'desc');
  const overdue = rows.filter((c) => c.status === 'Overdue');
  const scheduled = rows.filter((c) => c.status === 'Scheduled');

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Paid this year" value={inr(sum(rows.filter((c) => c.status === 'Paid'), (c) => c.amount))}
          foot={`${rows.filter((c) => c.status === 'Paid').length} challans filed`} />
        <Tile label="Overdue" value={overdue.length} trend={overdue.length ? 'down' : undefined}
          foot={overdue.length ? inr(sum(overdue, (c) => c.amount)) + ' outstanding' : 'All up to date'} />
        <Tile label="Scheduled" value={scheduled.length} foot="Upcoming remittances" />
        <Tile label="Authorities" value={uniq(rows.map((c) => c.authority)).length} foot="Portals filed against" />
      </StatRow>

      <Card title="Statutory remittances" sub={`${rows.length} entries across ${runs.length} cycles`} flush
        actions={<button className="btn sm" onClick={() =>
          downloadCSV('compliance_payments.csv',
            [['Period', 'Type', 'Name', 'Amount', 'Due', 'Authority', 'Status', 'Challan', 'Paid on']].concat(
              rows.map((c) => [c.mk, c.type, c.name, String(c.amount), c.dueDate, c.authority, c.status, c.challan || '', c.paidOn || '']),
            ))}><Icon n="download" size="lg" /> Export</button>}>
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
                      : <button className="btn sm primary"
                          {...notBacked('remittance is recorded outside the product; there is no challan generator yet')}
                        >Pay</button>}
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
  const { data: totals } = usePayrollTotals(mk);
  const { data: regRows = [] } = useRegister(mk);
  const { data: decls = {} } = useDeclarations();
  const { data: runs = [] } = usePayRuns();
  const list = regRows.map((r) => r.employee);
  if (!totals) return <EmptyState msg="Loading statutory summary…" icon={<Icon n="policy" size="lg" />} />;
  const t = totals;
  const esiEligible = regRows.filter((r) => r.payslip.gross <= 21000).map((r) => r.employee);
  const bySite = ['CHN', 'BLR', 'HYD', 'WFH']
    .map((s) => ({ site: siteOf(s), n: list.filter((e) => e.site === s).length, pt: list.filter((e) => e.site === s).length * siteOf(s).ptax }))
    .filter((r) => r.n);

  const stateOf = (id: string) => (id === 'CHN' || id === 'WFH' ? 'Tamil Nadu' : id === 'BLR' ? 'Karnataka' : 'Telangana');

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={mk} onChange={(e) => setMk(e.target.value)}>
          {runs.map((r) => <option key={r.mk} value={r.mk}>{monthLabelLong(r.mk)}</option>)}
        </select>
        <div className="spacer" />
      </div>

      <StatRow cols={4}>
        <Tile label="EPF total" value={inr(t.pf)} foot={`ECR due 15 ${MON[+mk.split('-')[1] % 12]}`} />
        <Tile label="ESI total" value={inr(t.esi)} foot={`${esiEligible.length} employees under ₹21,000 gross`} />
        <Tile label="Professional tax" value={inr(t.pt)} foot="State-wise, remitted monthly" />
        <Tile label="TDS (24Q)" value={inr(t.tds)} foot="Quarterly return + Form 16 at year end" />
      </StatRow>

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
                  ['Employees on New Regime', list.filter((e) => decls[e.id]?.regime === 'New').length],
                  ['Employees on Old Regime', list.filter((e) => decls[e.id]?.regime === 'Old').length],
                  ['Declarations submitted', `${list.filter((e) => decls[e.id]?.status !== 'Draft').length} / ${list.length}`],
                  ['Proofs verified', list.filter((e) => decls[e.id]?.status === 'Verified').length],
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
  const { data: rows = [] } = useCompensation();
  const salaryOf = new Map(rows.map((r) => [r.employee.id, r]));
  const everyone = rows.map((r) => r.employee);
  const list = sortBy(everyone, (e) => -e.ctc);
  const shown = q ? list.filter((e) => (e.name + ' ' + e.code).toLowerCase().includes(q.toLowerCase())) : list;

  const byGrade = (Object.keys(GRADES) as Grade[]).map((g, i) => ({
    k: GRADES[g].label, c: PAL[i], v: everyone.filter((e) => e.grade === g).length,
  }));
  const costByDept = DEPTS.map((d) => ({
    k: d.name, c: d.color, v: sumBase(everyone.filter((e) => e.dept === d.id), (e) => e.ctc),
  }));
  const medianBase = sortBy(everyone.map((e) => toBase(e.ctc, e.ccy)))[Math.floor(everyone.length / 2)];

  const showBreakup = (e: Employee) =>
    layer.modal({
      title: 'Salary breakup — ' + e.name,
      sub: `${countryOf(e.country).wage} ${m(e, e.ctc)} · ${GRADES[e.grade].label}`,
      size: 'wide',
      body: <StructureTable e={e} s={salaryOf.get(e.id)!.salary} />,
    });

  /*
   * Compensation is a drawer rather than another column. What somebody is paid,
   * what they were paid before and why it changed is a record in its own right,
   * and squeezing it into the master table would flatten the history into a
   * single current number — which is exactly the shape that made revising pay
   * look like editing a field.
   */
  const revise = (e: Employee, current: StructureRow | undefined) =>
    layer.modal({
      title: `Revise compensation — ${e.name}`,
      sub: 'A new version. The one in force is closed, not replaced.',
      size: 'narrow',
      body: (close: () => void) => (
        <ReviseForm person={e} current={current} close={close} />
      ),
      footer: null,
    });

  const showCompensation = (e: Employee) =>
    layer.drawer({
      title: e.name,
      sub: `${e.code} · ${deptOf(e.dept).name} · ${e.designation}`,
      body: (
        <CompensationPanel
          person={e}
          canRevise
          onRevise={(current) => revise(e, current)}
        />
      ),
    });

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Total annual cost" value={mbS(sumBase(everyone, (e) => e.ctc))}
          foot={`${everyone.length} employees across ${uniq(everyone.map((e) => e.country)).length} countries`} />
        <Tile label="Median package (₹ base)" value={mbS(medianBase)} foot="Normalised for comparison" />
        <Tile label="Highest band" value={GRADES.L6.label.split('·')[1]}
          foot={`Leadership · ${everyone.filter((e) => e.grade === 'L6').length} employees`} />
        <Tile label="Avg employer burden"
          value={mbS(sumBase(everyone, (e) => sum(salaryOf.get(e.id)!.salary.benefits, (b) => b.a)) / Math.max(1, everyone.length))}
          foot="Statutory + benefits, per employee" />
      </StatRow>

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
                const s = salaryOf.get(e.id)!.salary;
                const ct = countryOf(e.country);
                return (
                  <tr key={e.id}>
                    <td><PersonCell e={e} sub={e.code} /></td>
                    <td><Badge>{e.grade}</Badge></td>
                    <td className="nowrap">{deptOf(e.dept).name}</td>
                    <td className="nowrap">{ct.flag} {e.ccy}</td>
                    <td className="num strong">{m(e, e.ctc)}</td>
                    <td className="num muted">{mbS(toBase(e.ctc, e.ccy))}</td>
                    <td className="num">{m(e, salaryOf.get(e.id)!.basicAnnual)}</td>
                    <td className="num">{m(e, salaryOf.get(e.id)!.allowanceAnnual)}</td>
                    <td className="num">{m(e, sum(s.benefits, (b) => b.a))}</td>
                    <td className="num">{m(e, Math.round(s.grossA / 12))}</td>
                    <td className="right nowrap">
                      <button className="btn sm" onClick={() => showBreakup(e)}>Breakup</button>{' '}
                      <button className="btn sm" onClick={() => showCompensation(e)}>Compensation</button>
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

/* ---------------- My salary structure ---------------- */

function StructureTable({ e, s }: { e: Employee; s: SalaryStructure }) {
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
  const { data: s } = useStructure(e.id);
  const ct = countryOf(e.country);
  if (!s) return <EmptyState msg="Loading your salary structure…" icon={<Icon n="rupee" size="lg" />} />;

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <Card title="Salary structure" sub={`${ct.flag} ${ct.wage} ${m(e, e.ctc)} · ${GRADES[e.grade].label}`} flush>
          <StructureTable e={e} s={s} />
        </Card>
        <Card title="CTC composition" sub={GRADES[e.grade].label}>
          <Donut size={160} center={mS(e, e.ctc)} centerSub={'annual ' + e.ccy} fmt={(v) => m(e, v)}
            slices={s.earnings.map((x, i) => ({ k: x.k, v: x.a, c: PAL[i] }))
              .concat(s.benefits.map((x, i) => ({ k: x.k, v: x.a, c: PAL[i + 4] })))} />
          <Legend items={s.earnings.map((x, i) => ({ k: x.k, c: PAL[i] }))
            .concat(s.benefits.map((x, i) => ({ k: x.k, c: PAL[i + 4] })))} />
        </Card>
      </div>

      {/*
        * Your own compensation and how it has changed.
        *
        * Read-only for everybody here, including an administrator looking at
        * their own record: revising pay is done from the compensation master,
        * where the act is visibly about somebody rather than about yourself.
        * The service refuses it either way — this is so the button is not
        * offered where it should not be pressed.
        */}
      <CompensationPanel person={e} canRevise={false} onRevise={() => {}} />
    </div>
  );
}

/* ---------------- My payslips ---------------- */

function PyMe() {
  const app = useApp();
  const showSlip = useShowPayslip();
  const e = app.me;
  const ct = countryOf(e.country);

  const { data: history = [] } = usePayslipHistory(e.id);
  const { data: decls = {} } = useDeclarations();
  const slips = history.map((h) => ({ r: h.run, p: h.payslip }));
  const fyStart = (TODAY.getMonth() >= 3 ? TODAY.getFullYear() : TODAY.getFullYear() - 1) + '-04';
  const ytd = slips.filter((s) => s.r.mk >= fyStart);

  const docs: [string, string][] = [
    ['Form 16 — ' + ORG.fy, 'Provisional, live computation'],
    ['Form 12BB declaration', decls[e.id]?.status || 'Draft'],
    ['Salary certificate', 'For loans and visas'],
    [`PF passbook (UAN ${e.uan || '—'})`, 'EPFO portal'],
  ];

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Monthly net (latest)" value={m(e, slips.length ? slips[slips.length - 1].p.net : 0)}
          foot={slips.length ? monthLabelLong(slips[slips.length - 1].r.mk) : '—'} />
        <Tile label="YTD gross" value={mS(e, sum(ytd, (s) => s.p.gross))} foot={`${ytd.length} months this financial year`} />
        <Tile label="YTD tax withheld"
          value={m(e, sum(ytd, (s) => sum(s.p.ded.filter((d) => TAX_RE.test(d.k)), (d) => d.a)))}
          foot={ct.empTax} />
        <Tile label={ct.wage} value={mS(e, e.ctc)} foot={`${GRADES[e.grade].label} · ${ct.flag} ${e.ccy}`} />
      </StatRow>

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
                <span><Icon n="document" size="lg" /> </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{t}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>
                </div>
                <span className="muted"><Icon n="download" size="lg" /> </span>
              </ListRow>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'runs' | 'inputs' | 'reg' | 'bank' | 'comply' | 'stat' | 'struct' | 'me';

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
        ? [{ v: 'me', label: 'My Payslips' }]
        : [{ v: 'me', label: 'My Payslips' }, { v: 'struct', label: 'My Salary Structure' }];

  const [tab, setTab] = useTabFromUrl<Tab>(tabs[0]!.v, tabs.map((t) => t.v));
  const { data: runs = [] } = usePayRuns();
  const [picked, setPicked] = useState('');
  /* Default to the last closed cycle once the runs arrive. */
  const mk = picked || runs[runs.length - 2]?.mk || '';
  const setMk = setPicked;
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
    </>
  );
}

registerModule({
  key: 'payroll',
  title: TITLES.payroll,
  Component: Payroll,
});
