/**
 * The export centre.
 *
 * Every builder below reaches the data the same way a screen does — through a
 * service, with the caller passed along. That is not a convention somebody has
 * to remember: a dataset marked `caller` gets rows from a service that takes
 * the caller, and a dataset whose service has no caller is marked `admin-only`
 * and refused to everybody else. There is no path through this file where a
 * filter is written by hand and a manager ends up with the company.
 *
 * Refusals are recorded as well as successes. A manager reaching for the
 * payroll-shaped datasets is exactly what somebody reviewing this afterwards
 * wants to see, and a register containing only the permitted exports has
 * quietly answered a different question.
 */

import { sortBy } from '../../lib/collections';
import { uid } from '../../lib/rng';
import { TODAY, ymd } from '../../lib/dates';
import { EMAP } from '../../data/employees';
import { deptOf, siteOf } from '../../data/org';
import { DATASETS, EXPORT_LOG, datasetOf, exportKPI, exportHistory } from '../../data/exports';
import type { Dataset, ExportRun } from '../../data/exports';
import type { Services } from '../contracts';
import type {
  Caller, ExportFilter, ExportRequest, ExportResult, ExportRunRow, ExportService,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));


const nameOf = (id?: string | null) => (id ? EMAP[id]?.name ?? id : '—');

