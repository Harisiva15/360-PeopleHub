/**
 * The seven weekdays, and a schedule as the form edits it.
 *
 * Separate from `ScheduleForm.tsx` because a module that exports a component and
 * also exports constants defeats fast refresh — the same reason `ShiftForm` was
 * lifted out of the shifts screen in Phase 2g-B. Nothing here renders.
 */

import type { WorkSchedule, WorkScheduleDayDraft } from '../../services';

/**
 * Monday first, as `work_schedule_day.day_of_week` numbers them.
 *
 * ISO numbering — 1 Monday through 7 Sunday — which is what the migration's CHECK
 * enforces and what `EXTRACT(ISODOW …)` in the calendar resolver produces. Using
 * JavaScript's own 0-is-Sunday numbering anywhere near this is how a Sunday
 * becomes a Monday.
 */
export const WEEKDAYS: { dow: number; name: string; short: string }[] = [
  { dow: 1, name: 'Monday', short: 'Mon' },
  { dow: 2, name: 'Tuesday', short: 'Tue' },
  { dow: 3, name: 'Wednesday', short: 'Wed' },
  { dow: 4, name: 'Thursday', short: 'Thu' },
  { dow: 5, name: 'Friday', short: 'Fri' },
  { dow: 6, name: 'Saturday', short: 'Sat' },
  { dow: 7, name: 'Sunday', short: 'Sun' },
];

export interface ScheduleDraft {
  code: string;
  name: string;
  description: string;
  days: WorkScheduleDayDraft[];
}

/** Monday to Friday — what the server assumes when a create sends no days. */
export const monToFriDraft = (): WorkScheduleDayDraft[] =>
  WEEKDAYS.map((w) => ({ dayOfWeek: w.dow, working: w.dow <= 5, shiftCode: null }));

/**
 * An existing schedule as a draft, so the form has one shape to edit.
 *
 * All seven rows are produced whatever the schedule holds. The service writes all
 * seven on every create, so a missing one would mean something is wrong with the
 * data — and a form with six rows would silently drop the seventh on save.
 */
export const draftOf = (s: WorkSchedule): ScheduleDraft => ({
  code: s.code,
  name: s.name,
  description: s.description ?? '',
  days: WEEKDAYS.map((w) => {
    const row = s.days.find((d) => d.dayOfWeek === w.dow);
    return {
      dayOfWeek: w.dow,
      working: row ? row.working : w.dow <= 5,
      shiftCode: row?.shiftCode ?? null,
    };
  }),
});
