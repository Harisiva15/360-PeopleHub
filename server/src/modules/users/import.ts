/**
 * Bulk user import.
 *
 * **Nothing is inserted until every row has been judged.** The import runs in
 * two calls: `previewImport` validates and returns a verdict per row, and
 * `commitImport` writes only the rows the preview marked valid. A single-call
 * import that inserted as it went would leave a half-loaded tenant behind the
 * first bad row, and the person running it would have no way to know which
 * half.
 *
 * **A partial import is the normal case, not a failure.** Somebody uploading
 * two hundred rows will have four with a typo. Refusing all two hundred
 * teaches them to stop using the feature; importing 196 and handing back a
 * precise list of the other four is the useful behaviour.
 *
 * **Every row is validated against the database, not against a regex.** The
 * department has to exist, the manager has to be a real employee, the employee
 * code has to be free, the email has to be unused — none of which can be known
 * from the file. Checking them in memory against a cached list would be faster
 * and would let two concurrent imports both claim the same code.
 *
 * Only CSV is parsed here. Spreadsheet formats need a third-party parser and
 * that is a dependency decision, not a technical one — see `csv.ts`.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { UserError, createUser } from './service.ts';
import type { UserAccount } from './service.ts';
import { parseDelimited } from './csv.ts';

/** The columns the file must carry, in any order, matched case-insensitively. */
export const IMPORT_COLUMNS = [
  'name', 'email', 'phone', 'code', 'dept', 'designation', 'site',
  'manager', 'role', 'empType', 'joinedOn',
] as const;

const REQUIRED = ['name', 'email', 'dept', 'designation', 'site', 'role'] as const;

export interface ImportRow {
  /** 1-based, counting the header as row 1, so it matches what they see. */
  line: number;
  values: Record<string, string>;
  errors: string[];
  warnings: string[];
  valid: boolean;
  /** Set where the row would update somebody rather than create them. */
  existingId: string | null;
}

export interface ImportPreview {
  fileName: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  rows: ImportRow[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]/g, '');

/** Map the file's headers onto our column names, however they were written. */
function headerMap(header: string[]): { map: Record<number, string>; missing: string[] } {
  const map: Record<number, string> = {};
  header.forEach((h, i) => {
    const found = IMPORT_COLUMNS.find((c) => norm(c) === norm(h));
    if (found) map[i] = found;
  });
  const present = new Set(Object.values(map));
  return { map, missing: REQUIRED.filter((c) => !present.has(c)) };
}

interface Lookups {
  depts: Set<string>;
  sites: Set<string>;
  emails: Map<string, string>;
  codes: Set<string>;
  managers: Map<string, string>;
}

async function lookups(db: TenantClient): Promise<Lookups> {
  const [d, s, e, m] = await Promise.all([
    db.query<{ code: string }>('SELECT code FROM department'),
    db.query<{ code: string }>('SELECT code FROM site'),
    db.query<{ id: string; work_email: string; code: string }>(
      'SELECT id, work_email, code FROM employee'),
    db.query<{ id: string; full_name: string; code: string }>(
      `SELECT id, full_name, code FROM employee WHERE status <> 'exited'`),
  ]);
  return {
    depts: new Set(d.rows.map((r) => r.code)),
    sites: new Set(s.rows.map((r) => r.code)),
    emails: new Map(e.rows.filter((r) => r.work_email)
      .map((r) => [r.work_email.toLowerCase(), r.id])),
    codes: new Set(e.rows.map((r) => r.code).filter(Boolean)),
    /* A manager may be named by code or by full name — both are what somebody
       has to hand when they build the file. */
    managers: new Map([
      ...m.rows.map((r) => [r.code?.toLowerCase(), r.id] as [string, string]),
      ...m.rows.map((r) => [r.full_name.toLowerCase(), r.id] as [string, string]),
    ].filter(([k]) => k)),
  };
}

