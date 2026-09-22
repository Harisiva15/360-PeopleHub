/**
 * Nothing on the integrations page claims a connection that does not exist.
 *
 * The failure this module is shaped to avoid is a green tick nobody can
 * falsify. So the assertions here are unusual: rather than testing that the
 * code works, most of them test that the code *cannot lie* — that no method
 * sets a connection state, that a state only reads configuration, and that a
 * credential is never kept.
 */

import { getServices } from '../src/services';
import {
  API_KEYS, API_SCOPES, INTEGRATIONS, WEBHOOKS, WEBHOOK_EVENTS,
} from '../src/data/integrations';
import { DEMO_EMP, DEMO_MGR, HRHEAD } from '../src/data/employees';
import { recordAudit } from '../src/data/audit';
import { stateOf } from '../src/services/mock/integrations';
import type { ConnectionEvidence } from '../src/services/mock/integrations';
import { TODAY, ymd } from '../src/lib/dates';
import type { Caller } from '../src/services';

const s = getServices();
let failed = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const refused = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'accepted', 'refused'); }
  catch { check(label, 'refused', 'refused'); }
};
const allowed = async (label: string, run: () => Promise<unknown>) => {
  try { await run(); check(label, 'allowed', 'allowed'); }
  catch (e) { check(label, `refused: ${(e as Error).message}`, 'allowed'); }
};

const ADMIN: Caller = { role: 'admin', meId: HRHEAD.id };
const MANAGER: Caller = { role: 'manager', meId: DEMO_MGR.id };
const EMPLOYEE: Caller = { role: 'employee', meId: DEMO_EMP.id };

const seededHooks = new Set(WEBHOOKS.map((w) => w.id));
const seededKeys = new Set(API_KEYS.map((k) => k.id));

