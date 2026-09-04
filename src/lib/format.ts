/** Indian digit grouping (2,2,3) with a rupee sign. */
export function inr(n?: number | null, dec?: boolean): string {
  if (n == null || isNaN(n)) return '—';
  const neg = n < 0;
  const abs = Math.abs(dec ? +(+n).toFixed(2) : Math.round(n));
  const s = String(Math.floor(abs));
  const frac = dec ? (abs % 1).toFixed(2).slice(1) : '';
  let last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  if (rest) last3 = ',' + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '₹' + rest + last3 + frac;
}

/** Compact Indian scale — crore above 1e7, lakh above 1e5. */
export const lakh = (n: number): string =>
  n >= 10000000 ? (n / 10000000).toFixed(2) + ' Cr' : n >= 100000 ? (n / 100000).toFixed(1) + ' L' : inr(n);

export const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 1000) / 10 : 0);

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

export const initials = (n: string): string =>
  n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export const AVCOL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#4a3aa7', '#e34948', '#008300', '#1c5cab', '#d55181'];

/** Stable avatar colour — same name always gets the same swatch. */
export function avColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVCOL[h % AVCOL.length];
}

/** Haversine distance in metres — backs the attendance geo-fence check. */
export function distM(a: number, b: number, c: number, d: number): number {
  const R = 6371000;
  const t = Math.PI / 180;
  const dLat = (c - a) * t;
  const dLon = (d - b) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}
