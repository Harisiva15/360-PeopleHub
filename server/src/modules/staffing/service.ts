/**
 * Staffing — the consulting side of the business.
 *
 * Clients, the work they have signed for, the people placed on it, and the
 * money that comes back. Twelve tables, and the projections are in `mapper.ts`
 * so the decisions are visible here rather than buried in column lists.
 *
 * **Everything derivable is derived.** Vendor scorecards, bench days, invoice
 * ageing, the KPI block — all counted from the rows at read time rather than
 * kept in columns that drift. The one exception is `submission.margin_percent`,
 * which is stored because it is the margin that was agreed at submission and
 * recomputing it from today's rates would rewrite what was quoted.
 *
 * **This is commercial data.** Bill rates, client credit limits and vendor
 * markups are not things a consultant on the bench should be able to read, so
 * the whole module is admin-only rather than scoped per row. A staffing
 * coordinator role would be the right next refinement; until one exists,
 * refusing is better than half-guessing.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import {
  fromUnit, toClient, toConsultant, toInvoice, toPlacement, toRateCard,
  toRequirement, toSow, toSubmission, toVendor,
} from './mapper.ts';
import type {
  Client, Consultant, Invoice, Placement, RateCard, Sow, StaffingRequirement,
  Submission, Vendor,
} from './mapper.ts';

export class StaffingError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'StaffingError';
    this.code = code;
  }
}

/** The margin floor a submission is expected to clear, as a percentage. */
const MIN_MARGIN = 22;

/** Working days in a month, for bench cost and monthly revenue. */
const WORKING_DAYS = 21;

function assertStaffing(caller: Caller): void {
  if (caller.role !== 'admin') {
    throw new StaffingError(
      'staffing carries client rates and margins — admin only', 'forbidden');
  }
}

/* ---------------- clients, contracts and rates ---------------- */

export async function clients(caller: Caller): Promise<Client[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query('SELECT * FROM client ORDER BY name');
    const contacts = await db.query(
      `SELECT client_id, full_name, COALESCE(title, '') AS title,
              COALESCE(email::text, '') AS email, COALESCE(phone, '') AS phone, is_primary
         FROM client_contact ORDER BY is_primary DESC, full_name`);

    const byClient = new Map<string, ReturnType<typeof mapContact>[]>();
    for (const c of contacts.rows) {
      const list = byClient.get(c.client_id as string) ?? [];
      list.push(mapContact(c));
      byClient.set(c.client_id as string, list);
    }
    return rows.map((r) => toClient(r, byClient.get(r.id as string) ?? []));
  });
}

const mapContact = (c: Record<string, unknown>) => ({
  name: c.full_name as string,
  title: c.title as string,
  email: c.email as string,
  phone: c.phone as string,
  primary: Boolean(c.is_primary),
});

export async function sows(caller: Caller): Promise<Sow[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    /*
     * `filled` is counted from live placements rather than read from the
     * column: the column is a cache the placement flow maintains, and a SOW
     * showing three of five filled when four people are on it is the kind of
     * discrepancy nobody notices until an invoice is short.
     */
    const { rows } = await db.query(
      `SELECT s.*, COALESCE(p.n, 0) AS live_filled
         FROM sow s
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS n FROM placement p
            WHERE p.sow_id = s.id AND p.status IN ('starting', 'active', 'ending_soon')
         ) p ON true
        ORDER BY s.ends_on DESC`);
    return rows.map((r) => toSow({ ...r, filled: r.live_filled }));
  });
}

export async function rateCards(caller: Caller): Promise<RateCard[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM rate_card
        WHERE valid_to IS NULL OR valid_to >= CURRENT_DATE
        ORDER BY role, valid_from DESC`);
    return rows.map((r) => toRateCard({ ...r, min_margin: MIN_MARGIN }));
  });
}

/* ---------------- people ---------------- */

const CONSULTANT_ORDER = 'ORDER BY c.bench_since NULLS LAST, c.full_name';

export async function consultants(caller: Caller): Promise<Consultant[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT c.* FROM consultant c WHERE c.status <> 'exited' ${CONSULTANT_ORDER}`);
    return rows.map(toConsultant);
  });
}

