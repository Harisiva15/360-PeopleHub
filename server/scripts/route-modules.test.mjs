/**
 * Every route belongs to a module, and every module is a real one.
 *
 * The gate in app.ts narrows access per tenant by asking `moduleForPath` which
 * module a request belongs to. Two ways that goes wrong, both silent:
 *
 *   a new route whose prefix nobody added to the map. It would answer for
 *   everybody, ignoring the tenant's settings, and the only symptom would be
 *   an administrator saying "I switched that off and it still works";
 *
 *   a mapping to a module name that is not in POLICY. `effectiveRule` returns
 *   `none` for an unknown module, so every request to it would be refused with
 *   a message about the caller's role — for a typo.
 *
 * Both are caught here by reading the routes out of app.ts and the modules out
 * of policy.ts, rather than by anybody remembering.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { POLICY, ROLES, effectiveRule } from '../src/auth/policy.ts';
import { ROUTE_MODULE, UNGATED, moduleForPath } from '../src/http/route-modules.ts';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'http', 'app.ts'), 'utf8');

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/** Every route pattern in source order. */
const patterns = [...source.matchAll(/\bpattern:\s*'([^']+)'/g)].map((m) => m[1]);

console.log('\nroute to module\n');

ok(`${patterns.length} route patterns read out of app.ts`, patterns.length >= 300,
  'Far fewer than expected — the pattern has stopped matching and this is blind.');

/* 1. Every prefix is mapped or explicitly ungated. */
const unmapped = new Set();
for (const p of patterns) {
  const first = p.split('/')[1] ?? '';
  if (!ROUTE_MODULE[first] && !UNGATED.has(p)) unmapped.add(first);
}
ok('every route prefix maps to a module', unmapped.size === 0,
  `Unmapped: ${[...unmapped].join(', ')}\n        `
  + 'Add each to ROUTE_MODULE in src/http/route-modules.ts, or to UNGATED if it '
  + 'acts only on the caller\'s own row.');

/* 2. Every mapped module exists in the policy. */
const bogus = Object.entries(ROUTE_MODULE).filter(([, m]) => !POLICY[m]);
ok('every mapped module is in POLICY', bogus.length === 0,
  bogus.map(([p, m]) => `/${p} -> "${m}" which POLICY does not define`).join('\n        '));

/* 3. The map has no entries for prefixes no route uses. */
const livePrefixes = new Set(patterns.map((p) => p.split('/')[1] ?? ''));
const dead = Object.keys(ROUTE_MODULE).filter((p) => !livePrefixes.has(p));
ok('the map has no entries for routes that do not exist', dead.length === 0,
  `Dead entries: ${dead.join(', ')} — remove them, or the map stops describing the API.`);

/* 4. Same for the exemptions, which are the riskiest lines in the file. */
const deadExempt = [...UNGATED].filter((p) => p !== '/health' && !patterns.includes(p));
ok('every exemption names a route that exists', deadExempt.length === 0,
  `Stale exemptions: ${deadExempt.join(', ')} — an exemption for a path that moved is a `
  + 'hole waiting for a route to be added back at the same address.');

console.log('\nthe exemptions, one at a time\n');

/*
 * Each exemption is a route that bypasses narrowing entirely, so each is
 * listed rather than counted. Anybody reviewing this file should be able to
 * read the list and agree with it.
 */
for (const p of [...UNGATED].sort()) {
  ok(`${p} is ungated`, moduleForPath(p) === null);
}
ok('nothing under /users/:id is ungated',
  ![...UNGATED].some((p) => /^\/users\/[^m]/.test(p)),
  'An exemption matching another account would skip narrowing on somebody else\'s data.');

console.log('\nthe gate refuses what it should\n');

/*
 * A path with a prefix in neither list must be refused, not waved through.
 * This is the state the check above prevents, and it must still fail closed
 * if it ever occurs.
 */
ok('an unrecognised path maps to "unmapped"', moduleForPath('/nonesuch/thing') === 'unmapped');
for (const role of ROLES) {
  ok(`${role} is refused an unmapped module`,
    effectiveRule(role, 'unmapped', {}).read === 'none',
    'An unrecognised path would be served without any authorisation check.');
}

/*
 * And the whole point: a narrowed module refuses, while the same role on the
 * same route without narrowing does not.
 */
const sample = Object.keys(ROUTE_MODULE).find((p) => POLICY[ROUTE_MODULE[p]]?.admin.read !== 'none');
const mod = ROUTE_MODULE[sample];
ok(`admin reaches "${mod}" with no overrides`,
  effectiveRule('admin', mod, {}).read !== 'none');
ok(`admin is refused "${mod}" once the tenant narrows it to none`,
  effectiveRule('admin', mod, { [mod]: { admin: { read: 'none' } } }).read === 'none',
  'Narrowing would remove the menu entry and leave the routes answering.');

console.log(`\n${failed ? `${failed} FAILED` : 'every route is accounted for'}\n`);
process.exit(failed ? 1 : 0);
