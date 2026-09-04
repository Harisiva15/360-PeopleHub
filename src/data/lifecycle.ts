/* Shares the RNG stream with shifts — this import fixes the draw order. */
import './shifts';

import { sortBy } from '../lib/collections';
import { addDays, parseYmd, TODAY, yearsSince, ymd } from '../lib/dates';
import { inr } from '../lib/format';
import { chance, pick, ri, rnd } from '../lib/rng';
import { ACTIVE, empName } from './employees';
import { deptOf, siteOf, SITES } from './org';
import { CYCLES } from './performance';

export interface LifecycleEvent {
  on: string;
  type: string;
  note: string;
  /** Prior value, where the event is a change. */
  from: string | null;
  to: string | null;
}

/** empId -> events, newest first. */
export const LIFECYCLE: Record<string, LifecycleEvent[]> = {};

(function genLifecycle() {
  ACTIVE().forEach((e) => {
    const ev: LifecycleEvent[] = [
      {
        on: e.doj,
        type: 'Joined',
        note: e.designation + ' · ' + deptOf(e.dept).name,
        from: null,
        to: inr(Math.round(e.ctc / (1 + yearsSince(e.doj) * 0.11))),
      },
    ];

    const yrs = yearsSince(e.doj);
    /* work backwards from today's CTC to reconstruct the increment history */
    let ctc = Math.round(e.ctc / Math.pow(1.11, Math.max(0, yrs)));

    if (yrs >= 1)
      ev.push({
        on: ymd(addDays(parseYmd(e.doj), 190)),
        type: 'Confirmation',
        note: 'Probation completed, confirmed in role',
        from: null,
        to: null,
      });

    for (let y = 1; y <= yrs; y++) {
      const prev = ctc;
      const hike = 8 + Math.round(rnd() * 9);
      ctc = Math.round((prev * (1 + hike / 100)) / 1000) * 1000;
      ev.push({
        on: ymd(new Date(parseYmd(e.doj).getFullYear() + y, 9, 1)),
        type: 'Salary Revision',
        note: hike + '% increment · ' + CYCLES[0].name.replace('H2 ', ''),
        from: inr(prev),
        to: inr(ctc),
      });
      if (y === 2 || y === 4)
        ev.push({
          on: ymd(new Date(parseYmd(e.doj).getFullYear() + y, 9, 1)),
          type: 'Promotion',
          note: 'Promoted within band',
          from: 'Grade ' + (e.grade === 'L1' ? 'L1' : 'L' + Math.max(1, +e.grade[1] - 1)),
          to: 'Grade ' + e.grade,
        });
    }

    if (chance(0.14))
      ev.push({
        on: ymd(addDays(TODAY, -ri(60, 500))),
        type: 'Transfer',
        note: 'Location change',
        from: pick(SITES.filter((s) => s.lat)).name,
        to: siteOf(e.site).name,
      });

    if (chance(0.12))
      ev.push({
        on: ymd(addDays(TODAY, -ri(60, 400))),
        type: 'Manager Change',
        note: 'Reporting line updated after a team restructure',
        from: null,
        to: empName(e.managerId || ''),
      });

    LIFECYCLE[e.id] = sortBy(
      ev.filter((x) => x.on <= ymd(TODAY)),
      (x) => x.on,
      'desc',
    );
  });
})();
