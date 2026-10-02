import { SHIFTS } from '../../data/shifts';
import { ACTIVE, EMAP } from '../../data/employees';
import type {
  EmployeeSchedule, EmployeeScheduleDraft, ScheduleService, WorkSchedule,
  WorkScheduleDay, WorkScheduleDayDraft,
} from '../contracts';
import { ok } from './util';

/**
 * The demo's work schedules, following the server's rules rather than its own.
 *
 * Every refusal the service raises is raised here with the same wording, so a
 * form refused against a real tenant is refused in the demo too — the code shape,
 * the seven-day requirement, a day off naming a shift, an inactive shift, an
 * inactive schedule, a reversed date range, an overlap, and a start date inside a
 * period that has already ended.
 *
 * Two things are modelled as the server models them and are worth naming:
 *
 *   - **`valid_to` is inclusive.** 30 June to 1 July is adjacent, not overlapping.
 *   - **A closed period is never rewritten.** Assigning from a date inside one is
 *     refused rather than quietly reshaping history, which is the rule
 *     `employment_record` has followed since 0003.
 *
 * Dates are compared as `YYYY-MM-DD` strings, which sort correctly and avoid the
 * timezone shift `new Date('2026-10-04')` introduces.
 */

export interface DemoSchedule {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  days: { dayOfWeek: number; working: boolean; shiftCode: string | null }[];
}

export interface DemoAssignment {
  id: string;
  employeeId: string;
  scheduleCode: string;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

const STAMP = new Date(Date.UTC(2026, 0, 12)).toISOString();

const monToFri = (): DemoSchedule['days'] =>
  [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
    dayOfWeek, working: dayOfWeek <= 5, shiftCode: null,
  }));

/**
 * The default pattern, which is what migration 0054 writes for a real tenant, and
 * a six-day one so the demo shows that a tenant can work other days.
 */
export const SCHEDULES: DemoSchedule[] = [
  {
    code: 'DEFAULT_MF',
    name: 'Default Monday-Friday Schedule',
    description: 'The pattern this product applies when nothing else is configured.',
    active: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    days: monToFri(),
  },
  {
    code: 'SIX_DAY',
    name: 'Six-Day Operations',
    description: 'Monday to Saturday, for the support desk.',
    active: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    days: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
      dayOfWeek, working: dayOfWeek <= 6, shiftCode: null,
    })),
  },
];

/** Everybody on the default, from a date well before the demo's attendance. */
export const ASSIGNMENTS: DemoAssignment[] = ACTIVE().map((e, i) => ({
  id: `ES${String(i + 1).padStart(4, '0')}`,
  employeeId: e.id,
  scheduleCode: 'DEFAULT_MF',
  validFrom: '2024-04-01',
  validTo: null,
  createdAt: STAMP,
}));

const SCHEDULE_CODE = /^[A-Z0-9][A-Z0-9_-]{1,15}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const fail = (m: string) => Promise.reject(new Error(m));

const asDay = (d: DemoSchedule['days'][number]): WorkScheduleDay => ({
  dayOfWeek: d.dayOfWeek,
  working: d.working,
  shiftCode: d.shiftCode,
  shiftName: d.shiftCode ? SHIFTS.find((s) => s.id === d.shiftCode)?.n ?? null : null,
});

const asSchedule = (s: DemoSchedule, withDays: boolean): WorkSchedule => ({
  code: s.code,
  name: s.name,
  description: s.description,
  active: s.active,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  assignedNow: ASSIGNMENTS.filter(
    (a) => a.scheduleCode === s.code && a.validTo === null).length,
  days: withDays ? s.days.map(asDay) : [],
});

const asAssignment = (a: DemoAssignment): EmployeeSchedule => {
  const s = SCHEDULES.find((x) => x.code === a.scheduleCode);
  return {
    id: a.id,
    employeeId: a.employeeId,
    scheduleCode: a.scheduleCode,
    scheduleName: s?.name ?? a.scheduleCode,
    scheduleActive: s?.active ?? false,
    validFrom: a.validFrom,
    validTo: a.validTo,
    createdAt: a.createdAt,
  };
};

/** Inclusive overlap, on strings, which sort as dates. */
const overlaps = (
  aFrom: string, aTo: string | null, bFrom: string, bTo: string | null,
): boolean => (aTo === null || aTo >= bFrom) && (bTo === null || bTo >= aFrom);

