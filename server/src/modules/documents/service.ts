/**
 * Document collection — what has been asked for, and what has arrived.
 *
 * **A request is not a file.** `document` holds bytes and its `storage_key` is
 * NOT NULL, which makes it the wrong place for "we asked for a degree
 * certificate and it has not come". That question has an answer from the day
 * the offer goes out and long before any PDF exists, so the request is its own
 * record and points at a file only once there is one.
 *
 * **This deployment has no object storage**, so today every request lives its
 * whole life with nothing attached. That is a real limitation and it is also
 * the less important half: HR needs to know what is outstanding and who is
 * chasing it. Attaching the file is a later commit and a storage bucket.
 *
 * **Verification is a person and a date, not a flag.** The schema refuses a
 * verified request without both — a tick with nobody behind it is the state
 * every document audit is trying to find.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class DocumentError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}

const STATUSES = ['pending', 'received', 'verified', 'rejected', 'waived'];

/**
 * What a new joiner in India is asked for.
 *
 * Templated here for the same reason the onboarding checklist is: a joiner
 * created with no document list is one nobody chases. Regulated identifiers
 * are deliberately absent — this tenant does not store PAN or bank details,
 * and asking for a document the system cannot hold would be theatre.
 */
const JOINER_DOCUMENTS: [string, string, boolean][] = [
  ['photo_id', 'Government photo ID', true],
  ['address_proof', 'Proof of address', true],
  ['education', 'Highest degree certificate', true],
  ['experience', 'Experience / relieving letter', true],
  ['payslips', 'Last three payslips', false],
  ['offer_signed', 'Signed offer letter', true],
  ['bank_mandate', 'Bank mandate form', false],
  ['photo', 'Passport photograph', false],
  ['medical', 'Pre-employment medical', false],
];

export interface DocRequest {
  id: string;
  journeyId: string | null;
  empId: string | null;
  kind: string;
  label: string;
  mandatory: boolean;
  status: string;
  due: string | null;
  receivedOn: string | null;
  verifiedBy: string | null;
  verifiedOn: string | null;
  note: string;
  hasFile: boolean;
}

const PROJECTION = `
  SELECT r.id, r.journey_id, r.employee_id, r.kind, r.label, r.mandatory, r.status,
         r.due_on, r.received_on, r.verified_by, r.verified_on, r.note,
         (r.document_id IS NOT NULL) AS has_file
    FROM document_request r`;

const toRequest = (r: Record<string, unknown>): DocRequest => ({
  id: r.id as string,
  journeyId: (r.journey_id as string | null) ?? null,
  empId: (r.employee_id as string | null) ?? null,
  kind: r.kind as string,
  label: r.label as string,
  mandatory: Boolean(r.mandatory),
  status: r.status as string,
  due: (r.due_on as string | null) ?? null,
  receivedOn: (r.received_on as string | null) ?? null,
  verifiedBy: (r.verified_by as string | null) ?? null,
  verifiedOn: (r.verified_on as string | null) ?? null,
  note: (r.note as string) ?? '',
  hasFile: Boolean(r.has_file),
});

/** HR and managers chase documents; an employee sees only their own. */
function mayChase(caller: Caller): boolean {
  return caller.role === 'admin' || caller.role === 'manager';
}

export async function listRequests(
  caller: Caller,
  q: { journeyId?: string; empId?: string } = {},
): Promise<DocRequest[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  if (q.journeyId) { params.push(q.journeyId); where.push(`r.journey_id = $${params.length}`); }
  if (q.empId) { params.push(q.empId); where.push(`r.employee_id = $${params.length}`); }

  if (!mayChase(caller)) {
    params.push(caller.employeeId);
    where.push(`r.employee_id = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.display_order, r.label`, params);
    return rows.map(toRequest);
  });
}

/**
 * Open the standard checklist against a joiner, inside a transaction the caller
 * already holds.
 *
 * This takes a `db` rather than a `Caller` so that onboarding can open the
 * checklist in the same transaction that creates the journey. Starting a second
 * transaction from inside the first would not see the uncommitted journey and
 * would decide there was nothing to chase — which is exactly what it did before
 * this was split out.
 *
 * Idempotent: re-running adds anything the template has gained without
 * disturbing what has already been collected, which is what you want when the
 * list changes mid-intake.
 */
export async function openJoinerChecklist(
  db: TenantClient,
  journeyId: string,
  joiningOn: string,
  dueOn?: string,
): Promise<DocRequest[]> {
  for (const [i, [kind, label, mandatory]] of JOINER_DOCUMENTS.entries()) {
    await db.query(
      `INSERT INTO document_request
         (journey_id, kind, label, mandatory, due_on, display_order)
       VALUES ($1,$2,$3,$4, COALESCE($5::date, $6::date - 7), $7)
       ON CONFLICT (tenant_id, journey_id, employee_id, kind) DO NOTHING`,
      [journeyId, kind, label, mandatory, dueOn ?? null, joiningOn, i]);
  }
  return listRequestsIn(db, { journeyId });
}

