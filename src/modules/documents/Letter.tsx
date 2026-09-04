import type { ReactNode } from 'react';
import { LOGO_LIGHT } from '../../assets/logo';
import { fmtD, tenure, TODAY, ymd } from '../../lib/dates';
import { inr } from '../../lib/format';
import { ri } from '../../lib/rng';
import { EMAP, empName, HRHEAD } from '../../data/employees';
import type { Employee } from '../../types/employee';
import { deptOf, GRADES, ORG, siteOf } from '../../data/org';
import { salaryStructure, taxNewRegime } from '../../data/salary';
import { LETTER_TYPES, ytdFor } from '../../data/letters';
import { exitOf } from '../../data/exit';
import { CUR_CYCLE, reviewOf } from '../../data/performance';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';

const letterType = (id: string) => LETTER_TYPES.find((t) => t.id === id);

/** Third-person pronouns for the letter prose, from the record on file. */
const pron = (e: Employee) => (e.gender === 'F' ? { subj: 'she', obj: 'her', poss: 'her' } : { subj: 'he', obj: 'him', poss: 'his' });

const P = ({ children }: { children: ReactNode }) => (
  <p style={{ fontSize: 13, lineHeight: 1.8 }}>{children}</p>
);

/* ---------- the eight letter bodies ---------- */

function ExperienceBody({ e, relieving }: { e: Employee; relieving: boolean }) {
  const x = exitOf(e.id);
  const lwd = x ? x.lwd : ymd(TODAY);
  const p = pron(e);
  return (
    <>
      <P>
        This is to certify that <b>{e.name}</b> (Employee Code {e.code}) was employed with {ORG.legal} from{' '}
        <b>{fmtD(e.doj)}</b> to <b>{fmtD(lwd)}</b>.
      </P>
      <P>
        At the time of leaving, {p.subj} held the position of <b>{e.designation}</b> in the {deptOf(e.dept).name}{' '}
        department at our {siteOf(e.site).name}.
      </P>
      {relieving ? (
        <P>
          All company property has been returned and the exit clearance process has been completed. {e.name} is
          relieved from {p.poss} duties with effect from the close of business on {fmtD(lwd)}.
        </P>
      ) : (
        <P>
          During {p.poss} tenure of {tenure(e.doj)}, we found {p.obj} to be sincere, diligent and professional in
          conduct. We wish {p.obj} the very best for future endeavours.
        </P>
      )}
    </>
  );
}

function SalaryCertBody({ e }: { e: Employee }) {
  const s = salaryStructure(e);
  return (
    <>
      <P>
        This is to certify that <b>{e.name}</b> (Employee Code {e.code}) is employed with {ORG.legal} as{' '}
        <b>{e.designation}</b> since <b>{fmtD(e.doj)}</b>. The current annual compensation is as follows:
      </P>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Component</th><th className="right">Per annum</th><th className="right">Per month</th></tr>
        </thead>
        <tbody>
          {s.earnings.map((x) => (
            <tr key={x.k}>
              <td>{x.k}</td>
              <td className="right mono">{inr(x.a)}</td>
              <td className="right mono">{inr(x.a / 12)}</td>
            </tr>
          ))}
          <tr className="tot">
            <td>Gross salary</td>
            <td className="right mono">{inr(s.grossA)}</td>
            <td className="right mono">{inr(s.grossA / 12)}</td>
          </tr>
          <tr className="tot">
            <td>Total cost to company</td>
            <td className="right mono">{inr(e.ctc)}</td>
            <td className="right mono">{inr(e.ctc / 12)}</td>
          </tr>
        </tbody>
      </table>
      <P>
        This certificate is issued at the request of the employee for the purpose of a loan, visa or similar
        application. It does not constitute a guarantee of continued employment.
      </P>
    </>
  );
}

function AddressBody({ e }: { e: Employee }) {
  return (
    <>
      <P>To whomsoever it may concern,</P>
      <P>
        This is to certify that <b>{e.name}</b> (Employee Code {e.code}) has been employed with {ORG.legal} as{' '}
        <b>{e.designation}</b> since <b>{fmtD(e.doj)}</b>.
      </P>
      <P>As per our records, the residential address of the employee is:</P>
      <p style={{ fontSize: 13, lineHeight: 1.8, padding: 12, border: '1px solid var(--line)', borderRadius: 8 }}>
        <b>{e.name}</b>
        <br />
        {e.address}
      </p>
      <P>Contact number on record: {e.phone} · Official email: {e.email}</P>
      <P>This letter is issued on the request of the employee for the purpose of address verification.</P>
    </>
  );
}

