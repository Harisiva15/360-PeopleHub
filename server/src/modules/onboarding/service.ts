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

import { reaches } from '../../auth/can.ts';
import { personInScope } from '../../tenancy/scope.ts';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';
import { provisionEmployee } from '../people/provision.ts';
import { openJoinerChecklist, transferToEmployee } from '../documents/service.ts';

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

const toJourney = (r: Record<string, unknown>, showPay: boolean): Onboarding => ({
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
  /*
   * A joiner's offered CTC is compensation data, so it is compensation's to
   * grant — not onboarding's. Running an onboarding checklist does not come
   * with the salary attached, and the manager layer holds onboarding without
   * holding any compensation at all.
   */
  ctc: showPay && r.annual_ctc !== null ? Number(r.annual_ctc) : 0,
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
});

async function load(db: TenantClient, id: string, showPay: boolean): Promise<Onboarding> {
  const { rows } = await db.query(`${PROJECTION} WHERE j.id = $1`, [id]);
  if (!rows[0]) throw new OnboardingError('no such onboarding journey', 'not_found');
  return toJourney(rows[0], showPay);
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
/**
 * May this caller open onboarding at all.
 *
 * `reaches(..., 'team')`, not `all || caller.hasReports`. The two admit the
 * same people today, and that is the only thing that made the old form look
 * harmless: it granted *all-scope entry* to anybody with a direct report, and
 * where the query behind it was unscoped the gate's breadth became the query's
 * breadth. That is how every joiner's offered salary became visible to any
 * manager in the company.
 *
 * The table gives the manager layer `onboarding` at team, so team is what the
 * gate asks for. Entry only: which journeys come back is `journeyScope`, and
 * which may be changed is `mayHandleJourney`.
 */
function mayOnboard(caller: Caller): boolean {
  return reaches(caller, 'onboarding', 'read', 'team');
}

/**
 * May this caller change this particular journey?
 *
 * A journey belongs to whoever will manage the joiner, because the joiner
 * usually has no employee row yet. So the line is walked over `manager_id`.
 *
 * A journey with no manager named is nobody's line, and only an all-scope
 * caller may touch it.
 */
async function mayHandleJourney(
  db: TenantClient,
  caller: Caller,
  journeyId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ manager_id: string | null }>(
    'SELECT manager_id FROM onboarding_journey WHERE id = $1', [journeyId]);
  if (!rows[0]) return false;
  const mgr = rows[0].manager_id;
  if (mgr === null) return reaches(caller, 'onboarding', 'write', 'all');
  return personInScope(db, caller, mgr, 'onboarding', 'write');
}

/** Whether this caller may see what a joiner is being paid. */
const maySeeJoinerPay = (caller: Caller): boolean =>
  reaches(caller, 'compensation', 'read', 'all');

/**
 * Which journeys this caller may see.
 *
 * `null` means none. The listing had no scope clause at all: `mayOnboard`
 * admits anybody with reports, and every journey in the tenant was then
 * returned to them — CTC included. The policy gives the manager layer
 * `onboarding` read *team*, so the clause below is what that scope was always
 * meant to mean.
 *
 * A journey hangs off `manager_id` rather than off an employee row, because its
 * subject is a joiner who usually has no employee record yet. So the subtree is
 * walked over the journey's manager, not over the joiner.
 */
function journeyScope(caller: Caller): { sql: string; params: unknown[] } | null {
  if (reaches(caller, 'onboarding', 'read', 'all')) return { sql: 'TRUE', params: [] };
  if (!caller.employeeId || !reaches(caller, 'onboarding', 'read', 'team')) return null;
  return {
    sql: `(j.manager_id = $1 OR j.manager_id IN (
            WITH RECURSIVE reports AS (
              SELECT id FROM employee WHERE manager_id = $1
              UNION ALL
              SELECT c.id FROM employee c JOIN reports r ON c.manager_id = r.id
            )
            SELECT id FROM reports
          ))`,
    params: [caller.employeeId],
  };
}

