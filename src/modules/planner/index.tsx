/**
 * The project planner: a board, an iteration view, and the action tracker.
 *
 * The board moves cards with two buttons rather than drag-and-drop. Dragging
 * is the expected gesture and it is also the one that does not work on a
 * phone, does not work with a keyboard, and is announced by a screen reader as
 * nothing at all. Buttons move the same card through the same API call, and
 * the ordering arithmetic behind them is the part that took the care.
 */

import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { PROJECTS, projOf } from '../../data/org';
import type { WorkItem } from '../../services';
import { Avatar, Badge, Banner, Card, EmptyState, KV, Tabs, Tile, StatRow } from '../../components/ui';
import { ListRow } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useAllEmployees, useBoard, useCommentOnItem, useCreateItem, useCreateIteration,
  useItems, useIterations, useMoveItem, useMyItems, useUpdateItem, useVisiblePeople,
} from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

/** The columns a card travels through, in order. */
const COLUMNS = [
  { id: 'backlog', n: 'Backlog' },
  { id: 'todo', n: 'To do' },
  { id: 'in_progress', n: 'In progress' },
  { id: 'review', n: 'Review' },
  { id: 'blocked', n: 'Blocked' },
  { id: 'done', n: 'Done' },
];

const KIND_BADGE: Record<string, { kind: 'good' | 'info' | 'warn' | 'crit' | 'mute'; n: string }> = {
  epic: { kind: 'info', n: 'Epic' },
  story: { kind: 'good', n: 'Story' },
  task: { kind: 'mute', n: 'Task' },
  bug: { kind: 'crit', n: 'Bug' },
  action: { kind: 'warn', n: 'Action' },
};

const PRIORITY_BADGE: Record<string, 'good' | 'info' | 'warn' | 'crit' | 'mute'> = {
  urgent: 'crit', high: 'warn', medium: 'info', low: 'mute',
};

/** Overdue is a fact about today, so it is computed on render, never stored. */
const isOverdue = (w: WorkItem) =>
  Boolean(w.due) && w.due! < ymd(TODAY) && !['done', 'cancelled'].includes(w.status);

/* ---------------- the card ---------------- */

