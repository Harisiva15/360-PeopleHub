/**
 * Compensation — the salary structures and the components they are built from.
 *
 * `salary_structure` has been in the schema since 0004 and written by nothing,
 * so every reader fell through to `employee.ctc` and the table was theory.
 * `salary_component` was read by nobody. This is the write path both were
 * waiting for.
 *
 * **A revision supersedes; it never overwrites.** An employee's pay history is
 * the evidence behind every payslip already issued and every letter that quotes
 * a salary. So a new structure closes the previous one the day before it starts
 * and inserts a new open row — two rows, both true, neither edited. The
 * database backs this up twice: `salary_structure_one_current` permits one
 * open-ended row per employee, and `salary_structure_no_overlap` (0048) makes
 * two structures covering the same day impossible however they are written.
 *
 * **Components are the company's formula, structures are one person's number.**
 * A component says "Basic is 40% of CTC" and "HRA is 50% of Basic"; a structure
 * says "this person, this CTC, from this date". The breakdown is the formula
 * applied to the number, which is why changing a component changes what every
 * structure means and why that is audited.
 *
 * **Nothing is silently adjusted.** If the components do not add up to CTC, the
 * save is refused with the shortfall named. Rounding a few rupees into Special
 * Allowance to make a screen balance is how a payslip comes to disagree with an
 * offer letter, and neither party can say which was wrong.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { applyComponents, COMPONENT_KINDS } from './components.ts';
import type { ComponentKind, SalaryComponent } from './components.ts';
export { applyComponents } from './components.ts';
export type { ComponentKind, SalaryComponent, ComputedLine, Reconciliation } from './components.ts';

export class CompensationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'CompensationError';
    this.code = code;
  }
}

const refuse = (m: string, c = 'invalid'): never => { throw new CompensationError(m, c); };

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

export interface ComponentDraft {
  code: string;
  name: string;
  kind: ComponentKind;
  percentOf?: string | null;
  percent?: number | null;
  flat?: number | null;
  taxable?: boolean;
  order?: number;
  active?: boolean;
}

const toComponent = (r: Record<string, unknown>): SalaryComponent => ({
  code: r.code as string,
  name: r.name as string,
  kind: r.kind as ComponentKind,
  percentOf: (r.percent_of_code as string | null) ?? null,
  percent: r.percent === null ? null : Number(r.percent),
  flat: r.flat_amount === null ? null : Number(r.flat_amount),
  taxable: Boolean(r.taxable),
  order: Number(r.display_order),
  active: Boolean(r.active),
});

const COMPONENT_COLUMNS =
  `SELECT code, name, kind, percent_of_code, percent, flat_amount, taxable,
          display_order, active
     FROM salary_component`;

function assertAdmin(caller: Caller, what: string): void {
  if (caller.role !== 'admin') {
    refuse(`only an admin may ${what}`, 'forbidden');
  }
}

/** Every component, inactive ones included — the screen edits both. */
export async function listComponents(caller: Caller): Promise<SalaryComponent[]> {
  assertAdmin(caller, 'see the salary components');
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${COMPONENT_COLUMNS} ORDER BY display_order, code`);
    return rows.map(toComponent);
  });
}

/**
 * What a component must say before it is worth storing.
 *
 * The schema refuses an unknown kind and a component that is neither a
 * percentage nor an amount. These are the things it cannot see: a percentage
 * of a component that does not exist, a percentage of itself, a negative rate.
 */
function checkComponent(d: ComponentDraft, known: Map<string, SalaryComponent>): void {
  const code = d.code?.trim().toUpperCase() ?? '';
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) {
    refuse('a component code is 2–20 letters, digits or underscores, such as HRA');
  }
  if (!d.name?.trim()) refuse('a component needs a name');
  if (!COMPONENT_KINDS.includes(d.kind)) refuse(`a component is ${COMPONENT_KINDS.join(', ')}`);

  const hasPct = d.percent !== null && d.percent !== undefined;
  const hasFlat = d.flat !== null && d.flat !== undefined;
  if (!hasPct && !hasFlat) refuse('a component is either a percentage or a fixed amount');
  if (hasPct && hasFlat) {
    refuse('a component is a percentage or a fixed amount, not both');
  }
  if (hasPct && !(Number(d.percent) > 0)) refuse('a percentage must be greater than zero');
  if (hasFlat && !(Number(d.flat) >= 0)) refuse('a fixed amount cannot be negative');

  const base = d.percentOf?.trim().toUpperCase() || null;
  if (base) {
    if (!hasPct) refuse('only a percentage can be taken of another component');
    if (base === code) refuse('a component cannot be a percentage of itself');
    if (!known.has(base)) refuse(`there is no component ${base} to take a percentage of`);
    /*
     * One level only. A chain is not wrong in principle, but it needs cycle
     * detection to be safe and nothing asks for it — so it is refused clearly
     * rather than supported badly.
     */
    const parent = known.get(base)!;
    if (parent.percentOf) {
      refuse(`${base} is itself a percentage of ${parent.percentOf} — `
        + 'a component may only be a percentage of CTC or of a component of CTC');
    }
  }
}

/** Create a component, or change one. The code is its identity. */
export async function saveComponent(
  caller: Caller, draft: ComponentDraft,
): Promise<SalaryComponent[]> {
  assertAdmin(caller, 'change the salary components');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(`${COMPONENT_COLUMNS} FOR UPDATE`);
    const known = new Map(rows.map((r) => {
      const c = toComponent(r);
      return [c.code, c] as const;
    }));

    checkComponent(draft, known);
    const code = draft.code.trim().toUpperCase();
    const base = draft.percentOf?.trim().toUpperCase() || null;
    const existed = known.has(code);

    await db.query(
      `INSERT INTO salary_component
         (code, name, kind, percent_of_code, percent, flat_amount, taxable,
          display_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, code) DO UPDATE SET
         name = EXCLUDED.name, kind = EXCLUDED.kind,
         percent_of_code = EXCLUDED.percent_of_code, percent = EXCLUDED.percent,
         flat_amount = EXCLUDED.flat_amount, taxable = EXCLUDED.taxable,
         display_order = EXCLUDED.display_order, active = EXCLUDED.active`,
      [code, draft.name.trim(), draft.kind, base,
        draft.percent ?? null, draft.flat ?? null,
        draft.taxable ?? true, draft.order ?? known.size + 1, draft.active ?? true]);

    await audit(db, caller, existed ? 'compensation.component_changed'
      : 'compensation.component_created', null, code, { name: draft.name.trim() });

    const back = await db.query(`${COMPONENT_COLUMNS} ORDER BY display_order, code`);
    return back.rows.map(toComponent);
  });
}

/**
 * Remove a component.
 *
 * Refused while another component is a percentage of it — removing Basic while
 * HRA is half of Basic leaves HRA meaning nothing. Existing payslips are
 * unaffected either way: `payslip_line` stores what was paid, and this table
 * only describes what to pay next.
 */
export async function removeComponent(
  caller: Caller, code: string,
): Promise<SalaryComponent[]> {
  assertAdmin(caller, 'remove a salary component');

  return withTenant(caller, async (db) => {
    const it = await db.query('SELECT code FROM salary_component WHERE code = $1', [code]);
    if (!it.rows[0]) refuse('no such component', 'not_found');

    const dependents = await db.query(
      'SELECT code FROM salary_component WHERE percent_of_code = $1', [code]);
    if (dependents.rowCount) {
      refuse(`${dependents.rows.map((r) => r.code).join(', ')} `
        + `${dependents.rowCount === 1 ? 'is a percentage' : 'are percentages'} of ${code} — `
        + 'change those first, or make this one inactive instead', 'conflict');
    }

    await db.query('DELETE FROM salary_component WHERE code = $1', [code]);
    await audit(db, caller, 'compensation.component_removed', null, code, {});

    const back = await db.query(`${COMPONENT_COLUMNS} ORDER BY display_order, code`);
    return back.rows.map(toComponent);
  });
}

/* ------------------------------------------------------------------ *
 * Applying the components
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Structures
 * ------------------------------------------------------------------ */

export interface StructureRow {
  id: string;
  empId: string;
  validFrom: string;
  validTo: string | null;
  currency: string;
  ctc: number;
  gross: number;
  /** Why the change was made. Stored in `note`, which is what it is for. */
  reason: string;
  /** Open-ended rows are the one in force; the rest are history. */
  current: boolean;
  createdAt: string;
  /** From the audit trail rather than a column — see `salaryHistory`. */
  createdBy: string | null;
}

export interface StructureDraft {
  ctc: number;
  validFrom: string;
  currency?: string;
  reason?: string;
}

const toStructure = (r: Record<string, unknown>): StructureRow => ({
  id: r.id as string,
  empId: r.employee_id as string,
  validFrom: ymd(r.valid_from),
  validTo: r.valid_to === null ? null : ymd(r.valid_to),
  currency: String(r.currency).trim(),
  ctc: Number(r.annual_ctc),
  gross: Number(r.annual_gross),
  reason: (r.note as string | null) ?? '',
  current: r.valid_to === null,
  createdAt: new Date(r.created_at as string).toISOString(),
  createdBy: (r.created_by as string | null) ?? null,
});

/** Dates come back as Date objects; screens and the API speak yyyy-mm-dd. */
function ymd(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One employee's compensation, newest first.
 *
 * `createdBy` is read from the audit trail rather than stored on the row.
 * Every revision writes an audit entry naming the actor, so the name is
 * already recorded once; a column would be a second copy that can disagree
 * with the first.
 */
export async function salaryHistory(caller: Caller, empId: string): Promise<StructureRow[]> {
  if (empId !== caller.employeeId && caller.role !== 'admin') {
    refuse('you can only see your own compensation', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT s.id, s.employee_id, s.valid_from, s.valid_to, s.currency,
              s.annual_ctc, s.annual_gross, s.note, s.created_at,
              (SELECT a.actor_label FROM audit_log a
                WHERE a.subject_table = 'salary_structure' AND a.subject_id = s.id
                  AND a.action = 'compensation.created'
                ORDER BY a.occurred_at LIMIT 1) AS created_by
         FROM salary_structure s
        WHERE s.employee_id = $1
        ORDER BY s.valid_from DESC, s.created_at DESC`, [empId]);
    return rows.map(toStructure);
  });
}

