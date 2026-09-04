import { useState } from 'react';
import { sortBy, uniq } from '../../lib/collections';
import { addDays, fmtD, monthLabelLong, TODAY, yearsSince, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { COUNTRIES, countryOf, mb, money } from '../../data/countries';
import { ACTIVE, empName } from '../../data/employees';
import { deptOf, ORG } from '../../data/org';
import { CUR_RUN, payslip } from '../../data/payroll';
import {
  WA_ACCOUNT, WA_CAT_BADGE, WA_CONSENT, WA_LOG, WA_RULES, WA_STATUS_BADGE, WA_TEMPLATES,
  waConsent, waKPI, waRender, waTpl,
} from '../../data/whatsapp';
import type { WaTemplate } from '../../data/whatsapp';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { BarChart, HBar, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { pendingCount } from '../../state/pending';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const WaBadge = ({ s }: { s: string }) => (
  <Badge kind={(WA_STATUS_BADGE[s] || 'mute') as 'good' | 'info' | 'warn' | 'crit' | 'mute'}>{s}</Badge>
);
const WaCatBadge = ({ c }: { c: string }) => (
  <Badge kind={(WA_CAT_BADGE[c] || 'mute') as 'good' | 'info' | 'warn' | 'mute'}>{c}</Badge>
);

/** A message rendered as it appears on the handset. */
function WaBubble({ text, cta }: { text: string; cta?: string | null }) {
  return (
    <div className="wa-phone">
      <div className="wa-top">
        {WA_ACCOUNT.displayName}
        <span className="wa-verified" title="Verified business">✓</span>
        <span className="wa-num">{WA_ACCOUNT.number}</span>
      </div>
      <div className="wa-body">
        <div className="wa-msg">
          {text.split('\n').map((line, i) => <div key={i}>{line}</div>)}
          {cta && <div className="wa-cta">{cta}</div>}
          <div className="wa-meta">14:32 ✓✓</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Fills a template's variables from live records, so previews show real data
 * rather than placeholders.
 */
function useSampleFor() {
  const app = useApp();
  const e = app.me;
  const f = e.name.split(' ')[0];
  const ct = countryOf(e.country);

  return (t: WaTemplate): string => {
    const map: Record<string, string[]> = {
      payslip_ready: [f, monthLabelLong(CUR_RUN.mk), money(payslip(e, CUR_RUN.mk).net, e.ccy), '4417'],
      leave_decision: [f, 'Earned Leave', '12–14 Sep 2026', 'approved', empName(e.managerId || '') || 'your manager', '9'],
      approval_pending: [f, String(pendingCount(app.role, app.meId) || 4), '3'],
      birthday: [f, ORG.name],
      anniversary: [f, String(Math.max(1, yearsSince(e.doj))), ORG.name],
      interview_invite: ['Anjali', 'Technical', 'Senior Software Engineer', fmtD(ymd(addDays(TODAY, 2))), '11:00 IST'],
      offer_released: ['Anjali', 'Senior Software Engineer', ct.entity],
      onboarding_task: ['Anjali', 'Bank account and PAN submission', fmtD(ymd(addDays(TODAY, 2)))],
      attendance_missing: [f],
      timesheet_due: [f, fmtD(ymd(addDays(TODAY, 1))), '32'],
      bench_alert: ['Naveen', 'Data Engineer', 'Banking', fmtD(ymd(addDays(TODAY, 21)))],
      invoice_chase: ['Michael Grant', 'INV-US-9006', '$168,288', fmtD(ymd(addDays(TODAY, -12)))],
      asset_return: [f, 'MacBook Pro 14"', fmtD(ymd(addDays(TODAY, 3)))],
      otp: ['482913'],
    };
    return waRender(t.id, map[t.id] || []);
  };
}

/* ---------------- Employee view ---------------- */

function WaMine() {
  const app = useApp();
  const sample = useSampleFor();
  const c = waConsent(app.meId);
  const mine = WA_LOG.filter((l) => l.empId === app.meId).slice(0, 25);

  const toggle = (key: 'optIn' | 'marketing') => {
    const rec = WA_CONSENT[app.meId];
    rec[key] = !rec[key];
    /* turning off HR updates also stops the marketing category */
    if (key === 'optIn' && !rec.optIn) rec.marketing = false;
    if (key === 'optIn' && rec.optIn && !rec.on) {
      rec.on = ymd(TODAY);
      rec.via = 'Self-service portal';
      rec.verified = true;
      rec.number = app.me.phone;
    }
    app.toast(rec[key] ? 'Turned on' : 'Turned off', 'ok');
    app.bump();
  };

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <Card title="WhatsApp notifications"
          sub={c.optIn ? 'You receive updates on ' + c.number : 'You are not receiving WhatsApp updates'}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <div>
              <b>Receive HR updates</b>
              <div className="mt">Payslips, leave decisions, approvals, timesheet and attendance reminders</div>
            </div>
            <button className={'btn' + (c.optIn ? '' : ' primary')} onClick={() => toggle('optIn')}>
              {c.optIn ? 'Turn off' : 'Turn on'}
            </button>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12, padding: '10px 0' }}>
            <div>
              <b>Celebration messages</b>
              <div className="mt">Birthday and work anniversary wishes</div>
            </div>
            <button className={'btn' + (c.marketing ? '' : ' primary')} disabled={!c.optIn} onClick={() => toggle('marketing')}>
              {c.marketing ? 'Turn off' : 'Turn on'}
            </button>
          </div>
          {c.optIn ? (
            <div className="hint" style={{ marginTop: 10 }}>
              Opted in on {fmtD(c.on)} via {c.via}. You can stop at any time here, or by replying STOP to any message.
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <Banner kind="info" icon="ℹ">
                Turning this on means we may message you on WhatsApp about your employment. Sign-in codes are always sent
                regardless of this setting.
              </Banner>
            </div>
          )}
        </Card>

        <Card title="Preview" sub="How a message looks">
          <WaBubble text={sample(waTpl('payslip_ready')!)} cta="View payslip" />
        </Card>
      </div>

      <Card title="Messages sent to you" sub={`${mine.length} in the last 30 days`} flush>
        {mine.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>Message</th><th>Type</th><th>Status</th></tr></thead>
              <tbody>
                {mine.map((l) => (
                  <tr key={l.id}>
                    <td className="nowrap">{fmtD(l.on)} <span className="muted">{l.at}</span></td>
                    <td>{waTpl(l.tplId)?.name}</td>
                    <td><WaCatBadge c={l.cat} /></td>
                    <td><WaBadge s={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No messages sent to you yet" icon="💬" />}
      </Card>
    </div>
  );
}

/* ---------------- Templates ---------------- */

function WaTemplates() {
  const app = useApp();
  const k = waKPI();

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="Business number" value={WA_ACCOUNT.number}
          foot={WA_ACCOUNT.verified ? `Verified · quality ${WA_ACCOUNT.quality.toLowerCase()}` : 'Not verified'} />
        <Tile label="Templates live" value={`${k.active} of ${WA_TEMPLATES.length}`}
          foot={`${WA_TEMPLATES.filter((t) => t.status !== 'Approved').length} awaiting Meta review`} />
        <Tile label="Opted in" value={k.optInRate + '%'} foot={`${k.optIn} of ${ACTIVE().length} employees`} />
        <Tile label="Delivery rate" value={k.deliveryRate + '%'} foot={`${k.readRate}% read · last 30 days`} />
        <Tile label="Conversation cost" value={mb(Math.round(k.cost))} foot={`${k.sent} messages in 30 days`} />
      </div>

      <Banner kind="info" icon="💬">
        Templates must be approved by Meta before they can be used, and the category decides the rules.{' '}
        <b>Utility</b> messages relate to an existing transaction. <b>Marketing</b> needs explicit opt-in and is billed
        higher. <b>Authentication</b> is for sign-in codes only.
      </Banner>

      <Card title="Message templates"
        sub={`${WA_TEMPLATES.length} templates across ${uniq(WA_TEMPLATES.map((t) => t.cat)).length} categories`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Template</th><th>Category</th><th>Fires on</th><th>Audience</th>
                <th className="num">Sent (30d)</th><th className="num">Read</th><th>Meta status</th><th className="right">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {WA_TEMPLATES.map((t) => {
                const sent = WA_LOG.filter((l) => l.tplId === t.id);
                return (
                  <tr key={t.id}>
                    <td><b>{t.name}</b><div className="mt">{t.body.slice(0, 62)}…</div></td>
                    <td><WaCatBadge c={t.cat} /></td>
                    <td className="nowrap muted">{t.event}</td>
                    <td className="nowrap">{t.audience}</td>
                    <td className="num">{sent.length}</td>
                    <td className="num">{sent.length ? pct(sent.filter((l) => l.status === 'Read').length, sent.length) + '%' : '—'}</td>
                    <td>
                      {t.status === 'Approved' ? <Badge kind="good">Approved</Badge> : <Badge kind="warn">{t.status}</Badge>}
                    </td>
                    <td className="right">
                      <button className={'btn sm' + (t.on ? '' : ' primary')} onClick={() => {
                        t.on = !t.on;
                        app.toast(`${t.name} ${t.on ? 'enabled' : 'paused'}`, 'ok');
                        app.bump();
                      }}>{t.on ? 'On' : 'Off'}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Routing rules ---------------- */

const ESCALATION: [string, string][] = [
  ['1 · WhatsApp', 'Sent to the verified number if the employee has opted in for that category.'],
  ['2 · In-app notification', 'Always written to the bell in 360 People, whether or not WhatsApp succeeded.'],
  ['3 · Email', 'Sent when WhatsApp fails, or when the message carries an attachment such as a payslip PDF.'],
  ['4 · Manager', 'For approvals unread after 72 hours, the reminder escalates to the next level up.'],
];

function WaRules() {
  const app = useApp();
  return (
    <div className="stack">
      <Card title="Routing rules" sub={`${WA_RULES.filter((r) => r.on).length} of ${WA_RULES.length} rules active`} flush
        actions={<span className="muted" style={{ fontSize: 12.5 }}>Quiet hours: 21:00–08:00 in the recipient&rsquo;s own timezone</span>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Rule</th><th>Template</th><th>Trigger</th><th>Recipients</th><th>Respects quiet hours</th><th className="right">Active</th></tr>
            </thead>
            <tbody>
              {WA_RULES.map((r) => {
                const t = waTpl(r.tpl);
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <b>{t?.name || r.tpl}</b>
                      <div className="mt"><WaCatBadge c={t?.cat || 'Utility'} /></div>
                    </td>
                    <td>{r.when}</td>
                    <td className="muted">{r.to}</td>
                    <td>{r.quiet ? <Badge kind="good">Yes</Badge> : <Badge>Sends immediately</Badge>}</td>
                    <td className="right">
                      <button className={'btn sm' + (r.on ? '' : ' primary')} onClick={() => {
                        r.on = !r.on;
                        app.toast(`${r.id} ${r.on ? 'activated' : 'paused'}`, 'ok');
                        app.bump();
                      }}>{r.on ? 'Active' : 'Paused'}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Volume by trigger" sub="Last 30 days">
          <HBar rows={sortBy(
            WA_TEMPLATES.map((t, i) => ({ k: t.name, c: PAL[i % 8], v: WA_LOG.filter((l) => l.tplId === t.id).length })).filter((r) => r.v),
            (r) => -r.v,
          ).slice(0, 10)} />
        </Card>
        <Card title="Escalation ladder" sub="What happens when WhatsApp cannot reach someone">
          <div className="tl">
            {ESCALATION.map(([t, d]) => (
              <div className="tl-i" key={t}>
                <b style={{ fontSize: 12.5 }}>{t}</b>
                <div className="mt">{d}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Delivery log ---------------- */

function WaLog() {
  const [fs, setFs] = useState('');
  const [ft, setFt] = useState('');
  const k = waKPI();

  let list = WA_LOG;
  if (fs) list = list.filter((l) => l.status === fs);
  if (ft) list = list.filter((l) => l.tplId === ft);

  const days: { k: string; v: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = ymd(addDays(TODAY, -i));
    days.push({ k: fmtD(d).slice(0, 6), v: WA_LOG.filter((l) => l.on === d).length });
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={ft} onChange={(e) => setFt(e.target.value)}>
          <option value="">All templates</option>
          {WA_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={fs} onChange={(e) => setFs(e.target.value)}>
          <option value="">All statuses</option>
          {['Read', 'Delivered', 'Sent', 'Failed'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() =>
          downloadCSV('whatsapp_log.csv',
            [['Date', 'Time', 'Template', 'Recipient', 'Number', 'Category', 'Status', 'Reply', 'Error', 'Cost']].concat(
              WA_LOG.map((l) => [l.on, l.at, waTpl(l.tplId)?.name || l.tplId, empName(l.empId), l.to,
                l.cat, l.status, l.replied || '', l.error || '', String(l.cost)]),
            ))}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Messages sent" value={k.sent} foot="Rolling 30 days" />
        <Tile label="Delivered" value={k.deliveryRate + '%'} foot={`${k.delivered} reached the handset`} />
        <Tile label="Read" value={k.readRate + '%'} foot={`${k.read} opened`} />
        <Tile label="Failed" value={k.failed} foot="Escalated to email" />
        <Tile label="Replies received" value={k.replies} foot="Inbound responses to handle" />
      </div>

      <Card title="Daily volume" sub="Last 14 days">
        <BarChart labels={days.map((d) => d.k)} height={170}
          series={[{ name: 'Messages', color: 'var(--s3)', data: days.map((d) => d.v) }]} />
      </Card>

      <Card title="Delivery log" sub={`${list.length} of ${WA_LOG.length} messages`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>When</th><th>Template</th><th>Recipient</th><th>Number</th><th>Category</th><th>Status</th><th>Reply / error</th></tr>
            </thead>
            <tbody>
              {list.slice(0, 200).map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{fmtD(l.on)} <span className="muted">{l.at}</span></td>
                  <td>{waTpl(l.tplId)?.name || l.tplId}</td>
                  <td className="nowrap">{empName(l.empId)} {countryOf(l.country).flag}</td>
                  <td className="mono muted nowrap">{l.to}</td>
                  <td><WaCatBadge c={l.cat} /></td>
                  <td><WaBadge s={l.status} /></td>
                  <td className="muted">{l.replied ? `“${l.replied}”` : l.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length > 200 && (
          <div className="card-b">
            <div className="muted" style={{ fontSize: 12.5 }}>Showing the most recent 200 — export for the full log.</div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Consent ---------------- */

function WaConsentTab() {
  const app = useApp();
  const k = waKPI();
  const list = ACTIVE();
  const noOpt = list.filter((e) => !waConsent(e.id).optIn);
  const unverified = list.filter((e) => waConsent(e.id).optIn && !waConsent(e.id).verified);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Opted in" value={`${k.optIn} of ${list.length}`} foot={`${k.optInRate}% reachable on WhatsApp`} />
        <Tile label="Not opted in" value={noOpt.length} foot="Fall back to in-app and email" />
        <Tile label="Number unverified" value={unverified.length} foot="Opted in but never confirmed" />
        <Tile label="Celebration opt-in" value={list.filter((e) => waConsent(e.id).marketing).length}
          foot="Separate consent, as Marketing category" />
      </div>

      <Banner kind="info" icon="🔒">
        Consent is recorded per category and is withdrawable — by the employee in self-service, or by replying STOP.
        Withdrawal takes effect on the next send, and is written to the audit trail. Sign-in codes are Authentication
        category and are sent regardless.
      </Banner>

      <div className="grid g2">
        <Card title="Opt-in by country" sub="Where our reach is weakest">
          <HBar fmt={(v) => v + '%'}
            rows={COUNTRIES.filter((c) => list.some((e) => e.country === c.id)).map((c, i) => {
              const g = list.filter((e) => e.country === c.id);
              return {
                k: `${c.flag} ${c.name}`, c: PAL[i % 8],
                v: pct(g.filter((e) => waConsent(e.id).optIn).length, Math.max(1, g.length)),
              };
            })} />
        </Card>

        <Card title="Not reachable" sub={`${noOpt.length} employees`} flush
          actions={<button className="btn sm primary" onClick={() => app.toast(`Opt-in request sent to ${noOpt.length} employees`, 'ok')}>Request opt-in</button>}>
          {noOpt.length ? (
            <div className="tbl-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Employee</th><th>Department</th><th>Number on file</th><th className="right">Action</th></tr></thead>
                <tbody>
                  {noOpt.slice(0, 40).map((e) => (
                    <tr key={e.id}>
                      <td><PersonCell e={e} sub={e.code} /></td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="mono muted nowrap">{e.phone}</td>
                      <td className="right">
                        <button className="btn sm" onClick={() => app.toast('Opt-in request sent to ' + e.name, 'ok')}>Ask</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <EmptyState msg="Everyone is reachable" icon="✓" />}
        </Card>
      </div>

      <Card title="Consent register" sub={`${list.length} employees`} flush
        actions={<button className="btn sm" onClick={() =>
          downloadCSV('whatsapp_consent.csv',
            [['Emp Code', 'Name', 'Number', 'HR updates', 'Celebrations', 'Verified', 'Recorded', 'Captured via']].concat(
              list.map((e) => {
                const c = waConsent(e.id);
                return [e.code, e.name, c.number, c.optIn ? 'Yes' : 'No', c.marketing ? 'Yes' : 'No',
                  c.verified ? 'Yes' : 'No', c.on || '', c.via || ''];
              }),
            ))}>⤓ Export</button>}>
        <div className="tbl-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr><th>Employee</th><th>Number</th><th>HR updates</th><th>Celebrations</th><th>Verified</th><th>Recorded</th><th>Captured via</th></tr>
            </thead>
            <tbody>
              {list.map((e) => {
                const c = waConsent(e.id);
                return (
                  <tr key={e.id}>
                    <td><PersonCell e={e} sub={e.code} /></td>
                    <td className="mono muted nowrap">{c.number}</td>
                    <td>{c.optIn ? <Badge kind="good">Opted in</Badge> : <Badge>No</Badge>}</td>
                    <td>{c.marketing ? <Badge kind="good">Opted in</Badge> : <Badge>No</Badge>}</td>
                    <td>
                      {c.verified ? <Badge kind="good">✓</Badge> : c.optIn ? <Badge kind="warn">Pending</Badge> : <span className="muted">—</span>}
                    </td>
                    <td className="nowrap">{c.on ? fmtD(c.on) : '—'}</td>
                    <td className="nowrap muted">{c.via || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'tpl' | 'rules' | 'log' | 'consent';

const TABS: { v: Tab; label: string }[] = [
  { v: 'tpl', label: 'Templates' }, { v: 'rules', label: 'Routing Rules' },
  { v: 'log', label: 'Delivery Log' }, { v: 'consent', label: 'Consent & Numbers' },
];

function WhatsApp() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('tpl');
  if (app.role !== 'admin') return <WaMine />;

  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'tpl' && <WaTemplates />}
      {tab === 'rules' && <WaRules />}
      {tab === 'log' && <WaLog />}
      {tab === 'consent' && <WaConsentTab />}
    </>
  );
}

registerModule({
  key: 'whatsapp',
  title: TITLES.whatsapp,
  subtitle: (c) => {
    if (c.role !== 'admin') return 'Your WhatsApp notification settings';
    const k = waKPI();
    return `${k.active} templates live · ${k.optInRate}% of employees opted in`;
  },
  Component: WhatsApp,
});
