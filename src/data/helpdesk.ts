/* Shares the RNG stream with benefits — this import fixes the draw order. */
import './benefits';

import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri } from '../lib/rng';
import { ACTIVE } from './employees';
import { ORG } from './org';

export interface TicketCat {
  id: string;
  n: string;
  /** Resolution SLA in hours. */
  sla: number;
  team: string;
  ic: string;
}

export const TICKET_CATS: TicketCat[] = [
  { id: 'PAY', n: 'Payroll & Salary', sla: 24, team: 'FIN', ic: '₹' },
  { id: 'ATT', n: 'Attendance & Leave', sla: 24, team: 'HR', ic: '◉' },
  { id: 'IT', n: 'IT & Systems', sla: 8, team: 'DEVOPS', ic: '💻' },
  { id: 'DOC', n: 'Documents & Letters', sla: 48, team: 'HR', ic: '📄' },
  { id: 'POL', n: 'Policy Clarification', sla: 48, team: 'HR', ic: '📘' },
  { id: 'FAC', n: 'Facilities & Workplace', sla: 24, team: 'FIN', ic: '🏢' },
  { id: 'BEN', n: 'Insurance & Benefits', sla: 48, team: 'HR', ic: '🏥' },
  { id: 'ONB', n: 'Onboarding Support', sla: 12, team: 'HR', ic: '🚀' },
];

export const tCat = (id: string): TicketCat => TICKET_CATS.find((c) => c.id === id) || TICKET_CATS[0];

export interface TicketComment {
  by: string;
  on: string;
  text: string;
}

export interface Ticket {
  id: string;
  empId: string;
  cat: string;
  subject: string;
  desc: string;
  priority: string;
  status: 'Open' | 'In Progress' | 'Resolved' | 'Closed';
  createdOn: string;
  createdTime: string;
  dueOn: string;
  slaHours: number;
  assigneeId: string;
  resolvedOn: string | null;
  resolutionHrs: number | null;
  /** True when resolution ran past the SLA, or it is open and overdue. */
  breached: boolean;
  csat: number | null;
  comments: TicketComment[];
}

export const TICKETS: Ticket[] = [];

(function genTickets() {
  const subjects: Record<string, string[]> = {
    PAY: ['TDS deducted seems higher than my declaration', 'Payslip for June not visible', 'Reimbursement not credited with salary', 'PF not reflecting in EPFO passbook', 'Need salary revision letter'],
    ATT: ['Punch not recorded on 7 August', 'Leave balance shows incorrect carry forward', 'Comp off not credited for weekend work', 'Geo-fence flagged my punch wrongly'],
    IT: ['Laptop overheating and shutting down', 'VPN disconnects every 10 minutes', 'Need access to the staging database', 'Second monitor request', 'Email quota full'],
    DOC: ['Need an experience letter for a visa application', 'Address proof letter for bank account', 'Salary certificate for a home loan', 'Duplicate Form 16 for FY 2024-25'],
    POL: ['Clarification on the WFH policy for client projects', 'How does the sandwich leave rule work?', 'Notice period buyout options', 'Maternity leave extension policy'],
    FAC: ['Air conditioning not working in Block C', 'Parking pass renewal', 'Cafeteria timing change request', 'Desk relocation request'],
    BEN: ['Add newborn to medical insurance', 'Parents insurance top-up cost', 'How to claim OPD wallet', 'Insurance card not received'],
    ONB: ['Unable to log in to the HRMS on day one', 'UAN not generated yet', 'Buddy not assigned'],
  };

  for (let i = 0; i < 58; i++) {
    const c = pick(TICKET_CATS);
    const e = pick(ACTIVE());
    const created = addDays(TODAY, -ri(0, 45));
    const st: Ticket['status'] = pick([
      'Open', 'Open', 'In Progress', 'In Progress', 'Resolved', 'Resolved', 'Resolved', 'Closed',
    ] as Ticket['status'][]);
    const due = new Date(created.getTime() + c.sla * 3600000);
    /* most tickets land inside SLA; the rest overrun it */
    const resolvedH = chance(0.87) ? Math.max(1, ri(1, c.sla)) : ri(c.sla + 1, Math.round(c.sla * 2.5));
    const closed = ['Resolved', 'Closed'].includes(st);

    TICKETS.push({
      id: 'TKT-' + (9100 + i),
      empId: e.id,
      cat: c.id,
      subject: pick(subjects[c.id]),
      desc:
        'Raised via employee self-service. ' +
        pick([
          'Please look into this at the earliest.',
          'This is blocking me from completing a submission.',
          'Requesting an update on the timeline.',
          'Happy to share more details if needed.',
        ]),
      priority: pick(['Low', 'Medium', 'Medium', 'High', 'Urgent']),
      status: st,
      createdOn: ymd(created),
      createdTime: String(ri(9, 18)).padStart(2, '0') + ':' + String(ri(10, 59)),
      dueOn: ymd(due),
      slaHours: c.sla,
      assigneeId: pick(ACTIVE().filter((x) => x.dept === c.team)).id,
      resolvedOn: closed ? ymd(addDays(created, Math.ceil(resolvedH / 24))) : null,
      resolutionHrs: closed ? resolvedH : null,
      breached: closed ? resolvedH > c.sla : ymd(TODAY) > ymd(due),
      csat: st === 'Closed' ? ri(3, 5) : null,
      comments: ['Resolved', 'Closed', 'In Progress'].includes(st)
        ? [
            {
              by: 'HR Helpdesk',
              on: ymd(addDays(created, 1)),
              text: pick([
                'Looking into this — will update by end of day.',
                'Shared with the payroll team for verification.',
                'Ticket assigned to IT support.',
                'Could you share a screenshot of the error?',
              ]),
            },
          ]
        : [],
    });
  }
})();

/** Self-service knowledge base, shown alongside ticket creation. */
export const KB = [
  { cat: 'PAY', q: 'When is salary credited?', a: 'Salary is credited on the 1st working day of the following month. The attendance cut-off is the 25th; anything after that flows into the next cycle.' },
  { cat: 'PAY', q: 'Why is my TDS higher this month?', a: 'TDS is recomputed whenever your declaration changes, a bonus is paid, or proofs are rejected. Check Tax Declaration → Regime comparison for the current projection.' },
  { cat: 'ATT', q: 'What happens if I forget to punch?', a: 'Raise an attendance regularisation from Attendance → Regularisation within 30 days. Your manager approves it and the day stops counting as Loss of Pay.' },
  { cat: 'ATT', q: 'How does the sandwich rule work?', a: `Week-offs and holidays that fall between two leave days are not deducted from your balance at ${ORG.name}.` },
  { cat: 'DOC', q: 'How do I get an experience letter?', a: 'Go to Documents & Letters, choose Experience Letter and submit. HR issues it within 2 working days.' },
  { cat: 'BEN', q: 'How do I add a dependent to insurance?', a: 'Additions are allowed within 30 days of joining, marriage or childbirth. Raise a Helpdesk ticket under Insurance & Benefits with the supporting document.' },
  { cat: 'IT', q: 'How do I request software or access?', a: 'Raise an IT & Systems ticket with the business justification. Access needing data privileges also needs your manager and the data owner to approve.' },
  { cat: 'POL', q: 'What is the notice period?', a: '30 days during probation and 60 days after confirmation. Buyout is at the discretion of the reporting manager and HR.' },
];
