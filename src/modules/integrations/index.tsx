/**
 * Integration settings.
 *
 * The usual version of this page is a grid of vendor logos with green ticks.
 * Almost every tick would be a claim nobody could check, and a few of them
 * would be false — there is no Slack app here, no payroll feed, no calendar
 * sync. So every state on this page is derived from configuration that
 * actually exists, and it is shown **with the reason next to it**. "Connected"
 * on its own is unfalsifiable; "Connected — reading from api.example.com" is a
 * statement somebody can check and contradict.
 *
 * What is genuinely ours — webhooks and API keys — is managed properly.
 */

import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { API_SCOPES, WEBHOOK_EVENTS } from '../../services';
import type {
  ApiKeyDraft, IntegrationRow, IntegrationState, NewApiKey, WebhookDraft,
} from '../../services';
import { Badge, Banner, Card, EmptyState, KV, StatRow, Tabs, Tile } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useApiKeys, useApiScopes, useCreateApiKey, useCreateWebhook, useIntegrationStats,
  useIntegrations, useRemoveWebhook, useRevokeApiKey, useSetWebhookActive, useWebhooks,
} from './data';

type Tab = 'connections' | 'webhooks' | 'keys';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const STATE_TONE: Record<IntegrationState, 'good' | 'info' | 'mute'> = {
  Connected: 'good', 'Built in': 'info', Available: 'mute',
};

/* ---------------- webhooks ---------------- */