export async function bench(caller: Caller): Promise<Consultant[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT c.* FROM consultant c WHERE c.status = 'bench' ${CONSULTANT_ORDER}`);
    return rows.map(toConsultant);
  });
}

/**
 * How long somebody has been on the bench, and what that has cost.
 *
 * Counted from `bench_since` rather than stored, because the answer changes
 * every day and a stored figure would be wrong by definition the moment it
 * was written.
 */
export async function benchStanding(
  caller: Caller,
  consultantId: string,
): Promise<{ days: number; cost: number }> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT bench_since, COALESCE(cost_per_day, 0) AS cost_per_day
         FROM consultant WHERE id = $1`, [consultantId]);
    if (!rows[0]) throw new StaffingError('no such consultant', 'not_found');

    const since = rows[0].bench_since as string | null;
    if (!since) return { days: 0, cost: 0 };

    const { rows: [d] } = await db.query(
      'SELECT (CURRENT_DATE - $1::date)::int AS days', [since]);
    const days = Math.max(0, Number(d!.days));
    /* Cost is working days, not calendar days — nobody pays bench on a Sunday. */
    const workingDays = Math.round((days / 7) * 5);
    return { days, cost: Math.round(workingDays * Number(rows[0].cost_per_day)) };
  });
}

/* ---------------- demand ---------------- */

export async function requirements(caller: Caller): Promise<StaffingRequirement[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT * FROM staffing_requirement ORDER BY received_on DESC, code');
    return rows.map(toRequirement);
  });
}

export async function openRequirements(caller: Caller): Promise<StaffingRequirement[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    /*
     * Open means the status says so *and* there is a position left. A
     * requirement whose filled count reached its positions but whose status
     * nobody closed is not something to keep submitting against.
     */
    const { rows } = await db.query(
      `SELECT * FROM staffing_requirement
        WHERE status = 'open' AND filled < positions
        ORDER BY close_by NULLS LAST, received_on`);
    return rows.map(toRequirement);
  });
}

/* ---------------- submissions and placements ---------------- */

const SUBMISSION_PROJECTION = `
  SELECT s.*, r.client_id
    FROM submission s
    JOIN staffing_requirement r ON r.id = s.requirement_id`;

