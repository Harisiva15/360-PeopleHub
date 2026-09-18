/**
 * Timesheets, in memory.
 *
 * Mirrors the server's rules rather than approximating them, because these are
 * the rules the screens are written against: a day cannot exceed 24 hours in
 * total (not per line — the per-line cap would wave through four seven-hour
 * entries), a week cannot exceed 168, and a submitted sheet is not editable
 * until it is recalled.
 */

import { TODAY, ymd } from '../../lib/dates';
import { DEMO_EMP, EMAP } from '../../data/employees';
import { PROJECTS } from '../../data/org';
import { TS, totalsOf } from '../../data/timesheet';
import type { Timesheet, TSEntry } from '../../data/timesheet';
import type { EntryDraft, TimesheetService } from '../contracts';
import { ok } from './util';

const MAX_DAY_HOURS = 24;
const MAX_WEEK_HOURS = 168;
const DAYS = 7;

let seq = 9000;
const nextId = () => `TSE-${seq += 1}`;

const find = (id: string): Timesheet | undefined => TS.find((t) => t.id === id);
const missing = (id: string) => Promise.reject(new Error('No such timesheet: ' + id));

/** Totals are recomputed from the entries after every write. */
function recalc(t: Timesheet): Timesheet {
  Object.assign(t, totalsOf(t.entries));
  return t;
}

/** Draft and returned are the two states somebody can type into. */
function editable(t: Timesheet): Error | null {
  if (t.status === 'Draft' || t.status === 'Returned') return null;
  return new Error(`A ${t.status.toLowerCase()} timesheet cannot be edited — recall it first`);
}

const dayOffset = (weekStart: string, date: string) =>
  Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / 86_400_000,
  );

/** Everything the server would refuse, refused the same way and in the same order. */
function validate(
  t: Timesheet,
  draft: EntryDraft,
  excludeId: string | null,
): Error | number {
  if (!draft.proj?.trim()) return new Error('Choose a project');
  if (!draft.task?.trim()) return new Error('Say what the work was');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date ?? '')) return new Error('Choose a day');

  const offset = dayOffset(t.weekStart, draft.date);
  if (Number.isNaN(offset) || offset < 0 || offset >= DAYS) {
    return new Error('That day is not in this week');
  }
  if (!PROJECTS.some((p) => p.id === draft.proj)) {
    return new Error('No such project: ' + draft.proj);
  }

  const hours = Number(draft.hours ?? 0);
  if (!Number.isFinite(hours)) return new Error('Hours must be a number');
  if (hours < 0) return new Error('Hours cannot be negative');
  if (hours > MAX_DAY_HOURS) return new Error(`${MAX_DAY_HOURS} hours is the most in a day`);

  const others = t.entries.filter((e) => e.id !== excludeId);
  const day = others.filter((e) => e.date === draft.date).reduce((n, e) => n + e.hours, 0) + hours;
  if (day > MAX_DAY_HOURS) {
    return new Error(`That would put ${day} hours on one day — the most there is is ${MAX_DAY_HOURS}`);
  }
  const week = others.reduce((n, e) => n + e.hours, 0) + hours;
  if (week > MAX_WEEK_HOURS) {
    return new Error(`That would put ${week} hours in the week — the most there is is ${MAX_WEEK_HOURS}`);
  }

  return Math.round(hours * 100) / 100;
}

