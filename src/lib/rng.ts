/**
 * Deterministic PRNG so the demo dataset is byte-stable across reloads.
 *
 * Every generator in `src/data` draws from this single stream, so the module
 * evaluation order in `src/data/index.ts` is load-bearing: reordering imports
 * reshuffles the whole dataset. Ported from the prototype's `mulberry(360360)`.
 */
export function mulberry(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RND = mulberry(360360);

export const rnd = (): number => RND();
export const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
export const chance = (p: number): boolean => rnd() < p;

export const uid = (() => {
  let n = 1000;
  return (p?: string) => (p || 'id') + '-' + ++n;
})();