/**
 * Record a new compensation, superseding whatever was in force.
 *
 * The previous open structure is closed the day before this one begins, so the
 * two meet without touching — `salary_structure_no_overlap` compares half-open
 * ranges, and a gap or an overlap would both be wrong.
 *
 * Refused rather than adjusted when the components do not reconcile. The one
 * exception is a company that has defined no components at all: there is then
 * no formula to reconcile against, the derived defaults in payroll/rules.ts
 * still apply, and the structure records the CTC alone.
 */
export async function setSalaryStructure(
  caller: Caller, empId: string, draft: StructureDraft,
): Promise<StructureRow> {
  assertAdmin(caller, 'set compensation');

  const ctc = Number(draft.ctc);
  if (!Number.isFinite(ctc)) refuse('a compensation needs an annual CTC');
  if (ctc <= 0) refuse('an annual CTC must be greater than zero');
  if (!DATE.test(draft.validFrom ?? '')) refuse('an effective date is needed, as yyyy-mm-dd');

  const from = new Date(`${draft.validFrom}T00:00:00Z`);
  if (Number.isNaN(from.getTime())) refuse('that is not a date');
  const year = Number(draft.validFrom.slice(0, 4));
  if (year < 1900 || year > 2200) refuse('that effective date is not plausible');

  return withTenant(caller, async (db) => {
    const emp = await db.query(
      `SELECT e.id, e.full_name, COALESCE(le.currency, 'INR') AS currency
         FROM employee e
         LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
        WHERE e.id = $1 AND e.status <> 'exited'`, [empId]);
    if (!emp.rows[0]) refuse('no such employee', 'not_found');
    const currency = (draft.currency ?? (emp.rows[0].currency as string)).trim().toUpperCase();

    /* The formula, if the company has written one down. */
    const comps = (await db.query(`${COMPONENT_COLUMNS} ORDER BY display_order, code`))
      .rows.map(toComponent);
    const active = comps.filter((c) => c.active);
    let gross = ctc;

    if (comps.length > 0 && active.length === 0) {
      refuse('every salary component is inactive — there is no formula to apply');
    }
    if (active.length > 0) {
      if (!active.some((c) => c.kind === 'earning')) {
        refuse('there is no earning component — a salary cannot be made of deductions');
      }
      for (const c of active) {
        if (c.percentOf && !active.some((x) => x.code === c.percentOf)) {
          refuse(`${c.name} is a percentage of ${c.percentOf}, which is not active`);
        }
      }
      const r = applyComponents(comps, ctc);
      if (!r.balances) {
        const over = r.difference > 0;
        refuse(
          `the components come to ${fmt(r.counted)} against a CTC of ${fmt(ctc)} — `
          + `${fmt(Math.abs(r.difference))} ${over ? 'more' : 'short'}. `
          + 'Adjust a component so they reconcile; nothing is rounded to make them fit.');
      }
      gross = r.lines
        .filter((l) => l.kind === 'earning')
        .reduce((s, l) => s + l.annual, 0);
    }

    /*
     * Lock this employee's structures for the transaction, so two revisions
     * arriving together cannot both read "no overlap" and both insert.
     */
    const open = await db.query(
      `SELECT id, valid_from FROM salary_structure
        WHERE employee_id = $1 ORDER BY valid_from FOR UPDATE`, [empId]);

    for (const r of open.rows) {
      if (ymd(r.valid_from) === draft.validFrom) {
        refuse(`there is already a compensation effective ${draft.validFrom}`, 'conflict');
      }
    }

    const currentOpen = await db.query(
      `SELECT id, valid_from FROM salary_structure
        WHERE employee_id = $1 AND valid_to IS NULL`, [empId]);

    if (currentOpen.rows[0]) {
      const openFrom = ymd(currentOpen.rows[0].valid_from);
      if (openFrom >= draft.validFrom) {
        refuse(
          `the compensation in force starts on ${openFrom}; a revision must begin after it`,
          'conflict');
      }
      /* Closes the day before the new one opens: they meet, and do not overlap. */
      await db.query(
        `UPDATE salary_structure SET valid_to = ($2::date - 1) WHERE id = $1`,
        [currentOpen.rows[0].id, draft.validFrom]);
    }

    const ins = await db.query(
      `INSERT INTO salary_structure
         (employee_id, valid_from, valid_to, currency, annual_ctc, annual_gross, note)
       VALUES ($1, $2::date, NULL, $3, $4, $5, $6)
       RETURNING id`,
      [empId, draft.validFrom, currency, ctc, gross, draft.reason?.trim() ?? '']);
    const id = ins.rows[0]!.id as string;

    /*
     * The amount is deliberately not in the audit detail. The trail records
     * that compensation changed, for whom and by whom; what it changed to is in
     * salary_structure, behind the compensation permission. An audit viewer is
     * a wider audience than a payroll screen.
     */
    await audit(db, caller, 'compensation.created', id, empId,
      { effective_from: draft.validFrom, reason: draft.reason?.trim() ?? '' });
    if (currentOpen.rows[0]) {
      await audit(db, caller, 'compensation.superseded',
        currentOpen.rows[0].id as string, empId,
        { closed_on: draft.validFrom, replaced_by: id });
    }

    const back = await db.query(
      `SELECT s.id, s.employee_id, s.valid_from, s.valid_to, s.currency,
              s.annual_ctc, s.annual_gross, s.note, s.created_at, NULL AS created_by
         FROM salary_structure s WHERE s.id = $1`, [id]);
    return toStructure(back.rows[0]!);
  });
}

const fmt = (n: number): string => new Intl.NumberFormat('en-IN').format(Math.round(n));

/** One audit row per compensation write, with the actor's name resolved. */
async function audit(
  db: TenantClient,
  caller: Caller,
  action: string,
  subjectId: string | null,
  detailKey: string,
  detail: Record<string, unknown>,
): Promise<void> {
  /*
   * No FROM clause. Selecting the actor's name out of `employee` writes no row
   * at all when that lookup misses, which turns a missing name into a missing
   * audit entry — the one outcome an audit trail may not have.
   */
  await db.query(
    `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                            subject_table, subject_id, detail)
     SELECT 'payroll', $2, 'notice', $1,
            COALESCE((SELECT full_name FROM employee WHERE id = $1), 'system'),
            'salary_structure', $3::uuid,
            $5::jsonb || jsonb_build_object('ref', $4::text)`,
    [caller.employeeId, action, subjectId, detailKey, JSON.stringify(detail)]);
}