function AppointmentBody({ e }: { e: Employee }) {
  return (
    <>
      <P>Dear {e.name.split(' ')[0]},</P>
      <P>
        With reference to your application and the subsequent interviews, we are pleased to appoint you as{' '}
        <b>{e.designation}</b> in the {deptOf(e.dept).name} department, based at our {siteOf(e.site).name}, with
        effect from <b>{fmtD(e.doj)}</b>.
      </P>
      <P>
        Your total cost to company is <b>{inr(e.ctc)}</b> per annum, structured as set out in Annexure A. Your
        employment is governed by the terms below and the employee handbook, as amended from time to time.
      </P>
      <table style={{ marginTop: 12 }}>
        <tbody>
          <tr><th style={{ width: '32%' }}>Grade</th><td>{GRADES[e.grade].label}</td></tr>
          <tr><th>Reporting to</th><td>{empName(e.managerId || '')}</td></tr>
          <tr><th>Probation</th><td>Six (6) months from the date of joining</td></tr>
          <tr><th>Notice period</th><td>30 days during probation, 60 days on confirmation</td></tr>
          <tr><th>Working hours</th><td>{e.shift} IST, Monday to Friday</td></tr>
          <tr><th>Leave</th><td>12 Casual, 12 Sick and 15 Earned leave per annum, pro-rated</td></tr>
        </tbody>
      </table>
    </>
  );
}

function IncrementBody({ e }: { e: Employee }) {
  const s = salaryStructure(e);
  const rv = reviewOf(e.id);
  const hike = rv && rv.final ? rv.final.hike : 10;
  const newCtc = (Math.round((e.ctc * (1 + hike / 100)) / 1000) * 1000);
  return (
    <>
      <P>Dear {e.name.split(' ')[0]},</P>
      <P>
        We are pleased to inform you that following the {CUR_CYCLE.name}, your compensation has been revised with
        effect from <b>1 October 2026</b>.
      </P>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Particulars</th><th className="right">Existing</th><th className="right">Revised</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Annual cost to company</td>
            <td className="right mono">{inr(e.ctc)}</td>
            <td className="right mono">{inr(newCtc)}</td>
          </tr>
          <tr>
            <td>Monthly gross</td>
            <td className="right mono">{inr(s.grossA / 12)}</td>
            <td className="right mono">{inr((s.grossA / 12) * (1 + hike / 100))}</td>
          </tr>
          <tr className="tot">
            <td>Increase</td>
            <td className="right mono">—</td>
            <td className="right mono">{hike}%</td>
          </tr>
        </tbody>
      </table>
      <P>
        {rv && rv.final && rv.final.promoted ? 'We are also delighted to confirm your promotion, effective the same date. ' : ''}
        This revision reflects your contribution over the review period. Thank you for the impact you have had, and
        we look forward to what you will build next.
      </P>
    </>
  );
}

function NocBody({ e }: { e: Employee }) {
  const p = pron(e);
  return (
    <>
      <P>To whomsoever it may concern,</P>
      <P>
        This is to certify that <b>{e.name}</b> (Employee Code {e.code}) is currently employed with {ORG.legal} as{' '}
        <b>{e.designation}</b> since {fmtD(e.doj)}.
      </P>
      <P>
        The organisation has <b>no objection</b> to the employee applying for the stated purpose, subject to it not
        interfering with {p.poss} contractual obligations and confidentiality undertakings with the company.
      </P>
    </>
  );
}

