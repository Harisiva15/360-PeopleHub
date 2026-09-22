/**
 * Employee lifecycle.
 *
 * Where everybody stands in their employment, from application to alumni.
 *
 * **There is no "change stage" control, and that is the design.** The stage is
 * derived from the records the product already keeps — an onboarding row says
 * pre-boarding, an exit row says notice, the employee's own status says
 * active. A dropdown here would let somebody set a stage the underlying
 * records contradict, and the summary would start lying about the thing it
 * summarises. Moving somebody happens where the record lives, and the page
 * says which record that is.
 */

import { useState } from 'react';
import { sortBy, uniq } from '../../lib/collections';
import { fmtD, TODAY, ymd } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { DEPTS, SITES, deptOf } from '../../data/org';
import { CORE_PATH, LIFECYCLE_STAGES } from '../../services';
import type {
  LifecycleFilter, LifecycleRow, LifecycleStage, LifecycleTaskDraft,
} from '../../services';
import {
  Avatar, Badge, Banner, Card, EmptyState, KV, StatRow, Tabs, Tile,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useAddTask, useLifecycle, useLifecycleStats, useLifecycleRow, useRemoveTask,
  useSetTaskDone, useVisiblePeople,
} from './data';

const NOW = ymd(TODAY);

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** Four tones over twelve stages: joining, settled, moving, leaving. */
const STAGE_TONE: Record<LifecycleStage, 'good' | 'warn' | 'info' | 'mute' | 'crit'> = {
  Candidate: 'mute', Offer: 'warn', 'Pre-boarding': 'warn', Joined: 'info',
  Onboarding: 'warn', Active: 'good', Promotion: 'info', Transfer: 'info',
  'Leave of Absence': 'warn', Exit: 'crit', Offboarding: 'crit', Alumni: 'mute',
};

const StageBadge = ({ s }: { s: LifecycleStage }) => (
  <Badge kind={STAGE_TONE[s]}>{s}</Badge>
);

/* ---------------- the timeline ---------------- */

/**
 * The journey as a rail of stages.
 *
 * Only the ordinary path is drawn. Promotion, transfer and long leave are
 * things that happen *during* Active rather than after it, so putting them on
 * a line would imply an order employment does not have.
 */
