/* Shares the RNG stream with payroll inputs — this import fixes the draw order. */
import './payinputs';

import { addDays, parseYmd, TODAY, ymd } from '../lib/dates';
import { pick, ri } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import { PAYRUNS, payslip } from './payroll';

export interface LetterType {
  id: string;
  n: string;
  d: string;
  sla: string;
  /** Self-serve letters generate instantly; the rest need HR to issue them. */
  self: boolean;
}

export const LETTER_TYPES: LetterType[] = [
  { id: 'exp', n: 'Experience Letter', d: 'Confirms designation, tenure and conduct — for visa or a new employer', sla: '2 working days', self: false },
  { id: 'salcert', n: 'Salary Certificate', d: 'Current annual CTC and monthly gross — for loans and visas', sla: 'Instant', self: true },
  { id: 'addr', n: 'Address Proof Letter', d: 'Employment and address confirmation — for bank account or passport', sla: 'Instant', self: true },
  { id: 'appt', n: 'Appointment Letter', d: 'Copy of your original appointment letter', sla: 'Instant', self: true },
  { id: 'inc', n: 'Increment / Revision Letter', d: 'Latest salary revision with effective date', sla: 'Instant', self: true },
  { id: 'noc', n: 'No Objection Certificate', d: 'For higher studies, visa or a second engagement', sla: '3 working days', self: false },
  { id: 'rel', n: 'Relieving Letter', d: 'Issued on the last working day after clearance', sla: 'On LWD', self: false },
  { id: 'form16', n: 'Form 16', d: 'Annual TDS certificate — Part A and Part B', sla: 'Instant', self: true },
];

export interface LetterRequest {
  id: string;
  empId: string;
  type: string;
  purpose: string;
  requestedOn: string;
  status: 'Pending' | 'Issued';
  issuedOn: string | null;
}

export const LETTER_REQS: LetterRequest[] = [];

(function genLetters() {
  for (let i = 0; i < 14; i++) {
    const e = pick(ACTIVE());
    const t = pick(LETTER_TYPES.filter((x) => !x.self));
    const on = addDays(TODAY, -ri(1, 30));
    LETTER_REQS.push({
      id: 'LTR-' + (800 + i),
      empId: e.id,
      type: t.id,
      purpose: pick(['Visa application', 'Home loan', 'Higher studies', 'Bank account opening', 'New employer', 'Passport renewal']),
      requestedOn: ymd(on),
      status: pick(['Pending', 'Pending', 'Issued', 'Issued', 'Issued'] as LetterRequest['status'][]),
      issuedOn: null,
    });
  }
  LETTER_REQS.forEach((l) => {
    if (l.status === 'Issued') l.issuedOn = ymd(addDays(parseYmd(l.requestedOn), ri(1, 3)));
  });
})();

export interface Ytd {
  months: number;
  gross: number;
  tds: number;
  pf: number;
  pt: number;
  esi: number;
  net: number;
}

/** Year-to-date payroll figures for the current Indian financial year. */
export function ytdFor(empId: string, upToMk?: string): Ytd {
  const e = EMAP[empId];
  const fyStart = (TODAY.getMonth() >= 3 ? TODAY.getFullYear() : TODAY.getFullYear() - 1) + '-04';
  const runs = PAYRUNS.filter((r) => r.status === 'Paid' && r.mk >= fyStart && (!upToMk || r.mk <= upToMk));

  let gross = 0;
  let tds = 0;
  let pf = 0;
  let pt = 0;
  let net = 0;
  let esi = 0;

  runs.forEach((r) => {
    const p = payslip(e, r.mk);
    gross += p.gross;
    net += p.net;
    p.ded.forEach((d) => {
      if (d.k.includes('Provident')) pf += d.a;
      else if (d.k.includes('TDS')) tds += d.a;
      else if (d.k.includes('ESI')) esi += d.a;
      else if (d.k.includes('Professional')) pt += d.a;
    });
  });

  return { months: runs.length, gross, tds, pf, pt, esi, net };
}
