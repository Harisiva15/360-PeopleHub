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

export const addDays = (d: Ymd | Date, n: number): Date => {
  const x = new Date(asDate(d));
  x.setDate(x.getDate() + n);
  return x;
};

export const fmtD = (s?: Ymd | Date | null): string => {
  if (!s) return '—';
  const d = asDate(s);
  return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
};

export const fmtDS = (s?: Ymd | Date | null): string => {
  if (!s) return '—';
  const d = asDate(s);
  return d.getDate() + ' ' + MON[d.getMonth()];
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