function Journey({ current }: { current: LifecycleStage }) {
  const at = CORE_PATH.indexOf(current);
  /* A stage off the main path sits at Active, which is where it happens. */
  const pos = at >= 0 ? at : CORE_PATH.indexOf('Active');

  return (
    <div className="journey">
      {CORE_PATH.map((s, i) => {
        const state = i < pos ? 'done' : i === pos ? 'now' : 'todo';
        return (
          <div className={'journey-step ' + state} key={s}>
            <span className="journey-dot" aria-hidden="true">
              {state === 'done' ? <Icon n="ok" size="sm" /> : null}
            </span>
            <span className="journey-n">{s}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- the detail ---------------- */

function AddTaskForm({ empId, close }: { empId: string; close: () => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const add = useAddTask();
  const [n, setN] = useState('');
  const [due, setDue] = useState('');
  const [owner, setOwner] = useState('HR');
  const [assigneeId, setAssigneeId] = useState('');
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    const draft: LifecycleTaskDraft = { n, due, owner, assigneeId: assigneeId || null };
    try { await add.mutate(empId, draft); app.toast('Task added', 'ok'); close(); }
    catch (e) { setErr(msg(e, 'Could not add the task')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not added">{err}</Banner>}
      <div className="field">
        <label>What needs doing <span className="req">*</span></label>
        <input className="input" value={n} autoFocus placeholder="Confirm the new band in payroll"
          onChange={(e) => setN(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Due <span className="req">*</span></label>
          <input className="input" type="date" value={due}
            onChange={(e) => setDue(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Owning team</label>
          <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {['HR', 'IT', 'Finance', 'Manager', 'Operations'].map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Assign to</label>
        <select className="input" value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Nobody in particular</option>
          {sortBy(dir.list, (e) => e.name).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={add.pending} onClick={save}>Add task</button>
      </div>
    </div>
  );
}

function LifecycleDetailView({ id }: { id: string }) {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const { data: d, loading, error } = useLifecycleRow(id);
  const setDone = useSetTaskDone();
  const removeTask = useRemoveTask();
  const [tab, setTab] = useState<'journey' | 'tasks' | 'history'>('journey');

  if (error) return <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />;
  if (!d) return <EmptyState msg={loading ? 'Loading…' : 'Nobody by that id'} />;

  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  const open = d.tasks.filter((t) => !t.done);

  return (
    <div className="stack">
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <Avatar name={d.subject.name} size="lg" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 750, fontSize: 16 }}>{d.subject.name}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {d.subject.designation}
            {d.subject.dept && <> · {deptOf(d.subject.dept).name}</>}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <StageBadge s={d.standing.stage} />
            {!d.subject.onPayroll && <Badge kind="mute">Not on payroll yet</Badge>}
          </div>
        </div>
      </div>

      {d.standing.nextAction && (
        <Banner kind="info" icon={<Icon n="next" size="lg" />} title="Next action">
          {d.standing.nextAction}
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'journey' as const, label: 'Journey' },
          { v: 'tasks' as const, label: `Tasks (${open.length})` },
          { v: 'history' as const, label: 'History' },
        ]}
        onChange={setTab}
      />

      {tab === 'journey' && (
        <>
          <Journey current={d.standing.stage} />
          <KV rows={[
            ['Current stage', <StageBadge s={d.standing.stage} />],
            ['In this stage since', fmtD(d.standing.since)],
            ['Days in stage', d.standing.daysInStage],
            ['Manager', d.subject.managerId ? dir.name(d.subject.managerId) : '—'],
            ['Started', fmtD(d.subject.startOn)],
            ['Employee ID', d.subject.code],
          ]} />
          <Banner kind="info" icon={<Icon n="info" size="lg" />} title="How the stage is set">
            It is read from the records themselves — the onboarding checklist, the
            exit record, the employment status. To move somebody, change the record
            rather than the summary.
          </Banner>
        </>
      )}

      {tab === 'tasks' && (
        <>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            {app.role !== 'employee' && (
              <button className="btn sm" onClick={() => layer.modal({
                title: 'Add a lifecycle task',
                sub: d.subject.name,
                size: 'narrow',
                body: (close) => <AddTaskForm empId={id} close={close} />,
                footer: null,
              })}>
                <Icon n="add" size="lg" /> Add task
              </button>
            )}
          </div>
          {d.tasks.length ? (
            <div className="stack">
              {d.tasks.map((t) => (
                <div key={t.id} className={'lc-task' + (t.done ? ' done' : '')}>
                  <input
                    type="checkbox"
                    checked={t.done}
                    aria-label={t.n}
                    onChange={() => act(() => setDone.mutate(t.id, !t.done),
                      t.done ? 'Task reopened' : 'Task completed')}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="lc-task-n">{t.n}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {t.owner}
                      {t.assigneeId && <> · {dir.name(t.assigneeId)}</>}
                      {' · due '}{fmtD(t.due)}
                      {t.doneOn && <> · done {fmtD(t.doneOn)}</>}
                    </div>
                  </div>
                  {!t.done && t.due < NOW && <Badge kind="crit">Overdue</Badge>}
                  {app.role === 'admin' && (
                    <button className="btn ghost icon sm" aria-label={`Remove ${t.n}`}
                      onClick={() => act(() => removeTask.mutate(t.id), 'Task removed')}>
                      <Icon n="remove" size="sm" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={<Icon n="goal" size="xl" />}
              msg="No tasks for this stage" />
          )}
        </>
      )}

      {tab === 'history' && (
        d.events.length ? (
          <div className="tl"><div className="tl-day">
            {d.events.map((e, i) => (
              <div className="tl-row" key={`${e.on}-${i}`}>
                <div className="tl-time mono">{e.on.slice(5)}</div>
                <div className="tl-mark" aria-hidden="true">
                  <i style={{ background: 'var(--brand)' }} />
                </div>
                <div className="tl-body">
                  <div className="tl-k">{e.type}</div>
                  <div className="tl-s">{e.note}</div>
                  {e.to && <div className="tl-who muted">{e.from ? `${e.from} → ` : ''}{e.to}</div>}
                </div>
              </div>
            ))}
          </div></div>
        ) : (
          <EmptyState icon={<Icon n="clock" size="xl" />}
            msg="No employment history yet — this journey has not started" />
        )
      )}
    </div>
  );
}

/* ---------------- the page ---------------- */

function LifecycleView() {
  const layer = useLayer();
  const dir = useVisiblePeople();
  const [f, setF] = useState<LifecycleFilter>({});

  const { data: rows = [], loading, error } = useLifecycle(f);
  const { data: all = [] } = useLifecycle({});
  const { data: stats } = useLifecycleStats();

  if (error) {
    return (
      <Card title="Employee lifecycle">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const openDetail = (r: LifecycleRow) => layer.drawer({
    title: r.subject.name,
    sub: `${r.standing.stage} · ${r.standing.daysInStage} days`,
    body: <LifecycleDetailView id={r.subject.id} />,
  });

  const exportCsv = () => downloadCSV('employee_lifecycle.csv', [
    ['Name', 'Employee ID', 'Stage', 'Department', 'Manager', 'Started',
      'Stage since', 'Days in stage', 'Open tasks', 'Next action'],
    ...rows.map((r) => [
      r.subject.name, r.subject.code, r.standing.stage,
      r.subject.dept ? deptOf(r.subject.dept).name : '—',
      r.subject.managerId ? dir.name(r.subject.managerId) : '—',
      r.subject.startOn, r.standing.since, r.standing.daysInStage,
      r.openTasks, r.standing.nextAction ?? '—',
    ]),
  ]);

  const one = (k: keyof LifecycleFilter) => (v: string) => setF({ ...f, [k]: v || undefined });

  return (
    <div className="stack">
      <PageActions>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          <Icon n="download" size="lg" /> Export
        </button>
      </PageActions>

      <StatRow cols={5}>
        <Tile icon={<Icon n="joiner" size="lg" />} label="Pre-boarding"
          value={stats?.preboarding ?? '—'} foot="Offered, not started" />
        <Tile icon={<Icon n="people" size="lg" />} label="Onboarding"
          value={stats?.onboarding ?? '—'} foot="In their first weeks" />
        <Tile icon={<Icon n="clock" size="lg" />} label="On probation"
          value={stats?.probation ?? '—'} foot="Awaiting confirmation" />
        <Tile icon={<Icon n="swap" size="lg" />} label="Moving"
          value={(stats?.promotions ?? 0) + (stats?.transfers ?? 0)}
          foot="Promoted or transferred" />
        <Tile icon={<Icon n="undo" size="lg" />} label="Leaving"
          value={(stats?.exits ?? 0) + (stats?.offboarding ?? 0)}
          foot="On notice or in clearance" />
      </StatRow>

      <div className="toolbar">
        <div className="gsearch" style={{ width: 240, flex: '0 0 auto' }}>
          <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
          <input className="gsearch-in" type="search" value={f.q ?? ''}
            placeholder="Name or employee ID…" aria-label="Search people"
            onChange={(e) => one('q')(e.target.value)} />
        </div>
        <select className="input sm" value={f.stage ?? ''} aria-label="Stage"
          onChange={(e) => one('stage')(e.target.value)}>
          <option value="">All stages</option>
          {LIFECYCLE_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input sm" value={f.dept ?? ''} aria-label="Department"
          onChange={(e) => one('dept')(e.target.value)}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="input sm" value={f.managerId ?? ''} aria-label="Manager"
          onChange={(e) => one('managerId')(e.target.value)}>
          <option value="">All managers</option>
          {uniq(all.map((r) => r.subject.managerId).filter(Boolean) as string[])
            .map((id) => <option key={id} value={id}>{dir.name(id)}</option>)}
        </select>
        <select className="input sm" value={f.site ?? ''} aria-label="Location"
          onChange={(e) => one('site')(e.target.value)}>
          <option value="">All locations</option>
          {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div className="spacer" />
        {Object.values(f).some(Boolean) && (
          <button className="btn sm" onClick={() => setF({})}>Reset</button>
        )}
      </div>

      <Card title="Everybody, and where they are"
        sub={`${rows.length} of ${all.length} · longest in stage first`} flush>
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Person</th><th>Employee ID</th><th>Stage</th><th>Department</th>
                  <th>Manager</th><th>Since</th><th className="num">Days</th>
                  <th className="num">Open tasks</th><th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.subject.id} className="clickable" onClick={() => openDetail(r)}>
                    <td>
                      <div className="row" style={{ gap: 9, alignItems: 'center' }}>
                        <Avatar name={r.subject.name} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 650, fontSize: 13 }}>{r.subject.name}</div>
                          <div className="muted" style={{ fontSize: 11.5 }}>
                            {r.subject.designation || '—'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="mono nowrap">{r.subject.code}</td>
                    <td><StageBadge s={r.standing.stage} /></td>
                    <td className="nowrap">
                      {r.subject.dept ? deptOf(r.subject.dept).name : '—'}
                    </td>
                    <td className="nowrap">
                      {r.subject.managerId ? dir.name(r.subject.managerId) : '—'}
                    </td>
                    <td className="nowrap">{fmtD(r.standing.since)}</td>
                    <td className="num">{r.standing.daysInStage}</td>
                    <td className="num">{r.openTasks || '—'}</td>
                    <td className="muted" style={{ maxWidth: 240, fontSize: 12 }}>
                      {r.standing.nextAction ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Icon n="people" size="xl" />}
            msg={loading ? 'Loading the journey…' : 'Nobody matches this filter'}
          />
        )}
      </Card>
    </div>
  );
}

registerModule({
  key: 'lifecycle',
  title: TITLES.lifecycle,
  Component: LifecycleView,
});

export { LifecycleView };
