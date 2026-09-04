/**
 * Proves the tenant isolation actually holds, against the real database.
 *
 * Everything else in this repo checks the schema as *text*: the parser
 * confirms it is valid SQL, the invariant checker confirms the shape is right.
 * Neither can tell you whether PostgreSQL will really refuse to hand tenant A's
 * rows to tenant B. Only running it can, and only as a role that cannot bypass
 * RLS — which is why this connects as app_rw rather than as the owner.
 *
 * It creates two throwaway tenants, asserts, and deletes them. Safe to re-run.
 *
 *   node scripts/verify-isolation.mjs
 */

import pg from 'pg';
import { loadEnv } from './env.mjs';
import { sslConfig } from './ssl.mjs';

loadEnv();

const ownerUrl = process.env.MIGRATE_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) {
  console.error('MIGRATE_DATABASE_URL and DATABASE_URL must both be set');
  process.exit(1);
}

let failures = 0;
const ok = (label) => console.log(`  ok    ${label}`);
const bad = (label, detail) => {
  failures += 1;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
};
const check = (label, condition, detail) => (condition ? ok(label) : bad(label, detail));

let savepointSeq = 0;

/**
 * Run a statement expecting it to be refused, and report why if it is not.
 *
 * Wrapped in a savepoint because a failed statement aborts the whole
 * transaction in PostgreSQL — without this, the first expected failure
 * poisons every assertion after it with "current transaction is aborted".
 */
async function refuses(label, client, sql, params = []) {
  const sp = `sp_${(savepointSeq += 1)}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await client.query(sql, params);
    bad(label, 'the statement succeeded when it should have been refused');
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  } catch (e) {
    ok(`${label} — ${e.message.split('\n')[0].slice(0, 66)}`);
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
}

const owner = new pg.Client({ connectionString: ownerUrl, ssl: sslConfig() });
await owner.connect();

/* ---- fixtures ---------------------------------------------------------- */

await owner.query(
  `INSERT INTO country (code, name, currency) VALUES ('IN', 'India', 'INR')
     ON CONFLICT (code) DO NOTHING`);
await owner.query(
  `INSERT INTO currency (code, name, symbol) VALUES ('INR', 'Indian Rupee', '₹')
     ON CONFLICT (code) DO NOTHING`);

const mkTenant = async (slug) => {
  const { rows } = await owner.query(
    // $1 lands in a citext column and two text columns; without the casts
    // Postgres cannot deduce one type for the parameter.
    `INSERT INTO tenant (slug, legal_name, display_name, home_country, base_currency)
     VALUES ($1::citext, $1::text, $1::text, 'IN', 'INR')
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`, [slug]);
  return rows[0].id;
};

const tenantA = await mkTenant('isolation-check-a');
const tenantB = await mkTenant('isolation-check-b');

/** Set while seeding, so the cross-tenant foreign key test has a real target. */
let entityIdOfB = null;

const seedEmployee = async (tenantId, code, name) => {
  await owner.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
  const entity = await owner.query(
    `INSERT INTO legal_entity (tenant_id, code, legal_name, country, currency)
     VALUES ($1, 'MAIN', $2, 'IN', 'INR')
     ON CONFLICT (tenant_id, code) DO UPDATE SET legal_name = EXCLUDED.legal_name
     RETURNING id`, [tenantId, name]);
  if (tenantId === tenantB) entityIdOfB = entity.rows[0].id;
  await owner.query(
    `INSERT INTO employee (tenant_id, code, full_name, work_email, legal_entity_id, joined_on)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [tenantId, code, name, `${code.toLowerCase()}@${tenantId.slice(0, 8)}.test`, entity.rows[0].id]);
};

// Each seeding runs in its own transaction so SET LOCAL applies to it.
await owner.query('BEGIN');
await seedEmployee(tenantA, 'A001', 'Tenant A Person');
await owner.query('COMMIT');
await owner.query('BEGIN');
await seedEmployee(tenantB, 'B001', 'Tenant B Person');
await owner.query('COMMIT');

console.log('\nfixtures: two tenants, one employee each\n');

/* ---- the owner bypasses RLS, which is the whole reason app_rw exists ---- */