/** Open the standard checklist against a joiner who already exists. */
export async function requestJoinerDocuments(
  caller: Caller,
  journeyId: string,
  dueOn?: string,
): Promise<DocRequest[]> {
  if (!mayChase(caller)) {
    throw new DocumentError('only a manager or admin may request documents', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const j = await db.query('SELECT joining_on FROM onboarding_journey WHERE id = $1', [journeyId]);
    if (!j.rows[0]) throw new DocumentError('no such onboarding journey', 'not_found');
    return openJoinerChecklist(db, journeyId, j.rows[0].joining_on as string, dueOn);
  });
}

async function listRequestsIn(
  db: TenantClient,
  q: { journeyId?: string; empId?: string },
): Promise<DocRequest[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.journeyId) { params.push(q.journeyId); where.push(`r.journey_id = $${params.length}`); }
  if (q.empId) { params.push(q.empId); where.push(`r.employee_id = $${params.length}`); }
  const { rows } = await db.query(
    `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.display_order, r.label`, params);
  return rows.map(toRequest);
}

/** Ask for something the template does not cover. */
export async function requestDocument(
  caller: Caller,
  draft: { journeyId?: string; empId?: string; kind: string; label: string;
           mandatory?: boolean; due?: string },
): Promise<DocRequest[]> {
  if (!mayChase(caller)) {
    throw new DocumentError('only a manager or admin may request documents', 'forbidden');
  }
  if (!draft.label?.trim()) throw new DocumentError('say which document', 'invalid');
  if (!draft.kind?.trim()) throw new DocumentError('a document needs a kind', 'invalid');
  if (!draft.journeyId === !draft.empId) {
    throw new DocumentError('a request belongs to a joiner or an employee, not both', 'invalid');
  }

  return withTenant(caller, async (db) => {
    try {
      await db.query(
        `INSERT INTO document_request (journey_id, employee_id, kind, label, mandatory, due_on, display_order)
         VALUES ($1,$2,$3,$4,$5,$6::date,99)`,
        [draft.journeyId ?? null, draft.empId ?? null, draft.kind.trim(),
          draft.label.trim(), draft.mandatory ?? true, draft.due ?? null]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new DocumentError('that document has already been requested', 'duplicate');
      }
      throw e;
    }
    return listRequestsIn(db,
      draft.journeyId ? { journeyId: draft.journeyId } : { empId: draft.empId! });
  });
}

/**
 * Move a request along.
 *
 * Received, verified, rejected and waived each carry different obligations,
 * which the schema enforces: anything past pending says when it arrived, and a
 * verified one says who checked it. Setting them here together is what keeps
 * those constraints satisfiable.
 */
export async function setRequestStatus(
  caller: Caller,
  id: string,
  status: string,
  note?: string,
): Promise<DocRequest> {
  if (!mayChase(caller)) {
    throw new DocumentError('only a manager or admin may mark a document', 'forbidden');
  }
  if (!STATUSES.includes(status)) throw new DocumentError(`unknown status: ${status}`, 'invalid');
  if (status === 'rejected' && !note?.trim()) {
    throw new DocumentError('say why it was rejected', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      'SELECT id FROM document_request WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows[0]) throw new DocumentError('no such document request', 'not_found');

    await db.query(
      `UPDATE document_request SET
         status = $2,
         received_on = CASE
           WHEN $2 IN ('pending', 'waived') THEN NULL
           ELSE COALESCE(received_on, CURRENT_DATE) END,
         verified_by = CASE WHEN $2 = 'verified' THEN $3::uuid ELSE NULL END,
         verified_on = CASE WHEN $2 = 'verified' THEN CURRENT_DATE ELSE NULL END,
         note = COALESCE($4, note)
       WHERE id = $1`, [id, status, caller.employeeId, note ?? null]);

    const { rows } = await db.query(`${PROJECTION} WHERE r.id = $1`, [id]);
    return toRequest(rows[0]!);
  });
}

/**
 * Move a joiner's documents onto their employee record once they exist.
 *
 * Called when onboarding completes. Without it the collected documents stay
 * attached to a journey nobody opens again, and the employee's file looks
 * empty on their first day.
 */
export async function transferToEmployee(
  db: TenantClient,
  journeyId: string,
  employeeId: string,
): Promise<void> {
  await db.query(
    'UPDATE document_request SET journey_id = NULL, employee_id = $2 WHERE journey_id = $1',
    [journeyId, employeeId]);
}

export interface DocSummary {
  total: number;
  outstanding: number;
  received: number;
  verified: number;
  mandatoryOutstanding: number;
}

/** What is still missing, which is the only number anybody asks for. */
export async function collectionSummary(
  caller: Caller,
  q: { journeyId?: string; empId?: string },
): Promise<DocSummary> {
  const rows = await listRequests(caller, q);
  return {
    total: rows.length,
    outstanding: rows.filter((r) => r.status === 'pending').length,
    received: rows.filter((r) => r.status === 'received').length,
    verified: rows.filter((r) => r.status === 'verified').length,
    mandatoryOutstanding: rows.filter(
      (r) => r.mandatory && ['pending', 'rejected'].includes(r.status)).length,
  };
}
