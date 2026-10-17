/**
 * The security screens: what happened, what is controlled, what is kept.
 *
 * Three of the four reads here have had a table behind them since 0009 and a
 * mock in front of them ever since. `audit_log` in particular has been filling
 * up for real — eight modules write to it — while the screen showed invented
 * rows, which is the worst possible arrangement for an audit trail: the one
 * place somebody looks to find out what actually happened was the one place
 * guaranteed not to say.
 *
 * **`posture` is deliberately not here.** It reports whether each person's
 * device has a second factor, is managed, is encrypted and is patched. Nothing
 * in this system knows any of that — there is no MDM, no identity provider
 * feed, no agent. The mock invents it, and inventing a number for "94% of
 * devices encrypted" on a security page is not a placeholder, it is a false
 * assurance somebody will repeat to a client. It stays on the mock, visibly
 * fake, until something real feeds it.
 */

import { withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class SecurityError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

/**
 * The screens speak high/medium/low; the column stores
 * info/notice/warning/critical.
 *
 * Four levels into three, because the screen's filter is a triage control and
 * nobody triages in four bands. `critical` and `warning` both land on high —
 * collapsing them the other way would hide the critical ones among a much
 * larger pile of warnings.
 */
const TO_SEV: Record<string, 'high' | 'medium' | 'low'> = {
  critical: 'high', warning: 'high', notice: 'medium', info: 'low',
};
const FROM_SEV: Record<string, string[]> = {
  high: ['critical', 'warning'], medium: ['notice'], low: ['info'],
};

export interface AuditEntry {
  id: string;
  cat: string;
  action: string;
  sev: 'high' | 'medium' | 'low';
  byId: string | null;
  by: string;
  on: string;
  at: string;
  ip: string;
  device: string;
  country: string;
}

/**
 * `action` is stored as a slug — `fence_moved`, `role_changed`. Rendered here
 * rather than in the screen so every reader of this API gets the same words.
 */
const readable = (slug: string) =>
  slug.replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());

/** A user agent is not a device name; this is the most it can honestly say. */
function deviceOf(ua: string | null): string {
  if (!ua) return 'Unknown';
  if (/iPhone|iPad/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Other';
}

export async function audit(
  caller: Caller,
  cat?: string,
  sev?: string,
  limit = 200,
): Promise<AuditEntry[]> {
  if (caller.role !== 'admin') {
    throw new SecurityError('only an admin may read the audit trail', 'forbidden');
  }

  const params: unknown[] = [];
  const where: string[] = [];

  if (cat) {
    params.push(cat);
    where.push(`a.category = $${params.length}`);
  }
  if (sev) {
    const stored = FROM_SEV[sev];
    if (!stored) throw new SecurityError(`unknown severity: ${sev}`, 'invalid');
    params.push(stored);
    where.push(`a.severity = ANY($${params.length}::text[])`);
  }
  params.push(Math.min(Math.max(1, Math.trunc(limit) || 200), 1000));

  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT a.id, a.category, a.action, a.severity, a.actor_employee_id, a.actor_label,
              a.subject_table, a.subject_id, a.ip, a.user_agent, a.country,
              to_char(a.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS at,
              to_char(a.occurred_at, 'YYYY-MM-DD') AS on_date
         FROM audit_log a
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.occurred_at DESC, a.id DESC
        LIMIT $${params.length}`, params);

    return rows.map((r) => ({
      id: String(r.id),
      cat: r.category as string,
      action: readable(r.action as string),
      sev: TO_SEV[r.severity as string] ?? 'low',
      byId: (r.actor_employee_id as string | null) ?? null,
      /* The label as it was written, so a later rename does not rewrite history. */
      by: r.actor_label as string,
      on: r.on_date as string,
      at: r.at as string,
      ip: (r.ip as string | null) ?? '—',
      device: deviceOf(r.user_agent as string | null),
      country: (r.country as string | null) ?? '',
    }));
  });
}

/** The categories actually present, so the filter offers nothing empty. */
export async function auditCategories(caller: Caller): Promise<string[]> {
  if (caller.role !== 'admin') {
    throw new SecurityError('only an admin may read the audit trail', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      'SELECT DISTINCT category FROM audit_log ORDER BY category');
    return rows.map((r) => r.category as string);
  });
}

export interface Control {
  k: string;
  d: string;
  s: 'Met' | 'Partial';
}

/**
 * The control framework, as recorded rather than as claimed.
 *
 * `implemented` is Met and everything else is Partial — including
 * `not_started`, which the screen has no third state for. That is a deliberate
 * flattening in the pessimistic direction: a control nobody has begun showing
 * as anything other than "not met" would be the wrong way round.
 */
export async function controls(caller: Caller): Promise<Control[]> {
  if (caller.role !== 'admin') {
    throw new SecurityError('only an admin may see the control framework', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT name, COALESCE(note, '') AS note, status, framework
         FROM security_control ORDER BY framework NULLS LAST, code`);
    return rows.map((r) => ({
      k: r.name as string,
      d: (r.note as string) || (r.framework ? `${r.framework} control` : ''),
      s: r.status === 'implemented' ? 'Met' as const : 'Partial' as const,
    }));
  });
}

export interface RetentionRow {
  k: string;
  d: string;
  law: string;
  keep: string;
  basis: string;
}

const MONTHS_AS_WORDS = (m: number): string => {
  if (m % 12 === 0) return `${m / 12} year${m === 12 ? '' : 's'}`;
  return `${m} months`;
};

const DISPOSITION: Record<string, string> = {
  purge: 'Deleted',
  anonymise: 'Identifiers cleared, record kept',
  archive: 'Moved to cold storage',
  retain_indefinitely: 'Kept indefinitely',
};

/**
 * The retention register.
 *
 * Reads the same rows `scripts/retention.mjs` acts on, which is the point: a
 * register that describes one policy while a job enforces another is worse
 * than no register. `last_run_at` comes through so the screen can say when the
 * rule was last applied rather than only what it says.
 */
export async function retention(caller: Caller): Promise<RetentionRow[]> {
  if (caller.role !== 'admin') {
    throw new SecurityError('only an admin may see the retention register', 'forbidden');
  }
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query(
      `SELECT record_kind, retain_months, disposition, COALESCE(legal_basis, '') AS legal_basis,
              to_char(last_run_at, 'YYYY-MM-DD') AS last_run
         FROM retention_policy ORDER BY record_kind`);
    return rows.map((r) => ({
      k: readable(r.record_kind as string),
      d: DISPOSITION[r.disposition as string] ?? (r.disposition as string),
      law: (r.legal_basis as string).split('—')[0]!.trim() || '—',
      keep: MONTHS_AS_WORDS(Number(r.retain_months)),
      basis: r.last_run
        ? `Last applied ${r.last_run}`
        : 'Never applied — run npm run retention in server/',
    }));
  });
}
