/* Shares the RNG stream with leave — this import fixes the draw order. */
import './leave';

import { sum, uniq } from '../lib/collections';
import { addDays, isWeekend, mondayOf, TODAY, ymd } from '../lib/dates';
import { clamp } from '../lib/format';
import { pick, ri } from '../lib/rng';
import { attOf } from './attendance';
import { ACTIVE } from './employees';
import { HOLIDAY_MAP, PROJECTS, TASK_TYPES } from './org';

export type TSStatus = 'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Missing';

export interface TSRow {
  proj: string;
  task: string;
  /** Hours Monday through Sunday. */
  h: number[];
}

export interface Timesheet {
  id: string;
  empId: string;
  /** Monday of the week, as `YYYY-MM-DD`. */
  weekStart: string;
  rows: TSRow[];
  total: number;
  status: TSStatus;
  approverId: string | null;
  submittedOn: string | null;
  note: string;
}

export const TS: Timesheet[] = [];

(function genTS() {
  const weeks = 8;
  ACTIVE().forEach((e) => {
    const myProjects = uniq([
      pick(PROJECTS).id,
      pick(PROJECTS).id,
      e.dept === 'SUP' ? 'P-SUP' : e.dept === 'SALES' ? 'P-PRESALES' : 'P-ATLAS',
    ]);

    for (let w = weeks - 1; w >= 0; w--) {
      const ws = mondayOf(addDays(TODAY, -w * 7));
      if (ymd(ws) < e.doj) continue;

      const rows: TSRow[] = myProjects.slice(0, ri(2, 3)).map((p) => ({
        proj: p,
        task: pick(TASK_TYPES),
        h: [0, 0, 0, 0, 0, 0, 0],
      }));

      /* spread each day's capacity across the week's projects, from attendance */
      for (let d = 0; d < 7; d++) {
        const ds = ymd(addDays(ws, d));
        const a = attOf(e.id, ds);
        let cap = 0;
        if (a && (a.status === 'P' || a.status === 'W')) cap = clamp(Math.round(a.mins / 60), 4, 9);
        else if (!a && ds <= ymd(TODAY) && !isWeekend(addDays(ws, d)) && !HOLIDAY_MAP[ds]) cap = 8;
        if (ds > ymd(TODAY)) cap = 0;

        let left = cap;
        rows.forEach((r, i) => {
          if (left <= 0) return;
          const give =
            i === rows.length - 1 ? left : Math.min(left, ri(1, Math.max(1, Math.round(cap / rows.length) + 2)));
          r.h[d] = give;
          left -= give;
        });
      }

      const total = sum(rows, (r) => sum(r.h));
      const isCurrent = w === 0;
      const st: TSStatus = isCurrent
        ? 'Draft'
        : w === 1
          ? pick(['Submitted', 'Submitted', 'Approved'] as TSStatus[])
          : pick(['Approved', 'Approved', 'Approved', 'Approved', 'Rejected'] as TSStatus[]);

      TS.push({
        id: 'TS-' + e.id + '-' + ymd(ws),
        empId: e.id,
        weekStart: ymd(ws),
        rows,
        total,
        status: total === 0 && !isCurrent ? 'Missing' : st,
        approverId: e.managerId,
        submittedOn: st === 'Draft' ? null : ymd(addDays(ws, 5)),
        note: st === 'Rejected' ? 'Please split the Atlas hours by task type.' : '',
      });
    }
  });
})();

export const tsOf = (empId: string, ws: string): Timesheet | undefined =>
  TS.find((t) => t.empId === empId && t.weekStart === ws);
