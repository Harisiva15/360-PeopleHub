/**
 * Payroll — salary structures, cycles, payslips and their totals.
 *
 * **A payslip is stored, not recomputed.** This is the decision the whole
 * module turns on. The prototype derived a payslip from the employee's current
 * CTC every time it was opened, which means reopening March's payslip after an
 * April increment silently shows April's numbers. A payslip is a historical
 * document — in India it is one an employee can be asked to produce years
 * later — so `processRun` computes every line once and writes it to
 * `payslip_line`, and every read after that returns what was written.
 *
 * That is also why a run locks. `pay_run.locked` plus the schema's
 * `CHECK (status <> 'paid' OR (paid_on IS NOT NULL AND locked))` mean a paid
 * cycle cannot be quietly recomputed.
 *
 * **A draft run is a preview.** Reading a draft computes from today's
 * structures and stores nothing, so finance can see what the month looks like
 * before committing to it. The moment it is processed, the numbers freeze.
 *
 * **Loss of pay comes from attendance**, not from a field somebody types: an
 * absent day with no approved regularisation is unpaid. That is the one place
 * payroll reaches into another module, and it reads the same rows the
 * attendance screens do.
 *
 * ## What this module cannot do
 *
 * It cannot pay anybody. Bank account numbers and PAN were deliberately left
 * out of the schema, so `bank_batch` records a total and a count but no
 * payment instruction, and TDS is computed but not attributable for filing.
 * Those columns are a decision to revisit, not an oversight to work around.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import {
  currencyFor, dailyRateFor, hraExemption, monthlySlip, structureFor,
} from './rules.ts';
import type { Country, Line, Structure } from './rules.ts';

export class PayrollError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'PayrollError';
    this.code = code;
  }
}

export interface PayRun {
  mk: string;
  status: string;
  runOn: string | null;
  paidOn: string | null;
  by: string;
  locked: boolean;
}

export interface PayLine { k: string; a: number; tag?: string }

export interface Payslip {
  empId: string;
  mk: string;
  dim: number;
  lop: number;
  payDays: number;
  earn: PayLine[];
  gross: number;
  ded: PayLine[];
  totalDed: number;
  reimb: number;
  net: number;
  pfER: number;
  esiER: number;
  regime: string | null;
  annualTax: number;
  statutory: { pf: number; esi: number; pt: number; tax: number };
  country: string;
  ccy: string;
  ctcMonthly: number;
}

/** Only an admin sees other people's pay. Everyone sees their own. */
function maySeeAll(caller: Caller): boolean {
  return caller.role === 'admin';
}

function assertOwnOrAdmin(caller: Caller, empId: string): void {
  if (empId !== caller.employeeId && !maySeeAll(caller)) {
    throw new PayrollError('you can only see your own pay', 'forbidden');
  }
}

const mkOf = (periodMonth: string): string => periodMonth.slice(0, 7);
const firstOf = (mk: string): string => `${mk}-01`;
const daysInMonth = (mk: string): number => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y!, m!, 0).getDate();
};

/* ---------- salary structures ---------- */

interface EmployeePay {
  id: string;
  code: string;
  name: string;
  country: Country;
  ctc: number;
  professionalTax: number;
  joinedOn: string;
  leftOn: string | null;
}

const PAY_EMPLOYEE = `
  SELECT e.id, e.code, e.full_name, e.ctc, e.joined_on, e.left_on,
         COALESCE(le.country, 'IN') AS country
    FROM employee e
    LEFT JOIN legal_entity le ON le.id = e.legal_entity_id`;

const toPayEmployee = (r: Record<string, unknown>): EmployeePay => ({
  id: r.id as string,
  code: r.code as string,
  name: r.full_name as string,
  country: (r.country as Country) ?? 'IN',
  ctc: r.ctc === null ? 0 : Number(r.ctc),
  // Professional tax is a state levy. Until the site carries its own rate,
  // Tamil Nadu's half-yearly slab expressed monthly is the honest default for
  // an India-registered entity, and zero everywhere else.
  professionalTax: (r.country as string) === 'IN' ? 208 : 0,
  joinedOn: r.joined_on as string,
  leftOn: (r.left_on as string | null) ?? null,
});