export const timesheetService: TimesheetService = {
  list(q) {
    let out = TS.slice();
    if (q.empIds?.length) {
      const want = new Set(q.empIds);
      out = out.filter((t) => want.has(t.empId));
    }
    if (q.weekStart) out = out.filter((t) => t.weekStart === q.weekStart);
    if (q.since) out = out.filter((t) => t.weekStart >= q.since!);
    if (q.status) out = out.filter((t) => t.status === q.status);
    return ok(out.sort((a, b) => b.weekStart.localeCompare(a.weekStart)));
  },

  forWeek(empId, weekStart) {
    const found = TS.find((t) => t.empId === empId && t.weekStart === weekStart);
    if (found) return ok(found);
    /* A week nobody has touched is an empty draft, not an absence. */
    const made: Timesheet = {
      id: `TS-${seq += 1}`,
      empId,
      weekStart,
      entries: [],
      total: 0,
      billable: 0,
      nonBillable: 0,
      status: 'Draft',
      approverId: null,
      submittedOn: null,
      actedOn: null,
      note: '',
    };
    TS.unshift(made);
    return ok(made);
  },

  addEntry(id, draft) {
    const t = find(id);
    if (!t) return missing(id);
    const stop = editable(t);
    if (stop) return Promise.reject(stop);

    const hours = validate(t, draft, null);
    if (hours instanceof Error) return Promise.reject(hours);

    /* Same project, task and day is the same line — it merges. */
    const same = t.entries.find(
      (e) => e.date === draft.date && e.proj === draft.proj && e.task === draft.task.trim());
    if (same) {
      same.hours = Math.round((same.hours + hours) * 100) / 100;
      same.billable = draft.billable ?? same.billable;
      if (draft.remarks?.trim()) same.remarks = draft.remarks.trim();
      return ok(recalc(t));
    }

    const entry: TSEntry = {
      id: nextId(),
      date: draft.date,
      proj: draft.proj,
      task: draft.task.trim(),
      billable: draft.billable ?? true,
      hours,
      remarks: (draft.remarks ?? '').trim(),
    };
    t.entries.push(entry);
    t.entries.sort((a, b) => a.date.localeCompare(b.date) || a.proj.localeCompare(b.proj));
    return ok(recalc(t));
  },

  updateEntry(id, entryId, patch) {
    const t = find(id);
    if (!t) return missing(id);
    const stop = editable(t);
    if (stop) return Promise.reject(stop);

    const e = t.entries.find((x) => x.id === entryId);
    if (!e) return Promise.reject(new Error('No such entry: ' + entryId));

    const next: EntryDraft = {
      date: patch.date ?? e.date,
      proj: patch.proj ?? e.proj,
      task: patch.task ?? e.task,
      billable: patch.billable ?? e.billable,
      hours: patch.hours ?? e.hours,
      remarks: patch.remarks ?? e.remarks,
    };
    const hours = validate(t, next, entryId);
    if (hours instanceof Error) return Promise.reject(hours);

    Object.assign(e, {
      date: next.date,
      proj: next.proj,
      task: next.task!.trim(),
      billable: next.billable,
      hours,
      remarks: (next.remarks ?? '').trim(),
    });
    t.entries.sort((a, b) => a.date.localeCompare(b.date) || a.proj.localeCompare(b.proj));
    return ok(recalc(t));
  },

  removeEntry(id, entryId) {
    const t = find(id);
    if (!t) return missing(id);
    const stop = editable(t);
    if (stop) return Promise.reject(stop);

    const i = t.entries.findIndex((x) => x.id === entryId);
    if (i < 0) return Promise.reject(new Error('No such entry: ' + entryId));
    t.entries.splice(i, 1);
    return ok(recalc(t));
  },

  setComment(id, note) {
    const t = find(id);
    if (!t) return missing(id);
    const stop = editable(t);
    if (stop) return Promise.reject(stop);
    t.note = (note ?? '').trim();
    return ok(t);
  },

  copyPreviousWeek(id) {
    const t = find(id);
    if (!t) return missing(id);
    const stop = editable(t);
    if (stop) return Promise.reject(stop);
    if (t.entries.length) {
      return Promise.reject(new Error('This week already has entries — clear them first'));
    }

    const prevStart = ymd(new Date(Date.parse(`${t.weekStart}T00:00:00Z`) - 7 * 86_400_000));
    const prev = TS.find((x) => x.empId === t.empId && x.weekStart === prevStart);
    if (!prev || !prev.entries.length) {
      return Promise.reject(new Error('There is no previous week to copy'));
    }

    t.entries = prev.entries.map((e) => ({
      ...e,
      id: nextId(),
      date: ymd(new Date(Date.parse(`${e.date}T00:00:00Z`) + 7 * 86_400_000)),
    }));
    return ok(recalc(t));
  },

  submit(id) {
    const t = find(id);
    if (!t) return missing(id);
    const stop = editable(t);
    if (stop) return Promise.reject(stop);
    if (t.total <= 0) return Promise.reject(new Error('There are no hours to submit'));
    if (t.entries.some((e) => !e.task.trim())) {
      return Promise.reject(new Error('Every line needs a task before this can go'));
    }
    t.status = 'Submitted';
    t.submittedOn = ymd(TODAY);
    t.actedOn = null;
    return ok(t);
  },

  recall(id) {
    const t = find(id);
    if (!t) return missing(id);
    if (t.status !== 'Submitted') {
      return Promise.reject(
        new Error(`Only a submitted timesheet can be recalled — this one is ${t.status.toLowerCase()}`));
    }
    t.status = 'Draft';
    t.submittedOn = null;
    return ok(t);
  },

  decide(id, decision, note) {
    const t = find(id);
    if (!t) return missing(id);
    if (t.status !== 'Submitted') {
      return Promise.reject(new Error(`That timesheet is ${t.status.toLowerCase()}, not awaiting a decision`));
    }
    if (t.empId === DEMO_EMP.id) {
      return Promise.reject(new Error('You cannot decide your own timesheet'));
    }
    if (decision !== 'Approved' && !note?.trim()) {
      return Promise.reject(new Error('Say what needs fixing — the employee sees this'));
    }
    t.status = decision;
    /*
     * The server stamps the approver from the session token. There is no
     * session here, so the mock records the person who would have decided it —
     * the employee's reporting manager. Leaving it null instead would make the
     * approver column look permanently empty in the demo, which is a worse lie
     * than naming the one person it was always going to be.
     */
    t.approverId = EMAP[t.empId]?.managerId ?? t.approverId;
    t.actedOn = ymd(TODAY);
    if (note?.trim()) t.note = note.trim();
    return ok(t);
  },
};
