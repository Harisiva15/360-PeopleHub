/**
 * The export centre, server side.
 *
 * Two rules, both structural rather than careful.
 *
 * **An export cannot see more than the caller.** Every builder below reaches
 * its rows through the same module function the corresponding screen calls,
 * with the same `Caller`. There is no query in this file. That is the whole
 * design: a hand-written WHERE clause here would be a second copy of a scoping
 * rule that already exists, and the copy is always the one that drifts.
 *
 * **The register keeps the fact, never the data.** An export writes one
 * `audit_log` row with category 'export' — the dataset, the actor, the row
 * count, the filters. Migration 0031 has a CHECK that refuses an export row
 * carrying anything shaped like exported data, and a view that projects the
 * register out of it. There is no `export_run` table, because an export is an
 * access event and this system has had a table for those since 0009.
 *
 * **Refusals are recorded too.** Somebody reaching for data their role cannot
 * have is the thing a review is looking for, and a register holding only the
 * permitted exports has quietly answered a narrower question.
 *
 * All eight datasets are offered here. The five the 0032-0036 migrations
 * brought with them arrived after this module did, and until their tables
 * existed they were deliberately absent — claiming a dataset the server cannot
 * build hands somebody an empty CSV and a register entry saying it worked,
 * which is worse than not offering it at all.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { listVisibleEmployees } from '../employees/service.ts';
import { listLeave } from '../leave/service.ts';
import { listAssets } from '../assets/service.ts';
import { listJobTitles } from '../jobtitles/service.ts';
import { listLifecycle } from '../lifecycle/service.ts';
import { listSoftware } from '../software/service.ts';
import { listDevPlans } from '../devplans/service.ts';
import { listEvents } from '../events/service.ts';

export class ExportError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

type Role = Caller['role'];
type Cell = string | number | null;

export interface DatasetColumn {
  k: string;
  n: string;
  personal?: boolean;
}

export interface Dataset {
  id: string;
  n: string;
  desc: string;
  ic: string;
  roles: Role[];
  scope: 'caller' | 'admin-only';
  personal: boolean;
  dated: boolean;
  columns: DatasetColumn[];
}

export interface ExportRequest {
  datasetId: string;
  columns?: string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export interface ExportRunRecord {
  id: string;
  datasetId: string;
  datasetName: string;
  byId: string | null;
  byName: string;
  byRole: Role;
  at: string;
  rows: number;
  columns: number;
  filters: string;
  personal: boolean;
  outcome: 'Completed' | 'Refused';
  note: string;
}

export interface ExportResult {
  run: ExportRunRecord;
  dataset: Dataset;
  filename: string;
  header: string[];
  rows: Cell[][];
}

/**
 * The catalogue.
 *
 * Every entry is `scope: 'caller'` here, because every module function these
 * builders call takes the caller and narrows in SQL. The demo's catalogue
 * marks leave and assets admin-only for a reason that is true of the in-memory
 * implementation and not of this one: `LeaveService.list` and
 * `AssetService.list` in the shared contract take a query rather than a
 * caller, so the mock has nothing to narrow by. Widening them is a contract
 * change, not a change here.
 */
