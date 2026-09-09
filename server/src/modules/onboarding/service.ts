/**
 * Onboarding — the joining checklist, and the moment someone becomes an
 * employee.
 *
 * **Completing a journey creates the employee record.** The schema insists on
 * it: `CHECK (status <> 'completed' OR employee_id IS NOT NULL)`. A journey
 * that reached 'completed' with nobody on the other side would be a person the
 * company believes it onboarded and cannot pay, so the two happen in one
 * transaction or neither does. It goes through the same provisioner the
 * joining-request flow uses, so a hire onboarded this way is indistinguishable
 * from one added directly — same code series, same shift, same opening leave
 * balances.
 *
 * **Status is derived from the checklist, never set alongside it.** Every task
 * change recomputes it. A status field somebody can set independently is a
 * status field that will eventually disagree with the tasks underneath it, and
 * the checklist is the thing people actually look at.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { provisionEmployee } from '../people/provision.ts';

export class OnboardingError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
  }
}

const TO_STATUS: Record<string, string> = {
  pre_boarding: 'Pre-boarding', in_progress: 'In Progress',
  completed: 'Completed', cancelled: 'Completed',
};

/** Owner codes are stored lowercase; the screens show them capitalised. */
const TO_OWNER: Record<string, string> = {
  hr: 'HR', it: 'IT', manager: 'Manager', finance: 'Finance',
  candidate: 'Candidate', employee: 'Employee',
};

export interface OnbTask {
  k: string;
  n: string;
  owner: string;
  day: number;
  due: string;
  done: boolean;
  doneOn: string | null;
}

export interface Onboarding {
  id: string;
  candId: string;
  name: string;
  reqId: string;
  dept: string;
  designation: string;
  site: string;
  doj: string;
  managerId: string;
  buddyId: string;
  ctc: number;
  status: string;
  bgv: string;
  tasks: OnbTask[];
  docs: { n: string; ok: boolean }[];
}

const PROJECTION = `
  SELECT j.id, j.candidate_id, j.full_name, j.designation, j.joining_on,
         j.manager_id, j.buddy_id, j.annual_ctc, j.status, j.background_check,
         COALESCE(d.code, '') AS dept_code, COALESCE(s.code, '') AS site_code,
         COALESCE(c.requisition_id::text, '') AS req_id,
         COALESCE(t.tasks, '[]'::jsonb) AS tasks
    FROM onboarding_journey j
    LEFT JOIN department d ON d.id = j.department_id
    LEFT JOIN site s ON s.id = j.site_id
    LEFT JOIN candidate c ON c.id = j.candidate_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'k', ot.task_key, 'n', ot.title, 'owner', ot.owner,
               'due', ot.due_on, 'done', ot.done, 'doneOn', ot.done_on,
               'day', COALESCE(ot.due_on - j.joining_on, 0))
             ORDER BY ot.display_order, ot.task_key) AS tasks
        FROM onboarding_task ot WHERE ot.journey_id = j.id
    ) t ON true`;

const toJourney = (r: Record<string, unknown>): Onboarding => ({
  id: r.id as string,
  candId: (r.candidate_id as string) ?? '',
  name: r.full_name as string,
  reqId: (r.req_id as string) ?? '',
  dept: r.dept_code as string,
  designation: (r.designation as string) ?? '',
  site: r.site_code as string,
  doj: r.joining_on as string,
  managerId: (r.manager_id as string) ?? '',
  buddyId: (r.buddy_id as string) ?? '',
  ctc: r.annual_ctc === null ? 0 : Number(r.annual_ctc),
  status: TO_STATUS[r.status as string] ?? 'Pre-boarding',
  bgv: (r.background_check as string) ?? 'not_started',
  tasks: (r.tasks as Record<string, unknown>[]).map((t) => ({
    k: t.k as string,
    n: t.n as string,
    owner: TO_OWNER[t.owner as string] ?? (t.owner as string),
    day: Number(t.day ?? 0),
    due: (t.due as string) ?? '',
    done: Boolean(t.done),
    doneOn: (t.doneOn as string | null) ?? null,
  })),
  docs: [],
});

async function load(db: TenantClient, id: string): Promise<Onboarding> {
  const { rows } = await db.query(`${PROJECTION} WHERE j.id = $1`, [id]);
  if (!rows[0]) throw new OnboardingError('no such onboarding journey', 'not_found');
  return toJourney(rows[0]);
}

/**
 * Recompute the journey's status from its checklist.
 *
 * 'completed' is never set here — that transition creates an employee and is
 * handled by `completeOnboarding`, which can do both in one transaction.
 */
