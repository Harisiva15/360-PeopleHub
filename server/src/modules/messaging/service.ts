/**
 * WhatsApp — templates, consent, rules and the send log.
 *
 * **Nothing here sends a message.** Every method manages the configuration and
 * reads the record: what wording Meta has approved, who agreed to be messaged,
 * what fires when, and what went out. Actually delivering is a worker's job —
 * it reads `notification_log` for queued rows and calls the Business API — and
 * keeping that out of this module is why the module can exist before the Meta
 * account does.
 *
 * **Consent is the whole point of the module.** WhatsApp is not email: a
 * business messaging somebody who did not opt in is a policy violation with
 * the number behind it, and Meta enforces that by taking the number away. So
 * consent is a positive record with a date and a source, every change writes
 * an append-only `consent_event`, and withdrawing HR updates withdraws
 * marketing with it — marketing rides on the same number, and the schema's own
 * CHECK refuses the other combination.
 *
 * **Two gates before anything is live.** A template Meta has not approved
 * cannot be enabled, and a rule on a template that is not live cannot be
 * enabled either. The first is a CHECK on the row; the second is a trigger
 * across the two tables, added in 0026, because a paused template whose rule
 * kept firing is exactly the failure that loses a number.
 */

import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';
import { EMPLOYEE_PROJECTION } from '../employees/queries.ts';
import { toEmployee } from '../employees/mapper.ts';
import type { Employee } from '../employees/mapper.ts';

export class MessagingError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}

const CHANNEL = 'whatsapp';

const TO_CATEGORY: Record<string, string> = {
  utility: 'Utility', marketing: 'Marketing',
  authentication: 'Authentication', service: 'Utility',
};

const TO_LOG_STATUS: Record<string, string> = {
  queued: 'Queued', sent: 'Sent', delivered: 'Delivered',
  read: 'Read', failed: 'Failed', suppressed: 'Failed',
};

export interface WaTemplate {
  id: string;
  name: string;
  cat: string;
  lang: string;
  status: 'Approved' | 'Pending review';
  event: string;
  audience: string;
  body: string;
  vars: string[];
  cta: string | null;
  on: boolean;
}

/** `{{name}}` placeholders, in the order they first appear. */
const varsOf = (body: string): string[] => {
  const seen: string[] = [];
  for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.includes(m[1]!)) seen.push(m[1]!);
  }
  return seen;
};

export async function templates(caller: Caller): Promise<WaTemplate[]> {
  if (caller.role !== 'admin') {
    throw new MessagingError('only an admin may manage messaging', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT id, code, name, category, body, cta_label, trigger_event, audience,
              approval_status, enabled
         FROM message_template WHERE channel = $1 ORDER BY name`, [CHANNEL]);
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      cat: TO_CATEGORY[r.category as string] ?? 'Utility',
      /* One language for now. The column would go on message_template. */
      lang: 'en',
      status: r.approval_status === 'approved' ? 'Approved' as const : 'Pending review' as const,
      event: (r.trigger_event as string) ?? '',
      audience: (r.audience as string) ?? '',
      body: r.body as string,
      vars: varsOf(r.body as string),
      cta: (r.cta_label as string | null) ?? null,
      on: Boolean(r.enabled),
    }));
  });
}

/**
 * Pause or resume a template.
 *
 * Enabling one Meta has not approved is refused here with the reason rather
 * than left to the row's CHECK, which would surface as a constraint violation
 * and a 500. Pausing is always allowed — stopping a send is never the risky
 * direction.
 */
export async function setTemplateEnabled(
  caller: Caller,
  id: string,
  on: boolean,
): Promise<WaTemplate> {
  if (caller.role !== 'admin') {
    throw new MessagingError('only an admin may manage messaging', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      'SELECT id, approval_status FROM message_template WHERE id = $1 FOR UPDATE', [id]);
    const row = cur.rows[0];
    if (!row) throw new MessagingError('no such template', 'not_found');

    if (on && row.approval_status !== 'approved') {
      throw new MessagingError(
        `Meta has not approved this template — it is ${row.approval_status}`, 'not_approved');
    }

    await db.query('UPDATE message_template SET enabled = $2 WHERE id = $1', [id, on]);

    /*
     * Pausing a template pauses its rules with it. Leaving them enabled would
     * put the rule list and the template list in disagreement, and the trigger
     * added in 0026 would then refuse the next unrelated edit to either.
     */
    if (!on) {
      await db.query('UPDATE message_rule SET enabled = false WHERE template_id = $1', [id]);
    }

    const all = await templatesIn(db);
    const found = all.find((t) => t.id === id);
    if (!found) throw new MessagingError('no such template', 'not_found');
    return found;
  });
}

/* Shared so the write path returns exactly what the read path would. */
async function templatesIn(db: Parameters<Parameters<typeof withTenant>[1]>[0]) {
  const { rows } = await db.query(
    `SELECT id, code, name, category, body, cta_label, trigger_event, audience,
            approval_status, enabled
       FROM message_template WHERE channel = $1 ORDER BY name`, [CHANNEL]);
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    cat: TO_CATEGORY[r.category as string] ?? 'Utility',
    lang: 'en',
    status: r.approval_status === 'approved' ? 'Approved' as const : 'Pending review' as const,
    event: (r.trigger_event as string) ?? '',
    audience: (r.audience as string) ?? '',
    body: r.body as string,
    vars: varsOf(r.body as string),
    cta: (r.cta_label as string | null) ?? null,
    on: Boolean(r.enabled),
  }));
}

export interface WaRule {
  id: string;
  tpl: string;
  when: string;
  to: string;
  quiet: boolean;
  on: boolean;
}

/** The automation rules. Added to the contract with 0026 — see that migration. */
export async function rules(caller: Caller): Promise<WaRule[]> {
  if (caller.role !== 'admin') {
    throw new MessagingError('only an admin may manage messaging', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT r.id, t.code AS tpl, r.fires_when, r.audience, r.quiet_hours, r.enabled
         FROM message_rule r
         JOIN message_template t ON t.id = r.template_id
        WHERE t.channel = $1 ORDER BY r.code`, [CHANNEL]);
    return rows.map((r) => ({
      id: r.id as string,
      tpl: r.tpl as string,
      when: r.fires_when as string,
      to: r.audience as string,
      quiet: Boolean(r.quiet_hours),
      on: Boolean(r.enabled),
    }));
  });
}

