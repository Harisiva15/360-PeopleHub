/**
 * Tax declarations.
 *
 * What an employee says they will invest, so payroll deducts the right TDS
 * across the year instead of the whole liability in March.
 *
 * **The regime locks on verification, not on submission.** An employee may
 * change their mind and resubmit for as long as Finance has not checked the
 * proofs; once checked, the numbers behind a TDS calculation that has already
 * been applied cannot move. `tax_declaration`'s status machine says this and
 * the writes here enforce it.
 *
 * **Both regimes are priced on the same gross.** A comparison where one side
 * quietly uses a different income is not a comparison, and the whole point of
 * the screen is to answer "which costs me less".
 *
 * **Caps are applied on read, never on write.** What somebody declares is what
 * is stored; 80C's ₹1,50,000 ceiling is applied when the total is computed. A
 * cap applied at the point of entry silently discards a figure the employee
 * typed and leaves them unable to see why their number changed.
 *
 * **`landlord_pan` is deliberately refused — see `ITEM_CODES`.**
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import {
  hraExemption, structureFor, taxNewRegime, taxOldRegime,
} from '../payroll/rules.ts';
import type { Country, Structure } from '../payroll/rules.ts';
import { EMPLOYEE_PROJECTION } from '../employees/queries.ts';
import { toEmployee } from '../employees/mapper.ts';
import type { Employee } from '../employees/mapper.ts';

export class TaxError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}

/**
 * The declarable items, and their statutory ceiling where one applies.
 *
 * **`landlord_pan` is not here, and that is a decision rather than an
 * oversight.** Rule 26C requires the landlord's PAN once annual rent passes
 * ₹1,00,000, so an employee paying more than ₹8,333 a month cannot complete a
 * compliant HRA claim without it — which is most people renting in Chennai or
 * Bengaluru. The column that would hold it, `tax_declaration_item.text_value`,
 * is plain text, and migration 0003 records a deliberate decision not to keep
 * tax identifiers that way.
 *
 * Accepting it into plain text would quietly reverse that decision through a
 * side door. Refusing it leaves those claims incomplete. Both are real costs,
 * and which one to pay is not a call this module should make on its own, so
 * the item is refused with a message saying why until somebody decides.
 */
const ITEM_CODES: Record<string, { cap: number | null; section: string }> = {
  '80C_pf': { cap: null, section: '80C' },
  '80C_elss': { cap: null, section: '80C' },
  '80C_lic': { cap: null, section: '80C' },
  '80C_tuition': { cap: null, section: '80C' },
  '80D_self': { cap: null, section: '80D' },
  '80D_parents': { cap: null, section: '80D' },
  '80CCD1B': { cap: 50000, section: '80CCD(1B)' },
  '80E': { cap: null, section: '80E' },
  '80G': { cap: null, section: '80G' },
  hra_rent: { cap: null, section: 'HRA' },
  home_loan: { cap: 200000, section: '24(b)' },
};

/** Section ceilings applied when the total is computed, not when it is typed. */
const SECTION_CAP = { c80: 150000, d80: 100000, nps: 50000, loan: 200000 };

export interface Declaration {
  empId: string;
  regime: 'New' | 'Old';
  status: 'Draft' | 'Submitted' | 'Verified' | 'Rejected';
  submittedOn: string | null;
  items: Record<string, number>;
  proofs: string;
}

export interface DeclTotals {
  c80: number;
  d80: number;
  nps: number;
  e80: number;
  g80: number;
  /** Annualised rent paid, which drives the HRA exemption. */
  hra: number;
  loan: number;
  total: number;
}

export interface TaxSummary {
  declaration: Declaration;
  salary: Structure;
  totals: DeclTotals;
  hraExemption: number;
  oldRegime: ReturnType<typeof taxOldRegime>;
  newRegime: ReturnType<typeof taxNewRegime>;
  better: 'New' | 'Old';
}

const TO_STATUS: Record<string, Declaration['status']> = {
  draft: 'Draft', submitted: 'Submitted', verified: 'Verified', rejected: 'Rejected',
};
const TO_REGIME: Record<string, Declaration['regime']> = { new: 'New', old: 'Old' };

/** Metro for the HRA test — the 50% cities rather than every large one. */
const METRO_SITES = new Set(['CHN', 'BLR', 'HYD', 'MUM', 'DEL', 'KOL']);

function assertOwnOrAdmin(caller: Caller, empId: string): void {
  if (caller.role === 'admin') return;
  if (caller.employeeId !== empId) {
    throw new TaxError('a declaration is only visible to its owner and finance', 'forbidden');
  }
}

