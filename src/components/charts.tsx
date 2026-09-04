import type { ReactNode } from 'react';
import { sum } from '../lib/collections';
import { clamp } from '../lib/format';

/**
 * Categorical hues, assigned in this fixed order and never cycled. Validated
 * for lightness band, chroma, CVD separation and contrast in both themes; the
 * three lighter light-mode hues sit under 3:1 against the surface, which the
 * legends, direct value labels and data tables alongside every chart relieve.
 */
export const PAL = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

export interface Series {
  name: string;
  data: number[];
  color: string;
}

type Fmt = (v: number) => string | number;

/** Round an axis maximum up to a readable 1/2/2.5/5/10 × power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function axisTicks(max: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push((max * i) / n);
  return out;
}

interface AxisProps {
  labels: string[];
  series: Series[];
  width?: number;
  height?: number;
  padLeft?: number;
  fmt?: Fmt;
  tickFmt?: Fmt;
}

/* ---------- vertical bars, grouped or stacked ---------- */

export function BarChart({
  labels, series, width = 640, height = 220, padLeft = 46, stacked, fmt, tickFmt,
}: AxisProps & { stacked?: boolean }) {
  const PB = 26;
  const PT = 12;
  const PR = 8;
  const fmtV: Fmt = fmt || ((v) => Math.round(v));

  const maxRaw = stacked
    ? Math.max(...labels.map((_, i) => sum(series, (s) => s.data[i] || 0)))
    : Math.max(...series.map((s) => Math.max(...s.data.map((v) => v || 0))));
  const max = niceMax(maxRaw) || 1;

  const iw = width - padLeft - PR;
  const ih = height - PB - PT;
  const bw = iw / labels.length;
  const y = (v: number) => PT + ih - (v / max) * ih;

  const marks: ReactNode[] = [];
  const xLabels: ReactNode[] = [];
  const step = labels.length > 14 ? Math.ceil(labels.length / 12) : 1;

  labels.forEach((lb, i) => {
    if (stacked) {
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.data[i] || 0;
        if (!v) return;
        const y1 = y(acc + v);
        const y2 = y(acc);
        /* 2px surface gap keeps adjacent segments legible */
        const h = Math.max(1, y2 - y1 - 2);
        marks.push(
          <rect
            key={`s${i}-${si}`} className="mk"
            x={+(padLeft + i * bw + bw * 0.18).toFixed(1)} y={+y1.toFixed(1)}
            width={+(bw * 0.64).toFixed(1)} height={+h.toFixed(1)} rx={3} fill={s.color}
            data-tip={`${lb} · ${s.name}: ${fmtV(v)}`}
          />,
        );
        acc += v;
      });
    } else {
      const n = series.length;
      const gw = (bw * 0.72) / n;
      series.forEach((s, si) => {
        const v = s.data[i] || 0;
        const h = Math.max(v > 0 ? 2 : 0, PT + ih - y(v));
        marks.push(
          <rect
            key={`g${i}-${si}`} className="mk"
            x={+(padLeft + i * bw + bw * 0.14 + si * gw + 1).toFixed(1)} y={+(PT + ih - h).toFixed(1)}
            width={+Math.max(2, gw - 2).toFixed(1)} height={+h.toFixed(1)} rx={3} fill={s.color}
            data-tip={`${lb} · ${s.name}: ${fmtV(v)}`}
          />,
        );
      });
    }
    if (i % step === 0) {
      xLabels.push(
        <text key={`x${i}`} x={+(padLeft + i * bw + bw / 2).toFixed(1)} y={height - 9}
          textAnchor="middle" fontSize={10} fill="var(--ink-3)">{lb}</text>,
      );
    }
  });

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
      {axisTicks(max, 4).map((t, i) => (
        <g key={i}>
          <line x1={padLeft} x2={width - PR} y1={+y(t).toFixed(1)} y2={+y(t).toFixed(1)} stroke="var(--grid)" strokeWidth={1} />
          <text x={padLeft - 7} y={+(y(t) + 3.5).toFixed(1)} textAnchor="end" fontSize={10} fill="var(--ink-3)">
            {tickFmt ? tickFmt(t) : fmtV(t)}
          </text>
        </g>
      ))}
      <line x1={padLeft} x2={width - PR} y1={PT + ih} y2={PT + ih} stroke="var(--axis)" strokeWidth={1} />
      {marks}
      {xLabels}
    </svg>
  );
}

/* ---------- line / area ---------- */

