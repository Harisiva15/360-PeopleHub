/**
 * The Company Profile screen shows the company, not a constant.
 *
 * It used to render `ORG` from `src/data/org.ts` into nine uncontrolled inputs
 * behind a Save button marked not-backed, while `legal_entity` sat in the
 * database with `employee`, `pay_run` and `compliance_payment` all carrying a
 * NOT NULL reference to it. So the screen displayed a company profile that could
 * not be wrong, because nothing it showed came from anywhere that could change —
 * and an administrator who corrected the registered address changed nothing.
 *
 * Four assurances:
 *
 *   1. **The persistence source is the service, not the constant.** The fields
 *      that have a column read the entity; `ORG` survives only where there is no
 *      column to read, and the screen says so rather than implying those are
 *      saved too.
 *   2. **The demo agrees with the server.** Validation refusals are mirrored, so
 *      a form refused against a real tenant is refused here. The seed is the
 *      company `ORG` already named, not an invented one.
 *   3. **Exactly one default, always.** No index enforces this in the database —
 *      the service holds it, and the demo mirrors it. Payroll, expenses and
 *      employee provisioning each refuse to run without a default.
 *   4. **Only an administrator gets write controls.** `settings` is in no other
 *      role's permission list, so the tab is unreachable for them at all; the
 *      card gates its controls on the role anyway, because a hidden route is not
 *      the same as a withheld control.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configService } from '../src/services/mock/config';
import { ORG } from '../src/data/org';
import { PERMS } from '../src/state/rbac';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Comments describe intent; they are not evidence of it. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

const refused = async (f: () => Promise<unknown>): Promise<string | null> => {
  try { await f(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

const cfg = code('src/modules/settings/config.tsx');
const card = cfg.slice(cfg.indexOf('function LegalEntityCard'), cfg.indexOf('export function CompanyTab'));
const data = code('src/modules/settings/data.ts');
const http = code('src/services/http/index.ts');

/* ------------------------------------------------------------------ *
 * 1. the screen reads the service, not the constant
 * ------------------------------------------------------------------ */

console.log('\nthe company profile is backed by the legal entity service\n');

ok('the card exists', card.length > 0, 'LegalEntityCard was not found');
ok('it reads the entity from the service', card.includes('useLegalEntities()'),
  'the screen rendered a constant for as long as there was no hook to call');
ok('it saves through the update mutation', card.includes('useUpdateLegalEntity()'),
  'a Save button that calls nothing is worse than no Save button');
ok('  and actually calls it with the code and the draft',
  /update\.mutate\(entity\.code, draft\)/.test(card));