async function restatus(db: TenantClient, id: string): Promise<void> {
  await db.query(
    `UPDATE onboarding_journey j
        SET status = CASE
              WHEN j.status IN ('completed', 'cancelled') THEN j.status
              WHEN j.joining_on <= CURRENT_DATE
                OR EXISTS (SELECT 1 FROM onboarding_task o
                            WHERE o.journey_id = j.id AND o.done)
                THEN 'in_progress'
              ELSE 'pre_boarding' END
      WHERE j.id = $1`, [id]);
}

/** HR and managers run onboarding; nobody else sees a joiner's CTC. */
function mayOnboard(caller: Caller): boolean {
  return caller.role === 'admin' || caller.role === 'manager';
}

export async function listOnboarding(caller: Caller): Promise<Onboarding[]> {
  if (!mayOnboard(caller)) return [];
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(`${PROJECTION} ORDER BY j.joining_on DESC`);
    return rows.map(toJourney);
  });
}

/** Tick or untick one checklist item. */
export async function setTask(
  caller: Caller,
  id: string,
  key: string,
  done: boolean,
): Promise<Onboarding> {
  if (!mayOnboard(caller)) {
    throw new OnboardingError('only a manager or admin may update a checklist', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const j = await db.query(
      'SELECT status FROM onboarding_journey WHERE id = $1 FOR UPDATE', [id]);
    if (!j.rows[0]) throw new OnboardingError('no such onboarding journey', 'not_found');
    if (j.rows[0].status === 'completed') {
      throw new OnboardingError('that journey is already complete', 'completed');
    }

    // done and done_on move together: the schema's CHECK (done = (done_on IS
    // NOT NULL)) refuses them apart, and a tick with no date is not a record.
    const upd = await db.query(
      `UPDATE onboarding_task
          SET done = $3,
              done_on = CASE WHEN $3 THEN CURRENT_DATE ELSE NULL END,
              done_by = CASE WHEN $3 THEN $4::uuid ELSE NULL END
        WHERE journey_id = $1 AND task_key = $2`,
      [id, key, done, caller.employeeId]);
    if (upd.rowCount === 0) {
      throw new OnboardingError(`no task ${key} on this journey`, 'no_task');
    }

    await restatus(db, id);
    return load(db, id);
  });
}

/**
 * Finish a journey: the person becomes an employee.
 *
 * Refused while anything is still open. The checklist covers background
 * verification, asset issue and payroll setup, so completing around it would
 * mean claiming those happened.
 */
export async function completeOnboarding(caller: Caller, id: string): Promise<Onboarding> {
  if (!mayOnboard(caller)) {
    throw new OnboardingError('only a manager or admin may complete onboarding', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT j.*, c.email AS candidate_email
         FROM onboarding_journey j
         LEFT JOIN candidate c ON c.id = j.candidate_id
        WHERE j.id = $1 FOR UPDATE OF j`, [id]);
    const j = rows[0];
    if (!j) throw new OnboardingError('no such onboarding journey', 'not_found');
    if (j.status === 'completed') {
      throw new OnboardingError('that journey is already complete', 'completed');
    }

    const open = await db.query(
      'SELECT count(*)::int n FROM onboarding_task WHERE journey_id = $1 AND NOT done', [id]);
    if (open.rows[0].n > 0) {
      throw new OnboardingError(
        `${open.rows[0].n} checklist item(s) still open`, 'incomplete');
    }

    // A work email is required to create the record, and the journey may not
    // carry one — fall back to the candidate's.
    const email = (j.candidate_email as string | null)
      ?? `${(j.full_name as string).toLowerCase().replace(/[^a-z]+/g, '.')}@360.technology`;

    const { id: employeeId } = await provisionEmployee(db, {
      fullName: j.full_name as string,
      workEmail: email,
      joinedOn: j.joining_on as string,
      departmentId: j.department_id as string | null,
      siteId: j.site_id as string | null,
      managerId: j.manager_id as string | null,
      designation: j.designation as string | null,
    });

    await db.query(
      `UPDATE onboarding_journey
          SET status = 'completed', employee_id = $2, completed_on = CURRENT_DATE
        WHERE id = $1`, [id, employeeId]);

    await db.query(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'people', 'onboarding_completed', 'notice', $1, COALESCE(e.full_name, 'system'),
              'employee', $2, jsonb_build_object('journey', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, employeeId, id]);

    return load(db, id);
  });
}