/**
 * The structure behind one person's pay.
 *
 * Derived from CTC rather than read from `salary_structure`, because that
 * table is written when a structure is *revised* and most employees have never
 * had one written. Deriving keeps a new joiner's payslip correct on day one;
 * a stored revision, when it exists, takes precedence.
 */
async function structureOf(db: TenantClient, e: EmployeePay): Promise<Structure> {
  const stored = await db.query(
    `SELECT annual_ctc FROM salary_structure
      WHERE employee_id = $1 AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1`, [e.id]);
  const ctc = stored.rows[0] ? Number(stored.rows[0].annual_ctc) : e.ctc;
  return structureFor(ctc, e.country);
}

export async function salaryStructureOf(caller: Caller, empId: string): Promise<Structure> {
  assertOwnOrAdmin(caller, empId);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${PAY_EMPLOYEE} WHERE e.id = $1`, [empId]);
    if (!rows[0]) throw new PayrollError('no such employee', 'not_found');
    return structureOf(db, toPayEmployee(rows[0]));
  });
}

export interface CompRow {
  empId: string;
  code: string;
  name: string;
  ctc: number;
  ccy: string;
  grossA: number;
  basicA: number;
  country: string;
}

export async function compensation(caller: Caller): Promise<CompRow[]> {
  if (!maySeeAll(caller)) {
    throw new PayrollError('only an admin may see the compensation view', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PAY_EMPLOYEE} WHERE e.status <> 'exited' ORDER BY e.code`);
    const out: CompRow[] = [];
    for (const r of rows) {
      const e = toPayEmployee(r);
      const s = await structureOf(db, e);
      out.push({
        empId: e.id, code: e.code, name: e.name, ctc: s.ctc, ccy: s.ccy,
        grossA: s.grossA, basicA: s.earnings[0]?.a ?? 0, country: e.country,
      });
    }
    return out;
  });
}

export async function dailyRates(
  caller: Caller,
  empIds: string[],
): Promise<Record<string, number>> {
  if (!empIds.length) return {};
  if (!maySeeAll(caller) && !(empIds.length === 1 && empIds[0] === caller.employeeId)) {
    throw new PayrollError('only an admin may price other people', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PAY_EMPLOYEE} WHERE e.id = ANY($1::uuid[])`, [empIds]);
    const out: Record<string, number> = {};
    for (const r of rows) {
      const e = toPayEmployee(r);
      out[e.id] = dailyRateFor(await structureOf(db, e));
    }
    return out;
  });
}

/* ---------- cycles ---------- */

const RUN_PROJECTION = `
  SELECT r.id, r.period_month, r.status, r.locked, r.run_on, r.paid_on,
         COALESCE(p.full_name, '') AS processed_by_name
    FROM pay_run r
    LEFT JOIN employee p ON p.id = r.processed_by`;

const toRun = (r: Record<string, unknown>): PayRun => ({
  mk: mkOf(r.period_month as string),
  status: (r.status as string) === 'paid' ? 'Paid' : 'Draft',
  runOn: (r.run_on as string | null) ?? null,
  paidOn: (r.paid_on as string | null) ?? null,
  by: (r.processed_by_name as string) ?? '',
  locked: Boolean(r.locked),
});

export async function listRuns(caller: Caller): Promise<PayRun[]> {
  if (!maySeeAll(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${RUN_PROJECTION} ORDER BY r.period_month`);
    return rows.map(toRun);
  });
}

/**
 * The cycle currently being worked on.
 *
 * Created on demand for the current month if it does not exist, because a
 * payroll screen with no cycle is a screen that cannot be started from.
 */
