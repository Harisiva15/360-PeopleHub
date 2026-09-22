/**
 * The job title catalogue.
 *
 * **The count is the reason the module exists, so it is counted rather than
 * stored.** Every row carries how many people hold that title, derived from
 * `employee.job_title_id` in the same query. A cached count would be wrong
 * within a week — six modules move people between jobs and only this one would
 * remember to decrement — and a catalogue whose numbers are wrong is worse
 * than a list of strings, because somebody believes it.
 *
 * **A title somebody holds cannot be retired or deleted.** Deletion is refused
 * by the database (0032 makes `employee.job_title_id` ON DELETE RESTRICT);
 * retirement is refused here, because "inactive" is a state SQL cannot forbid
 * without a trigger nobody would expect to find.
 *
 * An employee reads exactly one record — their own — which is a different
 * shape from a filtered list, so it is a different method.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class JobTitleError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'JobTitleError';
    this.code = code;
  }
}

export interface JobTitle {
  id: string;
  code: string;
  n: string;
  dept: string;
  family: string;
  level: string;
  empType: string;
  desc: string;
  responsibilities: string[];
  required: string[];
  preferred: string[];
  status: 'Active' | 'Inactive' | 'Archived';
  createdOn: string;
  createdById: string | null;
  modifiedOn: string | null;
  modifiedById: string | null;
}

export interface JobTitleRow {
  title: JobTitle;
  employees: number;
}

export interface JobTitleFilter {
  q?: string | undefined;
  dept?: string | undefined;
  family?: string | undefined;
  level?: string | undefined;
  empType?: string | undefined;
  status?: string | undefined;
}

export interface JobTitleDraft {
  n: string;
  code: string;
  dept: string;
  level: string;
  family?: string | undefined;
  empType?: string | undefined;
  desc?: string | undefined;
  responsibilities?: string[] | undefined;
  required?: string[] | undefined;
  preferred?: string[] | undefined;
  status?: string | undefined;
}

interface Row {
  id: string; code: string; name: string; dept_code: string | null;
  family: string; level: string; employment_type: string; description: string;
  responsibilities: string[]; required_skills: string[]; preferred_skills: string[];
  status: JobTitle['status']; created_on: string; created_by_id: string | null;
  modified_on: string | null; modified_by_id: string | null;
  holders: string;
}

/*
 * The department is returned as its *code* — 'ENG', not a uuid — because every
 * screen calls `deptOf(t.dept)` against static config keyed by code. The uuid
 * stays server-side where it belongs.
 */
const PROJECTION = `
  SELECT t.id, t.code, t.name, d.code AS dept_code, t.family, t.level,
         t.employment_type, t.description, t.responsibilities,
         t.required_skills, t.preferred_skills, t.status,
         t.created_on::text, t.created_by_id, t.modified_on::text, t.modified_by_id,
         (SELECT count(*) FROM employee e
           WHERE e.job_title_id = t.id AND e.status <> 'exited')::text AS holders
    FROM job_title t
    LEFT JOIN department d ON d.id = t.department_id`;

const toTitle = (r: Row): JobTitleRow => ({
  title: {
    id: r.id,
    code: r.code,
    n: r.name,
    dept: r.dept_code ?? '',
    family: r.family,
    level: r.level,
    empType: r.employment_type,
    desc: r.description,
    responsibilities: r.responsibilities ?? [],
    required: r.required_skills ?? [],
    preferred: r.preferred_skills ?? [],
    status: r.status,
    createdOn: r.created_on,
    createdById: r.created_by_id,
    modifiedOn: r.modified_on,
    modifiedById: r.modified_by_id,
  },
  employees: Number(r.holders),
});

/** Anybody but an employee may browse; an employee gets `mine` instead. */
function mayBrowse(caller: Caller) {
  if (caller.role === 'employee') {
    throw new JobTitleError('Your role cannot browse the catalogue', 'forbidden');
  }
}

const mayWrite = (caller: Caller) => {
  if (caller.role !== 'admin') {
    throw new JobTitleError('Only an administrator can change the catalogue', 'forbidden');
  }
};

