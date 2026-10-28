/**
 * What a refusal tells the client beside its status and its sentence.
 *
 * Error bodies were `{ error: message }` and nothing else. The status gave the
 * category — 403, 404, 409 — and the message said what happened in English,
 * and between them there was nothing a screen could branch on. So the punch
 * card decided whether to offer an attendance correction by matching the
 * message text, which works until somebody rewords a sentence and then stops
 * working silently: the button simply never appears again.
 *
 * Bodies carry `code` — the service's own refusal name — and, where the
 * refusal is *about* something, `detail`.
 *
 * Its own module rather than two helpers inside `app.ts`, because `app.ts`
 * reads `config.ts` at import time and so cannot be loaded without a database
 * URL. These are pure functions over a thrown value; keeping them separate is
 * what lets `error-shape.test.mjs` assert the boundary below without a
 * database, and so run everywhere the server's TypeScript does.
 */

/**
 * The service's own refusal code, where the error carries one.
 *
 * Every service error class here has a `code` naming which refusal it is —
 * `outside_window`, `already_in`, `duplicate`. The two oldest, `AuthError` and
 * `PermissionError`, spell it `kind`; reading both makes this one rule rather
 * than a rule and an exception.
 *
 * ## The SQLSTATE must not travel
 *
 * A Postgres error also has a string `code`: five characters like `23503`.
 * Sending that to a browser would hand out the schema's constraint vocabulary
 * to answer a question nobody asked — and `42501` would name the table RLS
 * stopped the caller on. `statusFor` already turns those into a status and a
 * sentence of our own, and they reach a client only that way.
 *
 * Withheld by *shape* rather than by a list of the ones seen so far: five
 * characters, digits or upper case. A service code that happened to look like
 * one would be withheld too, which is the safe direction to fail in, and none
 * does — every one is a lower-case word.
 *
 * A non-string code is `undefined` and not `String(code)`. Node carries
 * numeric errno-style codes in places, and stringifying one would invent a
 * refusal name out of an operating-system detail.
 */
export const codeOf = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; kind?: unknown } | null;
  const raw = typeof e?.code === 'string' ? e.code
    : typeof e?.kind === 'string' ? e.kind : undefined;
  if (!raw || /^[0-9A-Z]{5}$/.test(raw)) return undefined;
  return raw;
};

/**
 * Structured context the refusal is *about*, where the error carries it.
 *
 * `outside_window` is the one this exists for. Its message names the day to
 * raise an attendance correction for, which is enough for a person to read and
 * not enough for a form to fill itself in with, so the date travels beside the
 * sentence as `detail.localDate` — in the shift's own timezone, never the
 * browser's, which for anybody on hours measured elsewhere is a different day
 * for several hours of every one.
 *
 * Only a plain object. An array is refused deliberately: spreading one into a
 * JSON body produces numeric keys, so a client reading `detail.localDate`
 * would get `undefined` from something that was sent successfully — a silent
 * wrong answer rather than a visible missing one.
 *
 * This carries nothing the caller is not already entitled to. It is data the
 * refusal is about, decided by the service that threw, not a dump of the
 * error.
 */
export const detailOf = (error: unknown): Record<string, unknown> | undefined => {
  const d = (error as { detail?: unknown } | null)?.detail;
  return d && typeof d === 'object' && !Array.isArray(d)
    ? d as Record<string, unknown>
    : undefined;
};