export async function setRuleEnabled(
  caller: Caller,
  id: string,
  on: boolean,
): Promise<{ id: string; on: boolean }> {
  if (caller.role !== 'admin') {
    throw new MessagingError('only an admin may manage messaging', 'forbidden');
  }

  return withTenant(caller, async (db) => {
    const cur = await db.query(
      `SELECT r.id, t.approval_status, t.enabled AS tpl_on
         FROM message_rule r JOIN message_template t ON t.id = r.template_id
        WHERE r.id = $1 FOR UPDATE OF r`, [id]);
    const row = cur.rows[0];
    if (!row) throw new MessagingError('no such rule', 'not_found');

    /* Same reasoning as the template: refuse with the reason, not a 500. */
    if (on && row.approval_status !== 'approved') {
      throw new MessagingError(
        `the template is ${row.approval_status}, so this rule cannot run`, 'not_approved');
    }
    if (on && !row.tpl_on) {
      throw new MessagingError('the template is paused, so this rule cannot run', 'not_approved');
    }

    await db.query('UPDATE message_rule SET enabled = $2 WHERE id = $1', [id, on]);
    return { id, on };
  });
}

/* ---------------- consent ---------------- */

export interface WaConsent {
  optIn: boolean;
  on: string | null;
  via: string | null;
  marketing: boolean;
  number: string;
  verified: boolean;
}

const NO_CONSENT: WaConsent = {
  optIn: false, on: null, via: null, marketing: false, number: '', verified: false,
};

