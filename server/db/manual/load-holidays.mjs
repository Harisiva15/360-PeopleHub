/**
 * Load a holiday calendar, per location, in one transaction.
 *
 *   node db/manual/load-holidays.mjs <holidays.json>
 *   node db/manual/load-holidays.mjs <holidays.json> --production --confirm-host=<host>
 *
 * The input is a JSON array of `{ d, n, site }` — an ISO date, a name, and a
 * site **code** or null for every location. Producing that file is a separate
 * job on purpose: a spreadsheet's shape is somebody else's decision and should
 * not be baked into the thing that writes rows.
 *
 * ## What it refuses
 *
 * Local by default, and `--production` without a matching `--confirm-host` is
 * refused, the way scripts/migrate.mjs does it. It also refuses to run twice:
 * if any of the sites it is about to load already holds a holiday in the date
 * range of the file, it stops and names them rather than inserting beside
 * them. `holiday_one_per_day` would catch an exact collision, but a *partial*
 * second load — a corrected file with three dates moved — would succeed on the
 * three and leave the old ones in place, which is the shape of mess nobody
 * finds until an employee asks why a Tuesday was a holiday.
 *
 * ## What it asserts before committing
 *
 * The per-site counts it expected from the file against what the table now
 * holds, inside the transaction, and the whole thing rolls back on a
 * mismatch. A load that silently puts 40 of 42 rows somewhere is worse than
 * one that fails.
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { assertLocalDatabase, hostOf } from '../../scripts/local-only.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('-'));
const PRODUCTION = args.includes('--production');
const claimed = args.find((a) => a.startsWith('--confirm-host='))?.split('=')[1];

if (!file) {
  console.error('usage: node db/manual/load-holidays.mjs <holidays.json> [--production --confirm-host=<host>]');
  process.exit(2);
}

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('  set MIGRATE_DATABASE_URL'); process.exit(2); }

if (PRODUCTION) {
  const host = hostOf(url);
  if (claimed !== host) {
    console.error('');
    console.error(`  REFUSED: --confirm-host says ${claimed ?? '(nothing)'}, but the target is ${host}.`);
    console.error('');
    process.exit(1);
  }
  console.error(`  writing to ${host}, confirmed by --confirm-host`);
} else {
  assertLocalDatabase();
}

const rows = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(rows) || !rows.length) { console.error('  the file holds no rows'); process.exit(2); }

/* What the file says each site should end up with. */
const expected = {};
for (const r of rows) expected[r.site ?? '(all locations)'] = (expected[r.site ?? '(all locations)'] ?? 0) + 1;
const dates = rows.map((r) => r.d).sort();
const [first, last] = [dates[0], dates[dates.length - 1]];

console.log('');
console.log(`  file        : ${file}`);
console.log(`  rows        : ${rows.length}`);
console.log(`  date range  : ${first} .. ${last}`);
console.log(`  per site    : ${Object.entries(expected).map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log('');

const db = new pg.Client({
  connectionString: url,
  ssl: PRODUCTION ? { rejectUnauthorized: false } : false,
});
await db.connect();

let committed = false;
try {
  const tenants = (await db.query('SELECT id, slug FROM tenant ORDER BY slug')).rows;
  if (tenants.length !== 1) {
    throw new Error(`expected exactly one tenant, found ${tenants.length}: ${tenants.map((t) => t.slug).join(', ')}`);
  }
  const tenant = tenants[0];
  console.log(`  tenant      : ${tenant.slug}`);

  const sites = new Map((await db.query(
    'SELECT code, id FROM site WHERE tenant_id = $1', [tenant.id])).rows.map((r) => [r.code, r.id]));
  const unknown = [...new Set(rows.map((r) => r.site).filter(Boolean))].filter((c) => !sites.has(c));
  if (unknown.length) throw new Error(`the file names sites this tenant does not have: ${unknown.join(', ')}`);

  await db.query('BEGIN');

  /* Refuses a second, partial load. See the header. */
  const occupied = (await db.query(
    `SELECT coalesce(s.code, '(all locations)') AS site, count(*)::int AS n
       FROM holiday h LEFT JOIN site s ON s.id = h.site_id
      WHERE h.tenant_id = $1 AND h.observed_on BETWEEN $2 AND $3
      GROUP BY 1 ORDER BY 1`, [tenant.id, first, last])).rows;
  if (occupied.length) {
    throw new Error('this range already holds holidays: '
      + occupied.map((r) => `${r.site}=${r.n}`).join('  ')
      + ' — clear them first, or load a file for a different range');
  }

  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await db.query(
      `INSERT INTO holiday (tenant_id, observed_on, name, optional, site_id)
       VALUES ($1, $2, $3, false, $4)`,
      [tenant.id, r.d, r.n, r.site ? sites.get(r.site) : null]);
  }

  const after = (await db.query(
    `SELECT coalesce(s.code, '(all locations)') AS site, count(*)::int AS n
       FROM holiday h LEFT JOIN site s ON s.id = h.site_id
      WHERE h.tenant_id = $1 AND h.observed_on BETWEEN $2 AND $3
      GROUP BY 1 ORDER BY 1`, [tenant.id, first, last])).rows;

  console.log('');
  console.log('  per-site counts, asserted before commit:');
  let bad = 0;
  for (const [site, want] of Object.entries(expected).sort()) {
    const got = after.find((r) => r.site === site)?.n ?? 0;
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${site.padEnd(16)} expected ${want}, found ${got}`);
  }
  const extra = after.filter((r) => !(r.site in expected));
  for (const r of extra) { bad += 1; console.log(`    FAIL  ${r.site} holds ${r.n} rows the file never mentioned`); }
  if (bad) throw new Error(`${bad} site(s) did not match the file — rolling back`);

  await db.query('COMMIT');
  committed = true;
  console.log('');
  console.log(`  COMMITTED ${rows.length} holidays`);
} catch (e) {
  if (!committed) { try { await db.query('ROLLBACK'); } catch { /* nothing open */ } }
  console.error('');
  console.error(`  REFUSED / ROLLED BACK: ${e.message}`);
  console.error('');
  await db.end();
  process.exit(1);
}

/* Read back what is actually there, which is the only report worth having. */
const back = (await db.query(
  `SELECT coalesce(s.code, 'ALL') AS site,
          count(*)::int AS n,
          min(h.observed_on)::text AS first,
          max(h.observed_on)::text AS last
     FROM holiday h LEFT JOIN site s ON s.id = h.site_id
    WHERE h.tenant_id = (SELECT id FROM tenant LIMIT 1)
    GROUP BY 1 ORDER BY 1`)).rows;
console.log('');
console.log('  read back from the table:');
for (const r of back) console.log(`    ${r.site.padEnd(8)} ${String(r.n).padStart(4)}   ${r.first} .. ${r.last}`);
console.log('');
await db.end();
