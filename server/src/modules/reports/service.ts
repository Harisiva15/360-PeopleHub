/**
 * Saved reports.
 *
 * **Running one goes through the export path, as the caller.** Not a copy of
 * its scoping, not a second builder — `run` from the exports module, with the
 * same `Caller`. Everything the export centre enforces therefore holds here,
 * and a report shared by an administrator and opened by a manager returns the
 * manager's rows.
 *
 * It also means running a report leaves a row in the export register, which is
 * deliberate: a saved report is not a side door around the audit trail.
 *
 * The grouping is the only thing this module does that exports do not, and it
 * happens over rows the export already narrowed.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { datasets as exportDatasets, run as runExport } from '../exports/service.ts';
import type { Dataset } from '../exports/service.ts';

export class ReportError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}

const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
type Aggregation = (typeof AGGREGATIONS)[number];

export interface ReportMeasure { col: string; agg: Aggregation }
export interface ReportFilterClause {
  col: string;
  op: 'is' | 'is not' | 'contains' | 'greater than' | 'less than';
  value: string;
}

export interface ReportDef {
  id: string; n: string; desc: string; datasetId: string;
  columns: string[]; groupBy: string | null;
  measures: ReportMeasure[]; filters: ReportFilterClause[];
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  ownerId: string; shared: boolean; createdOn: string;
  lastRunOn: string | null; runCount: number;
}

export interface ReportRow {
  report: ReportDef; dataset: Dataset | null; owner: string;
  mine: boolean; runnable: boolean;
}

export interface ReportResult {
  report: ReportDef; dataset: Dataset; header: string[];
  rows: (string | number | null)[][]; grouped: boolean; total: number;
}

export interface ReportDraft {
  n: string; desc?: string | undefined; datasetId: string;
  columns?: string[] | undefined; groupBy?: string | null | undefined;
  measures?: ReportMeasure[] | undefined; filters?: ReportFilterClause[] | undefined;
  sort?: { col: string; dir: 'asc' | 'desc' } | null | undefined;
  shared?: boolean | undefined;
}

interface Row {
  id: string; name: string; description: string; dataset_id: string;
  columns: string[]; group_by: string | null; measures: ReportMeasure[];
  filters: ReportFilterClause[]; sort: ReportDef['sort'];
  owner_id: string; owner: string; shared: boolean; created_on: string;
  last_run_on: string | null; run_count: number;
}

const PROJECTION = `
  SELECT r.id, r.name, r.description, r.dataset_id, r.columns, r.group_by,
         r.measures, r.filters, r.sort, r.owner_id, e.full_name AS owner,
         r.shared, r.created_on::text, r.last_run_on::text, r.run_count
    FROM saved_report r
    JOIN employee e ON e.id = r.owner_id`;

const toDef = (r: Row): ReportDef => ({
  id: r.id, n: r.name, desc: r.description, datasetId: r.dataset_id,
  columns: r.columns ?? [], groupBy: r.group_by,
  measures: r.measures ?? [], filters: r.filters ?? [], sort: r.sort,
  ownerId: r.owner_id, shared: r.shared, createdOn: r.created_on,
  lastRunOn: r.last_run_on, runCount: r.run_count,
});

const mayBuild = (caller: Caller) => {
  if (caller.role === 'employee') {
    throw new ReportError('Your role cannot build reports', 'forbidden');
  }
};

/**
 * Who may read a report at all.
 *
 * Shared, or yours, or you are an administrator. A predicate rather than a
 * filter applied afterwards, so "private to somebody else" and "does not
 * exist" stay distinguishable.
 */
function visibility(caller: Caller, params: unknown[]): string {
  if (caller.role === 'admin') return 'TRUE';
  params.push(caller.employeeId);
  return `(r.shared OR r.owner_id = $${params.length})`;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === '—') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function aggregate(values: unknown[], agg: Aggregation): number | null {
  if (agg === 'count') return values.length;
  const ns = values.map(num).filter((n): n is number => n !== null);
  if (!ns.length) return null;
  if (agg === 'sum') return ns.reduce((a, b) => a + b, 0);
  if (agg === 'avg') return Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 10) / 10;
  if (agg === 'min') return Math.min(...ns);
  return Math.max(...ns);
}

function passes(value: unknown, op: string, want: string): boolean {
  const s = String(value ?? '').toLowerCase();
  const w = want.toLowerCase();
  if (op === 'is') return s === w;
  if (op === 'is not') return s !== w;
  if (op === 'contains') return s.includes(w);
  if (op === 'greater than') return (num(value) ?? -Infinity) > Number(w);
  if (op === 'less than') return (num(value) ?? Infinity) < Number(w);
  return true;
}

