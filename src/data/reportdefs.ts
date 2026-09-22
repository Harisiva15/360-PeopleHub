/*
 * Last in the RNG chain, after the export register.
 */
import './exports';

import { sortBy } from '../lib/collections';
import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import { DATASETS } from './exports';

/**
 * Saved reports — a question somebody wrote down, not an answer.
 *
 * **A report stores its definition and never its results.** Running one asks
 * the same scoped dataset the export centre asks, as whoever is running it —
 * so a report written by an administrator and shared with a manager shows that
 * manager's line, not the administrator's snapshot of the company. Saving rows
 * would turn every shared report into a copy of the data with none of the
 * permissions attached, which is the single easiest way to leak a company.
 *
 * **It is built on the export datasets rather than beside them.** A second
 * catalogue with its own filters would be a second scoping rule, and the copy
 * is always the one that drifts. The difference between the two modules is
 * what they do with the rows: an export hands them over raw, a report groups
 * and counts them.
 */

export const AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export interface ReportMeasure {
  /** A column key from the dataset, or '*' for a plain row count. */
  col: string;
  agg: Aggregation;
}

export interface ReportFilterClause {
  col: string;
  op: 'is' | 'is not' | 'contains' | 'greater than' | 'less than';
  value: string;
}

export interface ReportDef {
  id: string;
  n: string;
  desc: string;
  /** Which dataset it asks. Always one of the export catalogue's. */
  datasetId: string;
  /** Column keys, in the order they appear. Empty means every column. */
  columns: string[];
  /** Null for a flat list; a column key to group and aggregate by. */
  groupBy: string | null;
  measures: ReportMeasure[];
  filters: ReportFilterClause[];
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  ownerId: string;
  /**
   * Shared reports are visible to anybody who could run the dataset.
   *
   * Visible, not resolved: see the note at the top. Sharing a report shares
   * the question.
   */
  shared: boolean;
  createdOn: string;
  lastRunOn: string | null;
  runCount: number;
}

export const REPORT_DEFS: ReportDef[] = [];

export const reportOf = (id: string) => REPORT_DEFS.find((r) => r.id === id);

export const datasetFor = (r: ReportDef) => DATASETS.find((d) => d.id === r.datasetId);

/** Columns that can be grouped by — anything that is not a running total. */
export const groupableColumns = (datasetId: string) =>
  DATASETS.find((d) => d.id === datasetId)?.columns ?? [];

/* ---------------- a few somebody would actually have written ---------------- */

const SEEDS: Omit<ReportDef, 'id' | 'ownerId' | 'createdOn' | 'lastRunOn' | 'runCount'>[] = [
  {
    n: 'Headcount by department',
    desc: 'How many people sit in each department, for the monthly pack.',
    datasetId: 'employees',
    columns: ['dept', 'name'],
    groupBy: 'dept',
    measures: [{ col: '*', agg: 'count' }],
    filters: [{ col: 'status', op: 'is', value: 'Active' }],
    sort: { col: 'count', dir: 'desc' },
    shared: true,
  },
  {
    n: 'Who is stuck in a stage',
    desc: 'Anybody who has been in the same lifecycle stage more than 60 days.',
    datasetId: 'lifecycle',
    columns: ['name', 'stage', 'days', 'nextAction'],
    groupBy: null,
    measures: [],
    filters: [{ col: 'days', op: 'greater than', value: '60' }],
    sort: { col: 'days', dir: 'desc' },
    shared: true,
  },
  {
    n: 'Software spend by vendor',
    desc: 'What each vendor costs us a year, and what of it is idle.',
    datasetId: 'software',
    columns: ['vendor', 'annualCost', 'wastedCost'],
    groupBy: 'vendor',
    measures: [
      { col: 'annualCost', agg: 'sum' },
      { col: 'wastedCost', agg: 'sum' },
    ],
    filters: [],
    sort: { col: 'annualCost', dir: 'desc' },
    shared: true,
  },
  {
    n: 'Development coverage by department',
    desc: 'How many plans each department has, and how far through they are.',
    datasetId: 'devplans',
    columns: ['name', 'status', 'progress'],
    groupBy: 'status',
    measures: [
      { col: '*', agg: 'count' },
      { col: 'progress', agg: 'avg' },
    ],
    filters: [],
    sort: null,
    shared: true,
  },
  {
    n: 'Turnout by kind of event',
    desc: 'Which sorts of event people actually come to.',
    datasetId: 'events',
    columns: ['type', 'going', 'attendance'],
    groupBy: 'type',
    measures: [
      { col: '*', agg: 'count' },
      { col: 'going', agg: 'sum' },
      { col: 'attendance', agg: 'avg' },
    ],
    filters: [],
    sort: { col: 'attendance', dir: 'desc' },
    shared: true,
  },
  {
    n: 'My team, by title',
    desc: 'A private one — who reports to me and what they are called.',
    datasetId: 'employees',
    columns: ['name', 'designation', 'doj'],
    groupBy: 'designation',
    measures: [{ col: '*', agg: 'count' }],
    filters: [],
    sort: null,
    shared: false,
  },
];

(function genReports() {
  const authors = ACTIVE().filter((e) => e.role === 'admin' || e.role === 'manager');
  if (!authors.length) return;

  SEEDS.forEach((seed) => {
    const createdOn = ymd(addDays(TODAY, -ri(10, 240)));
    /*
     * A report that has never been run is a different thing from one somebody
     * opens every Monday, and the list is more useful sorted by that.
     */
    const runs = seed.shared ? ri(2, 60) : ri(0, 8);
    REPORT_DEFS.push({
      ...seed,
      id: uid('RPT'),
      ownerId: pick(authors).id,
      createdOn,
      lastRunOn: runs ? ymd(addDays(TODAY, -ri(0, 21))) : null,
      runCount: runs,
    });
  });

  /* A couple of private ones so the "mine / shared" split has both sides. */
  for (let i = 0; i < 3; i++) {
    const base = pick(SEEDS);
    REPORT_DEFS.push({
      ...base,
      n: `${base.n} (working copy)`,
      desc: 'A private variation somebody was trying out.',
      id: uid('RPT'),
      ownerId: pick(authors).id,
      shared: false,
      createdOn: ymd(addDays(TODAY, -ri(1, 60))),
      lastRunOn: chance(0.6) ? ymd(addDays(TODAY, -ri(0, 30))) : null,
      runCount: ri(0, 5),
    });
  }
})();

export const reportsVisibleTo = (empId: string, role: string) =>
  sortBy(
    REPORT_DEFS.filter((r) => r.shared || r.ownerId === empId || role === 'admin'),
    (r) => -r.runCount,
  );

export const ownerName = (id: string) => EMAP[id]?.name ?? id;
