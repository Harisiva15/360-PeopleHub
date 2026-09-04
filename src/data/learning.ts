/* Shares the RNG stream with the helpdesk — this import fixes the draw order. */
import './helpdesk';

import { addDays, TODAY, ymd } from '../lib/dates';
import { chance, pick, ri } from '../lib/rng';
import { ACTIVE } from './employees';

export interface Course {
  id: string;
  t: string;
  cat: string;
  hrs: number;
  /** Compliance courses everyone must complete by `due`. */
  mandatory: boolean;
  due: string | null;
  provider: string;
}

export const COURSES: Course[] = [
  { id: 'C1', t: 'POSH — Prevention of Sexual Harassment', cat: 'Compliance', hrs: 1.5, mandatory: true, due: '2026-09-30', provider: 'Internal' },
  { id: 'C2', t: 'Information Security & Data Privacy', cat: 'Compliance', hrs: 2, mandatory: true, due: '2026-09-30', provider: 'Internal' },
  { id: 'C3', t: 'Code of Conduct & Anti-Bribery', cat: 'Compliance', hrs: 1, mandatory: true, due: '2026-09-30', provider: 'Internal' },
  { id: 'C4', t: 'Advanced React Patterns', cat: 'Technical', hrs: 12, mandatory: false, due: null, provider: 'Frontend Masters' },
  { id: 'C5', t: 'AWS Solutions Architect — Associate', cat: 'Certification', hrs: 40, mandatory: false, due: null, provider: 'AWS Training' },
  { id: 'C6', t: 'Kubernetes for Engineers (CKA prep)', cat: 'Certification', hrs: 35, mandatory: false, due: null, provider: 'Linux Foundation' },
  { id: 'C7', t: 'First-Time Manager Programme', cat: 'Leadership', hrs: 16, mandatory: false, due: null, provider: 'Internal' },
  { id: 'C8', t: 'Giving & Receiving Feedback', cat: 'Leadership', hrs: 3, mandatory: false, due: null, provider: 'Internal' },
  { id: 'C9', t: 'SQL & Data Analysis Fundamentals', cat: 'Technical', hrs: 10, mandatory: false, due: null, provider: 'Coursera' },
  { id: 'C10', t: 'Consultative Selling for BFSI', cat: 'Sales', hrs: 8, mandatory: false, due: null, provider: 'External' },
  { id: 'C11', t: 'Design Systems in Figma', cat: 'Design', hrs: 9, mandatory: false, due: null, provider: 'Internal' },
  { id: 'C12', t: 'Effective Business Writing', cat: 'Professional', hrs: 4, mandatory: false, due: null, provider: 'Internal' },
];

export const courseOf = (id: string): Course => COURSES.find((c) => c.id === id) || COURSES[0];

export interface Enrollment {
  empId: string;
  courseId: string;
  progress: number;
  status: 'Completed' | 'In Progress' | 'Not Started';
  completedOn: string | null;
  score: number | null;
}

export const ENROLL: Enrollment[] = [];

(function genEnroll() {
  ACTIVE().forEach((e) => {
    /* everyone is enrolled on the compliance set */
    COURSES.filter((c) => c.mandatory).forEach((c) => {
      const p = chance(0.72) ? 100 : ri(0, 90);
      ENROLL.push({
        empId: e.id,
        courseId: c.id,
        progress: p,
        status: p === 100 ? 'Completed' : p > 0 ? 'In Progress' : 'Not Started',
        completedOn: p === 100 ? ymd(addDays(TODAY, -ri(5, 120))) : null,
        score: p === 100 ? ri(72, 100) : null,
      });
    });
    /* elective take-up is sparser */
    COURSES.filter((c) => !c.mandatory).forEach((c) => {
      if (!chance(0.22)) return;
      const p = pick([100, 100, ri(10, 90), 0]);
      ENROLL.push({
        empId: e.id,
        courseId: c.id,
        progress: p,
        status: p === 100 ? 'Completed' : p > 0 ? 'In Progress' : 'Not Started',
        completedOn: p === 100 ? ymd(addDays(TODAY, -ri(5, 200))) : null,
        score: p === 100 ? ri(70, 100) : null,
      });
    });
  });
})();
