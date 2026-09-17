import { Children, cloneElement, isValidElement } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { avColor, initials } from '../lib/format';
import type { Employee } from '../types/employee';

/* ---------- Avatar & person ---------- */

export function Avatar({ name, size }: { name: string; size?: 'sm' | 'lg' | 'xl' }) {
  return (
    <div className={'av' + (size ? ' ' + size : '')} style={{ background: avColor(name) }}>
      {initials(name)}
    </div>
  );
}

/**
 * Name over a secondary line. Pass `sub={false}` for the name alone;
 * omitting `sub` falls back to the employee's designation.
 */
export function PersonCell({ e, sub }: { e: Employee; sub?: string | false }) {
  return (
    <div className="person">
      <Avatar name={e.name} size="sm" />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{e.name}</div>
        {sub !== false && <div className="mt">{sub || e.designation}</div>}
      </div>
    </div>
  );
}

/* ---------- Card ---------- */

export function Card({
  title,
  sub,
  actions,
  flush,
  children,
  className,
  style,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** Drop the body padding — for tables that should meet the card edge. */
  flush?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={'card' + (className ? ' ' + className : '')} style={style}>
      {(title || actions) && (
        <div className="card-h">
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && <h3>{title}</h3>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions}
        </div>
      )}
      <div className={'card-b' + (flush ? ' flush' : '')}>{children}</div>
    </div>
  );
}

/* ---------- Stat tile ---------- */

/** The five tinted variants. Plain stays the default, so nothing changes by accident. */
export type TileTone = 'blue' | 'green' | 'amber' | 'rose' | 'violet';

export function Tile({
  label,
  value,
  foot,
  trend,
  spark,
  tone,
  icon,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  /** Colours the footer figure green when rising, red when falling. */
  trend?: 'up' | 'down';
  spark?: ReactNode;
  /**
   * Tints the card. A tone carries no meaning on its own — it groups a row of
   * figures visually — so it never replaces a label or a status badge.
   */
  tone?: TileTone;
  icon?: ReactNode;
  /**
   * Anything that belongs under the footer — a progress bar, most often.
   *
   * Unlike `spark`, which floats in the corner, this takes the full width and
   * pushes the card taller. It exists because two screens were hand-writing
   * `div.tile` markup to get a bar in, which left those tiles outside the
   * component and so outside every improvement made to it.
   */
  children?: ReactNode;
}) {
  return (
    <div className={'tile' + (tone ? ' t-' + tone : '')}>
      {icon && <div className="tile-ic" aria-hidden="true">{icon}</div>}
      <div className="tile-t">
        <div className="val">{value}</div>
        <div className="lbl">{label}</div>
        {foot && <div className="foot">{trend ? <span className={trend}>{foot}</span> : foot}</div>}
        {children}
      </div>
      {spark && <div className="spark">{spark}</div>}
    </div>
  );
}

/**
 * The order tones are handed out in, taken from the dashboard's own rows.
 *
 * It is a rotation, not a scale: nothing is being ranked, so there is no
 * "worse" colour to land on. Read left to right it alternates cool and warm,
 * which keeps two adjacent cards from reading as a pair.
 */
const TONE_CYCLE: TileTone[] = ['blue', 'green', 'violet', 'amber', 'rose'];

/**
 * A row of stat tiles, tinted for you.
 *
 * Every screen opens with one of these rows, and for a long time only the
 * dashboard's were coloured — 16 tinted tiles against 387 plain ones, so the
 * dashboard looked like a different product from the pages it links to.
 * Tinting each call site by hand would have been 400 decisions that drift
 * apart the first time somebody adds a tile, so the row assigns the colours
 * and the page just says what the figures are.
 *
 * An explicit `tone` on a tile still wins — the rotation is a default, not a
 * policy. Position is counted over tiles actually rendered, so a conditional
 * tile that is absent does not leave a gap in the sequence.
 */
export function StatRow({
  cols = 4,
  children,
}: {
  /** Columns at desktop width; matches the `.grid.gN` classes. */
  cols?: 3 | 4 | 5;
  children: ReactNode;
}) {
  let next = 0;
  const tinted = Children.map(children, (child) => {
    if (!isValidElement(child) || child.type !== Tile) return child;
    const props = child.props as { tone?: TileTone };
    const tone = props.tone ?? TONE_CYCLE[next % TONE_CYCLE.length];
    next += 1;
    return cloneElement(child, { tone } as Partial<typeof props>);
  });
  return <div className={'grid g' + cols}>{tinted}</div>;
}

/* ---------- Pagination ---------- */

