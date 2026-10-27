/**
 * The photo and the logo reach the screens that are supposed to show them.
 *
 * ## What went wrong, twice, in the same shape
 *
 * Both features were built end to end and then not connected, and both failed
 * silently — which is why this is a check and not a note.
 *
 * **The photo.** `ProfilePhoto` — the only control in the product that can
 * upload one — is rendered on the account screen alone. The top bar's "My
 * profile" linked to `/employees`, the directory, where your own record draws
 * initials and offers nothing. So somebody following that menu item to set
 * their photo reached a dead end with no error to report: the server had
 * never been asked, because nothing on that screen could ask it. The database
 * agreed — no document row, no pointer, no audit row.
 *
 * And even once a photo exists, only the top bar passed a URL to `Avatar`.
 * The profile drawer drew initials for everybody regardless.
 *
 * **The logo.** Upload, replace, remove and the permissions were all built
 * and `useLogoUrl` had exactly one consumer: the Company Profile card that
 * uploads it. The sidebar went on drawing the built-in mark, so an uploaded
 * logo sat in storage and appeared nowhere.
 *
 * The common fault is that a feature can be complete and unreachable, and
 * nothing fails. Each assertion below names the place a thing is consumed,
 * not the place it is defined.
 */

import { readFileSync } from 'node:fs';
import { NAV } from '../src/nav';

const NL = String.fromCharCode(10);
let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !detail ? '' : `   ${detail}`}`);
};

const read = (p: string) => readFileSync(p, 'utf8');

const topbar = read('src/shell/TopBar.tsx');
const shell = read('src/shell/Shell.tsx');
const account = read('src/modules/account/index.tsx');
const profile = read('src/modules/employees/Profile.tsx');
const photoCard = read('src/modules/account/ProfilePhoto.tsx');
const contracts = read('src/services/contracts.ts');
const http = read('src/services/http/index.ts');
const mock = read('src/services/mock/config.ts');

console.log(`${NL}the photo can be reached by somebody looking for it${NL}`);

/*
 * The menu item and the screen that holds the control have to agree. Asserted
 * as a pair rather than on the href alone: moving the control would otherwise
 * leave this passing while the dead end came back.
 */
ok('1. "My profile" in the top bar opens the account screen',
  /<Link to="\/account"[\s\S]{0,200}My profile/.test(topbar),
  'it linked to /employees, where nothing can change a photo');

ok('2.  which is the screen that renders the upload control',
  /<ProfilePhoto\b/.test(account),
  'ProfilePhoto is rendered nowhere the menu leads');

ok('3. and the account menu entry mentions the photo',
  NAV.flatMap((g) => g.items).some(
    (i) => i.k === 'account' && /photo/i.test(i.d ?? '')),
  'its description said "sign-in details", so nobody looked there');

console.log(`${NL}a photo that exists is shown wherever the person is${NL}`);

ok('4. the profile drawer passes a photo URL to Avatar',
  /<Avatar[^>]*\bsrc=\{photo\./.test(profile),
  'it drew initials for everybody, photo or not');

ok('5.  from usePhotoUrl, which resolves to null when there is none',
  /usePhotoUrl\(/.test(profile));

/*
 * The list is deliberately excluded: a page of photos needs a bulk signing
 * endpoint that does not exist, so initials there are a decision rather than
 * an oversight. Asserted so nobody "fixes" it into N round trips.
 */
ok('6. the directory list still uses initials, on purpose',
  !/<Avatar[^>]*src=\{[^}]*\bphotoOf\b/.test(profile),
  'a list of photos would need one signed URL per row');

console.log(`${NL}an uploaded logo is drawn, and the built-in one is the fallback${NL}`);

ok('7. the shell asks for the tenant logo',
  /useTenantLogo\(\)/.test(shell),
  'the upload had no consumer outside the card that uploads it');

ok('8.  prefers it when there is one',
  /\{tenantLogo[\s\S]{0,120}<img src=\{tenantLogo\}/.test(shell));

ok('9.  and falls back to the built-in mark otherwise',
  /LOGO_ON_RAIL/.test(shell),
  'a tenant with no logo must still have a mark');

ok('10.  on a plate, because there is no reversed variant for an upload',
  /brand-plate/.test(shell) && /brand-plate/.test(read('src/styles/global.css')),
  'dark artwork on the navy rail is the known consequence of one upload');

ok('11. the default entity has its own read, since the shell has no code',
  /tenantLogoUrl/.test(contracts) && /tenantLogoUrl/.test(http) && /tenantLogoUrl/.test(mock),
  'declared, served and demoed — a contract method missing one of the three '
  + 'is a method that works in one build');

console.log(`${NL}a refused photo says what was wrong with it${NL}`);

ok('12. the refusal names the file\'s own type',
  /chosen\.type \|\|/.test(photoCard),
  '"that has to be a PNG or a JPEG" does not help somebody holding a HEIC');

ok('13.  and says how to get one, rather than only what is wrong',
  /Most Compatible|export the picture/i.test(photoCard));

console.log('');
if (failed) { console.error(`${failed} FAILED${NL}`); process.exit(1); }
console.log(`the photo and the logo reach the screens that show them${NL}`);
process.exit(0);