/** The financial year a date falls in, per the tenant's configured start month. */
async function fyStart(db: TenantClient): Promise<string> {
  const { rows } = await db.query(
    `SELECT make_date(
              CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= t.fiscal_year_start_month
                   THEN EXTRACT(YEAR FROM CURRENT_DATE)::int
                   ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END,
              t.fiscal_year_start_month, 1) AS fy
       FROM tenant t WHERE t.id = current_tenant_id()`);
  const row = rows[0];
  if (!row) throw new TaxError('tenant not found', 'not_found');
  return row.fy as string;
}

/**
 * Read one declaration, creating the year's row on first touch.
 *
 * A person who has never opened the screen has no row, and returning null
 * would make every caller handle "no declaration yet" separately. An empty
 * draft is the correct state for somebody who has declared nothing, so that is
 * what they get.
 */
async function declarationRow(
  db: TenantClient, empId: string, create: boolean,
): Promise<Declaration> {
  const fy = await fyStart(db);

  if (create) {
    await db.query(
      `INSERT INTO tax_declaration (employee_id, fy_start) VALUES ($1, $2)
       ON CONFLICT (tenant_id, employee_id, fy_start) DO NOTHING`, [empId, fy]);
  }

  const { rows } = await db.query(
    `SELECT d.id, d.employee_id, d.regime, d.status, d.submitted_on, d.proofs_note
       FROM tax_declaration d WHERE d.employee_id = $1 AND d.fy_start = $2`, [empId, fy]);
  const d = rows[0];
  if (!d) {
    return {
      empId, regime: 'New', status: 'Draft', submittedOn: null,
      items: Object.fromEntries(Object.keys(ITEM_CODES).map((k) => [k, 0])),
      proofs: '',
    };
  }

  const items = await db.query(
    'SELECT code, amount FROM tax_declaration_item WHERE declaration_id = $1', [d.id]);
  const declared = Object.fromEntries(Object.keys(ITEM_CODES).map((k) => [k, 0]));
  for (const r of items.rows) {
    if (r.code in declared) declared[r.code as string] = Number(r.amount ?? 0);
  }

  return {
    empId: d.employee_id as string,
    regime: TO_REGIME[d.regime as string] ?? 'New',
    status: TO_STATUS[d.status as string] ?? 'Draft',
    submittedOn: (d.submitted_on as string | null) ?? null,
    items: declared,
    proofs: (d.proofs_note as string) ?? '',
  };
}

/** Section ceilings, applied here so what was typed is still what was stored. */
export function totalsOf(items: Record<string, number>): DeclTotals {
  const n = (k: string) => Number(items[k] ?? 0);
  const c80 = Math.min(SECTION_CAP.c80,
    n('80C_pf') + n('80C_elss') + n('80C_lic') + n('80C_tuition'));
  const d80 = Math.min(SECTION_CAP.d80, n('80D_self') + n('80D_parents'));
  const nps = Math.min(SECTION_CAP.nps, n('80CCD1B'));
  const e80 = n('80E');
  /* 80G is half-deductible for the general category of eligible funds. */
  const g80 = Math.round(n('80G') * 0.5);
  const loan = Math.min(SECTION_CAP.loan, n('home_loan'));
  return {
    c80, d80, nps, e80, g80,
    hra: n('hra_rent') * 12,
    loan,
    total: c80 + d80 + nps + e80 + g80 + loan,
  };
}

interface PayFacts { ctc: number; country: Country; site: string }

async function payFactsFor(db: TenantClient, empId: string): Promise<PayFacts> {
  const { rows } = await db.query(
    `SELECT COALESCE(ss.annual_ctc, e.ctc, 0) AS ctc,
            COALESCE(le.country, 'IN') AS country,
            COALESCE(s.code, '') AS site
       FROM employee e
       LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
       LEFT JOIN site s ON s.id = e.site_id
       LEFT JOIN LATERAL (
         SELECT x.annual_ctc FROM salary_structure x
          WHERE x.employee_id = e.id AND x.valid_to IS NULL
          ORDER BY x.valid_from DESC LIMIT 1
       ) ss ON true
      WHERE e.id = $1`, [empId]);
  const r = rows[0];
  if (!r) throw new TaxError('no such employee', 'not_found');
  return {
    ctc: Number(r.ctc),
    country: (r.country as Country) ?? 'IN',
    site: r.site as string,
  };
}

export async function declarationFor(caller: Caller, empId: string): Promise<Declaration> {
  assertOwnOrAdmin(caller, empId);
  return withTenantReadOnly(caller, (db) => declarationRow(db, empId, false));
}

