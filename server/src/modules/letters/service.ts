/**
 * HR letters.
 *
 * **The queue was unreachable from the end it starts at.** `issue` was live in
 * the contract and the HR screen could act on a request, but nothing could
 * raise one — so the queue was always empty and the whole workflow existed
 * only for data somebody had invented. Asking for a letter is the half that
 * was missing.
 *
 * **An instant letter is not a request.** A salary certificate states what
 * somebody is paid, which is true the moment it is asked for; queuing it for a
 * human to approve is ceremony. The `instant` flag on `letter_type` says which
 * are which, and an instant type is issued in the same call that asks for it.
 *
 * **The issued text is frozen, not regenerated.** See migration 0024. An
 * experience letter asserts a designation and a tenure; re-rendering it from
 * today's data six months later answers a different question from the one it
 * answered when it went out, and the difference is what somebody will dispute.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller, TenantClient } from '../../tenancy/context.ts';

export class LetterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'LetterError';
    this.code = code;
  }
}

export interface LetterRequest {
  id: string;
  empId: string;
  type: string;
  purpose: string;
  requestedOn: string;
  status: 'Pending' | 'Issued' | 'Rejected';
  issuedOn: string | null;
  /** The letter as issued. Empty until it is. */
  body: string;
  reference: string | null;
  declineReason: string | null;
}

export interface LetterType {
  code: string;
  name: string;
  /** Generated from live data with no queue. */
  instant: boolean;
  requiresApproval: boolean;
}

const TO_STATUS: Record<string, LetterRequest['status']> = {
  pending: 'Pending', issued: 'Issued', rejected: 'Rejected',
};

const PROJECTION = `
  SELECT lr.id, lr.employee_id, lt.code AS type_code, lr.purpose, lr.requested_on,
         lr.status, lr.issued_on, lr.letter_body, lr.reference, lr.decline_reason
    FROM letter_request lr
    JOIN letter_type lt ON lt.id = lr.letter_type_id`;

const toRequest = (r: Record<string, unknown>): LetterRequest => ({
  id: r.id as string,
  empId: r.employee_id as string,
  type: r.type_code as string,
  purpose: (r.purpose as string) ?? '',
  requestedOn: r.requested_on as string,
  status: TO_STATUS[r.status as string] ?? 'Pending',
  issuedOn: (r.issued_on as string | null) ?? null,
  body: (r.letter_body as string) ?? '',
  reference: (r.reference as string | null) ?? null,
  declineReason: (r.decline_reason as string | null) ?? null,
});

/**
 * What this caller may see.
 *
 * A letter request carries a purpose — "home loan", "new employer" — which is
 * a private thing to have told your employer. HR sees the queue because they
 * issue it; a manager has no business in it, so unlike overtime this does not
 * open up to the reporting line.
 */
function scope(caller: Caller, params: unknown[]): string {
  if (caller.role === 'admin') return '';
  if (!caller.employeeId) throw new LetterError('this login has no employee record', 'forbidden');
  params.push(caller.employeeId);
  return `lr.employee_id = $${params.length}`;
}

export async function listLetterTypes(caller: Caller): Promise<LetterType[]> {
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT code, name, instant, requires_approval
         FROM letter_type WHERE active ORDER BY instant DESC, name`);
    return rows.map((r) => ({
      code: r.code as string,
      name: r.name as string,
      instant: Boolean(r.instant),
      requiresApproval: Boolean(r.requires_approval),
    }));
  });
}

export async function listLetterRequests(
  caller: Caller,
  status?: string,
): Promise<LetterRequest[]> {
  const params: unknown[] = [];
  const where: string[] = [];

  const scoped = scope(caller, params);
  if (scoped) where.push(scoped);

  if (status) {
    const stored = Object.keys(TO_STATUS).find((k) => TO_STATUS[k] === status);
    if (!stored) throw new LetterError(`unknown status: ${status}`, 'invalid');
    params.push(stored);
    where.push(`lr.status = $${params.length}`);
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${PROJECTION} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY lr.requested_on DESC, lr.id`, params);
    return rows.map(toRequest);
  });
}

