/**
 * Resolve a value as a service would.
 *
 * The mock reads straight out of memory, so this is immediate — but it still
 * returns a promise, which is the whole point: every call site is written for
 * a round trip that does not exist yet.
 *
 * Rows are handed back as live references into the dataset rather than copies.
 * That matches how the app has always worked and keeps the port's figures
 * identical; an HTTP implementation would naturally return fresh objects, and
 * no screen depends on the difference because screens no longer mutate rows.
 */
export const ok = <T>(v: T): Promise<T> => Promise.resolve(v);
