export const sum = <T>(a: readonly T[], f?: (x: T) => number): number =>
  a.reduce((t, x) => t + (f ? f(x) : (x as unknown as number)), 0);

export const uniq = <T>(a: readonly T[]): T[] => Array.from(new Set(a));

export function groupBy<T>(arr: readonly T[], f: (x: T) => string): Record<string, T[]> {
  const m: Record<string, T[]> = {};
  arr.forEach((x) => {
    const k = f(x);
    (m[k] = m[k] || []).push(x);
  });
  return m;
}

export function sortBy<T>(arr: readonly T[], f?: (x: T) => number | string, dir?: 'asc' | 'desc'): T[] {
  const g = f || ((x: T) => x as unknown as number | string);
  return arr.slice().sort((a, b) => {
    const x = g(a);
    const y = g(b);
    return (x > y ? 1 : x < y ? -1 : 0) * (dir === 'desc' ? -1 : 1);
  });
}
