/**
 * The Company Profile tab shows the tenant, and offers one control over it.
 *
 * The tenant's trading name came from `ORG.name` — a client-side constant — so an
 * administrator correcting it changed nothing. It now reads the `tenant` row the
 * whole product runs against and writes the one column migration 0053 opened.
 *
 * The interesting part is the eight fields it does **not** let anyone change.
 * `base_currency` is read by six modules that store amounts assuming it,
 * `fiscal_year_start_month` decides which leave year a quota change reprices, and
 * `data_region` is a residency commitment in a customer contract. 0053 grants
 * UPDATE on `display_name` alone, so those are refused by PostgreSQL — and the
 * screen must not offer a control that would be refused.
 *
 * Four assurances:
 *
 *   1. The display name is read from the service and written through it.
 *   2. `ORG` is not the persistence source. It survives as the demo's single
 *      source for the company's name, which is a different thing: one constant
 *      feeding one demo seed, rather than a screen pretending to save.
 *   3. The protected fields render as values, not as disabled inputs. A greyed-out
 *      box invites someone to hunt for what un-greys it; a labelled value does not
 *      claim to be a control.
 *   4. Only an administrator is offered the rename, and `settings` is in no other
 *      role's permission list, so the tab is unreachable for them anyway.
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
const card = cfg.slice(cfg.indexOf('function TenantProfileCard'),
  cfg.indexOf('function LegalEntityCard'));
const data = code('src/modules/settings/data.ts');
const http = code('src/services/http/index.ts');
const mock = code('src/services/mock/config.ts');
const contracts = code('src/services/contracts.ts');

/* ------------------------------------------------------------------ *
 * 1. the card is backed by the service
 * ------------------------------------------------------------------ */

console.log('\nthe tenant card reads and writes the real tenant\n');

ok('the card exists', card.length > 0, 'TenantProfileCard was not found');
ok('it reads the tenant from the service', card.includes('useTenantProfile()'),
  'the trading name came from a constant until this hook existed');
ok('it writes through the rename mutation', card.includes('useUpdateTenantDisplayName()'));
ok('  and calls it with the draft name',
  /rename\.mutate\(\{ displayName: draft \}\)/.test(card),
  'a Rename button that calls nothing is worse than no button');
