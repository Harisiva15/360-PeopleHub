/* Shares the RNG stream with learning — this import fixes the draw order. */
import './learning';

import { addDays, isWeekend, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import { empSeqHash } from './performance';

export interface Shift {
  id: string;
  n: string;
  start: string;
  end: string;
  /** Unpaid break, in minutes. */
  brk: number;
  /** Late-arrival grace, in minutes. */
  grace: number;
  c: string;
  night: boolean;
  /** Per-shift night allowance, where one applies. */
  allowance?: number;
}

export const SHIFTS: Shift[] = [
  { id: 'GEN', n: 'General', start: '09:30', end: '18:30', brk: 45, grace: 20, c: 'var(--s1)', night: false },
  { id: 'EARLY', n: 'Early (EMEA)', start: '07:00', end: '16:00', brk: 45, grace: 15, c: 'var(--s3)', night: false },
  { id: 'MID', n: 'Mid (US East)', start: '14:00', end: '23:00', brk: 45, grace: 15, c: 'var(--s4)', night: false },
  { id: 'NIGHT', n: 'Night (US West)', start: '22:00', end: '07:00', brk: 60, grace: 15, c: 'var(--s7)', night: true, allowance: 350 },
  { id: 'FLEX', n: 'Flexible', start: '—', end: '—', brk: 45, grace: 0, c: 'var(--s5)', night: false },
];

export const shiftOf = (id: string): Shift => SHIFTS.find((s) => s.id === id) || SHIFTS[0];

/** empId -> date -> shift id, or 'OFF'. */
export const ROSTER: Record<string, Record<string, string>> = {};

/** Only these departments run a rotational roster; everyone else is general shift. */
export const ROSTER_DEPTS = ['SUP', 'DEVOPS'];

(function genRoster() {
  ACTIVE().forEach((e) => {
    ROSTER[e.id] = {};
    const rotational = ROSTER_DEPTS.includes(e.dept);
    for (let i = -7; i <= 20; i++) {
      const d = addDays(TODAY, i);
      const ds = ymd(d);
      if (!rotational) {
        ROSTER[e.id][ds] = isWeekend(d) ? 'OFF' : 'GEN';
        continue;
      }
      /* rotate the shift weekly, and stagger week-offs per person */
      const wk = Math.floor((i + 7) / 7);
      const cycle = (empSeqHash(e.id) + wk) % 4;
      const off = d.getDay() === empSeqHash(e.id) % 7 || d.getDay() === (empSeqHash(e.id) + 1) % 7;
      ROSTER[e.id][ds] = off ? 'OFF' : ['GEN', 'EARLY', 'MID', 'NIGHT'][cycle];
    }
  });
})();

export interface Overtime {
  id: string;
  empId: string;
  date: string;
  hours: number;
  reason: string;
  status: 'Pending' | 'Approved';
  compensation: 'Comp Off' | 'Overtime Pay';
  approverId: string | null;
}

export const OVERTIME: Overtime[] = [];

(function genOT() {
  ACTIVE()
    .filter(() => chance(0.22))
    .forEach((e) => {
      const n = ri(1, 3);
      for (let i = 0; i < n; i++) {
        const d = addDays(TODAY, -ri(1, 45));
        OVERTIME.push({
          id: uid('OT'),
          empId: e.id,
          date: ymd(d),
          hours: ri(2, 8),
          reason: pick([
            'Production release support',
            'Client escalation',
            'Month-end payroll processing',
            'Data migration window',
            'On-call incident',
          ]),
          status: pick(['Pending', 'Approved', 'Approved', 'Approved'] as Overtime['status'][]),
          compensation: pick(['Comp Off', 'Comp Off', 'Overtime Pay'] as Overtime['compensation'][]),
          approverId: e.managerId,
        });
      }
    });
})();
