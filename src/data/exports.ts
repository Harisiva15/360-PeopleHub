/*
 * Last in the RNG chain, after the events calendar.
 */
import './events';

import { sortBy } from '../lib/collections';
import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import type { AppRole } from '../types/employee';

/**
 * The export register — what left the building, and who took it.
 *
 * **The register keeps metadata and never the data.** It records that Priya
 * exported 214 rows of the employee directory on Tuesday; it does not keep the
 * 214 rows. A log that held the files would turn the audit trail into the
 * largest collection of personal data in the product, sitting behind whatever
 * permissions the audit screen happens to have. Exports are generated live
 * from the services each time, and what is left behind is the fact of them.
 *
 * **An export cannot see more than the person can.** That is the rule the
 * module exists to keep, and it is structural rather than careful: a dataset
 * is either built by calling a service that takes the caller — in which case
 * the scoping is the same code the screen runs — or it is restricted to
 * administrators. There is no third option where somebody hand-writes a filter
 * and hopes. `scope` below records which of the two each dataset is, and the
 * check refuses any dataset that is neither.
 */

export type DatasetScope =
  /** Built from a service that takes the caller, so the screen's rules apply. */
  | 'caller'
  /** Built from a service that has no caller, so nobody but an admin may run it. */
  | 'admin-only';

export interface DatasetColumn {
  k: string;
  n: string;
  /** Marks a column that is personal data, for the sensitivity warning. */
  personal?: boolean;
}

export interface Dataset {
  id: string;
  n: string;
  desc: string;
  /** A name in `src/components/icons.tsx`, not a glyph. */
  ic: string;
  roles: AppRole[];
  scope: DatasetScope;
  /**
   * True where the rows are about identifiable people in a way that would
   * matter if the file were left on a train.
   */
  personal: boolean;
  columns: DatasetColumn[];
  /** Whether the dataset takes a date range at all. */
  dated: boolean;
}

/**
 * What can be taken out.
 *
 * Deliberately short. Every dataset here is one somebody has a reason to open
 * in a spreadsheet — a catalogue of forty exports, most of which nobody has
 * ever run, is a menu people scroll past rather than a tool.
 */
export const DATASETS: Dataset[] = [
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
  /*
   * From here down, the services have no caller and do their scoping in the
   * screen. Exporting through them would hand a manager the whole company, so
   * they are administrators only — see the note at the top of this file.
   */
  {
    id: 'leave',
    n: 'Leave requests',
    desc: 'Every request in the period, with its type, days and outcome.',
    ic: 'leave',
    roles: ['admin'],
    scope: 'admin-only',
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
    scope: 'admin-only',
    /* It names who holds each item, which makes it a list of people with
       their kit — personal data, however much it reads as an inventory. */
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

export const datasetOf = (id: string) => DATASETS.find((d) => d.id === id);

export type ExportOutcome = 'Completed' | 'Refused';

/**
 * One export, as it will be remembered.
 *
 * Note what is not here: the rows. See the note at the top of the file — this
 * is the record of an access, not a copy of what was accessed.
 */
export interface ExportRun {
  id: string;
  datasetId: string;
  /** Kept as text because a dataset could be retired and the record must still read. */
  datasetName: string;
  byId: string;
  byName: string;
  byRole: AppRole;
  /** Date and time, because two exports on one afternoon need an order. */
  at: string;
  /** How many rows left. Zero on a refusal. */
  rows: number;
  columns: number;
  /** The range and filters in words, so the record can be read without the code. */
  filters: string;
  personal: boolean;
  outcome: ExportOutcome;
  /** Why it was refused, where it was. */
  note: string;
}

export const EXPORT_LOG: ExportRun[] = [];

/** Newest first, which is the only order anybody reads an audit log in. */
export const exportHistory = () => sortBy(EXPORT_LOG, (r) => r.at, 'desc');

export const exportsBy = (empId: string) => exportHistory().filter((r) => r.byId === empId);

export function exportKPI(scope: ExportRun[] = EXPORT_LOG, asOf = ymd(TODAY)) {
  const month = asOf.slice(0, 7);
  const done = scope.filter((r) => r.outcome === 'Completed');
  return {
    runs: scope.length,
    thisMonth: scope.filter((r) => r.at.slice(0, 7) === month).length,
    rows: done.reduce((n, r) => n + r.rows, 0),
    personal: done.filter((r) => r.personal).length,
    refused: scope.filter((r) => r.outcome === 'Refused').length,
    /* Somebody taking personal data out repeatedly is the pattern worth seeing. */
    people: new Set(scope.map((r) => r.byId)).size,
    datasets: new Set(done.map((r) => r.datasetId)).size,
  };
}

/* ---------------- a history to read ---------------- */

(function genExportHistory() {
  const admins = ACTIVE().filter((e) => e.role === 'admin');
  const managers = ACTIVE().filter((e) => e.role === 'manager');
  if (!admins.length) return;

  for (let i = 0; i < 34; i++) {
    /*
     * Weighted towards administrators, because they are the ones with anything
     * much to take. A register where every role exports equally would misread
     * the risk it exists to show.
     */
    const who = chance(0.7) || !managers.length ? pick(admins) : pick(managers);
    const allowed = DATASETS.filter((d) => d.roles.includes(who.role));
    /*
     * Some runs are refusals — a manager reaching for payroll-shaped data. The
     * register is more useful for holding those than for holding only the
     * successes, and a log with no refusals in it has usually been filtered.
     */
    const refusal = chance(0.12);
    const d = refusal
      ? pick(DATASETS.filter((x) => !x.roles.includes(who.role))) ?? pick(allowed)
      : pick(allowed);
    if (!d) continue;

    const day = ymd(addDays(TODAY, -ri(0, 180)));
    const at = `${day} ${String(ri(8, 19)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}`;
    const refused = !d.roles.includes(who.role);

    EXPORT_LOG.push({
      id: uid('EXP'),
      datasetId: d.id,
      datasetName: d.n,
      byId: who.id,
      byName: who.name,
      byRole: who.role,
      at,
      rows: refused ? 0 : ri(4, 260),
      columns: d.columns.length,
      filters: d.dated
        ? `${ymd(addDays(TODAY, -ri(60, 365)))} to ${day}`
        : 'Everything visible',
      personal: d.personal,
      outcome: refused ? 'Refused' : 'Completed',
      note: refused ? `${who.role} cannot export ${d.n.toLowerCase()}` : '',
    });
  }
})();

export const exporterName = (id: string) => EMAP[id]?.name ?? id;