export async function currentRun(caller: Caller): Promise<PayRun> {
  if (!maySeeAll(caller)) {
    throw new PayrollError('only an admin may see the payroll cycle', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    const entity = await db.query(
      'SELECT id FROM legal_entity WHERE is_default LIMIT 1');
    if (!entity.rows[0]) throw new PayrollError('no default legal entity configured', 'invalid');

    const { rows } = await db.query(
      `INSERT INTO pay_run (legal_entity_id, period_month)
       VALUES ($1, date_trunc('month', CURRENT_DATE)::date)
       ON CONFLICT (tenant_id, legal_entity_id, period_month) DO UPDATE
         SET period_month = EXCLUDED.period_month
       RETURNING id`, [entity.rows[0].id]);

    const back = await db.query(`${RUN_PROJECTION} WHERE r.id = $1`, [rows[0].id]);
    return toRun(back.rows[0]!);
  });
}

/* ---------- payslips ---------- */

/** Unapproved absent days in a month. An absence nobody corrected is unpaid. */
async function lopDays(db: TenantClient, empId: string, mk: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int n
       FROM attendance a
       LEFT JOIN regularisation r
         ON r.attendance_id = a.id AND r.status = 'approved'
      WHERE a.employee_id = $1
        AND to_char(a.work_date, 'YYYY-MM') = $2
        AND a.status = 'A'
        AND r.id IS NULL`, [empId, mk]);
  return rows[0].n as number;
}

interface OffCycle { bonus: number; arrears: number; incentive: number; other: number; reimb: number }
const NO_INPUT: OffCycle = { bonus: 0, arrears: 0, incentive: 0, other: 0, reimb: 0 };

async function offCycleFor(db: TenantClient, runId: string): Promise<Record<string, OffCycle>> {
  const { rows } = await db.query(
    `SELECT employee_id, kind, sum(amount) AS amount
       FROM pay_input WHERE pay_run_id = $1
      GROUP BY employee_id, kind`, [runId]);
  const out: Record<string, OffCycle> = {};
  for (const r of rows) {
    const id = r.employee_id as string;
    out[id] = out[id] ?? { ...NO_INPUT };
    const amount = Number(r.amount);
    if (r.kind === 'bonus') out[id].bonus += amount;
    else if (r.kind === 'arrears') out[id].arrears += amount;
    else if (r.kind === 'incentive') out[id].incentive += amount;
    else out[id].other += amount;
  }
  return out;
}

/** The declared tax position for a financial year, if any. */
async function regimeFor(
  db: TenantClient,
  empId: string,
  mk: string,
): Promise<{ regime: 'new' | 'old'; deductions: number; rent: number }> {
  const [y, m] = mk.split('-').map(Number);
  const fyStart = `${m! >= 4 ? y! : y! - 1}-04-01`;
  const { rows } = await db.query(
    `SELECT d.regime,
            COALESCE(sum(i.amount) FILTER (WHERE i.code <> 'hra_rent'), 0) AS deductions,
            COALESCE(sum(i.amount) FILTER (WHERE i.code = 'hra_rent'), 0) AS rent
       FROM tax_declaration d
       LEFT JOIN tax_declaration_item i ON i.declaration_id = d.id
      WHERE d.employee_id = $1 AND d.fy_start = $2::date
      GROUP BY d.regime`, [empId, fyStart]);
  if (!rows[0]) return { regime: 'new', deductions: 0, rent: 0 };
  return {
    regime: rows[0].regime as 'new' | 'old',
    deductions: Number(rows[0].deductions),
    rent: Number(rows[0].rent),
  };
}

/** Compute one payslip without storing it. */
async function computeSlip(
  db: TenantClient,
  e: EmployeePay,
  mk: string,
  runId: string | null,
  inputs: OffCycle,
): Promise<Payslip> {
  const s = await structureOf(db, e);
  const dim = daysInMonth(mk);
  const lop = await lopDays(db, e.id, mk);
  const payDays = Math.max(0, dim - lop);

  const tax = e.country === 'IN' ? await regimeFor(db, e.id, mk) : { regime: 'new' as const, deductions: 0, rent: 0 };
  const basicA = s.earnings[0]?.a ?? 0;
  const hraA = s.earnings[1]?.a ?? 0;

  const loan = await db.query(
    `SELECT COALESCE(sum(emi), 0) AS emi FROM loan
      WHERE employee_id = $1 AND status = 'active'`, [e.id]);

  const slip = monthlySlip(s, payDays / dim, {
    bonus: inputs.bonus, arrears: inputs.arrears, incentive: inputs.incentive,
    other: inputs.other, reimb: inputs.reimb,
    ...(Number(loan.rows[0]?.emi ?? 0) ? { loanEmi: Number(loan.rows[0].emi) } : {}),
  }, {
    professionalTax: e.professionalTax,
    regime: tax.regime,
    oldRegimeDeductions: tax.deductions,
    hraExempt: hraExemption(basicA, hraA, tax.rent, true),
  });

  void runId;
  return {
    empId: e.id, mk, dim, lop, payDays,
    earn: slip.earnings, gross: slip.gross,
    ded: slip.deductions, totalDed: slip.totalDeductions,
    reimb: slip.reimbursements, net: slip.net,
    pfER: slip.pfER, esiER: slip.esiER,
    regime: e.country === 'IN' ? (tax.regime === 'old' ? 'Old' : 'New') : null,
    annualTax: slip.annualTax, statutory: slip.statutory,
    country: e.country, ccy: currencyFor(e.country),
    ctcMonthly: Math.round(s.ctc / 12),
  };
}

/** Read a stored payslip back, exactly as it was written. */
async function storedSlip(
  db: TenantClient,
  empId: string,
  mk: string,
): Promise<Payslip | null> {
  const { rows } = await db.query(
    `SELECT p.*, to_char(r.period_month, 'YYYY-MM') AS mk
       FROM payslip p JOIN pay_run r ON r.id = p.pay_run_id
      WHERE p.employee_id = $1 AND to_char(r.period_month, 'YYYY-MM') = $2`, [empId, mk]);
  if (!rows[0]) return null;
  const p = rows[0];

  const lines = await db.query(
    `SELECT kind, label, amount, tag FROM payslip_line
      WHERE payslip_id = $1 ORDER BY display_order, id`, [p.id]);
  const pick = (kind: string): PayLine[] => lines.rows
    .filter((l) => l.kind === kind)
    .map((l) => ({ k: l.label as string, a: Number(l.amount), ...(l.tag ? { tag: l.tag as string } : {}) }));

  const stat = lines.rows.filter((l) => l.tag === 'statutory');
  const sumOf = (needle: string) => stat
    .filter((l) => (l.label as string).toLowerCase().includes(needle))
    .reduce((a, l) => a + Number(l.amount), 0);

  return {
    empId, mk: p.mk as string,
    dim: Number(p.days_in_month), lop: Number(p.loss_of_pay_days),
    payDays: Number(p.paid_days),
    earn: pick('earning'), gross: Number(p.gross),
    ded: pick('deduction'), totalDed: Number(p.total_deductions),
    reimb: Number(p.reimbursements), net: Number(p.net_pay),
    pfER: Number(p.employer_pf), esiER: Number(p.employer_esi),
    regime: (p.tax_regime as string | null) ?? null,
    annualTax: Number(p.annual_tax),
    statutory: {
      pf: sumOf('provident') + Number(p.employer_pf),
      esi: sumOf('esi') + Number(p.employer_esi),
      pt: sumOf('professional'),
      tax: sumOf('tax'),
    },
    country: p.country as string, ccy: p.currency as string,
    ctcMonthly: Number(p.monthly_ctc),
  };
}

export async function payslipFor(
  caller: Caller,
  empId: string,
  mk: string,
): Promise<Payslip> {
  assertOwnOrAdmin(caller, empId);
  return withTenantReadOnly(caller, async (db) => {
    const stored = await storedSlip(db, empId, mk);
    if (stored) return stored;

    // Not processed yet: compute a preview from today's structure.
    const { rows } = await db.query(`${PAY_EMPLOYEE} WHERE e.id = $1`, [empId]);
    if (!rows[0]) throw new PayrollError('no such employee', 'not_found');
    const run = await db.query(
      'SELECT id FROM pay_run WHERE period_month = $1::date', [firstOf(mk)]);
    const inputs = run.rows[0] ? await offCycleFor(db, run.rows[0].id) : {};
    return computeSlip(db, toPayEmployee(rows[0]), mk,
      run.rows[0]?.id ?? null, inputs[empId] ?? { ...NO_INPUT });
  });
}

export async function payslipHistory(
  caller: Caller,
  empId: string,
): Promise<{ run: PayRun; payslip: Payslip }[]> {
  assertOwnOrAdmin(caller, empId);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${RUN_PROJECTION}
        WHERE EXISTS (SELECT 1 FROM payslip p
                       WHERE p.pay_run_id = r.id AND p.employee_id = $1)
        ORDER BY r.period_month DESC`, [empId]);
    const out = [];
    for (const r of rows) {
      const run = toRun(r);
      const slip = await storedSlip(db, empId, run.mk);
      if (slip) out.push({ run, payslip: slip });
    }
    return out;
  });
}

