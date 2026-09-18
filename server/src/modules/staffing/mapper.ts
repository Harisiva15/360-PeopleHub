/**
 * Database rows → the staffing shapes the screens render.
 *
 * Its own file because staffing is twelve tables and the projections are the
 * bulk of the work; keeping them beside the service would bury the handful of
 * decisions the service actually makes.
 *
 * Three mismatches recur, the same ones as everywhere else in this codebase:
 * storage enums are lower_snake and the screens render Title Case; `numeric`
 * arrives as a string because the driver is configured not to lose precision
 * on money; and `per_day` in a column is `per day` on a page.
 */

export type Unit = 'per day' | 'per hour';

export const toUnit = (v: unknown): Unit => (v === 'per_hour' ? 'per hour' : 'per day');
export const fromUnit = (v: string): string => (v === 'per hour' ? 'per_hour' : 'per_day');

/** Title Case from a lower_snake enum, for the many status columns here. */
export const title = (v: unknown): string =>
  String(v ?? '').split('_').map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : '')).join(' ');

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v as string | null) ?? '';
const nullable = (v: unknown): string | null => (v as string | null) ?? null;

export interface ClientContact {
  name: string; title: string; email: string; phone: string; primary: boolean;
}

export interface Client {
  id: string; name: string; country: string; ccy: string; industry: string;
  tier: string; paymentTerms: number; since: string; msaSigned: string;
  msaExpiry: string; creditLimit: number; ownerId: string | null;
  deliveryHeadId: string | null; status: string; engagement: string;
  vms: string | null; contacts: ClientContact[]; nps: number; riskFlag: boolean;
}

export const toClient = (r: Record<string, unknown>, contacts: ClientContact[]): Client => ({
  id: r.id as string,
  name: r.name as string,
  country: str(r.country),
  ccy: str(r.currency),
  industry: str(r.industry),
  tier: title(r.tier),
  paymentTerms: num(r.payment_terms_days),
  since: str(r.client_since),
  msaSigned: str(r.msa_signed_on),
  msaExpiry: str(r.msa_expires_on),
  creditLimit: num(r.credit_limit),
  ownerId: nullable(r.owner_id),
  deliveryHeadId: nullable(r.delivery_head_id),
  status: title(r.status),
  engagement: str(r.engagement_model),
  vms: nullable(r.vms),
  contacts,
  nps: num(r.nps),
  riskFlag: Boolean(r.risk_flag),
});

export interface Consultant {
  id: string; empId: string | null; external: boolean; vendorId: string | null;
  name: string; country: string; ccy: string; role: string; skills: string[];
  exp: number; workAuth: string; engagement: string; costPerDay: number;
  status: string; availableFrom: string | null; benchSince: string | null;
  rolledOffFrom?: string | null;
}

export const toConsultant = (r: Record<string, unknown>): Consultant => ({
  id: r.id as string,
  empId: nullable(r.employee_id),
  /* External is derived from which of the two references is set — the schema's
     own CHECK makes exactly one of them non-null, so this cannot disagree. */
  external: r.vendor_id !== null,
  vendorId: nullable(r.vendor_id),
  name: r.full_name as string,
  country: str(r.country),
  ccy: str(r.currency),
  role: str(r.role),
  skills: (r.skills as string[] | null) ?? [],
  exp: num(r.years_experience),
  workAuth: str(r.work_authorisation),
  engagement: r.vendor_id !== null ? 'Vendor' : 'Own payroll',
  costPerDay: num(r.cost_per_day),
  status: title(r.status),
  availableFrom: nullable(r.available_from),
  benchSince: nullable(r.bench_since),
  rolledOffFrom: nullable(r.rolled_off_from),
});

export interface StaffingRequirement {
  id: string; clientId: string; sowId: string | null; title: string; role: string;
  skills: string[]; location: string; ccy: string; billRate: number; unit: Unit;
  maxSubmissions: number; positions: number; filled: number; priority: string;
  receivedOn: string; closeBy: string; recruiterId: string | null; source: string;
  vms: string | null; status: string; duration: string;
}