ok('the displayed name comes from the tenant', card.includes('tenant.displayName'));
ok('no field is seeded from ORG with defaultValue', !/defaultValue=\{ORG\./.test(card));
ok('and the card does not read ORG at all', !/\bORG\./.test(card),
  'the tenant row is the source now');

ok('the hooks are declared in the settings data layer',
  data.includes('useTenantProfile') && data.includes('useUpdateTenantDisplayName'));
ok('and bound to the real endpoints',
  http.includes("api.get('/config/tenant-profile')")
  && http.includes("api.put('/config/tenant-profile', draft)"));
ok('there is no generic tenant mutation endpoint',
  !/api\.(put|post|patch)\(`?'?\/config\/tenant'/.test(http)
  && (http.match(/\/config\/tenant-profile/g) ?? []).length === 2,
  'one read and one write, and the write carries a single named field');

/* Sliced to its closing brace, not to a guessed character count. */
const draftStart = contracts.indexOf('interface TenantProfileDraft');
const draftShape = contracts.slice(draftStart, contracts.indexOf('}', draftStart) + 1);
ok('TenantProfileDraft carries exactly one field',
  (draftShape.match(/^\s+\w+(\?)?: /gm) ?? []).length === 1,
  draftShape.split('\n').slice(0, 6).join(' | '));
ok('  and that field is displayName', /displayName: string;/.test(draftShape));

/* ------------------------------------------------------------------ *
 * 2. the editable field, and the eight that are not
 * ------------------------------------------------------------------ */

console.log('\none field is editable and eight are shown as values\n');

ok('the company name is an input when editing', /id="tenant-name"/.test(card));
ok('  capped at the service\'s own limit', /maxLength=\{120\}/.test(card),
  'the server refuses over 120, so the field should not invite more');
ok('  and a value when not', /tenant\.displayName\}?\s*$/m.test(card) || card.includes('editing'),
  'the read-only branch is what a non-admin would see');
ok('the draft holds the name while editing', /setDraft\(tenant\.displayName\)/.test(card),
  'opening the form must start from what the server last said');
ok('  and is cleared on cancel and on success',
  (card.match(/setDraft\(null\)/g) ?? []).length >= 2);

for (const label of ['Legal name', 'Slug', 'Status', 'Country', 'Base currency',
  'Fiscal year starts', 'Data region', 'Tenant since']) {
  ok(`${label} is shown`, cfg.includes(`'${label}'`), 'the field is not on the card');
}

ok('the protected fields are rendered through KV, not as inputs',
  /<KV rows=\{\[/.test(card), 'a disabled input still looks like a control');
ok('  and no disabled input stands in for them',
  !/disabled[\s\S]{0,80}tenant\.(slug|status|baseCurrency|dataRegion|homeCountry)/.test(card),
  'a greyed-out box invites someone to hunt for what un-greys it');
ok('  and none of them is bound to an onChange',
  !/onChange[\s\S]{0,120}(baseCurrency|dataRegion|fiscalYearStartMonth|slug|status|homeCountry)/
    .test(card),
  'a control the database refuses is a fake control');
ok('each protected field says who does change it',
  /ask us to move it/.test(cfg) && /set by your agreement/.test(cfg)
  && /change this under the registered entity/.test(cfg),
  'read-only without a route forward is just a dead end');

/* ------------------------------------------------------------------ *
 * 3. loading, failure, success
 * ------------------------------------------------------------------ */

console.log('\nthe outcomes of the read and the write are all said\n');

ok('a loading read is said', /loading && !tenant/.test(card));
ok('a failed read is said rather than rendered as a blank tenant',
  /error && !tenant/.test(card));
ok('a failed save is shown in the card, not only in a toast',
  /\{failure &&/.test(card) && /setFailure\(/.test(card));
ok('a successful save is confirmed', /toast\('Company name saved', 'ok'\)/.test(card));
ok('  and the card re-reads afterwards', /refetch\(\)/.test(card));
ok('saving shows that it is in progress', /busy \? 'Saving…' : 'Save'/.test(card));

/* ------------------------------------------------------------------ *
 * 4. who gets the control
 * ------------------------------------------------------------------ */

console.log('\nonly an administrator is offered the rename\n');

ok('settings is in the admin permission list', PERMS.admin.includes('settings'));
ok('and in no other role\'s', !PERMS.manager.includes('settings')
  && !PERMS.employee.includes('settings'),
  'App.tsx turns that into AccessDenied, so the tab is unreachable for them');
ok('the card derives the role itself', /const admin = app\.role === 'admin'/.test(card),
  'a hidden route is not the same as a withheld control');
ok('and the rename control is gated on it', /actions=\{admin && tenant &&/.test(card));

/* ------------------------------------------------------------------ *
 * 5. the demo, from one source
 * ------------------------------------------------------------------ */

console.log('\nthe demo tenant takes its name from one place\n');

const tenant = await configService.tenantProfile();
ok('the demo display name is ORG.name', tenant.displayName === ORG.name,
  `${tenant.displayName} vs ${ORG.name}`);
ok('the demo legal name is ORG.legal', tenant.legalName === ORG.legal);
ok('  so the company name is not duplicated as a literal',
  /displayName: ORG\.name/.test(mock) && /legalName: ORG\.legal/.test(mock),
  'two literals for one company name is how the ORG problem started');
ok('the demo slug matches what seed.mjs writes', tenant.slug === '360vhm', tenant.slug);
ok('the demo country is IN', tenant.homeCountry === 'IN');
ok('the demo currency is INR', tenant.baseCurrency === 'INR');
ok('the demo fiscal year starts in April', tenant.fiscalYearStartMonth === 4,
  String(tenant.fiscalYearStartMonth));
ok('the demo status is active', tenant.status === 'active');
ok('the demo data region is ap-south-1', tenant.dataRegion === 'ap-south-1');
ok('and created_at is an ISO string', typeof tenant.createdAt === 'string'
  && !Number.isNaN(Date.parse(tenant.createdAt)));

console.log('\nthe demo refuses what the server refuses\n');

ok('an empty name is refused',
  (await refused(() => configService.updateTenantDisplayName({ displayName: '   ' })))
    ?.includes('needs a name') === true);
ok('a name over 120 characters is refused',
  (await refused(() => configService.updateTenantDisplayName({ displayName: 'Z'.repeat(121) })))
    ?.includes('at most 120 characters') === true);

const renamed = await configService.updateTenantDisplayName({ displayName: '  ZZ Demo Co  ' });
ok('a rename trims and takes', renamed.displayName === 'ZZ Demo Co', renamed.displayName);
ok('  and nothing else moved',
  renamed.slug === '360vhm' && renamed.status === 'active'
  && renamed.baseCurrency === 'INR' && renamed.homeCountry === 'IN'
  && renamed.fiscalYearStartMonth === 4 && renamed.dataRegion === 'ap-south-1'
  && renamed.legalName === ORG.legal,
  JSON.stringify(renamed));
ok('  and the change is visible on the next read',
  (await configService.tenantProfile()).displayName === 'ZZ Demo Co');

/* Put it back, so the demo is not left renamed for whatever runs next. */
await configService.updateTenantDisplayName({ displayName: ORG.name });
ok('the demo can be renamed back',
  (await configService.tenantProfile()).displayName === ORG.name);

ok('the demo update touches only the display name',
  /DEMO_TENANT\.displayName = name;/.test(mock)
  && !/DEMO_TENANT\.(slug|status|baseCurrency|dataRegion|homeCountry|legalName) =/.test(mock),
  'nothing in the demo should be able to reach a protected column either');

console.log();
if (failed) {
  console.error(`${failed} tenant profile checks failed`);
  process.exit(1);
}
console.log('the company profile shows the tenant, and offers the one control it may');
