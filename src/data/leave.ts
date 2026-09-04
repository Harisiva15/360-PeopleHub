/* Shares the RNG stream with attendance — this import fixes the draw order. */
import './attendance';

import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE } from './employees';
import { LEAVE_TYPES } from './org';

export type LeaveStatus = 'Pending' | 'Approved' | 'Rejected' | 'Cancelled';

export interface LeaveBalance {
  quota: number;
  /** Days carried forward from last year, for types that allow it. */
  carry: number;
  used: number;
}

export interface LeaveRequest {
  id: string;
  empId: string;
  type: string;
  from: string;
  to: string;
  days: number;
  /** Set when a single day is taken as a half day. */
  half: string | null;
  reason: string;
  status: LeaveStatus;
  approverId: string | null;
  appliedOn: string;
  actedOn: string | null;
  note: string;
}

/** empId -> leave type -> balance. */
export const LEAVE_BAL: Record<string, Record<string, LeaveBalance>> = {};
export const LEAVES: LeaveRequest[] = [];

(function genLeave() {
  ACTIVE().forEach((e) => {
    const bal: Record<string, LeaveBalance> = {};
    LEAVE_TYPES.forEach((t) => {
      if (t.gender && t.gender !== e.gender) return;
      const carry = t.carry ? ri(0, 8) : 0;
      bal[t.id] = { quota: t.id === 'CO' ? ri(0, 3) : t.quota, carry, used: 0 };
    });
    LEAVE_BAL[e.id] = bal;
  });

  const reasons: Record<string, string[]> = {
    CL: ['Personal work', 'Family function', 'House shifting', 'Bank work'],
    SL: ['Fever and cold', 'Migraine', 'Medical check-up', 'Food poisoning', 'Dental procedure'],
    EL: ['Family vacation', 'Wedding in family', 'Travel — Ooty', 'Annual break'],
    CO: ['Comp off for weekend release'],
    PL: ['Paternity leave'],
    ML: ['Maternity leave'],
    LOP: ['Extended personal leave'],
  };

  ACTIVE().forEach((e) => {
    const n = ri(2, 7);
    for (let i = 0; i < n; i++) {
      /* LOP and maternity are raised through their own flows, not the normal one */
      const t = pick(Object.keys(LEAVE_BAL[e.id]).filter((x) => x !== 'LOP' && x !== 'ML'));
      const days = t === 'EL' ? ri(1, 5) : ri(1, 2);
      const start = addDays(TODAY, ri(-95, 22));
      const from = ymd(start);
      const to = ymd(addDays(start, days - 1));
      const future = from > ymd(TODAY);
      const st: LeaveStatus = future
        ? pick(['Pending', 'Pending', 'Approved'] as LeaveStatus[])
        : pick(['Approved', 'Approved', 'Approved', 'Approved', 'Rejected', 'Cancelled'] as LeaveStatus[]);

      const rec: LeaveRequest = {
        id: uid('LV'),
        empId: e.id,
        type: t,
        from,
        to,
        days,
        half: days === 1 && chance(0.18) ? pick(['First Half', 'Second Half']) : null,
        reason: pick(reasons[t] || ['Personal']),
        status: st,
        approverId: e.managerId,
        appliedOn: ymd(addDays(start, -ri(1, 12))),
        actedOn: st === 'Pending' ? null : ymd(addDays(start, -ri(0, 3))),
        note:
          st === 'Rejected'
            ? pick([
                'Critical release week — please re-plan',
                'Insufficient balance',
                'Team coverage unavailable',
              ])
            : '',
      };

      if (rec.half) rec.days = 0.5;
      if (st === 'Approved') LEAVE_BAL[e.id][t].used += rec.days;
      LEAVES.push(rec);
    }
  });
})();

export function leaveBalance(empId: string, t: string): (LeaveBalance & { avail: number }) | null {
  const b = LEAVE_BAL[empId]?.[t];
  if (!b) return null;
  return { ...b, avail: b.quota + b.carry - b.used };
}
