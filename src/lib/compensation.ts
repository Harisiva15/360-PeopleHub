/**
 * Applying the company's salary components to one CTC.
 *
 * The server has its own copy in `server/src/modules/payroll/compensation.ts`,
 * because the two sides do not share a build. `checks/compensation.ts` runs
 * both over the same inputs and fails if they disagree — a screen that shows a
 * breakdown the server would refuse is worse than a screen that shows nothing.
 *
 * Kept pure and free of service imports so both a component and a check can
 * call it without a running API.
 */

import type { ComponentKind, Reconciliation, SalaryComponent } from '../services/contracts';

/** What counts towards cost to company. A deduction comes out of the earnings. */
const IN_CTC: ComponentKind[] = ['earning', 'employer_contribution'];

/**
 * Resolve every active component against `ctc`.
 *
 * Percentages of CTC resolve first, then percentages of those — one level,
 * which is all the validation permits. Each line is rounded to the rupee and
 * the residue is reported in `difference` rather than absorbed into a component
 * to make the total look right.
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

  const lines = [...active]
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