export async function listReports(caller: Caller): Promise<ReportRow[]> {
  mayBuild(caller);
  const all = await exportDatasets(caller);
  const params: unknown[] = [];
  const vis = visibility(caller, params);

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION} WHERE ${vis} ORDER BY r.run_count DESC, r.name`, params);
    return rows.map((r) => {
      const def = toDef(r);
      return {
        report: def,
        dataset: all.find((d) => d.id === def.datasetId) ?? null,
        owner: r.owner,
        mine: def.ownerId === caller.employeeId,
        runnable: all.some((d) => d.id === def.datasetId),
      };
    });
  });
}

export async function getReport(caller: Caller, id: string): Promise<ReportRow | null> {
  const rows = await listReports(caller);
  const found = rows.find((r) => r.report.id === id);
  if (found) return found;
  /* Distinguish "private to somebody else" from "not there". */
  return withTenantReadOnly(caller, async (db) => {
    const { rows: exists } = await db.query('SELECT 1 FROM saved_report WHERE id = $1', [id]);
    if (exists.length) throw new ReportError('That report is private to somebody else', 'forbidden');
    return null;
  });
}

export async function reportDatasets(caller: Caller): Promise<Dataset[]> {
  mayBuild(caller);
  return exportDatasets(caller);
}

export async function runReport(caller: Caller, id: string): Promise<ReportResult> {
  const row = await getReport(caller, id);
  if (!row) throw new ReportError('No such report', 'not_found');
  const r = row.report;
  if (!row.dataset) {
    throw new ReportError('The dataset this report asks for is not available to you', 'forbidden');
  }
  const ds = row.dataset;

  /*
   * The whole scoping story in one line. This is the caller's export, so the
   * report returns the caller's rows — and the export register records it.
   */
  const src = await runExport(caller, { datasetId: r.datasetId });

  const index = new Map(ds.columns.map((c, i) => [c.k, i]));
  const at = (line: (string | number | null)[], key: string) => {
    const i = index.get(key);
    return i === undefined ? null : line[i] ?? null;
  };

  const rows = src.rows.filter((line) =>
    r.filters.every((f) => passes(at(line, f.col), f.op, f.value)));

  await withTenant(caller, async (db) => {
    await db.query(
      'UPDATE saved_report SET run_count = run_count + 1, last_run_on = CURRENT_DATE WHERE id = $1',
      [id]);
  });

  if (!r.groupBy) {
    const cols = r.columns.length ? r.columns : ds.columns.map((c) => c.k);
    const header = cols.map((k) => ds.columns.find((c) => c.k === k)?.n ?? k);
    let out = rows.map((line) => cols.map((k) => at(line, k)));
    if (r.sort) {
      const i = cols.indexOf(r.sort.col);
      if (i >= 0) {
        const dir = r.sort.dir === 'desc' ? -1 : 1;
        out = [...out].sort((a, b) => {
          const x = num(a[i]); const y = num(b[i]);
          if (x !== null && y !== null) return (x - y) * dir;
          return String(a[i] ?? '').localeCompare(String(b[i] ?? '')) * dir;
        });
      }
    }
    return { report: r, dataset: ds, header, rows: out, grouped: false, total: out.length };
  }

  const groups = new Map<string, (string | number | null)[][]>();
  for (const line of rows) {
    const key = String(at(line, r.groupBy) ?? '—');
    const bucket = groups.get(key);
    if (bucket) bucket.push(line); else groups.set(key, [line]);
  }

  const measures = r.measures.length ? r.measures : [{ col: '*', agg: 'count' as Aggregation }];
  const header = [
    ds.columns.find((c) => c.k === r.groupBy)?.n ?? r.groupBy,
    ...measures.map((m) => (m.col === '*'
      ? 'Count'
      : `${m.agg[0]!.toUpperCase()}${m.agg.slice(1)} of ${ds.columns.find((c) => c.k === m.col)?.n ?? m.col}`)),
  ];

  let out = [...groups].map(([key, bucket]) => [
    key,
    ...measures.map((m) =>
      aggregate(m.col === '*' ? bucket : bucket.map((line) => at(line, m.col)), m.agg)),
  ]);

  if (r.sort) {
    const i = r.sort.col === r.groupBy
      ? 0
      : measures.findIndex((m) => m.col === r.sort!.col
        || (r.sort!.col === 'count' && m.col === '*')) + 1;
    if (i >= 0) {
      const dir = r.sort.dir === 'desc' ? -1 : 1;
      out = [...out].sort((a, b) => {
        const x = num(a[i]); const y = num(b[i]);
        if (x !== null && y !== null) return (x - y) * dir;
        return String(a[i] ?? '').localeCompare(String(b[i] ?? '')) * dir;
      });
    }
  }

  return { report: r, dataset: ds, header, rows: out, grouped: true, total: rows.length };
}

async function validate(caller: Caller, d: Partial<ReportDraft>, existing?: ReportDef) {
  const n = d.n ?? existing?.n;
  if (!n?.trim()) throw new ReportError('Give the report a name', 'invalid');
  const datasetId = d.datasetId ?? existing?.datasetId;
  const available = await exportDatasets(caller);
  const ds = available.find((x) => x.id === datasetId);
  /*
   * A dataset this role could not export is not one it may report on. Without
   * this the builder would be a way around the export catalogue.
   */
  if (!ds) throw new ReportError('Choose something you can report on', 'invalid');

  const keys = new Set(ds.columns.map((c) => c.k));
  for (const k of d.columns ?? existing?.columns ?? []) {
    if (!keys.has(k)) throw new ReportError(`${ds.n} has no column ${k}`, 'invalid');
  }
  const groupBy = d.groupBy === undefined ? existing?.groupBy : d.groupBy;
  if (groupBy && !keys.has(groupBy)) {
    throw new ReportError(`${ds.n} has no column ${groupBy}`, 'invalid');
  }
  const measures = d.measures ?? existing?.measures ?? [];
  for (const m of measures) {
    if (!AGGREGATIONS.includes(m.agg)) {
      throw new ReportError(`${m.agg} is not a way to summarise`, 'invalid');
    }
    if (m.col !== '*' && !keys.has(m.col)) {
      throw new ReportError(`${ds.n} has no column ${m.col}`, 'invalid');
    }
  }
  for (const f of d.filters ?? existing?.filters ?? []) {
    if (!keys.has(f.col)) throw new ReportError(`${ds.n} has no column ${f.col}`, 'invalid');
  }
  if (!groupBy && measures.length) {
    throw new ReportError('Choose something to group by before summarising', 'invalid');
  }
}

export async function createReport(caller: Caller, d: ReportDraft): Promise<ReportDef> {
  /* See the note on the read-back below. */
  mayBuild(caller);
  await validate(caller, d);
  const id = await withTenant(caller, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO saved_report
         (name, description, dataset_id, columns, group_by, measures, filters,
          sort, owner_id, shared)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
       RETURNING id`,
      [d.n.trim(), d.desc?.trim() ?? '', d.datasetId, d.columns ?? [],
        d.groupBy ?? null, JSON.stringify(d.measures ?? []),
        JSON.stringify(d.filters ?? []), d.sort ? JSON.stringify(d.sort) : null,
        caller.employeeId, d.shared ?? false],
    );
    /*
     * The id only. getReport opens its own read-only transaction on another
     * pool connection, which cannot see this insert before it commits — the
     * same defect that made creating a job title fail every time. The read-back
     * happens after this block returns.
     */
    return rows[0]!.id;
  });

  const made = await getReport(caller, id);
  if (!made) throw new ReportError('The report was not created', 'invalid');
  return made.report;
}

