/**
 * Integration settings.
 *
 * **Connection state is derived from configuration, never stored.** There is
 * no `setState` here and no column to write one to. The usual version of this
 * feature is a grid of vendor logos with green ticks, and almost every tick
 * would be a claim nobody could check — so each state is read from something
 * that actually exists (an environment variable, a live endpoint) and is
 * reported with the reason beside it.
 *
 * Webhooks and API keys are different: those are records this product genuinely
 * owns, so they persist.
 *
 * **A key is returned once and never stored.** What is kept is its last four
 * characters and a hash. 0037 constrains that column to exactly four, so it
 * cannot quietly become the place somebody stores the whole thing.
 */

import { createHash, randomBytes } from 'node:crypto';
import { withTenant, withTenantReadOnly } from '../../tenancy/context.ts';
import type { Caller } from '../../tenancy/context.ts';

export class IntegrationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
  }
}

export type IntegrationState = 'Connected' | 'Available' | 'Built in';

export interface Integration {
  id: string; n: string; vendor: string; kind: string; desc: string;
  basis: string; setting: string | null; toConnect: string;
}

export interface IntegrationRow {
  integration: Integration; state: IntegrationState; detail: string;
}

export const WEBHOOK_EVENTS = [
  'employee.joined', 'employee.exited', 'leave.approved',
  'timesheet.submitted', 'asset.issued', 'event.published',
];

export const API_SCOPES = [
  'employees:read', 'leave:read', 'leave:write', 'timesheet:read',
  'attendance:read', 'assets:read', 'events:read', 'events:write',
];

/*
 * The catalogue. Same list the client carries, because it describes the
 * product rather than this tenant — what differs per tenant is the state, and
 * that is worked out below.
 */
const INTEGRATIONS: Integration[] = [
  {
    id: 'supabase-auth', n: 'Single sign-on', vendor: 'Supabase Auth', kind: 'Identity',
    desc: 'Who signs in, and how.',
    basis: 'Read from the server environment.', setting: 'SUPABASE_JWKS_URL',
    toConnect: 'Configure the Supabase project and point the API at its JWKS.',
  },
  {
    id: 'postgres', n: 'PostgreSQL with row-level security', vendor: 'Supabase', kind: 'Data',
    desc: 'Every table carries a tenant and every read is fenced by policy.',
    basis: 'Part of the product. Not optional.', setting: null, toConnect: '',
  },
  {
    id: 'audit', n: 'Audit trail', vendor: '360 People Hub', kind: 'Data',
    desc: 'One trail across every module.',
    basis: 'Part of the product. Every module writes to it.', setting: null, toConnect: '',
  },
  {
    id: 'webhooks', n: 'Outbound webhooks', vendor: '360 People Hub', kind: 'Communication',
    desc: 'Post to a URL of yours when something happens here.',
    basis: 'Configured below.', setting: null, toConnect: '',
  },
  {
    id: 'email', n: 'Transactional email', vendor: 'Not configured', kind: 'Communication',
    desc: 'Invitations, approvals and reminders by email.',
    basis: 'No mail provider is configured. Nothing is being sent.',
    setting: 'SMTP_URL',
    toConnect: 'Configure an SMTP relay or a provider, then set the sender domain.',
  },
  {
    id: 'slack', n: 'Slack notifications', vendor: 'Slack', kind: 'Communication',
    desc: 'Approvals and announcements into a channel.',
    basis: 'No Slack app is installed against this tenant.',
    setting: null,
    toConnect: 'Create a Slack app, install it and store the bot token.',
  },
  {
    id: 'calendar', n: 'Calendar sync', vendor: 'Google Calendar · Outlook', kind: 'Calendar',
    desc: 'Leave and company events on people’s own calendars.',
    basis: 'No calendar credentials are held for this tenant.',
    setting: null,
    toConnect: 'Grant calendar scope and store a per-tenant refresh token.',
  },
  {
    id: 'payroll-out', n: 'Payroll bureau feed', vendor: 'Not configured', kind: 'Finance',
    desc: 'The monthly file a payroll bureau takes.',
    basis: 'No bureau is configured. Payroll output is exported by hand.',
    setting: null,
    toConnect: 'Agree a file format with the bureau and configure delivery.',
  },
  {
    id: 'storage', n: 'Document storage', vendor: 'Supabase Storage', kind: 'Storage',
    desc: 'Where letters, payslips and uploaded documents are kept.',
    basis: 'Follows the Supabase project.', setting: 'SUPABASE_URL',
    toConnect: 'Set the Supabase project, then create the documents bucket.',
  },
];

