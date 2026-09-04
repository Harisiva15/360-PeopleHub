import { sortBy, sum } from '../../lib/collections';
import { monthLabel, monthLabelLong } from '../../lib/dates';
import { inr, lakh } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { DEPTS, deptOf, ORG, SITES } from '../../data/org';
import { EXP_CATS } from '../../data/expenses';
import { BarChart, HBar, Legend, LineChart, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Badge, Card, PersonCell, Table, TableWrap, Tile } from '../../components/ui';
import { useShowEmployee } from '../employees/Profile';
import {
  useActiveLoans, useAllEmployees, useClaimsIn, useCompensation, useFbpTotals, usePayRuns,
  usePayrollTotalsFor, useRegister,
} from './data';
import { RepHead } from './shared';

/** Group insurance premium per head — GMC, GPA and GTL bundled. */
const INSURANCE_PER_HEAD = 14500;

/* ---------- Payroll cost analysis ---------- */

export function RepPayroll() {
  const { data: payRuns = [] } = usePayRuns();
  const { data: totalsBy = {} } = usePayrollTotalsFor(payRuns.map((r) => r.mk));
  const { data: comp = [] } = useCompensation();
  const runs = payRuns.filter((r) => totalsBy[r.mk]).map((r) => ({ r, t: totalsBy[r.mk] }));
  const grossOf = new Map(comp.map((c) => [c.employee.id, c.salary.grossA]));
  const everyone = comp.map((c) => c.employee);

  const byDept: HBarRow[] = DEPTS.map((d) => ({
    k: d.name,
    c: d.color,
    v: sum(everyone.filter((e) => e.dept === d.id), (e) => (grossOf.get(e.id) ?? 0) / 12),
  }));
  const bySite: HBarRow[] = SITES.filter((s) => s.lat).map((s, i) => ({
    k: s.name,
    c: PAL[i],
    v: sum(everyone.filter((e) => e.site === s.id), (e) => (grossOf.get(e.id) ?? 0) / 12),
  }));
  if (!runs.length) return <RepHead title="Payroll Cost Analysis" sub="Loading…" onExport={() => {}} />;
  const last = runs[runs.length - 1];

  const exportCSV = () =>
    downloadCSV('report_payroll.csv', [
      ['Period', 'Employees', 'Gross', 'PF', 'ESI', 'PT', 'TDS', 'Deductions', 'Net', 'LOP days'],
      ...runs.map(({ r, t }) => [monthLabelLong(r.mk), t.count, t.gross, t.pf, t.esi, t.pt, t.tds, t.ded, t.net, t.lop]),
    ]);

  const trend = [
    { name: 'Gross', color: 'var(--s1)', data: runs.map((r) => r.t.gross) },
    { name: 'Net paid', color: 'var(--s3)', data: runs.map((r) => r.t.net) },
    { name: 'Deductions', color: 'var(--s2)', data: runs.map((r) => r.t.ded) },
  ];

  return (
    <>
      <RepHead
        title="Payroll Cost Analysis"
        sub={`Last ${runs.length} payroll cycles · ${everyone.length} employees`}
        onExport={exportCSV}
      />
      <div className="stack">
        <div className="grid g4">
          <Tile label="Monthly gross" value={lakh(last.t.gross)} foot={monthLabelLong(last.r.mk)} />
          <Tile label="Annual run rate" value={lakh(last.t.gross * 12)} foot="Projected at current headcount" />
          <Tile label="Statutory cost" value={lakh(last.t.pf + last.t.esi + last.t.pt)} foot="PF + ESI + PT" />
          <Tile label="Avg cost per employee" value={inr(last.t.gross / Math.max(1, last.t.count))} foot="Monthly gross" />
        </div>

        <Card title="Payroll cost trend" sub="Gross, deductions and net">
          <LineChart
            labels={runs.map((r) => monthLabel(r.r.mk).split(' ')[0])}
            height={250}
            padLeft={58}
            area
            fmt={(v) => inr(v)}
            tickFmt={(v) => lakh(v)}
            series={trend}
          />
          <Legend items={trend.map((s) => ({ k: s.name, c: s.color }))} />
        </Card>

        <div className="grid g2">
          <Card title="Monthly cost by department" sub="Gross salary">
            <HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => lakh(v)} />
          </Card>
          <Card title="Monthly cost by location" sub="Gross salary">
            <HBar rows={sortBy(bySite, (r) => -r.v)} fmt={(v) => lakh(v)} />
          </Card>
        </div>

        <Card title="Payroll register summary" sub={`${runs.length} cycles`} flush>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Employees</th>
                  <th className="num">Gross</th>
                  <th className="num">PF</th>
                  <th className="num">ESI</th>
                  <th className="num">PT</th>
                  <th className="num">TDS</th>
                  <th className="num">Net paid</th>
                  <th className="num">LOP days</th>
                </tr>
              </thead>
              <tbody>
                {runs
                  .slice()
                  .reverse()
                  .map(({ r, t }) => (
                    <tr key={r.mk}>
                      <td><b>{monthLabelLong(r.mk)}</b></td>
                      <td className="num">{t.count}</td>
                      <td className="num">{inr(t.gross)}</td>
                      <td className="num">{inr(t.pf)}</td>
                      <td className="num">{inr(t.esi)}</td>
                      <td className="num">{inr(t.pt)}</td>
                      <td className="num">{inr(t.tds)}</td>
                      <td className="num strong">{inr(t.net)}</td>
                      <td className="num">{t.lop}</td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>
    </>
  );
}

/* ---------- Statutory compliance ---------- */

export function RepCompliance() {
  const { data: payRuns = [] } = usePayRuns();
  const { data: totalsBy = {} } = usePayrollTotalsFor(payRuns.map((r) => r.mk));
  const { data: comp = [] } = useCompensation();
  const paid = payRuns.filter((r) => r.status === 'Paid' && totalsBy[r.mk]);
  const runs = paid.map((r) => ({ r, t: totalsBy[r.mk] }));
  const lastMk = paid.length ? paid[paid.length - 1].mk : '';
  const { data: lastRegister = [] } = useRegister(lastMk);
  const esiCovered = lastRegister.filter((r) => r.payslip.gross <= 21000).length;
  if (!runs.length) return <RepHead title="Statutory Compliance" sub="Loading…" onExport={() => {}} />;
  const last = runs[runs.length - 1];

  /** The filing calendar, with the last remitted amount where one applies. */
  const items: [string, string, string, string][] = [
    ['EPF — Electronic Challan cum Return (ECR)', 'Monthly, by 15th', inr(last.t.pf), 'Filed'],
    ['ESI — Contribution challan', 'Monthly, by 15th', inr(last.t.esi), 'Filed'],
    ['Professional Tax — TN / KA / TS', 'Monthly, by 15th–20th', inr(last.t.pt), 'Filed'],
    ['TDS — Section 192 deposit', 'Monthly, by 7th', inr(last.t.tds), 'Filed'],
    ['Form 24Q — Quarterly TDS return', 'Quarterly, by 31st of following month', '—', 'Due 31 Oct'],
    ['Form 16 — Annual TDS certificate', 'Annual, by 15 June', '—', 'Issued'],
    ['Shops & Establishment renewal', 'Annual', '—', 'Valid till Mar 2027'],
    ['POSH Annual Report', 'Annual, by 31 Jan', '—', 'Submitted'],
    ['Gratuity actuarial valuation', 'Annual', lakh(sum(comp, (c) => c.salary.gratuity)), 'Provisioned'],
  ];

  const exportCSV = () =>
    downloadCSV('report_compliance.csv', [
      ['Period', 'PF', 'ESI', 'PT', 'TDS'],
      ...runs.map(({ r, t }) => [monthLabelLong(r.mk), t.pf, t.esi, t.pt, t.tds]),
    ]);

  const remit = [
    { name: 'PF', color: 'var(--s1)', data: runs.map((r) => r.t.pf) },
    { name: 'TDS', color: 'var(--s2)', data: runs.map((r) => r.t.tds) },
    { name: 'ESI', color: 'var(--s3)', data: runs.map((r) => r.t.esi) },
    { name: 'PT', color: 'var(--s4)', data: runs.map((r) => r.t.pt) },
  ];

  return (
    <>
      <RepHead
        title="Statutory Compliance"
        sub={`${ORG.legal} · PAN ${ORG.pan} · TAN ${ORG.tan}`}
        onExport={exportCSV}
      />
      <div className="stack">
        <div className="grid g4">
          <Tile label="EPF (last cycle)" value={inr(last.t.pf)} foot={monthLabelLong(last.r.mk)} />
          <Tile label="ESI (last cycle)" value={inr(last.t.esi)} foot={`${esiCovered} covered employees`} />
          <Tile label="TDS (last cycle)" value={inr(last.t.tds)} foot="Deposited under section 192" />
          <Tile label="Professional tax" value={inr(last.t.pt)} foot="Across 3 states" />
        </div>

        <Card title="Statutory remittance trend" sub={`Last ${runs.length} cycles`}>
          <BarChart
            labels={runs.map((r) => monthLabel(r.r.mk).split(' ')[0])}
            height={230}
            padLeft={58}
            stacked
            fmt={(v) => inr(v)}
            tickFmt={(v) => lakh(v)}
            series={remit}
          />
          <Legend items={remit.map((s) => ({ k: s.name, c: s.color }))} />
        </Card>

        <Card title="Compliance calendar" sub={`${items.length} obligations tracked`} flush>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Obligation</th>
                  <th>Frequency &amp; due date</th>
                  <th className="num">Last amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i[0]}>
                    <td><b>{i[0]}</b></td>
                    <td>{i[1]}</td>
                    <td className="num">{i[2]}</td>
                    <td><Badge kind={i[3].startsWith('Due') ? 'warn' : 'good'}>{i[3]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>
    </>
  );
}

/* ---------- Expense & employee cost ---------- */

export function RepSpend() {
  const showEmp = useShowEmployee();
  const { data: emps = [] } = useAllEmployees();
  const ids = emps.map((e) => e.id);
  const { data: claims = [] } = useClaimsIn(ids);
  const { data: activeLoans = [] } = useActiveLoans();
  const { data: fbp = {} } = useFbpTotals(ids);
  const claimTotal = sum(claims, (c) => c.total);
  const byCat: HBarRow[] = EXP_CATS.map((c) => ({
    k: c.n,
    c: c.c,
    v: sum(claims.flatMap((x) => x.items).filter((i) => i.cat === c.id), (i) => i.amount),
  })).filter((r) => r.v);

  const rows = sortBy(
    emps.map((e) => {
      const cl = sum(claims.filter((c) => c.empId === e.id), (c) => c.total);
      return { e, ctc: e.ctc, cl, ins: INSURANCE_PER_HEAD, fbp: fbp[e.id] ?? 0, total: e.ctc + cl + INSURANCE_PER_HEAD };
    }),
    (r) => -r.total
  );
  const byDept: HBarRow[] = DEPTS.map((d) => ({
    k: d.name,
    c: d.color,
    v: sum(rows.filter((r) => r.e.dept === d.id), (r) => r.total),
  })).filter((r) => r.v);


  const exportCSV = () =>
    downloadCSV('report_employee_cost.csv', [
      ['Emp Code', 'Name', 'Department', 'Annual CTC', 'Expense claims', 'Insurance', 'FBP allocated', 'Total cost'],
      ...rows.map((r) => [
        r.e.code,
        r.e.name,
        deptOf(r.e.dept).name,
        r.ctc,
        r.cl,
        r.ins,
        r.fbp,
        r.total,
      ]),
    ]);

  return (
    <>
      <RepHead title="Expense & Employee Cost" sub="Total cost of employment beyond payroll" onExport={exportCSV} />
      <div className="stack">
        <div className="grid g5">
          <Tile label="Total CTC" value={lakh(sum(emps, (e) => e.ctc))} foot={`${emps.length} employees`} />
          <Tile label="Expense claims" value={lakh(claimTotal)} foot={`${claims.length} claims all time`} />
          <Tile label="Insurance premium" value={lakh(emps.length * INSURANCE_PER_HEAD)} foot="GMC, GPA and GTL" />
          <Tile
            label="Loans outstanding"
            value={lakh(sum(activeLoans, (l) => l.outstanding))}
            foot={`${activeLoans.length} active loans`}
          />
          <Tile
            label="Cost per employee"
            value={lakh(sum(rows, (r) => r.total) / Math.max(1, rows.length))}
            foot="Fully loaded, annual"
          />
        </div>

        <div className="grid g2">
          <Card title="Expense by category" sub="All claims">
            <HBar rows={sortBy(byCat, (r) => -r.v)} fmt={(v) => inr(v)} />
          </Card>
          <Card title="Fully loaded cost by department" sub="CTC + claims + insurance">
            <HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => lakh(v)} />
          </Card>
        </div>

        <Card title="Cost per employee" sub="Top 40 by total cost" flush>
          <div style={{ maxHeight: 480, overflow: 'auto' }}>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th className="num">Annual CTC</th>
                    <th className="num">Expense claims</th>
                    <th className="num">Insurance</th>
                    <th className="num">FBP allocated</th>
                    <th className="num">Total cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 40).map((r) => (
                    <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                      <td><PersonCell e={r.e} /></td>
                      <td className="nowrap">{deptOf(r.e.dept).name}</td>
                      <td className="num">{inr(r.ctc)}</td>
                      <td className="num">{inr(r.cl)}</td>
                      <td className="num">{inr(r.ins)}</td>
                      <td className="num">{inr(r.fbp)}</td>
                      <td className="num strong">{inr(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        </Card>
      </div>
    </>
  );
}
