/**
 * The knowledge base holds articles, and only the right people write them.
 *
 * `knowledgeBase()` was `return []` — a literal, with a comment saying this
 * deployment had no table for it. `kb_article` has existed since migration
 * 0007. So the policy library showed nothing, could be given nothing, and the
 * comment explaining why had been false for a long time without anyone
 * noticing, because an empty list is exactly what an empty table looks like.
 *
 * That is the failure worth guarding against here: not a wrong answer, but a
 * plausible one. The first assertion writes a row and reads it back, which no
 * amount of `return []` can satisfy.
 *
 * The rest is the permission boundary. The helpdesk module grants an employee
 * `write: 'own'` so they can raise their own ticket, which would let them
 * write company policy if the service did not narrow it. It does, and this is
 * where that is held.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('\nSKIPPED: no database, and an article is a row in one.\n');
  process.exit(0);
}

process.env.PG_POOL_MAX = process.env.PG_POOL_MAX ?? '2';

const { default: pg } = await import('pg');
const { knowledgeBase, createArticle, updateArticle, removeArticle } =
  await import('../src/modules/helpdesk/service.ts');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};
const attempt = async (fn) => {
  try { await fn(); return null; } catch (e) { return e; }
};

const admin = new pg.Client({
  connectionString: process.env.MIGRATE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await admin.connect();

const before = (await admin.query('SELECT count(*)::int n FROM kb_article')).rows[0].n;

const ctx = (await admin.query(`
  SELECT t.id tenant, e.id emp, (SELECT code FROM ticket_category LIMIT 1) cat
    FROM tenant t JOIN employee e ON e.tenant_id = t.id
   WHERE t.slug = '360vhm' AND e.code = 'VHM004'`)).rows[0];

const caller = (role) => ({ role, tenantId: ctx.tenant, employeeId: ctx.emp, userId: null });
const made = [];

const cleanup = async () => {
  if (made.length) {
    await admin.query('DELETE FROM kb_article WHERE id = ANY($1::uuid[])', [made]);
  }
};

try {
  /* ---------------------------------------------------------------- *
   * It is written down, and read back
   * ---------------------------------------------------------------- */

  console.log('\nan article can be written and read\n');

  const a = await createArticle(caller('admin'), {
    cat: ctx.cat, q: 'ZZ What is the notice period?', a: 'ZZ Sixty days after confirmation.',
  });
  made.push(a.id);

  ok('creating returns the article', Boolean(a.id));
  ok('  with the question as given', a.q === 'ZZ What is the notice period?');
  ok('  the answer as given', a.a === 'ZZ Sixty days after confirmation.');
  ok('  the category as a code, which is what the screens resolve', a.cat === ctx.cat,
    `got ${JSON.stringify(a.cat)}, expected ${ctx.cat}`);
  ok('  and published by default', a.published === true);

  const listed = await knowledgeBase(caller('admin'));
  ok('and it comes back from the list', listed.some((x) => x.id === a.id),
    'this is the assertion `return []` could never pass');

  /* ---------------------------------------------------------------- *
   * Editing and unpublishing
   * ---------------------------------------------------------------- */

  console.log('\nediting\n');

  const edited = await updateArticle(caller('admin'), a.id, { a: 'ZZ Thirty days on probation.' });
  ok('the answer changes', edited.a === 'ZZ Thirty days on probation.');
  ok('  and the question is left alone', edited.q === a.q,
    'a patch must not blank the fields it does not mention');

  const hidden = await updateArticle(caller('admin'), a.id, { published: false });
  ok('an article can be unpublished', hidden.published === false);

  const asEmployee = await knowledgeBase(caller('employee'));
  ok('  and an employee no longer sees it', !asEmployee.some((x) => x.id === a.id),
    'an unpublished article is a draft; a draft is not company policy yet');
  const asManager = await knowledgeBase(caller('manager'));
  ok('  but whoever may edit it still does', asManager.some((x) => x.id === a.id));

  await updateArticle(caller('admin'), a.id, { published: true });
  ok('  and publishing it again brings it back',
    (await knowledgeBase(caller('employee'))).some((x) => x.id === a.id));

  /* ---------------------------------------------------------------- *
   * Who may write
   * ---------------------------------------------------------------- */

  console.log('\nwho may write company policy\n');

  const byEmployee = await attempt(() => createArticle(caller('employee'), {
    q: 'ZZ nope', a: 'ZZ nope',
  }));
  ok('an employee cannot create one', byEmployee !== null,
    'the helpdesk module grants an employee write:own for their own ticket — '
    + 'an article is not their own anything, and the service narrows it');
  ok('  and is told why', /administrator or a manager/.test(byEmployee?.message ?? ''),
    byEmployee?.message);

  ok('an employee cannot edit one',
    (await attempt(() => updateArticle(caller('employee'), a.id, { q: 'ZZ edited' }))) !== null);
  ok('an employee cannot remove one',
    (await attempt(() => removeArticle(caller('employee'), a.id))) !== null);

  const byManager = await createArticle(caller('manager'), {
    q: 'ZZ Who approves leave?', a: 'ZZ Your reporting manager.',
  });
  made.push(byManager.id);
  ok('a manager can', Boolean(byManager.id));

  /* ---------------------------------------------------------------- *
   * Validation
   * ---------------------------------------------------------------- */

  console.log('\nwhat is refused\n');

  ok('an empty question is refused',
    (await attempt(() => createArticle(caller('admin'), { q: '   ', a: 'ZZ body' }))) !== null);
  ok('an empty answer is refused',
    (await attempt(() => createArticle(caller('admin'), { q: 'ZZ q', a: '  ' }))) !== null);
  ok('blanking the question by patch is refused',
    (await attempt(() => updateArticle(caller('admin'), a.id, { q: '' }))) !== null,
    'the patch path validates too, or an edit can empty what create would not accept');

  const badCat = await attempt(() => createArticle(caller('admin'), {
    cat: 'ZZNOSUCH', q: 'ZZ q', a: 'ZZ a',
  }));
  ok('an unknown category is refused', badCat !== null);
  ok('  naming it', /ZZNOSUCH/.test(badCat?.message ?? ''), badCat?.message);

  const longQ = await attempt(() => createArticle(caller('admin'), {
    cat: null, q: 'Z'.repeat(301), a: 'ZZ a',
  }));
  ok('an over-long question is refused', longQ !== null);

  ok('editing an article that does not exist is a not-found',
    (await attempt(() => updateArticle(caller('admin'),
      '00000000-0000-0000-0000-000000000000', { q: 'ZZ x' }))) !== null);

  /* ---------------------------------------------------------------- *
   * Removal
   * ---------------------------------------------------------------- */

  console.log('\nremoval\n');

  const gone = await removeArticle(caller('admin'), byManager.id);
  made.splice(made.indexOf(byManager.id), 1);
  ok('removing returns what was removed', gone.id === byManager.id);
  ok('  and it is no longer listed',
    !(await knowledgeBase(caller('admin'))).some((x) => x.id === byManager.id));
  ok('  and removing it twice is a not-found',
    (await attempt(() => removeArticle(caller('admin'), byManager.id))) !== null);
} finally {
  await cleanup();
}

console.log('\nthe database is as it was\n');
const after = (await admin.query('SELECT count(*)::int n FROM kb_article')).rows[0].n;
ok(`kb_article rows ${after}`, after === before, `was ${before}`);

await admin.end();

console.log(failed
  ? `\n${failed} problem(s)`
  : '\nthe knowledge base holds articles, and only HR and managers write them');
process.exit(failed ? 1 : 0);
