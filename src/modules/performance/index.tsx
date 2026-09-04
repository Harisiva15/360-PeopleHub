import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { fmtD, TODAY, ymd } from '../../lib/dates';
import { inr, lakh } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { ACTIVE, EMAP, empName, teamOf } from '../../data/employees';
import {
  CHECKINS, CUR_CYCLE, CYCLES, GOALS, NINEBOX, PRAISE, RATINGS, ratingOf,
  REVIEW_PHASES, REVIEWS, reviewOf, VALUES,
} from '../../data/performance';
import type { Goal, Review } from '../../data/performance';
import { Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile } from '../../components/ui';
import { Divide, Dot, ListRow, StatusBadge } from '../../components/common';
import { Donut, HBar, Legend, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const GOAL_TONE: Record<string, 'good' | 'info' | 'warn' | 'crit'> = {
  Achieved: 'good', 'On Track': 'info', 'At Risk': 'warn', Behind: 'crit',
};

/** Progress bar colour tracks the same thresholds the status uses. */
const progressColor = (p: number) =>
  p >= 100 ? 'var(--good)' : p >= 60 ? 'var(--s1)' : p >= 35 ? 'var(--warn)' : 'var(--crit)';

const statusFor = (p: number): Goal['status'] =>
  p >= 100 ? 'Achieved' : p >= 60 ? 'On Track' : p >= 35 ? 'At Risk' : 'Behind';

function Stars({ n }: { n: number }) {
  return (
    <span style={{ letterSpacing: 2, fontSize: 13 }}>
      {'★'.repeat(n)}<span style={{ opacity: 0.25 }}>{'★'.repeat(5 - n)}</span>
    </span>
  );
}

function GoalCard({ g, editable }: { g: Goal; editable?: boolean }) {
  const app = useApp();
  const setProgress = (v: number) => {
    g.progress = v;
    g.status = statusFor(v);
    /* the mid and final key results mirror the progress thresholds */
    g.keyResults[1].done = v >= 50;
    g.keyResults[2].done = v >= 100;
    app.toast('Progress updated to ' + v + '%', 'ok');
    app.bump();
  };

  return (
    <Card style={{ marginBottom: 10 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: '-.1px' }}>{g.title}</div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
            {g.category} · weight {g.weight}% · due {fmtD(g.due)}{g.alignedTo ? ` · aligned to ${g.alignedTo}` : ''}
          </div>
        </div>
        <Badge kind={GOAL_TONE[g.status]}>{g.status}</Badge>
      </div>

      <div className="row" style={{ gap: 12, marginTop: 11 }}>
        <div style={{ flex: 1 }}>
          <div className="bar"><i style={{ width: g.progress + '%', background: progressColor(g.progress) }} /></div>
        </div>
        <span className="mono strong" style={{ minWidth: 42, textAlign: 'right' }}>{g.progress}%</span>
        {editable && (
          <input type="range" min={0} max={100} step={5} defaultValue={g.progress}
            style={{ width: 120 }} onChange={(e) => setProgress(+e.target.value)} />
        )}
      </div>

      <div className="row wrap" style={{ gap: 12, marginTop: 10 }}>
        {g.keyResults.map((k, i) => (
          <span key={i} style={{ fontSize: 11.5, color: k.done ? 'var(--good-text)' : 'var(--ink-3)' }}>
            {k.done ? '✓' : '○'} {k.k}
          </span>
        ))}
      </div>
    </Card>
  );
}

/* ---------------- My goals ---------------- */

function PfGoals() {
  const app = useApp();
  const me = app.me;
  const goals = GOALS.filter((g) => g.empId === me.id && g.cycleId === CUR_CYCLE.id);
  const achv = sum(goals, (g) => g.progress * g.weight) / Math.max(1, sum(goals, (g) => g.weight));
  const ci = sortBy(CHECKINS.filter((c) => c.empId === me.id), (c) => c.on, 'desc');
  const rv = reviewOf(me.id);
  const byCat = uniq(goals.map((g) => g.category)).map((c, i) => ({
    k: c, c: PAL[i % 8], v: sum(goals.filter((g) => g.category === c), (g) => g.weight),
  }));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Goal achievement" value={Math.round(achv) + '%'} foot={`Weighted across ${goals.length} goals`} />
        <Tile label="On track" value={`${goals.filter((g) => ['On Track', 'Achieved'].includes(g.status)).length} / ${goals.length}`}
          foot={`${goals.filter((g) => g.status === 'At Risk' || g.status === 'Behind').length} need attention`} />
        <Tile label="Cycle" value={CUR_CYCLE.name.split(' Appraisal')[0]} foot={`${fmtD(CUR_CYCLE.from)} – ${fmtD(CUR_CYCLE.to)}`} />
        <Tile label="Review status" value={rv ? rv.status : '—'} foot={'Manager: ' + empName(me.managerId || '')} />
      </div>

      <div className="grid g-2-1">
        <div>
          <div className="toolbar">
            <div style={{ fontWeight: 750, fontSize: 15 }}>My goals — {CUR_CYCLE.name}</div>
            <div className="spacer" />
          </div>
          {goals.map((g) => <GoalCard key={g.id} g={g} editable />)}
          {!goals.length && <Card><EmptyState msg="No goals set for this cycle yet" icon="🎯" /></Card>}
        </div>

        <div className="stack">
          <Card title="Weight by category" sub="Total must equal 100%">
            {byCat.length ? (
              <>
                <Donut size={150} center={sum(byCat, (b) => b.v) + '%'} centerSub="weight" slices={byCat} fmt={(v) => v + '%'} />
                <Legend items={byCat} fmt={(v) => v + '%'} />
              </>
            ) : <EmptyState msg="No goals" />}
          </Card>

          <Card title="Check-in history" sub={`${ci.length} conversations`} flush>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {ci.length ? ci.map((c) => (
                <div key={c.id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div className="muted" style={{ fontSize: 11, fontWeight: 650 }}>
                    {fmtD(c.on)} · with {empName(c.by || '')}
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 5 }}><b>Wins:</b> {c.wins}</div>
                  <div style={{ fontSize: 12.5, marginTop: 3 }}><b>Blockers:</b> {c.blockers}</div>
                  <div style={{ fontSize: 12.5, marginTop: 3 }}><b>Next:</b> {c.next}</div>
                </div>
              )) : <EmptyState msg="No check-ins logged yet" icon="💬" />}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Team goals ---------------- */

function PfTeam({ openReview }: { openReview: (id: string) => void }) {
  const app = useApp();
  const showEmp = useShowEmployee();

  const team = teamOf(app.meId, true).map((i) => EMAP[i]);
  if (app.role === 'admin') {
    ACTIVE().forEach((e) => {
      if (!team.some((t) => t.id === e.id) && e.id !== app.meId) team.push(e);
    });
  }

  const rows = team.map((e) => {
    const g = GOALS.filter((x) => x.empId === e.id && x.cycleId === CUR_CYCLE.id);
    const achv = sum(g, (x) => x.progress * x.weight) / Math.max(1, sum(g, (x) => x.weight));
    return {
      e, g, achv: Math.round(achv),
      risk: g.filter((x) => ['At Risk', 'Behind'].includes(x.status)).length,
      rv: reviewOf(e.id),
    };
  });

  const dist = (['Achieved', 'On Track', 'At Risk', 'Behind'] as const).map((s, i) => ({
    k: s, c: ['var(--s6)', 'var(--s1)', 'var(--s4)', 'var(--s8)'][i],
    v: GOALS.filter((g) => team.some((t) => t.id === g.empId) && g.status === s).length,
  }));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="People in scope" value={rows.length} foot="With goals in this cycle" />
        <Tile label="Avg goal achievement" value={Math.round(sum(rows, (r) => r.achv) / Math.max(1, rows.length)) + '%'} foot="Weighted" />
        <Tile label="Goals at risk" value={sum(rows, (r) => r.risk)} foot="Behind or at risk" />
        <Tile label="Reviews pending"
          value={rows.filter((r) => r.rv && r.rv.status !== 'Completed' && r.rv.status !== 'Calibrated').length}
          foot="Self or manager stage" />
      </div>

      <div className="grid g-2-1">
        <Card title="Team goal progress" sub={`${rows.length} people`} flush
          actions={<button className="btn sm" onClick={() =>
            downloadCSV('team_goals.csv',
              [['Emp Code', 'Name', 'Goals', 'Achievement %', 'At risk', 'Review status']].concat(
                rows.map((r) => [r.e.code, r.e.name, String(r.g.length), String(r.achv), String(r.risk), r.rv?.status || '']),
              ))}>⤓ Export</button>}>
          <div className="tbl-wrap" style={{ maxHeight: 560, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th className="num">Goals</th><th style={{ minWidth: 150 }}>Achievement</th><th className="num">At risk</th><th>Review status</th><th className="right">Action</th></tr>
              </thead>
              <tbody>
                {sortBy(rows, (r) => -r.achv).map((r) => (
                  <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                    <td><PersonCell e={r.e} /></td>
                    <td className="num">{r.g.length}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="bar" style={{ flex: 1 }}>
                          <i style={{ width: r.achv + '%', background: r.achv >= 80 ? 'var(--good)' : r.achv >= 50 ? 'var(--s1)' : 'var(--warn)' }} />
                        </div>
                        <span className="mono">{r.achv}%</span>
                      </div>
                    </td>
                    <td className="num">{r.risk ? <Badge kind="warn">{r.risk}</Badge> : '—'}</td>
                    <td>{r.rv ? <StatusBadge status={r.rv.status} /> : '—'}</td>
                    <td className="right">
                      <button className="btn sm" onClick={(ev) => { ev.stopPropagation(); openReview(r.e.id); }}>Review</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Goal status mix" sub="Across the team">
          <HBar rows={dist} />
          <Divide />
          <Banner kind="info" icon="💡">
            Goals at risk should be discussed in the next 1:1. Log the outcome as a check-in so it carries into the review.
          </Banner>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Review ---------------- */

function PfReview({ target, setTarget }: { target: string | null; setTarget: (id: string) => void }) {
  const app = useApp();
  const me = app.me;
  const e = EMAP[target && app.role !== 'employee' ? target : me.id];
  const rv = reviewOf(e.id);
  const goals = GOALS.filter((g) => g.empId === e.id && g.cycleId === CUR_CYCLE.id);
  const isSelf = e.id === me.id;

  if (!rv) return <Card><EmptyState msg="No review record for this cycle" /></Card>;
  const peerAvg = rv.peers.length ? sum(rv.peers, (p) => p.rating) / rv.peers.length : null;

  const options = sortBy([me].concat(teamOf(me.id, true).map((i) => EMAP[i])), (x) => x.name);

  return (
    <div className="stack">
      {app.role !== 'employee' && (
        <div className="toolbar">
          <select className="input" style={{ width: 'auto', maxWidth: 340 }} value={e.id} onChange={(ev) => setTarget(ev.target.value)}>
            {options.map((x) => (
              <option key={x.id} value={x.id}>{x.name}{x.id === me.id ? ' (me)' : ''} — {x.designation}</option>
            ))}
          </select>
          <div className="spacer" />
          <StatusBadge status={rv.status} />
        </div>
      )}

      <div className="grid g4">
        <Tile label="Goal achievement" value={rv.goalAchievement + '%'} foot={`${goals.length} goals, weighted`} />
        <Tile label="Self rating" value={rv.self.rating ? rv.self.rating + ' / 5' : 'Pending'}
          foot={rv.self.rating ? ratingOf(rv.self.rating).label : 'Awaiting submission'} />
        <Tile label="Manager rating" value={rv.manager.rating ? rv.manager.rating + ' / 5' : 'Pending'}
          foot={rv.manager.rating ? ratingOf(rv.manager.rating).label : 'Awaiting ' + empName(e.managerId || '')} />
        <Tile label="Peer average" value={peerAvg ? peerAvg.toFixed(1) + ' / 5' : '—'} foot={`${rv.peers.length} peer responses`} />
      </div>

      <div className="grid g-2-1">
        <div className="stack">
          <Card title="Goal scorecard" sub={CUR_CYCLE.name} flush>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Goal</th><th>Category</th><th className="num">Weight</th><th className="num">Progress</th><th className="num">Weighted</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {goals.map((g) => (
                    <tr key={g.id}>
                      <td><b>{g.title}</b></td>
                      <td>{g.category}</td>
                      <td className="num">{g.weight}%</td>
                      <td className="num">{g.progress}%</td>
                      <td className="num">{Math.round((g.progress * g.weight) / 100)}</td>
                      <td><Badge kind={GOAL_TONE[g.status]}>{g.status}</Badge></td>
                    </tr>
                  ))}
                  <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                    <td colSpan={4}>Weighted achievement</td><td className="num">{rv.goalAchievement}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Self appraisal" sub={rv.self.on ? 'Submitted ' + fmtD(rv.self.on) : 'Not submitted yet'}>
            {rv.self.rating ? (
              <>
                <div className="row" style={{ gap: 10, marginBottom: 9 }}>
                  <Stars n={rv.self.rating} />
                  <Badge kind="info">{ratingOf(rv.self.rating).label}</Badge>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{rv.self.comments}</div>
              </>
            ) : <EmptyState msg={isSelf ? 'Your self appraisal is due by 10 September' : 'Employee has not submitted yet'} icon="✍️" />}
          </Card>

          <Card title="Manager review" sub={'By ' + empName(e.managerId || '')}>
            {rv.manager.rating ? (
              <>
                <div className="row" style={{ gap: 10, marginBottom: 9 }}>
                  <Stars n={rv.manager.rating} />
                  <Badge kind="info">{ratingOf(rv.manager.rating).label}</Badge>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>{rv.manager.comments}</div>
              </>
            ) : <EmptyState msg="Manager review pending" icon="📝" />}
          </Card>

          <Card title="360° peer feedback" sub={`${rv.peers.length} responses · shown anonymised to the employee`} flush>
            {rv.peers.length ? rv.peers.map((p, i) => (
              <div key={i} style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                <div className="row" style={{ gap: 9, marginBottom: 5 }}>
                  {app.role === 'employee' ? (
                    <>
                      <span className="av sm" style={{ background: 'var(--line-2)' }}>?</span>
                      <span style={{ fontWeight: 650, fontSize: 12.5 }}>Anonymous peer</span>
                    </>
                  ) : (
                    <>
                      <Avatar name={empName(p.by)} size="sm" />
                      <span style={{ fontWeight: 650, fontSize: 12.5 }}>{empName(p.by)}</span>
                    </>
                  )}
                  <div className="spacer" />
                  <Stars n={p.rating} />
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{p.comment}</div>
              </div>
            )) : <EmptyState msg="Peer feedback not collected yet" icon="👥" />}
          </Card>
        </div>

        <div className="stack">
          <Card title="Final outcome" sub={rv.final ? 'Calibrated' : 'Pending calibration'}>
            {rv.final ? (
              <KV rows={[
                ['Final rating', <><b>{rv.final.rating} / 5</b> · {ratingOf(rv.final.rating).label}</>],
                ['Rating band', ratingOf(rv.final.rating).band],
                ['Increment', <><b>{rv.final.hike}%</b> effective 1 October 2026</>],
                ['New CTC', app.role === 'admin' || isSelf
                  ? inr(Math.round((e.ctc * (1 + rv.final.hike / 100)) / 1000) * 1000)
                  : <span className="muted">Restricted</span>],
                ['Promotion', rv.final.promoted ? <Badge kind="good">Recommended</Badge> : 'Not this cycle'],
              ]} />
            ) : <EmptyState msg="Calibration happens 21–27 September" icon="⚖️" />}
          </Card>

          <Card title="Rating scale" sub="360 Technology performance framework" flush>
            {RATINGS.map((r) => (
              <ListRow key={r.v}>
                <Dot color={r.c} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{r.v} — {r.label}</div>
                  <div className="muted" style={{ fontSize: 11 }}>Expected distribution: {r.band}</div>
                </div>
              </ListRow>
            ))}
          </Card>

          {rv.pip && (
            <Banner kind="warn" icon="⚠️" title="Performance improvement plan">
              A 60-day PIP has been initiated with weekly check-ins and a defined success measure.
            </Banner>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 9-box & calibration ---------------- */

function PfCalib() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const scope = app.role === 'admin' ? ACTIVE() : teamOf(app.meId, true).map((i) => EMAP[i]);
  const rows = scope.map((e) => ({ e, rv: reviewOf(e.id) })).filter((r) => r.rv && r.rv.manager.rating) as
    { e: typeof scope[number]; rv: Review }[];

  /* performance collapses the 1-5 rating into three bands for the grid */
  const perfBand = (rating: number) => (rating >= 4 ? 3 : rating === 3 ? 2 : 1);
  const box = (perf: number, pot: number) => rows.filter((r) => perfBand(r.rv.manager.rating!) === perf && r.rv.potential === pot);

  const dist = RATINGS.map((r) => ({ k: `${r.v} — ${r.label}`, c: r.c, v: rows.filter((x) => x.rv.manager.rating === r.v).length }));
  const budget = sum(rows.filter((r) => r.rv.final), (r) => (EMAP[r.e.id].ctc * r.rv.final!.hike) / 100);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Rated employees" value={rows.length} foot="Manager rating submitted" />
        <Tile label="Average rating" value={(sum(rows, (r) => r.rv.manager.rating!) / Math.max(1, rows.length)).toFixed(2)}
          foot="Target 3.10 – 3.40" />
        <Tile label="Increment pool" value={CUR_CYCLE.hikePool + '%'} foot="Approved by the board" />
        <Tile label="Committed spend" value={lakh(budget)} foot="Annualised increment cost" />
      </div>

      <div className="grid g-2-1">
        <Card title="9-box grid" sub="Performance (manager rating) × potential">
          <div style={{ display: 'grid', gridTemplateColumns: '64px repeat(3,1fr)', gap: 7 }}>
            <div />
            {['Low', 'Medium', 'High'].map((l) => (
              <div key={l} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                {l} performance
              </div>
            ))}
            {[3, 2, 1].map((pot) => (
              <div key={pot} style={{ display: 'contents' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', fontSize: 11, fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.05em', textAlign: 'right' }}>
                  {['Low', 'Med', 'High'][pot - 1]}<br />potential
                </div>
                {[1, 2, 3].map((perf) => {
                  const cell = box(perf, pot);
                  const meta = NINEBOX[perf + '-' + pot];
                  return (
                    <div key={perf}
                      style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10, minHeight: 104, background: `color-mix(in srgb, ${meta.c} 8%, var(--surface))` }}
                      data-tip={`${meta.n} — ${meta.a} · ${cell.length} people`}>
                      <div style={{ fontSize: 11, fontWeight: 750, color: meta.c }}>{meta.n}</div>
                      <div style={{ fontSize: 21, fontWeight: 750, letterSpacing: '-.6px', margin: '3px 0' }}>{cell.length}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                        {cell.slice(0, 6).map((r) => (
                          <span key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                            <Avatar name={r.e.name} size="sm" />
                          </span>
                        ))}
                        {cell.length > 6 && <span className="muted" style={{ fontSize: 10, alignSelf: 'center' }}>+{cell.length - 6}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Card>

        <div className="stack">
          <Card title="Rating distribution" sub="Against the target curve">
            <HBar rows={dist} />
            <Divide />
            <div className="muted" style={{ fontSize: 12 }}>
              Target curve: 10% Outstanding · 20% Exceeds · 55% Meets · 10% Needs Improvement · 5% Unsatisfactory.
              Calibration meetings adjust outliers before letters are released.
            </div>
          </Card>

          <Card title="Calibration actions" sub="Ready for release" flush>
            {rows.filter((r) => r.rv.final).slice(0, 10).map((r) => (
              <ListRow key={r.e.id} onClick={() => showEmp(r.e.id)}>
                <Avatar name={r.e.name} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{r.e.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {ratingOf(r.rv.final!.rating).label}{r.rv.final!.promoted ? ' · promotion' : ''}
                  </div>
                </div>
                <Badge kind="good">+{r.rv.final!.hike}%</Badge>
              </ListRow>
            ))}
            {app.role === 'admin' && (
              <ListRow>
                <button className="btn primary sm" style={{ width: '100%' }}
                  onClick={() => app.toast('Increment letters released to employees', 'ok')}>Release increment letters</button>
              </ListRow>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Praise wall ---------------- */

function PfPraise() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const list = sortBy(PRAISE, (p) => p.on, 'desc');
  const byValue = VALUES.map((v) => ({ k: v.k, c: v.c, v: PRAISE.filter((p) => p.value === v.k).length }));
  const top = sortBy(
    uniq(PRAISE.map((p) => p.toId)).map((id) => ({ id, n: PRAISE.filter((p) => p.toId === id).length })),
    (x) => -x.n,
  ).slice(0, 8);

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={() => app.toast('Praise composer is not wired in this build')}>🎉 Give praise</button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>{PRAISE.length} shout-outs this quarter · visible to everyone</span>
      </div>

      <div className="grid g-2-1">
        <div className="stack">
          {list.slice(0, 18).map((p) => {
            const v = VALUES.find((x) => x.k === p.value) || VALUES[0];
            return (
              <Card key={p.id}>
                <div className="row" style={{ gap: 9, marginBottom: 8 }}>
                  <Avatar name={empName(p.fromId)} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}>
                      <b>{empName(p.fromId)}</b> <span className="muted">praised</span> <b>{empName(p.toId)}</b>
                    </div>
                    <div className="muted" style={{ fontSize: 11 }}>{fmtD(p.on)}</div>
                  </div>
                  <span className="badge" style={{
                    background: `color-mix(in srgb, ${v.c} 14%, transparent)`,
                    color: v.c,
                    borderColor: `color-mix(in srgb, ${v.c} 32%, transparent)`,
                  }}>{v.ic} {v.k}</span>
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>{p.text}</div>
                <div className="row" style={{ marginTop: 10, gap: 8 }}>
                  <button className="btn sm ghost" onClick={() => setLiked((s) => ({ ...s, [p.id]: true }))}>
                    👏 {p.likes + (liked[p.id] ? 1 : 0)}
                  </button>
                </div>
              </Card>
            );
          })}
        </div>

        <div className="stack">
          <Card title="Praise by value" sub="Which values show up most">
            <HBar rows={sortBy(byValue, (r) => -r.v)} />
          </Card>

          <Card title="Most recognised" sub="This quarter" flush>
            {top.map((t, i) => (
              <ListRow key={t.id} onClick={() => showEmp(t.id)}>
                <span style={{ width: 18, fontWeight: 750, color: 'var(--ink-3)' }}>{i + 1}</span>
                <Avatar name={empName(t.id)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{empName(t.id)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{EMAP[t.id]?.designation || ''}</div>
                </div>
                <Badge kind="good">{t.n}</Badge>
              </ListRow>
            ))}
          </Card>

          <Card title="Our values" sub="What we recognise" flush>
            {VALUES.map((v) => (
              <ListRow key={v.k}>
                <span style={{ fontSize: 16 }}>{v.ic}</span>
                <div style={{ flex: 1, fontWeight: 650, fontSize: 12.5 }}>{v.k}</div>
                <Dot color={v.c} />
              </ListRow>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Cycle timeline ---------------- */

function PfCycle() {
  const today = ymd(TODAY);
  return (
    <div className="stack">
      <div className="grid g2">
        {CYCLES.slice().reverse().map((c) => (
          <Card key={c.id} title={c.name} sub={`${fmtD(c.from)} – ${fmtD(c.to)}`} actions={<StatusBadge status={c.status} />}>
            <KV rows={[
              ['Increment pool', c.hikePool + '% of payroll'],
              ['Employees in cycle', c.id === CUR_CYCLE.id ? REVIEWS.length : ACTIVE().length],
              ['Reviews completed', c.id === CUR_CYCLE.id
                ? REVIEWS.filter((r) => ['Calibrated', 'Completed'].includes(r.status)).length
                : ACTIVE().length],
              ['Letters released', c.status === 'Completed' ? 'Yes · 1 Apr 2026' : 'Scheduled 1 Oct 2026'],
            ]} />
          </Card>
        ))}
      </div>

      <Card title="Cycle timeline" sub={`${CUR_CYCLE.name} · ${REVIEW_PHASES.length} phases`}>
        <div className="stack" style={{ gap: 0 }}>
          {REVIEW_PHASES.map((p, i) => {
            const done = p.to < today;
            const now = p.from <= today && p.to >= today;
            return (
              <div key={p.k} className="row"
                style={{ gap: 14, alignItems: 'flex-start', padding: '12px 0', borderBottom: i === REVIEW_PHASES.length - 1 ? '0' : '1px solid var(--line)' }}>
                <div style={{
                  width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center',
                  flex: '0 0 26px', fontSize: 12, fontWeight: 700,
                  ...(done
                    ? { background: 'var(--good-text)', color: '#fff' }
                    : now ? { background: 'var(--brand)', color: '#fff' } : { background: 'var(--surface-3)', color: 'var(--ink-3)' }),
                }}>
                  {done ? '✓' : i + 1}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {p.n}{now && <> <Badge kind="info">In progress</Badge></>}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>{fmtD(p.from)} – {fmtD(p.to)}</div>
                </div>
                <Badge kind={done ? 'good' : now ? 'info' : 'mute'}>{done ? 'Completed' : now ? 'Open' : 'Upcoming'}</Badge>
              </div>
            );
          })}
        </div>
      </Card>

      <Banner kind="info" icon="ℹ️" title="How ratings translate into increments">
        The board approves a company-wide increment pool ({CUR_CYCLE.hikePool}% this cycle). Managers rate against goals,
        calibration normalises ratings across departments, and the pool is distributed so that higher ratings receive a
        proportionally larger share. Letters are released on 1 October with effect from the same date.
      </Banner>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'goals' | 'team' | 'review' | 'calib' | 'praise' | 'cycle';

function Performance() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'goals', label: 'My Goals' }, { v: 'review', label: 'My Review' }, { v: 'praise', label: 'Praise Wall' }, { v: 'cycle', label: 'Cycle Timeline' }]
    : [
        { v: 'goals', label: 'My Goals' }, { v: 'team', label: 'Team Goals' }, { v: 'review', label: 'Reviews' },
        { v: 'calib', label: '9-Box & Calibration' }, { v: 'praise', label: 'Praise Wall' }, { v: 'cycle', label: 'Cycle Timeline' },
      ];

  const [tab, setTab] = useState<Tab>('goals');
  const [rvTarget, setRvTarget] = useState<string | null>(null);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  const openReview = (id: string) => { setRvTarget(id); setTab('review'); };

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'goals' && <PfGoals />}
      {active === 'team' && <PfTeam openReview={openReview} />}
      {active === 'review' && <PfReview target={rvTarget} setTarget={setRvTarget} />}
      {active === 'calib' && <PfCalib />}
      {active === 'praise' && <PfPraise />}
      {active === 'cycle' && <PfCycle />}
    </>
  );
}

registerModule({
  key: 'performance',
  title: TITLES.performance,
  subtitle: () => `${CUR_CYCLE.name} · goals, reviews, calibration and recognition`,
  Component: Performance,
});
