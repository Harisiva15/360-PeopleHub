/**
 * The recruitment overview — the band that sits above everything else.
 *
 * Hiring is one pipeline read at several zoom levels, so the shape of it stays
 * on screen while you work in a tab underneath. The alternative, a Pipeline tab
 * beside a Candidates tab, makes you leave the picture to look at the detail
 * and then leave the detail to check the picture.
 *
 * **The counts are one pass over one list.** Stage counts, the requisition
 * panel and the headline figures are all the same candidates counted
 * differently — computed together so two numbers on one screen cannot disagree.
 *
 * **Movement is measured, not assumed.** The reference shows "↑ 20%" against
 * every figure. Only some of those are knowable here: applications carry a
 * date, so this month against last is real arithmetic. Hires and offers are
 * countable the same way. Anything without a dated history gets no trend
 * rather than a decorative arrow.
 */

import { useMemo } from 'react';
import type { Candidate, Requisition } from '../../services';
import { sortBy } from '../../lib/collections';
import { addDays, daysBetween, fmtDS, monthKey, TODAY, ymd } from '../../lib/dates';
import { STAGES } from '../../data/ats';
import { deptOf, siteOf } from '../../data/org';
import { Avatar, Badge, Card, EmptyState, StatRow, Tile } from '../../components/ui';
import { ListRow } from '../../components/common';

/** The columns the overview shows, in pipeline order. `rejected` is not one. */
const FLOW = STAGES.filter((s) => s.id !== 'rejected');

/** Stages a candidate can sit in while still being worked on. */
const OPEN_STAGES = new Set(['applied', 'screen', 'tech', 'manager', 'hr', 'offer']);

export interface Trend { pct: number; up: boolean }

/**
 * Month-on-month movement for a dated set.
 *
 * Returns null rather than zero when last month had none: "up 100%" from a
 * base of nothing says less than saying nothing, and an arrow implies a
 * comparison that was not really made.
 */
export function trendOf(dates: string[], today = ymd(TODAY)): Trend | null {
  const thisM = monthKey(today);
  const lastM = monthKey(ymd(addDays(`${thisM}-01`, -1)));

  const now = dates.filter((d) => monthKey(d) === thisM).length;
  const before = dates.filter((d) => monthKey(d) === lastM).length;
  if (!before) return null;

  const pct = Math.round(((now - before) / before) * 100);
  return { pct: Math.abs(pct), up: pct >= 0 };
}

const arrow = (t: Trend | null, suffix: string) =>
  (t ? `${t.up ? '▲' : '▼'} ${t.pct}% ${suffix}` : suffix);

/**
 * Days from application to offer, over candidates who actually got one.
 *
 * Averaged only across those with both dates. A mean that treats a missing
 * date as zero reports a hiring process faster than any that has ever run.
 */
export function timeToHire(cands: Candidate[]): number | null {
  const spans = cands
    .filter((c) => c.stage === 'hired' && c.offer?.sentOn)
    .map((c) => daysBetween(c.appliedOn, c.offer!.sentOn!))
    .filter((n) => n >= 0);
  if (!spans.length) return null;
  return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
}

