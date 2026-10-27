/**
 * The company logo and the person who signs its letters.
 *
 * The assertions that matter are not "an insert happened" but the rules the
 * decisions were taken on: 2 MB, PNG and JPG only and checked against the
 * bytes rather than the claim, SVG refused with its own reason, write for
 * company_admin alone while **everybody** reads, a replaced logo purged
 * rather than deleted, and a signatory that is a real pair or nothing at all.
 *
 *   node --experimental-strip-types scripts/branding.test.mjs
 *
 * ## Why the storage adapter is swapped
 *
 * `setStorage` replaces the Supabase adapter with one that keeps the bytes in
 * a Map. The alternative is a suite that cannot run without network and
 * credentials, and what is under test here is the service's rules — the
 * adapter's own validation is covered by `check:storage`, against the real
 * one. The put still goes through `validate` and `sniff`, so the size and
 * magic-byte assertions below are the real checks and not a stub's opinion.
 */

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

const refused = async (label, fn, rx) => {
  try {
    await fn();
    ok(label, false, 'it was allowed');
  } catch (e) {
    ok(label, rx.test(e?.message ?? ''), `${e?.constructor?.name}: ${e?.message}`);
  }
};

const { assertLocalDatabase } = await import('./local-only.mjs');
if (!process.env.MIGRATE_DATABASE_URL || !process.env.DATABASE_URL) {
  console.log('SKIPPED: set MIGRATE_DATABASE_URL and DATABASE_URL to a local database.');
  process.exit(0);
}
assertLocalDatabase();

process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';

/* Nothing above the skip, for the reason photo.test.mjs records. */
const { default: pg } = await import('pg');
const { withScratchTenant } = await import('./lib/scratch-tenant.mjs');
const { setStorage } = await import('../src/storage/index.ts');
const {
  logoUrl, setLogo, removeLogo, signatoryOf, setSignatory, LOGO_MAX_BYTES,
} = await import('../src/modules/branding/service.ts');

/* --- a storage adapter that keeps the bytes in memory -------------------- */

const objects = new Map();
let removals = 0;
setStorage({
  async put(req) {
    /* The real validate/sniff still run: this only replaces the transport. */
    const { validate, sniff, keyFor } = await import('../src/storage/index.ts');
    validate(req);
    const sniffed = sniff(req.bytes);
    const { createHash } = await import('node:crypto');
    const key = `${keyFor(req.prefix, req.tenantId)}`;
    objects.set(key, req.bytes);
    return {
      storageKey: key,
      mimeType: sniffed ?? req.mimeType,
      sizeBytes: req.bytes.length,
      checksum: createHash('sha256').update(req.bytes).digest('hex'),
    };
  },
  async signedUrl(key) { return `memory://${key}`; },
  async remove(key) { removals += 1; objects.delete(key); },
});

/* --- the smallest real PNG and JPG, as bytes ---------------------------- */

