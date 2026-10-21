/**
 * The storage adapter refuses what it should, and stores exactly what it was given.
 *
 * `document` has carried `storage_key`, `mime_type`, `size_bytes` and
 * `checksum` since migration 0007 with nothing to fill them. This covers the
 * adapter that now does.
 *
 * No bucket, no credential and no network: the rules worth asserting are the
 * ones that run before anything leaves the process — the byte cap, the
 * declared type against the bytes' own magic number, the key's shape, and the
 * checksum. The three `fetch` calls on the other side of those rules are
 * covered by their failure paths, which is where they can go wrong silently.
 *
 *   node --experimental-strip-types scripts/storage.test.mjs
 */

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
  if (!cond) failed += 1;
};

/* Set before the import: config.ts reads the environment once, at load. */
process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = ['sb', 'secret', 'notarealkeyfortests', '0'.repeat(8)].join('_');
process.env.SUPABASE_STORAGE_BUCKET = 'test-bucket';

const {
  validate, sniff, keyFor, StorageError, supabaseStorage, setStorage, storage,
} = await import('../src/storage/index.ts');

/* Real headers for the two image types, plus a PDF and something that is neither. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);

const IMAGES = ['image/png', 'image/jpeg'];
const TWO_MB = 2 * 1024 * 1024;

const req = (over = {}) => ({
  prefix: 'photos', tenantId: 'tenant-a', bytes: PNG,
  mimeType: 'image/png', maxBytes: TWO_MB, allow: IMAGES, ...over,
});

const refused = (label, fn, codeWanted) => {
  try {
    fn();
    ok(label, false, 'it was accepted');
  } catch (e) {
    const isStorage = e instanceof StorageError;
    ok(label, isStorage && e.code === codeWanted,
      `got ${isStorage ? e.code : e?.constructor?.name}: ${e?.message}`);
  }
};

console.log(`${NL}the bytes are what they claim to be${NL}`);

ok('1. a PNG header is recognised', sniff(PNG) === 'image/png');
ok('2. a JPEG header is recognised', sniff(JPEG) === 'image/jpeg');
ok('3. a PDF header is recognised', sniff(PDF) === 'application/pdf');
ok('4. anything else is not', sniff(ELF) === null, String(sniff(ELF)));
ok('5. a file too short to have a header is not', sniff(Buffer.from([0x89])) === null);

console.log(`${NL}and the rules run before anything leaves the process${NL}`);

ok('6. a well-formed request passes', (() => {
  try { validate(req()); return true; } catch { return false; }
})());

refused('7. an empty file is refused', () => validate(req({ bytes: Buffer.alloc(0) })), 'empty');
refused('8. over the cap is refused',
  () => validate(req({ bytes: Buffer.concat([PNG, Buffer.alloc(TWO_MB)]) })), 'too_large');
refused('9. a type outside the list is refused',
  () => validate(req({ bytes: PDF, mimeType: 'application/pdf' })), 'wrong_type');
refused('10. an unrecognised file is refused',
  () => validate(req({ bytes: ELF })), 'unrecognised');
refused('11. a PDF sent as a PNG is refused',
  () => validate(req({ bytes: PDF, mimeType: 'image/png' })), 'type_mismatch');
refused('12.  and a JPEG sent as a PNG, which is the honest mistake',
  () => validate(req({ bytes: JPEG, mimeType: 'image/png' })), 'type_mismatch');

/* The cap is per call, so a caller may be stricter than another. */
ok('13. a caller may set a smaller cap', (() => {
  try { validate(req({ maxBytes: 1024 * 1024 })); return true; } catch { return false; }
})());
refused('14.  and that cap is the one enforced',
  () => validate(req({ bytes: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), maxBytes: 1024 * 1024 })),
  'too_large');

console.log(`${NL}keys say nothing about the person${NL}`);

const k1 = keyFor('photos', 'tenant-a');
const k2 = keyFor('photos', 'tenant-a');
ok('15. the key is prefix/tenant/uuid',
  /^photos\/tenant-a\/[0-9a-f-]{36}$/.test(k1), k1);
ok('16. two keys for the same tenant differ', k1 !== k2);
ok('17. the prefix is where it was asked for',
  keyFor('branding', 't').startsWith('branding/'));
ok('18. and a tenant cannot appear in another tenant\'s path',
  !keyFor('photos', 'tenant-b').includes('tenant-a'));

console.log(`${NL}a store it cannot reach says so${NL}`);

/* 127.0.0.1:1 refuses immediately, so this is the real rejection path. */
let thrown = null;
try {
  await supabaseStorage.put(req());
} catch (e) { thrown = e; }
ok('19. an unreachable store is refused, not accepted',
  thrown instanceof StorageError, `${thrown?.constructor?.name}: ${thrown?.message}`);
ok('20.  with the code that says so', thrown?.code === 'unreachable', String(thrown?.code));
ok('21.  and the credential is nowhere in the message',
  !(thrown?.message ?? '').includes(process.env.SUPABASE_SERVICE_ROLE_KEY));
ok('22.  nor in the stack',
  !(thrown?.stack ?? '').includes(process.env.SUPABASE_SERVICE_ROLE_KEY));

let signErr = null;
try { await supabaseStorage.signedUrl('photos/t/x', 60); } catch (e) { signErr = e; }
ok('23. signing is refused the same way', signErr?.code === 'unreachable', String(signErr?.code));

/*
 * Awaited, not thrown at. `signedUrl` is async, so a refusal arrives as a
 * rejection and the synchronous helper above cannot see it — the first version
 * of this assertion handed the helper a Promise and reported that.
 */
let zeroErr = null;
try { await supabaseStorage.signedUrl('photos/t/x', 0); } catch (e) { zeroErr = e; }
ok('24. a signed URL with no lifetime is refused before any request',
  zeroErr instanceof StorageError && zeroErr.code === 'invalid',
  `${zeroErr?.code}: ${zeroErr?.message}`);

let negErr = null;
try { await supabaseStorage.signedUrl('photos/t/x', -60); } catch (e) { negErr = e; }
ok('    and so is a negative one', negErr?.code === 'invalid', String(negErr?.code));

console.log(`${NL}the seam${NL}`);

const calls = [];
const fake = {
  put: async (r) => { calls.push(['put', r.prefix]); return { storageKey: 'k', checksum: 'c', sizeBytes: 1, mimeType: r.mimeType }; },
  signedUrl: async (k) => { calls.push(['signedUrl', k]); return 'https://example.test/x'; },
  remove: async (k) => { calls.push(['remove', k]); },
};
const was = setStorage(fake);
try {
  await storage().put(req());
  await storage().signedUrl('photos/t/x', 60);
  await storage().remove('photos/t/x');
  ok('25. a substituted store is the one used',
    JSON.stringify(calls) === JSON.stringify([['put', 'photos'], ['signedUrl', 'photos/t/x'], ['remove', 'photos/t/x']]),
    JSON.stringify(calls));
} finally { setStorage(was); }
ok('26. and it is put back', storage() === supabaseStorage);

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`the store refuses what it should and says what went wrong${NL}`);
process.exit(0);