const envSet = (k: string) => Boolean(process.env[k]);

/**
 * The derivation.
 *
 * Every branch reads something real. There is no branch that returns
 * 'Connected' without evidence, and adding one is the thing the check watches
 * for.
 */
async function stateOf(
  i: Integration,
  liveHooks: number,
): Promise<{ state: IntegrationState; detail: string }> {
  switch (i.id) {
    case 'postgres':
    case 'audit':
      return { state: 'Built in', detail: 'Always on.' };
    case 'supabase-auth':
      return envSet('SUPABASE_JWKS_URL') || envSet('SUPABASE_URL')
        ? { state: 'Connected', detail: 'Tokens are verified against the configured project.' }
        : { state: 'Available', detail: 'No identity provider configured on the API.' };
    case 'storage':
      return envSet('SUPABASE_URL')
        ? { state: 'Connected', detail: 'Follows the configured Supabase project.' }
        : { state: 'Available', detail: 'Needs a Supabase project first.' };
    case 'email':
      return envSet('SMTP_URL')
        ? { state: 'Connected', detail: 'A mail relay is configured.' }
        : { state: 'Available', detail: i.basis };
    case 'webhooks':
      return liveHooks
        ? { state: 'Connected', detail: `${liveHooks} endpoint(s) receiving.` }
        : { state: 'Available', detail: 'No endpoints are receiving.' };
    default:
      return { state: 'Available', detail: i.basis };
  }
}

export async function listIntegrations(caller: Caller): Promise<IntegrationRow[]> {
  const live = await withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_endpoint WHERE active');
    return Number(rows[0]?.n ?? 0);
  });
  return Promise.all(INTEGRATIONS.map(async (i) => ({
    integration: i,
    ...(await stateOf(i, live)),
  })));
}

const adminOnly = (caller: Caller) => {
  if (caller.role !== 'admin') {
    throw new IntegrationError(
      'Only an administrator can change how this tenant connects to anything', 'forbidden');
  }
};

export interface Webhook {
  id: string; n: string; url: string; events: string[]; active: boolean;
  createdOn: string; createdById: string | null;
  lastFiredOn: string | null; lastStatus: number | null;
  deliveries: number; failures: number;
}

interface HookRow {
  id: string; name: string; url: string; events: string[]; active: boolean;
  created_on: string; created_by_id: string | null; created_by: string | null;
  last_fired_on: string | null; last_status: number | null;
  deliveries: number; failures: number;
}

const toHook = (r: HookRow) => ({
  webhook: {
    id: r.id, n: r.name, url: r.url, events: r.events ?? [], active: r.active,
    createdOn: r.created_on, createdById: r.created_by_id,
    lastFiredOn: r.last_fired_on, lastStatus: r.last_status,
    deliveries: r.deliveries, failures: r.failures,
  },
  createdBy: r.created_by ?? '—',
  /* One call in twenty failing is worth looking at. */
  unhealthy: r.active && r.deliveries > 0 && r.failures / r.deliveries > 0.05,
  failureRate: r.deliveries ? Math.round((r.failures / r.deliveries) * 1000) / 10 : 0,
});

export async function listWebhooks(caller: Caller) {
  adminOnly(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<HookRow>(
      `SELECT w.id, w.name, w.url, w.events, w.active, w.created_on::text,
              w.created_by_id, e.full_name AS created_by,
              w.last_fired_on::text, w.last_status, w.deliveries, w.failures
         FROM webhook_endpoint w
         LEFT JOIN employee e ON e.id = w.created_by_id
        ORDER BY w.name`);
    return rows.map(toHook);
  });
}

