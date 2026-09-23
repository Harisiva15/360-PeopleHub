/**
 * Compensation, in the demo.
 *
 * The rules restated here are the ones somebody can hit by filling the form in
 * — a component that is a percentage of nothing, a revision dated before the
 * one in force, a formula that does not add up to CTC. A demo that accepts what
 * production refuses teaches the wrong thing about the product.
 *
 * The starting components are the same six the migration seeds, and they
 * reconcile to exactly 100% of CTC, so the screen opens on a formula that
 * balances rather than on an error.
 */

import { ACTIVE } from '../../data/employees';
import type {
  ComponentDraft, CompensationService, SalaryComponent,
  StructureDraft, StructureRow,
} from '../contracts';
import { applyComponents } from '../../lib/compensation';
import { ok } from './util';

/* The company's formula. Percentages of CTC unless `percentOf` names a base. */
const COMPONENTS: SalaryComponent[] = [
  { code: 'BASIC', name: 'Basic Salary', kind: 'earning', percentOf: null, percent: 40, flat: null, taxable: true, order: 1, active: true },
  { code: 'HRA', name: 'House Rent Allowance', kind: 'earning', percentOf: 'BASIC', percent: 50, flat: null, taxable: true, order: 2, active: true },
  { code: 'LTA', name: 'Leave Travel Allowance', kind: 'earning', percentOf: 'BASIC', percent: 8, flat: null, taxable: true, order: 3, active: true },
  { code: 'SPECIAL', name: 'Special Allowance', kind: 'earning', percentOf: null, percent: 30.076, flat: null, taxable: true, order: 4, active: true },
  { code: 'PF_ER', name: 'Employer PF Contribution', kind: 'employer_contribution', percentOf: 'BASIC', percent: 12, flat: null, taxable: false, order: 5, active: true },
  { code: 'GRATUITY', name: 'Gratuity Accrual', kind: 'employer_contribution', percentOf: 'BASIC', percent: 4.81, flat: null, taxable: false, order: 6, active: true },
];

/** Structures written in this session, so the screen responds to its own saves. */
const STRUCTURES: StructureRow[] = [];

const no = (m: string) => Promise.reject(new Error(m));
const fmt = (n: number) => new Intl.NumberFormat('en-IN').format(Math.round(n));
const dayBefore = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

export const compensationService: CompensationService = {
  components() { return ok(COMPONENTS.slice()); },

  saveComponent(draft: ComponentDraft) {
    const code = draft.code.trim().toUpperCase();
    if (!/^[A-Z0-9_]{2,20}$/.test(code)) {
      return no('A component code is 2–20 letters, digits or underscores, such as HRA');
    }
    if (!draft.name.trim()) return no('A component needs a name');
    const hasPct = draft.percent !== null && draft.percent !== undefined;
    const hasFlat = draft.flat !== null && draft.flat !== undefined;
    if (!hasPct && !hasFlat) return no('A component is either a percentage or a fixed amount');
    if (hasPct && hasFlat) return no('A component is a percentage or a fixed amount, not both');
    if (hasPct && !(Number(draft.percent) > 0)) return no('A percentage must be greater than zero');
    if (hasFlat && !(Number(draft.flat) >= 0)) return no('A fixed amount cannot be negative');

    const base = draft.percentOf?.trim().toUpperCase() || null;
    if (base) {
      if (!hasPct) return no('Only a percentage can be taken of another component');
      if (base === code) return no('A component cannot be a percentage of itself');
      const parent = COMPONENTS.find((c) => c.code === base);
      if (!parent) return no(`There is no component ${base} to take a percentage of`);
      if (parent.percentOf) {
        return no(`${base} is itself a percentage of ${parent.percentOf} — a component may `
          + 'only be a percentage of CTC or of a component of CTC');
      }
    }

    const made: SalaryComponent = {
      code,
      name: draft.name.trim(),
      kind: draft.kind,
      percentOf: base,
      percent: hasPct ? Number(draft.percent) : null,
      flat: hasFlat ? Number(draft.flat) : null,
      taxable: draft.taxable ?? true,
      order: draft.order ?? COMPONENTS.length + 1,
      active: draft.active ?? true,
    };
    const at = COMPONENTS.findIndex((c) => c.code === code);
    if (at >= 0) COMPONENTS[at] = made; else COMPONENTS.push(made);
    return ok(COMPONENTS.slice());
  },

  removeComponent(code: string) {
    const at = COMPONENTS.findIndex((c) => c.code === code);
    if (at < 0) return no('No such component');
    const dependents = COMPONENTS.filter((c) => c.percentOf === code);
    if (dependents.length) {
      return no(`${dependents.map((c) => c.code).join(', ')} `
        + `${dependents.length === 1 ? 'is a percentage' : 'are percentages'} of ${code} — `
        + 'change those first, or make this one inactive instead');
    }
    COMPONENTS.splice(at, 1);
    return ok(COMPONENTS.slice());
  },

  setStructure(empId: string, draft: StructureDraft) {
    const ctc = Number(draft.ctc);
    if (!Number.isFinite(ctc) || ctc <= 0) return no('An annual CTC must be greater than zero');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.validFrom ?? '')) {
      return no('An effective date is needed, as yyyy-mm-dd');
    }
    const person = ACTIVE().find((e) => e.id === empId);
    if (!person) return no('No such employee');

    const active = COMPONENTS.filter((c) => c.active);
    if (COMPONENTS.length > 0 && active.length === 0) {
      return no('Every salary component is inactive — there is no formula to apply');
    }
    let gross = ctc;
    if (active.length) {
      if (!active.some((c) => c.kind === 'earning')) {
        return no('There is no earning component — a salary cannot be made of deductions');
      }
      const r = applyComponents(COMPONENTS, ctc);
      if (!r.balances) {
        const over = r.difference > 0;
        return no(`The components come to ${fmt(r.counted)} against a CTC of ${fmt(ctc)} — `
          + `${fmt(Math.abs(r.difference))} ${over ? 'more' : 'short'}. `
          + 'Adjust a component so they reconcile; nothing is rounded to make them fit.');
      }
      gross = r.lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.annual, 0);
    }

    const mine = STRUCTURES.filter((s) => s.empId === empId);
    if (mine.some((s) => s.validFrom === draft.validFrom)) {
      return no(`There is already a compensation effective ${draft.validFrom}`);
    }
    const open = mine.find((s) => s.validTo === null);
    if (open) {
      if (open.validFrom >= draft.validFrom) {
        return no(`The compensation in force starts on ${open.validFrom}; `
          + 'a revision must begin after it');
      }
      open.validTo = dayBefore(draft.validFrom);
      open.current = false;
    }

    const row: StructureRow = {
      id: `ss-${empId}-${draft.validFrom}`,
      empId,
      validFrom: draft.validFrom,
      validTo: null,
      currency: draft.currency ?? 'INR',
      ctc,
      gross,
      reason: draft.reason?.trim() ?? '',
      current: true,
      createdAt: new Date().toISOString(),
      createdBy: 'Demo administrator',
    };
    STRUCTURES.push(row);
    return ok(row);
  },

  history(empId: string) {
    return ok(STRUCTURES.filter((s) => s.empId === empId)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom)));
  },
};
