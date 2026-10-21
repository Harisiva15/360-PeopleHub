/**
 * Whose photo is whose, and what the server refuses.
 *
 * The permissions are the approved matrix rather than a choice made in the
 * service: your own photo goes through `account`, which every role holds as
 * `own`, and somebody else's through `employees` **write**, which is hr_admin
 * and company_admin. So finance_admin and a manager can see a photo and not
 * replace one, and that asymmetry is the thing most worth asserting — it is
 * the one a reasonable person would get wrong.
 *
 *   node --import=tsx/esm scripts/photo.test.mjs
 */

import pg from 'pg';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

const { assertLocalDatabase } = await import('./local-only.mjs');
const url = process.env.MIGRATE_DATABASE_URL;
if (!url || !process.env.DATABASE_URL) {
  console.log('SKIPPED: set MIGRATE_DATABASE_URL and DATABASE_URL to a local database.');
  process.exit(0);
}
/*
 * Both URLs, not just the one this file connects with. The admin client below
 * uses MIGRATE_DATABASE_URL, but every write under test goes through the
 * service, which uses the pool on DATABASE_URL — so checking only the first
 * would let a suite that writes real rows run against production while
 * reporting itself local. `assertLocalDatabase` with no arguments covers both
 * and exits; `hostOf` alone, which this used to call, only parses a host and
 * returns it.
 */
assertLocalDatabase();

/*
 * The store is substituted further down, so this suite needs no Supabase
 * credential — but `src/config.ts` validates the environment the moment it is
 * imported, and the photos service imports it transitively. These stand in for
 * the two it requires.
 *
 * They are addresses nothing is listening on, deliberately. If a later edit
 * ever bypasses the fake store, the request goes to 127.0.0.1:1 and fails
 * loudly instead of quietly reaching a real project, and the key is assembled
 * at runtime so the repository carries no string shaped like a secret.
 */
process.env.SUPABASE_URL ??= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= ['sb', 'secret', 'notarealkeyfortests', '0'.repeat(8)].join('_');
process.env.SUPABASE_STORAGE_BUCKET ??= 'test-bucket';

const { withScratchTenant } = await import('./lib/scratch-tenant.mjs');
const { setStorage, StorageError } = await import('../src/storage/index.ts');
const { setPhoto, photoUrl, removePhoto, PhotoError, PHOTO_MAX_BYTES } =
  await import('../src/modules/photos/service.ts');

const admin = new pg.Client({ connectionString: url });
await admin.connect();

/* Real headers, so the magic-number check sees what it expects. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/* A store that records rather than reaches the network. */
const made = [];
const removed = [];
const fakeStore = {
  put: async (req) => {
    /* The real adapter's rules still have to run, so call its validator. */
    const { validate } = await import('../src/storage/index.ts');
    validate(req);
    const key = `${req.prefix}/${req.tenantId}/key-${made.length + 1}`;
    made.push(key);
    return { storageKey: key, checksum: `sum-${made.length}`, sizeBytes: req.bytes.length, mimeType: req.mimeType };
  },
  signedUrl: async (k) => `https://signed.test/${k}`,
  remove: async (k) => { removed.push(k); },
};

const refused = async (label, fn, rx) => {
  try {
    await fn();
    ok(label, false, 'it was allowed');
  } catch (e) {
    ok(label, rx.test(e?.message ?? ''), `${e?.constructor?.name}: ${e?.message}`);
  }
};