export interface WebhookDraft {
  n: string; url: string; events: string[]; active?: boolean | undefined;
}

export async function createWebhook(caller: Caller, d: WebhookDraft): Promise<Webhook> {
  adminOnly(caller);
  if (!d.n?.trim()) throw new IntegrationError('Give the endpoint a name', 'invalid');
  let parsed: URL;
  try { parsed = new URL(d.url ?? ''); }
  catch { throw new IntegrationError('The URL must be a valid https address', 'invalid'); }
  /*
   * https only. A webhook carries employee data across the internet; over http
   * it carries it to everybody in between. 0037 enforces it at the schema
   * level too — this is here so the message says why.
   */
  if (parsed.protocol !== 'https:') {
    throw new IntegrationError('The URL must be a valid https address', 'invalid');
  }
  if (!d.events?.length) {
    throw new IntegrationError('Choose at least one event to send', 'invalid');
  }
  const unknown = d.events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (unknown.length) throw new IntegrationError(`Not an event: ${unknown[0]}`, 'invalid');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<HookRow>(
      `INSERT INTO webhook_endpoint (name, url, events, active, created_by_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, url, events, active, created_on::text, created_by_id,
                 NULL::text AS created_by, last_fired_on::text, last_status,
                 deliveries, failures`,
      [d.n.trim(), d.url.trim(), d.events, d.active ?? true, caller.employeeId]);
    return toHook(rows[0]!).webhook;
  });
}

export async function setWebhookActive(
  caller: Caller,
  id: string,
  active: boolean,
): Promise<Webhook> {
  adminOnly(caller);
  return withTenant(caller, async (db) => {
    const { rows } = await db.query<HookRow>(
      `UPDATE webhook_endpoint SET active = $1 WHERE id = $2
       RETURNING id, name, url, events, active, created_on::text, created_by_id,
                 NULL::text AS created_by, last_fired_on::text, last_status,
                 deliveries, failures`,
      [active, id]);
    if (!rows[0]) throw new IntegrationError('No such endpoint', 'not_found');
    return toHook(rows[0]).webhook;
  });
}

export async function removeWebhook(caller: Caller, id: string): Promise<Webhook> {
  adminOnly(caller);
  return withTenant(caller, async (db) => {
    const { rows } = await db.query<HookRow>(
      `DELETE FROM webhook_endpoint WHERE id = $1
       RETURNING id, name, url, events, active, created_on::text, created_by_id,
                 NULL::text AS created_by, last_fired_on::text, last_status,
                 deliveries, failures`,
      [id]);
    if (!rows[0]) throw new IntegrationError('No such endpoint', 'not_found');
    return toHook(rows[0]).webhook;
  });
}

export interface ApiKey {
  id: string; n: string; tail: string; scopes: string[];
  createdOn: string; createdById: string | null;
  lastUsedOn: string | null; expiresOn: string | null; revokedOn: string | null;
}

interface KeyRow {
  id: string; name: string; tail: string; scopes: string[];
  created_on: string; created_by_id: string | null; created_by: string | null;
  last_used_on: string | null; expires_on: string | null; revoked_on: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) =>
  new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const toKey = (r: KeyRow) => ({
  key: {
    id: r.id, n: r.name, tail: r.tail, scopes: r.scopes ?? [],
    createdOn: r.created_on, createdById: r.created_by_id,
    lastUsedOn: r.last_used_on, expiresOn: r.expires_on, revokedOn: r.revoked_on,
  },
  createdBy: r.created_by ?? '—',
  revoked: r.revoked_on !== null,
  expiringSoon: !r.revoked_on && r.expires_on !== null && r.expires_on <= inDays(30),
  expired: !r.revoked_on && r.expires_on !== null && r.expires_on < today(),
});

const KEY_PROJECTION = `
  SELECT k.id, k.name, k.tail, k.scopes, k.created_on::text, k.created_by_id,
         e.full_name AS created_by, k.last_used_on::text, k.expires_on::text,
         k.revoked_on::text
    FROM api_key k
    LEFT JOIN employee e ON e.id = k.created_by_id`;