/** Date and time, because two exports in one afternoon need an order. */
const stamp = () => {
  const d = new Date();
  return `${ymd(TODAY)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

type Row = (string | number | null)[];

/**
 * How each dataset's rows are produced.
 *
 * Keyed by dataset id so the catalogue and the builders cannot drift apart
 * silently — a dataset with no builder, or a builder with no dataset, is a
 * pair of assertions in the check rather than an empty file at download time.
 */
const BUILDERS: Record<string, (c: Caller, s: Services, f: ExportFilter) => Promise<Row[]>> = {
  async employees(c, s) {
    const rows = await s.employees.visible(c);
    return sortBy(rows, (e) => e.name).map((e) => [
      e.code, e.name, e.email, deptOf(e.dept).name, e.designation,
      siteOf(e.site).name, nameOf(e.managerId), e.doj, e.status,
    ]);
  },

  async lifecycle(c, s) {
    const rows = await s.lifecycle.list(c, {});
    return rows.map((r) => [
      r.subject.code, r.subject.name, r.standing.stage, r.standing.since,
      r.standing.daysInStage, r.subject.dept ? deptOf(r.subject.dept).name : '—',
      nameOf(r.subject.managerId), r.openTasks, r.standing.nextAction ?? '—',
    ]);
  },

  async devplans(c, s) {
    const rows = await s.devPlans.list(c, {});
    return rows.map((r) => [
      r.name, r.designation, r.plan.aspiration, r.plan.focus.join(' | '),
      r.plan.status, r.endorsed ? r.plan.endorsedOn ?? 'Yes' : 'No',
      nameOf(r.plan.mentorId), r.progress, r.overdue, r.plan.reviewOn,
    ]);
  },

  async events(c, s, f) {
    const rows = await s.events.list(c, { from: f.from, to: f.to });
    return rows.map((r) => [
      r.event.title, r.event.type, r.event.on,
      r.event.online ? 'Online' : `${r.event.venue}${r.event.site ? ` · ${siteOf(r.event.site).name}` : ''}`,
      r.organiser, r.event.status, r.audience, r.going, r.waitlisted,
      r.attendance ?? '—',
    ]);
  },

  async software(c, s) {
    const rows = await s.software.list(c, {});
    return rows.map((r) => [
      r.product.n, r.product.vendor, r.product.cat, r.product.seats, r.assigned,
      r.dormant, r.annualCost, r.wastedCost, r.product.renewsOn,
      nameOf(r.product.ownerId),
    ]);
  },

  async jobtitles(c, s) {
    const rows = await s.jobTitles.list(c);
    return rows.map((r) => [
      r.title.code, r.title.n, deptOf(r.title.dept).name, r.title.family,
      r.title.level, r.title.empType, r.title.status, r.employees,
    ]);
  },

  /* ---- the two whose services take no caller, hence administrators only ---- */

  async leave(_c, s, f) {
    const rows = await s.leave.list({});
    const within = rows.filter((r) =>
      (!f.from || r.to >= f.from) && (!f.to || r.from <= f.to));
    return sortBy(within, (r) => r.from, 'desc').map((r) => [
      EMAP[r.empId]?.code ?? r.empId, nameOf(r.empId), r.type, r.from, r.to,
      r.days, r.status, r.reason,
    ]);
  },

  async assets(_c, s) {
    const rows = await s.assets.list();
    return sortBy(rows, (a) => a.tag ?? a.id).map((a) => [
      a.tag ?? '—', a.type, a.cat ?? '—', a.serial,
      a.empId ? nameOf(a.empId) : '—', a.site ? siteOf(a.site).name : '—',
      a.status, a.purchased ?? '—', a.cost ?? 0, a.warrantyEnd ?? '—',
    ]);
  },
};

const runRow = (r: ExportRun): ExportRunRow => ({
  run: r,
  /* The dataset may since have been retired; the record still has to read. */
  dataset: datasetOf(r.datasetId) ?? null,
});

/**
 * Whose exports this caller may read.
 *
 * Everybody can see their own — you are entitled to know what you took — and
 * only an administrator sees the whole register. A manager reading everybody
 * else's export history is surveillance with no purpose the product has.
 */
function visibleRuns(c: Caller): ExportRun[] {
  return c.role === 'admin' ? exportHistory() : exportHistory().filter((r) => r.byId === c.meId);
}

const describe = (d: Dataset, f: ExportFilter) =>
  (d.dated && (f.from || f.to))
    ? `${f.from || 'the beginning'} to ${f.to || 'today'}`
    : 'Everything visible';

export const makeExportService = (getSvc: () => Services): ExportService => ({
  datasets(c) {
    /*
     * The catalogue is filtered rather than flagged. Listing a dataset the
     * person cannot run, greyed out, tells them what exists and that they
     * cannot have it — which is a worse answer than not raising it.
     */
    return ok(DATASETS.filter((d) => d.roles.includes(c.role)));
  },

  history(c, f = {}) {
    let rows = visibleRuns(c);
    if (f.datasetId) rows = rows.filter((r) => r.datasetId === f.datasetId);
    if (f.byId) rows = rows.filter((r) => r.byId === f.byId);
    if (f.outcome) rows = rows.filter((r) => r.outcome === f.outcome);
    if (f.personalOnly) rows = rows.filter((r) => r.personal);
    if (f.from) rows = rows.filter((r) => r.at.slice(0, 10) >= f.from!);
    if (f.to) rows = rows.filter((r) => r.at.slice(0, 10) <= f.to!);
    if (f.q?.trim()) {
      const q = f.q.trim().toLowerCase();
      rows = rows.filter((r) => `${r.datasetName} ${r.byName}`.toLowerCase().includes(q));
    }
    return ok(rows.map(runRow));
  },

  stats(c) {
    return ok(exportKPI(visibleRuns(c)));
  },

  async run(c, req: ExportRequest) {
    const d = datasetOf(req.datasetId);
    if (!d) return refuse('No such dataset');

    const record = (rows: number, outcome: ExportRun['outcome'], note: string): ExportRun => {
      const run: ExportRun = {
        id: uid('EXP'),
        datasetId: d.id,
        datasetName: d.n,
        byId: c.meId,
        byName: EMAP[c.meId]?.name ?? c.meId,
        byRole: c.role,
        at: stamp(),
        rows,
        columns: d.columns.length,
        filters: describe(d, req),
        personal: d.personal,
        outcome,
        note,
      };
      EXPORT_LOG.push(run);
      return run;
    };

    /*
     * A refusal is recorded before it is thrown. Somebody reviewing this later
     * is looking for the attempts as much as the successes, and an exception
     * that leaves no trace is the one thing this register cannot afford.
     */
    if (!d.roles.includes(c.role)) {
      record(0, 'Refused', `${c.role} cannot export ${d.n.toLowerCase()}`);
      return refuse(`Your role cannot export ${d.n.toLowerCase()}`);
    }
    if (d.scope === 'admin-only' && c.role !== 'admin') {
      /* Belt and braces: the roles list already says admin, and this says why. */
      record(0, 'Refused', 'This dataset is not narrowed to the caller');
      return refuse('That dataset can only be exported in full, so only an administrator may take it');
    }
    if (req.from && req.to && req.from > req.to) {
      return refuse('The range ends before it starts');
    }

    const build = BUILDERS[d.id];
    if (!build) return refuse('That dataset cannot be built');

    const rows = await build(c, getSvc(), req);

    /*
     * Columns are dropped after the rows are built rather than before. The
     * builder produces the dataset's full width, and a narrower request takes
     * a slice of it — which means a column list that does not match the
     * catalogue cannot silently shift every value one place to the left.
     */
    const keep = req.columns?.length
      ? d.columns.map((col, i) => (req.columns!.includes(col.k) ? i : -1)).filter((i) => i >= 0)
      : d.columns.map((_, i) => i);
    if (!keep.length) return refuse('Choose at least one column');

    const header = keep.map((i) => d.columns[i].n);
    const body = rows.map((r) => keep.map((i) => r[i] ?? ''));

    const run = record(body.length, 'Completed', '');
    const result: ExportResult = {
      run,
      dataset: d,
      filename: `${d.id}_${ymd(TODAY)}.csv`,
      header,
      rows: body,
    };
    return result;
  },
});