export function HiringOverview({
  cands, reqs, onCandidate, onStage, stage,
}: {
  cands: Candidate[];
  reqs: Requisition[];
  onCandidate: (id: string) => void;
  /** Clicking a column filters the tab below — the picture drives the detail. */
  onStage: (stage: string) => void;
  stage: string;
}) {
  const byStage = useMemo(() => {
    const m = new Map<string, Candidate[]>();
    cands.forEach((c) => {
      const list = m.get(c.stage) ?? [];
      list.push(c);
      m.set(c.stage, list);
    });
    m.forEach((list, k) => m.set(k, sortBy(list, (c) => c.appliedOn, 'desc')));
    return m;
  }, [cands]);

  const open = reqs.filter((r) => r.status === 'Open');
  const inProgress = cands.filter((c) => OPEN_STAGES.has(c.stage)).length;
  const offers = cands.filter((c) => c.offer && c.offer.status !== 'Draft');
  const hired = cands.filter((c) => c.stage === 'hired');
  const tth = timeToHire(cands);

  const applied = trendOf(cands.map((c) => c.appliedOn));
  const offerTrend = trendOf(offers.map((c) => c.offer!.sentOn!).filter(Boolean));
  const hireTrend = trendOf(hired.map((c) => c.offer?.sentOn ?? c.appliedOn));

  return (
    <div className="stack">
      <StatRow cols={5}>
        <Tile icon="💼" label="Open jobs" value={open.length}
          foot={`${open.reduce((n, r) => n + Math.max(0, r.openings - r.filled), 0)} positions to fill`} />
        <Tile icon="👥" label="Total candidates" value={cands.length}
          foot={arrow(applied, 'applied this month')} trend={applied?.up ? 'up' : 'down'} />
        <Tile icon="🔄" label="In progress" value={inProgress}
          foot="Still being worked on" />
        <Tile icon="🤝" label="Offers released" value={offers.length}
          foot={arrow(offerTrend, 'sent this month')} trend={offerTrend?.up ? 'up' : 'down'} />
        <Tile icon="✅" label="Hired" value={hired.length}
          foot={tth === null
            ? arrow(hireTrend, 'this cycle')
            : `${tth} days from apply to offer`} />
      </StatRow>

      <Card
        title="Hiring pipeline"
        sub={`${inProgress} in play across ${FLOW.length} stages`}
        actions={stage
          ? <button className="btn sm" onClick={() => onStage('')}>Clear filter</button>
          : <span className="muted" style={{ fontSize: 12 }}>Click a column to filter below</span>}
        flush>
        <div className="pipe">
          {FLOW.map((s) => {
            const list = byStage.get(s.id) ?? [];
            const on = stage === s.id;
            return (
              <div key={s.id} className={'pipe-col' + (on ? ' on' : '')}
                style={{ ['--stage' as string]: s.color }}>
                <button className="pipe-h" onClick={() => onStage(on ? '' : s.id)}
                  aria-pressed={on}>
                  <span className="pipe-n">{s.name}</span>
                  <span className="pipe-c">{list.length}</span>
                </button>

                {list.slice(0, 3).map((c) => (
                  <button key={c.id} className="pipe-card" onClick={() => onCandidate(c.id)}>
                    <Avatar name={c.name} size="sm" />
                    <span className="pipe-t">
                      <span className="pipe-name">{c.name}</span>
                      <span className="pipe-sub">{c.current || c.loc || '—'}</span>
                      <span className="pipe-when">{fmtDS(c.appliedOn)}</span>
                    </span>
                  </button>
                ))}

                {list.length > 3 && (
                  <button className="pipe-more" onClick={() => onStage(s.id)}>
                    + {list.length - 3} more
                  </button>
                )}
                {!list.length && <div className="pipe-empty">Nobody here</div>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Open requisitions" sub={`${open.length} live`} flush>
        {open.length ? sortBy(open, (r) => -(r.openings - r.filled)).slice(0, 8).map((r) => {
          const n = cands.filter((c) => c.reqId === r.id).length;
          return (
            <ListRow key={r.id}>
              <i className="pipe-dot" style={{
                background: r.priority === 'Critical' ? 'var(--crit)'
                  : r.priority === 'High' ? 'var(--warn-text, var(--t-amber-ink))' : 'var(--good)',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{r.title}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {r.id} · {siteOf(r.site).city} · {deptOf(r.dept).name} ·{' '}
                  {r.openings - r.filled} of {r.openings} to fill
                </div>
              </div>
              <Badge kind={n ? 'info' : 'warn'}>{n} candidate{n === 1 ? '' : 's'}</Badge>
            </ListRow>
          );
        }) : <EmptyState msg="No open requisitions" icon="💼" />}
      </Card>
    </div>
  );
}