/** Everyone's, keyed by employee. Finance's tracker reads this. */
export async function allDeclarations(caller: Caller): Promise<Record<string, Declaration>> {
  if (caller.role !== 'admin') {
    throw new TaxError('only finance may see every declaration', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      "SELECT id FROM employee WHERE status <> 'exited' ORDER BY code");
    const out: Record<string, Declaration> = {};
    for (const r of rows) {
      out[r.id as string] = await declarationRow(db, r.id as string, false);
    }
    return out;
  });
}

/**
 * One person's position for the year, with both regimes priced.
 *
 * The old regime is priced on gross *less* the HRA exemption, because that
 * exemption only exists under the old regime — pricing both on the same
 * post-exemption figure would flatter the new one.
 */
export async function taxSummary(caller: Caller, empId: string): Promise<TaxSummary> {
  assertOwnOrAdmin(caller, empId);
  return withTenantReadOnly(caller, async (db) => {
    const decl = await declarationRow(db, empId, false);
    const facts = await payFactsFor(db, empId);
    return summaryFrom(decl, facts);
  });
}

function summaryFrom(declaration: Declaration, facts: PayFacts): TaxSummary {
  const salary = structureFor(facts.ctc, facts.country);
  const totals = totalsOf(declaration.items);
  const basicA = salary.earnings[0]?.a ?? 0;
  /*
   * Found by tag, not by label. The Indian line reads "House Rent Allowance",
   * which does not contain the string "hra" — matching on the display name
   * silently returned zero exemption for everybody.
   */
  const hraA = salary.earnings.find((l) => l.tag === 'hra')?.a ?? 0;
  /* Section 10(13A) is an Indian exemption; elsewhere there is nothing to exempt. */
  const exempt = facts.country === 'IN'
    ? hraExemption(basicA, hraA, totals.hra, METRO_SITES.has(facts.site))
    : 0;

  const oldRegime = taxOldRegime(salary.grossA - exempt, totals.total);
  const newRegime = taxNewRegime(salary.grossA);

  return {
    declaration,
    salary,
    totals,
    hraExemption: exempt,
    oldRegime,
    newRegime,
    better: oldRegime.total <= newRegime.total ? 'Old' : 'New',
  };
}

export interface TaxRow {
  employee: Employee;
  declaration: Declaration;
  totals: DeclTotals;
  taxPayable: number;
}

