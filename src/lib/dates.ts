export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

/** A date as `YYYY-MM-DD`. Used as the key type throughout the dataset. */
export type Ymd = string;

export const ymd = (d: Date): Ymd =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

export const parseYmd = (s: Ymd): Date => {
  const p = String(s).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
};

const asDate = (d: Ymd | Date): Date => (typeof d === 'string' ? parseYmd(d) : d);

/**
 * The one place a stored value becomes a Date. Anything it cannot read becomes
 * `null`, so no formatter downstream can reach `getDate()` on an invalid Date.
 *
 * ## Why this exists
 *
 * User management printed "NaN Invalid Date" for three of five users. The
 * value was fine; the parse was not. `tenant_membership.last_login_at` is
 * returned as `last_login_at::text`, and Postgres renders a timestamptz as
 *
 *   2026-11-06 08:11:47.450537+00
 *
 * with a **space** where ISO 8601 puts a `T`. A formatter that split on 'T'
 * kept the whole string as the date part, `new Date` gave an invalid Date,
 * `getDate()` gave NaN and `toLocaleString` gave the literal text
 * "Invalid Date". The demo dataset writes `2026-09-18T09:30`, with the T, so
 * every screen looked right until it met the real API.
 *
 * Three shapes have to be read, and the order matters:
 *
 *   1. `YYYY-MM-DD` alone resolves to **local** midnight. `new Date('2026-11-06')`
 *      is UTC midnight, which is the previous day for any viewer west of
 *      Greenwich — so a joining date would read a day early in New York.
 *   2. A space-separated timestamp, normalised to a T. A bare `+00` offset is
 *      widened to `+00:00`, which is what the spec requires, and sub-millisecond
 *      digits are trimmed.
 *   3. Anything already valid, including a Date or an epoch number.
 */
export const parseInstant = (v: string | number | Date | null | undefined): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v) : null;

  const s = String(v).trim();
  if (!s) return null;

  /* Date-only first, so it lands on local midnight rather than UTC. */
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const d = new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const norm = s
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(norm);
  return Number.isFinite(d.getTime()) ? d : null;
};

export const addDays = (d: Ymd | Date, n: number): Date => {
  const x = new Date(asDate(d));
  x.setDate(x.getDate() + n);
  return x;
};

/*
 * All three go through `parseInstant`, so an unreadable value renders as the
 * fallback rather than as arithmetic on an invalid Date. `MON[NaN]` is
 * `undefined`, which is why the old versions could print "NaN undefined NaN".
 */

export const fmtD = (s?: Ymd | Date | null, fallback = '—'): string => {
  const d = parseInstant(s ?? null);
  if (!d) return fallback;
  return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
};

export const fmtDS = (s?: Ymd | Date | null, fallback = '—'): string => {
  const d = parseInstant(s ?? null);
  if (!d) return fallback;
  return d.getDate() + ' ' + MON[d.getMonth()];
};

/** "November 2026" — a reporting period's own name. */
export const fmtMonthYear = (s?: Ymd | Date | null, fallback = '—'): string => {
  const d = parseInstant(s ?? null);
  if (!d) return fallback;
  return MONL[d.getMonth()] + ' ' + d.getFullYear();
};

/**
 * An instant — a date plus the time of day, where the date alone would not be
 * enough. "6 Nov, 08:11", in the viewer's own zone.
 *
 * `fallback` is the caller's word for "no value", and it is deliberately not
 * "Never": that is a claim about history, and only a caller holding the
 * evidence may make it. Everywhere else an absent instant is unknown, not
 * proof of absence.
 */
export const fmtDT = (s?: string | number | Date | null, fallback = '—'): string => {
  const d = parseInstant(s ?? null);
  if (!d) return fallback;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MON[d.getMonth()]}, ${hh}:${mm}`;
};

export const dowOf = (s: Ymd | Date): string => DOW[asDate(s).getDay()];

export const isWeekend = (d: Ymd | Date): boolean => {
  const x = asDate(d).getDay();
  return x === 0 || x === 6;
};

/** `YYYY-MM` — the key payroll, attendance and billing periods are bucketed by. */
export const monthKey = (d: Ymd | Date): string => {
  const x = asDate(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0');
};

export const monthLabel = (k: string): string => {
  const p = k.split('-');
  return MON[+p[1] - 1] + ' ' + p[0];
};

export const monthLabelLong = (k: string): string => {
  const p = k.split('-');
  return MONL[+p[1] - 1] + ' ' + p[0];
};

/** Monday of the week containing `d` — timesheets are keyed by this. */
export function mondayOf(d: Ymd | Date): Date {
  const x = new Date(asDate(d));
  const g = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - g);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysBetween(a: Ymd, b: Ymd): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);
}

export function yearsSince(s: Ymd): number {
  const d = parseYmd(s);
  let y = TODAY.getFullYear() - d.getFullYear();
  const m = TODAY.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && TODAY.getDate() < d.getDate())) y--;
  return y;
}

export function tenure(s: Ymd): string {
  const d = parseYmd(s);
  let y = TODAY.getFullYear() - d.getFullYear();
  let m = TODAY.getMonth() - d.getMonth();
  if (m < 0) { y--; m += 12; }
  return (y > 0 ? y + 'y ' : '') + m + 'm';
}

/** Next occurrence of a day/month event — birthdays and work anniversaries. */
export function nextOccur(s: Ymd): Date {
  const d = parseYmd(s);
  const t = new Date(TODAY.getFullYear(), d.getMonth(), d.getDate());
  if (t < TODAY) t.setFullYear(t.getFullYear() + 1);
  return t;
}

export const hhmm = (mins: number): string =>
  String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(Math.round(mins % 60)).padStart(2, '0');

export function fmtTime(t?: string | null): string {
  if (!t) return '—';
  const p = t.split(':');
  let h = +p[0];
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + p[1] + ' ' + ap;
}
