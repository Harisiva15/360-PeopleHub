-- ---------------------------------------------------------------------------
-- 0048 — compensation history cannot overlap itself, and components exist
--
-- `salary_structure` has been read since 0004 and written by nothing, so every
-- caller silently fell through to `employee.ctc` and the whole table was
-- theory. `salary_component` was read by nobody at all.
--
-- This migration does not add the write path — that is service code, and it
-- needs no schema change. It adds the two things the schema was missing for
-- that code to be safe, and nothing else.
--
-- **Overlap becomes impossible rather than checked.** `salary_structure_one_current`
-- (0004) already permits one open-ended row per employee, which stops two
-- *current* structures. It says nothing about two closed ones covering the same
-- months — 1 Jan to 30 Jun and 1 Mar to 31 Dec both satisfy it, and a payslip
-- for April would then have two answers with no rule saying which. The service
-- refuses an overlap before writing; this is what makes the refusal true rather
-- than merely likely, including for anything that writes the table later.
--
-- `daterange(valid_from, valid_to)` is half-open, so a structure ending on the
-- 30th and the next beginning on the 1st do not touch — which is the boundary
-- the service supersedes on. A NULL `valid_to` is an unbounded range, so two
-- open structures overlap by definition and this subsumes the older index; both
-- are kept, because the older one gives a clearer error for the common case.
--
-- **Components are seeded, because an empty screen teaches nothing.** The six
-- below are the rules `structureFor` in payroll/rules.ts has always applied,
-- restated as data a company can edit. They reconcile to exactly 100% of CTC:
--
--   Basic 40 + HRA 20 + LTA 3.2 + Special 30.076 + PF 4.8 + Gratuity 1.924
--
-- One difference from the derived rules, and it is deliberate: the hard-coded
-- version adds a flat ₹12,000 medical premium. A flat amount cannot reconcile
-- to a percentage of every CTC, so it is left out rather than seeded and
-- immediately failing its own validation. A company that pays one should add it
-- and reduce Special Allowance to match — which is the point of the table.
--
-- Seeding does not change any existing behaviour. Components apply only to an
-- employee who has a stored structure, and there are none.
-- ---------------------------------------------------------------------------

/*
 * btree_gist lets an exclusion constraint mix plain equality (tenant, employee)
 * with range overlap. Standard contrib, available on this instance.
 */
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE salary_structure DROP CONSTRAINT IF EXISTS salary_structure_no_overlap;
ALTER TABLE salary_structure
  ADD CONSTRAINT salary_structure_no_overlap
  EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(valid_from, valid_to) WITH &&
  );

COMMENT ON CONSTRAINT salary_structure_no_overlap ON salary_structure IS
  'One structure covers any given day for a given employee. Half-open ranges, '
  'so 31 Mar -> 1 Apr does not overlap. See 0048.';

/*
 * The company's default structure, as data.
 *
 * `percent_of_code` names the component a percentage is taken of; NULL means
 * percent of CTC. So Basic is 40% of CTC and HRA is 50% of Basic, which is how
 * the rule is actually written down in an offer letter.
 *
 * ON CONFLICT on (tenant_id, code) so a re-run changes nothing and a company
 * that has already edited these keeps its edits. Scoped by a tenant that has a
 * Bangalore site, the same way 0045 identifies "operates in India" without
 * naming a customer.
 */
INSERT INTO salary_component
  (tenant_id, code, name, kind, percent_of_code, percent, flat_amount, taxable, display_order, active)
SELECT t.tenant_id, v.code, v.name, v.kind, v.base, v.pct, NULL, v.taxable, v.ord, true
  FROM (SELECT DISTINCT tenant_id FROM site WHERE code = 'BLR') t
 CROSS JOIN (VALUES
   ('BASIC',    'Basic Salary',                'earning',               NULL,    40.000, true,  1),
   ('HRA',      'House Rent Allowance',        'earning',               'BASIC', 50.000, true,  2),
   ('LTA',      'Leave Travel Allowance',      'earning',               'BASIC',  8.000, true,  3),
   ('SPECIAL',  'Special Allowance',           'earning',               NULL,    30.076, true,  4),
   ('PF_ER',    'Employer PF Contribution',    'employer_contribution', 'BASIC', 12.000, false, 5),
   ('GRATUITY', 'Gratuity Accrual',            'employer_contribution', 'BASIC',  4.810, false, 6)
 ) AS v(code, name, kind, base, pct, taxable, ord)
ON CONFLICT (tenant_id, code) DO NOTHING;
