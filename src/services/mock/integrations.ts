/**
 * Integration settings.
 *
 * **The state of a connection is derived, never stored.** `stateOf` below
 * reads the build configuration the app is actually running with — is there a
 * Supabase project, is there an API, which sign-in providers are listed — and
 * reports what that implies. Nothing in this module can set a connection to
 * "Connected", because a boolean somebody ticked is not evidence that anything
 * is connected, and a green tick nobody can falsify is worse than no screen.
 *
 * Webhooks and API keys are the exception, and only because those are records
 * this product genuinely owns: a URL we post to, a credential we issued. Those
 * are created, revoked and kept here like anything else.
 *
 * **A key is shown once and never stored.** `create` returns the secret; what
 * is kept is the last four characters. A table of live credentials readable by
 * anybody who can open this page is the usual version of this feature, and it
 * is a breach with a date on it.
 */

import { sortBy } from '../../lib/collections';
import { TODAY, addDays, ymd } from '../../lib/dates';
import { uid } from '../../lib/rng';
import { EMAP } from '../../data/employees';
import {
  API_KEYS, API_SCOPES, INTEGRATIONS, WEBHOOKS, WEBHOOK_EVENTS,
  isUnhealthy, keyExpiringSoon,
} from '../../data/integrations';
import type {
  ApiKey, Integration, IntegrationState, Webhook, WebhookEvent,
} from '../../data/integrations';
import { recordAudit } from '../../data/audit';
import type {
  ApiKeyDraft, Caller, IntegrationRow, IntegrationService, NewApiKey, WebhookDraft,
} from '../contracts';
import { ok } from './util';

const refuse = (why: string) => Promise.reject(new Error(why));

const adminOnly = (c: Caller) => {
  if (c.role !== 'admin') {
    throw new Error('Only an administrator can change how this tenant connects to anything');
  }
};

/**
 * What the build says.
 *
 * Read through `import.meta.env`, which is the same thing the app itself
 * branches on at startup — so this screen cannot claim a connection the app is
 * not actually using.
 */
const env = (k: string): string => {
  try {
    return String((import.meta.env as unknown as Record<string, unknown>)[k] ?? '');
  } catch {
    return '';
  }
};

/**
 * The evidence a connection can be judged on.
 *
 * Taken as a parameter rather than read inside `stateOf`, so the derivation
 * can be tested against fixtures — no credentials, blank credentials, real
 * ones — instead of against whatever environment the test happens to run in.
 * A check that reads the same environment the code reads restates the
 * implementation and cannot fail.
 */
export interface ConnectionEvidence {
  supabaseUrl: string;
  apiUrl: string;
  ssoProviders: string[];
  liveWebhooks: number;
}

/** A value that is present, is a string, and is not just whitespace. */
const present = (v: string) => typeof v === 'string' && v.trim().length > 0;

export const readEvidence = (): ConnectionEvidence => ({
  supabaseUrl: env('VITE_SUPABASE_URL'),
  apiUrl: env('VITE_API_URL'),
  ssoProviders: env('VITE_SSO_PROVIDERS').split(',').map((s) => s.trim()).filter(Boolean),
  liveWebhooks: WEBHOOKS.filter((w) => w.active).length,
});

/**
 * The derivation.
 *
 * Every branch reads `ev`. There is no branch that returns Connected without
 * consulting it, and the check asserts exactly that by running every
 * integration under empty evidence — which is what would catch somebody
 * adding `case 'slack': return { state: 'Connected' }`.
 */