export async function submissions(caller: Caller): Promise<Submission[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${SUBMISSION_PROJECTION} ORDER BY s.submitted_on DESC`);
    return rows.map(toSubmission);
  });
}

/** The pipeline, in order. A submission moves forward one stage at a time. */
const STAGES = [
  'submitted', 'client_review', 'interview_scheduled', 'interviewed',
  'offered', 'placed',
] as const;
const TERMINAL = ['rejected', 'withdrawn', 'fallout'] as const;

/**
 * Move a submission along.
 *
 * Forward one step, or out to a terminal stage from anywhere. Skipping is
 * refused: a submission that jumped from submitted to placed has lost the
 * interview it must have had, and the submission-to-interview ratio the whole
 * staffing business is measured on is computed from exactly those transitions.
 */
export async function moveSubmission(
  caller: Caller,
  id: string,
  stage: string,
): Promise<Submission> {
  assertStaffing(caller);

  const target = String(stage).toLowerCase().replace(/ /g, '_');
  const known = [...STAGES, ...TERMINAL] as readonly string[];
  if (!known.includes(target)) {
    throw new StaffingError(`unknown stage: ${stage}`, 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      'SELECT id, stage, requirement_id FROM submission WHERE id = $1 FOR UPDATE', [id]);
    const row = cur.rows[0];
    if (!row) throw new StaffingError('no such submission', 'not_found');

    const from = row.stage as string;
    if ((TERMINAL as readonly string[]).includes(from)) {
      throw new StaffingError(`that submission was already ${from.replace(/_/g, ' ')}`, 'already_decided');
    }

    if (!(TERMINAL as readonly string[]).includes(target)) {
      const at = STAGES.indexOf(from as typeof STAGES[number]);
      const to = STAGES.indexOf(target as typeof STAGES[number]);
      if (to <= at) {
        throw new StaffingError('a submission does not move backwards', 'invalid');
      }
      if (to > at + 1) {
        throw new StaffingError(
          `cannot skip from ${from.replace(/_/g, ' ')} to ${target.replace(/_/g, ' ')}`, 'invalid');
      }
    }

    await db.query('UPDATE submission SET stage = $2 WHERE id = $1', [id, target]);

    /*
     * Reaching 'placed' fills a position on the requirement. Done here so the
     * count and the stage cannot disagree, and guarded by the table's own
     * CHECK (filled <= positions) rather than trusted to arithmetic.
     */
    if (target === 'placed') {
      const r = await db.query(
        `UPDATE staffing_requirement
            SET filled = filled + 1,
                status = CASE WHEN filled + 1 >= positions THEN 'filled' ELSE status END
          WHERE id = $1 AND filled < positions
          RETURNING id`, [row.requirement_id]);
      if (!r.rowCount) {
        throw new StaffingError(
          'every position on that requirement is already filled', 'conflict');
      }
    }

    const back = await db.query(`${SUBMISSION_PROJECTION} WHERE s.id = $1`, [id]);
    return toSubmission(back.rows[0]!);
  });
}

export async function placements(caller: Caller): Promise<Placement[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    /*
     * Timesheet compliance is the share of weeks in the placement that have an
     * approved client timesheet. It is what tells you an invoice is going to
     * be short before it goes out, so it is counted rather than assumed.
     */
    const { rows } = await db.query(
      `SELECT p.*,
              COALESCE(ts.approved, 0) AS approved_weeks,
              COALESCE(ts.total, 0) AS total_weeks,
              COALESCE(i.po, '') AS po_number
         FROM placement p
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE t.approved_by_client)::int AS approved,
                  count(*)::int AS total
             FROM placement_timesheet t WHERE t.placement_id = p.id
         ) ts ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(s.purchase_order, '') AS po FROM sow s WHERE s.id = p.sow_id
         ) i ON true
        ORDER BY p.starts_on DESC`);

    return rows.map((r) => toPlacement(
      r,
      Number(r.total_weeks) ? Math.round((Number(r.approved_weeks) / Number(r.total_weeks)) * 100) : 0,
      r.po_number as string,
    ));
  });
}

/* ---------------- vendors ---------------- */

export async function vendors(caller: Caller): Promise<Vendor[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    /*
     * The scorecard is counted from submissions, never stored. A vendor's
     * numbers are the thing renewal conversations turn on, and a cached
     * counter that drifted would be arguing from the wrong figures.
     */
    const { rows } = await db.query(
      `SELECT v.*,
              COALESCE(m.subs, 0) AS subs,
              COALESCE(m.interviews, 0) AS interviews,
              COALESCE(m.placements, 0) AS placements,
              COALESCE(m.fallouts, 0) AS fallouts,
              COALESCE(m.avg_days, 0) AS avg_submit_days
         FROM vendor v
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS subs,
                  count(*) FILTER (WHERE s.interview_on IS NOT NULL)::int AS interviews,
                  count(*) FILTER (WHERE s.stage = 'placed')::int AS placements,
                  count(*) FILTER (WHERE s.stage = 'fallout')::int AS fallouts,
                  round(avg(s.submitted_on - r.received_on))::int AS avg_days
             FROM submission s
             JOIN staffing_requirement r ON r.id = s.requirement_id
            WHERE s.vendor_id = v.id
         ) m ON true
        ORDER BY v.name`);
    return rows.map(toVendor);
  });
}

/* ---------------- money ---------------- */

export async function invoices(caller: Caller): Promise<Invoice[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT i.*,
              CASE WHEN i.paid_on IS NULL AND i.due_on IS NOT NULL
                        AND i.due_on < CURRENT_DATE
                   THEN (CURRENT_DATE - i.due_on)::int ELSE 0 END AS overdue_days
         FROM invoice i ORDER BY i.issued_on DESC NULLS LAST, i.number DESC`);

    const lines = await db.query(
      `SELECT invoice_id, description, units, unit_rate, amount
         FROM invoice_line ORDER BY description`);
    const byInvoice = new Map<string, { description: string; units: number; rate: number; amount: number }[]>();
    for (const l of lines.rows) {
      const list = byInvoice.get(l.invoice_id as string) ?? [];
      list.push({
        description: (l.description as string) ?? '',
        units: Number(l.units ?? 0),
        rate: Number(l.unit_rate ?? 0),
        amount: Number(l.amount ?? 0),
      });
      byInvoice.set(l.invoice_id as string, list);
    }

    return rows.map((r) => toInvoice(
      r, byInvoice.get(r.id as string) ?? [], Number(r.overdue_days)));
  });
}

