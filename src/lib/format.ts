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

/**
 * The avatar backgrounds, behind white initials.
 *
 * Every one of these carries `.av { color: #fff }`, so each is really a
 * contrast pair and has to be read as one. Seven of the ten were not: white on
 * `#eda100` was 2.2:1 and on `#1baf7a` 2.8:1, against the 4.5:1 that 11.5px
 * text needs. They are darkened here to clear it — hue kept, lightness taken
 * down until white reads.
 *
 * It survived because `check:contrast` validates *token* pairs read out of the
 * stylesheet, and this is a JavaScript array of literals applied as an inline
 * `background`, so there was no token for it to check. `checks/contrast.ts`
 * now imports this array and checks every entry, which is why adding a colour
 * here cannot reintroduce the problem.
 *
 * One palette for both themes, deliberately. The initials sit on the avatar's
 * own fill, not on the page, so the ratio does not move when the surface
 * behind it does — what the theme changes is the edge against the card, not
 * the legibility of the letters.
 */
export const AVCOL = ['#2975d1', '#c0552a', '#15855d', '#9e6b00', '#ad5c7a', '#4a3aa7', '#d04342', '#008300', '#1c5cab', '#c34a76'];

/** Stable avatar colour — same name always gets the same swatch. */
/**
 * Haversine distance in metres — backs the attendance geo-fence check.
 *
 * The browser's copy is for showing the employee where they stand before they
 * punch. The server computes its own from the same coordinates and that one
 * decides; these two agreeing is a convenience, not a guarantee.
 */
export function distM(a: number, b: number, c: number, d: number): number {
  const R = 6371000;
  const t = Math.PI / 180;
  const dLat = (c - a) * t;
  const dLon = (d - b) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

export function avColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVCOL[h % AVCOL.length];
}