const was = setStorage(fakeStore);
let fatal = null;
try {
  await withScratchTenant(admin, async (ctx) => {
    const t = { tenantId: ctx.tenant, userId: null };
    const ADMIN_C = { ...t, role: 'company_admin', hasReports: false, employeeId: ctx.adminEmployeeId };
    const HR = { ...t, role: 'hr_admin', hasReports: false, employeeId: ctx.adminEmployeeId };
    const FIN = { ...t, role: 'finance_admin', hasReports: false, employeeId: ctx.adminEmployeeId };
    const MGR = { ...t, role: 'employee', hasReports: true, employeeId: ctx.adminEmployeeId };

    /* Two other people to be the subject, so "somebody else" is real. */
    const other = async (code) => (await admin.query(
      `INSERT INTO employee
         (tenant_id, code, full_name, work_email, status, app_role,
          department_id, site_id, legal_entity_id, shift_id, joined_on, currency)
       SELECT $1, $2, $3, $4, 'active', 'employee',
              e.department_id, e.site_id, e.legal_entity_id, e.shift_id,
              DATE '2021-01-01', 'INR'
         FROM employee e WHERE e.id = $5
       RETURNING id`,
      [ctx.tenant, code, `ZZ ${code}`, `zz-${code}@360.technology`, ctx.adminEmployeeId])).rows[0].id;

    const A = await other('ZZPH1');
    const B = await other('ZZPH2');
    const SELF_A = { ...t, role: 'employee', hasReports: false, employeeId: A };

    console.log(`${NL}nobody has a photo to begin with${NL}`);
    ok('1. no photo reads as null, not an error', await photoUrl(ADMIN_C, A) === null);

    console.log(`${NL}your own is yours${NL}`);
    const mine = await setPhoto(SELF_A, A, PNG, 'image/png');
    ok('2. an employee may set their own', mine.url.startsWith('https://signed.test/'), mine.url);
    ok('3.  and it is stored under the photos prefix',
      made[0]?.startsWith(`photos/${ctx.tenant}/`), made[0]);
    ok('4.  and reading it back gives a URL', Boolean(await photoUrl(SELF_A, A)));

    const row = (await admin.query(
      `SELECT d.kind, d.mime_type, d.size_bytes, d.checksum, d.purged_at,
              (e.photo_document_id = d.id) AS is_current
         FROM employee e JOIN document d ON d.id = e.photo_document_id
        WHERE e.id = $1`, [A])).rows[0];
    ok('5. the document row records what was stored',
      row?.kind === 'photo' && row?.mime_type === 'image/png'
      && Number(row?.size_bytes) === PNG.length && row?.checksum === 'sum-1',
      JSON.stringify(row));
    ok('6.  and the employee points at it', row?.is_current === true);

    console.log(`${NL}somebody else's needs employees write${NL}`);
    await refused('7. employee A cannot write B',
      () => setPhoto(SELF_A, B, PNG, 'image/png'), /administrator/i);
    await refused('8. a manager cannot either',
      () => setPhoto(MGR, B, PNG, 'image/png'), /administrator/i);
    await refused('9. nor can finance_admin',
      () => setPhoto(FIN, B, PNG, 'image/png'), /administrator/i);

    const byHr = await setPhoto(HR, B, JPEG, 'image/jpeg');
    ok('10. hr_admin can', byHr.url.includes('photos/'), byHr.url);
    const byAdmin = await setPhoto(ADMIN_C, B, PNG, 'image/png');
    ok('11. and company_admin can', byAdmin.url.includes('photos/'), byAdmin.url);

    console.log(`${NL}replacing purges the one before it${NL}`);
    const bRows = (await admin.query(
      `SELECT d.id, d.purged_at IS NOT NULL AS purged,
              (e.photo_document_id = d.id) AS is_current
         FROM document d JOIN employee e ON e.id = d.employee_id
        WHERE d.employee_id = $1 AND d.kind = 'photo'
        ORDER BY d.uploaded_at`, [B])).rows;
    ok('12. both uploads left a row', bRows.length === 2, String(bRows.length));
    ok('13.  the first is purged', bRows[0]?.purged === true);
    ok('14.  the second is current', bRows[1]?.is_current === true && bRows[1]?.purged === false);
    ok('15.  and the replaced bytes were deleted from the store',
      removed.length === 1, removed.join(', '));

    console.log(`${NL}the file itself${NL}`);
    await refused('16. a PDF sent as a PNG is refused',
      () => setPhoto(ADMIN_C, A, PDF, 'image/png'), /contents are application\/pdf/);
    await refused('17. a PDF declared honestly is still not a photo',
      () => setPhoto(ADMIN_C, A, PDF, 'application/pdf'), /not accepted here/);
    await refused('18. over the byte cap is refused',
      () => setPhoto(ADMIN_C, A, Buffer.concat([PNG, Buffer.alloc(PHOTO_MAX_BYTES)]), 'image/png'),
      /limit is/);

    console.log(`${NL}removing${NL}`);
    await refused('19. somebody else cannot remove yours',
      () => removePhoto(SELF_A, B), /administrator/i);
    await removePhoto(SELF_A, A);
    ok('20. you may remove your own', await photoUrl(SELF_A, A) === null);
    const aRow = (await admin.query(
      'SELECT photo_document_id FROM employee WHERE id = $1', [A])).rows[0];
    ok('21.  the pointer is cleared', aRow?.photo_document_id === null);
    const aDocs = (await admin.query(
      "SELECT purged_at IS NOT NULL AS purged FROM document WHERE employee_id = $1 AND kind = 'photo'",
      [A])).rows;
    ok('22.  and every photo document is purged',
      aDocs.length > 0 && aDocs.every((d) => d.purged === true),
      JSON.stringify(aDocs));
    await removePhoto(SELF_A, A);
    ok('23. removing one that is not there is not an error', true);

    console.log(`${NL}a purged document is not signed${NL}`);
    await setPhoto(ADMIN_C, A, PNG, 'image/png');
    await admin.query(
      `UPDATE document SET purged_at = now()
        WHERE id = (SELECT photo_document_id FROM employee WHERE id = $1)`, [A]);
    ok('24. a pointer at purged bytes reads as no photo',
      await photoUrl(ADMIN_C, A) === null,
      'signing a purged key would render a broken image');
  });
} catch (e) {
  fatal = e;
} finally {
  setStorage(was);
  await admin.end();
}

if (fatal) { console.error(`${NL}the run did not finish: ${fatal.message}${NL}`); process.exit(1); }
console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`a photo is yours, or an administrator's to change, and never a PDF${NL}`);
process.exit(0);
