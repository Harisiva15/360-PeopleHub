import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { daysBetween, fmtD, TODAY, ymd } from '../../lib/dates';
import { inr, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';

import { courseOf } from '../../data/learning';
import type { Course, Enrollment } from '../../services';
import { DEPTS, deptOf } from '../../data/org';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { Chip, Divide, ListRow } from '../../components/common';
import { HBar } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import {
  useAllEmployees, useCourses, useEnrol, useEnrolments, useSetProgress, useVisiblePeople,
} from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const COMPLIANCE_DEADLINE = '2026-09-30';

const courseIcon = (c: Course) =>
  c.mandatory ? '🛡️' : c.cat === 'Certification' ? '🏅' : c.cat === 'Leadership' ? '🧭' : '📘';

/* ---------------- course player ---------------- */

function useCoursePlayer() {
  const layer = useLayer();

  return (en: Enrollment) => {
    const c = courseOf(en.courseId);
    layer.modal({
      title: c.t,
      sub: `${c.provider} · ${c.hrs} hours · ${c.cat}`,
      body: (close) => <Player en={en} close={close} />,
      footer: null,
    });
  };
}

function Player({ en, close }: { en: Enrollment; close: () => void }) {
  const app = useApp();
  const setProgress = useSetProgress();
  const [progress, setProgress_] = useState(en.progress);
    return (
      <>
        <Banner kind="info" icon="▶️">
          You are {en.progress}% through this course.
        </Banner>
        <Divide />
        <div className="field">
          <label>Mark progress</label>
          <input type="range" min={0} max={100} step={10} value={progress}
            style={{ width: '100%' }} onChange={(e) => setProgress_(+e.target.value)} />
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          Completing a course records a certificate on your profile and, for mandatory training, updates your
          compliance status.
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
          <button className="btn" onClick={close}>Close</button>
          <button className="btn primary" onClick={async () => {
            try {
              await setProgress.mutate(en.empId, en.courseId, progress);
              close();
              app.toast(progress === 100 ? 'Course completed — certificate issued 🏅' : 'Progress saved', 'ok');
            } catch (e) {
              app.toast(e instanceof Error ? e.message : 'Could not save your progress', 'err');
            }
          }}>Save progress</button>
        </div>
      </>
  );
}

/* ---------------- My learning ---------------- */

function LnMy() {
  const { data: COURSES = [] } = useCourses();
  const { data: ENROLL = [] } = useEnrolments();
  const enrol = useEnrol();
  const app = useApp();
  const play = useCoursePlayer();

  const doEnrol = async (courseId: string) => {
    try {
      await enrol.mutate(app.meId, courseId);
      app.toast('Enrolled in ' + courseOf(courseId).t, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not enrol you', 'err');
    }
  };

  const mine = ENROLL.filter((x) => x.empId === app.meId);
  const done = mine.filter((x) => x.status === 'Completed');
  const mand = mine.filter((x) => courseOf(x.courseId).mandatory);
  const hrs = sum(done, (x) => courseOf(x.courseId).hrs);
  const pending = mand.filter((x) => x.status !== 'Completed');

  return (
    <div className="stack">
      {pending.length > 0 && (
        <Banner kind="warn" icon="⚠️" title={`${pending.length} mandatory course(s) pending`}>
          Complete before 30 September — compliance training is tracked against your appraisal record.
        </Banner>
      )}

      <div className="grid g4">
        <Tile label="Courses completed" value={done.length} foot={`Out of ${mine.length} enrolled`} />
        <Tile label="Learning hours" value={hrs.toFixed(1) + ' h'} foot="This financial year" />
        <Tile label="Compliance" value={pct(mand.filter((x) => x.status === 'Completed').length, Math.max(1, mand.length)) + '%'}
          foot={`${mand.filter((x) => x.status === 'Completed').length} of ${mand.length} mandatory done`} />
        <Tile label="Learning wallet" value={inr(40000)} foot="Annual entitlement" />
      </div>

      <div className="grid g-2-1">
        <Card title="My courses" sub={`${mine.length} enrolled`} flush>
          {mine.length ? sortBy(mine, (x) => (x.status === 'Completed' ? 1 : 0)).map((x) => {
            const c = courseOf(x.courseId);
            return (
              <ListRow key={x.courseId} style={{ alignItems: 'flex-start' }}>
                <div style={{ fontSize: 17 }}>{courseIcon(c)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 13 }}>
                    {c.t}{c.mandatory && <> <Badge kind="warn">Mandatory</Badge></>}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {c.cat} · {c.hrs} h · {c.provider}{c.due ? ` · due ${fmtD(c.due)}` : ''}
                  </div>
                  <div className="bar" style={{ marginTop: 6 }}>
                    <i style={{ width: x.progress + '%', background: x.progress === 100 ? 'var(--good)' : 'var(--brand)' }} />
                  </div>
                </div>
                <div className="right" style={{ minWidth: 96 }}>
                  {x.status === 'Completed' ? (
                    <>
                      <Badge kind="good">Completed</Badge>
                      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>Score {x.score}%</div>
                    </>
                  ) : (
                    <button className="btn sm primary" onClick={() => play(x)}>
                      {x.progress ? 'Resume' : 'Start'}
                    </button>
                  )}
                </div>
              </ListRow>
            );
          }) : <EmptyState msg="Nothing enrolled yet — browse the catalogue" icon="🎓" />}
        </Card>

        <div className="stack">
          <Card title="Certificates" sub={`${done.length} earned`} flush>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              {done.length ? done.map((x) => (
                <ListRow key={x.courseId} onClick={() => app.toast(`Certificate for "${courseOf(x.courseId).t}" downloaded`, 'ok')}>
                  <span>🏅</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{courseOf(x.courseId).t}</div>
                    <div className="muted" style={{ fontSize: 11 }}>Completed {fmtD(x.completedOn)}</div>
                  </div>
                  <span className="muted">⤓</span>
                </ListRow>
              )) : <EmptyState msg="No certificates yet" />}
            </div>
          </Card>

          <Card title="Recommended for you" sub="Based on your role and goals" flush>
            {COURSES.filter((c) => !mine.some((m) => m.courseId === c.id)).slice(0, 5).map((c) => (
              <ListRow key={c.id}>
                <span>📗</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{c.t}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{c.cat} · {c.hrs} h</div>
                </div>
                <button className="btn sm" onClick={() => doEnrol(c.id)}>Enrol</button>
              </ListRow>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Catalogue ---------------- */

function LnCat() {
  const { data: COURSES = [] } = useCourses();
  const { data: ENROLL = [] } = useEnrolments();
  const app = useApp();
  const play = useCoursePlayer();
  const enrol = useEnrol();
  const [f, setF] = useState('');

  const doEnrol = async (courseId: string) => {
    try {
      await enrol.mutate(app.meId, courseId);
      app.toast('Enrolled in ' + courseOf(courseId).t, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not enrol you', 'err');
    }
  };

  const cats = uniq(COURSES.map((c) => c.cat));
  const list = f ? COURSES.filter((c) => c.cat === f) : COURSES;

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="row wrap" style={{ gap: 6 }}>
          <button className={'chip x' + (f === '' ? ' on' : '')} onClick={() => setF('')}>All ({COURSES.length})</button>
          {cats.map((c) => (
            <button key={c} className={'chip x' + (f === c ? ' on' : '')} onClick={() => setF(c)}>
              {c} ({COURSES.filter((x) => x.cat === c).length})
            </button>
          ))}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' }}>
        {list.map((c) => {
          const en = ENROLL.find((x) => x.empId === app.meId && x.courseId === c.id);
          return (
            <Card key={c.id}>
              <div className="row" style={{ gap: 9, marginBottom: 9 }}>
                <div style={{ fontSize: 22 }}>{courseIcon(c)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{c.t}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{c.provider}</div>
                </div>
              </div>
              <div className="row wrap" style={{ gap: 5, marginBottom: 11 }}>
                <Chip>{c.cat}</Chip>
                <Chip>{c.hrs} h</Chip>
                {c.mandatory && <Badge kind="warn">Mandatory</Badge>}
              </div>
              {en ? (
                <>
                  <div className="bar" style={{ marginBottom: 9 }}><i style={{ width: en.progress + '%' }} /></div>
                  {en.status === 'Completed'
                    ? <Badge kind="good">Completed · {en.score}%</Badge>
                    : <button className="btn sm primary" style={{ width: '100%' }} onClick={() => play(en)}>Continue ({en.progress}%)</button>}
                </>
              ) : (
                <button className="btn sm" style={{ width: '100%' }} onClick={() => doEnrol(c.id)}>Enrol</button>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Compliance tracker ---------------- */

function LnComp() {
  const { data: COURSES = [] } = useCourses();
  const { data: ENROLL = [] } = useEnrolments();
  const { data: everyone = [] } = useAllEmployees();
  const dir = useVisiblePeople();
  const app = useApp();
  const showEmp = useShowEmployee();
  const mand = COURSES.filter((c) => c.mandatory);
  const active = everyone;

  const rows = active.map((e) => {
    const done = mand.filter((c) => ENROLL.some((x) => x.empId === e.id && x.courseId === c.id && x.status === 'Completed')).length;
    return { e, done, pct: pct(done, mand.length) };
  });
  const laggards = sortBy(rows.filter((r) => r.pct < 100), (r) => r.pct);

  const byDept = DEPTS.map((d) => {
    const es = rows.filter((r) => r.e.dept === d.id);
    return { k: d.name, c: d.color, v: es.length ? Math.round(sum(es, (r) => r.pct) / es.length) : 0 };
  }).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Overall compliance" value={Math.round(sum(rows, (r) => r.pct) / Math.max(1, rows.length)) + '%'}
          foot={`Across ${mand.length} mandatory courses`} />
        <Tile label="Fully compliant" value={`${rows.filter((r) => r.pct === 100).length} / ${rows.length}`} foot="All mandatory training done" />
        <Tile label="Not started" value={rows.filter((r) => r.pct === 0).length} foot="Zero mandatory courses completed" />
        <Tile label="Deadline" value="30 Sep 2026" foot={`${daysBetween(ymd(TODAY), COMPLIANCE_DEADLINE)} days remaining`} />
      </div>

      <div className="grid g-2-1">
        <Card title="Employees below 100%" sub={`${laggards.length} people`} flush
          actions={<button className="btn sm" onClick={() => app.toast('Reminder emails sent to all employees below 100%', 'ok')}>📧 Send reminders</button>}>
          <div style={{ maxHeight: 520, overflow: 'auto' }} className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Department</th><th>Manager</th><th className="num">Completed</th><th style={{ minWidth: 120 }}>Progress</th></tr>
              </thead>
              <tbody>
                {laggards.map((r) => (
                  <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                    <td><PersonCell e={r.e} /></td>
                    <td className="nowrap">{deptOf(r.e.dept).name}</td>
                    <td className="nowrap">{dir.name(r.e.managerId || '')}</td>
                    <td className="num">{r.done} / {mand.length}</td>
                    <td>
                      <div className="row" style={{ gap: 7 }}>
                        <div className="bar" style={{ flex: 1 }}>
                          <i style={{ width: r.pct + '%', background: r.pct >= 66 ? 'var(--s1)' : r.pct >= 33 ? 'var(--warn)' : 'var(--crit)' }} />
                        </div>
                        <span className="mono">{r.pct}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Compliance by department" sub="Average completion">
          <HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => v + '%'} />
          <Divide />
          <div className="stack" style={{ gap: 9 }}>
            {mand.map((c) => {
              const n = active.filter((e) => ENROLL.some((x) => x.empId === e.id && x.courseId === c.id && x.status === 'Completed')).length;
              return (
                <div key={c.id}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{c.t}</span>
                    <span className="mono">{n}/{active.length}</span>
                  </div>
                  <div className="bar"><i style={{ width: pct(n, active.length) + '%' }} /></div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Team progress ---------------- */

function LnTeam() {
  const { data: COURSES = [] } = useCourses();
  const { data: ENROLL = [] } = useEnrolments();
  const dir = useVisiblePeople();
  const showEmp = useShowEmployee();
  const ids = dir.ids;

  const rows = dir.list.map((e) => {
    const en = ENROLL.filter((x) => x.empId === e.id);
    return {
      e,
      enrolled: en.length,
      done: en.filter((x) => x.status === 'Completed').length,
      hrs: sum(en.filter((x) => x.status === 'Completed'), (x) => courseOf(x.courseId).hrs),
    };
  });

  const popular = COURSES.map((c) => ({
    k: c.t, c: c.mandatory ? 'var(--s4)' : 'var(--s1)',
    v: ENROLL.filter((x) => ids.includes(x.empId) && x.courseId === c.id).length,
  })).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Learning hours" value={Math.round(sum(rows, (r) => r.hrs)) + ' h'} foot="Completed by the team" />
        <Tile label="Avg per person" value={(sum(rows, (r) => r.hrs) / Math.max(1, rows.length)).toFixed(1) + ' h'} foot="Target 24 h per year" />
        <Tile label="Courses completed" value={sum(rows, (r) => r.done)} foot={`Across ${rows.length} people`} />
        <Tile label="Active learners" value={rows.filter((r) => r.enrolled > 3).length} foot="More than 3 enrolments" />
      </div>

      <div className="grid g-2-1">
        <Card title="Team learning" sub={`${rows.length} people`} flush
          actions={<button className="btn sm" onClick={() =>
            downloadCSV('learning.csv',
              [['Emp Code', 'Name', 'Course', 'Category', 'Mandatory', 'Status', 'Progress %', 'Completed on', 'Score']].concat(
                ENROLL.filter((x) => ids.includes(x.empId)).map((x) => {
                  const e = dir.byId(x.empId)!;
                  const c = courseOf(x.courseId);
                  return [e.code, e.name, c.t, c.cat, c.mandatory ? 'Yes' : 'No', x.status,
                    String(x.progress), x.completedOn || '', String(x.score ?? '')];
                }),
              ))}>⤓ Export</button>}>
          <div className="tbl-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Employee</th><th className="num">Enrolled</th><th className="num">Completed</th><th className="num">Hours</th></tr></thead>
              <tbody>
                {sortBy(rows, (r) => -r.hrs).map((r) => (
                  <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                    <td><PersonCell e={r.e} /></td>
                    <td className="num">{r.enrolled}</td>
                    <td className="num">{r.done}</td>
                    <td className="num strong">{r.hrs.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Most popular courses" sub="Enrolments">
          <HBar rows={sortBy(popular, (r) => -r.v).slice(0, 10)} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'my' | 'cat' | 'comp' | 'team';

function Learning() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'my', label: 'My Learning' }, { v: 'cat', label: 'Course Catalogue' }]
    : [
        { v: 'my', label: 'My Learning' }, { v: 'cat', label: 'Course Catalogue' },
        { v: 'comp', label: 'Compliance Tracker' }, { v: 'team', label: 'Team Progress' },
      ];

  const [tab, setTab] = useState<Tab>('my');
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'my' && <LnMy />}
      {active === 'cat' && <LnCat />}
      {active === 'comp' && <LnComp />}
      {active === 'team' && <LnTeam />}
    </>
  );
}

registerModule({
  key: 'learning',
  title: TITLES.learning,
  /* Static: the registry's callbacks are synchronous and cannot await. */
  subtitle: () => 'Catalogue, certifications and compliance training tracked to completion',
  Component: Learning,
});
