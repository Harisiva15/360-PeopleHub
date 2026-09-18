/**
 * Courses and who has done them.
 *
 * **Progress drives the status, not the other way round.** Setting 100% is what
 * completes an enrolment and stamps the date; there is no separate "mark
 * complete". Two ways to say the same thing is how a course ends up completed
 * at 60%.
 *
 * **Re-enrolling resets.** The unique on (employee, course) means one row per
 * person per course, and the schema comment says re-enrolling resets it. That
 * is right for annual compliance training: last year's completion should not
 * satisfy this year's deadline.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class LearningError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'LearningError';
    this.code = code;
  }
}

export interface Course {
  id: string;
  /** Title. Named `t` because that is what the catalogue cards read. */
  t: string;
  cat: string;
  provider: string;
  hrs: number;
  mandatory: boolean;
  due: string | null;
}

export interface Enrollment {
  empId: string;
  courseId: string;
  progress: number;
  status: 'Not Started' | 'In Progress' | 'Completed';
  score: number | null;
  enrolledOn: string;
  completedOn: string | null;
}

const TO_STATUS: Record<string, Enrollment['status']> = {
  not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed',
};

const toEnrollment = (r: Record<string, unknown>): Enrollment => ({
  empId: r.employee_id as string,
  courseId: r.course_id as string,
  progress: Number(r.progress),
  status: TO_STATUS[r.status as string] ?? 'Not Started',
  score: r.score === null ? null : Number(r.score),
  enrolledOn: r.enrolled_on as string,
  completedOn: (r.completed_on as string | null) ?? null,
});

export async function courses(caller: Caller): Promise<Course[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT id, title, COALESCE(category, '') AS category,
              COALESCE(provider, '') AS provider, hours, mandatory, due_on
         FROM course WHERE active
        ORDER BY mandatory DESC, title`);
    return rows.map((r) => ({
      id: r.id as string,
      t: r.title as string,
      cat: r.category as string,
      provider: r.provider as string,
      hrs: Number(r.hours),
      mandatory: Boolean(r.mandatory),
      due: (r.due_on as string | null) ?? null,
    }));
  });
}

/** Everyone's, or the people asked about — scoped to what the caller may see. */
export async function enrolments(caller: Caller, empIds?: string[]): Promise<Enrollment[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (caller.role === 'employee') {
    if (!caller.employeeId) throw new LearningError('this login has no employee record', 'forbidden');
    params.push(caller.employeeId);
    where.push(`e.employee_id = $${params.length}`);
  } else if (caller.role === 'manager') {
    params.push(caller.employeeId);
    where.push(`(e.employee_id = $${params.length} OR e.employee_id IN (
       WITH RECURSIVE t AS (
         SELECT id FROM employee WHERE manager_id = $${params.length}
         UNION ALL SELECT c.id FROM employee c JOIN t ON c.manager_id = t.id
       ) SELECT id FROM t))`);
  }

  if (empIds?.length) {
    params.push(empIds);
    where.push(`e.employee_id = ANY($${params.length}::uuid[])`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT e.employee_id, e.course_id, e.progress, e.status, e.score,
              e.enrolled_on, e.completed_on
         FROM enrollment e
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.enrolled_on DESC`, params);
    return rows.map(toEnrollment);
  });
}

/** Sign up. Idempotent for somebody already enrolled and not yet finished. */
export async function enrol(
  caller: Caller,
  empId: string,
  courseId: string,
): Promise<Enrollment> {
  if (empId !== caller.employeeId && caller.role === 'employee') {
    throw new LearningError('you can only enrol yourself', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const course = await db.query('SELECT id FROM course WHERE id = $1 AND active', [courseId]);
    if (!course.rows[0]) throw new LearningError('no such course', 'not_found');

    /*
     * Re-enrolling resets, per the schema's own comment: last year's
     * completion of annual compliance training should not satisfy this year's
     * deadline. A first enrolment and a reset are the same statement.
     */
    await db.query(
      `INSERT INTO enrollment (employee_id, course_id) VALUES ($1, $2)
       ON CONFLICT (tenant_id, employee_id, course_id)
       DO UPDATE SET progress = 0, status = 'not_started', score = NULL,
                     enrolled_on = CURRENT_DATE, completed_on = NULL`,
      [empId, courseId]);

    const { rows } = await db.query(
      `SELECT employee_id, course_id, progress, status, score, enrolled_on, completed_on
         FROM enrollment WHERE employee_id = $1 AND course_id = $2`, [empId, courseId]);
    return toEnrollment(rows[0]!);
  });
}

/**
 * Move somebody along a course.
 *
 * The status is derived here rather than accepted: 0 is not started, 100 is
 * completed and stamps the date, anything between is in progress. Progress
 * only moves forward — a course that went from 80% back to 20% is a bug in
 * whatever reported it, not a thing to record.
 */
export async function setProgress(
  caller: Caller,
  empId: string,
  courseId: string,
  progress: number,
): Promise<Enrollment> {
  if (empId !== caller.employeeId && caller.role === 'employee') {
    throw new LearningError('you can only record your own progress', 'forbidden');
  }
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new LearningError('progress is a percentage between 0 and 100', 'invalid');
  }
  const pct = Math.round(progress);

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      `SELECT progress FROM enrollment
        WHERE employee_id = $1 AND course_id = $2 FOR UPDATE`, [empId, courseId]);
    if (!cur.rows[0]) throw new LearningError('not enrolled on that course', 'not_found');
    if (Number(cur.rows[0].progress) > pct) {
      throw new LearningError(
        `progress does not go backwards — already at ${cur.rows[0].progress}%`, 'invalid');
    }

    await db.query(
      /*
       * $3 is cast on every use. Without it Postgres sees the same parameter
       * assigned to a smallint column and compared against integer literals,
       * deduces two types for one parameter, and refuses the whole statement.
       */
      `UPDATE enrollment
          SET progress = $3::int,
              status = CASE WHEN $3::int >= 100 THEN 'completed'
                            WHEN $3::int > 0 THEN 'in_progress'
                            ELSE 'not_started' END,
              completed_on = CASE WHEN $3::int >= 100 THEN CURRENT_DATE ELSE NULL END
        WHERE employee_id = $1 AND course_id = $2`, [empId, courseId, pct]);

    const { rows } = await db.query(
      `SELECT employee_id, course_id, progress, status, score, enrolled_on, completed_on
         FROM enrollment WHERE employee_id = $1 AND course_id = $2`, [empId, courseId]);
    return toEnrollment(rows[0]!);
  });
}
