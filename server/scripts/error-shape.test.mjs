/**
 * What a refusal tells the client, and what it must not.
 *
 * Error bodies used to be `{ error: message }` and nothing else. The status
 * said which category — 403, 404, 409 — and the message said what happened in
 * English, and between them there was nothing a screen could branch on. So the
 * punch card decided whether to offer an attendance correction by matching the
 * message text, which works until somebody rewords a sentence and then stops
 * working silently: the button simply never appears again.
 *
 * Bodies now carry `code` (the service's own refusal name) and, where the
 * refusal is *about* something, `detail`.
 *
 * ## The half that is a boundary, not a convenience
 *
 * `codeOf` reads `error.code`, and a Postgres error also has a string `code` —
 * a five-character SQLSTATE like `23503`. Passing that through would send the
 * schema's constraint vocabulary to a browser to answer a question nobody
 * asked, and it would do it on exactly the errors nobody anticipated, which is
 * the worst population to be generous with. `statusFor` already translates
 * those into a status and a sentence of our own; this suite is what stops the
 * raw code travelling beside them.
 *
 * No database, and that is why `codeOf` and `detailOf` live in
 * `http/refusal.ts` rather than inside `app.ts`: importing `app.ts` reads
 * `config.ts`, which throws without a `DATABASE_URL`, and a boundary this
 * narrow should be assertable anywhere the server's TypeScript runs.
 */

const { codeOf, detailOf } = await import('../src/http/refusal.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `\n        ${detail}`}`);
};

console.log('\nthe refusal code\n');

class ServiceError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

ok('1. a service refusal carries its own code',
  codeOf(new ServiceError('outside the window', 'outside_window')) === 'outside_window');
ok('    including the ones a screen branches on',
  ['already_in', 'no_punch_in', 'forbidden', 'not_found', 'duplicate', 'conflict']
    .every((c) => codeOf(new ServiceError('x', c)) === c));

/*
 * `AuthError` and `PermissionError` predate the convention and spell it
 * `kind`. Reading both is what makes this one rule rather than a rule and an
 * exception, and it costs one `??`.
 */
ok('2. and `kind`, for the two classes that spell it that way',
  codeOf(Object.assign(new Error('nope'), { kind: 'forbidden' })) === 'forbidden');
ok('    with `code` winning when something carries both',
  codeOf(Object.assign(new Error('nope'), { code: 'invalid', kind: 'forbidden' })) === 'invalid');

console.log('\nand the SQLSTATE that must not travel with it\n');

/*
 * The five shapes a `pg` error actually arrives in. Each is a real SQLSTATE
 * this codebase maps in `statusFor`: unique violation, foreign key, check
 * constraint, not-null, and insufficient privilege — the last being the one
 * that would tell a caller which table RLS stopped them on.
 */
for (const sqlstate of ['23505', '23503', '23514', '23502', '42501']) {
  ok(`3. SQLSTATE ${sqlstate} is not sent as a refusal code`,
    codeOf(Object.assign(new Error('db said no'), { code: sqlstate })) === undefined,
    String(codeOf(Object.assign(new Error('db said no'), { code: sqlstate }))));
}

/*
 * And the shape of the rule rather than a list of the codes it has seen: five
 * characters, upper case or digits. A service code that happened to look like
 * one would also be withheld, which is the safe direction — and none does,
 * because every one of them is a lower-case word with an underscore.
 */
ok('    because the rule is the shape, not a list of known ones',
  codeOf(Object.assign(new Error('x'), { code: 'P0001' })) === undefined
  && codeOf(Object.assign(new Error('x'), { code: '0A000' })) === undefined);
ok('    and no service code in this codebase looks like one',
  ['outside_window', 'already_in', 'no_punch_in', 'self_approval', 'not_configured',
    'unreachable', 'too_large', 'not_authorised', 'svg_refused', 'incomplete']
    .every((c) => codeOf(new ServiceError('x', c)) === c));

console.log('\nnothing to report is reported as nothing\n');

ok('4. an error with no code sends none', codeOf(new Error('plain')) === undefined);
ok('    and neither does a non-error', codeOf(undefined) === undefined
  && codeOf(null) === undefined && codeOf('a string') === undefined
  && codeOf(42) === undefined);
/*
 * A numeric code is `undefined`, not `'500'`. Node's own errors carry numeric
 * `errno`-style codes in places, and stringifying one would invent a refusal
 * name out of an operating-system detail.
 */
ok('    nor a code that is not a string',
  codeOf(Object.assign(new Error('x'), { code: 23505 })) === undefined);

console.log('\nthe structured detail\n');

ok('5. an object detail travels',
  detailOf(new ServiceError('x', 'outside_window', { localDate: '2026-10-20' }))
    ?.localDate === '2026-10-20');

/*
 * An array is refused on purpose. `{ ...detail }` on an array produces an
 * object with numeric keys, so a client reading `detail.localDate` would get
 * `undefined` from something that was sent successfully — a silent wrong
 * answer rather than a visible missing one.
 */
ok('6. an array does not, because a list is not a field set',
  detailOf(new ServiceError('x', 'c', ['a', 'b'])) === undefined);
ok('    and neither does a string, a number or null',
  detailOf(new ServiceError('x', 'c', 'just words')) === undefined
  && detailOf(new ServiceError('x', 'c', 7)) === undefined
  && detailOf(new ServiceError('x', 'c', null)) === undefined);
ok('7. an error with no detail sends none', detailOf(new Error('plain')) === undefined);
ok('    and a non-error is not probed for one',
  detailOf(undefined) === undefined && detailOf(null) === undefined);

console.log(`\n${failed
  ? `${failed} FAILED`
  : 'a refusal says which refusal it is, and says nothing about the schema'}\n`);
process.exit(failed ? 1 : 0);