/* ---------------- the headline ---------------- */

export interface StaffingKPI {
  placements: number;
  revenueMonthly: number;
  costMonthly: number;
  grossMargin: number;
  bench: number;
  benchCostMonthly: number;
  avgBenchDays: number;
  openReqs: number;
  openPositions: number;
  submissions: number;
  sub2int: number;
  int2place: number;
  fillRate: number;
  utilisation: number;
  ar: number;
  arOverdue: number;
  dso: number;
}

/**
 * The staffing headline, in one statement.
 *
 * Every figure is counted from rows. Rates are monthly-ised at 21 working
 * days, which is the convention the rest of this system uses for a day rate,
 * and hourly placements are multiplied to a day first so the two units add up.
 */
export async function kpi(caller: Caller): Promise<StaffingKPI> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `WITH live AS (
         SELECT p.*, CASE WHEN p.unit = 'per_hour' THEN 8 ELSE 1 END AS to_day
           FROM placement p WHERE p.status IN ('starting', 'active', 'ending_soon')
       ), money AS (
         SELECT count(*)::int AS n,
                COALESCE(sum(bill_rate * to_day), 0) * $1 AS revenue,
                COALESCE(sum(pay_rate * to_day), 0) * $1 AS cost
           FROM live
       ), benched AS (
         SELECT count(*)::int AS n,
                COALESCE(sum(COALESCE(cost_per_day, 0)), 0) * $1 AS cost,
                COALESCE(round(avg(CURRENT_DATE - bench_since)), 0)::int AS avg_days
           FROM consultant WHERE status = 'bench'
       ), demand AS (
         SELECT count(*)::int AS reqs,
                COALESCE(sum(positions - filled), 0)::int AS positions
           FROM staffing_requirement WHERE status = 'open' AND filled < positions
       ), pipeline AS (
         SELECT count(*)::int AS subs,
                count(*) FILTER (WHERE interview_on IS NOT NULL)::int AS interviewed,
                count(*) FILTER (WHERE stage = 'placed')::int AS placed
           FROM submission
       ), closed AS (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'filled')::int AS filled
           FROM staffing_requirement WHERE status IN ('filled', 'closed', 'lost')
       ), heads AS (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status IN ('placed', 'assigned'))::int AS working
           FROM consultant WHERE status <> 'exited'
       ), ar AS (
         SELECT COALESCE(sum(total) FILTER (WHERE paid_on IS NULL), 0) AS outstanding,
                COALESCE(sum(total) FILTER (
                  WHERE paid_on IS NULL AND due_on IS NOT NULL AND due_on < CURRENT_DATE
                ), 0) AS overdue,
                COALESCE(round(avg(paid_on - issued_on) FILTER (WHERE paid_on IS NOT NULL)), 0)::int AS dso
           FROM invoice
       )
       SELECT money.n AS placements, money.revenue, money.cost,
              benched.n AS bench, benched.cost AS bench_cost, benched.avg_days,
              demand.reqs, demand.positions,
              pipeline.subs, pipeline.interviewed, pipeline.placed,
              closed.total AS closed_total, closed.filled AS closed_filled,
              heads.total AS heads_total, heads.working,
              ar.outstanding, ar.overdue, ar.dso
         FROM money, benched, demand, pipeline, closed, heads, ar`, [WORKING_DAYS]);

    const r = rows[0]!;
    const revenue = Number(r.revenue);
    const cost = Number(r.cost);
    const subs = Number(r.subs);
    const closedTotal = Number(r.closed_total);
    const headsTotal = Number(r.heads_total);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

    return {
      placements: Number(r.placements),
      revenueMonthly: Math.round(revenue),
      costMonthly: Math.round(cost),
      grossMargin: pct(revenue - cost, revenue),
      bench: Number(r.bench),
      benchCostMonthly: Math.round(Number(r.bench_cost)),
      avgBenchDays: Number(r.avg_days),
      openReqs: Number(r.reqs),
      openPositions: Number(r.positions),
      submissions: subs,
      sub2int: pct(Number(r.interviewed), subs),
      int2place: pct(Number(r.placed), Number(r.interviewed)),
      fillRate: pct(Number(r.closed_filled), closedTotal),
      utilisation: pct(Number(r.working), headsTotal),
      ar: Math.round(Number(r.outstanding)),
      arOverdue: Math.round(Number(r.overdue)),
      dso: Number(r.dso),
    };
  });
}