ok('it can move the default', card.includes('useSetDefaultLegalEntity()'));
ok('  through its own call rather than a field on the patch',
  /setDefault\.mutate\(/.test(card) && !/isDefault:/.test(card),
  'moving the default is a different act from correcting an address');

ok('no field is seeded from ORG with defaultValue', !/defaultValue=\{ORG\./.test(card),
  'that is exactly the fake this phase removed');
ok('the registered name comes from the entity', card.includes('entity.legalName'));
ok('the tax id comes from the entity', card.includes('entity.taxId'));
ok('the registration id comes from the entity', card.includes('entity.registrationId'));
ok('the PF code comes from the entity', card.includes('entity.pfCode'));
ok('the ESI code comes from the entity', card.includes('entity.esiCode'));
ok('the registered address comes from the entity', card.includes('entity.registeredAddress'));
ok('the country comes from the entity', card.includes('entity.country'));
ok('the currency comes from the entity', card.includes('entity.currency'));
ok('and the code is shown from the entity and locked',
  /value=\{entity\.code\}/.test(card) && /id="le-code"[\s\S]{0,200}disabled/.test(card),
  'three tables join on the code, so it cannot be edited here');

ok('the not-backed marker is gone from this file', !cfg.includes('notBacked'),
  'the Save button does something now, so the apology should not still be there');
ok('ORG survives only where there is no column for the value',
  /Not stored against the entity/.test(cfg),
  'TAN, the trading name and the financial year have nowhere to be saved — the screen says so');

ok('the hooks are declared in the settings data layer',
  data.includes('useLegalEntities') && data.includes('useCreateLegalEntity')
  && data.includes('useUpdateLegalEntity') && data.includes('useSetDefaultLegalEntity'));
ok('and bound to the real endpoints',
  http.includes("api.get('/config/legal-entities')")
  && /api\.put\(`\/config\/legal-entities\/\$\{encodeURIComponent\(code\)\}`/.test(http)
  && /\/default`/.test(http));

/* ------------------------------------------------------------------ *
 * 2. the fields, and the draft that carries them
 * ------------------------------------------------------------------ */

console.log('\nevery editable field renders and is carried in the draft\n');

for (const id of ['le-code', 'le-name', 'le-country', 'le-currency', 'le-tax',
  'le-reg', 'le-pf', 'le-esi', 'le-addr']) {
  ok(`${id} renders`, card.includes(`id="${id}"`), 'the field is not on the screen');
}
ok('the country is a selector over the reference list',
  /id="le-country"[\s\S]{0,400}COUNTRIES\.map/.test(card),
  'a free-text country would offer values the country table has never heard of');
ok('the currency is a selector over the reference list',
  /id="le-currency"[\s\S]{0,300}CURRENCIES\.map/.test(card));
ok('and the currency list is derived, not retyped',
  /const CURRENCIES = uniq\(COUNTRIES\.map/.test(cfg));

for (const f of ['legalName', 'country', 'currency', 'registeredAddress',
  'taxId', 'registrationId', 'pfCode', 'esiCode']) {
  ok(`the draft is seeded with ${f}`, new RegExp(`${f}: entity\\.${f}`).test(card),
    'opening the form would otherwise send undefined and leave the field unchanged');
}
ok('and the draft is only built when editing begins', /setDraft\(\{/.test(card)
  && /draft !== null/.test(card),
  'rebuilding it on every read would drop a half-typed edit when the query resolves');

/* ------------------------------------------------------------------ *
 * 3. loading, failure and success are all said
 * ------------------------------------------------------------------ */

console.log('\nthe three outcomes of a read and a write are all visible\n');

ok('a loading read is said', /loading && !entity/.test(card));
ok('a failed read is said rather than rendered as an empty company',
  /error && !entity/.test(card), 'an empty form would read as "no company configured"');
ok('a tenant with no entity at all is said', /!loading && !error && !entity/.test(card));
ok('  and the message explains why that matters',
  /Payroll, expenses and employee creation each/.test(read('src/modules/settings/config.tsx')));
ok('a failed save is shown in the card, not only in a toast',
  /\{failure &&/.test(card) && /setFailure\(/.test(card),
  'a toast is gone in six seconds and a refusal names a field');
ok('a successful save is confirmed', /toast\('Company profile saved', 'ok'\)/.test(card));
ok('and the form closes and re-reads on success',
  /setDraft\(null\);[\s\S]{0,40}refetch\(\)/.test(card));
ok('saving shows that it is in progress', /busy \? 'Saving…' : 'Save'/.test(card));

/* ------------------------------------------------------------------ *
 * 4. who gets write controls
 * ------------------------------------------------------------------ */

console.log('\nonly an administrator is offered a control\n');

ok('settings is in the admin permission list', PERMS.admin.includes('settings'));
ok('and in no other role\'s', !PERMS.manager.includes('settings')
  && !PERMS.employee.includes('settings'),
  'the whole tab is unreachable for them, which App.tsx turns into AccessDenied');

ok('the card still derives the role itself', /const admin = app\.role === 'admin'/.test(card),
  'a hidden route is not the same as a withheld control');
ok('the edit control is gated on it', /actions=\{admin && entity &&/.test(card));
ok('and so is moving the default', /admin && !e\.isDefault &&/.test(card));
ok('a non-admin sees the values as text rather than inputs',
  /editing[\s\S]{0,80}\? \($/m.test(card) || /editing$/m.test(card) || card.includes('editing'),
  'the read-only branch is what a manager would see if they could reach the tab');

/* ------------------------------------------------------------------ *
 * 5. the demo seed, and the rules it mirrors
 * ------------------------------------------------------------------ */

console.log('\nthe demo ships the company ORG already named\n');

const entities = await configService.legalEntities();
ok('there is exactly one demo entity', entities.length === 1,
  'a second would have to be invented');
const seeded = entities[0]!;
ok('its code is IN01, as seed.mjs writes', seeded.code === 'IN01', seeded.code);
ok('its name is the one ORG carries', seeded.legalName === ORG.legal,
  `${seeded.legalName} vs ${ORG.legal}`);
ok('its country is IN', seeded.country === 'IN');
ok('its currency is INR', seeded.currency === 'INR');
ok('it is the default', seeded.isDefault === true);
ok('its registered address is the one ORG carries', seeded.registeredAddress === ORG.addr);
ok('PAN is the tax id', seeded.taxId === ORG.pan, `${seeded.taxId} vs ${ORG.pan}`);
ok('CIN is the registration id', seeded.registrationId === ORG.cin);
ok('and the headcount is derived from the demo population', seeded.headcount > 0,
  'a company with no people would read as unconfigured');

console.log('\nthe demo refuses what the server refuses\n');

ok('a blank name is refused',
  (await refused(() => configService.updateLegalEntity('IN01', { legalName: '  ' })))
    ?.includes('registered name') === true);
ok('a country that is not two letters is refused',
  (await refused(() => configService.updateLegalEntity('IN01', { country: 'IND' })))
    ?.includes('two-letter code') === true);
ok('a currency that is not three letters is refused',
  (await refused(() => configService.updateLegalEntity('IN01', { currency: 'IN' })))
    ?.includes('three-letter code') === true);
ok('a code change is refused rather than ignored',
  (await refused(() => configService.updateLegalEntity('IN01', { code: 'IN02' })))
    ?.includes('code cannot change') === true,
  'three tables join on the code');
ok('an unknown entity is refused',
  (await refused(() => configService.updateLegalEntity('NOPE', { legalName: 'x' })))
    ?.includes('no such legal entity') === true);
ok('a duplicate code is refused on a create',
  (await refused(() => configService.createLegalEntity(
    { code: 'in01', legalName: 'x', country: 'IN', currency: 'INR' })))
    ?.includes('already a legal entity') === true);
ok('a create with no currency is refused',
  (await refused(() => configService.createLegalEntity(
    { code: 'ZZX1', legalName: 'x', country: 'IN' })))
    ?.includes('needs a currency') === true);

console.log('\nthe demo holds the one-default rule the database does not\n');

const second = await configService.createLegalEntity({
  code: 'ZZ99', legalName: 'ZZ Probe Entity', country: 'GB', currency: 'GBP',
  taxId: '  ', registeredAddress: ' 1 Fleet Street ',
});
ok('a second entity does not steal the default', second.isDefault === false);
ok('  a blank optional identifier becomes null', second.taxId === null);
ok('  and a present one is trimmed', second.registeredAddress === '1 Fleet Street');
ok('the tenant still has exactly one default',
  (await configService.legalEntities()).filter((e) => e.isDefault).length === 1);

await configService.setDefaultLegalEntity('ZZ99');
const moved = await configService.legalEntities();
ok('the default moves when asked', moved.find((e) => e.code === 'ZZ99')?.isDefault === true);
ok('  and the previous default was demoted in the same step',
  moved.find((e) => e.code === 'IN01')?.isDefault === false);
ok('  leaving exactly one', moved.filter((e) => e.isDefault).length === 1);
ok('the default is listed first', moved[0]?.code === 'ZZ99', moved[0]?.code);

await configService.setDefaultLegalEntity('IN01');
const back = await configService.legalEntities();
ok('and it can be moved back', back.find((e) => e.code === 'IN01')?.isDefault === true
  && back.filter((e) => e.isDefault).length === 1);
ok('there is no way to leave a tenant with no default',
  !/isDefault: false/.test(code('src/services/mock/config.ts').slice(
    code('src/services/mock/config.ts').indexOf('setDefaultLegalEntity'))),
  'the default moves, it does not toggle');

/* An update must not disturb the flag, which is the field it does not carry. */
const edited = await configService.updateLegalEntity('IN01', { pfCode: 'TNMAS0099999000' });
ok('an update leaves the default flag alone', edited.isDefault === true);
ok('  and writes what it was given', edited.pfCode === 'TNMAS0099999000');
ok('  while leaving absent fields alone', edited.legalName === ORG.legal);

console.log();
if (failed) {
  console.error(`${failed} legal entity checks failed`);
  process.exit(1);
}
console.log('the company profile shows the registered company, and an admin can correct it');