export async function listJobTitles(
  caller: Caller,
  f: JobTitleFilter = {},
): Promise<JobTitleRow[]> {
  mayBrowse(caller);
  const where: string[] = [];
  const params: unknown[] = [];

  /* Returns the placeholder, so a clause that needs the value twice can say so. */
  const bind = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.dept) where.push(`d.code = ${bind(f.dept)}`);
  if (f.family) where.push(`t.family = ${bind(f.family)}`);
  if (f.level) where.push(`t.level = ${bind(f.level)}`);
  if (f.empType) where.push(`t.employment_type = ${bind(f.empType)}`);
  if (f.status) where.push(`t.status = ${bind(f.status)}`);
  if (f.q?.trim()) {
    const p = bind(`%${f.q.trim()}%`);
    where.push(`(t.name ILIKE ${p} OR t.code ILIKE ${p})`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.level, t.name`,
      params,
    );
    return rows.map(toTitle);
  });
}

export async function getJobTitle(caller: Caller, id: string): Promise<JobTitleRow | null> {
  /*
   * An employee may read exactly one title: theirs. Anything else is refused
   * rather than filtered, so "not yours" and "not there" stay different
   * answers — a filtered list would say the title does not exist, which is a
   * lie somebody would act on.
   */
  if (caller.role === 'employee') {
    const own = await mineJobTitle(caller);
    if (!own || own.title.id !== id) {
      throw new JobTitleError('That title is not yours to read', 'forbidden');
    }
    return own;
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(`${PROJECTION} WHERE t.id = $1`, [id]);
    return rows[0] ? toTitle(rows[0]) : null;
  });
}

/** The one title the signed-in person holds. */
export async function mineJobTitle(caller: Caller): Promise<JobTitleRow | null> {
  if (!caller.employeeId) return null;
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<Row>(
      `${PROJECTION} WHERE t.id = (SELECT job_title_id FROM employee WHERE id = $1)`,
      [caller.employeeId],
    );
    return rows[0] ? toTitle(rows[0]) : null;
  });
}

const validate = (d: Partial<JobTitleDraft>) => {
  if (d.n !== undefined && !d.n.trim()) throw new JobTitleError('Give the title a name', 'invalid');
  if (d.code !== undefined) {
    if (!d.code.trim()) throw new JobTitleError('Give the title a code', 'invalid');
    if (!/^[A-Za-z0-9._-]+$/.test(d.code.trim())) {
      throw new JobTitleError('A code is letters, digits, dot, dash or underscore', 'invalid');
    }
  }
  if (d.level !== undefined && !/^L[1-8]$/.test(d.level)) {
    throw new JobTitleError('A level is L1 to L8', 'invalid');
  }
};

export async function createJobTitle(caller: Caller, d: JobTitleDraft): Promise<JobTitle> {
  mayWrite(caller);
  validate(d);
  if (!d.dept) throw new JobTitleError('Choose a department', 'invalid');

  return withTenant(caller, async (db) => {
    const { rows: dept } = await db.query<{ id: string }>(
      'SELECT id FROM department WHERE code = $1', [d.dept]);
    if (!dept[0]) throw new JobTitleError('No such department', 'invalid');

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO job_title
         (code, name, department_id, family, level, employment_type, description,
          responsibilities, required_skills, preferred_skills, status, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        d.code.trim(), d.n.trim(), dept[0].id, d.family ?? '', d.level,
        d.empType ?? 'Full Time', d.desc ?? '', d.responsibilities ?? [],
        d.required ?? [], d.preferred ?? [], d.status ?? 'Active', caller.employeeId,
      ],
    ).catch((e: { constraint?: string }) => {
      if (e.constraint === 'job_title_tenant_id_code_key') {
        throw new JobTitleError('That code is already in the catalogue', 'duplicate');
      }
      if (e.constraint === 'job_title_name_unique') {
        throw new JobTitleError('That title is already in the catalogue', 'duplicate');
      }
      throw e;
    });

    await audit(db, caller, 'job_title.created', rows[0]!.id, `${d.n.trim()} · ${d.code.trim()}`);
    const made = await getJobTitle(caller, rows[0]!.id);
    if (!made) throw new JobTitleError('The title was not created', 'invalid');
    return made.title;
  });
}

export async function updateJobTitle(
  caller: Caller,
  id: string,
  patch: Partial<JobTitleDraft>,
): Promise<JobTitle> {
  mayWrite(caller);
  validate(patch);

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };

  if (patch.n !== undefined) set('name', patch.n.trim());
  if (patch.code !== undefined) set('code', patch.code.trim());
  if (patch.family !== undefined) set('family', patch.family);
  if (patch.level !== undefined) set('level', patch.level);
  if (patch.empType !== undefined) set('employment_type', patch.empType);
  if (patch.desc !== undefined) set('description', patch.desc);
  if (patch.responsibilities !== undefined) set('responsibilities', patch.responsibilities);
  if (patch.required !== undefined) set('required_skills', patch.required);
  if (patch.preferred !== undefined) set('preferred_skills', patch.preferred);
  if (!sets.length) {
    const unchanged = await getJobTitle(caller, id);
    if (!unchanged) throw new JobTitleError('No such title', 'not_found');
    return unchanged.title;
  }

  return withTenant(caller, async (db) => {
    if (patch.dept !== undefined) {
      const { rows: dept } = await db.query<{ id: string }>(
        'SELECT id FROM department WHERE code = $1', [patch.dept]);
      if (!dept[0]) throw new JobTitleError('No such department', 'invalid');
      params.push(dept[0].id);
      sets.push(`department_id = $${params.length}`);
    }
    params.push(caller.employeeId);
    sets.push(`modified_by_id = $${params.length}`);
    sets.push('modified_on = CURRENT_DATE');
    params.push(id);

    const { rowCount } = await db.query(
      `UPDATE job_title SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (!rowCount) throw new JobTitleError('No such title', 'not_found');

    await audit(db, caller, 'job_title.updated', id, Object.keys(patch).join(', '));
    const after = await getJobTitle(caller, id);
    if (!after) throw new JobTitleError('No such title', 'not_found');
    return after.title;
  });
}

