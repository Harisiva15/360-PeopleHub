import { sum } from '../../lib/collections';
import { TODAY, ymd } from '../../lib/dates';
import { EMAP } from '../../data/employees';
import { TS, tsOf } from '../../data/timesheet';
import type { Timesheet } from '../../data/timesheet';
import type { TimesheetService } from '../contracts';
import { ok } from './util';

const find = (id: string): Timesheet | undefined => TS.find((t) => t.id === id);

const missing = (id: string) => Promise.reject(new Error('No such timesheet: ' + id));

/** The total is derived, never stored by the caller. */
function recalc(t: Timesheet): Timesheet {
  t.total = sum(t.rows, (r) => sum(r.h));
  return t;
}

export const timesheetService: TimesheetService = {
  list(q) {
    let out = TS.slice();
    if (q.empIds) {
      const want = new Set(q.empIds);
      out = out.filter((t) => want.has(t.empId));
    }
    if (q.weekStart) out = out.filter((t) => t.weekStart === q.weekStart);
    if (q.since) out = out.filter((t) => t.weekStart >= q.since!);
    if (q.status) out = out.filter((t) => t.status === q.status);
    return ok(out);
  },

  forWeek(empId, weekStart) {
    const found = tsOf(empId, weekStart);
    if (found) return ok(found);
    const row: Timesheet = {
      id: 'TS-' + empId + '-' + weekStart,
      empId,
      weekStart,
      rows: [],
      total: 0,
      status: 'Draft',
      approverId: EMAP[empId]?.managerId ?? null,
      submittedOn: null,
      note: '',
    };
    TS.push(row);
    return ok(row);
  },

  addRow(id, proj, task) {
    const t = find(id);
    if (!t) return missing(id);
    t.rows.push({ proj, task, h: [0, 0, 0, 0, 0, 0, 0] });
    return ok(recalc(t));
  },

  removeRow(id, rowIndex) {
    const t = find(id);
    if (!t) return missing(id);
    t.rows.splice(rowIndex, 1);
    return ok(recalc(t));
  },

  setRow(id, rowIndex, patch) {
    const t = find(id);
    if (!t) return missing(id);
    const row = t.rows[rowIndex];
    if (!row) return Promise.reject(new Error('No row ' + rowIndex + ' on ' + id));
    if (patch.proj !== undefined) row.proj = patch.proj;
    if (patch.task !== undefined) row.task = patch.task;
    return ok(recalc(t));
  },

  setHours(id, rowIndex, dayIndex, hours) {
    const t = find(id);
    if (!t) return missing(id);
    const row = t.rows[rowIndex];
    if (!row) return Promise.reject(new Error('No row ' + rowIndex + ' on ' + id));
    row.h[dayIndex] = hours;
    return ok(recalc(t));
  },

  submit(id) {
    const t = find(id);
    if (!t) return missing(id);
    if (!t.total) return Promise.reject(new Error('Log at least one hour before submitting'));
    t.status = 'Submitted';
    t.submittedOn = ymd(TODAY);
    t.note = '';
    return ok(t);
  },

  recall(id) {
    const t = find(id);
    if (!t) return missing(id);
    if (t.status !== 'Submitted') return Promise.reject(new Error('Only a submitted sheet can be recalled'));
    t.status = 'Draft';
    t.submittedOn = null;
    return ok(t);
  },

  approve(id, approverId) {
    const t = find(id);
    if (!t) return missing(id);
    if (t.status === 'Approved') return Promise.reject(new Error('Already approved'));
    t.status = 'Approved';
    t.approverId = approverId;
    return ok(t);
  },

  reject(id, approverId, note) {
    const t = find(id);
    if (!t) return missing(id);
    t.status = 'Rejected';
    t.approverId = approverId;
    t.note = note;
    return ok(t);
  },
};
