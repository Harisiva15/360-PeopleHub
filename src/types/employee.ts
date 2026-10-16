import type { CountryId, CurrencyId, Grade } from './country';
import type { Ymd } from '../lib/dates';

export type EmpStatus = 'Active' | 'Exited';
export type EmpType = 'Full-time' | 'Contract';
/*
 * The assigned roles. `manager` is deliberately absent: answering for other
 * people is a fact about the reporting tree, not a title, and it applies on
 * top of whichever of these somebody holds. See server/src/auth/policy.ts.
 */
export type AppRole = 'employee' | 'hr_admin' | 'finance_admin' | 'company_admin';

export interface Employee {
  id: string;
  /** Payroll code, e.g. TT1042. */
  code: string;
  name: string;
  gender: 'M' | 'F' | 'X';
  dob: Ymd;
  doj: Ymd;
  /** Date of leaving — null while active. */
  dol: Ymd | null;
  email: string;
  phone: string;
  dept: string;
  designation: string;
  grade: Grade;
  site: string;
  country: CountryId;
  ccy: CurrencyId;
  /** Employing legal entity, keyed by country. */
  entityId: CountryId;
  managerId: string | null;
  status: EmpStatus;
  empType: EmpType;
  /** Annual cost to company, in the employee's local currency. */
  ctc: number;
  bank: string;
  acct: string;
  ifsc: string;
  blood: string;
  address: string;
  emergency: string;
  skills: string[];
  role: AppRole;
  /** Ids of active direct reports. */
  reports: string[];
  shift: string;
  probation: boolean;
  exitReason: string | null;
  /** Statutory notice period in days, per the employing country. */
  notice: number;

  /* India statutory identifiers — null outside India */
  pan: string | null;
  uan: string | null;
  pf: string | null;
  esi: string | null;

  /* country-specific identifiers */
  ssn?: string;
  sin?: string;
  nino?: string;
  eid?: string;
  workAuth?: string;
}