export async function listApiKeys(caller: Caller) {
  adminOnly(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows } = await db.query<KeyRow>(`${KEY_PROJECTION} ORDER BY k.name`);
    return rows.map(toKey);
  });
}

export async function apiScopes(): Promise<string[]> {
  return API_SCOPES;
}

export interface ApiKeyDraft {
  n: string; scopes: string[]; expiresInDays?: number | undefined;
}

export async function createApiKey(
  caller: Caller,
  d: ApiKeyDraft,
): Promise<{ key: ApiKey; secret: string }> {
  adminOnly(caller);
  if (!d.n?.trim()) throw new IntegrationError('Give the key a name', 'invalid');
  if (!d.scopes?.length) {
    throw new IntegrationError('A key with no scopes can do nothing — choose at least one', 'invalid');
  }
  const unknown = d.scopes.filter((s) => !API_SCOPES.includes(s));
  if (unknown.length) throw new IntegrationError(`Not a scope: ${unknown[0]}`, 'invalid');

  /*
   * A real random secret, and only its hash and last four characters are kept.
   * Node's crypto, not Math.random: this is a credential.
   */
  const secret = `phk_${randomBytes(24).toString('base64url')}`;
  const hash = createHash('sha256').update(secret).digest('hex');

  return withTenant(caller, async (db) => {
    const { rows } = await db.query<KeyRow>(
      `INSERT INTO api_key (name, tail, secret_hash, scopes, created_by_id, expires_on)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, tail, scopes, created_on::text, created_by_id,
                 NULL::text AS created_by, last_used_on::text, expires_on::text,
                 revoked_on::text`,
      [d.n.trim(), secret.slice(-4).toUpperCase(), hash, d.scopes, caller.employeeId,
        d.expiresInDays ? inDays(d.expiresInDays) : null]);
    return { key: toKey(rows[0]!).key, secret };
  });
}

/**
 * Revoke, never delete.
 *
 * The key that pulled the directory in March is part of the record of who had
 * access; removing the row removes the only evidence it existed.
 */
export async function revokeApiKey(caller: Caller, id: string): Promise<ApiKey> {
  adminOnly(caller);
  return withTenant(caller, async (db) => {
    const { rows } = await db.query<KeyRow>(
      `UPDATE api_key SET revoked_on = COALESCE(revoked_on, CURRENT_DATE)
        WHERE id = $1
       RETURNING id, name, tail, scopes, created_on::text, created_by_id,
                 NULL::text AS created_by, last_used_on::text, expires_on::text,
                 revoked_on::text`,
      [id]);
    if (!rows[0]) throw new IntegrationError('No such key', 'not_found');
    return toKey(rows[0]).key;
  });
}

export async function integrationStats(caller: Caller) {
  const rows = await listIntegrations(caller);
  return withTenantReadOnly(caller, async (db) => {
    const { rows: counts } = await db.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM webhook_endpoint WHERE active)::text AS hooks,
              (SELECT count(*) FROM webhook_endpoint
                WHERE active AND deliveries > 0
                  AND failures::numeric / deliveries > 0.05)::text AS unhealthy,
              (SELECT count(*) FROM api_key WHERE revoked_on IS NULL)::text AS keys,
              (SELECT count(*) FROM api_key
                WHERE revoked_on IS NULL AND expires_on IS NOT NULL
                  AND expires_on <= CURRENT_DATE + 30)::text AS expiring`);
    const c = counts[0] ?? {};
    return {
      connected: rows.filter((r) => r.state === 'Connected' || r.state === 'Built in').length,
      available: rows.filter((r) => r.state === 'Available').length,
      webhooks: Number(c.hooks ?? 0),
      unhealthy: Number(c.unhealthy ?? 0),
      keys: Number(c.keys ?? 0),
      expiringSoon: Number(c.expiring ?? 0),
      /* The API is answering, so this is not demo mode by definition. */
      demoMode: false,
    };
  });
}