/* ---------------- matching ---------------- */

export interface MatchRow {
  requirementId: string;
  consultantId: string;
  score: number;
  /** Why it scored what it did, in the order the reasons were applied. */
  reasons: string[];
  /** Margin at the requirement's bill rate and this consultant's cost. */
  margin: number;
}

/**
 * Score one consultant against one requirement.
 *
 * Deliberately explainable rather than clever: a recruiter has to be able to
 * say why somebody was put forward, and a score nobody can account for is one
 * that gets ignored. Skills dominate because they are what the client screens
 * on; everything else adjusts around them.
 */
function score(
  req: Record<string, unknown>,
  con: Record<string, unknown>,
): { score: number; reasons: string[]; margin: number } {
  const reasons: string[] = [];
  const wanted = ((req.skills as string[] | null) ?? []).map((s) => s.toLowerCase());
  const has = ((con.skills as string[] | null) ?? []).map((s) => s.toLowerCase());

  const hits = wanted.filter((s) => has.includes(s));
  const skillPct = wanted.length ? hits.length / wanted.length : 0;
  let total = skillPct * 60;
  reasons.push(wanted.length
    ? `${hits.length} of ${wanted.length} skills`
    : 'no skills specified on the requirement');

  /* Same role title is worth something, but less than the skills behind it. */
  if (String(con.role ?? '').toLowerCase() === String(req.role ?? '').toLowerCase()) {
    total += 10;
    reasons.push('same role');
  }

  /* Availability. Somebody on the bench can start; somebody placed cannot. */
  if (con.status === 'bench') {
    total += 15;
    reasons.push('on the bench');
  } else if (con.status === 'internal') {
    total += 5;
    reasons.push('internal, would need releasing');
  } else {
    reasons.push('currently engaged');
  }

  /* Location. A country match matters for work authorisation and timezone. */
  if (con.country && req.location
      && String(req.location).toLowerCase().includes(String(con.country).toLowerCase())) {
    total += 5;
    reasons.push('same country');
  }

  /* Margin at the asking rate. Below the floor it is not a match worth making. */
  const bill = Number(req.bill_rate ?? 0) * (req.unit === 'per_hour' ? 8 : 1);
  const cost = Number(con.cost_per_day ?? 0);
  const margin = bill > 0 ? Math.round(((bill - cost) / bill) * 100) : 0;
  if (margin >= MIN_MARGIN) {
    total += 10;
    reasons.push(`${margin}% margin`);
  } else {
    total -= 15;
    reasons.push(`${margin}% margin, under the ${MIN_MARGIN}% floor`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(total))), reasons, margin };
}

