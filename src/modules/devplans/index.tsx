/**
 * Development plans.
 *
 * Three things this screen is careful about.
 *
 * The employee owns the document. They write it and they tick it off; the
 * manager endorses it and is held to the review date. So the same page shows a
 * different set of controls depending on whose plan you are looking at, and a
 * manager never gets an edit button on somebody else's aspiration.
 *
 * An action that names a course shows a progress bar it did not compute — the
 * figure comes from the enrolment in Learning, and the row says so rather than
 * offering a tick box that would put two screens into disagreement.
 *
 * Coverage counts endorsed plans only. A draft nobody signed is a wish, and
 * counting wishes is how a development programme reports ninety per cent and
 * changes nothing.
 */

import { useState } from 'react';
import { sortBy, uniq } from '../../lib/collections';
import { fmtD } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { DEPTS, deptOf } from '../../data/org';
import { COURSES } from '../../data/learning';
import { ACTION_KINDS, DEV_AREAS, HORIZONS, JOB_LEVELS } from '../../services';
import type {
  ActionKind, DevActionDraft, DevActionRow, DevArea, DevPlanDetail,
  DevPlanDraft, DevPlanFilter, DevPlanRow, Horizon, JobLevel, PlanStatus,
} from '../../services';
import {
  Avatar, Badge, Banner, Bar, Card, EmptyState, KV, StatRow, Tabs, Tile,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import {
  useAddAction, useCreateDevPlan, useDevFocus, useDevPlan, useDevPlans, useDevStats,
  useEndorsePlan, useMentorLoad, useMentorOptions, useMyDevPlan, useRemoveAction,
  useSetActionDone, useSetPlanStatus, useSetReview, useUpdateDevPlan, useVisiblePeople,
} from './data';

type Tab = 'plans' | 'focus' | 'mentors';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const STATUS_TONE: Record<PlanStatus, 'good' | 'warn' | 'info' | 'mute'> = {
  Active: 'good', Draft: 'warn', Completed: 'info', Cancelled: 'mute',
};

/* ---------------- the plan form ---------------- */

function PlanForm({ existing, close }: { existing?: DevPlanDetail; close: () => void }) {
  const app = useApp();
  const create = useCreateDevPlan();
  const update = useUpdateDevPlan();
  const { data: mentors = [] } = useMentorOptions();
  const p = existing?.plan;

  const [d, setD] = useState<DevPlanDraft>({
    aspiration: p?.aspiration ?? '',
    targetLevel: (p?.targetLevel ?? null) as JobLevel | null,
    horizonMonths: p?.horizonMonths ?? 12,
    focus: p?.focus ?? [],
    mentorId: p?.mentorId ?? null,
    strengths: p?.strengths ?? '',
    reviewOn: p?.reviewOn ?? '',
    notes: p?.notes ?? '',
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof DevPlanDraft>(k: K, v: DevPlanDraft[K]) => setD({ ...d, [k]: v });

  const toggleArea = (a: DevArea) => set('focus',
    d.focus.includes(a) ? d.focus.filter((x) => x !== a) : [...d.focus, a]);

  const save = async () => {
    setErr('');
    try {
      if (p) await update.mutate(p.id, d);
      else await create.mutate(d);
      app.toast(p ? 'Plan updated' : 'Plan created as a draft', 'ok');
      close();
    } catch (e) { setErr(msg(e, 'Could not save the plan')); }
  };

  const wasEndorsed = !!p?.endorsedOn;
  const material = wasEndorsed && (
    d.aspiration !== p.aspiration
    || d.horizonMonths !== p.horizonMonths
    || d.targetLevel !== p.targetLevel
    || JSON.stringify(sortBy(d.focus)) !== JSON.stringify(sortBy(p.focus))
  );

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not saved">{err}</Banner>}

      {material && (
        <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="This will need endorsing again">
          Your manager signed off a different plan. Changing what it is for withdraws
          that endorsement and puts the plan back to a draft — which is the point of
          endorsing it.
        </Banner>
      )}

      <div className="field">
        <label>What are you aiming at <span className="req">*</span></label>
        <input className="input" value={d.aspiration} autoFocus
          placeholder="Move into a lead role"
          onChange={(e) => set('aspiration', e.target.value)} />
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Target level</label>
          <select className="input" value={d.targetLevel ?? ''}
            onChange={(e) => set('targetLevel', (e.target.value || null) as JobLevel | null)}>
            <option value="">Not aiming at a level</option>
            {JOB_LEVELS.map((l) => <option key={l.id} value={l.id}>{l.n}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Over <span className="req">*</span></label>
          <select className="input" value={d.horizonMonths}
            onChange={(e) => set('horizonMonths', Number(e.target.value) as Horizon)}>
            {HORIZONS.map((h) => <option key={h} value={h}>{h} months</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label>Focus areas <span className="req">*</span></label>
        <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
          {DEV_AREAS.map((a) => (
            <button
              key={a}
              type="button"
              className={'chip' + (d.focus.includes(a) ? ' on' : '')}
              aria-pressed={d.focus.includes(a)}
              onClick={() => toggleArea(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 2 }}>
          <label>Mentor</label>
          <select className="input" value={d.mentorId ?? ''}
            onChange={(e) => set('mentorId', e.target.value || null)}>
            <option value="">Nobody yet</option>
            {mentors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.designation}{m.mentees ? ` · ${m.mentees} mentee(s)` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Next review</label>
          <input className="input" type="date" value={d.reviewOn ?? ''}
            onChange={(e) => set('reviewOn', e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label>What you are already good at</label>
        <textarea className="input" rows={2} value={d.strengths ?? ''}
          placeholder="The things a plan should build on rather than repeat"
          onChange={(e) => set('strengths', e.target.value)} />
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea className="input" rows={2} value={d.notes ?? ''}
          onChange={(e) => set('notes', e.target.value)} />
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={create.pending || update.pending} onClick={save}>
          {p ? 'Save plan' : 'Create draft'}
        </button>
      </div>
    </div>
  );
}

function ActionForm({ planId, close }: { planId: string; close: () => void }) {
  const app = useApp();
  const add = useAddAction();
  const [d, setD] = useState<DevActionDraft>({
    kind: 'On-the-job', area: 'Technical skills', n: '', due: '', courseId: null, note: '',
  });
  const [err, setErr] = useState('');
  const set = <K extends keyof DevActionDraft>(k: K, v: DevActionDraft[K]) => setD({ ...d, [k]: v });

  const tracksCourse = d.kind === 'Course' || d.kind === 'Certification';

  const save = async () => {
    setErr('');
    try {
      await add.mutate(planId, { ...d, courseId: tracksCourse ? d.courseId : null });
      app.toast('Action added', 'ok');
      close();
    } catch (e) { setErr(msg(e, 'Could not add the action')); }
  };

  return (
    <div className="stack">
      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not added">{err}</Banner>}

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Kind <span className="req">*</span></label>
          <select className="input" value={d.kind}
            onChange={(e) => set('kind', e.target.value as ActionKind)}>
            {ACTION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Develops <span className="req">*</span></label>
          <select className="input" value={d.area}
            onChange={(e) => set('area', e.target.value as DevArea)}>
            {DEV_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      <div className="field">
        <label>What you will do <span className="req">*</span></label>
        <input className="input" value={d.n} autoFocus
          placeholder="Run the standup and sprint planning for a quarter"
          onChange={(e) => set('n', e.target.value)} />
      </div>

      {tracksCourse && (
        <>
          <div className="field">
            <label>Which course</label>
            <select className="input" value={d.courseId ?? ''}
              onChange={(e) => set('courseId', e.target.value || null)}>
              <option value="">Not one from the catalogue</option>
              {sortBy(COURSES, (c) => c.t).map((c) => (
                <option key={c.id} value={c.id}>{c.t} · {c.hrs}h</option>
              ))}
            </select>
          </div>
          {d.courseId && (
            <Banner kind="info" icon={<Icon n="learning" size="lg" />} title="Tracked in Learning">
              Progress on this action is read from your enrolment. You will not be able
              to tick it off here — finish the course and this updates itself.
            </Banner>
          )}
        </>
      )}

      <div className="field">
        <label>By when <span className="req">*</span></label>
        <input className="input" type="date" value={d.due}
          onChange={(e) => set('due', e.target.value)} />
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={add.pending} onClick={save}>Add action</button>
      </div>
    </div>
  );
}

/* ---------------- one action ---------------- */

function ActionRowView({ r, canEdit, onToggle, onRemove }: {
  r: DevActionRow;
  canEdit: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const a = r.action;
  return (
    <div className={'lc-task' + (r.done ? ' done' : '')}>
      {/*
        A course action has no tick box at all, rather than a disabled one.
        A control you cannot use still reads as a control, and somebody will
        click it and conclude the page is broken.
      */}
      {r.fromEnrolment ? (
        <span className="lc-ic" aria-hidden="true"><Icon n="learning" size="sm" /></span>
      ) : (
        <input type="checkbox" checked={r.done} aria-label={a.n}
          disabled={!canEdit} onChange={onToggle} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="lc-task-n">{a.n}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {a.kind} · {a.area} · due {fmtD(a.due)}
          {a.doneOn && <> · done {fmtD(a.doneOn)}</>}
        </div>
        {r.fromEnrolment && (
          <div style={{ marginTop: 5 }}>
            <Bar value={r.progress} />
            <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
              {r.progress}% · from your enrolment in {r.courseTitle ?? 'Learning'}
            </div>
          </div>
        )}
      </div>

      {r.overdue && <Badge kind="crit">Overdue</Badge>}
      {canEdit && (
        <button className="btn ghost icon sm" aria-label={`Remove ${a.n}`} onClick={onRemove}>
          <Icon n="remove" size="sm" />
        </button>
      )}
    </div>
  );
}

/* ---------------- the plan, in full ---------------- */

function PlanBody({ d, refetchKey }: { d: DevPlanDetail; refetchKey?: string }) {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const endorse = useEndorsePlan();
  const setStatus = useSetPlanStatus();
  const setReview = useSetReview();
  const toggle = useSetActionDone();
  const removeAction = useRemoveAction();
  const [tab, setTab] = useState<'actions' | 'about' | 'history'>('actions');
  void refetchKey;

  const p = d.plan;
  const mine = p.empId === app.meId;
  const canEdit = mine || app.role === 'admin';
  const canEndorse = !mine && app.role !== 'employee';
  const closed = p.status === 'Completed' || p.status === 'Cancelled';

  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  return (
    <div className="stack">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge kind={STATUS_TONE[p.status]}>{p.status}</Badge>
        {d.endorsed
          ? <Badge kind="good">Endorsed {fmtD(p.endorsedOn)}</Badge>
          : <Badge kind="warn">Not endorsed</Badge>}
        {d.reviewDue && <Badge kind="crit">Review due</Badge>}
        {p.targetLevel && <Badge kind="info">Towards {p.targetLevel}</Badge>}
      </div>

      <Card title={p.aspiration} sub={`${p.horizonMonths} months · ${fmtD(p.from)} to ${fmtD(p.to)}`}>
        <Bar value={d.progress} />
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          {d.done} of {d.actions} actions complete
          {d.overdue > 0 && <> · <span className="b-crit">{d.overdue} overdue</span></>}
        </div>
      </Card>

      {!d.endorsed && p.status === 'Draft' && (
        <Banner kind="warn" icon={<Icon n="pending" size="lg" />}
          title={mine ? 'Waiting on your manager' : 'Waiting on you'}>
          {mine
            ? 'This is a draft until your manager endorses it. It does not count towards coverage until then, which is deliberate — a plan nobody agreed to is a wish.'
            : 'They have written this and are waiting for you to agree to it. Endorsing it makes it active and puts it on your review list.'}
        </Banner>
      )}

      {canEndorse && !d.endorsed && p.status !== 'Cancelled' && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={endorse.pending}
            onClick={() => act(() => endorse.mutate(p.id), 'Plan endorsed')}>
            <Icon n="verified" size="lg" /> Endorse this plan
          </button>
        </div>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'actions' as const, label: `Actions (${d.actions})` },
          { v: 'about' as const, label: 'The plan' },
          { v: 'history' as const, label: 'History' },
        ]}
        onChange={setTab}
      />

      {tab === 'actions' && (
        <>
          {canEdit && !closed && (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn sm" onClick={() => layer.modal({
                title: 'Add an action',
                sub: d.name,
                body: (close) => <ActionForm planId={p.id} close={close} />,
                footer: null,
              })}>
                <Icon n="add" size="lg" /> Add action
              </button>
            </div>
          )}
          {d.items.length ? (
            <div className="stack">
              {d.items.map((r) => (
                <ActionRowView
                  key={r.action.id}
                  r={r}
                  canEdit={canEdit && !closed}
                  onToggle={() => act(() => toggle.mutate(r.action.id, !r.done),
                    r.done ? 'Action reopened' : 'Action complete')}
                  onRemove={() => act(() => removeAction.mutate(r.action.id), 'Action removed')}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<Icon n="goal" size="xl" />}
              msg="Nothing on the plan yet — a plan with no actions cannot be endorsed" />
          )}
        </>
      )}

      {tab === 'about' && (
        <>
          <KV rows={[
            ['Aiming at', p.aspiration],
            ['Target level', p.targetLevel ?? '—'],
            ['Focus areas', p.focus.join(' · ') || '—'],
            ['Mentor', p.mentorId ? dir.name(p.mentorId) : 'Nobody yet'],
            ['Running', `${fmtD(p.from)} to ${fmtD(p.to)}`],
            ['Next review', <>
              {fmtD(p.reviewOn)}
              {d.reviewDue && <> <Badge kind="crit">due</Badge></>}
            </>],
            ['Endorsed by', p.endorsedById ? dir.name(p.endorsedById) : 'Not yet'],
            ['Strengths to build on', p.strengths || '—'],
            ['Notes', p.notes || '—'],
          ]} />

          <div className="row" style={{ gap: 9, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {(canEdit || canEndorse) && !closed && (
              <label className="row" style={{ gap: 7, alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>Move the review to</span>
                <input className="input sm" type="date" value={p.reviewOn}
                  onChange={(e) => act(() => setReview.mutate(p.id, e.target.value),
                    'Review date moved')} />
              </label>
            )}
            {canEdit && !closed && (
              <>
                <button className="btn" onClick={() => layer.modal({
                  title: 'Edit the plan',
                  sub: d.name,
                  body: (close) => <PlanForm existing={d} close={close} />,
                  footer: null,
                })}>
                  <Icon n="tool" size="lg" /> Edit
                </button>
                <button className="btn" disabled={setStatus.pending}
                  onClick={() => act(() => setStatus.mutate(p.id, 'Completed'), 'Plan completed')}>
                  <Icon n="done" size="lg" /> Mark complete
                </button>
                <button className="btn danger" disabled={setStatus.pending}
                  onClick={() => act(() => setStatus.mutate(p.id, 'Cancelled'), 'Plan cancelled')}>
                  Cancel plan
                </button>
              </>
            )}
          </div>
        </>
      )}

      {tab === 'history' && (
        d.history.length ? (
          <div className="tl"><div className="tl-day">
            {d.history.map((h) => (
              <div className="tl-row" key={h.id}>
                <div className="tl-time mono">{h.at.slice(5, 10)}</div>
                <div className="tl-mark" aria-hidden="true">
                  <i style={{ background: 'var(--brand)' }} />
                </div>
                <div className="tl-body">
                  <div className="tl-k">{h.action.replace('dev_plan.', '').replace(/_/g, ' ')}</div>
                  <div className="tl-s">{h.summary}</div>
                  <div className="tl-who muted">{h.actorLabel}</div>
                </div>
              </div>
            ))}
          </div></div>
        ) : (
          <EmptyState icon={<Icon n="clock" size="xl" />}
            msg="Nothing has changed since the plan was written" />
        )
      )}
    </div>
  );
}

function PlanDrawer({ id }: { id: string }) {
  const { data: d, loading, error } = useDevPlan(id);
  if (error) return <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />;
  if (!d) return <EmptyState msg={loading ? 'Loading…' : 'No such plan'} />;
  return <PlanBody d={d} />;
}

/* ---------------- an employee's own screen ---------------- */

function MyPlan() {
  const layer = useLayer();
  const { data: d, loading } = useMyDevPlan();

  if (loading) return <EmptyState msg="Loading your plan…" />;
  if (!d) {
    return (
      <Card title="You do not have a development plan yet">
        <EmptyState
          icon={<Icon n="rocket" size="xl" />}
          msg={
            <div className="stack" style={{ alignItems: 'center', gap: 12 }}>
              <span>
                A plan says where you are trying to get to and what will get you there.
                You write it; your manager endorses it.
              </span>
              <button className="btn primary" onClick={() => layer.modal({
                title: 'Write your development plan',
                body: (close) => <PlanForm close={close} />,
                footer: null,
              })}>
                <Icon n="add" size="lg" /> Write my plan
              </button>
            </div>
          }
        />
      </Card>
    );
  }
  return <PlanBody d={d} />;
}

/* ---------------- the page ---------------- */

function DevPlansView() {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const [tab, setTab] = useTabFromUrl<Tab>('plans', ['plans', 'focus', 'mentors']);
  const [f, setF] = useState<DevPlanFilter>({});

  const { data: rows = [], loading, error } = useDevPlans(f);
  const { data: all = [] } = useDevPlans({});
  const { data: stats } = useDevStats();
  const { data: focus = [] } = useDevFocus();
  const { data: mentors = [] } = useMentorLoad();

  if (app.role === 'employee') return <MyPlan />;
  if (error) {
    return (
      <Card title="Development plans">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const openPlan = (r: DevPlanRow) => layer.drawer({
    title: r.name,
    sub: r.plan.aspiration,
    body: <PlanDrawer id={r.plan.id} />,
  });

  const exportCsv = () => downloadCSV('development_plans.csv', [
    ['Name', 'Department', 'Designation', 'Aspiration', 'Target level', 'Focus',
      'Status', 'Endorsed', 'Mentor', 'Actions', 'Complete', 'Overdue',
      'Progress %', 'Next review'],
    ...rows.map((r) => [
      r.name, r.dept ? deptOf(r.dept).name : '—', r.designation, r.plan.aspiration,
      r.plan.targetLevel ?? '—', r.plan.focus.join(' | '), r.plan.status,
      r.endorsed ? fmtD(r.plan.endorsedOn) : 'No',
      r.plan.mentorId ? dir.name(r.plan.mentorId) : '—',
      r.actions, r.done, r.overdue, r.progress, r.plan.reviewOn,
    ]),
  ]);

  const one = (k: keyof DevPlanFilter) => (v: string) => setF({ ...f, [k]: v || undefined });
  const active = Object.values(f).some((v) => v != null && v !== '' && v !== false);

  return (
    <div className="stack">
      <PageActions>
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>
          <Icon n="download" size="lg" /> Export
        </button>
        {!all.some((r) => r.plan.empId === app.meId) && (
          <button className="btn primary" onClick={() => layer.modal({
            title: 'Write your development plan',
            body: (close) => <PlanForm close={close} />,
            footer: null,
          })}>
            <Icon n="add" size="lg" /> My plan
          </button>
        )}
      </PageActions>

      <StatRow cols={5}>
        <Tile icon={<Icon n="rocket" size="lg" />} label="Live plans"
          value={stats?.active ?? '—'}
          foot={stats ? `${stats.drafts} awaiting endorsement` : ''} />
        <Tile icon={<Icon n="verified" size="lg" />} label="Coverage"
          value={stats ? `${stats.coverage}%` : '—'} foot="Endorsed, of all employees" />
        <Tile icon={<Icon n="done" size="lg" />} label="Actions done"
          value={stats ? `${stats.actionsDone} / ${stats.actions}` : '—'}
          foot="Across every plan" />
        <Tile icon={<Icon n="warn" size="lg" />} label="Overdue actions"
          value={stats?.overdue ?? '—'} foot="On live plans" />
        <Tile icon={<Icon n="calendar" size="lg" />} label="Reviews due"
          value={stats?.reviewsDue ?? '—'} foot="Conversations owed" />
      </StatRow>

      {stats != null && stats.drafts > 0 && (
        <Banner kind="info" icon={<Icon n="pending" size="lg" />} title="Drafts are not coverage">
          {stats.drafts} plan(s) are written and unendorsed. They do not count towards
          the {stats.coverage}% above until somebody agrees to them.
        </Banner>
      )}

      <Tabs
        value={tab}
        options={[
          { v: 'plans' as const, label: 'Plans' },
          { v: 'focus' as const, label: 'What people are working on' },
          { v: 'mentors' as const, label: `Mentors (${mentors.length})` },
        ]}
        onChange={setTab}
      />

      {tab === 'plans' && (
        <>
          <div className="toolbar">
            <div className="gsearch" style={{ width: 230, flex: '0 0 auto' }}>
              <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
              <input className="gsearch-in" type="search" value={f.q ?? ''}
                placeholder="Name or aspiration…" aria-label="Search plans"
                onChange={(e) => one('q')(e.target.value)} />
            </div>
            <select className="input sm" value={f.status ?? ''} aria-label="Status"
              onChange={(e) => one('status')(e.target.value)}>
              <option value="">All statuses</option>
              {(['Draft', 'Active', 'Completed', 'Cancelled'] as const).map((sv) => (
                <option key={sv} value={sv}>{sv}</option>
              ))}
            </select>
            <select className="input sm" value={f.dept ?? ''} aria-label="Department"
              onChange={(e) => one('dept')(e.target.value)}>
              <option value="">All departments</option>
              {DEPTS.map((dp) => <option key={dp.id} value={dp.id}>{dp.name}</option>)}
            </select>
            <select className="input sm" value={f.area ?? ''} aria-label="Focus area"
              onChange={(e) => one('area')(e.target.value)}>
              <option value="">Any focus</option>
              {DEV_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select className="input sm" value={f.mentorId ?? ''} aria-label="Mentor"
              onChange={(e) => one('mentorId')(e.target.value)}>
              <option value="">Any mentor</option>
              {uniq(all.map((r) => r.plan.mentorId).filter(Boolean) as string[])
                .map((id) => <option key={id} value={id}>{dir.name(id)}</option>)}
            </select>
            <button className={'btn sm' + (f.reviewDue ? ' primary' : '')}
              aria-pressed={!!f.reviewDue}
              onClick={() => setF({ ...f, reviewDue: f.reviewDue ? undefined : true })}>
              Review due
            </button>
            <button className={'btn sm' + (f.overdueOnly ? ' primary' : '')}
              aria-pressed={!!f.overdueOnly}
              onClick={() => setF({ ...f, overdueOnly: f.overdueOnly ? undefined : true })}>
              Has overdue actions
            </button>
            <div className="spacer" />
            {active && <button className="btn sm" onClick={() => setF({})}>Reset</button>}
          </div>

          <Card title="Plans" sub={`${rows.length} of ${all.length}`} flush>
            {rows.length ? (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Person</th><th>Aiming at</th><th>Focus</th><th>Mentor</th>
                      <th>Progress</th><th className="num">Overdue</th>
                      <th>Next review</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.plan.id} className="clickable" onClick={() => openPlan(r)}>
                        <td>
                          <div className="row" style={{ gap: 9, alignItems: 'center' }}>
                            <Avatar name={r.name} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 650, fontSize: 13 }}>{r.name}</div>
                              <div className="muted" style={{ fontSize: 11.5 }}>
                                {r.designation}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td style={{ maxWidth: 200, fontSize: 12.5 }}>{r.plan.aspiration}</td>
                        <td className="muted" style={{ maxWidth: 160, fontSize: 11.5 }}>
                          {r.plan.focus.join(', ')}
                        </td>
                        <td className="nowrap">
                          {r.plan.mentorId ? dir.name(r.plan.mentorId) : '—'}
                        </td>
                        <td style={{ minWidth: 110 }}>
                          <Bar value={r.progress} />
                          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                            {r.done}/{r.actions}
                          </div>
                        </td>
                        <td className="num">{r.overdue || '—'}</td>
                        <td className="nowrap">
                          {fmtD(r.plan.reviewOn)}
                          {r.reviewDue && <> <Badge kind="crit">due</Badge></>}
                        </td>
                        <td>
                          <Badge kind={STATUS_TONE[r.plan.status]}>{r.plan.status}</Badge>
                          {!r.endorsed && r.plan.status !== 'Cancelled'
                            && <> <Badge kind="warn">unendorsed</Badge></>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={<Icon n="rocket" size="xl" />}
                msg={loading
                  ? 'Loading plans…'
                  : all.length
                    ? 'No plans match this filter'
                    : 'Nobody you can see has a development plan yet'}
              />
            )}
          </Card>
        </>
      )}

      {tab === 'focus' && (
        <Card title="What people are working on"
          sub="Live plans by focus area — a company profile, not a ranking">
          {focus.length ? (
            <div className="stack">
              {sortBy(focus, (r) => -r.plans).map((r) => (
                <div key={r.area}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span style={{ fontWeight: 650 }}>{r.area}</span>
                    <span className="muted">{r.plans} plan(s)</span>
                  </div>
                  <Bar value={Math.round((r.plans / Math.max(1, focus[0] ? Math.max(...focus.map((x) => x.plans)) : 1)) * 100)} />
                </div>
              ))}
              <Banner kind="info" icon={<Icon n="info" size="lg" />} title="Read this as a gap list">
                An area nobody names is not necessarily fine — it may be the one no
                manager is raising. The useful question is which of these you expected
                to be larger.
              </Banner>
            </div>
          ) : (
            <EmptyState icon={<Icon n="chart" size="xl" />} msg="No live plans to summarise" />
          )}
        </Card>
      )}

      {tab === 'mentors' && (
        <Card title="Who is mentoring whom" sub="Live plans naming a mentor, busiest first" flush>
          {mentors.length ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Mentor</th><th className="num">Mentees</th><th>Load</th></tr>
                </thead>
                <tbody>
                  {mentors.map((m) => (
                    <tr key={m.mentorId}>
                      <td>
                        <div className="row" style={{ gap: 9, alignItems: 'center' }}>
                          <Avatar name={m.name} />
                          <span style={{ fontWeight: 650, fontSize: 13 }}>{m.name}</span>
                        </div>
                      </td>
                      <td className="num">{m.mentees}</td>
                      <td>
                        {m.mentees >= 4
                          ? <Badge kind="warn">Carrying a lot</Badge>
                          : <Badge kind="good">Comfortable</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Icon n="people" size="xl" />}
              msg="No live plan names a mentor yet" />
          )}
        </Card>
      )}
    </div>
  );
}

registerModule({
  key: 'devplans',
  title: TITLES.devplans,
  Component: DevPlansView,
});

export { DevPlansView };
