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

/* ---------------- failures nobody is listening for ---------------- */

/**
 * Every read failure, announced once, so a silent one becomes a visible one.
 *
 * ## Why this exists
 *
 * `useQuery` has always returned `error`. Across `src/modules` there are 384
 * call sites that destructure the result and **18** that take `error`. The
 * other 366 are written like
 *
 *     const { data: lv = [] } = usePendingLeave(ids);
 *     const { data: pendingTotal = 0 } = usePendingCount();
 *
 * so a 403, a 500, a CORS rejection and a dropped connection all render as an
 * empty list, or as the number zero. The screen looks like a working screen
 * reporting that there is nothing to show. That is the worst available
 * outcome: nobody files a bug against a feature that appears to work and says
 * there is no data, so the failure survives.
 *
 * It is also how the demo-id defect stayed alive. Every sign-in sent `E008` to
 * Postgres, every one of those requests failed, and the app showed empty
 * panels rather than an error — the only trace was in the database log.
 *
 * ## Why here rather than at the call sites
 *
 * Teaching 366 destructures to render an error state is a change to 37 modules
 * and to what each screen looks like when something breaks — a real piece of
 * design work, not a sweep. This is the part that is safe to do now and does
 * not need any of those decisions: the data flow is untouched, every screen
 * renders exactly as before, and the failure additionally says so out loud.
 *
 * Screens that *do* handle `error` keep doing it; this is in addition, not
 * instead, which is why the listener de-duplicates by message.
 *
 * Deliberately not an exception and not a redirect. A failed panel on an
 * otherwise working page should not take the page down.
 */
export interface QueryFailure {
  /** What the service said. Already safe to show — the API never returns SQL. */
  message: string;
}

const failureListeners = new Set<(f: QueryFailure) => void>();

/** Subscribe to read failures. Returns an unsubscribe. */
export function onQueryFailure(fn: (f: QueryFailure) => void): () => void {
  failureListeners.add(fn);
  return () => { failureListeners.delete(fn); };
}

function announceFailure(e: Error): void {
  /*
   * "You are not signed in" is not a failure worth a toast: the auth layer is
   * already signing the person out and showing the login page, and a toast
   * about it would arrive on top of that, once per in-flight query.
   */
  if (/not signed in/i.test(e.message)) return;
  for (const fn of failureListeners) {
    try { fn({ message: e.message }); } catch { /* a listener must not break a query */ }
  }
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
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        setLoading(false);
        /* See `onQueryFailure`: nearly every call site discards `error`, so
           without this a failure is indistinguishable from an empty result. */
        announceFailure(err);
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