export function LineChart({
  labels, series, width = 640, height = 220, padLeft = 46, area, fmt, tickFmt,
}: AxisProps & { area?: boolean }) {
  const PB = 26;
  const PT = 12;
  const PR = 10;
  const fmtV: Fmt = fmt || ((v) => Math.round(v));
  const max = niceMax(Math.max(...series.map((s) => Math.max(...s.data)))) || 1;

  const iw = width - padLeft - PR;
  const ih = height - PB - PT;
  const x = (i: number) => padLeft + (labels.length === 1 ? iw / 2 : (i * iw) / (labels.length - 1));
  const y = (v: number) => PT + ih - (v / max) * ih;
  const step = labels.length > 13 ? Math.ceil(labels.length / 10) : 1;

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
      {axisTicks(max, 4).map((t, i) => (
        <g key={i}>
          <line x1={padLeft} x2={width - PR} y1={+y(t).toFixed(1)} y2={+y(t).toFixed(1)} stroke="var(--grid)" strokeWidth={1} />
          <text x={padLeft - 7} y={+(y(t) + 3.5).toFixed(1)} textAnchor="end" fontSize={10} fill="var(--ink-3)">
            {tickFmt ? tickFmt(t) : fmtV(t)}
          </text>
        </g>
      ))}
      <line x1={padLeft} x2={width - PR} y1={PT + ih} y2={PT + ih} stroke="var(--axis)" strokeWidth={1} />

      {series.map((s, si) => {
        const pts = s.data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        return (
          <g key={si}>
            {area && (
              <path
                d={`M${x(0).toFixed(1)},${PT + ih} L${pts.join(' L')} L${x(labels.length - 1).toFixed(1)},${PT + ih} Z`}
                fill={s.color} opacity={0.12}
              />
            )}
            <path d={`M${pts.join(' L')}`} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        );
      })}

      {/* markers last, so they sit above every line; a 2px surface ring separates overlaps */}
      {series.map((s, si) =>
        s.data.map((v, i) => (
          <circle
            key={`${si}-${i}`} className="mk" cx={+x(i).toFixed(1)} cy={+y(v).toFixed(1)} r={4}
            fill={s.color} stroke="var(--surface)" strokeWidth={2}
            data-tip={`${labels[i]} · ${s.name}: ${fmtV(v)}`}
          />
        )),
      )}

      {labels.map((lb, i) =>
        i % step === 0 ? (
          <text key={i} x={+x(i).toFixed(1)} y={height - 9} textAnchor="middle" fontSize={10} fill="var(--ink-3)">{lb}</text>
        ) : null,
      )}
    </svg>
  );
}

/* ---------- horizontal bars ---------- */

export interface HBarRow {
  k: string;
  v: number;
  c?: string;
}

export function HBar({ rows, fmt }: { rows: HBarRow[]; fmt?: Fmt }) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  const fmtV: Fmt = fmt || ((v) => v);
  return (
    <div className="stack" style={{ gap: 9 }}>
      {rows.map((r, i) => (
        <div key={i} data-tip={`${r.k}: ${fmtV(r.v)}`}>
          <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
            <span style={{ fontWeight: 600 }}>{r.k}</span>
            <span className="mono muted">{fmtV(r.v)}</span>
          </div>
          <div className="bar">
            <i style={{ width: Math.max(1.5, (r.v / max) * 100).toFixed(1) + '%', background: r.c || 'var(--s1)' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- donut ---------- */

export interface Slice {
  k: string;
  v: number;
  c: string;
}

export function Donut({
  slices, size = 170, stroke = 22, center, centerSub, fmt,
}: {
  slices: Slice[];
  size?: number;
  stroke?: number;
  center?: ReactNode;
  centerSub?: string;
  fmt?: Fmt;
}) {
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const C = 2 * Math.PI * r;
  const total = sum(slices, (s) => s.v) || 1;

  let acc = 0;
  const arcs = slices.map((s, i) => {
    if (!s.v) return null;
    const frac = s.v / total;
    /* 2px gap between segments */
    const len = C * frac - 2;
    const el = (
      <circle
        key={i} className="mk" cx={cx} cy={cx} r={r} fill="none" stroke={s.c} strokeWidth={stroke} strokeLinecap="butt"
        strokeDasharray={`${Math.max(0, len).toFixed(2)} ${(C - len).toFixed(2)}`}
        strokeDashoffset={(-C * acc + 1).toFixed(2)}
        data-tip={`${s.k}: ${fmt ? fmt(s.v) : s.v} (${(frac * 100).toFixed(1)}%)`}
      />
    );
    acc += frac;
    return el;
  });

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: '0 0 auto' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        {arcs}
      </svg>
      {center != null && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div>
            <div style={{ fontSize: 23, fontWeight: 750, letterSpacing: '-.8px', lineHeight: 1 }}>{center}</div>
            {centerSub && (
              <div style={{ fontSize: 10.5, color: 'var(--ink-3)', fontWeight: 600, marginTop: 2 }}>{centerSub}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- legend ---------- */

export interface LegendItem {
  k: string;
  c: string;
  v?: number | string;
}

/** Always shown for two or more series, so identity is never colour alone. */
export function Legend({ items, fmt }: { items: LegendItem[]; fmt?: (v: number | string) => string | number }) {
  return (
    <div className="legend">
      {items.map((i, n) => (
        <span key={n}>
          <i style={{ background: i.c }} />
          {i.k}
          {i.v != null && <> <b className="mono">{fmt ? fmt(i.v) : i.v}</b></>}
        </span>
      ))}
    </div>
  );
}

/* ---------- sparkline ---------- */

export function Spark({ data, color, w = 74, h = 22 }: { data: number[]; color: string; w?: number; h?: number }) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const pts = data.map(
    (v, i) => `${((i * w) / (data.length - 1)).toFixed(1)},${(h - ((v - min) / (max - min || 1)) * h).toFixed(1)}`,
  );
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={`M${pts.join(' L')}`} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- progress ring ---------- */

export function Ring({ value, color, size = 88 }: { value: number; color: string; size?: number }) {
  const sw = 9;
  const r = (size - sw) / 2;
  const C = 2 * Math.PI * r;
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={sw} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={`${((C * clamp(value, 0, 100)) / 100).toFixed(1)} ${C.toFixed(1)}`}
        />
      </svg>
      <div className="ctr">{Math.round(value)}%</div>
    </div>
  );
}