const DATASETS: Dataset[] = [
  {
    id: 'employees',
    n: 'Employee directory',
    desc: 'Everybody you can see, with their department, role and manager.',
    ic: 'people',
    roles: ['admin', 'manager'],
    scope: 'caller',
    personal: true,
    dated: false,
    columns: [
      { k: 'code', n: 'Employee ID' },
      { k: 'name', n: 'Name', personal: true },
      { k: 'email', n: 'Work email', personal: true },
      { k: 'dept', n: 'Department' },
      { k: 'designation', n: 'Designation' },
      { k: 'site', n: 'Location' },
      { k: 'manager', n: 'Manager' },
      { k: 'doj', n: 'Joined' },
      { k: 'status', n: 'Status' },
    ],
  },
  {
    id: 'lifecycle',
    n: 'Employment lifecycle',
    desc: 'Where each person stands, how long they have been there and what is next.',
    ic: 'swap',
    roles: ['admin', 'manager'],
    scope: 'caller',
    personal: true,
    dated: false,
    columns: [
      { k: 'code', n: 'Employee ID' },
      { k: 'name', n: 'Name', personal: true },
      { k: 'stage', n: 'Stage' },
      { k: 'since', n: 'In stage since' },
      { k: 'days', n: 'Days in stage' },
      { k: 'dept', n: 'Department' },
      { k: 'manager', n: 'Manager' },
      { k: 'openTasks', n: 'Open tasks' },
      { k: 'nextAction', n: 'Next action' },
    ],
  },
  {
    id: 'devplans',
    n: 'Development plans',
    desc: 'Aspirations, focus areas, progress and when each is next reviewed.',
    ic: 'rocket',
    roles: ['admin', 'manager'],
    scope: 'caller',
    personal: true,
    dated: false,
    columns: [
      { k: 'name', n: 'Name', personal: true },
      { k: 'designation', n: 'Designation' },
      { k: 'aspiration', n: 'Aiming at' },
      { k: 'focus', n: 'Focus areas' },
      { k: 'status', n: 'Status' },
      { k: 'endorsed', n: 'Endorsed' },
      { k: 'mentor', n: 'Mentor' },
      { k: 'progress', n: 'Progress %' },
      { k: 'overdue', n: 'Overdue actions' },
      { k: 'reviewOn', n: 'Next review' },
    ],
  },
  {
    id: 'events',
    n: 'Company events',
    desc: 'What was on, how many came and what the turnout was.',
    ic: 'calendar',
    roles: ['admin', 'manager'],
    scope: 'caller',
    personal: false,
    dated: true,
    columns: [
      { k: 'title', n: 'Event' },
      { k: 'type', n: 'Kind' },
      { k: 'on', n: 'Date' },
      { k: 'where', n: 'Where' },
      { k: 'organiser', n: 'Organiser' },
      { k: 'status', n: 'Status' },
      { k: 'audience', n: 'Invited' },
      { k: 'going', n: 'Going' },
      { k: 'waitlisted', n: 'Waitlisted' },
      { k: 'attendance', n: 'Turnout %' },
    ],
  },
  {
    id: 'software',
    n: 'Software estate',
    desc: 'Subscriptions, seats, renewals and what the idle seats cost.',
    ic: 'puzzle',
    roles: ['admin', 'manager'],
    scope: 'caller',
    personal: false,
    dated: false,
    columns: [
      { k: 'product', n: 'Product' },
      { k: 'vendor', n: 'Vendor' },
      { k: 'cat', n: 'Category' },
      { k: 'seats', n: 'Seats purchased' },
      { k: 'assigned', n: 'Seats assigned' },
      { k: 'dormant', n: 'Dormant seats' },
      { k: 'annualCost', n: 'Annual cost' },
      { k: 'wastedCost', n: 'Idle spend' },
      { k: 'renewsOn', n: 'Renews' },
      { k: 'owner', n: 'Owner' },
    ],
  },
  {
    id: 'jobtitles',
    n: 'Job title catalogue',
    desc: 'Every title, its level and family, and how many people hold it.',
    ic: 'briefcase',
    roles: ['admin', 'manager'],
    scope: 'caller',
    personal: false,
    dated: false,
    columns: [
      { k: 'code', n: 'Code' },
      { k: 'n', n: 'Title' },
      { k: 'dept', n: 'Department' },
      { k: 'family', n: 'Family' },
      { k: 'level', n: 'Level' },
      { k: 'empType', n: 'Employment type' },
      { k: 'status', n: 'Status' },
      { k: 'employees', n: 'People holding it' },
    ],
  },
  {
    id: 'leave',
    n: 'Leave requests',
    desc: 'Every request in the period, with its type, days and outcome.',
    ic: 'leave',
    roles: ['admin'],
    scope: 'caller',
    personal: true,
    dated: true,
    columns: [
      { k: 'code', n: 'Employee ID' },
      { k: 'name', n: 'Name', personal: true },
      { k: 'type', n: 'Leave type' },
      { k: 'from', n: 'From' },
      { k: 'to', n: 'To' },
      { k: 'days', n: 'Days' },
      { k: 'status', n: 'Status' },
      { k: 'reason', n: 'Reason', personal: true },
    ],
  },
  {
    id: 'assets',
    n: 'Asset register',
    desc: 'Every item, where it is, who holds it and what it is worth.',
    ic: 'laptop',
    roles: ['admin'],
    scope: 'caller',
    personal: true,
    dated: false,
    columns: [
      { k: 'tag', n: 'Asset tag' },
      { k: 'type', n: 'Item' },
      { k: 'cat', n: 'Category' },
      { k: 'serial', n: 'Serial' },
      { k: 'holder', n: 'Held by', personal: true },
      { k: 'site', n: 'Location' },
      { k: 'status', n: 'Status' },
      { k: 'purchased', n: 'Purchased' },
      { k: 'cost', n: 'Cost' },
      { k: 'warrantyEnd', n: 'Warranty ends' },
    ],
  },
];

