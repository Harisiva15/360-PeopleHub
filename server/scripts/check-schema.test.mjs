/**
 * Does the schema checker actually catch anything?
 *
 * A checker that has only ever passed is indistinguishable from a checker that
 * always passes. Each case below is a schema with one deliberate flaw; the
 * test asserts the checker rejects it, and for the right reason.
 *
 *   node scripts/check-schema.test.mjs
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-schema.mjs');

/** A minimal but valid base every case builds on. */
const BASE = `
CREATE TABLE tenant (id uuid PRIMARY KEY);
CREATE TABLE employee (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  UNIQUE (tenant_id, id)
);
`;

const CASES = [
  {
    name: 'accepts a correct schema',
    sql: BASE + `
CREATE TABLE leave_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  employee_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
);`,
    expect: 'pass',
  },
  {
    name: 'rejects a table with no tenant_id',
    sql: BASE + `
CREATE TABLE forgotten (id uuid PRIMARY KEY, note text);`,
    expect: /forgotten has no tenant_id/,
  },
  {
    name: 'rejects a foreign key that omits tenant_id',
    sql: BASE + `
CREATE TABLE leave_request (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  employee_id uuid NOT NULL REFERENCES employee (id),
  UNIQUE (tenant_id, id)
);`,
    expect: /omits tenant_id/,
  },
  {
    name: 'rejects a nullable tenant_id',
    sql: BASE + `
CREATE TABLE loose (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenant (id),
  UNIQUE (tenant_id, id)
);`,
    expect: /must be NOT NULL/,
  },
  {
    name: 'rejects a table that cannot be referenced tenant-safely',
    sql: BASE + `
CREATE TABLE orphan (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id)
);`,
    expect: /needs UNIQUE \(tenant_id, id\)/,
  },
  {
    name: 'rejects a reference to a table that does not exist',
    sql: BASE + `
CREATE TABLE dangling (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  ghost_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ghost_id) REFERENCES ghost (tenant_id, id)
);`,
    expect: /references unknown table ghost/,
  },
  {
    name: 'rejects a reference to a column that does not exist',
    sql: BASE + `
CREATE TABLE typo (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  employee_id uuid NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, emp_id)
);`,
    expect: /employee\.emp_id, which does not exist/,
  },
  {
    name: 'rejects the same table defined twice',
    sql: BASE + `
CREATE TABLE employee (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  UNIQUE (tenant_id, id)
);`,
    expect: /employee is defined twice/,
  },
  {
    name: 'rejects SQL that does not parse',
    sql: BASE + `CREATE TABEL wrong (id uuid);`,
    expect: /does not parse/,
  },
];

let failed = 0;

for (const c of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'schema-test-'));
  mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'db', 'migrations', '0001_case.sql'), c.sql);
  writeFileSync(join(dir, 'scripts', 'check-schema.mjs'), '');

  let output = '';
  let exitCode = 0;
  try {
    // The checker resolves migrations relative to its own location, so run a
    // copy from inside the temporary tree.
    output = execFileSync(process.execPath, [CHECKER], {
      encoding: 'utf8',
      env: { ...process.env, SCHEMA_MIGRATIONS_DIR: join(dir, 'db', 'migrations') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status ?? 1;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  const passed = c.expect === 'pass'
    ? exitCode === 0
    : exitCode !== 0 && c.expect.test(output);

  if (passed) {
    console.log(`  ok    ${c.name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${c.name}`);
    console.error(`        exit ${exitCode}, output:\n${output.split('\n').map((l) => '        ' + l).join('\n')}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${CASES.length} checker tests failed` : `\nall ${CASES.length} checker tests passed`);
process.exit(failed ? 1 : 0);