(async () => {
  console.log(`\n${INTEGRATIONS.length} connections, ${WEBHOOKS.length} endpoints, ${API_KEYS.length} keys\n`);

  /* ---- the state cannot be set ---- */

  /*
   * The load-bearing assertion. If a method ever appears that writes a
   * connection state, every tick on the page becomes a claim somebody typed.
   */
  const methods = Object.keys(s.integrations);
  check('no method sets a connection state',
    methods.filter((m) => /connect|disconnect|setState|enable/i.test(m)), []);

  /*
   * And the stored record carries no state either — it describes what the
   * thing is, not whether it is on. The state comes out of `list`.
   */
  const stored = Object.keys(INTEGRATIONS[0]!).sort();
  check('a stored integration has no state field', stored, [
    'basis', 'desc', 'id', 'kind', 'n', 'setting', 'toConnect', 'vendor',
  ]);

  const rows = await s.integrations.list(ADMIN);
  check('every connection is listed', rows.length, INTEGRATIONS.length);
  check('every one comes back with a state',
    rows.filter((r) => !r.state).length, 0);
  /*
   * And with a reason. A state on its own is the unfalsifiable claim; the
   * reason is what lets somebody contradict it.
   */
  check('and with a reason beside it',
    rows.filter((r) => !r.detail?.trim()).length, 0);
  check('every state is one of the three',
    rows.filter((r) => !['Connected', 'Available', 'Built in'].includes(r.state)).length, 0);

  /* ---- the derivation, against fixtures rather than the ambient environment ---- */

  /*
   * This is the part that matters, and the first version of it was wrong.
   *
   * It read the same environment variables the service reads and asserted they
   * agreed — which restates the implementation and cannot fail. The invariant
   * worth testing is behavioural: *no provider may report Connected without
   * evidence*. So `stateOf` takes its evidence as an argument and is driven
   * here with fixtures.
   */
  const NONE: ConnectionEvidence = {
    supabaseUrl: '', apiUrl: '', ssoProviders: [], liveWebhooks: 0,
  };
  /* Present but meaningless — the case a truthiness check would wave through. */
  const BLANK: ConnectionEvidence = {
    supabaseUrl: '   ', apiUrl: '\t', ssoProviders: [], liveWebhooks: 0,
  };
  const FULL: ConnectionEvidence = {
    supabaseUrl: 'https://project.supabase.co',
    apiUrl: 'https://api.example.com',
    ssoProviders: ['google', 'azure'],
    liveWebhooks: 2,
  };

  /*
   * The assertion with teeth. Run every integration with nothing behind it:
   * anything that still says Connected is claiming something it cannot show,
   * and a hard-coded `return { state: 'Connected' }` fails right here.
   */
  const underNone = INTEGRATIONS.map((i) => ({ id: i.id, ...stateOf(i, NONE) }));
  check('with no evidence at all, nothing reports Connected',
    underNone.filter((r) => r.state === 'Connected').map((r) => r.id), []);

  const underBlank = INTEGRATIONS.map((i) => ({ id: i.id, ...stateOf(i, BLANK) }));
  check('whitespace is not a credential',
    underBlank.filter((r) => r.state === 'Connected').map((r) => r.id), []);

  /* Built in is the one state that survives empty evidence, by definition. */
  check('the things that are genuinely always on still say so',
    underNone.filter((r) => r.state === 'Built in').map((r) => r.id).sort(),
    ['audit', 'postgres']);

  /* And with real evidence, the ones that depend on it do connect. */
  const underFull = Object.fromEntries(
    INTEGRATIONS.map((i) => [i.id, stateOf(i, FULL).state]));
  for (const id of ['supabase-auth', 'storage', 'api', 'sso-providers', 'webhooks']) {
    check(`${id} connects when its evidence is there`, underFull[id], 'Connected');
  }

  /*
   * A provider with no evidence source stays Available whatever is configured.
   * Slack does not become connected because somebody set a Supabase URL.
   */
  const noSource = INTEGRATIONS
    .filter((i) => !['supabase-auth', 'storage', 'api', 'sso-providers', 'webhooks',
      'postgres', 'audit'].includes(i.id));
  check('there are providers with no evidence source to test', noSource.length > 0, true);
  check('and none of them connects however much else is configured',
    noSource.filter((i) => stateOf(i, FULL).state !== 'Available').map((i) => i.id), []);

  /* Each branch must consult the evidence: the detail changes with it. */
  const varies = ['supabase-auth', 'api', 'sso-providers', 'webhooks']
    .filter((id) => {
      const i = INTEGRATIONS.find((x) => x.id === id)!;
      return stateOf(i, NONE).detail === stateOf(i, FULL).detail;
    });
  check('every evidence-backed provider says something different when it is there',
    varies, []);

  /* Every unconnected thing says what it would take. */
  check('every available connection says how to connect it',
    rows.filter((r) => r.state === 'Available' && !r.integration.toConnect.trim())
      .map((r) => r.integration.id), []);

  const stats = await s.integrations.stats(ADMIN);
  check('the figures match the list',
    stats.connected + stats.available, rows.length);
  /* Demo mode means no API, which is the same fact the app itself branches on. */
  check('demo mode and the API connection agree',
    stats.demoMode, rows.find((r) => r.integration.id === 'api')!.state !== 'Connected');

  /* ---- who may see the plumbing ---- */

  await allowed('anybody may see what the tenant connects to',
    () => s.integrations.list(EMPLOYEE));
  await refused('but not the endpoints', () => s.integrations.webhooks(EMPLOYEE));
  await refused('nor the keys', () => s.integrations.apiKeys(EMPLOYEE));
  await refused('a manager cannot see the endpoints either',
    () => s.integrations.webhooks(MANAGER));

  /* ---- webhooks ---- */

  const draft = (over: Partial<{ n: string; url: string; events: string[] }> = {}) => ({
    n: `Check endpoint ${Math.random().toString(36).slice(2, 6)}`,
    url: 'https://example.invalid/hooks/check',
    events: ['employee.joined'],
    ...over,
  });

  await refused('a manager cannot add an endpoint',
    () => s.integrations.createWebhook(MANAGER, draft()));
  await refused('an endpoint with no name is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ n: ' ' })));
  /*
   * http is refused rather than warned about. A webhook carries employee data
   * across the internet, and over http it carries it to everybody in between.
   */
  await refused('an http endpoint is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: 'http://example.invalid/hook' })));
  await refused('a malformed URL is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: 'not a url' })));
  /*
   * The schemes a naive check lets through. `javascript:` parses as a URL and
   * `ftp:` is a perfectly valid one — neither is somewhere to post employee
   * data, and both are refused by protocol rather than by pattern-matching the
   * string, which is what makes the rule hold for the next scheme too.
   */
  await refused('a javascript: URL is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: 'javascript:alert(1)' })));
  await refused('an ftp: URL is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: 'ftp://example.invalid/hook' })));
  await refused('a file: URL is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: 'file:///etc/passwd' })));
  await refused('an empty URL is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: '' })));
  await refused('a whitespace URL is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ url: '   ' })));
  await allowed('a plain https URL is accepted',
    () => s.integrations.createWebhook(ADMIN, draft({ url: 'https://example.com/hook' })));
  await refused('an endpoint listening for nothing is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ events: [] })));
  await refused('an event that does not exist is refused',
    () => s.integrations.createWebhook(ADMIN, draft({ events: ['nope'] })));

  const hook = await s.integrations.createWebhook(ADMIN, draft());
  check('a new endpoint has delivered nothing', hook.deliveries, 0);
  check('and has never fired', hook.lastFiredOn, null);
  check('every seeded endpoint listens for a real event',
    WEBHOOKS.filter((w) => w.events.some((e) => !WEBHOOK_EVENTS.includes(e))).length, 0);
  check('no endpoint has failed more often than it has delivered',
    WEBHOOKS.filter((w) => w.failures > w.deliveries).length, 0);
  check('every endpoint is https',
    WEBHOOKS.filter((w) => !w.url.startsWith('https://')).length, 0);

  await allowed('an endpoint can be paused',
    () => s.integrations.setWebhookActive(ADMIN, hook.id, false));
  check('and it stops receiving', WEBHOOKS.find((w) => w.id === hook.id)!.active, false);
  await allowed('and removed', () => s.integrations.removeWebhook(ADMIN, hook.id));

  /* ---- API keys ---- */

  await refused('a manager cannot issue a key',
    () => s.integrations.createApiKey(MANAGER, { n: 'Check key', scopes: ['employees:read'] }));
  await refused('a key with no name is refused',
    () => s.integrations.createApiKey(ADMIN, { n: '', scopes: ['employees:read'] }));
  await refused('a key with no scopes is refused',
    () => s.integrations.createApiKey(ADMIN, { n: 'Check key', scopes: [] }));
  await refused('a scope that does not exist is refused',
    () => s.integrations.createApiKey(ADMIN, { n: 'Check key', scopes: ['everything'] }));

  const issued = await s.integrations.createApiKey(ADMIN, {
    n: 'Check key', scopes: ['employees:read'], expiresInDays: 30,
  });

  /*
   * The secret comes back once and is not kept. Asserted by looking for it in
   * the stored row rather than trusting the comment that says so.
   */
  check('the secret is returned to the caller', issued.secret.length > 8, true);
  const storedKey = API_KEYS.find((k) => k.id === issued.key.id)!;
  check('and is not stored anywhere on the record',
    JSON.stringify(storedKey).includes(issued.secret), false);
  check('only the last four characters are kept', storedKey.tail.length, 4);
  check('and they are the last four',
    storedKey.tail, issued.secret.slice(-4).toUpperCase());
  check('a new key has never been used', storedKey.lastUsedOn, null);
  check('and is not revoked', storedKey.revokedOn, null);

  /*
   * Revoked, never deleted: the key that pulled the directory in March is part
   * of the record of who had access.
   */
  const before = API_KEYS.length;
  await allowed('a key can be revoked', () => s.integrations.revokeApiKey(ADMIN, issued.key.id));
  check('revoking does not delete the row', API_KEYS.length, before);
  check('it dates the revocation',
    API_KEYS.find((k) => k.id === issued.key.id)!.revokedOn, ymd(TODAY));
  await allowed('revoking twice is not an error',
    () => s.integrations.revokeApiKey(ADMIN, issued.key.id));

  check('every seeded key uses real scopes',
    API_KEYS.filter((k) => k.scopes.some((x) => !API_SCOPES.includes(x))).length, 0);
  check('no key was last used before it was issued',
    API_KEYS.filter((k) => k.lastUsedOn && k.lastUsedOn < k.createdOn).length, 0);
  check('a revoked key is not still in use',
    API_KEYS.filter((k) => k.revokedOn && k.lastUsedOn && k.lastUsedOn > k.revokedOn).length, 0);

  /* ---- clean up ---- */

  for (const w of WEBHOOKS.filter((x) => !seededHooks.has(x.id))) {
    WEBHOOKS.splice(WEBHOOKS.indexOf(w), 1);
  }
  for (const k of API_KEYS.filter((x) => !seededKeys.has(x.id))) {
    API_KEYS.splice(API_KEYS.indexOf(k), 1);
  }
  check('the check left no endpoints behind', WEBHOOKS.length, seededHooks.size);
  check('and no keys', API_KEYS.length, seededKeys.size);
  recordAudit.reset();

  console.log();
  if (failed) {
    console.error(`${failed} integration checks failed`);
    process.exit(1);
  }
  console.log('nothing here claims a connection it cannot show');
})();