const datasetOf = (id: string) => DATASETS.find((d) => d.id === id);

/**
 * Names for the person columns.
 *
 * The employee list the caller can see is fetched once and used as a lookup,
 * rather than resolving each row's manager or asset holder separately. A
 * directory of five hundred should be one query, not five hundred and one —
 * and a name this caller cannot see is left as a dash rather than resolved
 * behind their back.
 */
async function nameLookup(caller: Caller): Promise<Map<string, string>> {
  const people = await listVisibleEmployees(caller);
  return new Map(people.map((e) => [e.id, e.name]));
}

const BUILDERS: Record<string, (c: Caller, req: ExportRequest) => Promise<Cell[][]>> = {
  async employees(caller) {
    const rows = await listVisibleEmployees(caller);
    const names = new Map(rows.map((e) => [e.id, e.name]));
    return rows.map((e) => [
      e.code, e.name, e.email, e.dept, e.designation, e.site,
      e.managerId ? names.get(e.managerId) ?? '—' : '—',
      e.doj, e.status,
    ]);
  },

  async lifecycle(caller) {
    const rows = await listLifecycle(caller);
    return rows.map((r) => [
      r.subject.code, r.subject.name, r.standing.stage, r.standing.since,
      r.standing.daysInStage, r.subject.dept, r.subject.managerId ?? '—',
      r.openTasks, r.standing.nextAction ?? '—',
    ]);
  },

  async devplans(caller) {
    const rows = await listDevPlans(caller);
    return rows.map((r) => [
      r.name, r.designation, r.plan.aspiration, r.plan.focus.join(' | '),
      r.plan.status, r.endorsed ? r.plan.endorsedOn ?? 'Yes' : 'No',
      r.plan.mentorId ?? '—', r.progress, r.overdue, r.plan.reviewOn,
    ]);
  },

  async events(caller, req) {
    const rows = await listEvents(caller, { from: req.from, to: req.to });
    return rows.map((r) => [
      r.event.title, r.event.type, r.event.on,
      r.event.online ? 'Online' : `${r.event.venue}${r.event.site ? ` · ${r.event.site}` : ''}`,
      r.organiser, r.event.status, r.audience, r.going, r.waitlisted,
      r.attendance ?? '—',
    ]);
  },

  async software(caller) {
    const rows = await listSoftware(caller);
    return rows.map((r) => [
      r.product.n, r.product.vendor, r.product.cat, r.product.seats, r.assigned,
      r.dormant, r.annualCost, r.wastedCost, r.product.renewsOn,
      r.product.ownerId ?? '—',
    ]);
  },

  async jobtitles(caller) {
    const rows = await listJobTitles(caller);
    return rows.map((r) => [
      r.title.code, r.title.n, r.title.dept, r.title.family, r.title.level,
      r.title.empType, r.title.status, r.employees,
    ]);
  },

  /* ---- the two whose module functions predate the caller-scoped pattern ---- */

  async leave(caller, req) {
    const [rows, names] = await Promise.all([listLeave(caller), nameLookup(caller)]);
    const within = rows.filter((r) =>
      (!req.from || r.to >= req.from) && (!req.to || r.from <= req.to));
    return within.map((r) => [
      r.empId, names.get(r.empId) ?? r.empId, r.type, r.from, r.to,
      r.days, r.status, r.reason,
    ]);
  },

  async assets(caller) {
    const [rows, names] = await Promise.all([listAssets(caller), nameLookup(caller)]);
    return rows.map((a) => [
      a.tag ?? '—', a.type, a.cat ?? '—', a.serial,
      a.empId ? names.get(a.empId) ?? '—' : '—',
      a.site ?? '—', a.status, a.purchased ?? '—', a.cost ?? 0, a.warrantyEnd ?? '—',
    ]);
  },
};

