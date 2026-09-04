import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { daysBetween, fmtD, MON, monthKey, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { EMAP, empName } from '../../data/employees';
import { KB, TICKETS, TICKET_CATS, tCat } from '../../data/helpdesk';
import type { Ticket } from '../../data/helpdesk';
import { deptOf } from '../../data/org';
import { Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile } from '../../components/ui';
import { Divide, ListRow } from '../../components/common';
import { BarChart, HBar, Legend, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const PRIO_TONE: Record<string, 'crit' | 'warn' | 'info' | 'mute'> = {
  Urgent: 'crit', High: 'warn', Medium: 'info', Low: 'mute',
};
const STATUS_TONE: Record<string, 'warn' | 'info' | 'good' | 'mute'> = {
  Open: 'warn', 'In Progress': 'info', Resolved: 'good', Closed: 'mute',
};

const PrioBadge = ({ p }: { p: string }) => <Badge kind={PRIO_TONE[p]}>{p}</Badge>;
const TktBadge = ({ s }: { s: string }) => <Badge kind={STATUS_TONE[s]}>{s}</Badge>;

/** Age buckets for the open-ticket ageing chart. */
const AGE_BUCKETS: [string, number, number][] = [
  ['Under 1 day', 0, 1], ['1–3 days', 1, 3], ['3–7 days', 3, 7], ['Over 7 days', 7, 999],
];

function TicketTable({ list, showEmp, onOpen }: { list: Ticket[]; showEmp?: boolean; onOpen: (t: Ticket) => void }) {
  if (!list.length) return <EmptyState msg="No tickets here" icon="🎫" />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Ticket</th>
            {showEmp && <th>Raised by</th>}
            <th>Category</th><th>Priority</th><th>Assigned to</th><th>Raised</th><th>SLA</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sortBy(list, (t) => t.createdOn, 'desc').map((t) => (
            <tr key={t.id} className="clickable" onClick={() => onOpen(t)}>
              <td>
                <b>{t.subject}</b>
                <div className="muted mono" style={{ fontSize: 11 }}>{t.id}</div>
              </td>
              {showEmp && <td><PersonCell e={EMAP[t.empId]} /></td>}
              <td className="nowrap">{tCat(t.cat).ic} {tCat(t.cat).n}</td>
              <td><PrioBadge p={t.priority} /></td>
              <td className="nowrap">{empName(t.assigneeId)}</td>
              <td className="nowrap">{fmtD(t.createdOn)}</td>
              <td>
                {t.breached
                  ? <Badge kind="crit">Breached</Badge>
                  : t.resolutionHrs != null
                    ? <Badge kind="good">{t.resolutionHrs} h</Badge>
                    : <Badge kind="info">{t.slaHours} h target</Badge>}
              </td>
              <td><TktBadge s={t.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- ticket drawer ---------------- */

function TicketBody({ t, close }: { t: Ticket; close: () => void }) {
  const app = useApp();
  const [reply, setReply] = useState('');

  return (
    <>
      <div className="row wrap" style={{ gap: 7, marginBottom: 14 }}>
        <TktBadge s={t.status} />
        <PrioBadge p={t.priority} />
        {t.breached ? <Badge kind="crit">SLA breached</Badge> : <Badge kind="info">{t.slaHours} h SLA</Badge>}
      </div>

      <div style={{ marginBottom: 14 }}>
        <KV rows={[
          ['Raised by', empName(t.empId)],
          ['Assigned to', `${empName(t.assigneeId)} · ${deptOf(tCat(t.cat).team).name}`],
          ['Created', `${fmtD(t.createdOn)} at ${t.createdTime}`],
          ['Due by', fmtD(t.dueOn)],
          ...(t.resolvedOn ? [['Resolved', `${fmtD(t.resolvedOn)} · took ${t.resolutionHrs} h`]] as [string, string][] : []),
          ...(t.csat ? [['Satisfaction', '★'.repeat(t.csat) + '☆'.repeat(5 - t.csat)]] as [string, string][] : []),
        ]} />
      </div>

      <Banner icon="💬">{t.desc}</Banner>

      {t.comments.length > 0 && (
        <>
          <Divide />
          <h4 style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink-3)' }}>
            Activity
          </h4>
          {t.comments.map((c, i) => (
            <div key={i} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 650 }}>{c.by} · {fmtD(c.on)}</div>
              <div style={{ fontSize: 12.5, marginTop: 3 }}>{c.text}</div>
            </div>
          ))}
        </>
      )}

      <Divide />
      <div className="field">
        <label>Add a reply</label>
        <textarea className="input" placeholder="Type your update…" value={reply} onChange={(e) => setReply(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Close</button>
        <button className="btn" onClick={() => {
          const v = reply.trim();
          if (!v) {
            app.toast('Write something first', 'err');
            return;
          }
          t.comments.push({ by: app.me.name, on: ymd(TODAY), text: v });
          /* replying to a new ticket moves it into progress */
          if (t.status === 'Open') t.status = 'In Progress';
          close();
          app.toast('Reply posted', 'ok');
          app.bump();
        }}>Post reply</button>
        {(app.role === 'admin' || t.assigneeId === app.meId) && t.status !== 'Closed' && (
          <button className="btn primary" onClick={() => {
            t.status = 'Resolved';
            t.resolvedOn = ymd(TODAY);
            t.resolutionHrs = Math.max(1, daysBetween(t.createdOn, ymd(TODAY)) * 24);
            t.breached = t.resolutionHrs > t.slaHours;
            close();
            app.toast('Ticket marked resolved', 'ok');
            app.bump();
          }}>Mark resolved</button>
        )}
      </div>
    </>
  );
}

function useShowTicket() {
  const layer = useLayer();
  return (t: Ticket) =>
    layer.drawer({
      title: t.subject,
      sub: `${t.id} · ${tCat(t.cat).n}`,
      body: (close) => <TicketBody t={t} close={close} />,
    });
}

/* ---------------- new ticket ---------------- */

function NewTicketForm({ close }: { close: () => void }) {
  const app = useApp();
  const [cat, setCat] = useState(TICKET_CATS[0].id);
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState('Medium');

  return (
    <>
      <div className="grid g2" style={{ gap: '0 14px' }}>
        <div className="field">
          <label>Category</label>
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
            {TICKET_CATS.map((c) => <option key={c.id} value={c.id}>{c.ic} {c.n} — {c.sla} h SLA</option>)}
          </select>
        </div>
        <div className="field">
          <label>Priority</label>
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['Low', 'Medium', 'High', 'Urgent'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Subject</label>
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="field">
        <label>Describe the issue</label>
        <textarea className="input" style={{ minHeight: 90 }} value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <Banner kind="info" icon="⏱️">
        {tCat(cat).n} tickets are handled by {deptOf(tCat(cat).team).name} with a {tCat(cat).sla}-hour resolution target.
      </Banner>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!subject.trim()} onClick={() => {
          const created = new Date();
          TICKETS.unshift({
            id: 'TKT-' + (9100 + TICKETS.length),
            empId: app.meId, cat, subject, desc: desc || 'Raised via employee self-service.',
            priority, status: 'Open', createdOn: ymd(TODAY),
            createdTime: String(created.getHours()).padStart(2, '0') + ':' + String(created.getMinutes()).padStart(2, '0'),
            dueOn: ymd(new Date(TODAY.getTime() + tCat(cat).sla * 3600000)),
            slaHours: tCat(cat).sla, assigneeId: app.meId,
            resolvedOn: null, resolutionHrs: null, breached: false, csat: null, comments: [],
          });
          close();
          app.toast('Ticket raised — you will get an update within ' + tCat(cat).sla + ' hours', 'ok');
          app.bump();
        }}>Raise ticket</button>
      </div>
    </>
  );
}

function useNewTicket() {
  const layer = useLayer();
  return () =>
    layer.modal({
      title: 'Raise a ticket',
      sub: 'Routed automatically to the owning team',
      body: (close) => <NewTicketForm close={close} />,
      footer: null,
    });
}

/* ---------------- My tickets ---------------- */

function HdMy() {
  const app = useApp();
  const show = useShowTicket();
  const raise = useNewTicket();
  const mine = TICKETS.filter((t) => t.empId === app.meId);
  const resolved = mine.filter((t) => t.resolutionHrs);

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={raise}>＋ Raise a ticket</button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>Average first response: 4 h · resolution within SLA 87%</span>
      </div>

      <div className="grid g4">
        <Tile label="My tickets" value={mine.length} foot="All time" />
        <Tile label="Open" value={mine.filter((t) => ['Open', 'In Progress'].includes(t.status)).length} foot="Being worked on" />
        <Tile label="Resolved" value={mine.filter((t) => ['Resolved', 'Closed'].includes(t.status)).length} foot="Closed successfully" />
        <Tile label="Avg resolution"
          value={Math.round(sum(resolved, (t) => t.resolutionHrs!) / Math.max(1, resolved.length)) + ' h'}
          foot="For your tickets" />
      </div>

      <Card title="My tickets" sub={`${mine.length} records`} flush>
        <TicketTable list={mine} onOpen={show} />
      </Card>

      <Card title="Common questions" sub="Might save you a ticket" flush>
        {KB.slice(0, 5).map((k, i) => (
          <ListRow key={i}>
            <span>{tCat(k.cat).ic}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{k.q}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>{tCat(k.cat).n}</div>
            </div>
            <span className="muted">›</span>
          </ListRow>
        ))}
      </Card>
    </div>
  );
}

/* ---------------- Queue ---------------- */

function HdQueue() {
  const app = useApp();
  const show = useShowTicket();
  const [f, setF] = useState('');

  const ids = visibleIds(app.role, app.meId);
  const all = app.role === 'admin' ? TICKETS : TICKETS.filter((t) => t.assigneeId === app.meId || ids.includes(t.empId));
  const list = f ? all.filter((t) => t.status === f) : all;
  const open = all.filter((t) => ['Open', 'In Progress'].includes(t.status));
  const resolved = all.filter((t) => t.resolutionHrs);
  const rated = all.filter((t) => t.csat);
  const byCat = TICKET_CATS.map((c, i) => ({ k: c.n, c: PAL[i % 8], v: all.filter((t) => t.cat === c.id).length })).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="Open tickets" value={open.length} foot={`${all.filter((t) => t.status === 'Open').length} unassigned work`} />
        <Tile label="SLA breached" value={all.filter((t) => t.breached && ['Open', 'In Progress'].includes(t.status)).length} foot="Needs escalation" />
        <Tile label="Resolved this month" value={all.filter((t) => t.resolvedOn && monthKey(t.resolvedOn) === monthKey(TODAY)).length} foot="Closed by the team" />
        <Tile label="Avg resolution" value={Math.round(sum(resolved, (t) => t.resolutionHrs!) / Math.max(1, resolved.length)) + ' h'} foot="Across all categories" />
        <Tile label="CSAT" value={(sum(rated, (t) => t.csat!) / Math.max(1, rated.length)).toFixed(1) + ' / 5'} foot={`${rated.length} rated tickets`} />
      </div>

      <div className="grid g-2-1">
        <Card title="Ticket queue" sub={`${list.length} tickets`} flush
          actions={
            <div className="row">
              <select className="input" style={{ width: 'auto' }} value={f} onChange={(e) => setF(e.target.value)}>
                <option value="">All</option>
                {['Open', 'In Progress', 'Resolved', 'Closed'].map((s) => <option key={s}>{s}</option>)}
              </select>
              <button className="btn sm" onClick={() =>
                downloadCSV('tickets.csv',
                  [['ID', 'Subject', 'Raised by', 'Category', 'Priority', 'Assignee', 'Created', 'Due', 'Status', 'Resolution h', 'Breached']].concat(
                    all.map((t) => [t.id, t.subject, empName(t.empId), tCat(t.cat).n, t.priority,
                      empName(t.assigneeId), t.createdOn, t.dueOn, t.status, String(t.resolutionHrs ?? ''), t.breached ? 'Yes' : 'No']),
                  ))}>⤓</button>
            </div>
          }>
          <div style={{ maxHeight: 600, overflow: 'auto' }}>
            <TicketTable list={list} showEmp onOpen={show} />
          </div>
        </Card>

        <div className="stack">
          <Card title="By category" sub={`${all.length} tickets`}>
            <HBar rows={sortBy(byCat, (r) => -r.v)} />
          </Card>
          <Card title="Ageing" sub="Open tickets by age">
            <HBar rows={AGE_BUCKETS.map((b, i) => ({
              k: b[0], c: ['var(--s6)', 'var(--s1)', 'var(--s4)', 'var(--s8)'][i],
              v: open.filter((t) => {
                const d = daysBetween(t.createdOn, ymd(TODAY));
                return d >= b[1] && d < b[2];
              }).length,
            }))} />
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- SLA & analytics ---------------- */

function HdSla() {
  const all = TICKETS;
  const byCat = TICKET_CATS.map((c) => {
    const ts = all.filter((t) => t.cat === c.id && t.resolutionHrs != null);
    return {
      c, n: all.filter((t) => t.cat === c.id).length,
      avg: ts.length ? Math.round(sum(ts, (t) => t.resolutionHrs!) / ts.length) : 0,
      met: pct(ts.filter((t) => !t.breached).length, Math.max(1, ts.length)),
    };
  }).filter((r) => r.n);

  const months: { k: string; l: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    months.push({ k: monthKey(d), l: MON[d.getMonth()] });
  }
  const raised = months.map((m) => all.filter((t) => monthKey(t.createdOn) === m.k).length);
  const resolved = months.map((m) => all.filter((t) => t.resolvedOn && monthKey(t.resolvedOn) === m.k).length);
  const withRes = all.filter((t) => t.resolutionHrs != null);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="SLA compliance" value={pct(withRes.filter((t) => !t.breached).length, Math.max(1, withRes.length)) + '%'} foot="Target 90%" />
        <Tile label="Total tickets" value={all.length} foot="Last 45 days" />
        <Tile label="Reopen rate" value="5%" foot="Tickets reopened after resolution" />
        <Tile label="Self-service deflection" value="23%" foot="Answered by the knowledge base" />
      </div>

      <Card title="Raised vs resolved" sub="Last 6 months">
        <BarChart labels={months.map((m) => m.l)} height={220}
          series={[
            { name: 'Raised', color: 'var(--s1)', data: raised },
            { name: 'Resolved', color: 'var(--s3)', data: resolved },
          ]} />
        <Legend items={[{ k: 'Raised', c: 'var(--s1)' }, { k: 'Resolved', c: 'var(--s3)' }]} />
      </Card>

      <Card title="SLA by category" sub="Target vs actual resolution time" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Category</th><th>Owning team</th><th className="num">Tickets</th><th className="num">SLA target</th><th className="num">Avg resolution</th><th className="num">SLA met</th></tr>
            </thead>
            <tbody>
              {byCat.map((r) => (
                <tr key={r.c.id}>
                  <td>{r.c.ic} <b>{r.c.n}</b></td>
                  <td>{deptOf(r.c.team).name}</td>
                  <td className="num">{r.n}</td>
                  <td className="num">{r.c.sla} h</td>
                  <td className="num" style={r.avg > r.c.sla ? { color: 'var(--crit)', fontWeight: 700 } : undefined}>{r.avg} h</td>
                  <td className="num"><b>{r.met}%</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Knowledge base ---------------- */

function HdKb() {
  const app = useApp();
  const raise = useNewTicket();
  const [q, setQ] = useState('');
  const list = q ? KB.filter((k) => (k.q + k.a).toLowerCase().includes(q.toLowerCase())) : KB;

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search" style={{ flex: 1, maxWidth: 460 }}>
          <input className="input" placeholder="Search the knowledge base…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="spacer" />
        <button className="btn" onClick={raise}>Still stuck? Raise a ticket</button>
      </div>

      <div className="grid g2">
        {list.map((k, i) => (
          <Card key={i}>
            <div className="row" style={{ gap: 8, marginBottom: 7 }}>
              <Badge kind="info">{tCat(k.cat).ic} {tCat(k.cat).n}</Badge>
            </div>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>{k.q}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{k.a}</div>
            <div className="row" style={{ marginTop: 11, gap: 7 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>Was this helpful?</span>
              <button className="btn sm ghost" onClick={() => app.toast('Thanks for the feedback', 'ok')}>👍</button>
              <button className="btn sm ghost" onClick={() => app.toast('Thanks — we will improve this answer')}>👎</button>
            </div>
          </Card>
        ))}
      </div>

      {!list.length && <Card><EmptyState msg="Nothing matches that search" icon="🔍" /></Card>}
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'my' | 'queue' | 'sla' | 'kb';

function Helpdesk() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'my', label: 'My Tickets' }, { v: 'kb', label: 'Knowledge Base' }]
    : [
        { v: 'queue', label: 'Ticket Queue' }, { v: 'my', label: 'My Tickets' },
        { v: 'sla', label: 'SLA & Analytics' }, { v: 'kb', label: 'Knowledge Base' },
      ];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'my' && <HdMy />}
      {active === 'queue' && <HdQueue />}
      {active === 'sla' && <HdSla />}
      {active === 'kb' && <HdKb />}
    </>
  );
}

registerModule({
  key: 'helpdesk',
  title: TITLES.helpdesk,
  subtitle: () => 'Ticketing with SLAs, plus a self-service knowledge base',
  badge: (c) => TICKETS.filter((t) => t.empId === c.meId && ['Open', 'In Progress'].includes(t.status)).length,
  Component: Helpdesk,
});