/**
 * The facts a letter asserts, read once and rendered into the body.
 *
 * Deliberately a single read inside the issuing transaction: a letter that
 * gathered its figures across several statements could state a designation
 * from before a promotion and a salary from after it.
 */
interface Facts {
  name: string;
  code: string;
  designation: string;
  department: string;
  site: string;
  city: string;
  joinedOn: string;
  status: string;
  ctc: number | null;
  currency: string;
  company: string;
}

async function factsFor(db: TenantClient, empId: string): Promise<Facts> {
  /*
   * The structure is dated, so the one in force today is the one whose window
   * contains today — `valid_to` null meaning "still current". Taking the
   * latest row regardless would quote a revision that has not started yet.
   */
  const { rows } = await db.query(
    `SELECT e.full_name, e.code, e.designation, e.joined_on, e.status,
            d.name AS dept, s.name AS site, s.city,
            le.legal_name AS company, le.currency AS entity_currency,
            ss.annual_ctc, ss.currency AS pay_currency
       FROM employee e
       LEFT JOIN department d ON d.id = e.department_id
       LEFT JOIN site s ON s.id = e.site_id
       LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
       LEFT JOIN LATERAL (
         SELECT x.annual_ctc, x.currency FROM salary_structure x
          WHERE x.employee_id = e.id
            AND x.valid_from <= CURRENT_DATE
            AND (x.valid_to IS NULL OR x.valid_to >= CURRENT_DATE)
          ORDER BY x.valid_from DESC LIMIT 1
       ) ss ON true
      WHERE e.id = $1`, [empId]);
  const r = rows[0];
  if (!r) throw new LetterError('no such employee', 'not_found');
  return {
    name: r.full_name as string,
    code: r.code as string,
    designation: (r.designation as string) ?? '',
    department: (r.dept as string) ?? '',
    site: (r.site as string) ?? '',
    city: (r.city as string) ?? '',
    joinedOn: r.joined_on as string,
    status: r.status as string,
    ctc: r.annual_ctc === null || r.annual_ctc === undefined ? null : Number(r.annual_ctc),
    currency: (r.pay_currency as string) ?? (r.entity_currency as string) ?? 'INR',
    company: (r.company as string) ?? '',
  };
}

/**
 * A date as a letter writes it, from the 'YYYY-MM-DD' the pool hands back.
 *
 * Parsed from its parts rather than through `new Date(s)`, which reads a bare
 * date as UTC midnight and renders it a day early in any zone behind it — the
 * bug the offer letters had.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function inWords(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const money = (n: number, ccy: string) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: ccy, maximumFractionDigits: 0 })
    .format(n);

/**
 * Render one letter.
 *
 * Plain text, because that is what the column holds and what survives being
 * read back in five years. A type with a `template_body` configured uses it
 * with the same substitutions; the defaults below are what an unconfigured
 * tenant gets rather than an error.
 */
