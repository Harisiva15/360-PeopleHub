/**
 * Custom reports.
 *
 * **Running a report asks the export centre.** Not a copy of its query, not a
 * parallel builder — the same `exports.run` the export screen calls, with the
 * same caller. Everything the export centre enforces about scope therefore
 * holds here for free, and there is no second place for it to be wrong.
 *
 * The consequence is the rule that matters: a report shared by an
 * administrator and run by a manager returns the *manager's* rows. The
 * definition travels; the data does not.
 *
 * The grouping happens here, over rows the service already narrowed. That is
 * the only thing this module does that the export centre does not.
 */

import { sortBy } from '../../lib/collections';
import { TODAY, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { EMAP } from '../../data/employees';
import { DATASETS, datasetOf } from '../../data/exports';
import {
  AGGREGATIONS, REPORT_DEFS, reportOf, reportsVisibleTo,
} from '../../data/reportdefs';
import type { Aggregation, ReportDef } from '../../data/reportdefs';
import { recordAudit } from '../../data/audit';
import type { Services } from '../contracts';
import type {
  Caller, ReportDraft, ReportResult, ReportRow, ReportService,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));

const rowOf = (r: ReportDef, c: Caller): ReportRow => ({
  report: r,
  dataset: datasetOf(r.datasetId) ?? null,
  owner: EMAP[r.ownerId]?.name ?? r.ownerId,
  mine: r.ownerId === c.meId,
  /* Whether this caller could run it at all, so the list can say why not. */
  runnable: (datasetOf(r.datasetId)?.roles ?? []).includes(c.role),
});

const mayEdit = (c: Caller, r: ReportDef) => c.role === 'admin' || r.ownerId === c.meId;

/** A number from a cell, treating anything unparseable as absent rather than zero. */
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === '—') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function aggregate(values: unknown[], agg: Aggregation): number | null {
  if (agg === 'count') return values.length;
  const ns = values.map(num).filter((n): n is number => n !== null);
  if (!ns.length) return null;
  switch (agg) {
    case 'sum': return ns.reduce((a, b) => a + b, 0);
    case 'avg': return Math.round((ns.reduce((a, b) => a + b, 0) / ns.length) * 10) / 10;
    case 'min': return Math.min(...ns);
    case 'max': return Math.max(...ns);
    default: return null;
  }
}

function passes(value: unknown, op: string, want: string): boolean {
  const s = String(value ?? '').toLowerCase();
  const w = want.toLowerCase();
  switch (op) {
    case 'is': return s === w;
    case 'is not': return s !== w;
    case 'contains': return s.includes(w);
    case 'greater than': return (num(value) ?? -Infinity) > Number(w);
    case 'less than': return (num(value) ?? Infinity) < Number(w);
    default: return true;
  }
}

const validate = (d: Partial<ReportDraft>, existing?: ReportDef): string | null => {
  const n = d.n ?? existing?.n;
  if (!n?.trim()) return 'Give the report a name';
  const datasetId = d.datasetId ?? existing?.datasetId;
  const ds = datasetId ? datasetOf(datasetId) : undefined;
  if (!ds) return 'Choose something to report on';

  const keys = new Set(ds.columns.map((c) => c.k));
  for (const k of d.columns ?? existing?.columns ?? []) {
    if (!keys.has(k)) return `${ds.n} has no column ${k}`;
  }
  const groupBy = d.groupBy === undefined ? existing?.groupBy : d.groupBy;
  if (groupBy && !keys.has(groupBy)) return `${ds.n} has no column ${groupBy}`;
  for (const m of d.measures ?? existing?.measures ?? []) {
    if (!AGGREGATIONS.includes(m.agg)) return `${m.agg} is not a way to summarise`;
    if (m.col !== '*' && !keys.has(m.col)) return `${ds.n} has no column ${m.col}`;
  }
  for (const f of d.filters ?? existing?.filters ?? []) {
    if (!keys.has(f.col)) return `${ds.n} has no column ${f.col}`;
  }
  /*
   * Measures without a grouping have nothing to aggregate over, and a grouping
   * without measures produces a list of distinct values — which is a valid
   * question, so only the first is refused.
   */
  if (!groupBy && (d.measures ?? existing?.measures ?? []).length) {
    return 'Choose something to group by before summarising';
  }
  return null;
};

