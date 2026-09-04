/* Shares the RNG stream with staffing — this import fixes the draw order. */
import './staffing';

import { sum } from '../lib/collections';
import { addDays, parseYmd, TODAY, ymd } from '../lib/dates';
import { pct } from '../lib/format';
import { chance, pick, ri, rnd, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import type { CountryId } from '../types/country';

export const WA_ACCOUNT = {
  number: '+91 44 4020 3600',
  displayName: '360 People',
  quality: 'High',
  tier: '10,000 business-initiated conversations / 24 hours',
  verified: true,
};

/** Meta's own categories — the category decides whether opt-in is required. */
export type WaCategory = 'Utility' | 'Marketing' | 'Authentication';

export interface WaTemplate {
  id: string;
  name: string;
  cat: WaCategory;
  lang: string;
  status: 'Approved' | 'Pending review';
  event: string;
  audience: string;
  body: string;
  vars: string[];
  cta: string | null;
  on: boolean;
}

export const WA_TEMPLATES: WaTemplate[] = [
  {
    id: 'payslip_ready', name: 'Payslip published', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Payroll run published', audience: 'Employee',
    body: 'Hi {{1}}, your payslip for {{2}} is ready. Net pay {{3}} has been credited to your account ending {{4}}. View it in 360 People.',
    vars: ['First name', 'Pay period', 'Net pay', 'Account last 4'], cta: 'View payslip', on: true,
  },
  {
    id: 'leave_decision', name: 'Leave approved or declined', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Leave request approved or rejected', audience: 'Employee',
    body: 'Hi {{1}}, your {{2}} request for {{3}} has been {{4}} by {{5}}. Balance remaining: {{6}} days.',
    vars: ['First name', 'Leave type', 'Dates', 'Decision', 'Approver', 'Balance'], cta: 'Open leave', on: true,
  },
  {
    id: 'approval_pending', name: 'Approval waiting on you', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Item pending more than 24 hours', audience: 'Manager',
    body: 'Hi {{1}}, you have {{2}} items waiting for approval in 360 People — the oldest has been pending {{3}} days.',
    vars: ['First name', 'Count', 'Oldest age'], cta: 'Review now', on: true,
  },
  {
    id: 'birthday', name: 'Birthday wish', cat: 'Marketing', lang: 'en', status: 'Approved',
    event: 'Employee birthday', audience: 'Employee',
    body: 'Happy birthday {{1}}! Everyone at {{2}} wishes you a wonderful year ahead. 🎂',
    vars: ['First name', 'Company'], cta: null, on: true,
  },
  {
    id: 'anniversary', name: 'Work anniversary', cat: 'Marketing', lang: 'en', status: 'Approved',
    event: 'Work anniversary', audience: 'Employee',
    body: 'Congratulations {{1}} on completing {{2}} years with {{3}}. Thank you for everything you have built here.',
    vars: ['First name', 'Years', 'Company'], cta: null, on: true,
  },
  {
    id: 'interview_invite', name: 'Interview invitation', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Interview scheduled', audience: 'Candidate',
    body: 'Hi {{1}}, your {{2}} interview for {{3}} is confirmed for {{4}} at {{5}}. Reply CONFIRM to accept or RESCHEDULE to move it.',
    vars: ['First name', 'Round', 'Role', 'Date', 'Time'], cta: 'Join call', on: true,
  },
  {
    id: 'offer_released', name: 'Offer released', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Offer sent to candidate', audience: 'Candidate',
    body: 'Hi {{1}}, we are delighted to offer you the role of {{2}} at {{3}}. Your offer letter is ready to review and accept.',
    vars: ['First name', 'Role', 'Company'], cta: 'Open offer', on: true,
  },
  {
    id: 'onboarding_task', name: 'Onboarding reminder', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Onboarding task due', audience: 'New joiner',
    body: 'Hi {{1}}, welcome aboard. {{2}} is due before {{3}} — it takes about two minutes in 360 People.',
    vars: ['First name', 'Task', 'Due date'], cta: 'Complete task', on: true,
  },
  {
    id: 'attendance_missing', name: 'Missing punch', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'No punch recorded by 11:00', audience: 'Employee',
    body: 'Hi {{1}}, we have not recorded a punch for you today. If you are working, punch in from the app or raise a regularisation.',
    vars: ['First name'], cta: 'Punch in', on: true,
  },
  {
    id: 'timesheet_due', name: 'Timesheet due', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Friday 16:00 with an unsubmitted timesheet', audience: 'Employee',
    body: 'Hi {{1}}, your timesheet for the week ending {{2}} is not submitted yet. {{3}} hours are logged so far.',
    vars: ['First name', 'Week ending', 'Hours logged'], cta: 'Submit', on: true,
  },
  {
    id: 'bench_alert', name: 'Bench redeployment', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Consultant matched to an open requirement', audience: 'Consultant',
    body: 'Hi {{1}}, we have a {{2}} opportunity with a {{3}} client starting {{4}}. Are you available? Reply YES or NO.',
    vars: ['First name', 'Role', 'Industry', 'Start'], cta: null, on: true,
  },
  {
    id: 'invoice_chase', name: 'Invoice reminder', cat: 'Utility', lang: 'en', status: 'Pending review',
    event: 'Invoice past due date', audience: 'Client contact',
    body: 'Hello {{1}}, invoice {{2}} for {{3}} was due on {{4}}. Could you confirm the payment run it is scheduled into?',
    vars: ['Contact name', 'Invoice', 'Amount', 'Due date'], cta: 'View invoice', on: false,
  },
  {
    id: 'asset_return', name: 'Asset return reminder', cat: 'Utility', lang: 'en', status: 'Approved',
    event: 'Last working day within 3 days with assets outstanding', audience: 'Leaver',
    body: 'Hi {{1}}, please return {{2}} to IT before {{3}}. Anything outstanding is recovered at written-down value in your settlement.',
    vars: ['First name', 'Assets', 'Last working day'], cta: null, on: true,
  },
  {
    id: 'otp', name: 'Sign-in code', cat: 'Authentication', lang: 'en', status: 'Approved',
    event: 'Two-factor sign-in', audience: 'Employee',
    body: '{{1}} is your 360 People verification code. It expires in 10 minutes. Do not share it with anyone.',
    vars: ['Code'], cta: null, on: true,
  },
];

export const waTpl = (id: string): WaTemplate | undefined => WA_TEMPLATES.find((t) => t.id === id);

export interface WaConsent {
  optIn: boolean;
  on: string | null;
  via: string | null;
  /** Separate consent for birthday and anniversary sends. */
  marketing: boolean;
  number: string;
  verified: boolean;
}

export const WA_CONSENT: Record<string, WaConsent> = {};

(function genConsent() {
  ACTIVE().forEach((e) => {
    const opted = chance(0.86);
    WA_CONSENT[e.id] = {
      optIn: opted,
      on: opted ? ymd(addDays(parseYmd(e.doj), ri(0, 20))) : null,
      via: opted ? pick(['Onboarding form', 'Self-service portal', 'Onboarding form', 'HR assisted']) : null,
      marketing: opted ? chance(0.78) : false,
      number: e.phone,
      verified: opted ? chance(0.94) : false,
    };
  });
})();

export const waConsent = (empId: string): WaConsent =>
  WA_CONSENT[empId] || { optIn: false, on: null, via: null, marketing: false, number: '', verified: false };

/** Utility and Marketing categories legally need prior opt-in. */
export function waReachable(empId: string, cat: WaCategory): boolean {
  const c = waConsent(empId);
  if (!c.optIn || !c.verified) return false;
  return cat === 'Marketing' ? c.marketing : true;
}

export interface WaRule {
  id: string;
  tpl: string;
  when: string;
  to: string;
  /** Respects the recipient's local quiet hours. */
  quiet: boolean;
  on: boolean;
}

export const WA_RULES: WaRule[] = [
  { id: 'R1', tpl: 'payslip_ready', when: 'On payroll publish', to: 'All employees in the run', quiet: true, on: true },
  { id: 'R2', tpl: 'leave_decision', when: 'Immediately on decision', to: 'The requester', quiet: false, on: true },
  { id: 'R3', tpl: 'approval_pending', when: 'Daily at 10:00 local', to: 'Approvers with pending items', quiet: true, on: true },
  { id: 'R4', tpl: 'birthday', when: '09:00 local on the day', to: 'The employee', quiet: true, on: true },
  { id: 'R5', tpl: 'anniversary', when: '09:00 local on the day', to: 'The employee', quiet: true, on: true },
  { id: 'R6', tpl: 'interview_invite', when: 'On schedule and 2 hours before', to: 'The candidate', quiet: false, on: true },
  { id: 'R7', tpl: 'offer_released', when: 'On offer release', to: 'The candidate', quiet: false, on: true },
  { id: 'R8', tpl: 'onboarding_task', when: 'Two days before the due date', to: 'The new joiner', quiet: true, on: true },
  { id: 'R9', tpl: 'attendance_missing', when: 'Weekdays at 11:00 local', to: 'Employees with no punch', quiet: true, on: true },
  { id: 'R10', tpl: 'timesheet_due', when: 'Friday at 16:00 local', to: 'Employees with an open timesheet', quiet: true, on: true },
  { id: 'R11', tpl: 'bench_alert', when: 'On an AI match above 70%', to: 'The consultant', quiet: false, on: true },
  { id: 'R12', tpl: 'asset_return', when: 'Three days before the last working day', to: 'The leaver', quiet: true, on: true },
  { id: 'R13', tpl: 'invoice_chase', when: 'Manual, from the collection worklist', to: 'The client contact', quiet: false, on: false },
  { id: 'R14', tpl: 'otp', when: 'On every two-factor sign-in', to: 'The signing-in user', quiet: false, on: true },
];

export interface WaLogEntry {
  id: string;
  tplId: string;
  empId: string;
  to: string;
  on: string;
  at: string;
  status: 'Read' | 'Delivered' | 'Sent' | 'Failed' | 'Queued';
  cat: WaCategory;
  country: CountryId;
  replied: string | null;
  error: string | null;
  /** INR per conversation, by Meta's category pricing. */
  cost: number;
}

export const WA_LOG: WaLogEntry[] = [];

(function genLog() {
  const live = WA_TEMPLATES.filter((t) => t.on && t.status === 'Approved');
  const people = ACTIVE().filter((e) => waConsent(e.id).optIn);

  for (let i = 0; i < 320; i++) {
    const t = pick(live);
    /* only message people who consented to that category — marketing is separate */
    const eligible = t.cat === 'Marketing' ? people.filter((x) => waConsent(x.id).marketing) : people;
    if (!eligible.length) continue;
    const e = pick(eligible);
    const d = addDays(TODAY, -ri(0, 29));

    /* authentication messages land almost always; marketing is read least */
    const r = rnd();
    const st: WaLogEntry['status'] =
      t.cat === 'Authentication'
        ? r < 0.97 ? 'Read' : r < 0.995 ? 'Delivered' : 'Failed'
        : t.cat === 'Marketing'
          ? r < 0.62 ? 'Read' : r < 0.9 ? 'Delivered' : r < 0.97 ? 'Sent' : 'Failed'
          : r < 0.81 ? 'Read' : r < 0.94 ? 'Delivered' : r < 0.98 ? 'Sent' : 'Failed';

    WA_LOG.push({
      id: uid('WA'),
      tplId: t.id,
      empId: e.id,
      to: waConsent(e.id).number,
      on: ymd(d),
      at: String(ri(8, 20)).padStart(2, '0') + ':' + String(ri(0, 59)).padStart(2, '0'),
      status: st,
      cat: t.cat,
      country: e.country,
      replied: st === 'Read' && chance(0.14) ? pick(['CONFIRM', 'YES', 'Thanks!', 'RESCHEDULE', 'NO']) : null,
      error:
        st === 'Failed'
          ? pick(['Number not on WhatsApp', 'User has blocked the business', 'Template paused by Meta', 'Outside the 24-hour session window'])
          : null,
      cost: t.cat === 'Marketing' ? 0.73 : t.cat === 'Authentication' ? 0.13 : 0.35,
    });
  }
  WA_LOG.sort((a, b) => (b.on + b.at).localeCompare(a.on + a.at));
})();

export function waKPI() {
  const n = WA_LOG.length;
  const opted = ACTIVE().filter((e) => waConsent(e.id).optIn).length;
  const landed = WA_LOG.filter((l) => ['Delivered', 'Read'].includes(l.status)).length;
  const read = WA_LOG.filter((l) => l.status === 'Read').length;
  return {
    sent: n,
    delivered: landed,
    read,
    failed: WA_LOG.filter((l) => l.status === 'Failed').length,
    replies: WA_LOG.filter((l) => l.replied).length,
    deliveryRate: pct(landed, Math.max(1, n)),
    readRate: pct(read, Math.max(1, n)),
    optIn: opted,
    optInRate: pct(opted, Math.max(1, ACTIVE().length)),
    cost: sum(WA_LOG, (l) => l.cost),
    active: WA_TEMPLATES.filter((t) => t.on && t.status === 'Approved').length,
  };
}

/* badge classes, so the view layer does not re-derive them */
export const WA_STATUS_BADGE: Record<string, string> = {
  Read: 'good', Delivered: 'info', Sent: 'mute', Failed: 'crit', Queued: 'warn',
};
export const WA_CAT_BADGE: Record<string, string> = {
  Utility: 'info', Marketing: 'warn', Authentication: 'good',
};

/** Fill a template's `{{n}}` placeholders, so previews are never lorem ipsum. */
export function waRender(tplId: string, vals?: string[]): string {
  const t = waTpl(tplId);
  if (!t) return '';
  let b = t.body;
  (vals || []).forEach((v, i) => {
    b = b.split('{{' + (i + 1) + '}}').join(v);
  });
  return b;
}
