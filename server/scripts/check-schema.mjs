/**
 * Schema checker.
 *
 * Parses the migrations with the real PostgreSQL parser (libpg-query is the
 * server's own grammar compiled to WASM), then asserts the invariants that
 * make the tenancy model actually hold. Syntax is the easy half; the checks
 * below are the half that catches a leak.
 *
 *   node scripts/check-schema.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, loadModule } from 'libpg-query';

// Overridable so check-schema.test.mjs can point it at a fixture.
const MIGRATIONS = process.env.SCHEMA_MIGRATIONS_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/**
 * Tables with no tenant_id at all: global reference data, plus the two tables
 * that describe tenants and logins themselves.
 */
const GLOBAL_TABLES = new Set([
  'tenant',
  'country', 'currency', 'fx_rate',
]);

/**
 * Tables that carry a tenant_id but are outside the tenant_isolation policy.
 *
 * tenant_membership is read to *discover* which tenant a session belongs to,
 * so scoping it by that tenant would be circular. It is not unprotected: 0010
 * gives it its own policy — a user may see their own memberships and no one
 * else's — which is why the composite-key rule below does not apply to it.
 */
const PLATFORM_TABLES = new Set([
  'tenant_membership',
]);

/** True for a table the tenancy invariants apply to. */
const isScoped = (name) => !GLOBAL_TABLES.has(name) && !PLATFORM_TABLES.has(name);

const str = (n) => n?.String?.sval ?? null;
const names = (list) => (list ?? []).map(str).filter(Boolean);

/** Flatten a CREATE TABLE into something worth asserting against. */
function readCreateTable(stmt) {
  const table = {
    name: stmt.relation.relname,
    columns: new Map(),
    uniques: [],      // arrays of column names, from PK and UNIQUE alike
    foreignKeys: [],
  };

  for (const elt of stmt.tableElts ?? []) {
    if (elt.ColumnDef) {
      const col = elt.ColumnDef;
      const type = names(col.typeName?.names).filter((n) => n !== 'pg_catalog').join('.');
      let notNull = false;
      for (const c of col.constraints ?? []) {
        const con = c.Constraint;
        if (!con) continue;
        if (con.contype === 'CONSTR_NOTNULL') notNull = true;
        if (con.contype === 'CONSTR_PRIMARY') {
          notNull = true;
          table.uniques.push([col.colname]);
        }
        if (con.contype === 'CONSTR_UNIQUE') table.uniques.push([col.colname]);
        if (con.contype === 'CONSTR_FOREIGN') {
          table.foreignKeys.push({
            columns: [col.colname],
            refTable: con.pktable?.relname,
            refSchema: con.pktable?.schemaname ?? null,
            refColumns: names(con.pk_attrs),
          });
        }
      }
      table.columns.set(col.colname, { type, notNull });
      continue;
    }

    const con = elt.Constraint;
    if (!con) continue;
    if (con.contype === 'CONSTR_PRIMARY' || con.contype === 'CONSTR_UNIQUE') {
      table.uniques.push(names(con.keys));
    }
    if (con.contype === 'CONSTR_FOREIGN') {
      table.foreignKeys.push({
        columns: names(con.fk_attrs),
        refTable: con.pktable?.relname,
        refSchema: con.pktable?.schemaname ?? null,
        refColumns: names(con.pk_attrs),
      });
    }
  }
  return table;
}

/** ALTER TABLE ... ADD CONSTRAINT, which some migrations use to break cycles. */
function applyAlterTable(stmt, tables) {
  const target = tables.get(stmt.relation.relname);
  if (!target) return;
  for (const c of stmt.cmds ?? []) {
    const cmd = c.AlterTableCmd;
    if (cmd?.subtype !== 'AT_AddConstraint') continue;
    const con = cmd.def?.Constraint;
    if (!con) continue;
    if (con.contype === 'CONSTR_FOREIGN') {
      target.foreignKeys.push({
        columns: names(con.fk_attrs),
        refTable: con.pktable?.relname,
        refSchema: con.pktable?.schemaname ?? null,
        refColumns: names(con.pk_attrs),
      });
    }
    if (con.contype === 'CONSTR_UNIQUE' || con.contype === 'CONSTR_PRIMARY') {
      target.uniques.push(names(con.keys));
    }
  }
}

const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

await loadModule();

const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
if (!files.length) {
  console.error('no migrations found in', MIGRATIONS);
  process.exit(1);
}

const tables = new Map();
const indexes = [];
let statements = 0;