function WebhookForm({ close }: { close: () => void }) {
  const app = useApp();
  const create = useCreateWebhook();
  const [d, setD] = useState<WebhookDraft>({ n: '', url: '', events: [], active: true });
  const [err, setErr] = useState('');

  const toggle = (e: string) => setD({
    ...d,
    events: d.events.includes(e) ? d.events.filter((x) => x !== e) : [...d.events, e],
  });

  const save = async () => {
    setErr('');
    try { await create.mutate(d); app.toast('Endpoint added', 'ok'); close(); }
    catch (e) { setErr(msg(e, 'Could not add the endpoint')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not added">{err}</Banner>}

      <div className="field">
        <label>What is it <span className="req">*</span></label>
        <input className="input" value={d.n} autoFocus placeholder="IT provisioning"
          onChange={(e) => setD({ ...d, n: e.target.value })} />
      </div>

      <div className="field">
        <label>Where to post <span className="req">*</span></label>
        <input className="input" value={d.url} placeholder="https://automation.example.com/hooks/joiners"
          onChange={(e) => setD({ ...d, url: e.target.value })} />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
          https only. This carries employee data to somebody else&rsquo;s server, and
          over http it carries it to everybody in between.
        </div>
      </div>

      <div className="field">
        <label>Send on <span className="req">*</span></label>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap', marginTop: 6 }}>
          {WEBHOOK_EVENTS.map((e) => (
            <button key={e} type="button"
              className={'chip' + (d.events.includes(e) ? ' on' : '')}
              aria-pressed={d.events.includes(e)}
              onClick={() => toggle(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={create.pending} onClick={save}>
          Add endpoint
        </button>
      </div>
    </div>
  );
}

/* ---------------- keys ---------------- */

function ApiKeyForm({ close }: { close: () => void }) {
  const app = useApp();
  const create = useCreateApiKey();
  const { data: scopes = API_SCOPES } = useApiScopes();
  const [d, setD] = useState<ApiKeyDraft>({ n: '', scopes: [], expiresInDays: 365 });
  const [err, setErr] = useState('');
  const [issued, setIssued] = useState<NewApiKey | null>(null);

  const toggle = (s: string) => setD({
    ...d,
    scopes: d.scopes.includes(s) ? d.scopes.filter((x) => x !== s) : [...d.scopes, s],
  });

  const save = async () => {
    setErr('');
    try { setIssued(await create.mutate(d)); app.toast('Key issued', 'ok'); }
    catch (e) { setErr(msg(e, 'Could not issue the key')); }
  };

  /*
   * Once issued, the form becomes the one and only sight of the secret. No
   * cancel button here — closing is the only way out, and the copy above the
   * key says plainly that it will not be shown again.
   */
  if (issued) {
    return (
      <div className="stack">
        <Banner kind="warn" icon={<Icon n="lock" size="lg" />} title="Copy it now">
          This is the only time this key will be shown. It is not stored — what is
          kept is its name, its scopes and the last four characters, which is enough
          to recognise it in a list and useless to anybody who finds it.
        </Banner>
        <div className="field">
          <label>{issued.key.n}</label>
          <input className="input mono" readOnly value={issued.secret}
            onFocus={(e) => e.currentTarget.select()} />
        </div>
        <KV rows={[
          ['Scopes', issued.key.scopes.join(', ')],
          ['Expires', issued.key.expiresOn ? fmtD(issued.key.expiresOn) : 'Never'],
        ]} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={close}>I have copied it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not issued">{err}</Banner>}

      <div className="field">
        <label>What is it for <span className="req">*</span></label>
        <input className="input" value={d.n} autoFocus placeholder="Reporting warehouse"
          onChange={(e) => setD({ ...d, n: e.target.value })} />
      </div>

      <div className="field">
        <label>What it may do <span className="req">*</span></label>
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>
          Choose the narrowest set that works. A key with more scope than it needs
          is the one that matters when it leaks.
        </div>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
          {scopes.map((s) => (
            <button key={s} type="button"
              className={'chip' + (d.scopes.includes(s) ? ' on' : '')}
              aria-pressed={d.scopes.includes(s)}
              onClick={() => toggle(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Expires after</label>
        <select className="input" value={d.expiresInDays ?? ''}
          onChange={(e) => setD({
            ...d,
            expiresInDays: e.target.value ? Number(e.target.value) : undefined,
          })}>
          <option value="90">90 days</option>
          <option value="180">180 days</option>
          <option value="365">A year</option>
          <option value="">Never — not recommended</option>
        </select>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={create.pending} onClick={save}>
          Issue key
        </button>
      </div>
    </div>
  );
}

/* ---------------- the page ---------------- */

function IntegrationsView() {
  const app = useApp();
  const layer = useLayer();
  const [tab, setTab] = useTabFromUrl<Tab>('connections', ['connections', 'webhooks', 'keys']);

  const { data: rows = [], loading, error } = useIntegrations();
  const { data: stats } = useIntegrationStats();
  const { data: hooks = [] } = useWebhooks();
  const { data: keys = [] } = useApiKeys();
  const setActive = useSetWebhookActive();
  const removeHook = useRemoveWebhook();
  const revoke = useRevokeApiKey();

  if (error) {
    return (
      <Card title="Integrations">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  const byKind = sortBy(rows, (r) => r.integration.kind);
  const kinds = [...new Set(byKind.map((r) => r.integration.kind))];

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile icon={<Icon n="verified" size="lg" />} label="In use"
          value={stats?.connected ?? '—'} foot="Connected or built in" />
        <Tile icon={<Icon n="puzzle" size="lg" />} label="Not set up"
          value={stats?.available ?? '—'} foot="Supported, not configured" />
        <Tile icon={<Icon n="send" size="lg" />} label="Endpoints"
          value={stats?.webhooks ?? '—'}
          foot={stats?.unhealthy ? `${stats.unhealthy} failing` : 'All healthy'} />
        <Tile icon={<Icon n="lock" size="lg" />} label="API keys"
          value={stats?.keys ?? '—'}
          foot={stats?.expiringSoon ? `${stats.expiringSoon} expiring soon` : 'None expiring'} />
      </StatRow>

      {stats?.demoMode && (
        <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="This build is not reading real data">
          No API is configured, so every screen in this app is showing the built-in
          demo dataset. Nothing you change here reaches a real system.
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'connections' as const, label: `Connections (${rows.length})` },
          { v: 'webhooks' as const, label: `Endpoints (${hooks.length})` },
          { v: 'keys' as const, label: `API keys (${keys.filter((k) => !k.revoked).length})` },
        ]}
        onChange={setTab}
      />

      {tab === 'connections' && (
        <>
          <Banner kind="info" icon={<Icon n="info" size="lg" />} title="Every state here is worked out, not recorded">
            Nothing on this page can be set to &ldquo;connected&rdquo; by hand. Each one is
            read from the configuration this build is actually running with, and the
            reason is printed beside it so you can contradict it.
          </Banner>

          {kinds.map((kind) => (
            <Card key={kind} title={kind} flush>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>What</th><th>State</th><th>Why</th><th>To connect</th></tr>
                  </thead>
                  <tbody>
                    {byKind.filter((r: IntegrationRow) => r.integration.kind === kind).map((r) => (
                      <tr key={r.integration.id}>
                        <td>
                          <div style={{ fontWeight: 650, fontSize: 13 }}>{r.integration.n}</div>
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {r.integration.vendor}
                          </div>
                        </td>
                        <td><Badge kind={STATE_TONE[r.state]}>{r.state}</Badge></td>
                        <td className="muted" style={{ fontSize: 12, maxWidth: 300 }}>
                          {r.detail}
                          {r.integration.setting && (
                            <div className="mono" style={{ fontSize: 11, marginTop: 3 }}>
                              {r.integration.setting}
                            </div>
                          )}
                        </td>
                        <td className="muted" style={{ fontSize: 11.5, maxWidth: 280 }}>
                          {r.integration.toConnect || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          {!rows.length && (
            <Card title="Connections">
              <EmptyState icon={<Icon n="puzzle" size="xl" />}
                msg={loading ? 'Loading…' : 'Nothing to show'} />
            </Card>
          )}
        </>
      )}

      {tab === 'webhooks' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              We post to these when something happens here.
            </span>
            {app.role === 'admin' && (
              <button className="btn sm primary" onClick={() => layer.modal({
                title: 'Add an endpoint',
                body: (close) => <WebhookForm close={close} />,
                footer: null,
              })}>
                <Icon n="add" size="lg" /> Add endpoint
              </button>
            )}
          </div>

          <Card title="Outbound endpoints" flush>
            {hooks.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Endpoint</th><th>Events</th><th className="num">Delivered</th>
                      <th className="num">Failed</th><th>Last</th><th>State</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {hooks.map((h) => (
                      <tr key={h.webhook.id}>
                        <td>
                          <div style={{ fontWeight: 650, fontSize: 13 }}>{h.webhook.n}</div>
                          <div className="muted mono" style={{ fontSize: 11 }}>{h.webhook.url}</div>
                        </td>
                        <td className="muted" style={{ fontSize: 11.5, maxWidth: 200 }}>
                          {h.webhook.events.join(', ')}
                        </td>
                        <td className="num">{h.webhook.deliveries}</td>
                        <td className="num">
                          {h.webhook.failures || '—'}
                          {h.unhealthy && <> <Badge kind="crit">{h.failureRate}%</Badge></>}
                        </td>
                        <td className="nowrap">
                          {h.webhook.lastFiredOn ? fmtD(h.webhook.lastFiredOn) : 'Never'}
                          {h.webhook.lastStatus && (
                            <div className="muted mono" style={{ fontSize: 11 }}>
                              {h.webhook.lastStatus}
                            </div>
                          )}
                        </td>
                        <td>
                          {h.webhook.active
                            ? <Badge kind="good">Receiving</Badge>
                            : <Badge kind="mute">Paused</Badge>}
                        </td>
                        <td className="num">
                          {app.role === 'admin' && (
                            <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn sm" onClick={() => act(
                                () => setActive.mutate(h.webhook.id, !h.webhook.active),
                                h.webhook.active ? 'Endpoint paused' : 'Endpoint resumed')}>
                                {h.webhook.active ? 'Pause' : 'Resume'}
                              </button>
                              <button className="btn ghost icon sm"
                                aria-label={`Remove ${h.webhook.n}`}
                                onClick={() => act(() => removeHook.mutate(h.webhook.id),
                                  'Endpoint removed')}>
                                <Icon n="remove" size="sm" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={<Icon n="send" size="xl" />}
                msg="Nothing is receiving events from here" />
            )}
          </Card>
        </>
      )}

      {tab === 'keys' && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Credentials issued to other systems to read from here.
            </span>
            {app.role === 'admin' && (
              <button className="btn sm primary" onClick={() => layer.modal({
                title: 'Issue an API key',
                size: 'narrow',
                body: (close) => <ApiKeyForm close={close} />,
                footer: null,
              })}>
                <Icon n="add" size="lg" /> Issue key
              </button>
            )}
          </div>

          <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="Keys are shown once and never stored">
            What is kept is the name, the scopes and the last four characters. Revoked
            keys stay on this list — a key that pulled the directory in March is part
            of the record of who had access, and deleting the row removes the only
            evidence it existed.
          </Banner>

          <Card title="API keys" flush>
            {keys.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Key</th><th>Scopes</th><th>Issued</th><th>Last used</th>
                      <th>Expires</th><th>State</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.key.id}>
                        <td>
                          <div style={{ fontWeight: 650, fontSize: 13 }}>{k.key.n}</div>
                          <div className="muted mono" style={{ fontSize: 11 }}>
                            ••••{k.key.tail}
                          </div>
                        </td>
                        <td className="muted" style={{ fontSize: 11.5, maxWidth: 220 }}>
                          {k.key.scopes.join(', ')}
                        </td>
                        <td className="nowrap">{fmtD(k.key.createdOn)}</td>
                        <td className="nowrap">
                          {k.key.lastUsedOn ? fmtD(k.key.lastUsedOn) : 'Never'}
                        </td>
                        <td className="nowrap">
                          {k.key.expiresOn ? fmtD(k.key.expiresOn) : 'Never'}
                        </td>
                        <td>
                          {k.revoked ? <Badge kind="mute">Revoked</Badge>
                            : k.expired ? <Badge kind="crit">Expired</Badge>
                              : k.expiringSoon ? <Badge kind="warn">Expiring</Badge>
                                : <Badge kind="good">Live</Badge>}
                        </td>
                        <td className="num">
                          {app.role === 'admin' && !k.revoked && (
                            <button className="btn sm danger"
                              onClick={() => act(() => revoke.mutate(k.key.id), 'Key revoked')}>
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={<Icon n="lock" size="xl" />} msg="No keys have been issued" />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

registerModule({
  key: 'integrations',
  title: TITLES.integrations,
  Component: IntegrationsView,
});

export { IntegrationsView };