export function stateOf(
  i: Integration,
  ev: ConnectionEvidence,
): { state: IntegrationState; detail: string } {
  switch (i.id) {
    case 'postgres':
    case 'audit':
      return { state: 'Built in', detail: 'Always on.' };

    case 'supabase-auth':
      return present(ev.supabaseUrl)
        ? { state: 'Connected', detail: 'A Supabase project is configured; sign-in is required.' }
        : {
          state: 'Available',
          detail: 'No project configured — this build runs in demo mode with no sign-in.',
        };

    case 'sso-providers':
      return ev.ssoProviders.length
        ? { state: 'Connected', detail: `Offering ${ev.ssoProviders.join(' and ')}.` }
        : { state: 'Available', detail: 'No providers listed; email sign-in only.' };

    case 'storage':
      return present(ev.supabaseUrl)
        ? { state: 'Connected', detail: 'Follows the configured Supabase project.' }
        : { state: 'Available', detail: 'Needs a Supabase project first.' };

    case 'api':
      return present(ev.apiUrl)
        ? { state: 'Connected', detail: `Reading from ${ev.apiUrl}.` }
        : {
          state: 'Available',
          detail: 'No API configured — every screen is reading the built-in demo dataset.',
        };

    case 'webhooks':
      return ev.liveWebhooks > 0
        ? { state: 'Connected', detail: `${ev.liveWebhooks} endpoint(s) receiving.` }
        : { state: 'Available', detail: 'No endpoints are receiving.' };

    /*
     * Everything else. There is no credential, no token and no app installed,
     * so there is nothing to derive a "connected" from — and inventing one is
     * the failure this whole module is shaped around.
     */
    default:
      return { state: 'Available', detail: i.basis };
  }
}

const rowOf = (i: Integration, ev: ConnectionEvidence): IntegrationRow =>
  ({ integration: i, ...stateOf(i, ev) });

const webhookRow = (w: Webhook) => ({
  webhook: w,
  createdBy: EMAP[w.createdById]?.name ?? w.createdById,
  unhealthy: isUnhealthy(w),
  failureRate: w.deliveries ? Math.round((w.failures / w.deliveries) * 1000) / 10 : 0,
});

const keyRow = (k: ApiKey) => ({
  key: k,
  createdBy: EMAP[k.createdById]?.name ?? k.createdById,
  revoked: k.revokedOn !== null,
  expiringSoon: keyExpiringSoon(k),
  expired: !k.revokedOn && k.expiresOn !== null && k.expiresOn < ymd(TODAY),
});

const validUrl = (u: string) => {
  try {
    const parsed = new URL(u);
    /*
     * https only. A webhook carries employee data to somebody else's server,
     * and over http it carries it to everybody between here and there.
     */
    return parsed.protocol === 'https:';
  } catch { return false; }
};

