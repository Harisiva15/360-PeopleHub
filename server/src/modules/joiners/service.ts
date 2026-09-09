/**
 * New joiners — a manager proposes, an admin approves.
 *
 * The split exists because "managers can add people" and "managers can grant
 * access" are different powers that look identical in a form. A manager who
 * can write to `employee` can create one with any role, for anyone. So they
 * write here instead, and approval is what turns a request into a person.
 *
 * An admin's own request is approved as it is created — they are the approver,
 * and making them click twice would teach them to distrust the queue.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import { provisionEmployee } from '../people/provision.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class JoinerError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'JoinerError';
    this.code = code;
  }
}

export interface NewJoiner {
  fullName: string;
  workEmail: string;
  employeeCode?: string | null;
  designation?: string | null;
  /** Config codes, as the screens use them — 'ENG', 'CHN', 'L2', 'IN'. */
  dept?: string | null;
  site?: string | null;
  grade?: string | null;
  shift?: string | null;
  managerId?: string | null;
  joiningOn: string;
  employmentType?: string;
  note?: string | null;
}

export interface JoiningRequest {
  id: string;
  fullName: string;
  workEmail: string;
  employeeCode: string | null;
  designation: string | null;
  dept: string | null;
  site: string | null;
  grade: string | null;
  joiningOn: string;
  employmentType: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  note: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  employeeId: string | null;
}

const PROJECTION = `
  SELECT jr.id, jr.full_name, jr.work_email, jr.employee_code, jr.designation,
         d.code AS dept_code, s.code AS site_code, g.code AS grade_code,
         jr.joining_on, jr.employment_type, jr.status, jr.note,
         jr.requested_by, rb.full_name AS requested_by_name, jr.requested_at,
         jr.decided_by, jr.decided_at, jr.decision_note, jr.employee_id
    FROM joining_request jr
    LEFT JOIN department  d  ON d.id = jr.department_id
    LEFT JOIN site        s  ON s.id = jr.site_id
    LEFT JOIN grade_band  g  ON g.id = jr.grade_id
    LEFT JOIN employee    rb ON rb.id = jr.requested_by`;

const toRequest = (r: Record<string, unknown>): JoiningRequest => ({
  id: r.id as string,
  fullName: r.full_name as string,
  workEmail: r.work_email as string,
  employeeCode: (r.employee_code as string | null) ?? null,
  designation: (r.designation as string | null) ?? null,
  dept: (r.dept_code as string | null) ?? null,
  site: (r.site_code as string | null) ?? null,
  grade: (r.grade_code as string | null) ?? null,
  joiningOn: r.joining_on as string,
  employmentType: r.employment_type as string,
  status: r.status as JoiningRequest['status'],
  note: (r.note as string | null) ?? null,
  requestedBy: (r.requested_by as string | null) ?? null,
  requestedByName: (r.requested_by_name as string | null) ?? null,
  requestedAt: (r.requested_at as Date).toISOString(),
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at ? (r.decided_at as Date).toISOString() : null,
  decisionNote: (r.decision_note as string | null) ?? null,
  employeeId: (r.employee_id as string | null) ?? null,
});

/** Resolve a config code to its uuid, or null when not supplied. */
async function codeToId(
  db: TenantClient,
  table: 'department' | 'site' | 'grade_band' | 'shift',
  code: string | null | undefined,
): Promise<string | null> {
  if (!code) return null;
  const { rows } = await db.query(`SELECT id FROM ${table} WHERE code = $1`, [code]);
  if (!rows[0]) throw new JoinerError(`no such ${table.replace('_', ' ')}: ${code}`, 'invalid');
  return rows[0].id as string;
}

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * Raise a request. An admin's is approved immediately; a manager's queues.
 */