export async function consent(caller: Caller, empId: string): Promise<WaConsent> {
  if (caller.role !== 'admin' && caller.employeeId !== empId) {
    throw new MessagingError('consent is between the company and that person', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT transactional, marketing, destination, verified, captured_via,
              captured_on, withdrawn_on
         FROM notification_consent WHERE employee_id = $1 AND channel = $2`,
      [empId, CHANNEL]);
    const r = rows[0];
    if (!r) return { ...NO_CONSENT };
    /* Withdrawn is not the same as never given, but it reaches the screens the
       same way — what differs is the trail, which consent_event keeps. */
    const live = Boolean(r.transactional) && r.withdrawn_on === null;
    return {
      optIn: live,
      on: (r.captured_on as string | null) ?? null,
      via: (r.captured_via as string | null) ?? null,
      marketing: live && Boolean(r.marketing),
      number: (r.destination as string) ?? '',
      verified: Boolean(r.verified),
    };
  });
}

export interface WaConsentRow {
  employee: Employee;
  consent: WaConsent;
}

export async function consentRows(caller: Caller): Promise<WaConsentRow[]> {
  if (caller.role !== 'admin') {
    throw new MessagingError('only an admin may see the consent register', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `${EMPLOYEE_PROJECTION} WHERE e.status <> 'exited' ORDER BY e.code`);
    const consents = await db.query(
      `SELECT employee_id, transactional, marketing, destination, verified,
              captured_via, captured_on, withdrawn_on
         FROM notification_consent WHERE channel = $1`, [CHANNEL]);

    const byEmp = new Map<string, WaConsent>();
    for (const r of consents.rows) {
      const live = Boolean(r.transactional) && r.withdrawn_on === null;
      byEmp.set(r.employee_id as string, {
        optIn: live,
        on: (r.captured_on as string | null) ?? null,
        via: (r.captured_via as string | null) ?? null,
        marketing: live && Boolean(r.marketing),
        number: (r.destination as string) ?? '',
        verified: Boolean(r.verified),
      });
    }

    return rows.map((e) => ({
      employee: toEmployee(e as never, true),
      consent: byEmp.get(e.id as string) ?? { ...NO_CONSENT },
    }));
  });
}

/**
 * Turn one consent category on or off.
 *
 * Withdrawing transactional withdraws marketing with it — marketing rides on
 * the same number, and the schema refuses the other combination outright. Every
 * change appends a `consent_event`, because "we had consent" is a claim that
 * has to be provable on a date rather than asserted from the current row.
 */
export async function setConsent(
  caller: Caller,
  empId: string,
  key: 'optIn' | 'marketing',
  on: boolean,
): Promise<WaConsent> {
  if (caller.role !== 'admin' && caller.employeeId !== empId) {
    throw new MessagingError('consent is given by the person, not for them', 'forbidden');
  }
  if (key !== 'optIn' && key !== 'marketing') {
    throw new MessagingError(`unknown consent category: ${key}`, 'invalid');
  }

  return withTenant(caller, async (db) => {
    const emp = await db.query(
      "SELECT id, phone FROM employee WHERE id = $1 AND status <> 'exited'", [empId]);
    if (!emp.rows[0]) throw new MessagingError('no such employee', 'not_found');

    await db.query(
      `INSERT INTO notification_consent (employee_id, channel, destination)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, employee_id, channel) DO NOTHING`,
      [empId, CHANNEL, (emp.rows[0].phone as string | null) ?? null]);

    if (key === 'optIn') {
      await db.query(
        `UPDATE notification_consent
            SET transactional = $3,
                marketing = CASE WHEN $3 THEN marketing ELSE false END,
                captured_via = CASE WHEN $3 THEN 'self-service' ELSE captured_via END,
                captured_on = CASE WHEN $3 THEN CURRENT_DATE ELSE captured_on END,
                withdrawn_on = CASE WHEN $3 THEN NULL ELSE CURRENT_DATE END,
                updated_at = now()
          WHERE employee_id = $1 AND channel = $2`, [empId, CHANNEL, on]);
    } else {
      const cur = await db.query(
        `SELECT transactional FROM notification_consent
          WHERE employee_id = $1 AND channel = $2`, [empId, CHANNEL]);
      if (on && !cur.rows[0]?.transactional) {
        throw new MessagingError(
          'marketing rides on the same number — HR updates have to be on first', 'invalid');
      }
      await db.query(
        `UPDATE notification_consent SET marketing = $3, updated_at = now()
          WHERE employee_id = $1 AND channel = $2`, [empId, CHANNEL, on]);
    }

    await db.query(
      `INSERT INTO consent_event (employee_id, channel, category, granted, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [empId, CHANNEL, key === 'optIn' ? 'transactional' : 'marketing', on,
        caller.employeeId === empId ? 'self-service' : 'admin']);

    /* Withdrawing transactional withdraws marketing; record that separately so
       the trail shows both, not one change with a hidden consequence. */
    if (key === 'optIn' && !on) {
      await db.query(
        `INSERT INTO consent_event (employee_id, channel, category, granted, source)
         VALUES ($1, $2, 'marketing', false, 'withdrawn with transactional')`,
        [empId, CHANNEL]);
    }

    return consentIn(db, empId);
  });
}

async function consentIn(
  db: Parameters<Parameters<typeof withTenant>[1]>[0],
  empId: string,
): Promise<WaConsent> {
  const { rows } = await db.query(
    `SELECT transactional, marketing, destination, verified, captured_via,
            captured_on, withdrawn_on
       FROM notification_consent WHERE employee_id = $1 AND channel = $2`,
    [empId, CHANNEL]);
  const r = rows[0];
  if (!r) return { ...NO_CONSENT };
  const live = Boolean(r.transactional) && r.withdrawn_on === null;
  return {
    optIn: live,
    on: (r.captured_on as string | null) ?? null,
    via: (r.captured_via as string | null) ?? null,
    marketing: live && Boolean(r.marketing),
    number: (r.destination as string) ?? '',
    verified: Boolean(r.verified),
  };
}

