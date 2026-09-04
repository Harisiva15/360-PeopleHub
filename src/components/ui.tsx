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

export function Tile({
  label,
  value,
  foot,
  trend,
  spark,
}: {
  label: ReactNode;
  value: ReactNode;
  foot?: ReactNode;
  /** Colours the footer figure green when rising, red when falling. */
  trend?: 'up' | 'down';
  spark?: ReactNode;
}) {
  return (
    <div className="tile">
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
      {foot && <div className="foot">{trend ? <span className={trend}>{foot}</span> : foot}</div>}
      {spark && <div className="spark">{spark}</div>}
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