function render(type: string, f: Facts, purpose: string, template: string | null): string {
  const today = inWords(new Date().toISOString().slice(0, 10));
  const subs: Record<string, string> = {
    '{{name}}': f.name,
    '{{code}}': f.code,
    '{{designation}}': f.designation,
    '{{department}}': f.department,
    '{{site}}': f.site,
    '{{city}}': f.city,
    '{{joined}}': inWords(f.joinedOn),
    '{{company}}': f.company,
    '{{today}}': today,
    '{{purpose}}': purpose,
    '{{ctc}}': f.ctc === null ? '—' : money(f.ctc, f.currency),
  };

  if (template) {
    return Object.entries(subs).reduce((out, [k, v]) => out.split(k).join(v), template);
  }

  const head = `${f.company}\n${today}\n\nTO WHOMSOEVER IT MAY CONCERN\n\n`;
  const foot = `\n\nFor ${f.company}\n\nAuthorised Signatory\nHuman Resources`;

  switch (type) {
    case 'exp':
      return `${head}This is to certify that ${f.name} (Employee Code ${f.code}) `
        + `${f.status === 'exited' ? 'was' : 'has been'} employed with ${f.company} `
        + `from ${inWords(f.joinedOn)}${f.status === 'exited' ? '' : ' to date'}, `
        + `most recently as ${f.designation} in the ${f.department} department at our `
        + `${f.site} office.\n\nDuring this period their conduct and performance were `
        + `found to be satisfactory.\n\nThis letter is issued on request `
        + `${purpose ? `for the purpose of ${purpose.toLowerCase()}` : ''}.`.trimEnd() + foot;

    case 'salcert':
      return `${head}This is to certify that ${f.name} (Employee Code ${f.code}) is employed `
        + `with ${f.company} as ${f.designation}, having joined on ${inWords(f.joinedOn)}.`
        + `\n\nTheir current annual cost to company is ${subs['{{ctc}}']}.`
        + `\n\nThis certificate is issued on request `
        + `${purpose ? `for the purpose of ${purpose.toLowerCase()}` : ''} and does not `
        + `constitute a commitment of future employment or earnings.`.trimEnd() + foot;

    case 'addr':
      return `${head}This is to certify that ${f.name} (Employee Code ${f.code}) is employed `
        + `with ${f.company} as ${f.designation} and is presently attached to our `
        + `${f.site} office at ${f.city}.\n\nThis letter is issued on request `
        + `${purpose ? `for the purpose of ${purpose.toLowerCase()}` : ''}.`.trimEnd() + foot;

    case 'appt':
      return `${head}This is to confirm the appointment of ${f.name} (Employee Code ${f.code}) `
        + `with ${f.company} as ${f.designation} in the ${f.department} department, `
        + `effective ${inWords(f.joinedOn)}.`.trimEnd() + foot;

    case 'noc':
      return `${head}${f.company} has no objection to ${f.name} (Employee Code ${f.code}), `
        + `presently employed as ${f.designation}, `
        + `${purpose ? `proceeding with ${purpose.toLowerCase()}` : 'proceeding as requested'}.`
        + `\n\nThis letter does not alter the terms of their employment.`.trimEnd() + foot;

    case 'rel':
      return `${head}This is to certify that ${f.name} (Employee Code ${f.code}) was employed `
        + `with ${f.company} as ${f.designation} from ${inWords(f.joinedOn)} and has been `
        + `relieved of their duties, all company property and dues having been settled.`
        + foot;

    default:
      /*
       * An unknown type gets a letter that states only what is certain rather
       * than a blank page. Form 16 and increment letters need payroll figures
       * this deployment does not yet produce, and inventing them would be
       * worse than saying so.
       */
      return `${head}This is to certify that ${f.name} (Employee Code ${f.code}) is employed `
        + `with ${f.company} as ${f.designation}, having joined on ${inWords(f.joinedOn)}.`
        + foot;
  }
}

export interface NewLetterRequest {
  empId?: string;
  type: string;
  purpose?: string;
}

/**
 * Ask for a letter.
 *
 * An instant type is issued here and now; anything else joins the queue. You
 * ask for your own — a letter states facts about a person and is addressed to
 * whoever they choose to give it to, so somebody else requesting one on your
 * behalf is not a thing that should be possible without you knowing.
 */
export async function requestLetter(
  caller: Caller,
  draft: NewLetterRequest,
): Promise<LetterRequest> {
  if (!caller.employeeId) {
    throw new LetterError('this login has no employee record', 'forbidden');
  }
  const empId = draft.empId || caller.employeeId;
  if (empId !== caller.employeeId && caller.role !== 'admin') {
    throw new LetterError('you can only request your own letters', 'forbidden');
  }
  if (!draft.type?.trim()) throw new LetterError('say which letter you need', 'invalid');

  return withTenant(caller, async (db) => {
    if (empId !== caller.employeeId) {
      const who = await db.query(
        "SELECT 1 FROM employee WHERE id = $1 AND status <> 'exited'", [empId]);
      if (!who.rowCount) throw new LetterError('no such employee', 'not_found');
    }

    const t = await db.query(
      'SELECT id, code, instant, template_body FROM letter_type WHERE code = $1 AND active',
      [draft.type.trim()]);
    const type = t.rows[0];
    if (!type) throw new LetterError(`no such letter type: ${draft.type}`, 'not_found');

    /*
     * One open request per person per type. Asking twice because the first is
     * taking a while should not put two letters in the queue for HR to notice
     * are the same.
     */
    const open = await db.query(
      `SELECT id FROM letter_request
        WHERE employee_id = $1 AND letter_type_id = $2 AND status = 'pending'`,
      [empId, type.id]);
    if (open.rowCount) {
      throw new LetterError('you already have an open request for that letter', 'duplicate');
    }

    const purpose = (draft.purpose ?? '').trim();
    const { rows } = await db.query(
      `INSERT INTO letter_request (employee_id, letter_type_id, purpose)
       VALUES ($1, $2, $3) RETURNING id`, [empId, type.id, purpose]);
    const id = rows[0]!.id as string;

    if (type.instant) {
      const facts = await factsFor(db, empId);
      await issueInto(db, id, facts, type.code as string,
        purpose, type.template_body as string | null, null);
    }

    const back = await db.query(`${PROJECTION} WHERE lr.id = $1`, [id]);
    return toRequest(back.rows[0]!);
  });
}