/* ---------------- the log, and what it adds up to ---------------- */

export interface WaLogEntry {
  id: string;
  tplId: string;
  empId: string;
  to: string;
  on: string;
  at: string;
  status: string;
  cat: string;
  country: string;
  replied: string | null;
  error: string | null;
  cost: number;
}

export async function log(caller: Caller, empId?: string): Promise<WaLogEntry[]> {
  if (caller.role !== 'admin' && caller.employeeId !== empId) {
    throw new MessagingError('the send log is admin-only', 'forbidden');
  }

  const params: unknown[] = [CHANNEL];
  let where = 'l.channel = $1';
  if (empId) {
    params.push(empId);
    where += ` AND l.employee_id = $${params.length}`;
  }

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT l.id, l.template_id, l.employee_id, l.destination, l.status, l.category,
              l.reply_text, l.error, l.cost,
              to_char(l.queued_at, 'YYYY-MM-DD') AS on_date,
              to_char(l.queued_at, 'HH24:MI') AS at_time,
              COALESCE(le.country, '') AS country
         FROM notification_log l
         LEFT JOIN employee e ON e.id = l.employee_id
         LEFT JOIN legal_entity le ON le.id = e.legal_entity_id
        WHERE ${where}
        ORDER BY l.queued_at DESC, l.id DESC
        LIMIT 500`, params);

    return rows.map((r) => ({
      id: String(r.id),
      tplId: (r.template_id as string | null) ?? '',
      empId: (r.employee_id as string | null) ?? '',
      to: (r.destination as string) ?? '',
      on: r.on_date as string,
      at: r.at_time as string,
      status: TO_LOG_STATUS[r.status as string] ?? 'Queued',
      cat: TO_CATEGORY[r.category as string] ?? 'Utility',
      country: r.country as string,
      replied: (r.reply_text as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      cost: Number(r.cost ?? 0),
    }));
  });
}

export interface WaStats {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
  deliveryRate: number;
  readRate: number;
  cost: number;
  optIn: number;
  optInRate: number;
  active: number;
  workforce: number;
}

/**
 * The messaging headline.
 *
 * Delivery and read rates are computed against what was actually *sent* rather
 * than what was queued — a message still sitting in the queue has not failed to
 * deliver, and counting it as such makes a backlog look like an outage.
 */
export async function stats(caller: Caller): Promise<WaStats> {
  if (caller.role !== 'admin') {
    throw new MessagingError('only an admin may see messaging statistics', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `WITH sends AS (
         SELECT count(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS sent,
                count(*) FILTER (WHERE status IN ('delivered','read'))::int AS delivered,
                count(*) FILTER (WHERE status = 'read')::int AS read,
                count(*) FILTER (WHERE status IN ('failed','suppressed'))::int AS failed,
                count(*) FILTER (WHERE reply_text IS NOT NULL)::int AS replies,
                COALESCE(sum(cost), 0) AS cost
           FROM notification_log WHERE channel = $1
       ), people AS (
         SELECT count(*)::int AS workforce FROM employee WHERE status <> 'exited'
       ), agreed AS (
         SELECT count(*)::int AS opted
           FROM notification_consent c
           JOIN employee e ON e.id = c.employee_id AND e.status <> 'exited'
          WHERE c.channel = $1 AND c.transactional AND c.withdrawn_on IS NULL
       ), talked AS (
         SELECT count(DISTINCT employee_id)::int AS active
           FROM notification_log
          WHERE channel = $1 AND queued_at > now() - interval '30 days'
       )
       SELECT * FROM sends, people, agreed, talked`, [CHANNEL]);

    const r = rows[0]!;
    const sent = Number(r.sent);
    const workforce = Number(r.workforce);
    const opted = Number(r.opted);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

    return {
      sent,
      delivered: Number(r.delivered),
      read: Number(r.read),
      failed: Number(r.failed),
      replies: Number(r.replies),
      deliveryRate: pct(Number(r.delivered), sent),
      readRate: pct(Number(r.read), sent),
      cost: Number(r.cost),
      optIn: opted,
      optInRate: pct(opted, workforce),
      active: Number(r.active),
      workforce,
    };
  });
}
