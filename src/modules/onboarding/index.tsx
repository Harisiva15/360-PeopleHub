import { useState } from 'react';
import { sum } from '../../lib/collections';
import { fmtD, monthKey, TODAY, ymd } from '../../lib/dates';
import { inr, pct } from '../../lib/format';


import type { Onboarding } from '../../services';
import { deptOf, siteOf } from '../../data/org';
import { Avatar, Badge, Banner, Card, EmptyState, KV, Tile } from '../../components/ui';
import { Divide, ListRow, StatusBadge } from '../../components/common';
import { HBar, PAL, Ring } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { isMyReport } from '../../state/rbac';
import { useCompleteJourney, useJourneys, useSetTask, useVisiblePeople } from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const progressOf = (x: Onboarding) => pct(x.tasks.filter((t) => t.done).length, x.tasks.length);

const OWNERS = ['HR', 'IT', 'Manager', 'Finance', 'Candidate', 'Employee'];

function OnbDetail({ o }: { o: Onboarding }) {
  const dir = useVisiblePeople();
  const setTask = useSetTask();
  const completeJourney = useCompleteJourney();
  const app = useApp();
  const done = o.tasks.filter((t) => t.done).length;
  const complete = pct(done, o.tasks.length);
  const byOwner = OWNERS.map((k, i) => ({ k, c: PAL[i], v: o.tasks.filter((t) => t.owner === k).length })).filter((r) => r.v);

  /* The service derives the journey's status from the checklist. */
  const toggleTask = async (key: string, checked: boolean) => {
    try {
      await setTask.mutate(o.id, key, checked);
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not update the task', 'err');
    }
  };

  return (
    <div className="stack">
      <Card title={o.name} sub={`${o.designation} · ${deptOf(o.dept).name} · joins ${fmtD(o.doj)}`}
        actions={
          <div className="row">
            <StatusBadge status={o.status} />
            {o.status !== 'Completed' && (
              <button className="btn sm primary" onClick={async () => {
                try {
                  for (const t of o.tasks.filter((x) => !x.done)) await setTask.mutate(o.id, t.k, true);
                  await completeJourney.mutate(o.id);
                  app.toast(o.name + "'s onboarding marked complete", 'ok');
                } catch (e) {
                  app.toast(e instanceof Error ? e.message : 'Could not complete the journey', 'err');
                }
              }}>Mark complete</button>
            )}
          </div>
        }>
        <div className="row" style={{ gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <Ring value={complete} color={complete === 100 ? 'var(--good)' : 'var(--brand)'} size={92} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <KV rows={[
              ['Reporting manager', dir.name(o.managerId)],
              ['Onboarding buddy', dir.name(o.buddyId)],
              ['Location', siteOf(o.site).name],
              ['Offered CTC', app.role === 'admin' ? inr(o.ctc) : <span className="muted">Restricted</span>],
              ['Background check', <StatusBadge status={o.bgv} />],
              ['Tasks complete', `${done} of ${o.tasks.length}`],
            ]} />
          </div>
        </div>
      </Card>

      <Card title="Onboarding checklist" sub={`${done} of ${o.tasks.length} complete`} flush>
        {o.tasks.map((t) => (
          <ListRow key={t.k}>
            <input type="checkbox" checked={t.done} style={{ width: 17, height: 17, cursor: 'pointer' }}
              onChange={(e) => toggleTask(t.k, e.target.checked)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, ...(t.done ? { textDecoration: 'line-through', opacity: 0.55 } : {}) }}>
                {t.n}
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>Owner: {t.owner} · due {fmtD(t.due)}</div>
            </div>
            {t.done
              ? <Badge kind="good">Done</Badge>
              : t.due < ymd(TODAY) ? <Badge kind="crit">Overdue</Badge> : <Badge>Pending</Badge>}
          </ListRow>
        ))}
      </Card>

      <div className="grid g2">
        <Card title="Document collection" sub={`${o.docs.filter((d) => d.ok).length} of ${o.docs.length} received`} flush>
          {o.docs.map((d, i) => (
            <ListRow key={d.n}>
              <span>📄</span>
              <div style={{ flex: 1 }}>{d.n}</div>
              {d.ok ? <Badge kind="good">Received</Badge> : (
                <button className="btn sm" onClick={() => {
                  o.docs[i].ok = true;
                  app.toast('Document marked as received', 'ok');
                  app.bump();
                }}>Mark received</button>
              )}
            </ListRow>
          ))}
        </Card>

        <Card title="Tasks by owner" sub="Responsibility split">
          <HBar rows={byOwner} />
          <Divide />
          <Banner kind="info" icon="📧">
            Welcome email, IT asset request and payroll setup are triggered automatically 3 days before the joining date.
          </Banner>
        </Card>
      </div>
    </div>
  );
}

function OnboardingView() {
  const { data: ONBOARD = [] } = useJourneys();
  const app = useApp();
  const list = app.role === 'admin'
    ? ONBOARD
    : ONBOARD.filter((o) => o.managerId === app.meId || isMyReport(app.meId, o.managerId));

  const [sel, setSel] = useState<string | null>(null);
  const o = list.find((x) => x.id === sel) || list[0];

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Active journeys" value={list.filter((x) => x.status !== 'Completed').length} foot={`${list.length} total this quarter`} />
        <Tile label="Joining this month" value={list.filter((x) => x.doj.slice(0, 7) === monthKey(TODAY)).length} foot="Confirmed start dates" />
        <Tile label="BGV pending" value={list.filter((x) => x.bgv !== 'Clear').length} foot="Background verification open" />
        <Tile label="Avg completion" value={Math.round(sum(list, progressOf) / Math.max(1, list.length)) + '%'} foot="Checklist tasks done" />
      </div>

      <div className="grid g-1-2">
        <Card title="Onboarding journeys" sub={`${list.length} people`} flush>
          <div style={{ maxHeight: 640, overflow: 'auto' }}>
            {list.length ? list.map((x) => (
              <ListRow key={x.id} onClick={() => setSel(x.id)}
                style={o && x.id === o.id ? { background: 'var(--brand-wash)' } : undefined}>
                <Avatar name={x.name} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 13 }}>{x.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{x.designation} · joins {fmtD(x.doj)}</div>
                  <div className="bar" style={{ marginTop: 6 }}>
                    <i style={{ width: progressOf(x) + '%', background: progressOf(x) === 100 ? 'var(--good)' : 'var(--brand)' }} />
                  </div>
                </div>
                <StatusBadge status={x.status} />
              </ListRow>
            )) : <EmptyState msg="No onboarding journeys" icon="🚀" />}
          </div>
        </Card>

        {o ? <OnbDetail o={o} /> : <Card><EmptyState msg="Select a journey" /></Card>}
      </div>
    </div>
  );
}

registerModule({
  key: 'onboarding',
  title: TITLES.onboarding,
  Component: OnboardingView,
});