/** Only the datasets this caller could actually run. */
export async function datasets(caller: Caller): Promise<Dataset[]> {
  return DATASETS.filter((d) => d.roles.includes(caller.role));
}

const describe = (d: Dataset, req: ExportRequest) =>
  (d.dated && (req.from || req.to))
    ? `${req.from || 'the beginning'} to ${req.to || 'today'}`
    : 'Everything visible';

/**
 * Write the register entry.
 *
 * Its own transaction, so a refusal is recorded even though the request that
 * follows it throws. An exception that leaves no trace is the one thing this
 * register cannot afford.
 */
async function record(
  caller: Caller,
  d: Dataset,
  rows: number,
  outcome: 'Completed' | 'Refused',
  note: string,
  filters: string,
): Promise<ExportRunRecord> {
  return withTenant(caller, async (db) => {
    const { rows: out } = await db.query<{ id: string; at: string; label: string }>(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'export',
              $1,
              CASE WHEN $2::text = 'Refused' THEN 'warning'
                   WHEN $3::boolean THEN 'notice'
                   ELSE 'info' END,
              $4,
              COALESCE((SELECT full_name FROM employee WHERE id = $4), 'system'),
              'dataset',
              NULL,
              jsonb_build_object(
                'datasetId',   $5::text,
                'datasetName', $6::text,
                'byRole',      $7::text,
                'rows',        $8::int,
                'columns',     $9::int,
                'filters',     $10::text,
                'personal',    $3::boolean,
                'outcome',     $2::text,
                'note',        $11::text
              )
       RETURNING id::text, occurred_at::text AS at, actor_label AS label`,
      [
        outcome === 'Refused' ? 'export_refused' : 'export_run',
        outcome,
        d.personal,
        caller.employeeId,
        d.id,
        d.n,
        caller.role,
        rows,
        d.columns.length,
        filters,
        note,
      ],
    );
    const r = out[0];
    /* The INSERT above returns exactly one row or throws; this is the type
       system asking, not a case that can happen. */
    if (!r) throw new ExportError('The register did not record the export', 'not_recorded');
    return {
      id: r.id,
      datasetId: d.id,
      datasetName: d.n,
      byId: caller.employeeId,
      byName: r.label,
      byRole: caller.role,
      at: r.at,
      rows,
      columns: d.columns.length,
      filters,
      personal: d.personal,
      outcome,
      note,
    };
  });
}

export async function run(caller: Caller, req: ExportRequest): Promise<ExportResult> {
  const d = datasetOf(req.datasetId);
  if (!d) throw new ExportError('No such dataset', 'unknown_dataset');

  if (!d.roles.includes(caller.role)) {
    await record(caller, d, 0, 'Refused', `${caller.role} cannot export ${d.n.toLowerCase()}`,
      describe(d, req));
    throw new ExportError(`Your role cannot export ${d.n.toLowerCase()}`, 'forbidden');
  }
  if (req.from && req.to && req.from > req.to) {
    throw new ExportError('The range ends before it starts', 'bad_range');
  }

  const build = BUILDERS[d.id];
  if (!build) throw new ExportError('That dataset cannot be built', 'no_builder');

  const rows = await build(caller, req);

  /*
   * The slice is taken after the rows are built, never before. A narrower
   * request takes columns out of the dataset's full width, which means a
   * column list that does not match the catalogue cannot silently shift every
   * value one place to the left.
   */
  const keep = req.columns?.length
    ? d.columns.map((c, i) => (req.columns!.includes(c.k) ? i : -1)).filter((i) => i >= 0)
    : d.columns.map((_, i) => i);
  if (!keep.length) throw new ExportError('Choose at least one column', 'no_columns');

  const header = keep.map((i) => d.columns[i]!.n);
  const body = rows.map((r) => keep.map((i) => r[i] ?? ''));

  const entry = await record(caller, d, body.length, 'Completed', '', describe(d, req));

  return {
    run: entry,
    dataset: d,
    filename: `${d.id}_${new Date().toISOString().slice(0, 10)}.csv`,
    header,
    rows: body,
  };
}

export interface ExportFilter {
  q?: string | undefined;
  datasetId?: string | undefined;
  byId?: string | undefined;
  outcome?: 'Completed' | 'Refused' | undefined;
  personalOnly?: boolean | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * The register.
 *
 * An administrator reads all of it; everybody else reads their own. A manager
 * reading everybody's export history is surveillance with no purpose the
 * product has — and unlike most scoping here it cannot come from RLS, because
 * every row belongs to this tenant. So it is a predicate, in SQL, like the
 * rest of the role scoping.
 */
export async function history(
  caller: Caller,
  f: ExportFilter = {},
): Promise<{ run: ExportRunRecord; dataset: Dataset | null }[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (caller.role !== 'admin') {
    params.push(caller.employeeId);
    where.push(`by_id = $${params.length}`);
  }
  if (f.datasetId) { params.push(f.datasetId); where.push(`dataset_id = $${params.length}`); }
  if (f.byId) { params.push(f.byId); where.push(`by_id = $${params.length}`); }
  if (f.outcome) { params.push(f.outcome); where.push(`outcome = $${params.length}`); }
  if (f.personalOnly) where.push('personal');
  if (f.from) { params.push(f.from); where.push(`at::date >= $${params.length}`); }
  if (f.to) { params.push(f.to); where.push(`at::date <= $${params.length}`); }
  if (f.q?.trim()) {
    params.push(`%${f.q.trim()}%`);
    where.push(`(dataset_name ILIKE $${params.length} OR by_name ILIKE $${params.length})`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{
      id: string; at: string; dataset_id: string; dataset_name: string;
      by_id: string | null; by_name: string; by_role: Role; rows: number;
      columns: number; filters: string; personal: boolean;
      outcome: 'Completed' | 'Refused'; note: string;
    }>(
      `SELECT id::text, at::text, dataset_id, dataset_name, by_id::text, by_name,
              by_role, rows, columns, filters, personal, outcome, note
         FROM export_run
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY at DESC
        LIMIT 500`,
      params,
    );
    return rows.map((r) => ({
      run: {
        id: r.id,
        datasetId: r.dataset_id,
        datasetName: r.dataset_name,
        byId: r.by_id,
        byName: r.by_name,
        byRole: r.by_role,
        at: r.at,
        rows: r.rows,
        columns: r.columns,
        filters: r.filters,
        personal: r.personal,
        outcome: r.outcome,
        note: r.note,
      },
      dataset: datasetOf(r.dataset_id) ?? null,
    }));
  });
}

export interface ExportStats {
  runs: number;
  thisMonth: number;
  rows: number;
  personal: number;
  refused: number;
  people: number;
  datasets: number;
}

/**
 * The figures, aggregated in SQL rather than by counting the rows the register
 * returned. `history` is capped at 500 for the screen's sake, and a total that
 * silently meant "of the last 500" would be the kind of wrong nobody notices.
 */
export async function stats(caller: Caller): Promise<ExportStats> {
  const where = caller.role === 'admin' ? '' : 'WHERE by_id = $1';
  const params = caller.role === 'admin' ? [] : [caller.employeeId];

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Record<string, string>>(
      `SELECT count(*)::text                                            AS runs,
              count(*) FILTER (
                WHERE date_trunc('month', at) = date_trunc('month', now())
              )::text                                                   AS this_month,
              COALESCE(sum(rows) FILTER (WHERE outcome = 'Completed'), 0)::text AS rows,
              count(*) FILTER (WHERE outcome = 'Completed' AND personal)::text  AS personal,
              count(*) FILTER (WHERE outcome = 'Refused')::text          AS refused,
              count(DISTINCT by_id)::text                               AS people,
              count(DISTINCT dataset_id) FILTER (
                WHERE outcome = 'Completed'
              )::text                                                   AS datasets
         FROM export_run ${where}`,
      params,
    );
    const r = rows[0] ?? {};
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      runs: n('runs'),
      thisMonth: n('this_month'),
      rows: n('rows'),
      personal: n('personal'),
      refused: n('refused'),
      people: n('people'),
      datasets: n('datasets'),
    };
  });
}