function ItemCard({ item, onOpen, onMove }: {
  item: WorkItem;
  onOpen: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const dir = useVisiblePeople();
  const at = COLUMNS.findIndex((c) => c.id === item.status);

  return (
    <div className="wi-card">
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <Badge kind={KIND_BADGE[item.kind]?.kind ?? 'mute'}>
          {KIND_BADGE[item.kind]?.n ?? item.kind}
        </Badge>
        <span className="muted mono" style={{ fontSize: 11 }}>{item.ref}</span>
        <div className="spacer" />
        <Badge kind={PRIORITY_BADGE[item.priority] ?? 'mute'}>{item.priority}</Badge>
      </div>

      <button className="wi-title" onClick={onOpen}>{item.title}</button>

      <div className="row" style={{ gap: 7, alignItems: 'center', marginTop: 8 }}>
        {item.assigneeId
          ? <Avatar name={dir.name(item.assigneeId)} size="sm" />
          : <span className="muted" style={{ fontSize: 11.5 }}>Unassigned</span>}
        {item.due && (
          <span className={'wi-due' + (isOverdue(item) ? ' over' : '')}>
            {isOverdue(item) ? '⚠ ' : ''}{fmtD(item.due)}
          </span>
        )}
        {item.estimate ? <span className="muted" style={{ fontSize: 11.5 }}>{item.estimate}h</span> : null}
        <div className="spacer" />
        <div className="wi-move">
          <button className="btn sm ghost" disabled={at <= 0}
            title="Move back a column" onClick={() => onMove(-1)}>‹</button>
          <button className="btn sm ghost" disabled={at < 0 || at >= COLUMNS.length - 1}
            title="Move on a column" onClick={() => onMove(1)}>›</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- new item ---------------- */

function NewItemForm({ close, fixedKind }: { close: () => void; fixedKind?: string }) {
  const app = useApp();
  const create = useCreateItem();
  const { data: everyone = [] } = useAllEmployees();
  const { data: iterations = [] } = useIterations();
  const isAction = fixedKind === 'action';

  const [d, setD] = useState({
    title: '', kind: fixedKind ?? 'task', projectId: '', iterationId: '',
    assigneeId: '', priority: 'medium', due: '', estimate: '', desc: '', source: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof d, v: string) => setD((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!d.title.trim()) return setError('Give it a title');
    setBusy(true);
    setError(null);
    try {
      await create.mutate({
        title: d.title.trim(),
        kind: d.kind,
        ...(d.projectId ? { projectId: d.projectId } : {}),
        ...(d.iterationId ? { iterationId: d.iterationId } : {}),
        ...(d.assigneeId ? { assigneeId: d.assigneeId } : {}),
        priority: d.priority,
        ...(d.due ? { due: d.due } : {}),
        ...(d.estimate ? { estimate: Number(d.estimate) } : {}),
        ...(d.desc ? { desc: d.desc } : {}),
        ...(d.source ? { source: d.source } : {}),
      });
      app.toast(isAction ? 'Action item raised' : 'Work item raised', 'ok');
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not raise it');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="field">
        <label htmlFor="wi-title">Title</label>
        <input id="wi-title" className="input" autoFocus value={d.title}
          onChange={(e) => set('title', e.target.value)} />
      </div>

      <div className="grid g2" style={{ gap: '0 14px' }}>
        {!fixedKind && (
          <div className="field">
            <label htmlFor="wi-kind">Type</label>
            <select id="wi-kind" className="input" value={d.kind} onChange={(e) => set('kind', e.target.value)}>
              {['epic', 'story', 'task', 'bug'].map((k) => (
                <option key={k} value={k}>{KIND_BADGE[k]?.n ?? k}</option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="wi-pri">Priority</label>
          <select id="wi-pri" className="input" value={d.priority} onChange={(e) => set('priority', e.target.value)}>
            {['urgent', 'high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {isAction ? (
          <div className="field">
            <label htmlFor="wi-src">Where it came from</label>
            <input id="wi-src" className="input" placeholder="Management meeting, 17 Sep"
              value={d.source} onChange={(e) => set('source', e.target.value)} />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="wi-proj">Project</label>
            <select id="wi-proj" className="input" value={d.projectId}
              onChange={(e) => set('projectId', e.target.value)}>
              <option value="">—</option>
              {PROJECTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="wi-owner">Owner</label>
          <select id="wi-owner" className="input" value={d.assigneeId}
            onChange={(e) => set('assigneeId', e.target.value)}>
            <option value="">Unassigned</option>
            {sortBy(everyone, (e) => e.name).map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="wi-due">Due</label>
          <input id="wi-due" type="date" className="input" value={d.due}
            onChange={(e) => set('due', e.target.value)} />
        </div>

        {!isAction && (
          <>
            <div className="field">
              <label htmlFor="wi-est">Estimate (hours)</label>
              <input id="wi-est" type="number" className="input" value={d.estimate}
                onChange={(e) => set('estimate', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="wi-it">Iteration</label>
              <select id="wi-it" className="input" value={d.iterationId}
                onChange={(e) => set('iterationId', e.target.value)}>
                <option value="">Backlog — no iteration</option>
                {iterations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </div>
          </>
        )}
      </div>

      <div className="field">
        <label htmlFor="wi-desc">Detail</label>
        <textarea id="wi-desc" className="input" value={d.desc}
          onChange={(e) => set('desc', e.target.value)} />
      </div>

      {error && <div className="login-msg err" role="alert">{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 8 }}>
        <button className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Raise it'}
        </button>
      </div>
    </>
  );
}

/* ---------------- detail ---------------- */

function useItemDetail() {
  const layer = useLayer();
  const dir = useVisiblePeople();
  const comment = useCommentOnItem();
  const update = useUpdateItem();
  const app = useApp();

  return (w: WorkItem) => layer.modal({
    title: w.title,
    sub: `${w.ref} · ${KIND_BADGE[w.kind]?.n ?? w.kind}${w.project ? ` · ${projOf(w.project).name}` : ''}`,
    size: 'wide',
    body: (
      <>
        <KV rows={[
          ['Status', <Badge kind={w.status === 'done' ? 'good' : 'info'}>{w.status.replace('_', ' ')}</Badge>],
          ['Priority', <Badge kind={PRIORITY_BADGE[w.priority] ?? 'mute'}>{w.priority}</Badge>],
          ['Owner', w.assigneeId ? dir.name(w.assigneeId) : 'Unassigned'],
          ['Due', w.due ? fmtD(w.due) + (isOverdue(w) ? ' — overdue' : '') : '—'],
          ...(w.estimate ? [['Estimate', w.estimate + ' hours'] as [string, string]] : []),
          ...(w.iteration ? [['Iteration', w.iteration] as [string, string]] : []),
          ...(w.source ? [['Raised in', w.source] as [string, string]] : []),
          ...(w.closedOn ? [['Closed', fmtD(w.closedOn)] as [string, string]] : []),
        ]} />
        {w.desc && <p className="muted" style={{ lineHeight: 1.6 }}>{w.desc}</p>}

        <div className="divide" />
        <div className="lb" style={{ marginBottom: 8 }}>Comments</div>
        {w.comments.length
          ? w.comments.map((c, i) => (
            <ListRow key={i}>
              <Avatar name={c.by} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{c.text}</div>
                <div className="muted" style={{ fontSize: 11 }}>{c.by} · {fmtD(c.on)}</div>
              </div>
            </ListRow>
          ))
          : <div className="muted" style={{ fontSize: 12.5 }}>Nothing yet.</div>}

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <input className="input" id="wi-comment" placeholder="Add a comment…" />
          <button className="btn" onClick={() => {
            const el = document.getElementById('wi-comment') as HTMLInputElement | null;
            if (!el?.value.trim()) return;
            void comment.mutate(w.id, el.value).then(() => {
              el.value = '';
              app.toast('Comment added', 'ok');
              layer.close();
            });
          }}>Comment</button>
        </div>
      </>
    ),
    footer: (close) => (
      <>
        <button className="btn" onClick={close}>Close</button>
        {!['done', 'cancelled'].includes(w.status) && (
          <button className="btn primary" onClick={() => {
            void update.mutate(w.id, { priority: w.priority === 'urgent' ? 'high' : 'urgent' });
            app.toast('Priority changed', 'ok');
            close();
          }}>
            {w.priority === 'urgent' ? 'Lower priority' : 'Mark urgent'}
          </button>
        )}
      </>
    ),
  });
}

/* ---------------- the board ---------------- */

function PlannerBoard() {
  const app = useApp();
  const layer = useLayer();
  const [project, setProject] = useState('');
  const { data: items = [] } = useItems({ ...(project ? { projectId: project } : {}) });
  const { data: stats = [] } = useBoard(project || undefined);
  const move = useMoveItem();
  const detail = useItemDetail();

  /* Actions live in their own tab; the board is the delivery work. */
  const cards = items.filter((w) => w.kind !== 'action');

  const shift = (w: WorkItem, dir: -1 | 1) => {
    const at = COLUMNS.findIndex((c) => c.id === w.status);
    const to = COLUMNS[at + dir];
    if (!to) return;
    void move.mutate(w.id, to.id, null);
    app.toast(`${w.ref} → ${to.n}`, 'ok');
  };

  const openNew = () => layer.modal({
    title: 'New work item', sub: 'It lands in the backlog',
    body: (close) => <NewItemForm close={close} />, footer: null,
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={project}
          onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {PROJECTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn primary" onClick={openNew}>＋ New item</button>
      </div>

      <div className="board">
        {COLUMNS.map((col) => {
          const inCol = cards.filter((w) => w.status === col.id);
          const st = stats.find((x) => x.status === col.id);
          return (
            <section key={col.id} className="board-col">
              <header className="board-head">
                <span className="board-name">{col.n}</span>
                <span className="board-count">{inCol.length}</span>
                {st && st.estimate > 0 && <span className="board-est">{st.estimate}h</span>}
              </header>
              <div className="board-body">
                {inCol.length
                  ? inCol.map((w) => (
                    <ItemCard key={w.id} item={w} onOpen={() => detail(w)}
                      onMove={(dir) => shift(w, dir)} />
                  ))
                  : <div className="board-empty">Nothing here</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- action items ---------------- */

function ActionTracker() {
  const layer = useLayer();
  const app = useApp();
  const dir = useVisiblePeople();
  const { data: actions = [] } = useItems({ kind: 'action' });
  const move = useMoveItem();
  const detail = useItemDetail();

  const open = actions.filter((a) => !['done', 'cancelled'].includes(a.status));
  const overdue = open.filter(isOverdue);
  const closed = actions.filter((a) => a.status === 'done');

  return (
    <div className="stack">
      <Banner kind={overdue.length ? 'warn' : 'info'} icon={overdue.length ? '⚠' : 'ℹ'}
        title={overdue.length ? `${overdue.length} action item(s) past their date` : 'Action items'}>
        Items raised in meetings, reviews and audits. They belong to a person and a date rather
        than a project, which is why they sit outside the board.
      </Banner>

      <StatRow cols={4}>
        <Tile tone="blue" icon="📋" label="Open" value={open.length} foot="Still to close out" />
        <Tile tone="rose" icon="⚠" label="Overdue" value={overdue.length}
          foot={overdue.length ? 'Past the agreed date' : 'Nothing late'} />
        <Tile tone="amber" icon="⏳" label="Due this week" value={
          open.filter((a) => a.due && a.due >= ymd(TODAY) && a.due <= ymd(addDays(TODAY, 7))).length
        } foot="Next seven days" />
        <Tile tone="green" icon="✓" label="Closed" value={closed.length} foot="Done" />
      </StatRow>

      <Card title="Open actions" sub={`${open.length} outstanding`} flush
        actions={<button className="btn sm primary" onClick={() => layer.modal({
          title: 'New action item', sub: 'From a meeting, review or audit',
          body: (close) => <NewItemForm close={close} fixedKind="action" />, footer: null,
        })}>＋ Raise an action</button>}>
        {open.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Ref</th><th>Action</th><th>Owner</th><th>Raised in</th>
                  <th>Due</th><th>Status</th><th className="right">Close</th>
                </tr>
              </thead>
              <tbody>
                {sortBy(open, (a) => a.due ?? '9999').map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => detail(a)}>
                    <td className="mono muted">{a.ref}</td>
                    <td><b>{a.title}</b></td>
                    <td>{a.assigneeId ? dir.name(a.assigneeId) : <span className="muted">Unassigned</span>}</td>
                    <td className="muted">{a.source || '—'}</td>
                    <td className={isOverdue(a) ? 'nowrap' : 'nowrap muted'}>
                      {a.due ? <>{isOverdue(a) && '⚠ '}{fmtD(a.due)}</> : '—'}
                    </td>
                    <td><Badge kind={a.status === 'blocked' ? 'crit' : 'info'}>
                      {a.status.replace('_', ' ')}
                    </Badge></td>
                    <td className="right">
                      <button className="btn sm" onClick={(ev) => {
                        ev.stopPropagation();
                        void move.mutate(a.id, 'done', null);
                        app.toast(`${a.ref} closed`, 'ok');
                      }}>Close</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="Nothing outstanding 🎯" />}
      </Card>

      {closed.length > 0 && (
        <Card title="Closed" sub={`${closed.length} done`} flush>
          {sortBy(closed, (a) => a.closedOn ?? '', 'desc').slice(0, 15).map((a) => (
            <ListRow key={a.id} onClick={() => detail(a)}>
              <Badge kind="good">✓</Badge>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{a.title}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {a.source || 'No source'} · closed {a.closedOn ? fmtD(a.closedOn) : '—'}
                </div>
              </div>
            </ListRow>
          ))}
        </Card>
      )}
    </div>
  );
}

/* ---------------- my work ---------------- */

function MyWork() {
  const app = useApp();
  const { data: mine = [] } = useMyItems(app.me.id);
  const detail = useItemDetail();

  return (
    <div className="stack">
      <Card title="Assigned to me" sub={`${mine.length} open · soonest first`} flush>
        {mine.length ? mine.map((w) => (
          <ListRow key={w.id} onClick={() => detail(w)}>
            <Badge kind={KIND_BADGE[w.kind]?.kind ?? 'mute'}>{KIND_BADGE[w.kind]?.n ?? w.kind}</Badge>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{w.title}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {w.ref}
                {w.project ? ` · ${projOf(w.project).name}` : ''}
                {w.source ? ` · ${w.source}` : ''}
              </div>
            </div>
            {w.due && (
              <span className={isOverdue(w) ? 'wi-due over' : 'wi-due'}>
                {isOverdue(w) ? '⚠ ' : ''}{fmtD(w.due)}
              </span>
            )}
            <Badge kind={PRIORITY_BADGE[w.priority] ?? 'mute'}>{w.priority}</Badge>
          </ListRow>
        )) : <EmptyState msg="Nothing assigned to you 🎉" />}
      </Card>
    </div>
  );
}

/* ---------------- iterations ---------------- */

function Iterations() {
  const app = useApp();
  const layer = useLayer();
  const { data: iterations = [] } = useIterations();
  const { data: items = [] } = useItems({});
  const create = useCreateIteration();

  const openNew = () => layer.modal({
    title: 'Plan an iteration',
    body: (close) => {
      let name = '';
      let goal = '';
      let from = ymd(TODAY);
      let to = ymd(addDays(TODAY, 13));
      return (
        <>
          <div className="field">
            <label htmlFor="it-n">Name</label>
            <input id="it-n" className="input" autoFocus placeholder="Sprint 15"
              onChange={(e) => { name = e.target.value; }} />
          </div>
          <div className="field">
            <label htmlFor="it-g">Goal</label>
            <input id="it-g" className="input" onChange={(e) => { goal = e.target.value; }} />
          </div>
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <div className="field">
              <label htmlFor="it-f">Starts</label>
              <input id="it-f" type="date" className="input" defaultValue={from}
                onChange={(e) => { from = e.target.value; }} />
            </div>
            <div className="field">
              <label htmlFor="it-t">Ends</label>
              <input id="it-t" type="date" className="input" defaultValue={to}
                onChange={(e) => { to = e.target.value; }} />
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" onClick={() => {
              void create.mutate({ name, goal, from, to })
                .then(() => { app.toast('Iteration planned', 'ok'); close(); })
                .catch((e: Error) => app.toast(e.message, 'err'));
            }}>Plan it</button>
          </div>
        </>
      );
    },
    footer: null,
  });

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn primary" onClick={openNew}>＋ Plan an iteration</button>
      </div>

      {iterations.length ? (
        <div className="grid g2">
          {iterations.map((it) => {
            const inIt = items.filter((w) => w.iterationId === it.id);
            const done = inIt.filter((w) => w.status === 'done');
            return (
              <Card key={it.id} title={it.name}
                sub={`${fmtD(it.from)} – ${fmtD(it.to)}`}>
                {it.goal && <p className="muted" style={{ marginTop: 0 }}>{it.goal}</p>}
                <KV rows={[
                  ['Status', <Badge kind={it.status === 'active' ? 'good' : 'mute'}>{it.status}</Badge>],
                  ['Items', `${done.length} of ${inIt.length} done`],
                  ['Effort', sum(inIt, (w) => w.estimate ?? 0) + ' hours planned'],
                ]} />
              </Card>
            );
          })}
        </div>
      ) : <EmptyState msg="No iterations planned yet" />}
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'board' | 'actions' | 'mine' | 'iterations';

const TABS: { v: Tab; label: string }[] = [
  { v: 'board', label: 'Board' },
  { v: 'actions', label: 'Action Items' },
  { v: 'mine', label: 'My Work' },
  { v: 'iterations', label: 'Iterations' },
];

function Planner() {
  const [tab, setTab] = useState<Tab>('board');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'board' && <PlannerBoard />}
      {tab === 'actions' && <ActionTracker />}
      {tab === 'mine' && <MyWork />}
      {tab === 'iterations' && <Iterations />}
    </>
  );
}

registerModule({
  key: 'planner',
  title: TITLES.planner,
  Component: Planner,
});
