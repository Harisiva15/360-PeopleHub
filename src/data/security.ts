/* Shares the RNG stream with the asset workflow — this import fixes the draw order. */
import './assetWorkflow';

import { addDays, monthLabelLong, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import { CUR_RUN } from './payroll';
import type { CountryId } from '../types/country';
import type { Employee } from '../types/employee';

export type Severity = 'high' | 'medium' | 'low';

export interface AuditEntry {
  id: string;
  cat: string;
  action: string;
  sev: Severity;
  byId: string;
  by: string;
  on: string;
  at: string;
  ip: string;
  device: string;
  country: CountryId;
}

export const AUDIT: AuditEntry[] = [];

(function genAudit() {
  /* only people who can actually perform privileged actions appear as actors */
  const actors = ACTIVE().filter((e) => ['HR', 'FIN', 'IT'].includes(e.dept) || e.grade >= 'L4');

  const templates: [string, (mk: string) => string, Severity][] = [
    ['Payroll', (mk) => 'Payroll run locked for ' + monthLabelLong(mk), 'high'],
    ['Payroll', () => 'Salary revision applied to ' + ri(3, 18) + ' employees', 'high'],
    ['Payroll', () => 'Bank disbursal file generated and signed', 'high'],
    ['Access', () => 'Role changed to Manager for ' + ri(1, 3) + ' user(s)', 'high'],
    ['Access', () => 'Access revoked for a leaver on last working day', 'medium'],
    ['Access', () => 'Privileged session started from a new device', 'high'],
    ['Employee', () => 'Bank account details updated for ' + ri(1, 4) + ' employee(s)', 'high'],
    ['Employee', () => ri(2, 6) + ' employees added via onboarding automation', 'low'],
    ['Attendance', () => 'Geo-fence radius updated ' + ri(180, 220) + ' m → ' + ri(220, 300) + ' m', 'medium'],
    ['Attendance', () => 'Bulk regularisation approved (' + ri(8, 40) + ' records)', 'medium'],
    ['Hiring', () => 'Requisition approved with an off-band offer', 'medium'],
    ['Compliance', () => 'Form 24Q filed with the Income Tax Department', 'medium'],
    ['Compliance', () => 'PF ECR uploaded and challan paid', 'medium'],
    ['Security', () => 'Two-factor authentication enforced for the admin role', 'high'],
    ['Security', () => 'Failed sign-in threshold exceeded — account locked', 'high'],
    ['Security', () => 'Data export of the salary register downloaded', 'high'],
    ['Leave', () => 'Leave policy updated — carry-forward cap changed', 'medium'],
    ['Finance', () => 'Invoice raised above the client credit limit', 'high'],
    ['Staffing', () => 'Placement created below the margin floor with an override', 'high'],
    ['Staffing', () => 'Rate card revised for a client account', 'medium'],
  ];

  for (let i = 0; i < 140; i++) {
    const t = pick(templates);
    const d = addDays(TODAY, -ri(0, 44));
    const who = pick(actors);
    AUDIT.push({
      id: uid('AUD'),
      cat: t[0],
      action: t[1](CUR_RUN.mk),
      sev: t[2],
      byId: who.id,
      by: who.name,
      on: ymd(d),
      at: String(ri(8, 20)).padStart(2, '0') + ':' + String(ri(0, 59)).padStart(2, '0'),
      ip: '10.4.' + ri(1, 20) + '.' + ri(2, 250),
      device: pick(['macOS · Chrome', 'Windows · Edge', 'macOS · Safari', 'Windows · Chrome', 'iOS · Mobile app']),
      country: who.country,
    });
  }
  AUDIT.sort((a, b) => (b.on + b.at).localeCompare(a.on + a.at));
})();

export interface PostureRecord {
  e: Employee;
  /** Second factor enrolled. */
  mfa: boolean;
  /** Enrolled in mobile device management. */
  managed: boolean;
  encrypted: boolean;
  patched: boolean;
  lastSeen: string;
}

/** Device and identity posture, derived from the workforce. */
export const POSTURE: PostureRecord[] = ACTIVE().map((e) => ({
  e,
  /* MFA is mandatory for the departments that touch personal data */
  mfa: chance(0.88) || ['HR', 'FIN', 'IT'].includes(e.dept),
  managed: chance(0.91),
  encrypted: chance(0.94),
  patched: chance(0.83),
  lastSeen: ymd(addDays(TODAY, -ri(0, 26))),
}));
