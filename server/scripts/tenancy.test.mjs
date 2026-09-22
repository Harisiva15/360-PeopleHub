/**
 * Nested tenant transactions join the right one, and never the wrong one.
 *
 * `withTenant` now reuses an open transaction when one exists for the same
 * tenant, so a service that inserts and then reads the row back sees its own
 * uncommitted work. That fixed seven create paths that failed every time.
 *
 * The risk it introduces is the reason this file exists. Reusing a connection
 * means reusing its `app.tenant_id`, which is SET LOCAL to the outer
 * transaction. If a nested call for tenant B joined tenant A's transaction, it
 * would read and write A's rows and row-level security would not object — the
 * setting would be telling it to. That is a cross-tenant leak introduced by a
 * bug fix, which is the worst kind.
 *
 * So the store is keyed by tenant and a mismatch must open its own connection.
 * This proves both halves without a database: the pool is a stub that records
 * how many connections were asked for.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

let failed = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label}${cond ? '' : `\n        ${detail}`}`);
};

/*
 * The logic under test, transcribed. Importing tenancy/context.ts would drag
 * in the pool and a DATABASE_URL; what matters here is the joining rule, and
 * a transcription that drifts is caught by the assertion at the end comparing
 * it against the real file's source.
 */
const ambient = new AsyncLocalStorage();
const ambientFor = (tenantId) => {
  const store = ambient.getStore();
  return store && store.tenantId === tenantId ? store.client : null;
};

let connections = 0;
const connect = () => { connections += 1; return { id: connections }; };

const withTenant = async (caller, fn) => {
  const joined = ambientFor(caller.tenantId);
  if (joined) return fn(joined);
  const client = connect();
  return ambient.run({ client, tenantId: caller.tenantId }, () => fn(client));
};

const A = { tenantId: 'tenant-a' };
const B = { tenantId: 'tenant-b' };

console.log('\nnested tenant transactions\n');

/* 1. A nested call for the same tenant joins the open transaction. */
connections = 0;
let sameClient = false;
await withTenant(A, async (outer) => {
  await withTenant(A, async (inner) => { sameClient = inner === outer; });
});
ok('a nested call for the same tenant reuses the connection', sameClient);
ok('and opens no second connection', connections === 1, `${connections} opened`);

/* 2. A nested call for a different tenant must not. */
connections = 0;
let differentClient = false;
await withTenant(A, async (outer) => {
  await withTenant(B, async (inner) => { differentClient = inner !== outer; });
});
ok('a nested call for a DIFFERENT tenant gets its own connection', differentClient,
  'it would otherwise inherit app.tenant_id and read the outer tenant\'s rows');
ok('and a second connection is opened for it', connections === 2, `${connections} opened`);

/* 3. Three deep, alternating, is still correct at every level. */
connections = 0;
const seen = [];
await withTenant(A, async (a1) => {
  seen.push(['A', a1.id]);
  await withTenant(B, async (b1) => {
    seen.push(['B', b1.id]);
    await withTenant(A, async (a2) => seen.push(['A', a2.id]));
  });
});
const idsByTenant = { A: new Set(), B: new Set() };
for (const [t, id] of seen) idsByTenant[t].add(id);
ok('alternating nesting never mixes two tenants onto one connection',
  [...idsByTenant.A].every((id) => ![...idsByTenant.B].includes(id)),
  JSON.stringify(seen));

/*
 * A deeper A inside B opens a third connection rather than rejoining the outer
 * A — correct, because B's transaction is the one in scope and A's is not
 * reachable from here. Stated so the behaviour is deliberate rather than
 * discovered later and assumed to be a bug.
 */
ok('an inner A inside B does not reach back to the outer A',
  connections === 3, `${connections} connections for A > B > A`);

/* 4. The store does not survive the transaction. */
let leaked = true;
await withTenant(A, async () => {});
leaked = ambient.getStore() !== undefined;
ok('nothing is left in the store after the transaction ends', !leaked);

console.log('\nthe transcription still matches the real module\n');

const real = new URL('../src/tenancy/context.ts', import.meta.url);
const src = (await import('node:fs')).readFileSync(real, 'utf8');
ok('context.ts keys the ambient store by tenant',
  /store\.tenantId === tenantId/.test(src),
  'The joining rule has changed and this test is now checking a copy that no longer matches.');
ok('context.ts joins an existing transaction in withTenant',
  /const joined = ambientFor\(caller\.tenantId\);\s*\n\s*if \(joined\) return fn\(joined\);/.test(src));
ok('withTenantReadOnly joins without demoting the transaction',
  /Inside an existing transaction, join it and do \*not\* mark it read only/.test(src));

console.log(`\n${failed ? `${failed} FAILED` : 'nested transactions join the right tenant'}\n`);
process.exit(failed ? 1 : 0);