export const integrationService: IntegrationService = {
  list() {
    const ev = readEvidence();
    return ok(INTEGRATIONS.map((i) => rowOf(i, ev)));
  },

  webhooks(c) {
    if (c.role !== 'admin') return refuse('Only an administrator can see the endpoints');
    return ok(sortBy(WEBHOOKS, (w) => w.n).map(webhookRow));
  },

  createWebhook(c, d: WebhookDraft) {
    try { adminOnly(c); } catch (e) { return refuse((e as Error).message); }
    if (!d.n?.trim()) return refuse('Give the endpoint a name');
    if (!validUrl(d.url ?? '')) return refuse('The URL must be a valid https address');
    if (!d.events?.length) return refuse('Choose at least one event to send');
    const unknown = d.events.filter((e) => !WEBHOOK_EVENTS.includes(e as WebhookEvent));
    if (unknown.length) return refuse(`Not an event: ${unknown[0]}`);

    const w: Webhook = {
      id: uid('WH'),
      n: d.n.trim(),
      url: d.url.trim(),
      events: d.events as WebhookEvent[],
      active: d.active ?? true,
      createdOn: ymd(TODAY),
      createdById: c.meId,
      lastFiredOn: null,
      lastStatus: null,
      deliveries: 0,
      failures: 0,
    };
    WEBHOOKS.push(w);
    recordAudit.write(c, 'integration.webhook_created', 'integration', w.id, `${w.n} · ${w.url}`);
    return ok(w);
  },

  setWebhookActive(c, id, active) {
    try { adminOnly(c); } catch (e) { return refuse((e as Error).message); }
    const w = WEBHOOKS.find((x) => x.id === id);
    if (!w) return refuse('No such endpoint');
    w.active = active;
    recordAudit.write(c, active ? 'integration.webhook_resumed' : 'integration.webhook_paused',
      'integration', w.id, w.n);
    return ok(w);
  },

  removeWebhook(c, id) {
    try { adminOnly(c); } catch (e) { return refuse((e as Error).message); }
    const i = WEBHOOKS.findIndex((x) => x.id === id);
    if (i < 0) return refuse('No such endpoint');
    const [w] = WEBHOOKS.splice(i, 1);
    recordAudit.write(c, 'integration.webhook_removed', 'integration', w!.id, w!.n);
    return ok(w!);
  },

  apiKeys(c) {
    if (c.role !== 'admin') return refuse('Only an administrator can see the keys');
    return ok(sortBy(API_KEYS, (k) => k.n).map(keyRow));
  },

  scopes() {
    return ok(API_SCOPES);
  },

  /**
   * Issue a key.
   *
   * The secret is returned once, here, and not stored. What is kept is the
   * name, the scopes and the last four characters — enough to recognise it in
   * a list and nothing that could be used.
   */
  createApiKey(c, d: ApiKeyDraft) {
    try { adminOnly(c); } catch (e) { return refuse((e as Error).message); }
    if (!d.n?.trim()) return refuse('Give the key a name');
    if (!d.scopes?.length) return refuse('A key with no scopes can do nothing — choose at least one');
    const unknown = d.scopes.filter((s) => !API_SCOPES.includes(s));
    if (unknown.length) return refuse(`Not a scope: ${unknown[0]}`);

    const secret = `phk_${Array.from({ length: 8 }, () => Math.random().toString(36).slice(2, 6)).join('')}`;
    const key: ApiKey = {
      id: uid('KEY'),
      n: d.n.trim(),
      tail: secret.slice(-4).toUpperCase(),
      scopes: d.scopes,
      createdOn: ymd(TODAY),
      createdById: c.meId,
      lastUsedOn: null,
      expiresOn: d.expiresInDays ? ymd(addDays(TODAY, d.expiresInDays)) : null,
      revokedOn: null,
    };
    API_KEYS.push(key);
    recordAudit.write(c, 'integration.key_issued', 'integration', key.id,
      `${key.n} · ${key.scopes.join(', ')}`);
    const out: NewApiKey = { key, secret };
    return ok(out);
  },

  /**
   * Revoke, never delete.
   *
   * A key that was used to pull the employee directory in March is part of the
   * record of who had access. Deleting the row removes the only evidence that
   * it ever existed.
   */
  revokeApiKey(c, id) {
    try { adminOnly(c); } catch (e) { return refuse((e as Error).message); }
    const k = API_KEYS.find((x) => x.id === id);
    if (!k) return refuse('No such key');
    if (k.revokedOn) return ok(k);
    k.revokedOn = ymd(TODAY);
    recordAudit.write(c, 'integration.key_revoked', 'integration', k.id, k.n);
    return ok(k);
  },

  stats() {
    const ev = readEvidence();
    const rows = INTEGRATIONS.map((i) => rowOf(i, ev));
    const live = WEBHOOKS.filter((w) => w.active);
    return ok({
      connected: rows.filter((r) => r.state === 'Connected' || r.state === 'Built in').length,
      available: rows.filter((r) => r.state === 'Available').length,
      webhooks: live.length,
      unhealthy: live.filter(isUnhealthy).length,
      keys: API_KEYS.filter((k) => !k.revokedOn).length,
      expiringSoon: API_KEYS.filter((k) => keyExpiringSoon(k)).length,
      /* Whether this build is reading real data at all. */
      demoMode: !present(ev.apiUrl),
    });
  },
};
