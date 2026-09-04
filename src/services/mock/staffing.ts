/**
 * The staffing book, including the match engine.
 *
 * Matching lives behind the service deliberately: it reads consultant cost
 * bases and client bill rates to score a pairing, and that is not data every
 * caller should be holding. The scoring itself is deterministic arithmetic
 * (see `data/matching`), so it ports to a server unchanged.
 */

import { sortBy, sum } from '../../lib/collections';
import { toBase } from '../../data/countries';
import {
  benchCost, benchDays, benchList, CLIENTS, CONSULTANTS, INVOICES, PLACEMENTS,
  RATE_CARDS, REQUIREMENTS, reqOf2, SOWS, SUBMISSIONS, staffingKPI, VENDORS,
} from '../../data/staffing';
import type { Consultant, StaffingRequirement } from '../../data/staffing';
import { matchExplain, matchScore, MATCH_FLOOR, openReqs } from '../../data/matching';
import type { MatchRow, PlanRow, RedeploymentPlan, StaffingService } from '../contracts';
import { ok } from './util';

/** Monthly run-rate units: 21 billable days, or 173 hours. */
const monthlyUnits = (unit: 'per day' | 'per hour') => (unit === 'per day' ? 21 : 173);

/** Anyone not currently placed is available to be matched. */
const available = () => CONSULTANTS.filter((c) => c.status !== 'Placed');

export const staffingService: StaffingService = {
  clients() { return ok(CLIENTS.slice()); },
  requirements() { return ok(REQUIREMENTS.slice()); },
  openRequirements() { return ok(openReqs()); },
  consultants() { return ok(CONSULTANTS.slice()); },
  bench() { return ok(benchList()); },
  placements() { return ok(PLACEMENTS.slice()); },
  submissions() { return ok(SUBMISSIONS.slice()); },

  moveSubmission(id, stage) {
    const sub = SUBMISSIONS.find((x) => x.id === id);
    if (!sub) return Promise.reject(new Error('No such submission: ' + id));
    if (sub.stage === stage) return ok(sub);
    sub.stage = stage;
    return ok(sub);
  },
  invoices() { return ok(INVOICES.slice()); },
  vendors() { return ok(VENDORS.slice()); },
  sows() { return ok(SOWS.slice()); },
  rateCards() { return ok(RATE_CARDS.slice()); },
  kpi() { return ok(staffingKPI()); },

  matchesForConsultant(consultantId) {
    const c = CONSULTANTS.find((x) => x.id === consultantId);
    if (!c) return Promise.reject(new Error('No such consultant: ' + consultantId));
    const rows: MatchRow[] = openReqs().map((requirement) => ({
      consultant: c,
      requirement,
      explain: matchExplain(c, requirement),
    }));
    return ok(sortBy(rows, (r) => -r.explain.total));
  },

  matchesForRequirement(requirementId) {
    const r = reqOf2(requirementId);
    if (!r) return Promise.reject(new Error('No such requirement: ' + requirementId));
    const rows: MatchRow[] = available().map((consultant) => ({
      consultant,
      requirement: r,
      explain: matchExplain(consultant, r),
    }));
    return ok(sortBy(rows, (x) => -x.explain.total));
  },

  /**
   * Greedy assignment: best pairings first, one suggestion per consultant, and
   * never more than a requirement has open positions.
   */
  redeploymentPlan() {
    const pool = available();
    const reqs = openReqs();

    const pairs: { c: Consultant; r: StaffingRequirement; t: number }[] = [];
    pool.forEach((c) =>
      reqs.forEach((r) => {
        const t = matchScore(c, r);
        if (t >= MATCH_FLOOR) pairs.push({ c, r, t });
      }),
    );

    const usedC = new Set<string>();
    const cap: Record<string, number> = {};
    const picks: PlanRow[] = [];

    sortBy(pairs, (p) => -p.t).forEach((p) => {
      if (usedC.has(p.c.id)) return;
      const room = Math.max(0, p.r.positions - p.r.filled) - (cap[p.r.id] || 0);
      if (room <= 0) return;
      usedC.add(p.c.id);
      cap[p.r.id] = (cap[p.r.id] || 0) + 1;
      picks.push({
        consultant: p.c,
        requirement: p.r,
        score: p.t,
        margin: matchExplain(p.c, p.r).margin,
        benchDays: p.c.status === 'Bench' ? benchDays(p.c) : 0,
      });
    });

    const plan: RedeploymentPlan = {
      picks,
      recovered: sum(
        picks.filter((p) => p.consultant.status === 'Bench'),
        (p) => toBase(p.consultant.costPerDay * 21, p.consultant.ccy),
      ),
      revenue: sum(picks, (p) => toBase(p.requirement.billRate * monthlyUnits(p.requirement.unit), p.requirement.ccy)),
      benchTotal: benchList().length,
      availableCount: pool.length,
      openRequirementCount: reqs.length,
    };
    return ok(plan);
  },

  benchStanding(consultantId) {
    const c = CONSULTANTS.find((x) => x.id === consultantId);
    if (!c) return Promise.reject(new Error('No such consultant: ' + consultantId));
    return ok({ days: benchDays(c), cost: benchCost(c) });
  },
};
