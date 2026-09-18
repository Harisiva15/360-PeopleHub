/**
 * The pieces every recruitment screen draws the same way.
 *
 * An SLA that reads green on one page and amber on another is worse than no
 * SLA, so the indicator, the priority chip and the money are one component
 * each rather than one per screen.
 */

import { fmtD } from '../../lib/dates';
import { money } from '../../data/countries';
import { Badge } from '../../components/ui';
import type { BadgeKind } from '../../components/ui';
import type { JobPriority, SlaStanding, StaffingRequirement } from '../../services';

/* ---------------- SLA ---------------- */

const SLA_TONE: Record<SlaStanding['state'], BadgeKind> = {
  'On Track': 'good',
  Approaching: 'warn',
  Overdue: 'crit',
  Closed: 'mute',
};

/**
 * Where an order stands, in one badge.
 *
 * An overdue order says which stage is behind rather than only that it is
 * late: "behind on submission" is something a recruiter can act on this
 * afternoon, and "overdue" on its own is not. Colour never carries the meaning
 * alone — the state is always written out.
 */
export function SlaBadge({ sla, detail }: { sla: SlaStanding; detail?: boolean }) {
  const behind = sla.behind
    ? ` · behind on ${sla.behind}`
    : sla.state === 'Approaching' ? ` · ${sla.daysRemaining}d left` : '';
  return (
    <Badge kind={SLA_TONE[sla.state]}>
      {sla.state}{detail ? behind : ''}
    </Badge>
  );
}

/** The aging figure a list column shows: days open, and how far past target. */
export function Aging({ sla }: { sla: SlaStanding }) {
  if (sla.state === 'Closed') return <span className="muted">—</span>;
  return (
    <span className="mono">
      {sla.daysOpen}d
      {sla.aging > 0 && <span className="sla-over"> +{sla.aging}</span>}
    </span>
  );
}

/* ---------------- priority ---------------- */

const PRIORITY_TONE: Record<JobPriority, BadgeKind> = {
  Critical: 'crit', High: 'warn', Medium: 'info', Low: 'mute',
};

export const PriorityBadge = ({ p }: { p: JobPriority }) => (
  <Badge kind={PRIORITY_TONE[p]}>{p}</Badge>
);

/* ---------------- money ---------------- */

/**
 * What an order is worth, said the way it was sold: a contract is a rate pair,
 * a permanent role is a band. Showing a blank rate on a permanent order — or a
 * blank band on a contract — is the usual way this reads as broken.
 */
export function Commercials({ r }: { r: StaffingRequirement }) {
  if (r.payRate !== null) {
    return (
      <span className="mono nowrap">
        {money(r.billRate, r.ccy)} / {money(r.payRate, r.ccy)}
        {r.markupPct !== null && <span className="muted"> · {r.markupPct}%</span>}
      </span>
    );
  }
  if (r.salaryMin !== null && r.salaryMax !== null) {
    return (
      <span className="mono nowrap">
        {money(r.salaryMin, r.ccy)}–{money(r.salaryMax, r.ccy)}
      </span>
    );
  }
  return <span className="muted">—</span>;
}

/** The unit a rate is quoted in, for a column header or a field hint. */
export const rateUnit = (r: StaffingRequirement) =>
  r.unit === 'per day' ? 'per day' : 'per hour';

/* ---------------- identity ---------------- */

/**
 * A job order's number.
 *
 * The desk says "JO-2026-00125", not a uuid — an order number is read aloud on
 * a call with a client, so it is derived from the id rather than being a
 * second thing to keep in step.
 */
export const jobNo = (r: { id: string; openedOn: string }) =>
  `JO-${r.openedOn.slice(0, 4)}-${r.id.replace(/\D/g, '').padStart(5, '0')}`;

/** The order's one-line identity: what it is and who it is for. */
export function JobTitle({ r, client }: { r: StaffingRequirement; client: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="jo-t">{r.title}</div>
      <div className="muted" style={{ fontSize: 11.5 }}>
        {client} · {r.location} · {fmtD(r.openedOn)}
      </div>
    </div>
  );
}