/** A human-readable reference, unique enough to quote on the phone. */
const referenceFor = (code: string, id: string) =>
  `${code.toUpperCase()}/${new Date().getFullYear()}/${id.slice(0, 8).toUpperCase()}`;

/** Freeze the letter onto the row. Shared by instant issue and the HR queue. */
async function issueInto(
  db: TenantClient,
  id: string,
  facts: Facts,
  typeCode: string,
  purpose: string,
  template: string | null,
  issuedBy: string | null,
): Promise<void> {
  const body = render(typeCode, facts, purpose, template);
  await db.query(
    `UPDATE letter_request
        SET status = 'issued', issued_on = CURRENT_DATE, issued_by = $2,
            letter_body = $3, reference = $4
      WHERE id = $1`,
    [id, issuedBy, body, referenceFor(typeCode, id)]);
}

/**
 * Issue a queued letter.
 *
 * The body is rendered here rather than taken from the caller: a letter whose
 * text came from the request body is a letter anybody with the endpoint can
 * make the company say anything in.
 */
export async function issueLetter(caller: Caller, id: string): Promise<LetterRequest> {
  if (caller.role === 'employee' || !caller.employeeId) {
    throw new LetterError('only HR may issue a letter', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      `SELECT lr.id, lr.employee_id, lr.status, lr.purpose,
              lt.code AS type_code, lt.template_body
         FROM letter_request lr
         JOIN letter_type lt ON lt.id = lr.letter_type_id
        WHERE lr.id = $1 FOR UPDATE OF lr`, [id]);
    const row = cur.rows[0];
    if (!row) throw new LetterError('no such letter request', 'not_found');
    if (row.status !== 'pending') {
      throw new LetterError(`that request was already ${row.status}`, 'already_decided');
    }

    const facts = await factsFor(db, row.employee_id as string);
    await issueInto(db, id, facts, row.type_code as string,
      (row.purpose as string) ?? '', row.template_body as string | null, caller.employeeId);

    const back = await db.query(`${PROJECTION} WHERE lr.id = $1`, [id]);
    return toRequest(back.rows[0]!);
  });
}

/** Refuse a request. A reason is required — see 0024. */
export async function rejectLetter(
  caller: Caller,
  id: string,
  reason: string,
): Promise<LetterRequest> {
  if (caller.role === 'employee' || !caller.employeeId) {
    throw new LetterError('only HR may act on a letter request', 'forbidden');
  }
  if (!reason?.trim()) {
    throw new LetterError('say why — the employee sees this', 'invalid');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      'SELECT id, status FROM letter_request WHERE id = $1 FOR UPDATE', [id]);
    const row = cur.rows[0];
    if (!row) throw new LetterError('no such letter request', 'not_found');
    if (row.status !== 'pending') {
      throw new LetterError(`that request was already ${row.status}`, 'already_decided');
    }

    await db.query(
      `UPDATE letter_request SET status = 'rejected', decline_reason = $2 WHERE id = $1`,
      [id, reason.trim()]);

    const back = await db.query(`${PROJECTION} WHERE lr.id = $1`, [id]);
    return toRequest(back.rows[0]!);
  });
}