export interface RegisterRow { e: { id: string; code: string; name: string }; p: Payslip }

export async function register(caller: Caller, mk: string): Promise<RegisterRow[]> {
  if (!maySeeAll(caller)) {
    throw new PayrollError('only an admin may see the payroll register', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const run = await db.query(
      'SELECT id, status FROM pay_run WHERE period_month = $1::date', [firstOf(mk)]);
    const inputs = run.rows[0] ? await offCycleFor(db, run.rows[0].id) : {};

    const { rows } = await db.query(
      `${PAY_EMPLOYEE}
        WHERE e.status <> 'exited' AND e.joined_on <= (date_trunc('month', $1::date)
              + interval '1 month' - interval '1 day')::date
        ORDER BY e.code`, [firstOf(mk)]);

    const out: RegisterRow[] = [];
    for (const r of rows) {
      const e = toPayEmployee(r);
      const p = (await storedSlip(db, e.id, mk))
        ?? await computeSlip(db, e, mk, run.rows[0]?.id ?? null, inputs[e.id] ?? { ...NO_INPUT });
      out.push({ e: { id: e.id, code: e.code, name: e.name }, p });
    }
    return out;
  });
}

export interface PayrollTotals {
  count: number;
  gross: number;
  ded: number;
  net: number;
  pf: number;
  tds: number;
  esi: number;
  pt: number;
  lop: number;
  byCountry: Record<string, { count: number; gross: number; net: number; ccy: string }>;
  base: string;
}

