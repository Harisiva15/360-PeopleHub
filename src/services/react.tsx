import { useCallback, useEffect, useRef, useState } from 'react';
import { getServices } from './index';
import type { Services } from './contracts';

/**
 * Query and mutation hooks over the service layer.
 *
 * Deliberately small — this is a seam, not a data-fetching library. What it
 * has to get right is the three things that bite when a mock is swapped for a
 * network: results arriving out of order, results arriving after unmount, and
 * a mutation leaving the screen showing stale rows.
 */

/** Bumped on every successful mutation; every live query refetches. */
const listeners = new Set<() => void>();
let revision = 0;

/** Force every mounted query to refetch — called for you after a mutation. */
export function invalidate(): void {
  revision++;
  listeners.forEach((l) => l());
}

/**
 * Watch for service mutations from outside React's query hooks. The app shell
 * uses this to re-render screens that have not been migrated onto the service
 * layer yet and still read the dataset directly.
 */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export interface QueryResult<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Runs `run` against the active services and re-runs it when `deps` change or
 * anything is mutated. Previous data is kept while refetching, so a refresh
 * does not blank the screen.
 */
export function useQuery<T>(run: (s: Services) => Promise<T>, deps: unknown[] = []): QueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  /* Held in a ref so a stale response can never overwrite a newer one. */
  const seq = useRef(0);
  const alive = useRef(true);
  const [tick, setTick] = useState(0);

  /*
   * The latest runner is parked in a ref so the fetch effect does not re-fire
   * on every render just because the closure is new. Writing it in an effect
   * rather than during render keeps render pure — the fetch effect below is
   * declared after this one, so it always sees the current value.
   */
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    runRef.current(getServices()).then(
      (v) => {
        if (!alive.current || mine !== seq.current) return;
        setData(v);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive.current || mine !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  /* Refetch on any mutation anywhere. Coarse, but correct — and the mock is instant. */
  useEffect(() => {
    const l = () => setTick(revision);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, error, refetch };
}

export interface MutationResult<A extends unknown[], R> {
  mutate: (...args: A) => Promise<R>;
  pending: boolean;
  error: Error | null;
}

/**
 * Wraps a service command. On success every live query refetches, so screens
 * never hand-roll cache updates — the thing that rots first when the data
 * source changes.
 */
export function useMutation<A extends unknown[], R>(
  run: (s: Services, ...args: A) => Promise<R>,
): MutationResult<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /* Same reason as useQuery: assigned in an effect, read from the handler. */
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });

  const mutate = useCallback(async (...args: A): Promise<R> => {
    setPending(true);
    setError(null);
    try {
      const out = await runRef.current(getServices(), ...args);
      invalidate();
      return out;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setPending(false);
    }
  }, []);

  return { mutate, pending, error };
}