const mayEdit = (caller: Caller, ownerId: string) =>
  caller.role === 'admin' || caller.employeeId === ownerId;

export async function updateReport(
  caller: Caller,
  id: string,
  patch: Partial<ReportDraft>,
): Promise<ReportDef> {
  const row = await getReport(caller, id);
  if (!row) throw new ReportError('No such report', 'not_found');
  if (!mayEdit(caller, row.report.ownerId)) {
    throw new ReportError('Only the person who wrote a report can change it', 'forbidden');
  }
  await validate(caller, patch, row.report);

  return withTenant(caller, async (db) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (patch.n !== undefined) set('name', patch.n.trim());
    if (patch.desc !== undefined) set('description', patch.desc);
    if (patch.datasetId !== undefined) set('dataset_id', patch.datasetId);
    if (patch.columns !== undefined) set('columns', patch.columns);
    if (patch.groupBy !== undefined) set('group_by', patch.groupBy);
    if (patch.measures !== undefined) {
      params.push(JSON.stringify(patch.measures));
      sets.push(`measures = $${params.length}::jsonb`);
    }
    if (patch.filters !== undefined) {
      params.push(JSON.stringify(patch.filters));
      sets.push(`filters = $${params.length}::jsonb`);
    }
    if (patch.sort !== undefined) {
      params.push(patch.sort ? JSON.stringify(patch.sort) : null);
      sets.push(`sort = $${params.length}::jsonb`);
    }
    if (patch.shared !== undefined) set('shared', patch.shared);

    if (sets.length) {
      params.push(id);
      await db.query(`UPDATE saved_report SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    const after = await getReport(caller, id);
    if (!after) throw new ReportError('No such report', 'not_found');
    return after.report;
  });
}

export async function removeReport(caller: Caller, id: string): Promise<ReportDef> {
  const row = await getReport(caller, id);
  if (!row) throw new ReportError('No such report', 'not_found');
  if (!mayEdit(caller, row.report.ownerId)) {
    throw new ReportError('Only the person who wrote a report can delete it', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    await db.query('DELETE FROM saved_report WHERE id = $1', [id]);
    return row.report;
  });
}

/**
 * Take somebody else's report as a private starting point.
 *
 * The alternative is people editing a shared report to answer their own
 * question and quietly changing it for everybody, which is how a shared report
 * stops being trusted.
 */
export async function duplicateReport(caller: Caller, id: string): Promise<ReportDef> {
  mayBuild(caller);
  const row = await getReport(caller, id);
  if (!row) throw new ReportError('No such report', 'not_found');
  const r = row.report;
  return createReport(caller, {
    n: `${r.n} (copy)`,
    desc: r.desc,
    datasetId: r.datasetId,
    columns: r.columns,
    groupBy: r.groupBy,
    measures: r.measures,
    filters: r.filters,
    sort: r.sort,
    shared: false,
  });
}