export const makeReportService = (getSvc: () => Services): ReportService => ({
  list(c) {
    if (c.role === 'employee') return refuse('Your role cannot build reports');
    return ok(reportsVisibleTo(c.meId, c.role).map((r) => rowOf(r, c)));
  },

  /** The datasets a report can be built on — the export catalogue, filtered. */
  datasets(c) {
    if (c.role === 'employee') return refuse('Your role cannot build reports');
    return ok(DATASETS.filter((d) => d.roles.includes(c.role)));
  },

  async run(c, id) {
    const r = reportOf(id);
    if (!r) return refuse('No such report');
    if (!r.shared && r.ownerId !== c.meId && c.role !== 'admin') {
      return refuse('That report is private to somebody else');
    }
    const ds = datasetOf(r.datasetId);
    if (!ds) return refuse('The dataset this report asks for no longer exists');

    /*
     * The whole scoping story in one line: the export centre runs it, as this
     * caller. A report shared by an administrator and opened by a manager
     * returns the manager's rows, because this is the manager's export.
     */
    const src = await getSvc().exports.run(c, { datasetId: r.datasetId });

    const index = new Map(ds.columns.map((col, i) => [col.k, i]));
    const at = (row: (string | number | null)[], key: string) => {
      const i = index.get(key);
      return i === undefined ? null : row[i] ?? null;
    };

    let rows = src.rows.filter((row) =>
      r.filters.every((f) => passes(at(row, f.col), f.op, f.value)));

    r.lastRunOn = ymd(TODAY);
    r.runCount += 1;

    /* ---- flat ---- */
    if (!r.groupBy) {
      const cols = r.columns.length ? r.columns : ds.columns.map((x) => x.k);
      const header = cols.map((k) => ds.columns.find((x) => x.k === k)?.n ?? k);
      let out = rows.map((row) => cols.map((k) => at(row, k)));
      if (r.sort) {
        const i = cols.indexOf(r.sort.col);
        if (i >= 0) {
          out = sortBy(out, (row) => num(row[i]) ?? String(row[i] ?? ''),
            r.sort.dir === 'desc' ? 'desc' : 'asc');
        }
      }
      const result: ReportResult = {
        report: r, dataset: ds, header, rows: out, grouped: false, total: out.length,
      };
      return result;
    }

    /* ---- grouped ---- */
    const groups = new Map<string, (string | number | null)[][]>();
    for (const row of rows) {
      const key = String(at(row, r.groupBy) ?? '—');
      const bucket = groups.get(key);
      if (bucket) bucket.push(row); else groups.set(key, [row]);
    }

    const measures = r.measures.length ? r.measures : [{ col: '*', agg: 'count' as Aggregation }];
    const label = (m: { col: string; agg: Aggregation }) =>
      (m.col === '*'
        ? 'Count'
        : `${m.agg[0]!.toUpperCase()}${m.agg.slice(1)} of ${ds.columns.find((x) => x.k === m.col)?.n ?? m.col}`);

    const header = [
      ds.columns.find((x) => x.k === r.groupBy)?.n ?? r.groupBy,
      ...measures.map(label),
    ];

    let out = [...groups].map(([key, bucket]) => [
      key,
      ...measures.map((m) =>
        aggregate(m.col === '*' ? bucket : bucket.map((row) => at(row, m.col)), m.agg)),
    ]);

    if (r.sort) {
      /* Sorting a grouped report sorts by a measure, or by the group itself. */
      const i = r.sort.col === r.groupBy
        ? 0
        : measures.findIndex((m) => m.col === r.sort!.col || (r.sort!.col === 'count' && m.col === '*')) + 1;
      if (i >= 0) {
        out = sortBy(out, (row) => num(row[i]) ?? String(row[i] ?? ''),
          r.sort.dir === 'desc' ? 'desc' : 'asc');
      }
    }

    const result: ReportResult = {
      report: r, dataset: ds, header, rows: out, grouped: true, total: rows.length,
    };
    return result;
  },

  create(c, d) {
    if (c.role === 'employee') return refuse('Your role cannot build reports');
    const bad = validate(d);
    if (bad) return refuse(bad);
    const ds = datasetOf(d.datasetId)!;
    if (!ds.roles.includes(c.role)) {
      return refuse(`Your role cannot report on ${ds.n.toLowerCase()}`);
    }
    const r: ReportDef = {
      id: uid('RPT'),
      n: d.n.trim(),
      desc: d.desc?.trim() ?? '',
      datasetId: d.datasetId,
      columns: d.columns ?? [],
      groupBy: d.groupBy ?? null,
      measures: d.measures ?? [],
      filters: d.filters ?? [],
      sort: d.sort ?? null,
      ownerId: c.meId,
      shared: d.shared ?? false,
      createdOn: ymd(TODAY),
      lastRunOn: null,
      runCount: 0,
    };
    REPORT_DEFS.push(r);
    recordAudit.write(c, 'report.created', 'report', r.id, r.n);
    return ok(r);
  },

  update(c, id, patch) {
    const r = reportOf(id);
    if (!r) return refuse('No such report');
    if (!mayEdit(c, r)) return refuse('Only the person who wrote a report can change it');
    const bad = validate(patch, r);
    if (bad) return refuse(bad);
    Object.assign(r, patch);
    recordAudit.write(c, 'report.updated', 'report', r.id, r.n);
    return ok(r);
  },

  remove(c, id) {
    const i = REPORT_DEFS.findIndex((r) => r.id === id);
    if (i < 0) return refuse('No such report');
    if (!mayEdit(c, REPORT_DEFS[i]!)) {
      return refuse('Only the person who wrote a report can delete it');
    }
    const [r] = REPORT_DEFS.splice(i, 1);
    recordAudit.write(c, 'report.removed', 'report', r!.id, r!.n);
    return ok(r!);
  },

  /**
   * Take somebody else's report as a starting point.
   *
   * The alternative is people editing a shared report to answer their own
   * question and quietly changing it for everybody — which is how a shared
   * report stops being trusted.
   */
  duplicate(c, id) {
    if (c.role === 'employee') return refuse('Your role cannot build reports');
    const r = reportOf(id);
    if (!r) return refuse('No such report');
    if (!r.shared && r.ownerId !== c.meId && c.role !== 'admin') {
      return refuse('That report is private to somebody else');
    }
    const copy: ReportDef = {
      ...r,
      id: uid('RPT'),
      n: `${r.n} (copy)`,
      ownerId: c.meId,
      shared: false,
      createdOn: ymd(TODAY),
      lastRunOn: null,
      runCount: 0,
    };
    REPORT_DEFS.push(copy);
    recordAudit.write(c, 'report.duplicated', 'report', copy.id, `${r.n} → ${copy.n}`);
    return ok(copy);
  },
});
