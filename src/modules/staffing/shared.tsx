import { money } from '../../data/countries';
import { Badge } from '../../components/ui';
import type { BadgeKind } from '../../components/ui';

/** Client tiers and vendor tiers share one badge scale. */
const TIER_TONE: Record<string, BadgeKind> = {
  Platinum: 'info', Gold: 'warn', Silver: 'mute', Bronze: 'mute',
  Preferred: 'good', Approved: 'info', Trial: 'warn', Watchlist: 'crit',
};

export function TierBadge({ tier }: { tier: string }) {
  return <Badge kind={TIER_TONE[tier] || 'mute'}>{tier}</Badge>;
}

/** A bill or pay rate with its unit, e.g. "$118/hr". */
export function Rate({ v, ccy, unit }: { v: number; ccy: string; unit: 'per day' | 'per hour' }) {
  return (
    <>
      {money(v, ccy)}
      <span className="muted" style={{ fontSize: 11 }}>/{unit === 'per day' ? 'day' : 'hr'}</span>
    </>
  );
}

/** Monthly run-rate multiplier: 21 billable days or 173 hours. */
export const monthlyUnits = (unit: 'per day' | 'per hour') => (unit === 'per day' ? 21 : 173);
