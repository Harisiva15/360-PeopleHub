/* Shares the RNG stream with learning — this import fixes the draw order. */
import './learning';

import { addDays, isWeekend, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE } from './employees';

/**
 * A shift is a region's working hours, tagged on the person.
 *
 * The prototype had rotational patterns — General, Early, Mid, Night —
 * assigned per person per day. Migration 0015 dropped that model along with
 * the table behind it, because it describes a support desk running 24/7 out of
 * one country and not this business, where somebody in Chennai works US hours
 * and never rotates.
 *
 * The part the old model could not carry is `tz`, and it is the part that
 * matters: a 21:30 punch is three hours late or bang on time depending on
 * which clock you measure it against, and the office someone sits in cannot
 * tell you which.
 */
export interface Shift {
  id: string;
  n: string;
  start: string;
  end: string;
  /** The clock these hours are measured against, as an IANA name. */
  tz: string;
  /** Where the hours are kept, as an ISO country code. */
  region: string;
  /** Unpaid break, in minutes. */
  brk: number;
  /** Late-arrival grace, in minutes. */
  grace: number;
  c: string;
  night: boolean;
}

export const SHIFTS: Shift[] = [
  { id: 'IN', n: 'India Shift', start: '09:30', end: '18:30', tz: 'Asia/Kolkata', region: 'IN', brk: 45, grace: 20, c: 'var(--s1)', night: false },
  { id: 'US', n: 'US Shift', start: '09:00', end: '18:00', tz: 'America/New_York', region: 'US', brk: 45, grace: 15, c: 'var(--s3)', night: false },
  { id: 'UK', n: 'UK Shift', start: '09:00', end: '17:30', tz: 'Europe/London', region: 'GB', brk: 45, grace: 15, c: 'var(--s4)', night: false },
  { id: 'AE', n: 'UAE Shift', start: '09:00', end: '18:00', tz: 'Asia/Dubai', region: 'AE', brk: 45, grace: 15, c: 'var(--s5)', night: false },
];

export const shiftOf = (id: string): Shift => SHIFTS.find((s) => s.id === id) || SHIFTS[0];

/**
 * empId -> date -> shift id, or 'OFF'.
 *
 * Every working day for one person carries the same code, because the shift is
 * a standing profile rather than a daily decision. The grid shape survives
 * because that is how a rota is *read* — a row is one person's week — not
 * because each cell was chosen separately.
 */
export const ROSTER: Record<string, Record<string, string>> = {};

/** The shift a site's people work, by site code. */
const SITE_SHIFT: Record<string, string> = {
  BLR: 'IN', CHN: 'IN', HYD: 'IN', WFH: 'IN', CLIENT: 'IN',
  NJ: 'US', LON: 'UK', DXB: 'AE',
};

(function genRoster() {
  ACTIVE().forEach((e) => {
    ROSTER[e.id] = {};
    /*
     * Roughly one person in six is on a client's hours rather than their own
     * office's — the whole reason the timezone had to move onto the shift.
     */
    const base = SITE_SHIFT[e.site] ?? 'IN';
    const standing = base === 'IN' && chance(0.18) ? pick(['US', 'UK']) : base;
    for (let i = -7; i <= 20; i++) {
      const d = addDays(TODAY, i);
      ROSTER[e.id][ymd(d)] = isWeekend(d) ? 'OFF' : standing;
    }
  });
})();

export interface Overtime {
  id: string;
  empId: string;
  date: string;
  hours: number;
  reason: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  compensation: 'Comp Off' | 'Overtime Pay';
  approverId: string | null;
  /** Days of comp off actually credited. Zero for overtime pay. */
  credited: number;
}

export const OVERTIME: Overtime[] = [];

(function genOT() {
  ACTIVE()
    .filter(() => chance(0.22))
    .forEach((e) => {
      const n = ri(1, 3);
      for (let i = 0; i < n; i++) {
        const d = addDays(TODAY, -ri(1, 45));
        const hours = ri(2, 8);
        const status = pick(['Pending', 'Approved', 'Approved', 'Rejected'] as Overtime['status'][]);
        const compensation = pick(['Comp Off', 'Comp Off', 'Overtime Pay'] as Overtime['compensation'][]);
        OVERTIME.push({
          id: uid('OT'),
          empId: e.id,
          date: ymd(d),
          hours,
          reason: pick([
            'Production release support',
            'Client escalation',
            'Month-end payroll processing',
            'Data migration window',
            'On-call incident',
          ]),
          status,
          compensation,
          approverId: status === 'Pending' ? null : e.managerId,
          /* Eight hours to the day, rounded down, and only once approved. */
          credited: status === 'Approved' && compensation === 'Comp Off'
            ? Math.floor(hours / 8) : 0,
        });
      }
    });
})();