console.log('as the owner (postgres, BYPASSRLS):');
{
  const { rows } = await owner.query(
    'SELECT count(*)::int n FROM employee WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
  check(
    'sees both tenants — this is why the API must NOT connect as this role',
    rows[0].n === 2,
    `expected 2, saw ${rows[0].n}`,
  );
}

/* ---- and now as the application role ----------------------------------- */

const app = new pg.Client({ connectionString: appUrl, ssl: sslConfig() });
await app.connect();

const asRole = (await app.query('SELECT current_user AS u, ' +
  '(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass')).rows[0];

console.log(`\nas the application role (${asRole.u}):`);

if (asRole.bypass) {
  bad(
    `${asRole.u} has BYPASSRLS, so nothing below proves anything`,
    'Point DATABASE_URL at app_rw. Every assertion after this is meaningless '
    + 'while the API connects as a role that skips row-level security.',
  );
} else {
  ok(`${asRole.u} cannot bypass row-level security`);
}

/* no tenant set at all */
await app.query('BEGIN');
await refuses('a query with no tenant set is refused', app, 'SELECT count(*) FROM employee');
await app.query('ROLLBACK');

/* scoped to A */
await app.query('BEGIN');
await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantA]);
{
  const { rows } = await app.query('SELECT tenant_id, code FROM employee');
  check('scoped to A, sees exactly A\'s row', rows.length === 1 && rows[0].code === 'A001',
    `saw ${rows.length} row(s): ${rows.map((r) => r.code).join(', ') || 'none'}`);
  check('and none of B\'s', !rows.some((r) => r.tenant_id === tenantB));
}

/*
 * WITH CHECK — the half people forget.
 *
 * Literal values into a table that depends on no other scoped row, so the only
 * thing that can refuse this is the policy itself. An earlier version of this
 * test SELECTed the row it was inserting from a table RLS had already filtered,
 * so it inserted nothing, raised nothing, and proved nothing.
 */
await refuses(
  'cannot insert a row stamped with another tenant', app,
  `INSERT INTO department (tenant_id, code, name) VALUES ($1, 'SMUGGLED', 'Smuggled')`,
  [tenantB],
);

/* And the composite foreign key: a real id, belonging to the wrong tenant. */
await refuses(
  "cannot reference another tenant's row by id", app,
  `INSERT INTO employee (code, full_name, work_email, legal_entity_id, joined_on)
   VALUES ('X998', 'Cross reference', 'x998@x.test', $1, CURRENT_DATE)`,
  [entityIdOfB],
);

/* and cannot reach across by id even knowing it */
{
  const { rows } = await app.query('SELECT count(*)::int n FROM employee WHERE tenant_id = $1', [tenantB]);
  check('cannot read B\'s rows by naming B explicitly', rows[0].n === 0, `saw ${rows[0].n}`);
}
await app.query('ROLLBACK');

/* scoped to B */
await app.query('BEGIN');
await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantB]);
{
  const { rows } = await app.query('SELECT code FROM employee');
  check('scoped to B, sees exactly B\'s row', rows.length === 1 && rows[0].code === 'B001',
    `saw ${rows.length} row(s): ${rows.map((r) => r.code).join(', ') || 'none'}`);
}
await app.query('ROLLBACK');

/* the setting must not survive the transaction */
await app.query('BEGIN');
await refuses(
  'the tenant does not leak into the next transaction on the same connection',
  app, 'SELECT count(*) FROM employee');
await app.query('ROLLBACK');

/* the default fills the tenant in, so code cannot omit it */
await app.query('BEGIN');
await app.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantA]);
{
  await app.query(
    `INSERT INTO employee (code, full_name, work_email, legal_entity_id, joined_on)
     SELECT 'A002', 'Defaulted', 'a002@a.test', le.id, CURRENT_DATE
       FROM legal_entity le LIMIT 1`);
  const { rows } = await app.query('SELECT tenant_id FROM employee WHERE code = $1', ['A002']);
  check('an insert that omits tenant_id gets the current tenant',
    rows.length === 1 && rows[0].tenant_id === tenantA);
}
await app.query('ROLLBACK');

await app.end();

/* ---- clean up ----------------------------------------------------------- */

await owner.query('DELETE FROM tenant WHERE slug IN ($1, $2)',
  ['isolation-check-a', 'isolation-check-b']);
await owner.end();

console.log(failures
  ? `\n${failures} isolation check(s) FAILED`
  : '\nall isolation checks passed — the policies hold against a real database');
process.exit(failures ? 1 : 0);