export const toRequirement = (r: Record<string, unknown>): StaffingRequirement => ({
  id: r.id as string,
  clientId: r.client_id as string,
  sowId: nullable(r.sow_id),
  title: r.title as string,
  role: str(r.role),
  skills: (r.skills as string[] | null) ?? [],
  location: str(r.location),
  ccy: str(r.currency),
  billRate: num(r.bill_rate),
  unit: toUnit(r.unit),
  maxSubmissions: num(r.max_submissions),
  positions: num(r.positions),
  filled: num(r.filled),
  priority: title(r.priority),
  receivedOn: str(r.received_on),
  closeBy: str(r.close_by),
  recruiterId: nullable(r.recruiter_id),
  source: str(r.source),
  vms: nullable(r.vms),
  status: title(r.status),
  duration: str(r.duration),
});

export interface Submission {
  id: string; reqId: string; consultantId: string; conId: string;
  vendorId: string | null; clientId: string; submittedById: string | null;
  submittedOn: string; ccy: string; unit: Unit; billRate: number; payRate: number;
  margin: number; stage: string;
  rtr: { signed: boolean; on: string; validDays: number };
  ownership: { recruiterId: string | null; until: string };
  feedback: string; interviewOn: string | null;
}

export const toSubmission = (r: Record<string, unknown>): Submission => ({
  id: r.id as string,
  reqId: r.requirement_id as string,
  consultantId: r.consultant_id as string,
  /* The screens use both names for the same thing. */
  conId: r.consultant_id as string,
  vendorId: nullable(r.vendor_id),
  clientId: str(r.client_id),
  submittedById: nullable(r.submitted_by),
  submittedOn: str(r.submitted_on),
  ccy: str(r.currency),
  unit: toUnit(r.unit),
  billRate: num(r.bill_rate),
  payRate: num(r.pay_rate),
  margin: num(r.margin_percent),
  stage: title(r.stage),
  rtr: {
    signed: Boolean(r.rtr_signed),
    on: str(r.rtr_signed_on),
    validDays: num(r.rtr_valid_days),
  },
  ownership: {
    recruiterId: nullable(r.owning_recruiter_id),
    until: str(r.ownership_until),
  },
  feedback: str(r.feedback),
  interviewOn: nullable(r.interview_on),
});

export interface Placement {
  id: string; submissionId: string | null; consultantId: string; conId: string;
  clientId: string; sowId: string | null; reqId: string | null;
  vendorId: string | null; role: string; location: string; ccy: string; unit: Unit;
  billRate: number; payRate: number; margin: number;
  start: string; end: string; startOn: string; endOn: string;
  extensions: number; status: string; hoursPerWeek: number; tsCompliance: number;
  poNumber: string;
}

export const toPlacement = (
  r: Record<string, unknown>,
  tsCompliance: number,
  poNumber: string,
): Placement => ({
  id: r.id as string,
  submissionId: nullable(r.submission_id),
  consultantId: r.consultant_id as string,
  conId: r.consultant_id as string,
  clientId: r.client_id as string,
  sowId: nullable(r.sow_id),
  reqId: nullable(r.requirement_id),
  vendorId: nullable(r.vendor_id),
  role: str(r.role),
  location: str(r.location),
  ccy: str(r.currency),
  unit: toUnit(r.unit),
  billRate: num(r.bill_rate),
  payRate: num(r.pay_rate),
  margin: num(r.margin_percent),
  /* Both spellings, because the screens grew two. */
  start: str(r.starts_on),
  end: str(r.ends_on),
  startOn: str(r.starts_on),
  endOn: str(r.ends_on),
  extensions: num(r.extensions),
  status: title(r.status),
  /*
   * Not a column. A placement's weekly hours come from its unit: a per-day
   * engagement is a five-day week at eight hours. Storing it would give two
   * sources for one fact.
   */
  hoursPerWeek: toUnit(r.unit) === 'per day' ? 40 : 40,
  tsCompliance,
  poNumber,
});