export async function totals(caller: Caller, mk: string): Promise<PayrollTotals> {
  const rows = await register(caller, mk);
  const t: PayrollTotals = {
    count: rows.length, gross: 0, ded: 0, net: 0, pf: 0, tds: 0, esi: 0, pt: 0, lop: 0,
    byCountry: {}, base: 'INR',
  };
  for (const { p } of rows) {
    t.gross += p.gross;
    t.ded += p.totalDed;
    t.net += p.net;
    t.pf += p.statutory.pf;
    t.tds += p.statutory.tax;
    t.esi += p.statutory.esi;
    t.pt += p.statutory.pt;
    t.lop += p.lop;
    const c = t.byCountry[p.country] ?? { count: 0, gross: 0, net: 0, ccy: p.ccy };
    c.count += 1; c.gross += p.gross; c.net += p.net;
    t.byCountry[p.country] = c;
  }
  return t;
}

export async function totalsFor(
  caller: Caller,
  mks: string[],
): Promise<Record<string, PayrollTotals>> {
  const out: Record<string, PayrollTotals> = {};
  for (const mk of mks) out[mk] = await totals(caller, mk);
  return out;
}

export async function inputsFor(
  caller: Caller,
  mk: string,
): Promise<Record<string, OffCycle>> {
  if (!maySeeAll(caller)) {
    throw new PayrollError('only an admin may see off-cycle inputs', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const run = await db.query(
      'SELECT id FROM pay_run WHERE period_month = $1::date', [firstOf(mk)]);
    return run.rows[0] ? offCycleFor(db, run.rows[0].id) : {};
  });
}

/**
 * Close a cycle: compute every payslip, store it, and lock the run.
 *
 * Everything happens in one transaction. A run half-processed is worse than
 * one not processed at all — some people paid against stored lines and the
 * rest against a structure that may change tomorrow.
 */
