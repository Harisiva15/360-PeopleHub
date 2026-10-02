import { EMAP } from '../../data/employees';
import { HOLIDAY_MAP } from '../../data/org';
import type { CalendarService, DayVerdict } from '../contracts';
import { ASSIGNMENTS, SCHEDULES } from './schedules';
import { ok } from './util';

/**
 * The demo's calendar, mirroring `server/src/modules/calendar/service.ts`.
 *
 * It resolves the same four steps in the same order, so a day the server calls
 * non-working is non-working here:
 *
 *   1. **Was the person employed?** Outside `doj`–`dol` the answer is
 *      `NOT_EMPLOYED` and nothing else is asked. Those two fields are the demo's
 *      `joined_on` and `left_on`.
 *   2. **Which schedule applied on that date?** The assignment whose inclusive
 *      range covers it — resolved per date, never "the current one", so a pattern
 *      change mid-range counts each side under its own pattern.
 *   3. **Does that schedule work this weekday?** Its `work_schedule_day` row.
 *      With no assignment, the Monday-to-Friday fallback, reported as
 *      `schedule: null` so the fallback is visible rather than silent.
 *   4. **Is it a mandatory holiday?** Only then, and only on a day the schedule
 *      works, does the day become `HOLIDAY` — which is why a holiday landing on
 *      somebody's week off stays `WEEKLY_OFF`.
 *
 * A holiday closes the office only when it is **not** optional, which is exactly
 * what `HOLIDAY_MAP` has always encoded with its `if (!h.opt)` filter, and what
 * the holiday calendar screen means by "Fixed" as against "Optional".
 *
 * The schedules and assignments are the live arrays from `./schedules`, not copies,
 * so assigning somebody a six-day pattern in the demo changes their calendar and
 * their leave count — the same thing that happens against a real tenant.
 *
 * The weekday comes from the date string's own parts rather than from
 * `new Date(ymd).getDay()`, which reads the string as UTC midnight and then
 * reports the weekday in the browser's zone — so `2026-10-04` is Sunday in Chennai
 * and Saturday in Los Angeles. A leave count must not depend on where the reader
 * is sitting, which is the same reason the server decides this in SQL.
 *
 * Site-specific holidays are not represented, because the demo has none to
 * represent: `HOLIDAYS` in `src/data/org.ts` carries no site. The server reads
 * `holiday.site_id`; there is nothing here to read it from, and inventing one
 * would make the demo disagree with production in the other direction.
 */

/** Days since the epoch for a `YYYY-MM-DD`, with no timezone in the arithmetic. */
function epochDay(ymdStr: string): number {
  const [y, m, d] = ymdStr.split('-').map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

const dayStr = (epoch: number): string =>
  new Date(epoch * 86_400_000).toISOString().slice(0, 10);

/** 1 = Monday … 7 = Sunday, matching Postgres ISODOW. 1970-01-01 was a Thursday. */
const isoDow = (epoch: number): number => ((epoch + 3) % 7) + 1;

/**
 * Classify a range for one employee, synchronously.
 *
 * Exported because the demo leave service needs the count while building a row
 * and cannot await — and because two copies of this loop is how the drift this
 * phase removed got started.
 */
export function classifyDemoDays(empId: string, from: string, to: string): DayVerdict[] {
  if (!from || !to || to < from) return [];

  const emp = EMAP[empId];
  /*
   * Only this person's assignments, newest range first is unnecessary — the demo
   * service enforces the same non-overlap rule the exclusion constraint does, so
   * at most one covers any date.
   */
  const mine = ASSIGNMENTS.filter((a) => a.employeeId === empId);

  const out: DayVerdict[] = [];
  for (let e = epochDay(from); e <= epochDay(to); e += 1) {
    const date = dayStr(e);

    /* Outside the employment, so there is no expectation to describe. */
    if (emp && (date < emp.doj || (emp.dol !== null && date > emp.dol))) {
      out.push({
        date, workingDay: false, reason: 'NOT_EMPLOYED', holiday: null,
        schedule: null, shift: null,
      });
      continue;
    }

    const held = mine.find((a) => a.validFrom <= date && (a.validTo === null || date <= a.validTo));
    const pattern = held ? SCHEDULES.find((s) => s.code === held.scheduleCode) : undefined;
    const row = pattern?.days.find((d) => d.dayOfWeek === isoDow(e));

    const schedule = pattern ? pattern.code : null;
    const scheduled = row ? row.working : isoDow(e) <= 5;
    const holiday = HOLIDAY_MAP[date] ?? null;

    if (!scheduled) {
      out.push({ date, workingDay: false, reason: 'WEEKLY_OFF', holiday, schedule, shift: null });
      continue;
    }
    const shift = row?.shiftCode ?? emp?.shift ?? null;
    if (holiday) {
      out.push({ date, workingDay: false, reason: 'HOLIDAY', holiday, schedule, shift });
    } else {
      out.push({ date, workingDay: true, reason: 'WORKING', holiday: null, schedule, shift });
    }
  }
  return out;
}

/** How many working days a range holds. The number the demo stores on a request. */
export const demoWorkingDays = (empId: string, from: string, to: string): number =>
  classifyDemoDays(empId, from, to).filter((d) => d.workingDay).length;

export const calendarService: CalendarService = {
  workingDays(empId, from, to) {
    return ok(classifyDemoDays(empId, from, to));
  },
};