export interface Vendor {
  id: string; name: string; country: string; type: string; tier: string; ccy: string;
  contact: string; email: string; msaSigned: string; msaExpiry: string;
  insuranceExpiry: string; w9: boolean; coi: boolean; paymentTerms: number;
  markup: number; subs: number; interviews: number; placements: number;
  fallouts: number; avgSubmitDays: number; status: string; onboarded: string;
}

export const toVendor = (r: Record<string, unknown>): Vendor => ({
  id: r.id as string,
  name: r.name as string,
  country: str(r.country),
  type: title(r.kind),
  tier: title(r.tier),
  ccy: str(r.currency),
  contact: str(r.contact_name),
  email: str(r.contact_email),
  msaSigned: str(r.msa_signed_on),
  msaExpiry: str(r.msa_expires_on),
  insuranceExpiry: str(r.insurance_expires_on),
  w9: Boolean(r.w9_on_file),
  coi: Boolean(r.coi_on_file),
  paymentTerms: num(r.payment_terms_days),
  markup: num(r.markup_percent),
  /* Counted from submissions rather than stored, so they cannot go stale. */
  subs: num(r.subs),
  interviews: num(r.interviews),
  placements: num(r.placements),
  fallouts: num(r.fallouts),
  avgSubmitDays: num(r.avg_submit_days),
  status: title(r.status),
  onboarded: str(r.onboarded_on),
});

export interface Sow {
  id: string; clientId: string; title: string; type: string; ccy: string;
  start: string; end: string; value: number; burned: number; headcount: number;
  filled: number; status: string; po: string; signedBy: string;
  ownerId: string | null; billingCycle: string;
}

export const toSow = (r: Record<string, unknown>): Sow => ({
  id: r.id as string,
  clientId: r.client_id as string,
  title: r.title as string,
  type: title(r.kind),
  ccy: str(r.currency),
  start: str(r.starts_on),
  end: str(r.ends_on),
  value: num(r.contract_value),
  burned: num(r.burned_value),
  headcount: num(r.headcount),
  filled: num(r.filled),
  status: title(r.status),
  po: str(r.purchase_order),
  signedBy: str(r.signed_by),
  ownerId: nullable(r.owner_id),
  billingCycle: title(r.billing_cycle),
});

export interface RateCard {
  id: string; clientId: string; role: string; ccy: string; unit: Unit;
  billRate: number; minMargin: number; location: string; effective: string;
}

export const toRateCard = (r: Record<string, unknown>): RateCard => ({
  id: r.id as string,
  clientId: r.client_id as string,
  role: r.role as string,
  ccy: str(r.currency),
  unit: toUnit(r.unit),
  billRate: num(r.bill_rate),
  /*
   * Not a column. The floor is a company-wide policy rather than a per-card
   * number, so it lives in one place — see MIN_MARGIN in the service.
   */
  minMargin: num(r.min_margin),
  location: str(r.seniority),
  effective: str(r.valid_from),
});

export interface InvoiceLine {
  description: string; units: number; rate: number; amount: number;
}

export interface Invoice {
  id: string; number: string; clientId: string; sowId: string | null;
  periodStart: string; periodEnd: string; ccy: string; subtotal: number;
  taxRate: number; tax: number; total: number; status: string;
  issuedOn: string; dueOn: string; paidOn: string | null;
  submittedVia: string; disputeNote: string; lines: InvoiceLine[];
  /** Days past due, zero when it is not. */
  overdueDays: number;
}

export const toInvoice = (
  r: Record<string, unknown>,
  lines: InvoiceLine[],
  overdueDays: number,
): Invoice => ({
  id: r.id as string,
  number: r.number as string,
  clientId: r.client_id as string,
  sowId: nullable(r.sow_id),
  periodStart: str(r.period_start),
  periodEnd: str(r.period_end),
  ccy: str(r.currency),
  subtotal: num(r.subtotal),
  taxRate: num(r.tax_rate),
  tax: num(r.tax_amount),
  total: num(r.total),
  status: title(r.status),
  issuedOn: str(r.issued_on),
  dueOn: str(r.due_on),
  paidOn: nullable(r.paid_on),
  submittedVia: str(r.submitted_via),
  disputeNote: str(r.dispute_note),
  lines,
  overdueDays,
});
