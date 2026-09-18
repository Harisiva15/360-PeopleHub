/* Shares the RNG stream with leave — this import fixes the draw order. */
import './leave';

import { addDays, mondayOf, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import { PROJECTS } from './org';

/**
 * A timesheet is a list of entries, not a grid.
 *
 * One entry is one project, one task, one day. That is exactly what
 * `timesheet_entry` has always held, and the weekly grid this used to be — a
 * row per project/task with seven day-columns — was a rendering of it that had
 * leaked into the type.
 *
 * The grid could not say that the same project had billable and non-billable
 * hours in one week, because `billable` came off the project rather than the
 * entry. Consulting work does that every day: client development in the
 * morning, internal standup in the afternoon.
 */
export type TSStatus = 'Draft' | 'Submitted' | 'Approved' | 'Returned' | 'Rejected';

export interface TSEntry {
  id: string;
  /** The day the work happened, as `YYYY-MM-DD`. */
  date: string;
  /** Project code. */
  proj: string;
  task: string;
  billable: boolean;
  hours: number;
  remarks: string;
}

export interface Timesheet {
  id: string;
  empId: string;
  /** Monday of the week, as `YYYY-MM-DD`. */
  weekStart: string;
  entries: TSEntry[];
  total: number;
  billable: number;
  nonBillable: number;
  status: TSStatus;
  approverId: string | null;
  submittedOn: string | null;
  actedOn: string | null;
  /** The employee's note to their manager, or the manager's reason back. */
  note: string;
}

/** What somebody might have been doing, by whether the project bills. */
const BILLABLE_TASKS = [
  'Requirements Analysis', 'Development', 'Code Review', 'Testing',
  'Deployment', 'Client Call', 'Bug Fixing',
];
const INTERNAL_TASKS = [
  'Product Meeting', 'Sprint Planning', 'Training', 'Recruitment',
  'Internal Review', 'Documentation',
];

export const TS: Timesheet[] = [];

/** Totals from the entries, so the three figures always reconcile. */
export function totalsOf(entries: TSEntry[]): {
  total: number; billable: number; nonBillable: number;
} {
  const round = (n: number) => Math.round(n * 100) / 100;
  const total = round(entries.reduce((n, e) => n + e.hours, 0));
  const billable = round(entries.filter((e) => e.billable).reduce((n, e) => n + e.hours, 0));
  return { total, billable, nonBillable: round(total - billable) };
}

(function genTimesheets() {
  const billableProjects = PROJECTS.filter((p) => p.billable);
  const internalProjects = PROJECTS.filter((p) => !p.billable);

  ACTIVE().forEach((e) => {
    /* Eight weeks back, so the history tab and the trends have something. */
    for (let w = 0; w < 8; w += 1) {
      const weekStart = ymd(addDays(mondayOf(TODAY), -7 * w));
      const entries: TSEntry[] = [];

      const main = pick(billableProjects) ?? PROJECTS[0]!;
      for (let d = 0; d < 5; d += 1) {
        const date = ymd(addDays(new Date(weekStart + 'T00:00:00'), d));

        /* Most days are one project all day; some are split with something internal. */
        if (chance(0.25) && internalProjects.length) {
          const split = pick([2, 4]);
          entries.push({
            id: uid('TSE'),
            date,
            proj: pick(internalProjects)!.id,
            task: pick(INTERNAL_TASKS),
            billable: false,
            hours: split,
            remarks: pick(['Roadmap discussion', 'Team sync', 'Knowledge sharing', '']),
          });
          entries.push({
            id: uid('TSE'),
            date,
            proj: main.id,
            task: pick(BILLABLE_TASKS),
            billable: true,
            hours: 8 - split,
            remarks: pick(['Feature work', 'Reviewed the pipeline', '']),
          });
        } else {
          entries.push({
            id: uid('TSE'),
            date,
            proj: main.id,
            task: pick(BILLABLE_TASKS),
            billable: true,
            hours: 8,
            remarks: pick(['Feature development', 'Unit and integration testing',
              'Requirement review with client', '']),
          });
        }
      }

      const t = totalsOf(entries);
      /* This week is still being filled in; older ones have been decided. */
      const status: TSStatus = w === 0 ? 'Draft'
        : w === 1 ? pick(['Submitted', 'Approved'] as TSStatus[])
          : chance(0.1) ? 'Returned' : 'Approved';

      TS.push({
        id: uid('TS'),
        empId: e.id,
        weekStart,
        entries,
        ...t,
        status,
        approverId: status === 'Draft' || status === 'Submitted' ? null : e.managerId,
        submittedOn: status === 'Draft' ? null : ymd(addDays(new Date(weekStart + 'T00:00:00'), 5)),
        actedOn: ['Approved', 'Returned', 'Rejected'].includes(status)
          ? ymd(addDays(new Date(weekStart + 'T00:00:00'), 6 + ri(0, 2))) : null,
        note: status === 'Returned' ? 'Please split the Friday hours by task.' : '',
      });
    }
  });
})();