/**
 * Cut a list into pages.
 *
 * Tables here have been truncating instead — "showing the first 400, narrow
 * the filters" — which tells someone their data is there but refuses to show
 * it. A page number is the ordinary answer and it lets the count be honest.
 *
 * `page` is 1-based because it is shown to people. Returned clamped, so a
 * filter that shrinks the list while you are on page 9 lands you on the last
 * page that exists rather than on an empty one.
 */
export function pageOf<T>(rows: T[], page: number, size: number) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(Math.max(1, page), pages);
  const from = (at - 1) * size;
  return {
    rows: rows.slice(from, from + size),
    page: at,
    pages,
    total: rows.length,
    /* 1-based and inclusive, to read as "1 – 6 of 100". */
    first: rows.length ? from + 1 : 0,
    last: Math.min(from + size, rows.length),
  };
}

/**
 * The footer under a paged table: what you are looking at, and how to move.
 *
 * Page numbers are windowed around the current one. A hundred pages of
 * buttons is not navigation, and the first and last are always reachable
 * because "go to the end" is a real intention.
 */
export function Pager({
  page,
  pages,
  total,
  first,
  last,
  noun,
  onPage,
  size,
  onSize,
}: {
  page: number;
  pages: number;
  total: number;
  first: number;
  last: number;
  /** Plural, for the count — "employees", "assets". */
  noun: string;
  onPage: (p: number) => void;
  size?: number;
  onSize?: (n: number) => void;
}) {
  /* At most five numbers, centred on the current page where there is room. */
  const span = Math.min(5, pages);
  const start = Math.min(Math.max(1, page - 2), Math.max(1, pages - span + 1));
  const numbers = Array.from({ length: span }, (_, i) => start + i);

  return (
    <div className="pager">
      <span className="muted">
        {total ? `Showing ${first} – ${last} of ${total} ${noun}` : `No ${noun}`}
      </span>
      <div className="spacer" />

      {onSize && (
        <select className="input sm" style={{ width: 'auto' }} value={size}
          onChange={(e) => onSize(Number(e.target.value))} title="Rows per page">
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
      )}

      {pages > 1 && (
        <div className="pager-n">
          <button className="btn icon sm" disabled={page === 1}
            onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
          {numbers[0]! > 1 && (
            <button className="btn icon sm" onClick={() => onPage(1)}>1</button>
          )}
          {numbers[0]! > 2 && <span className="muted">…</span>}
          {numbers.map((n) => (
            <button key={n} className={'btn icon sm' + (n === page ? ' primary' : '')}
              aria-current={n === page ? 'page' : undefined}
              onClick={() => onPage(n)}>{n}</button>
          ))}
          {numbers[numbers.length - 1]! < pages - 1 && <span className="muted">…</span>}
          {numbers[numbers.length - 1]! < pages && (
            <button className="btn icon sm" onClick={() => onPage(pages)}>{pages}</button>
          )}
          <button className="btn icon sm" disabled={page === pages}
            onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
        </div>
      )}
    </div>
  );
}

/* ---------- Badge ---------- */

export type BadgeKind = 'good' | 'warn' | 'crit' | 'info' | 'mute';

export function Badge({ kind = 'mute', children }: { kind?: BadgeKind; children: ReactNode }) {
  return <span className={'badge b-' + kind}>{children}</span>;
}

/* ---------- Empty state ---------- */

export function EmptyState({ msg, icon }: { msg: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      <span className="big">{icon || '◌'}</span>
      {msg}
    </div>
  );
}

/* ---------- Table ---------- */

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="tbl-wrap">{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="tbl">{children}</table>;
}

/* ---------- Progress bar ---------- */

export function Bar({ value, color }: { value: number; color?: string }) {
  return (
    <div className="bar">
      <i style={{ width: Math.max(0, Math.min(100, value)) + '%', background: color }} />
    </div>
  );
}

/* ---------- Segmented control ---------- */

export function Seg<T extends string>({
  value,
  options,
  onChange,
  title,
}: {
  value: T;
  options: { v: T; label: ReactNode }[];
  onChange: (v: T) => void;
  title?: string;
}) {
  return (
    <div className="seg" title={title}>
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="tabs">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Key/value list ---------- */

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------- Banner ---------- */

/** Inline callout above a section — status is carried by icon and text, not colour alone. */
export function Banner({
  kind,
  icon,
  title,
  children,
  actions,
}: {
  kind?: 'info' | 'good' | 'warn';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={'banner' + (kind ? ' ' + kind : '')}>
      {icon && <div>{icon}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div className="t">{title}</div>}
        {children}
      </div>
      {actions}
    </div>
  );
}
