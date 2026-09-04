import { LOGO_LIGHT } from '../../assets/logo';
import { fmtD, monthLabelLong } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { countryOf, money } from '../../data/countries';
import { deptOf, ORG, siteOf } from '../../data/org';
import type { Employee, Payslip, SalaryStructure } from '../../services';
import { getServices } from '../../services';
import { useLayer } from '../../components/Layer';

/** Indian numbering system, for the amount-in-words line on Indian payslips. */
function inWords(value: number): string {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n: number): string => (n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : ''));
  const three = (n: number): string =>
    n >= 100 ? a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n);

  let n = Math.round(value);
  let out = '';
  if (n >= 10000000) { out += three(Math.floor(n / 10000000)) + ' Crore '; n %= 10000000; }
  if (n >= 100000) { out += three(Math.floor(n / 100000)) + ' Lakh '; n %= 100000; }
  if (n >= 1000) { out += three(Math.floor(n / 1000)) + ' Thousand '; n %= 1000; }
  if (n) out += three(n);
  return out.trim() + ' Rupees Only';
}

function PayslipDoc({ e, p, s, mk }: { e: Employee; p: Payslip; s: SalaryStructure; mk: string }) {
  const CC = e.ccy || 'INR';
  const CT = countryOf(e.country);
  const M = (a: number) => money(a, CC);

  /* earnings and deductions are laid out side by side, padded to the longer column */
  const rows = Math.max(p.earn.length, p.ded.length);

  return (
    <div className="payslip" id="slipDoc">
      <div className="ps-h">
        <div>
          <img className="ps-logo" src={LOGO_LIGHT} alt={ORG.name} />
          <div style={{ fontSize: 13, fontWeight: 750, letterSpacing: '-.2px' }}>{CT.entity}</div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{CT.addr}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>{CT.reg}</div>
        </div>
        <div className="right">
          <div style={{ fontWeight: 800, fontSize: 14 }}>PAYSLIP</div>
          <div style={{ fontSize: 12 }}>{monthLabelLong(mk)}</div>
          <div className="muted" style={{ fontSize: 11 }}>System generated</div>
        </div>
      </div>

      <table style={{ marginBottom: 14 }}>
        <tbody>
          <tr>
            <th style={{ width: '22%' }}>Employee Name</th><td style={{ width: '28%' }}>{e.name}</td>
            <th style={{ width: '22%' }}>Employee Code</th><td>{e.code}</td>
          </tr>
          <tr>
            <th>Designation</th><td>{e.designation}</td>
            <th>Department</th><td>{deptOf(e.dept).name}</td>
          </tr>
          <tr>
            <th>Date of Joining</th><td>{fmtD(e.doj)}</td>
            <th>Location</th><td>{siteOf(e.site).name}</td>
          </tr>
          <tr>
            <th>PAN</th><td>{e.pan || '—'}</td>
            <th>UAN / PF No.</th><td>{e.uan || '—'}</td>
          </tr>
          <tr>
            <th>Bank</th><td>{e.bank} · A/c {e.acct}</td>
            <th>Pay days</th><td>{p.payDays} of {p.dim}{p.lop ? ` (${p.lop} LOP)` : ''}</td>
          </tr>
        </tbody>
      </table>

      <table>
        <thead>
          <tr>
            <th style={{ width: '38%' }}>Earnings</th><th className="right" style={{ width: '12%' }}>Amount</th>
            <th style={{ width: '38%' }}>Deductions</th><th className="right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              <td>{p.earn[i]?.k || ''}</td>
              <td className="right mono">{p.earn[i] ? M(p.earn[i].a) : ''}</td>
              <td>{p.ded[i]?.k || ''}</td>
              <td className="right mono">{p.ded[i] ? M(p.ded[i].a) : ''}</td>
            </tr>
          ))}
          <tr className="tot">
            <td>Gross Earnings</td><td className="right mono">{M(p.gross)}</td>
            <td>Total Deductions</td><td className="right mono">{M(p.totalDed)}</td>
          </tr>
        </tbody>
      </table>

      {p.reimb > 0 && (
        <table style={{ marginTop: 12 }}>
          <tbody>
            <tr>
              <td style={{ width: '60%' }}>Add: reimbursements (non-taxable, against bills)</td>
              <td className="right mono">{M(p.reimb)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <table style={{ marginTop: 12 }}>
        <tbody>
          <tr className="tot">
            <td style={{ width: '60%' }}>NET PAY</td>
            <td className="right mono" style={{ fontSize: 15 }}>{M(p.net)}</td>
          </tr>
          <tr>
            <td colSpan={2}><i>{CC === 'INR' ? inWords(p.net) : `${M(p.net)} (${CC})`}</i></td>
          </tr>
        </tbody>
      </table>

      <table style={{ marginTop: 12 }}>
        <thead><tr><th colSpan={4}>Employer contributions (not part of net pay)</th></tr></thead>
        <tbody>
          <tr>
            <td>Employer PF</td><td className="right mono">{M(p.pfER)}</td>
            <td>Employer ESI</td><td className="right mono">{M(p.esiER)}</td>
          </tr>
          <tr>
            <td>Gratuity accrual</td><td className="right mono">{M(s.gratuity / 12)}</td>
            <td>Medical insurance</td><td className="right mono">{M(s.medIns / 12)}</td>
          </tr>
        </tbody>
      </table>

      <div className="muted" style={{ marginTop: 14, fontSize: 10.5, lineHeight: 1.6 }}>
        {p.country === 'IN' ? (
          <>Income tax computed under the <b>{p.regime} Regime</b> based on your Form 12BB declaration. Projected annual tax liability {M(p.annualTax)}. </>
        ) : p.country === 'AE' ? (
          <>The United Arab Emirates levies no personal income tax. End-of-service gratuity accrues at 21 days of basic pay per year of service. </>
        ) : (
          <>Withholding computed under <b>{CT.empTax}</b>. Projected annual liability {M(p.annualTax)}. Pay frequency: {CT.payFreq}. </>
        )}
        This is a computer-generated payslip and does not require a signature. For queries contact payroll@360technology.in within 7 days of release.
      </div>
    </div>
  );
}

/** Opens the payslip document. Shared by the register, self-service and search. */
export function useShowPayslip() {
  const layer = useLayer();
  /* Resolve the person and their computed slip before opening — the drawer
     header needs both, and both come from the service. */
  return async (empId: string, mk: string) => {
    const svc = getServices();
    const e = await svc.employees.byId(empId);
    if (!e) return;
    const [p, s] = await Promise.all([svc.payroll.payslip(empId, mk), svc.payroll.structure(empId)]);
    layer.modal({
      title: 'Payslip — ' + monthLabelLong(mk),
      sub: e.name + ' · ' + e.code,
      size: 'wide',
      body: <PayslipDoc e={e} p={p} s={s} mk={mk} />,
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Close</button>
          <button className="btn" onClick={() =>
            downloadCSV(`payslip_${e.code}_${mk}.csv`, [
              ['Payslip', monthLabelLong(mk)], ['Employee', e.name], ['Code', e.code],
              ['Designation', e.designation], ['Pay days', `${p.payDays}/${p.dim}`], [],
              ['Earnings', 'Amount'],
              ...p.earn.map((x) => [x.k, x.a]),
              ['Gross', p.gross], [],
              ['Deductions', 'Amount'],
              ...p.ded.map((x) => [x.k, x.a]),
              ['Total deductions', p.totalDed], ['Net pay', p.net],
            ])}>⤓ CSV</button>
          <button className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </>
      ),
    });
  };
}