export async function listOnboarding(caller: Caller): Promise<Onboarding[]> {
  if (!mayOnboard(caller)) return [];
  const scope = journeyScope(caller);
  if (!scope) return [];
  const pay = maySeeJoinerPay(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} WHERE ${scope.sql} ORDER BY j.joining_on DESC`, scope.params);
    return rows.map((r) => toJourney(r, pay));
  });
}

export interface NewJourney {
  name: string;
  dept: string;
  designation: string;
  site?: string;
  doj: string;
  managerId?: string;
  buddyId?: string;
  ctc?: number;
  candId?: string;
}

/**
 * The standard joining checklist, offset in days around the joining date.
 *
 * Templated here rather than left to the caller: a journey created without a
 * checklist is a journey that can be completed instantly, and completing one
 * creates an employee.
 */
const TEMPLATE: [string, string, string, number][] = [
  ['offer_accept', 'Offer accepted', 'hr', -30],
  ['docs', 'Document collection (ID, education, experience)', 'candidate', -14],
  ['bgv', 'Background verification initiated', 'hr', -12],
  ['itasset', 'IT asset allocation (laptop, accessories)', 'it', -3],
  ['accounts', 'Email, VPN and tool accounts created', 'it', -2],
  ['joining', 'Joining formalities & Form 11/2 signed', 'hr', 0],
  ['induction', 'Company induction & policy walkthrough', 'hr', 0],
  ['payroll', 'Payroll, PF/UAN and bank setup', 'finance', 1],
  ['buddy', 'Buddy assigned & team introduction', 'manager', 1],
  ['goals', 'Probation goals & 30-60-90 plan set', 'manager', 5],
  ['training', 'Mandatory compliance training (POSH, InfoSec)', 'employee', 7],
  ['confirm', 'Probation confirmation review', 'manager', 180],
];

/** Start a journey, with the standard checklist dated around the joining date. */
export async function createJourney(
  caller: Caller,
  draft: NewJourney,
): Promise<Onboarding> {
  if (!mayOnboard(caller)) {
    throw new OnboardingError('only a manager or admin may start onboarding', 'forbidden');
  }
  if (!draft.name?.trim()) throw new OnboardingError('the joiner needs a name', 'invalid');
  if (!draft.doj) throw new OnboardingError('the joiner needs a joining date', 'invalid');

  return withTenant(caller, async (db) => {
    /*
     * A manager starts a joiner on their own line, not on somebody else's.
     *
     * The journey does not exist yet, so the subject is the manager the draft
     * names — defaulting to the caller, which is what a manager adding their
     * own joiner means. An all-scope caller passes either way.
     */
    const forManager = draft.managerId ?? caller.employeeId;
    if (!forManager) {
      throw new OnboardingError('say who the joiner will report to', 'invalid');
    }
    if (!(await personInScope(db, caller, forManager, 'onboarding', 'write'))) {
      throw new OnboardingError('you can only start a joiner on your own team', 'forbidden');
    }

    const dept = draft.dept
      ? (await db.query('SELECT id FROM department WHERE code = $1', [draft.dept])).rows[0]?.id
      : null;
    const site = draft.site
      ? (await db.query('SELECT id FROM site WHERE code = $1', [draft.site])).rows[0]?.id
      : null;

    const { rows } = await db.query(
      `INSERT INTO onboarding_journey
         (candidate_id, full_name, department_id, site_id, designation, joining_on,
          manager_id, buddy_id, annual_ctc, currency, status)
       SELECT $1, $2, $3, $4, $5, $6::date, $7, $8, $9, t.base_currency,
              CASE WHEN $6::date <= CURRENT_DATE THEN 'in_progress' ELSE 'pre_boarding' END
         FROM tenant t WHERE t.id = current_tenant_id()
       RETURNING id`,
      [draft.candId ?? null, draft.name.trim(), dept ?? null, site ?? null,
        draft.designation ?? null, draft.doj, draft.managerId ?? null,
        draft.buddyId ?? null, draft.ctc ?? null]);
    const id = rows[0].id as string;

    for (const [i, [key, title, owner, day]] of TEMPLATE.entries()) {
      await db.query(
        `INSERT INTO onboarding_task
           (journey_id, task_key, title, owner, due_on, display_order)
         VALUES ($1, $2, $3, $4, ($5::date + $6::int), $7)`,
        [id, key, title, owner, draft.doj, day, i]);
    }

    /*
     * The document checklist opens with the journey, in this same transaction.
     * A joiner created without one is a joiner nobody chases, and the chasing
     * has to start well before the joining date to be any use — so if the
     * checklist cannot be opened, the journey should not exist either.
     */
    await openJoinerChecklist(db, id, draft.doj);

    return load(db, id, maySeeJoinerPay(caller));
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
    if (!(await mayHandleJourney(db, caller, id))) {
      throw new OnboardingError('that joiner is not on your team', 'forbidden');
    }
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
    return load(db, id, maySeeJoinerPay(caller));
  });
}

/**
 * Finish a journey: the person becomes an employee.
 *
 * Refused while anything is still open. The checklist covers background
 * verification, asset issue and payroll setup, so completing around it would
 * mean claiming those happened.
 */
export async function completeOnboarding(
  caller: Caller,
  id: string,
  /**
   * The working pattern the new employee starts on, by code. Optional, and
   * omitted leaves them unassigned rather than guessed at — see
   * `ProvisionSpec.workScheduleCode`.
   */
  workScheduleCode?: string | null,
): Promise<Onboarding> {
  if (!mayOnboard(caller)) {
    throw new OnboardingError('only a manager or admin may complete onboarding', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    if (!(await mayHandleJourney(db, caller, id))) {
      throw new OnboardingError('that joiner is not on your team', 'forbidden');
    }
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

    const { id: employeeId } = await provisionEmployee(db, caller, {
      fullName: j.full_name as string,
      workEmail: email,
      joinedOn: j.joining_on as string,
      departmentId: j.department_id as string | null,
      siteId: j.site_id as string | null,
      managerId: j.manager_id as string | null,
      designation: j.designation as string | null,
      /* Chosen when the journey is completed, which is when the person becomes real. */
      workScheduleCode: workScheduleCode ?? null,
    });

    await db.query(
      `UPDATE onboarding_journey
          SET status = 'completed', employee_id = $2, completed_on = CURRENT_DATE
        WHERE id = $1`, [id, employeeId]);

    /* The documents follow the person, or their file looks empty on day one. */
    await transferToEmployee(db, id, employeeId);

    await db.query(
      `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'people', 'onboarding_completed', 'notice', $1, COALESCE(e.full_name, 'system'),
              'employee', $2, jsonb_build_object('journey', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, employeeId, id]);

    return load(db, id, maySeeJoinerPay(caller));
  });
}