export async function setJobTitleStatus(
  caller: Caller,
  id: string,
  status: string,
): Promise<JobTitle> {
  mayWrite(caller);
  if (!['Active', 'Inactive', 'Archived'].includes(status)) {
    throw new JobTitleError('Not a status', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ holders: string; name: string }>(
      `SELECT (SELECT count(*) FROM employee e
                WHERE e.job_title_id = t.id AND e.status <> 'exited')::text AS holders,
              t.name
         FROM job_title t WHERE t.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new JobTitleError('No such title', 'not_found');

    /*
     * Retiring a title out from under its holders is how a headcount report
     * starts naming a job that officially does not exist. Refused here rather
     * than in the database because "inactive" is not a referential state.
     */
    if (status !== 'Active' && Number(row.holders) > 0) {
      throw new JobTitleError(
        `${row.holders} people hold ${row.name} — move them first`, 'in_use');
    }

    await db.query('UPDATE job_title SET status = $1, modified_on = CURRENT_DATE WHERE id = $2',
      [status, id]);
    await audit(db, caller, 'job_title.status', id, `${row.name} → ${status}`);
    const after = await getJobTitle(caller, id);
    if (!after) throw new JobTitleError('No such title', 'not_found');
    return after.title;
  });
}

export async function removeJobTitle(caller: Caller, id: string): Promise<JobTitle> {
  mayWrite(caller);
  /*
   * Read it before deleting it. The contract hands the deleted record back —
   * a toast needs the name, and afterwards there is nothing left to fetch.
   */
  const existing = await getJobTitle(caller, id);
  if (!existing) throw new JobTitleError('No such title', 'not_found');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<{ holders: string }>(
      `SELECT (SELECT count(*) FROM employee e WHERE e.job_title_id = $1)::text AS holders`,
      [id],
    );
    if (Number(rows[0]?.holders ?? 0) > 0) {
      throw new JobTitleError(
        `${rows[0]!.holders} people hold ${existing.title.n} — move them first`, 'in_use');
    }
    await db.query('DELETE FROM job_title WHERE id = $1', [id]);
    await audit(db, caller, 'job_title.removed', id, existing.title.n);
    return existing.title;
  });
}

/* One trail for every module — see 0009. */
async function audit(
  db: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  caller: Caller,
  action: string,
  subjectId: string,
  summary: string,
) {
  await db.query(
    `INSERT INTO audit_log (category, action, actor_employee_id, actor_label,
                            subject_table, subject_id, detail)
     SELECT 'catalogue', $1, $2,
            COALESCE((SELECT full_name FROM employee WHERE id = $2), 'system'),
            'job_title', $3, jsonb_build_object('summary', $4::text)`,
    [action, caller.employeeId, subjectId, summary],
  );
}