/**
 * Both sides of the cross, each with its own parameters.
 *
 * They were sharing one array, which meant the side that did not reference
 * $1 was still handed it — "bind message supplies 1 parameters, but prepared
 * statement requires 0" — and every match query was a 500. A filter and its
 * parameters travel together.
 */
interface Side { where: string; params: unknown[] }

async function matchRows(db: TenantClient, req: Side, con: Side): Promise<MatchRow[]> {
  const reqs = await db.query(
    `SELECT id, role, skills, location, bill_rate, unit FROM staffing_requirement
      WHERE ${req.where}`, req.params);
  const cons = await db.query(
    `SELECT id, role, skills, country, cost_per_day, status FROM consultant
      WHERE ${con.where}`, con.params);

  const out: MatchRow[] = [];
  for (const r of reqs.rows) {
    for (const c of cons.rows) {
      const s = score(r, c);
      /* Below 40 is noise — it puts a name in front of somebody for no reason. */
      if (s.score < 40) continue;
      out.push({
        requirementId: r.id as string,
        consultantId: c.id as string,
        score: s.score,
        reasons: s.reasons,
        margin: s.margin,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function matchesForConsultant(
  caller: Caller,
  consultantId: string,
): Promise<MatchRow[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, (db) => matchRows(
    db,
    { where: "status = 'open' AND filled < positions", params: [] },
    { where: 'id = $1', params: [consultantId] },
  ));
}

export async function matchesForRequirement(
  caller: Caller,
  requirementId: string,
): Promise<MatchRow[]> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, (db) => matchRows(
    db,
    { where: 'id = $1', params: [requirementId] },
    { where: "status <> 'exited'", params: [] },
  ));
}

export interface RedeploymentPlan {
  /** Bench people with at least one match worth making. */
  placeable: { consultantId: string; best: MatchRow }[];
  /** Bench people with none, and what it is costing to hold them. */
  stuck: { consultantId: string; days: number; cost: number }[];
  benchCostMonthly: number;
}

/**
 * Who on the bench can be moved, and who cannot.
 *
 * The useful half is `stuck`: a consultant with no match at all is a decision
 * somebody has to make — retrain, redeploy internally, or release — and the
 * cost of not making it is the number beside them.
 */
export async function redeploymentPlan(caller: Caller): Promise<RedeploymentPlan> {
  assertStaffing(caller);
  return withTenantReadOnly(caller, async (db) => {
    const all = await matchRows(
      db,
      { where: "status = 'open' AND filled < positions", params: [] },
      { where: "status = 'bench'", params: [] },
    );

    const best = new Map<string, MatchRow>();
    for (const m of all) {
      if (!best.has(m.consultantId)) best.set(m.consultantId, m);
    }

    const { rows } = await db.query(
      `SELECT id, COALESCE(cost_per_day, 0) AS cost_per_day,
              COALESCE((CURRENT_DATE - bench_since)::int, 0) AS days
         FROM consultant WHERE status = 'bench'`);

    const placeable: RedeploymentPlan['placeable'] = [];
    const stuck: RedeploymentPlan['stuck'] = [];
    let benchCost = 0;

    for (const c of rows) {
      const id = c.id as string;
      benchCost += Number(c.cost_per_day) * WORKING_DAYS;
      const match = best.get(id);
      if (match) { placeable.push({ consultantId: id, best: match }); continue; }
      const days = Number(c.days);
      stuck.push({
        consultantId: id,
        days,
        cost: Math.round(Math.round((days / 7) * 5) * Number(c.cost_per_day)),
      });
    }

    stuck.sort((a, b) => b.days - a.days);
    return { placeable, stuck, benchCostMonthly: Math.round(benchCost) };
  });
}

export { fromUnit };