function Form16Body({ e }: { e: Employee }) {
  const s = salaryStructure(e);
  const tax = taxNewRegime(s.grossA);
  const yt = ytdFor(e.id);
  return (
    <>
      <P>
        <b>Form 16 — Part B</b> · Certificate under Section 203 of the Income-tax Act, 1961 for tax deducted at
        source on salary.
      </P>
      <table style={{ marginTop: 12 }}>
        <tbody>
          <tr>
            <th style={{ width: '38%' }}>Employee name</th><td>{e.name}</td>
            <th style={{ width: '18%' }}>PAN</th><td>{e.pan}</td>
          </tr>
          <tr><th>Employer</th><td>{ORG.legal}</td><th>TAN</th><td>{ORG.tan}</td></tr>
          <tr><th>Financial year</th><td>{ORG.fy}</td><th>Assessment year</th><td>{ORG.ay}</td></tr>
        </tbody>
      </table>
      <table style={{ marginTop: 12 }}>
        <thead>
          <tr><th>Particulars</th><th className="right">Amount</th></tr>
        </thead>
        <tbody>
          <tr><td>1. Gross salary under section 17(1)</td><td className="right mono">{inr(s.grossA)}</td></tr>
          <tr><td>2. Less: standard deduction under section 16(ia)</td><td className="right mono">{inr(75000)}</td></tr>
          <tr className="tot"><td>3. Income chargeable under the head Salaries</td><td className="right mono">{inr(tax.taxable)}</td></tr>
          <tr><td>4. Tax on total income</td><td className="right mono">{inr(tax.tax)}</td></tr>
          <tr><td>5. Health and education cess at 4%</td><td className="right mono">{inr(tax.cess)}</td></tr>
          <tr className="tot"><td>6. Total tax payable</td><td className="right mono">{inr(tax.total)}</td></tr>
          <tr><td>7. Tax deducted at source (year to date)</td><td className="right mono">{inr(yt.tds)}</td></tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginTop: 12 }}>
        Computed under the New Tax Regime as per the declaration on record. Part A of Form 16, containing the
        quarterly TDS deposit details, is downloaded directly from the TRACES portal.
      </p>
    </>
  );
}

function LetterBody({ type, e }: { type: string; e: Employee }) {
  switch (type) {
    case 'exp': return <ExperienceBody e={e} relieving={false} />;
    case 'rel': return <ExperienceBody e={e} relieving />;
    case 'salcert': return <SalaryCertBody e={e} />;
    case 'addr': return <AddressBody e={e} />;
    case 'appt': return <AppointmentBody e={e} />;
    case 'inc': return <IncrementBody e={e} />;
    case 'noc': return <NocBody e={e} />;
    case 'form16': return <Form16Body e={e} />;
    default: return null;
  }
}

/**
 * A letter on company paper: the same masthead and signature block for every
 * type, with the body switched on the letter chosen.
 */
function LetterDoc({ type, empId, docRef }: { type: string; empId: string; docRef: string }) {
  const e = EMAP[empId];
  const t = letterType(type);
  return (
    <div className="payslip">
      <div className="ps-h">
        <div>
          <img className="ps-logo" src={LOGO_LIGHT} alt={ORG.name} />
          <div style={{ fontSize: 13, fontWeight: 750, letterSpacing: '-.2px' }}>{ORG.legal}</div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{ORG.addr}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>CIN {ORG.cin} · PAN {ORG.pan}</div>
        </div>
        <div className="right">
          <div style={{ fontWeight: 800, fontSize: 13, textTransform: 'uppercase' }}>{t?.n || 'Letter'}</div>
          <div style={{ fontSize: 12 }}>{fmtD(TODAY)}</div>
          <div className="muted" style={{ fontSize: 11 }}>Ref: {docRef}</div>
        </div>
      </div>

      <LetterBody type={type} e={e} />

      <p style={{ fontSize: 13, marginTop: 26 }}>
        For <b>{ORG.legal}</b>
      </p>
      <p style={{ fontSize: 13, marginTop: 22 }}>
        <b>{HRHEAD.name}</b>
        <br />
        {HRHEAD.designation}
        <br />
        <span className="muted" style={{ fontSize: 11 }}>
          This is a digitally generated letter and is valid without a physical signature. Verify authenticity at
          verify.360technology.in using reference above.
        </span>
      </p>
    </div>
  );
}

/**
 * Opens a generated letter. Shared with the exit and employee modules, so a
 * letter always looks the same wherever it was raised from.
 */
export function useShowLetter() {
  const layer = useLayer();
  const app = useApp();

  return (type: string, empId: string) => {
    const e = EMAP[empId];
    if (!e) return;
    const t = letterType(type);
    /* Drawn once per open so the reference stays put while the letter is on screen. */
    const reference = `360T/HR/${ri(1000, 9999)}/${TODAY.getFullYear()}`;

    layer.modal({
      title: t?.n || 'Letter',
      sub: e.name + ' · ' + e.code,
      size: 'wide',
      body: <LetterDoc type={type} empId={empId} docRef={reference} />,
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Close</button>
          <button className="btn" onClick={() => { close(); app.toast('Letter emailed to ' + e.email, 'ok'); }}>
            ✉️ Email to employee
          </button>
          <button className="btn primary" onClick={() => window.print()}>🖨 Print / Save PDF</button>
        </>
      ),
    });
  };
}
