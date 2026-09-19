/*
 * Last in the RNG chain, after users. Two files importing the same predecessor
 * leaves their own order undefined, and the whole dataset is drawn from one
 * seeded stream.
 */
import './users';

import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri, uid } from '../lib/rng';
import { ACTIVE, EMAP } from './employees';
import { DEPTS, GRADES, SKILLS, TITLES } from './org';
import type { Grade } from '../types/country';

/**
 * A job title.
 *
 * The catalogue already existed implicitly: `TITLES` maps a department and a
 * grade to a name, and every employee carries the result as `designation`.
 * What it could not do is carry anything *about* a title — what the role is
 * for, what it needs, whether it is still one the company hires into — so a
 * designation was a string that happened to repeat.
 *
 * Making it a record rather than a string is the whole module. It means a
 * title can be retired without touching the people who hold it, and that
 * "how many Senior Engineers do we have" is a question with an answer rather
 * than a `filter` somebody writes again each time.
 */

/**
 * The levels, as the brief lists them, mapped onto the grades the product
 * already pays against. Eight names over six bands: L7 and L8 exist as
 * titles — a Director and an Executive are real positions — and both sit in
 * the top band, because the company has one compensation ceiling and not
 * eight.
 */
export const JOB_LEVELS = [
  { id: 'L1', n: 'L1 — Entry', grade: 'L1' as Grade },
  { id: 'L2', n: 'L2 — Junior', grade: 'L2' as Grade },
  { id: 'L3', n: 'L3 — Mid-level', grade: 'L3' as Grade },
  { id: 'L4', n: 'L4 — Senior', grade: 'L4' as Grade },
  { id: 'L5', n: 'L5 — Lead', grade: 'L4' as Grade },
  { id: 'L6', n: 'L6 — Manager', grade: 'L5' as Grade },
  { id: 'L7', n: 'L7 — Director', grade: 'L6' as Grade },
  { id: 'L8', n: 'L8 — Executive', grade: 'L6' as Grade },
] as const;

export type JobLevel = (typeof JOB_LEVELS)[number]['id'];

export const levelOf = (id: string) =>
  JOB_LEVELS.find((l) => l.id === id) ?? JOB_LEVELS[0];

/** The families a title belongs to, cutting across departments. */
export const JOB_FAMILIES = [
  'Engineering', 'Quality', 'Infrastructure', 'Product', 'Design', 'Data',
  'Sales', 'Marketing', 'Finance', 'People', 'Operations', 'Leadership',
];

export const JOB_EMP_TYPES = ['Full Time', 'Part Time', 'Contract', 'Intern'];

export const JOB_TITLE_STATUSES = ['Active', 'Inactive', 'Archived'] as const;
export type JobTitleStatus = (typeof JOB_TITLE_STATUSES)[number];

export interface JobTitle {
  id: string;
  /** Read aloud in a requisition, so it is short and unique. */
  code: string;
  n: string;
  dept: string;
  family: string;
  level: JobLevel;
  empType: string;
  desc: string;
  responsibilities: string[];
  required: string[];
  preferred: string[];
  status: JobTitleStatus;
  createdOn: string;
  createdById: string | null;
  modifiedOn: string | null;
  modifiedById: string | null;
}

export const JOB_TITLES: JobTitle[] = [];

/**
 * Built from the titles people actually hold.
 *
 * Generating a plausible catalogue and leaving the employees pointing at their
 * own strings would give a module where every count read zero — which looks
 * like a bug and is worse than no module.
 */
(function genJobTitles() {
  const admins = ACTIVE().filter((e) => e.role === 'admin');
  const actor = () => (admins.length ? pick(admins).id : null);

  /* The grade each title is written for, from the TITLES table it came from. */
  const levelFor = (dept: string, grade: Grade): JobLevel => {
    const band = JOB_LEVELS.filter((l) => l.grade === grade);
    if (!band.length) return 'L3';
    /* Where two levels share a grade, a manager-shaped department takes the
       higher of the two — an Engineering Manager is L6, not L5. */
    return (band.length > 1 && /Manager|Head|Chief|VP|Director/.test(TITLES[dept]?.[grade] ?? '')
      ? band[band.length - 1].id
      : band[0].id) as JobLevel;
  };

  const familyFor = (dept: string): string => ({
    ENG: 'Engineering', QA: 'Quality', DEVOPS: 'Infrastructure', PM: 'Product',
    DESIGN: 'Design', DATA: 'Data', SALES: 'Sales', MKT: 'Marketing',
    FIN: 'Finance', HR: 'People', OPS: 'Operations',
  }[dept] ?? 'Operations');

  let seq = 0;
  Object.entries(TITLES).forEach(([dept, byGrade]) => {
    const prefix = dept.slice(0, 4).toUpperCase();
    Object.entries(byGrade).forEach(([grade, name]) => {
      seq += 1;
      const level = levelFor(dept, grade as Grade);
      const created = addDays(TODAY, -ri(120, 1400));

      /* A handful of older titles are no longer hired into. */
      const holders = ACTIVE().filter((e) => e.designation === name).length;
      const status: JobTitleStatus = holders === 0 && chance(0.4) ? 'Inactive' : 'Active';

      JOB_TITLES.push({
        id: uid('JT'),
        code: `${prefix}-${String(seq).padStart(3, '0')}`,
        n: name,
        dept,
        family: familyFor(dept),
        level,
        empType: 'Full Time',
        desc: `${name} in ${DEPTS.find((d) => d.id === dept)?.name ?? dept}, `
          + `at ${GRADES[grade as Grade].label.split(' · ')[1] ?? grade} level.`,
        responsibilities: [
          'Deliver the work the role is accountable for, to the agreed standard.',
          'Work with the rest of the team and the people who depend on it.',
          ...(level >= 'L5' ? ['Develop the people reporting into this role.'] : []),
        ],
        required: [pick(SKILLS), pick(SKILLS)],
        preferred: chance(0.6) ? [pick(SKILLS)] : [],
        status,
        createdOn: ymd(created),
        createdById: actor(),
        modifiedOn: chance(0.3) ? ymd(addDays(created, ri(30, 400))) : null,
        modifiedById: chance(0.3) ? actor() : null,
      });
    });
  });
})();

export const jobTitleOf = (id: string): JobTitle | undefined =>
  JOB_TITLES.find((t) => t.id === id);

/** Everybody currently holding this title. The count the catalogue exists for. */
export const holdersOf = (t: JobTitle) =>
  ACTIVE().filter((e) => e.designation === t.n);

/** The title an employee holds, when the catalogue knows it. */
export const titleForEmployee = (empId: string): JobTitle | undefined => {
  const e = EMAP[empId];
  return e ? JOB_TITLES.find((t) => t.n === e.designation) : undefined;
};