/** The tracker across the workforce. Finance only. */
export async function taxRows(caller: Caller): Promise<TaxRow[]> {
  if (caller.role !== 'admin') {
    throw new TaxError('only finance may see the declaration tracker', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${EMPLOYEE_PROJECTION} WHERE e.status <> 'exited' ORDER BY e.code`);
    const out: TaxRow[] = [];
    for (const r of rows) {
      const empId = r.id as string;
      const decl = await declarationRow(db, empId, false);
      const s = summaryFrom(decl, await payFactsFor(db, empId));
      out.push({
        /* Finance sees compensation — that is the whole point of the tracker. */
        employee: toEmployee(r as never, true),
        declaration: decl,
        totals: s.totals,
        /* What they will actually pay, on the regime they chose. */
        taxPayable: decl.regime === 'Old' ? s.oldRegime.total : s.newRegime.total,
      });
    }
    return out;
  });
}

/**
 * Save declared investments, and submit them.
 *
 * Saving is submitting: the screen has no separate draft state, and a
 * declaration nobody submitted is one Finance never sees. Amounts are stored
 * as typed — the caps in `totalsOf` are a reading of the numbers, not an edit
 * to them.
 */
export async function saveDeclaration(
  caller: Caller,
  empId: string,
  items: Record<string, unknown>,
): Promise<Declaration> {
  assertOwnOrAdmin(caller, empId);

  /* Unknown codes are refused rather than dropped, so a typo is visible. */
  for (const code of Object.keys(items)) {
    if (code === 'landlord_pan') {
      throw new TaxError(
        "the landlord's PAN is not stored in this deployment — see the note in "
        + 'the tax module about Rule 26C', 'not_supported');
    }
    if (!(code in ITEM_CODES)) {
      throw new TaxError(`not a declarable item: ${code}`, 'invalid');
    }
  }

  const clean: Record<string, number> = {};
  for (const [code, raw] of Object.entries(items)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new TaxError(`${code} must be a positive amount`, 'invalid');
    }
    const { cap } = ITEM_CODES[code]!;
    /*
     * A per-item ceiling is refused rather than silently trimmed: 80CCD(1B)
     * caps at 50,000 whatever you invest, and quietly rewriting 80,000 to
     * 50,000 leaves somebody convinced they declared the larger figure.
     */
    if (cap !== null && n > cap) {
      throw new TaxError(
        `${ITEM_CODES[code]!.section} is capped at ${cap.toLocaleString('en-IN')} — `
        + `declared ${n.toLocaleString('en-IN')}`, 'invalid');
    }
    clean[code] = Math.round(n);
  }

  return withTenant(caller, async (db) => {
    const fy = await fyStart(db);
    await db.query(
      `INSERT INTO tax_declaration (employee_id, fy_start) VALUES ($1, $2)
       ON CONFLICT (tenant_id, employee_id, fy_start) DO NOTHING`, [empId, fy]);

    const cur = await db.query(
      `SELECT id, status FROM tax_declaration
        WHERE employee_id = $1 AND fy_start = $2 FOR UPDATE`, [empId, fy]);
    const row = cur.rows[0]!;
    if (row.status === 'verified') {
      throw new TaxError(
        'finance has verified this declaration — raise a ticket to reopen it', 'locked');
    }

    for (const [code, amount] of Object.entries(clean)) {
      await db.query(
        `INSERT INTO tax_declaration_item (declaration_id, code, amount)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, declaration_id, code)
         DO UPDATE SET amount = EXCLUDED.amount`, [row.id, code, amount]);
    }

    await db.query(
      `UPDATE tax_declaration
          SET status = 'submitted', submitted_on = CURRENT_DATE
        WHERE id = $1`, [row.id]);

    return declarationRow(db, empId, false);
  });
}

/** Switch regime. Refused once Finance has verified the proofs. */
export async function setRegime(
  caller: Caller,
  empId: string,
  regime: string,
): Promise<Declaration> {
  assertOwnOrAdmin(caller, empId);
  const stored = Object.keys(TO_REGIME).find((k) => TO_REGIME[k] === regime);
  if (!stored) throw new TaxError(`unknown regime: ${regime}`, 'invalid');

  return withTenant(caller, async (db) => {
    const fy = await fyStart(db);
    await db.query(
      `INSERT INTO tax_declaration (employee_id, fy_start) VALUES ($1, $2)
       ON CONFLICT (tenant_id, employee_id, fy_start) DO NOTHING`, [empId, fy]);

    const cur = await db.query(
      `SELECT id, status FROM tax_declaration
        WHERE employee_id = $1 AND fy_start = $2 FOR UPDATE`, [empId, fy]);
    if (cur.rows[0]!.status === 'verified') {
      throw new TaxError('the regime is locked once finance has verified the proofs', 'locked');
    }

    await db.query('UPDATE tax_declaration SET regime = $2 WHERE id = $1',
      [cur.rows[0]!.id, stored]);
    return declarationRow(db, empId, false);
  });
}

/**
 * Say the proofs have been handed over.
 *
 * A note rather than an attachment: object storage is not built, so what this
 * records is that somebody says the paperwork exists, not the paperwork. The
 * note says so in as many words rather than implying a file is on file.
 */
export async function submitProofs(
  caller: Caller,
  empId: string,
  note?: string,
): Promise<Declaration> {
  assertOwnOrAdmin(caller, empId);

  return withTenant(caller, async (db) => {
    const fy = await fyStart(db);
    const cur = await db.query(
      `SELECT id, status FROM tax_declaration
        WHERE employee_id = $1 AND fy_start = $2 FOR UPDATE`, [empId, fy]);
    const row = cur.rows[0];
    if (!row) throw new TaxError('nothing declared yet', 'not_found');
    if (row.status === 'draft') {
      throw new TaxError('declare your investments before submitting proofs', 'invalid');
    }

    await db.query('UPDATE tax_declaration SET proofs_note = $2 WHERE id = $1',
      [row.id, (note ?? '').trim() || 'Proofs handed to finance (not stored in the system)']);
    return declarationRow(db, empId, false);
  });
}

/** Finance checks the proofs. A draft has nothing to check. */
export async function verifyDeclaration(
  caller: Caller,
  empId: string,
): Promise<Declaration> {
  if (caller.role !== 'admin' || !caller.employeeId) {
    throw new TaxError('only finance may verify a declaration', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const fy = await fyStart(db);
    const cur = await db.query(
      `SELECT id, status FROM tax_declaration
        WHERE employee_id = $1 AND fy_start = $2 FOR UPDATE`, [empId, fy]);
    const row = cur.rows[0];
    if (!row) throw new TaxError('nothing declared yet', 'not_found');
    if (row.status === 'draft') throw new TaxError('nothing submitted to verify yet', 'invalid');
    if (row.status === 'verified') throw new TaxError('already verified', 'already_decided');

    await db.query(
      `UPDATE tax_declaration
          SET status = 'verified', verified_on = CURRENT_DATE, verified_by = $2
        WHERE id = $1`, [row.id, caller.employeeId]);
    return declarationRow(db, empId, false);
  });
}