function judge(
  row: Record<string, string>,
  line: number,
  look: Lookups,
  seenEmails: Map<string, number>,
  seenCodes: Map<string, number>,
  caller: Caller,
): ImportRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const v = (k: string) => (row[k] ?? '').trim();

  for (const c of REQUIRED) if (!v(c)) errors.push(`${c} is required`);

  const email = v('email').toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('email is not an address');
  }

  /*
   * Duplicates within the file itself, which no database check can catch —
   * two rows both claiming the same address would import as two people and
   * then fail on the second.
   */
  if (email) {
    const first = seenEmails.get(email);
    if (first) errors.push(`email repeats row ${first}`);
    else seenEmails.set(email, line);
  }

  const existingId = email ? look.emails.get(email) ?? null : null;
  if (existingId) {
    warnings.push('email already has an account — this row would be skipped');
  }

  const code = v('code');
  if (code) {
    const first = seenCodes.get(code.toLowerCase());
    if (first) errors.push(`employee ID repeats row ${first}`);
    else seenCodes.set(code.toLowerCase(), line);
    if (look.codes.has(code)) errors.push(`employee ID ${code} is already in use`);
  } else {
    warnings.push('no employee ID — one will be generated');
  }

  const dept = v('dept');
  if (dept && !look.depts.has(dept)) errors.push(`no department ${dept}`);
  const site = v('site');
  if (site && !look.sites.has(site)) errors.push(`no location ${site}`);

  const role = v('role').toLowerCase();
  if (role && !['admin', 'manager', 'employee'].includes(role)) {
    errors.push(`${v('role')} is not a role`);
  }
  /*
   * The same rule the single-user path enforces. A bulk file is exactly where
   * somebody would try to grant themselves an administrator.
   */
  if (role === 'admin' && caller.role !== 'admin') {
    errors.push('only an administrator can grant the administrator role');
  }

  const manager = v('manager');
  if (manager && !look.managers.has(manager.toLowerCase())) {
    errors.push(`no employee named or coded ${manager}`);
  }

  const joined = v('joinedOn');
  if (joined && Number.isNaN(Date.parse(joined))) errors.push(`${joined} is not a date`);

  return {
    line,
    values: row,
    errors,
    warnings,
    valid: errors.length === 0 && !existingId,
    existingId,
  };
}

export async function previewImport(
  caller: Caller,
  fileName: string,
  text: string,
): Promise<ImportPreview> {
  if (caller.role === 'employee') {
    throw new UserError('Your role cannot import accounts', 'forbidden');
  }
  /*
   * A spreadsheet handed to a CSV reader produces rows of binary noise rather
   * than an error. Refusing by extension is crude and it is honest: this
   * parser reads text, and saying so beats importing gibberish.
   */
  if (/\.(xlsx|xls|ods)$/i.test(fileName)) {
    throw new UserError(
      'Spreadsheets are not read directly — save the sheet as CSV and upload that',
      'invalid');
  }
  /*
   * A NUL byte, written as an escape. A binary file handed to a text parser
   * produces rows of noise rather than an error, and NUL is the cheapest
   * reliable sign of one. Written as an escape rather than as a literal
   * character: a real NUL in source is invisible in every editor and
   * survives no copy-paste.
   */
  if (text.includes(String.fromCharCode(0))) {
    throw new UserError('That file is not text — save it as CSV', 'invalid');
  }

  const grid = parseDelimited(text);
  if (grid.length < 2) {
    throw new UserError('The file needs a header row and at least one row of people', 'invalid');
  }

  const { map, missing } = headerMap(grid[0]!);
  if (missing.length) {
    throw new UserError(`The file is missing a column: ${missing.join(', ')}`, 'invalid');
  }

  return withTenantReadOnly(caller, async (db) => {
    const look = await lookups(db);
    const seenEmails = new Map<string, number>();
    const seenCodes = new Map<string, number>();

    const rows = grid.slice(1).map((cells, i) => {
      const record: Record<string, string> = {};
      cells.forEach((cell, col) => { if (map[col]) record[map[col]!] = cell; });
      return judge(record, i + 2, look, seenEmails, seenCodes, caller);
    });

    return {
      fileName,
      totalRows: rows.length,
      validRows: rows.filter((r) => r.valid).length,
      invalidRows: rows.filter((r) => r.errors.length).length,
      duplicateRows: rows.filter((r) => r.existingId).length,
      rows,
    };
  });
}

