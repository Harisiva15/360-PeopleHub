/**
 * What a timesheet screen shows when it has nothing to show yet.
 *
 * Three states, and they are genuinely different things. A screen that is
 * *loading* has not asked yet; a screen that is *empty* asked and the answer
 * was none; a screen that *failed* asked and never found out. Collapsing the
 * third into the second is the failure worth naming — a caught error turned
 * into an empty array reads as "you have no timesheets", which is a statement
 * about the data rather than about the network, and the person believes it.
 *
 * So `Loaded` takes the error and refuses to render the children while one is
 * standing. Retry calls the query's own `refetch`, which re-runs the request
 * that failed rather than reloading the page and losing everything else.
 */

import type { ReactNode } from 'react';
import { EmptyState } from '../../components/ui';
import { Icon } from '../../components/icons';

/* ---------------- skeletons ---------------- */

/** A shimmering block standing in for text that has not arrived. */
export function Bar({ w = '100%', h = 12 }: { w?: number | string; h?: number }) {
  return <span className="sk-bar" style={{ width: w, height: h }} />;
}

/** A table's worth of skeleton, sized to the columns it will hold. */
export function TableSkeleton({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <div className="sk-table" aria-hidden="true">
      <div className="sk-row sk-head">
        {Array.from({ length: cols }, (_, i) => <Bar key={i} w={i === 0 ? '55%' : '70%'} h={10} />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="sk-row" key={r}>
          {Array.from({ length: cols }, (_, i) => (
            <Bar key={i} w={i === 0 ? '80%' : `${45 + ((r * 7 + i * 11) % 40)}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Cards in a grid — projects, summary tiles. */
export function CardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="sk-cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <Bar w="45%" h={10} />
          <Bar w="70%" h={18} />
          <Bar w="60%" h={10} />
        </div>
      ))}
    </div>
  );
}

/** A grid of week or day tiles. */
export function CalendarSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="sk-cal" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-cal-cell" key={i}>
          <Bar w="60%" h={10} />
          <Bar w="40%" h={14} />
        </div>
      ))}
    </div>
  );
}

/* ---------------- the failure ---------------- */

/**
 * A request that did not come back, and the offer to ask again.
 *
 * The message the service gave is shown underneath rather than swallowed: "no
 * tenant context" and "this login has no employee record" are different
 * problems with different answers, and hiding both behind one sentence costs
 * the person the only clue they had.
 */
export function LoadError({ error, onRetry, what }: {
  error: Error;
  onRetry: () => void;
  /** What could not be loaded — "your timesheets", "the team's weeks". */
  what: string;
}) {
  return (
    <div className="ts-fail">
      <Icon n="warn" size="lg" />
      <div className="ts-fail-body">
        <b>Something went wrong</b>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
          We couldn&rsquo;t load {what}.
        </div>
        <div className="ts-fail-detail">{error.message}</div>
      </div>
      <button className="btn sm" onClick={onRetry}>Retry</button>
    </div>
  );
}

/* ---------------- the three states, in one place ---------------- */

export interface Loadable {
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Render the children only once there is something to render them from.
 *
 * `empty` decides whether the answer was "none" — the caller knows what empty
 * means for its own data, and a length check here would be wrong for a screen
 * whose emptiness depends on a filter.
 */
export function Loaded({
  q, what, skeleton, empty, emptyState, children,
}: {
  q: Loadable;
  what: string;
  skeleton: ReactNode;
  empty: boolean;
  emptyState: ReactNode;
  children: ReactNode;
}) {
  if (q.error) return <LoadError error={q.error} onRetry={q.refetch} what={what} />;
  if (q.loading) return <>{skeleton}</>;
  if (empty) return <>{emptyState}</>;
  return <>{children}</>;
}

/** An empty result, with the thing to do about it where there is one. */
export function Nothing({ msg, sub, action }: {
  msg: string;
  sub?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="ts-nothing">
      <EmptyState icon={<Icon n="note" size="lg" />} msg={msg} />
      {sub && <div className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>{sub}</div>}
      {action && (
        <button className="btn sm" onClick={action.onClick}>{action.label}</button>
      )}
    </div>
  );
}