/* An 8-byte PNG signature followed by a minimal IHDR is enough for `sniff`. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 9),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(16, 1)]);

const admin = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
await admin.connect();

console.log('');
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const boss = {
      tenantId: ctx.tenant,
      userId: null,
      employeeId: ctx.adminEmployeeId,
      role: 'company_admin',
      hasReports: false,
    };
    /* Same tenant, same person, a role that holds nothing on `settings`. */
    const hr = { ...boss, role: 'hr_admin' };
    const staff = { ...boss, role: 'employee' };

    const entity = (await admin.query(
      'SELECT id, code FROM legal_entity WHERE tenant_id = $1 AND is_default',
      [ctx.tenant])).rows[0];

    /* --- nothing uploaded yet ------------------------------------------- */

    ok('1. no logo reads as null rather than an error',
      await logoUrl(boss, entity.code) === null);
    ok('2.  and the default entity answers without being named',
      await logoUrl(boss) === null);
    ok('3. no signatory reads as null, which is what refuses a letter',
      await signatoryOf(boss, entity.code) === null);

    /* --- who may write -------------------------------------------------- */

    await refused('4. hr_admin may not upload a logo',
      () => setLogo(hr, entity.code, PNG, 'image/png'), /company administrator/i);
    await refused('5. an employee may not either',
      () => setLogo(staff, entity.code, PNG, 'image/png'), /company administrator/i);
    await refused('6.  nor remove one',
      () => removeLogo(hr, entity.code), /company administrator/i);
    await refused('7.  nor name the signatory',
      () => setSignatory(hr, entity.code, 'A', 'B'), /company administrator/i);

    /* --- what a logo may be --------------------------------------------- */

    await refused('8. SVG is refused, and the message says why rather than "wrong type"',
      () => setLogo(boss, entity.code, SVG, 'image/svg+xml'), /executable markup/i);
    await refused('9.  including an SVG renamed to .png — the bytes are read, not the claim',
      () => setLogo(boss, entity.code, SVG, 'image/png'), /executable markup/i);
    await refused('10. a GIF is refused as a type',
      () => setLogo(boss, entity.code, GIF, 'image/gif'), /type|allow|png|jpe?g/i);
    await refused('11. a PNG claiming to be a JPG is refused on its magic number',
      () => setLogo(boss, entity.code, PNG, 'image/jpeg'), /./);
    await refused(`12. over ${LOGO_MAX_BYTES / 1024 / 1024} MB is refused`,
      () => setLogo(boss, entity.code,
        Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES, 3)]), 'image/png'),
      /the limit is/i);

    /* --- the upload ----------------------------------------------------- */

    const first = await setLogo(boss, entity.code, PNG, 'image/png');
    ok('13. company_admin may upload one, and gets a URL back',
      typeof first.url === 'string' && first.url.length > 0, JSON.stringify(first));

    const doc = (await admin.query(
      `SELECT d.id, d.kind, d.employee_id, d.mime_type, d.size_bytes, d.purged_at
         FROM legal_entity le JOIN document d ON d.id = le.logo_document_id
        WHERE le.id = $1`, [entity.id])).rows[0];
    ok('14. it is a document row with kind=logo', doc?.kind === 'logo', JSON.stringify(doc));
    ok('15.  belonging to the company, not to a person', doc?.employee_id === null);
    ok('16.  with the type taken from the bytes', doc?.mime_type === 'image/png', doc?.mime_type);

    ok('17. every signed-in role may read it, which is the whole point',
      await logoUrl(hr, entity.code) !== null
      && await logoUrl(staff, entity.code) !== null);

    /* --- replacing it --------------------------------------------------- */

    const before = removals;
    await setLogo(boss, entity.code, JPG, 'image/jpeg');
    const after = (await admin.query(
      `SELECT d.id, d.mime_type FROM legal_entity le
         JOIN document d ON d.id = le.logo_document_id WHERE le.id = $1`,
      [entity.id])).rows[0];
    ok('18. a replacement moves the pointer', after?.id !== doc?.id, `${doc?.id} -> ${after?.id}`);
    ok('19.  and the new one is the JPG', after?.mime_type === 'image/jpeg', after?.mime_type);

    const old = (await admin.query(
      'SELECT purged_at FROM document WHERE id = $1', [doc.id])).rows[0];
    ok('20. the one it replaced is purged, not deleted — the trail keeps it',
      old?.purged_at !== null, JSON.stringify(old));
    ok('21.  and its bytes are gone', removals === before + 1, `${removals - before} removals`);

    /* --- removing it ---------------------------------------------------- */

    await removeLogo(boss, entity.code);
    ok('22. removal clears the pointer, so the built-in mark comes back',
      await logoUrl(boss, entity.code) === null);
    const purgedAll = (await admin.query(
      `SELECT count(*)::int n FROM document
        WHERE tenant_id = $1 AND kind = 'logo' AND purged_at IS NULL`, [ctx.tenant])).rows[0].n;
    ok('23.  and leaves no unpurged logo behind', purgedAll === 0, `${purgedAll}`);

    /* --- the signatory -------------------------------------------------- */

    await refused('24. a name without a title is refused',
      () => setSignatory(boss, entity.code, 'Hari Sivakumar', ''), /both a name and a title/i);
    await refused('25.  and a title without a name',
      () => setSignatory(boss, entity.code, '', 'Director'), /both a name and a title/i);

    const set = await setSignatory(boss, entity.code, '  Hari Sivakumar  ', '  Director  ');
    ok('26. the pair is stored, trimmed',
      set?.name === 'Hari Sivakumar' && set?.title === 'Director', JSON.stringify(set));
    ok('27.  and reads back for any signed-in caller, because a letter is read by its subject',
      (await signatoryOf(staff, entity.code))?.name === 'Hari Sivakumar');

    const cleared = await setSignatory(boss, entity.code, '', '');
    ok('28. both empty clears it', cleared === null, JSON.stringify(cleared));
    ok('29.  and it reads back as null, which is what refuses a letter',
      await signatoryOf(boss, entity.code) === null);

    /* --- the audit trail ------------------------------------------------ */

    const trail = (await admin.query(
      `SELECT action, category, subject_table, detail->>'summary' AS summary
         FROM audit_log WHERE tenant_id = $1 AND subject_table = 'legal_entity'
        ORDER BY occurred_at`, [ctx.tenant])).rows;
    const actions = trail.map((r) => r.action);
    ok('30. every write is audited',
      actions.filter((a) => a === 'legal_entity.logo_changed').length === 2
      && actions.includes('legal_entity.logo_removed')
      && actions.filter((a) => a === 'legal_entity.signatory_changed').length === 2,
      JSON.stringify(actions));
    ok('31.  as a config change, against the entity',
      trail.every((r) => r.category === 'config' && r.subject_table === 'legal_entity'));
    ok('32.  and the signatory row names who it was set to, so the trail can be read alone',
      trail.some((r) => (r.summary ?? '').includes('Hari Sivakumar, Director')),
      JSON.stringify(trail.map((r) => r.summary)));
  });
} catch (e) {
  fatal = e;
} finally {
  await admin.end();
}

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a logo is the company's, a signatory is a real person, and only one role sets either${NL}`);
process.exit(0);