export interface ImportResult {
  importId: string;
  created: number;
  skipped: number;
  failed: number;
  /** Which rows did not make it, and why. */
  failures: { line: number; reason: string }[];
}

/**
 * Write the valid rows.
 *
 * Re-validates rather than trusting the preview: the two calls are separated
 * by however long somebody spent reading the table, and in that time another
 * administrator may have taken the employee code the preview said was free.
 *
 * Each row goes through `createUser`, the same path a single account takes —
 * so every rule in that function applies here too. A bulk endpoint with its
 * own insert is how a bulk endpoint becomes the way round the rules.
 */
export async function commitImport(
  caller: Caller,
  fileName: string,
  text: string,
): Promise<ImportResult> {
  const preview = await previewImport(caller, fileName, text);
  const failures: { line: number; reason: string }[] = [];
  let created = 0;

  for (const row of preview.rows) {
    if (!row.valid) {
      failures.push({
        line: row.line,
        reason: row.errors.join('; ') || 'already has an account',
      });
      continue;
    }
    try {
      await createUser(caller, {
        name: row.values.name!,
        email: row.values.email!,
        phone: row.values.phone,
        code: row.values.code,
        dept: row.values.dept!,
        designation: row.values.designation!,
        site: row.values.site!,
        managerId: row.values.manager
          ? (await resolveManager(caller, row.values.manager))
          : null,
        role: (row.values.role!.toLowerCase() as 'admin' | 'manager' | 'employee'),
        empType: row.values.empType,
        joinedOn: row.values.joinedOn,
      });
      created += 1;
    } catch (e) {
      /* One bad row does not stop the rest. It is reported, precisely. */
      failures.push({ line: row.line, reason: (e as Error).message });
    }
  }

  const skipped = preview.rows.filter((r) => r.existingId).length;

  const importId = await withTenant(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO user_import
         (uploaded_by, file_name, file_size, total_rows, created_rows,
          updated_rows, skipped_rows, failed_rows, status, rows)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9::jsonb)
       RETURNING id`,
      [caller.employeeId, fileName, text.length, preview.totalRows, created,
        skipped, failures.length,
        failures.length === 0 ? 'completed'
          : created === 0 ? 'failed' : 'partial',
        /* The failures, so the person can come back to them. Not the file:
           it is a list of people and this table is not where it should live. */
        JSON.stringify(failures)],
    );
    return rows[0]!.id;
  });

  return { importId, created, skipped, failed: failures.length, failures };
}

async function resolveManager(caller: Caller, nameOrCode: string): Promise<string | null> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM employee
        WHERE (lower(code) = lower($1) OR lower(full_name) = lower($1))
          AND status <> 'exited' LIMIT 1`,
      [nameOrCode]);
    return rows[0]?.id ?? null;
  });
}

/** What has been imported before, newest first. */
export async function importHistory(caller: Caller) {
  if (caller.role === 'employee') {
    throw new UserError('Your role cannot see the import history', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{
      id: string; uploaded_at: string; file_name: string; total_rows: number;
      created_rows: number; skipped_rows: number; failed_rows: number;
      status: string; by: string | null;
    }>(
      `SELECT i.id, i.uploaded_at::text, i.file_name, i.total_rows, i.created_rows,
              i.skipped_rows, i.failed_rows, i.status, e.full_name AS by
         FROM user_import i
         LEFT JOIN employee e ON e.id = i.uploaded_by
        ORDER BY i.uploaded_at DESC LIMIT 50`);
    return rows.map((r) => ({
      id: r.id, at: r.uploaded_at, fileName: r.file_name,
      total: r.total_rows, created: r.created_rows, skipped: r.skipped_rows,
      failed: r.failed_rows, status: r.status, by: r.by ?? '—',
    }));
  });
}

export type { UserAccount };