/** The day before, without going through a Date. */
function dayBefore(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, day! - 1));
  return t.toISOString().slice(0, 10);
}

/** Mirrors `resolveDay`: an ISO weekday, a day off with no shift, an active shift. */
function checkDay(d: WorkScheduleDayDraft): Error | null {
  if (typeof d.dayOfWeek !== 'number' || !Number.isInteger(d.dayOfWeek)
    || d.dayOfWeek < 1 || d.dayOfWeek > 7) {
    return new Error('a weekday is 1 to 7, Monday through Sunday');
  }
  if (typeof d.working !== 'boolean') {
    return new Error('a weekday is either worked or it is not');
  }
  const wanted = typeof d.shiftCode === 'string' ? d.shiftCode.trim().toUpperCase() : null;
  if (!d.working && wanted) {
    return new Error(
      'a day nobody works cannot name a shift — clear the shift or mark the day worked');
  }
  if (wanted) {
    const shift = SHIFTS.find((s) => s.id === wanted);
    if (!shift) return new Error(`no such shift: ${wanted}`);
    if (!shift.active) {
      return new Error(`${wanted} is not in use and cannot be assigned — activate it first`);
    }
  }
  return null;
}

export const scheduleService: ScheduleService = {
  workSchedules() {
    /*
     * With the days, as the service now returns them: a screen that lists which
     * days each pattern works would otherwise need a request per row.
     */
    return ok([...SCHEDULES]
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
      .map((s) => asSchedule(s, true)));
  },

  workSchedule(code) {
    const s = SCHEDULES.find((x) => x.code === code.trim().toUpperCase());
    if (!s) return fail('no such work schedule');
    return ok(asSchedule(s, true));
  },

  createWorkSchedule(draft) {
    if (!draft.code?.trim()) return fail('a schedule needs a code');
    const code = draft.code.trim().toUpperCase();
    if (!SCHEDULE_CODE.test(code)) {
      return fail('a schedule code is 2-16 characters: letters, digits, hyphen or underscore');
    }
    if (!draft.name?.trim()) return fail('a schedule needs a name');
    if (draft.name.trim().length > 120) return fail('a name is at most 120 characters');
    if (SCHEDULES.some((s) => s.code === code)) {
      return fail(`${code} is already a work schedule`);
    }

    const wanted = draft.days ?? monToFri().map((d) => ({ ...d }));
    if (wanted.length !== 7) {
      return fail(
        'a schedule covers all seven weekdays — send seven days, or none for Monday to Friday');
    }
    if (new Set(wanted.map((d) => d.dayOfWeek)).size !== 7) {
      return fail('each weekday appears once, Monday through Sunday');
    }
    for (const d of wanted) {
      const bad = checkDay(d);
      if (bad) return Promise.reject(bad);
    }

    const made: DemoSchedule = {
      code,
      name: draft.name.trim(),
      description: draft.description?.trim() || null,
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      days: wanted.map((d) => ({
        dayOfWeek: d.dayOfWeek,
        working: d.working,
        shiftCode: d.working && d.shiftCode ? d.shiftCode.trim().toUpperCase() : null,
      })).sort((a, b) => a.dayOfWeek - b.dayOfWeek),
    };
    SCHEDULES.push(made);
    return ok(asSchedule(made, true));
  },

  updateWorkSchedule(code, patch) {
    const key = code.trim().toUpperCase();
    const s = SCHEDULES.find((x) => x.code === key);
    if (!s) return fail('no such work schedule');
    if (patch.code !== undefined && patch.code.trim().toUpperCase() !== key) {
      return fail(
        'a schedule code cannot change — every assignment joins on it. Create a new one');
    }
    if (patch.days !== undefined) {
      return fail('weekdays are changed one at a time, not through this call');
    }
    if (patch.name !== undefined && !patch.name.trim()) return fail('a schedule needs a name');
    if (patch.name !== undefined && patch.name.trim().length > 120) {
      return fail('a name is at most 120 characters');
    }
    if (patch.name !== undefined) s.name = patch.name.trim();
    if (patch.description !== undefined) s.description = patch.description?.trim() || null;
    s.updatedAt = new Date().toISOString();
    return ok(asSchedule(s, true));
  },

  setWorkScheduleDay(code, day) {
    const s = SCHEDULES.find((x) => x.code === code.trim().toUpperCase());
    if (!s) return fail('no such work schedule');
    const bad = checkDay(day);
    if (bad) return Promise.reject(bad);

    const shiftCode = day.working && day.shiftCode
      ? day.shiftCode.trim().toUpperCase() : null;
    const existing = s.days.find((d) => d.dayOfWeek === day.dayOfWeek);
    if (existing) {
      existing.working = day.working;
      existing.shiftCode = shiftCode;
    } else {
      s.days.push({ dayOfWeek: day.dayOfWeek, working: day.working, shiftCode });
      s.days.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
    }
    s.updatedAt = new Date().toISOString();
    return ok(asSchedule(s, true));
  },

  setWorkScheduleActive(code, active) {
    const s = SCHEDULES.find((x) => x.code === code.trim().toUpperCase());
    if (!s) return fail('no such work schedule');
    if (typeof active !== 'boolean') return fail('a schedule is either active or inactive');
    /* Nobody is moved: the people already on it keep it. */
    s.active = active;
    s.updatedAt = new Date().toISOString();
    return ok(asSchedule(s, true));
  },

  employeeSchedules(empId) {
    if (!EMAP[empId]) return fail('no such employee');
    return ok(ASSIGNMENTS
      .filter((a) => a.employeeId === empId)
      .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
      .map(asAssignment));
  },

  assignEmployeeSchedule(empId, draft: EmployeeScheduleDraft) {
    const e = EMAP[empId];
    if (!e) return fail('no such employee');
    if (!draft.scheduleCode?.trim()) return fail('an assignment needs a schedule');
    if (!YMD.test(draft.validFrom ?? '')) {
      return fail('a start date is written as YYYY-MM-DD');
    }
    const to = draft.validTo ?? null;
    if (to !== null) {
      if (!YMD.test(to)) return fail('an end date is written as YYYY-MM-DD');
      if (to < draft.validFrom) return fail('an end date cannot be before the start date');
    }

    const wanted = draft.scheduleCode.trim().toUpperCase();
    const s = SCHEDULES.find((x) => x.code === wanted);
    if (!s) return fail(`no such work schedule: ${wanted}`);
    if (!s.active) {
      return fail(`${wanted} is not in use and cannot be assigned — activate it first`);
    }

    const from = draft.validFrom;
    const clashes = ASSIGNMENTS
      .filter((a) => a.employeeId === empId && overlaps(a.validFrom, a.validTo, from, to))
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));

    const settled = clashes.filter((a) => a.validTo !== null);
    if (settled.length) {
      const f = settled[0]!;
      return fail(
        `${from} falls inside a schedule period that has already ended `
        + `(${f.validFrom} to ${f.validTo}). Historical periods are not rewritten — `
        + 'choose a start date after the last one, or correct that period first.');
    }

    const open = clashes[0];
    if (open) {
      if (open.validFrom === from) {
        /* Amended rather than superseded, as employment_record does. */
        open.scheduleCode = wanted;
        open.validTo = to;
        return ok(asAssignment(open));
      }
      if (open.validFrom > from) {
        return fail(
          `the current schedule period starts on ${open.validFrom}, after ${from}. `
          + 'Backdating before an existing period is not supported.');
      }
      open.validTo = dayBefore(from);
    }

    const made: DemoAssignment = {
      id: `ES${String(ASSIGNMENTS.length + 1).padStart(4, '0')}`,
      employeeId: empId,
      scheduleCode: wanted,
      validFrom: from,
      validTo: to,
      createdAt: new Date().toISOString(),
    };
    ASSIGNMENTS.push(made);
    return ok(asAssignment(made));
  },

  closeEmployeeSchedule(empId, assignmentId, validTo) {
    if (!EMAP[empId]) return fail('no such employee');
    if (!YMD.test(validTo ?? '')) return fail('an end date is written as YYYY-MM-DD');
    const a = ASSIGNMENTS.find((x) => x.id === assignmentId && x.employeeId === empId);
    if (!a) return fail('no such schedule assignment');
    if (a.validTo !== null) {
      return fail('that period has already ended — historical periods are not rewritten');
    }
    if (validTo < a.validFrom) {
      return fail(`an end date cannot be before the period began on ${a.validFrom}`);
    }
    a.validTo = validTo;
    return ok(asAssignment(a));
  },
};
