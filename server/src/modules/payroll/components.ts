/**
 * Applying the company's salary components to one CTC.
 *
 * Deliberately free of imports. `compensation.ts` reaches the database and
 * `service.ts` reaches half the module, and neither can be loaded without a
 * connection — which would mean the one piece of arithmetic worth testing in
 * isolation could only be tested against a live database.
 *
 * The browser has its own copy in `src/lib/compensation.ts`, because the two
 * sides do not share a build and the compensation form shows a breakdown as the
 * number is typed rather than asking per keystroke. `checks/compensation.ts`
 * runs both over the same inputs and fails if they disagree by a rupee.
 */

export type ComponentKind = 'earning' | 'deduction' | 'employer_contribution' | 'reimbursement';

export const COMPONENT_KINDS: ComponentKind[] =
  ['earning', 'deduction', 'employer_contribution', 'reimbursement'];

/** What counts towards cost to company. A deduction comes out of the earnings. */
const IN_CTC: ComponentKind[] = ['earning', 'employer_contribution'];

export interface SalaryComponent {
  code: string;
  name: string;
  kind: ComponentKind;
  /** The component this percentage is taken of. Null means a percent of CTC. */
  percentOf: string | null;
  percent: number | null;
  flat: number | null;
  taxable: boolean;
  order: number;
  active: boolean;
}

export interface ComputedLine {
  code: string;
  name: string;
  kind: ComponentKind;
  /** How it was arrived at, for a screen that has to explain the number. */
  basis: string;
  annual: number;
  taxable: boolean;
}

export interface Reconciliation {
  ctc: number;
  lines: ComputedLine[];
  /** Earnings plus employer contributions — what must equal CTC. */
  counted: number;
  /** counted - ctc. Zero is the only value that saves. */
  difference: number;
  balances: boolean;
}

/**
 * Resolve every active component against `ctc`.
 *
 * Percentages of CTC resolve first, then percentages of those — one level,
 * which is all the validation permits. Each line is rounded to the rupee and
 * the residue is reported in `difference` rather than absorbed into a component
 * to make the total look right: a few rupees quietly moved into Special
 * Allowance is how a payslip comes to disagree with an offer letter.
 */
export function applyComponents(
  components: SalaryComponent[],
  ctc: number,
): Reconciliation {
  const active = components.filter((c) => c.active);
  const byCode = new Map(active.map((c) => [c.code, c]));
  const seen = new Map<string, number>();

  const resolve = (c: SalaryComponent): number => {
    const had = seen.get(c.code);
    if (had !== undefined) return had;
    let v: number;
    if (c.flat !== null) v = Math.round(c.flat);
    else if (c.percentOf === null) v = Math.round((ctc * (c.percent ?? 0)) / 100);
    else {
      const parent = byCode.get(c.percentOf);
      /* An inactive or missing base contributes nothing; validation names it. */
      v = Math.round(((parent ? resolve(parent) : 0) * (c.percent ?? 0)) / 100);
    }
    seen.set(c.code, v);
    return v;
  };

  const lines: ComputedLine[] = [...active]
    .sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
    .map((c) => ({
      code: c.code,
      name: c.name,
      kind: c.kind,
      basis: c.flat !== null
        ? 'fixed amount'
        : c.percentOf === null
          ? `${c.percent}% of CTC`
          : `${c.percent}% of ${c.percentOf}`,
      annual: resolve(c),
      taxable: c.taxable,
    }));

  const counted = lines
    .filter((l) => IN_CTC.includes(l.kind))
    .reduce((s, l) => s + l.annual, 0);

  return { ctc, lines, counted, difference: counted - ctc, balances: counted === ctc };
}