for (const file of files) {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
  let tree;
  try {
    tree = await parse(sql);
  } catch (e) {
    fail(file, `does not parse — ${e.message}`);
    continue;
  }

  for (const { stmt } of tree.stmts) {
    statements += 1;
    if (stmt.CreateStmt) {
      const t = readCreateTable(stmt.CreateStmt);
      if (tables.has(t.name)) fail(file, `table ${t.name} is defined twice`);
      t.file = file;
      tables.set(t.name, t);
    } else if (stmt.AlterTableStmt) {
      applyAlterTable(stmt.AlterTableStmt, tables);
    } else if (stmt.IndexStmt) {
      indexes.push({
        table: stmt.IndexStmt.relation.relname,
        columns: (stmt.IndexStmt.indexParams ?? []).map((p) => p.IndexElem?.name).filter(Boolean),
      });
    }
  }
}

/* ---- invariant 1: everything is tenant-scoped unless deliberately global --- */
for (const [name, t] of tables) {
  if (GLOBAL_TABLES.has(name)) {
    if (t.columns.has('tenant_id')) {
      fail(t.file, `${name} is listed as global but has a tenant_id column`);
    }
    continue;
  }
  const col = t.columns.get('tenant_id');
  if (!col) {
    fail(t.file, `${name} has no tenant_id — add one, or add it to GLOBAL_TABLES with a reason`);
    continue;
  }
  if (col.type !== 'uuid') fail(t.file, `${name}.tenant_id is ${col.type}, expected uuid`);
  if (!col.notNull) fail(t.file, `${name}.tenant_id must be NOT NULL, or rows escape the policy`);
}

/* ---- invariant 2: a tenant table can be the target of a composite FK ------ */
const hasUnique = (t, cols) =>
  t.uniques.some((u) => u.length === cols.length && u.every((c, i) => c === cols[i]));

for (const [name, t] of tables) {
  if (!isScoped(name)) continue;
  if (!hasUnique(t, ['tenant_id', 'id'])) {
    fail(t.file, `${name} needs UNIQUE (tenant_id, id) so other tables can reference it tenant-safely`);
  }
}

/* ---- invariant 3: no foreign key can point across tenants ----------------
 * This is the one that matters. A plain "REFERENCES employee (id)" is
 * satisfied by *any* tenant's employee, so a bug or a hostile payload can
 * attach one tenant's leave request to another tenant's person. Carrying
 * tenant_id through the key makes that unrepresentable.
 * ------------------------------------------------------------------------- */
for (const [name, t] of tables) {
  for (const fk of t.foreignKeys) {
    // A reference into another schema — auth.users on Supabase — is outside
    // this schema's control. The columns cannot be verified from here, and it
    // is by definition not tenant-scoped, so the composite rule does not
    // apply. Flagging it would only train people to ignore the checker.
    if (fk.refSchema && fk.refSchema !== 'public') continue;

    const ref = tables.get(fk.refTable);
    if (!ref) {
      fail(t.file, `${name} references unknown table ${fk.refTable}`);
      continue;
    }
    for (const c of fk.columns) {
      if (!t.columns.has(c)) fail(t.file, `${name}.${c} in a foreign key does not exist`);
    }
    for (const c of fk.refColumns) {
      if (!ref.columns.has(c)) fail(t.file, `${name} references ${fk.refTable}.${c}, which does not exist`);
    }
    const bothScoped = isScoped(name) && isScoped(fk.refTable);
    if (bothScoped && !(fk.columns.includes('tenant_id') && fk.refColumns.includes('tenant_id'))) {
      fail(t.file, `${name} -> ${fk.refTable} (${fk.columns.join(', ')}) omits tenant_id; `
        + 'it would accept a row from another tenant');
    }
  }
}

/* ---- invariant 4: tenant_id leads an index, or every read is a seq scan --- */
for (const [name, t] of tables) {
  if (!isScoped(name)) continue;
  const leads = (cols) => cols[0] === 'tenant_id';
  const covered = t.uniques.some(leads) || indexes.some((i) => i.table === name && leads(i.columns));
  if (!covered) {
    fail(t.file, `${name} has no index starting at tenant_id — every RLS-filtered read scans the table`);
  }
}

/* ---- report -------------------------------------------------------------- */
const scoped = [...tables.keys()].filter(isScoped).length;
console.log(`${files.length} migrations, ${statements} statements, ${tables.size} tables `
  + `(${scoped} tenant-scoped, ${tables.size - scoped} global or platform)`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('schema checks passed');