export async function processRun(caller: Caller, mk: string): Promise<PayRun> {
  if (!maySeeAll(caller)) {
    throw new PayrollError('only an admin may process payroll', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const run = await db.query(
      'SELECT id, status, locked FROM pay_run WHERE period_month = $1::date FOR UPDATE',
      [firstOf(mk)]);
    if (!run.rows[0]) throw new PayrollError('no payroll cycle for that month', 'not_found');
    if (run.rows[0].status === 'paid') {
      throw new PayrollError('that cycle has already been paid', 'already_paid');
    }
    const runId = run.rows[0].id as string;

    const inputs = await offCycleFor(db, runId);
    const { rows } = await db.query(
      `${PAY_EMPLOYEE}
        WHERE e.status <> 'exited' AND e.joined_on <= (date_trunc('month', $1::date)
              + interval '1 month' - interval '1 day')::date
        ORDER BY e.code`, [firstOf(mk)]);

    let net = 0;
    let count = 0;
    const statutory = { pf: 0, esi: 0, pt: 0, tax: 0 };

    for (const r of rows) {
      const e = toPayEmployee(r);
      const p = await computeSlip(db, e, mk, runId, inputs[e.id] ?? { ...NO_INPUT });

      const slip = await db.query(
        `INSERT INTO payslip
           (pay_run_id, employee_id, currency, days_in_month, paid_days,
            loss_of_pay_days, gross, total_deductions, reimbursements, net_pay,
            employer_pf, employer_esi, tax_regime, annual_tax, monthly_ctc, country)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (tenant_id, pay_run_id, employee_id) DO UPDATE SET
           gross = EXCLUDED.gross, total_deductions = EXCLUDED.total_deductions,
           reimbursements = EXCLUDED.reimbursements, net_pay = EXCLUDED.net_pay,
           paid_days = EXCLUDED.paid_days, loss_of_pay_days = EXCLUDED.loss_of_pay_days,
           employer_pf = EXCLUDED.employer_pf, employer_esi = EXCLUDED.employer_esi,
           tax_regime = EXCLUDED.tax_regime, annual_tax = EXCLUDED.annual_tax,
           monthly_ctc = EXCLUDED.monthly_ctc, generated_at = now()
         RETURNING id`,
        [runId, e.id, p.ccy, p.dim, p.payDays, p.lop, p.gross, p.totalDed,
          p.reimb, p.net, p.pfER, p.esiER, p.regime, p.annualTax, p.ctcMonthly, p.country]);
      const slipId = slip.rows[0].id as string;

      // Rewritten wholesale: a re-process must not leave last attempt's lines
      // sitting alongside this one's.
      await db.query('DELETE FROM payslip_line WHERE payslip_id = $1', [slipId]);
      const write = async (kind: string, list: Line[]) => {
        for (const [i, l] of list.entries()) {
          await db.query(
            `INSERT INTO payslip_line (payslip_id, kind, label, amount, tag, display_order)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [slipId, kind, l.k, l.a, l.tag ?? null, i]);
        }
      };
      await write('earning', p.earn);
      await write('deduction', p.ded);
      if (p.reimb) await write('reimbursement', [{ k: 'Reimbursements', a: p.reimb }]);

      net += p.net;
      count += 1;
      statutory.pf += p.statutory.pf;
      statutory.esi += p.statutory.esi;
      statutory.pt += p.statutory.pt;
      statutory.tax += p.statutory.tax;
    }

    await db.query(
      `UPDATE pay_run
          SET status = 'paid', locked = true, run_on = CURRENT_DATE,
              paid_on = CURRENT_DATE, processed_by = $2
        WHERE id = $1`, [runId, caller.employeeId]);

    /*
     * The bank advice records a total and a count and nothing else, because
     * there are no account numbers in this schema to pay into. It is a
     * reconciliation record, not a payment instruction.
     */
    await db.query(
      `INSERT INTO bank_batch
         (pay_run_id, bank_name, currency, total_amount, record_count, reference)
       SELECT $1::uuid, COALESCE(le.legal_name, 'Primary bank'), t.base_currency, $2, $3,
              'ADV-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || substr($1::uuid::text, 1, 8)
         FROM tenant t
         LEFT JOIN legal_entity le ON le.is_default
        WHERE t.id = current_tenant_id()`,
      [runId, Math.round(net), count]);

    // Statutory remittances, with the dates they are actually due.
    const due: [string, number, number][] = [
      ['PF', statutory.pf, 15], ['ESI', statutory.esi, 15],
      ['PT', statutory.pt, 30], ['TDS', statutory.tax, 7],
    ];
    for (const [kind, amount, day] of due) {
      if (amount <= 0) continue;
      await db.query(
        `INSERT INTO compliance_payment
           (legal_entity_id, period_month, kind, amount, due_on)
         SELECT r.legal_entity_id, r.period_month, $2, $3,
                (r.period_month + interval '1 month' + ($4 || ' days')::interval)::date
           FROM pay_run r WHERE r.id = $1
         ON CONFLICT (tenant_id, legal_entity_id, period_month, kind)
           DO UPDATE SET amount = EXCLUDED.amount`,
        [runId, kind, Math.round(amount), String(day)]);
    }

    await db.query(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'payroll', 'run_processed', 'notice', $1, COALESCE(e.full_name, 'system'),
              'pay_run', $2, jsonb_build_object('month', $3::text, 'employees', $4::text,
                                                'net', $5::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, runId, mk, String(count), String(Math.round(net))]);

    const back = await db.query(`${RUN_PROJECTION} WHERE r.id = $1`, [runId]);
    return toRun(back.rows[0]!);
  });
}

/* ---------- the money-movement reads ---------- */

export async function bankBatches(caller: Caller): Promise<{
  mk: string; bank: string; mode: string; count: number; amount: number; status: string;
}[]> {
  if (!maySeeAll(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT to_char(r.period_month, 'YYYY-MM') AS mk, b.bank_name, b.record_count,
              b.total_amount, b.status
         FROM bank_batch b JOIN pay_run r ON r.id = b.pay_run_id
        ORDER BY r.period_month DESC`);
    return rows.map((r) => ({
      mk: r.mk as string,
      bank: r.bank_name as string,
      mode: 'NEFT',
      count: Number(r.record_count),
      amount: Number(r.total_amount),
      status: (r.status as string) === 'generated' ? 'Generated' : (r.status as string),
    }));
  });
}

export async function compliancePayments(caller: Caller): Promise<{
  mk: string; kind: string; amount: number; due: string; paid: string | null; status: string;
}[]> {
  if (!maySeeAll(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT to_char(period_month, 'YYYY-MM') AS mk, kind, amount, due_on, paid_on,
              CASE WHEN paid_on IS NOT NULL THEN 'Paid'
                   WHEN due_on < CURRENT_DATE THEN 'Overdue'
                   ELSE 'Due' END AS state
         FROM compliance_payment ORDER BY period_month DESC, kind`);
    return rows.map((r) => ({
      mk: r.mk as string, kind: r.kind as string, amount: Number(r.amount),
      due: r.due_on as string, paid: (r.paid_on as string | null) ?? null,
      status: r.state as string,
    }));
  });
}

export async function activeLoans(caller: Caller): Promise<Record<string, unknown>[]> {
  return withTenantReadOnly(caller, async (db) => {
    const scope = maySeeAll(caller) ? '' : 'AND l.employee_id = $1';
    const { rows } = await db.query(
      `SELECT l.id, l.employee_id, l.principal, l.emi, l.outstanding,
              l.status, l.sanctioned_on, lt.name AS kind
         FROM loan l JOIN loan_type lt ON lt.id = l.loan_type_id
        WHERE l.status = 'active' ${scope}
        ORDER BY l.disbursed_on DESC`,
      maySeeAll(caller) ? [] : [caller.employeeId]);
    return rows.map((r) => ({
      id: r.id, empId: r.employee_id, kind: r.kind,
      principal: Number(r.principal), emi: Number(r.emi),
      outstanding: Number(r.outstanding), status: 'Active',
      takenOn: r.sanctioned_on,
    }));
  });
}