export async function requestJoiner(
  caller: Caller,
  input: NewJoiner,
): Promise<JoiningRequest> {
  if (caller.role === 'employee') {
    throw new JoinerError('only a manager or an admin may add a joiner', 'forbidden');
  }
  if (!input.fullName?.trim()) throw new JoinerError('a name is required', 'invalid');
  if (!EMAIL.test(input.workEmail ?? '')) throw new JoinerError('a valid work email is required', 'invalid');
  if (!input.joiningOn) throw new JoinerError('a joining date is required', 'invalid');

  return withTenant(caller, async (db) => {
    // Somebody already here with that address is the common mistake — a
    // rehire, or a second request for the same person.
    const existing = await db.query(
      'SELECT code FROM employee WHERE work_email = $1::citext', [input.workEmail]);
    if (existing.rowCount) {
      throw new JoinerError(
        `${existing.rows[0].code} already uses that email address`, 'duplicate');
    }

    const [dept, site, grade] = await Promise.all([
      codeToId(db, 'department', input.dept),
      codeToId(db, 'site', input.site),
      codeToId(db, 'grade_band', input.grade),
    ]);

    let created;
    try {
      created = await db.query(
        `INSERT INTO joining_request
           (full_name, work_email, employee_code, designation, department_id, site_id,
            grade_id, manager_id, joining_on, employment_type, note, requested_by)
         VALUES ($1,$2::citext,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [input.fullName.trim(), input.workEmail, input.employeeCode ?? null,
          input.designation ?? null, dept, site, grade,
          input.managerId ?? caller.employeeId, input.joiningOn,
          input.employmentType ?? 'permanent', input.note ?? null, caller.employeeId]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new JoinerError('there is already a pending request for that address', 'duplicate');
      }
      throw e;
    }

    const id = created.rows[0].id as string;

    await db.query(
      `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                              subject_table, subject_id, detail)
       SELECT 'people', 'joiner_requested', $1, COALESCE(e.full_name, 'system'),
              'joining_request', $2, jsonb_build_object('email', $3::text)
         FROM employee e WHERE e.id = $1`,
      [caller.employeeId, id, input.workEmail]);

    // An admin is the approver, so their own request is already decided.
    if (caller.role === 'admin') {
      return approveInTransaction(db, caller, id, 'created directly by an admin');
    }
    return reload(db, id);
  });
}

async function reload(db: TenantClient, id: string): Promise<JoiningRequest> {
  const { rows } = await db.query(`${PROJECTION} WHERE jr.id = $1`, [id]);
  if (!rows[0]) throw new JoinerError('no such joining request', 'not_found');
  return toRequest(rows[0]);
}

/** Approve, and create the employee. Runs inside an existing transaction. */
async function approveInTransaction(
  db: TenantClient,
  caller: Caller,
  id: string,
  note: string | null,
): Promise<JoiningRequest> {
  const { rows } = await db.query(
    'SELECT * FROM joining_request WHERE id = $1 FOR UPDATE', [id]);
  const req = rows[0];
  if (!req) throw new JoinerError('no such joining request', 'not_found');
  if (req.status !== 'pending') {
    throw new JoinerError(`this request is already ${req.status}`, 'not_pending');
  }

  // Shared with the onboarding flow, which has to produce an identical record.
  const { id: employeeId, code } = await provisionEmployee(db, {
    fullName: req.full_name as string,
    workEmail: req.work_email as string,
    joinedOn: req.joining_on as string,
    departmentId: req.department_id as string | null,
    siteId: req.site_id as string | null,
    gradeId: req.grade_id as string | null,
    managerId: req.manager_id as string | null,
    designation: req.designation as string | null,
    employmentType: req.employment_type as string | null,
    code: req.employee_code as string | null,
  });

  await db.query(
    `UPDATE joining_request
        SET status = 'approved', decided_by = $1, decided_at = now(),
            decision_note = $2, employee_id = $3
      WHERE id = $4`,
    [caller.employeeId, note, employeeId, id]);

  await db.query(
    `INSERT INTO audit_log (category, action, severity, actor_employee_id, actor_label,
                            subject_table, subject_id, detail)
     SELECT 'people', 'joiner_approved', 'notice', $1, COALESCE(e.full_name, 'system'),
            'employee', $2, jsonb_build_object('code', $3::text, 'request', $4::text)
       FROM employee e WHERE e.id = $1`,
    [caller.employeeId, employeeId, code, id]);

  return reload(db, id);
}

export async function approveJoiner(
  caller: Caller,
  id: string,
  note?: string,
): Promise<JoiningRequest> {
  if (caller.role !== 'admin') {
    throw new JoinerError('only an admin may approve a joiner', 'forbidden');
  }
  return withTenant(caller, (db) => approveInTransaction(db, caller, id, note ?? null));
}

export async function rejectJoiner(
  caller: Caller,
  id: string,
  note?: string,
): Promise<JoiningRequest> {
  if (caller.role !== 'admin') {
    throw new JoinerError('only an admin may reject a joiner', 'forbidden');
  }
  return withTenant(caller, async (db) => {
    const r = await db.query(
      `UPDATE joining_request
          SET status = 'rejected', decided_by = $1, decided_at = now(), decision_note = $2
        WHERE id = $3 AND status = 'pending'`,
      [caller.employeeId, note ?? null, id]);
    if (r.rowCount === 0) {
      throw new JoinerError('no pending request with that id', 'not_pending');
    }
    return reload(db, id);
  });
}

/** Admins see every request; a manager sees the ones they raised. */
export async function listJoiners(
  caller: Caller,
  status?: JoiningRequest['status'],
): Promise<JoiningRequest[]> {
  if (caller.role === 'employee') return [];

  const where: string[] = [];
  const params: unknown[] = [];
  if (caller.role === 'manager') {
    params.push(caller.employeeId);
    where.push(`jr.requested_by = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`jr.status = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY jr.requested_at DESC`, params);
    return rows.map(toRequest);
  });
}
