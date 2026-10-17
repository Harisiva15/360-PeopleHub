import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { daysBetween, fmtD, MON, monthKey, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';

import { TICKET_CATS, tCat } from '../../data/helpdesk';
import type { Ticket } from '../../services';
import { deptOf } from '../../data/org';
import { Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile, StatRow } from '../../components/ui';
import { notBacked } from '../../components/NotBacked';
import { Divide, ListRow } from '../../components/common';
import { BarChart, HBar, Legend, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useCommentOnTicket, useCreateArticle, useKnowledgeBase, useRaiseTicket,
  useRemoveArticle, useResolveTicket, useTickets, useUpdateArticle, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import type { KbArticle, KbDraft } from '../../services';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { Icon } from '../../components/icons';

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

function TicketTable(
  { list, dir, showEmp, onOpen }:
  { list: Ticket[]; dir: Directory; showEmp?: boolean; onOpen: (t: Ticket) => void },
) {
  if (!list.length) return <EmptyState msg="No tickets here" icon={<Icon n="ticket" size="lg" />} />;
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
              {showEmp && <td><PersonCell e={dir.byId(t.empId)!} /></td>}
              <td className="nowrap"><Icon n={tCat(t.cat).ic} /> {tCat(t.cat).n}</td>
              <td><PrioBadge p={t.priority} /></td>
              <td className="nowrap">{dir.name(t.assigneeId)}</td>
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
  const dir = useVisiblePeople();
  const commentOn = useCommentOnTicket();
  const resolveTicket = useResolveTicket();
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
          ['Raised by', dir.name(t.empId)],
          ['Assigned to', `${dir.name(t.assigneeId)} · ${deptOf(tCat(t.cat).team).name}`],
          ['Created', `${fmtD(t.createdOn)} at ${t.createdTime}`],
          ['Due by', fmtD(t.dueOn)],
          ...(t.resolvedOn ? [['Resolved', `${fmtD(t.resolvedOn)} · took ${t.resolutionHrs} h`]] as [string, string][] : []),
          ...(t.csat ? [['Satisfaction', '★'.repeat(t.csat) + '☆'.repeat(5 - t.csat)]] as [string, string][] : []),
        ]} />
      </div>

      <Banner icon={<Icon n="helpdesk" size="lg" />}>{t.desc}</Banner>

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
        <button className="btn" onClick={async () => {
          const v = reply.trim();
          if (!v) {
            app.toast('Write something first', 'err');
            return;
          }
          try {
            await commentOn.mutate(t.id, app.me.name, v);
            close();
            app.toast('Reply posted', 'ok');
          } catch (e) {
            app.toast(e instanceof Error ? e.message : 'Could not post the reply', 'err');
          }
        }}>Post reply</button>
        {(app.role === 'admin' || t.assigneeId === app.meId) && t.status !== 'Closed' && (
          <button className="btn primary" onClick={async () => {
            try {
              await resolveTicket.mutate(t.id);
              close();
              app.toast('Ticket marked resolved', 'ok');
            } catch (e) {
              app.toast(e instanceof Error ? e.message : 'Could not resolve the ticket', 'err');
            }
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
  const raiseTicket = useRaiseTicket();
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
            {TICKET_CATS.map((c) => <option key={c.id} value={c.id}>{c.n} — {c.sla} h SLA</option>)}
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
      <Banner kind="info" icon={<Icon n="timer" size="lg" />}>
        {tCat(cat).n} tickets are handled by {deptOf(tCat(cat).team).name} with a {tCat(cat).sla}-hour resolution target.
      </Banner>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!subject.trim()} onClick={async () => {
          try {
            await raiseTicket.mutate({
              empId: app.meId, cat, subject,
              desc: desc || 'Raised via employee self-service.',
              priority,
            });
            close();
            app.toast('Ticket raised — you will get an update within ' + tCat(cat).sla + ' hours', 'ok');
          } catch (e) {
            app.toast(e instanceof Error ? e.message : 'Could not raise the ticket', 'err');
          }
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
  const { data: TICKETS = [] } = useTickets();
  const { data: KB = [] } = useKnowledgeBase();
  const dir = useVisiblePeople();
  const app = useApp();
  const show = useShowTicket();
  const raise = useNewTicket();
  const mine = TICKETS.filter((t) => t.empId === app.meId);
  const resolved = mine.filter((t) => t.resolutionHrs);

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={raise}><Icon n="add" size="lg" /> Raise a ticket</button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>Average first response: 4 h · resolution within SLA 87%</span>
      </div>

      <StatRow cols={4}>
        <Tile label="My tickets" value={mine.length} foot="All time" />
        <Tile label="Open" value={mine.filter((t) => ['Open', 'In Progress'].includes(t.status)).length} foot="Being worked on" />
        <Tile label="Resolved" value={mine.filter((t) => ['Resolved', 'Closed'].includes(t.status)).length} foot="Closed successfully" />
        <Tile label="Avg resolution"
          value={Math.round(sum(resolved, (t) => t.resolutionHrs!) / Math.max(1, resolved.length)) + ' h'}
          foot="For your tickets" />
      </StatRow>

      <Card title="My tickets" sub={`${mine.length} records`} flush>
        <TicketTable list={mine} dir={dir} onOpen={show} />
      </Card>

      <Card title="Common questions" sub="Might save you a ticket" flush>
        {KB.slice(0, 5).map((k, i) => (
          <ListRow key={i}>
            <Icon n={tCat(k.cat).ic} />
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
  const { data: TICKETS = [] } = useTickets();
  const dir = useVisiblePeople();
  const app = useApp();
  const show = useShowTicket();
  const [f, setF] = useState('');

  const all = app.role === 'admin'
    ? TICKETS
    : TICKETS.filter((t) => t.assigneeId === app.meId || dir.ids.includes(t.empId));
  const list = f ? all.filter((t) => t.status === f) : all;
  const open = all.filter((t) => ['Open', 'In Progress'].includes(t.status));
  const resolved = all.filter((t) => t.resolutionHrs);
  const rated = all.filter((t) => t.csat);
  const byCat = TICKET_CATS.map((c, i) => ({ k: c.n, c: PAL[i % 8], v: all.filter((t) => t.cat === c.id).length })).filter((r) => r.v);

  return (
    <div className="stack">
      <StatRow cols={5}>
        <Tile label="Open tickets" value={open.length} foot={`${all.filter((t) => t.status === 'Open').length} unassigned work`} />
        <Tile label="SLA breached" value={all.filter((t) => t.breached && ['Open', 'In Progress'].includes(t.status)).length} foot="Needs escalation" />
        <Tile label="Resolved this month" value={all.filter((t) => t.resolvedOn && monthKey(t.resolvedOn) === monthKey(TODAY)).length} foot="Closed by the team" />
        <Tile label="Avg resolution" value={Math.round(sum(resolved, (t) => t.resolutionHrs!) / Math.max(1, resolved.length)) + ' h'} foot="Across all categories" />
        <Tile label="CSAT" value={(sum(rated, (t) => t.csat!) / Math.max(1, rated.length)).toFixed(1) + ' / 5'} foot={`${rated.length} rated tickets`} />
      </StatRow>

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
                    all.map((t) => [t.id, t.subject, dir.name(t.empId), tCat(t.cat).n, t.priority,
                      dir.name(t.assigneeId), t.createdOn, t.dueOn, t.status, String(t.resolutionHrs ?? ''), t.breached ? 'Yes' : 'No']),
                  ))}>⤓</button>
            </div>
          }>
          <div style={{ maxHeight: 600, overflow: 'auto' }}>
            <TicketTable list={list} dir={dir} showEmp onOpen={show} />
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
  const { data: TICKETS = [] } = useTickets();
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
      <StatRow cols={4}>
        <Tile label="SLA compliance" value={pct(withRes.filter((t) => !t.breached).length, Math.max(1, withRes.length)) + '%'} foot="Target 90%" />
        <Tile label="Total tickets" value={all.length} foot="Last 45 days" />
        <Tile label="Reopen rate" value="5%" foot="Tickets reopened after resolution" />
        <Tile label="Self-service deflection" value="23%" foot="Answered by the knowledge base" />
      </StatRow>

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
                  <td><Icon n={r.c.ic} /> <b>{r.c.n}</b></td>
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

/**
 * The article editor.
 *
 * Uncontrolled inputs writing through `onChange` into the caller's draft, the
 * same shape the other modals in this product use — the dialog owns the draft
 * so the footer's Save can read it without lifting state through the layer.
 */
function ArticleForm({ initial, onChange }: {
  initial: KbDraft;
  onChange: (v: KbDraft) => void;
}) {
  const [v, setV] = useState<KbDraft>(initial);
  const set = (patch: Partial<KbDraft>) => {
    const next = { ...v, ...patch };
    setV(next);
    onChange(next);
  };

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="kb-cat">Category</label>
        <select id="kb-cat" className="input" value={v.cat ?? ''}
          onChange={(e) => set({ cat: e.target.value || null })}>
          <option value="">Uncategorised</option>
          {TICKET_CATS.map((c) => <option key={c.id} value={c.id}>{c.n}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="kb-q">Question</label>
        <input id="kb-q" className="input" value={v.q} maxLength={300}
          placeholder="What someone would actually ask"
          onChange={(e) => set({ q: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="kb-a">Answer</label>
        <textarea id="kb-a" className="input" style={{ minHeight: 160 }} value={v.a}
          placeholder="The answer, and where to go next"
          onChange={(e) => set({ a: e.target.value })} />
      </div>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={v.published ?? true}
          onChange={(e) => set({ published: e.target.checked })} />
        <span>Published — visible to everyone. Clear this to keep it a draft.</span>
      </label>
    </div>
  );
}

/**
 * The company's policies and how-to answers.
 *
 * This was read-only, over a service that returned a literal empty list — so
 * the policy library could neither show a policy nor be given one. It reads
 * `kb_article` now, and an administrator or a manager can write to it.
 *
 * Authoring is gated twice on purpose. The service refuses anyone else outright;
 * this hides the controls, because offering a button that will be refused is a
 * worse way to learn your role than not being offered it.
 */
function HdKb() {
  const app = useApp();
  const layer = useLayer();
  const { data: KB = [], refetch } = useKnowledgeBase();
  const raise = useNewTicket();
  const create = useCreateArticle();
  const update = useUpdateArticle();
  const remove = useRemoveArticle();
  const [q, setQ] = useState('');
  const list = q ? KB.filter((k) => (k.q + k.a).toLowerCase().includes(q.toLowerCase())) : KB;

  const mayEdit = app.role === 'admin' || app.role === 'manager';

  const edit = (existing?: KbArticle) => {
    let draft: KbDraft = {
      cat: existing?.cat ?? '', q: existing?.q ?? '', a: existing?.a ?? '',
      published: existing?.published ?? true,
    };
    layer.modal({
      title: existing ? 'Edit article' : 'New article',
      size: 'wide',
      body: <ArticleForm initial={draft} onChange={(v) => { draft = v; }} />,
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            if (!draft.q.trim() || !draft.a.trim()) {
              app.toast('An article needs a question and an answer', 'err');
              return;
            }
            try {
              if (existing) await update.mutate(existing.id, draft);
              else await create.mutate(draft);
              close();
              refetch();
              app.toast(existing ? 'Article updated' : 'Article published', 'ok');
            } catch (e) {
              app.toast(e instanceof Error ? e.message : 'Could not save the article', 'err');
            }
          }}>{existing ? 'Save' : 'Publish'}</button>
        </>
      ),
    });
  };

  const del = (k: KbArticle) => layer.modal({
    title: 'Remove this article?',
    size: 'narrow',
    body: (
      <div className="stack">
        <div style={{ fontWeight: 650 }}>{k.q}</div>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          This removes the article for everyone and cannot be undone. If you only
          want it out of sight while you rework it, edit it and clear
          “Published” instead.
        </div>
      </div>
    ),
    footer: (close) => (
      <>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn danger" onClick={async () => {
          try {
            await remove.mutate(k.id);
            close();
            refetch();
            app.toast('Article removed', 'ok');
          } catch (e) {
            app.toast(e instanceof Error ? e.message : 'Could not remove the article', 'err');
          }
        }}>Remove</button>
      </>
    ),
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search" style={{ flex: 1, maxWidth: 460 }}>
          <input className="input" placeholder="Search the knowledge base…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="spacer" />
        {mayEdit && <button className="btn primary" onClick={() => edit()}>New article</button>}
        <button className="btn" onClick={raise}>Still stuck? Raise a ticket</button>
      </div>

      <div className="grid g2">
        {list.map((k, i) => (
          <Card key={k.id || i}>
            <div className="row" style={{ gap: 8, marginBottom: 7 }}>
              <Badge kind="info"><Icon n={tCat(k.cat).ic} size="sm" /> {tCat(k.cat).n}</Badge>
              {!k.published && <Badge kind="warn">Draft — not visible to employees</Badge>}
              <div className="spacer" />
              {mayEdit && (
                <>
                  <button className="btn sm ghost" onClick={() => edit(k)}>Edit</button>
                  <button className="btn sm ghost" onClick={() => del(k)}>Remove</button>
                </>
              )}
            </div>
            <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 6 }}>{k.q}</div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{k.a}</div>
            <div className="row" style={{ marginTop: 11, gap: 7 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>Was this helpful?</span>
              {/* Nothing records article feedback yet, so neither button claims it does. */}
              <button className="btn sm ghost" {...notBacked('article feedback is not collected yet')}><Icon n="thumbsUp" size="sm" /></button>
              <button className="btn sm ghost" {...notBacked('article feedback is not collected yet')}><Icon n="thumbsDown" size="sm" /></button>
            </div>
          </Card>
        ))}
      </div>

      {!list.length && (
        <Card>
          <EmptyState
            msg={q
              ? 'Nothing matches that search'
              : mayEdit
                ? 'No articles yet — publish the first one'
                : 'No articles have been published yet'}
            icon={<Icon n={q ? 'search' : 'policy'} size="lg" />}
          />
        </Card>
      )}
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

  const [tab, setTab] = useTabFromUrl<Tab>(tabs[0]!.v, tabs.map((t) => t.v));
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
  Component: Helpdesk,
});
