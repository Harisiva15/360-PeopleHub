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

/** Categories the audit trail is filtered by, in the order they are listed. */
export const AUDIT_CATS = [
  'Payroll', 'Access', 'Employee', 'Attendance', 'Hiring',
  'Compliance', 'Security', 'Leave', 'Finance', 'Staffing',
];

export interface RetentionRow {
  k: string;
  d: string;
  /** Lawful basis the data is held under. */
  law: string;
  keep: string;
  basis: string;
}

/** What the company holds about its people, why, and for how long. */
export const RETENTION: RetentionRow[] = [
  { k: 'Employee master record', d: 'Name, contact, identifiers, job history', law: 'Contract · legitimate interest', keep: '7 years after exit', basis: 'Statutory record keeping' },
  { k: 'Payroll and tax records', d: 'Salary, deductions, tax declarations, Form 16 / W-2 / P60', law: 'Legal obligation', keep: '8 years (IN) · 4 years (US) · 6 years (UK)', basis: 'Income tax and labour law' },
  { k: 'Attendance and location', d: 'Punch records, geo-coordinates at punch, geo-fence result', law: 'Legitimate interest', keep: '24 months', basis: 'Payroll accuracy and dispute resolution' },
  { k: 'Background verification', d: 'Identity, education, employment and criminal checks', law: 'Consent · legal obligation', keep: '3 years after exit', basis: 'Client contractual requirement' },
  { k: 'Health and insurance', d: 'Insurance nominee, claims, medical certificates', law: 'Explicit consent', keep: '3 years after policy end', basis: 'Benefits administration' },
  { k: 'Candidate applications', d: 'CV, interview notes, assessment scores', law: 'Consent', keep: '12 months (unhired)', basis: 'Future opportunity, withdrawable' },
  { k: 'Performance and disciplinary', d: 'Reviews, ratings, PIP, warnings', law: 'Contract', keep: '3 years after exit', basis: 'Employment defence' },
  { k: 'Access and audit logs', d: 'Sign-in, privileged actions, data exports', law: 'Legal obligation', keep: '2 years', basis: 'Security monitoring' },
];

export interface Control {
  k: string;
  d: string;
  s: 'Met' | 'Partial';
}

/** The control framework the posture score is partly weighted on. */
export const CONTROLS: Control[] = [
  { k: 'Encryption in transit', d: 'TLS 1.3 on every connection', s: 'Met' },
  { k: 'Encryption at rest', d: 'AES-256 on database and object storage', s: 'Met' },
  { k: 'Role-based access control', d: 'Admin, Manager and Employee scopes enforced server side', s: 'Met' },
  { k: 'Multi-factor authentication', d: 'Enforced for administrator and payroll roles', s: 'Partial' },
  { k: 'Single sign-on', d: 'SAML 2.0 / OIDC with the corporate identity provider', s: 'Met' },
  { k: 'Audit trail immutability', d: 'Append-only log with 2-year retention', s: 'Met' },
  { k: 'Field-level masking', d: 'Bank, tax identifier and salary masked outside Payroll and HR', s: 'Met' },
  { k: 'Data residency', d: 'India data held in-country; EU and UK data in-region', s: 'Partial' },
  { k: 'Penetration testing', d: 'Independent test at least annually', s: 'Met' },
  { k: 'Backup and recovery', d: 'Daily backup, 4-hour recovery objective, quarterly restore test', s: 'Met' },
  { k: 'Vendor due diligence', d: 'Security review before any sub-processor is engaged', s: 'Partial' },
  { k: 'Breach notification', d: '72-hour notification runbook, tested', s: 'Met' },
];
