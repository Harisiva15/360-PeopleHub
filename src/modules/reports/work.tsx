import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, daysBetween, fmtDS, mondayOf, TODAY, ymd } from '../../lib/dates';
import { lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { CANDS, SOURCES, STAGES } from '../../data/ats';
import { ACTIVE, EMAP, empName } from '../../data/employees';
import { DEPTS, deptOf, PROJECTS, projOf } from '../../data/org';
import { TS } from '../../data/timesheet';
import { CUR_CYCLE, GOALS, NINEBOX, POTENTIAL, PRAISE, RATINGS, REVIEWS, VALUES } from '../../data/performance';
import { tCat, TICKET_CATS, TICKETS } from '../../data/helpdesk';
import { ENPS_HISTORY, SURVEYS } from '../../data/engagement';
import { COURSES, ENROLL } from '../../data/learning';
import { HBar, Legend, LineChart, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Card, PersonCell, Table, TableWrap, Tile } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { hiringScope, reqScope } from '../hiring';
import { RepHead } from './shared';

/* ---------- Hiring effectiveness ---------- */

export function RepHiring() {
  const app = useApp();
  const cands = hiringScope(app.role, app.meId, CANDS);
  const reqs = reqScope(app.role, app.meId);
  const openReqs = reqs.filter((r) => r.status === 'Open');
  const today = ymd(TODAY);

  /* Each funnel row counts everyone who reached that stage or moved past it. */
  const stages = STAGES.filter((s) => s.id !== 'rejected');
  const funnel: HBarRow[] = stages.map((s, i) => ({
    k: s.name,
    c: s.color,
    v: cands.filter((c) => STAGES.findIndex((x) => x.id === c.stage) >= i && c.stage !== 'rejected').length,
  }));

  const bySource: HBarRow[] = SOURCES.map((s, i) => ({ k: s, c: PAL[i % 8], v: cands.filter((c) => c.source === s).length }));
  const quality: HBarRow[] = SOURCES.map((s, i) => ({
    k: s,
    c: PAL[i % 8],
    v: pct(
      cands.filter((c) => c.source === s && (c.stage === 'hired' || c.stage === 'offer')).length,
      Math.max(1, cands.filter((c) => c.source === s).length)
    ),
  })).filter((r) => r.v);

  const ageing: HBarRow[] = sortBy(
    openReqs.map((r) => ({
      k: r.title.slice(0, 32),
      v: daysBetween(r.openedOn, today),
      c: r.priority === 'Critical' ? 'var(--crit)' : r.priority === 'High' ? 'var(--s2)' : 'var(--s1)',
    })),
    (r) => -r.v
  ).slice(0, 10);

  const interviewed = cands.filter((c) => ['tech', 'manager', 'hr', 'offer', 'hired'].includes(c.stage)).length;
  const offered = cands.filter((c) => c.offer);

  const exportCSV = () =>
    downloadCSV('report_hiring.csv', [
      ['Requisition', 'Title', 'Department', 'Openings', 'Filled', 'Applicants', 'In pipeline', 'Age (days)', 'Status'],
      ...reqs.map((r) => {
        const cs = CANDS.filter((c) => c.reqId === r.id);
        return [
          r.id,
          r.title,
          deptOf(r.dept).name,
          r.openings,
          r.filled,
          cs.length,
          cs.filter((c) => !['hired', 'rejected'].includes(c.stage)).length,
          daysBetween(r.openedOn, today),
          r.status,
        ];
      }),
    ]);

  return (
    <>
      <RepHead
        title="Hiring Effectiveness"
        sub={`${cands.length} candidates · ${openReqs.length} open requisitions`}
        onExport={exportCSV}
      />
      <div className="stack">
        <div className="grid g4">
          <Tile
            label="Positions open"
            value={sum(openReqs, (r) => r.openings - r.filled)}
            foot={`${openReqs.length} live requisitions`}
          />
          <Tile
            label="Applicant → hire"
            value={pct(cands.filter((c) => c.stage === 'hired').length, Math.max(1, cands.length)) + '%'}
            foot="Overall conversion"
          />
          <Tile
            label="Interview → offer"
            value={pct(offered.length, Math.max(1, interviewed)) + '%'}
            foot="Post-interview conversion"
          />
          <Tile
            label="Offer acceptance"
            value={pct(offered.filter((c) => c.offer!.status === 'Accepted').length, Math.max(1, offered.length)) + '%'}
            foot="Accepted / rolled out"
          />
        </div>

        <div className="grid g2">
          <Card title="Funnel" sub="Candidates at or beyond each stage">
            <HBar rows={funnel} />
          </Card>
          <Card title="Source effectiveness" sub="% reaching offer or hire">
            <HBar rows={sortBy(quality, (r) => -r.v)} fmt={(v) => v + '%'} />
          </Card>
        </div>

        <div className="grid g2">
          <Card title="Applicants by source" sub={`${cands.length} total`}>
            <HBar rows={sortBy(bySource, (r) => -r.v)} />
          </Card>
          <Card title="Requisition ageing" sub="Days since opened">
            <HBar rows={ageing} fmt={(v) => v + ' d'} />
          </Card>
        </div>
      </div>
    </>
  );
}

/* ---------- Timesheet utilisation ---------- */

const billableHours = (t: (typeof TS)[number]) =>
  sum(t.rows.filter((r) => projOf(r.proj).billable), (r) => sum(r.h));

export function RepUtil() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const ids = app.visibleIds();
  const inScope = new Set(ids);

  const weeks: string[] = [];
  for (let w = 11; w >= 0; w--) weeks.push(ymd(mondayOf(addDays(TODAY, -w * 7))));

  const mine = TS.filter((t) => inScope.has(t.empId));
  const totals = weeks.map((ws) => sum(mine.filter((t) => t.weekStart === ws), (t) => t.total));
  const bill = weeks.map((ws) => sum(mine.filter((t) => t.weekStart === ws), billableHours));

  const byProj: HBarRow[] = PROJECTS.map((p) => ({
    k: p.name,
    c: p.color,
    v: sum(mine, (t) => sum(t.rows.filter((r) => r.proj === p.id), (r) => sum(r.h))),
  })).filter((r) => r.v);

  const perPerson = sortBy(
    ids
      .map((id) => {
        const ts = TS.filter((t) => t.empId === id && t.weekStart >= weeks[8]);
        const h = sum(ts, (t) => t.total);
        const b = sum(ts, billableHours);
        return { e: EMAP[id], h, b, u: pct(b, Math.max(1, h)) };
      })
      .filter((r) => r.h),
    (r) => -r.u
  );

  const submitted = mine.filter((t) => ['Submitted', 'Approved'].includes(t.status)).length;

  const exportCSV = () =>
    downloadCSV('report_utilisation.csv', [
      ['Emp Code', 'Name', 'Department', 'Hours (12w)', 'Billable (12w)', 'Utilisation %'],
      ...ids.map((i) => {
        const e = EMAP[i];
        const ts = TS.filter((t) => t.empId === i);
        const h = sum(ts, (t) => t.total);
        const b = sum(ts, billableHours);
        return [e.code, e.name, deptOf(e.dept).name, h, b, pct(b, Math.max(1, h))];
      }),
    ]);

  const series = [
    { name: 'Total', color: 'var(--s1)', data: totals },
    { name: 'Billable', color: 'var(--s3)', data: bill },
  ];

  return (
    <>
      <RepHead title="Timesheet Utilisation" sub={`Last 12 weeks · ${ids.length} employees`} onExport={exportCSV} />
      <div className="stack">
        <div className="grid g4">
          <Tile label="Hours logged" value={sum(totals).toLocaleString('en-IN') + ' h'} foot="Across 12 weeks" />
          <Tile
            label="Billable hours"
            value={sum(bill).toLocaleString('en-IN') + ' h'}
            foot={`${pct(sum(bill), Math.max(1, sum(totals)))}% of logged time`}
          />
          <Tile
            label="Avg weekly hours"
            value={(sum(totals) / 12 / Math.max(1, ids.length)).toFixed(1) + ' h'}
            foot="Per employee"
          />
          <Tile
            label="Timesheet compliance"
            value={pct(submitted, Math.max(1, mine.length)) + '%'}
            foot="Submitted on time"
          />
        </div>

        <Card title="Billable vs total hours" sub="Weekly, last 12 weeks">
          <LineChart labels={weeks.map((w) => fmtDS(w))} height={240} area fmt={(v) => v + ' h'} series={series} />
          <Legend items={[{ k: 'Total hours', c: 'var(--s1)' }, { k: 'Billable hours', c: 'var(--s3)' }]} />
        </Card>

        <div className="grid g2">
          <Card title="Effort by project" sub="All logged hours">
            <HBar rows={sortBy(byProj, (r) => -r.v)} fmt={(v) => v + ' h'} />
          </Card>
          <Card title="Utilisation by person" sub="Top 15 · last 4 weeks" flush>
            <div style={{ maxHeight: 400, overflow: 'auto' }}>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="num">Hours</th>
                      <th className="num">Billable</th>
                      <th className="num">Utilisation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perPerson.slice(0, 15).map((r) => (
                      <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                        <td><PersonCell e={r.e} /></td>
                        <td className="num">{r.h}</td>
                        <td className="num">{r.b}</td>
                        <td className="num"><b>{r.u}%</b></td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ---------- Performance & talent ---------- */

export function RepTalent() {
  const app = useApp();
  const showEmp = useShowEmployee();
  const ids = app.visibleIds();
  const inScope = new Set(ids);

  const g = GOALS.filter((x) => inScope.has(x.empId));
  const rv = REVIEWS.filter((r) => inScope.has(r.empId) && r.manager.rating);
  const dist: HBarRow[] = RATINGS.map((r) => ({
    k: r.v + ' — ' + r.label,
    c: r.c,
    v: rv.filter((x) => x.manager.rating === r.v).length,
  }));
  const byDept: HBarRow[] = DEPTS.map((d) => {
    const dg = g.filter((x) => EMAP[x.empId] && EMAP[x.empId].dept === d.id);
    return { k: d.name, c: d.color, v: Math.round(sum(dg, (x) => x.progress * x.weight) / Math.max(1, sum(dg, (x) => x.weight))) };
  }).filter((r) => r.v);
  const byCat: HBarRow[] = uniq(g.map((x) => x.category)).map((c, i) => ({
    k: c,
    c: PAL[i % 8],
    v: g.filter((x) => x.category === c).length,
  }));
  const praiseByValue: HBarRow[] = VALUES.map((v) => ({ k: v.k, c: v.c, v: PRAISE.filter((p) => p.value === v.k).length }));
  const hikeCost = sum(rv.filter((r) => r.final), (r) => (EMAP[r.empId].ctc * r.final!.hike) / 100);
  const goalPct = Math.round(sum(g, (x) => x.progress * x.weight) / Math.max(1, sum(g, (x) => x.weight)));

  const exportCSV = () =>
    downloadCSV('report_talent.csv', [
      ['Emp Code', 'Name', 'Department', 'Goal %', 'Self rating', 'Manager rating', 'Potential', 'Increment %'],
      ...REVIEWS.filter((r) => inScope.has(r.empId)).map((r) => {
        const e = EMAP[r.empId];
        return [
          e.code,
          e.name,
          deptOf(e.dept).name,
          r.goalAchievement,
          r.self.rating || '',
          r.manager.rating || '',
          POTENTIAL.find((p) => p.v === r.potential)?.label || '',
          r.final ? r.final.hike : '',
        ];
      }),
    ]);

  return (
    <>
      <RepHead
        title="Performance & Talent"
        sub={`${CUR_CYCLE.name} · ${ids.length} employees in scope`}
        onExport={exportCSV}
      />
      <div className="stack">
        <div className="grid g4">
          <Tile label="Goal achievement" value={goalPct + '%'} foot={`${g.length} goals, weighted`} />
          <Tile
            label="Reviews complete"
            value={`${rv.length} / ${ids.length}`}
            foot={`${pct(rv.length, Math.max(1, ids.length))}% manager ratings in`}
          />
          <Tile
            label="Average rating"
            value={(sum(rv, (r) => r.manager.rating || 0) / Math.max(1, rv.length)).toFixed(2)}
            foot="Target band 3.10 – 3.40"
          />
          <Tile label="Increment commitment" value={lakh(hikeCost)} foot={`Annualised, pool ${CUR_CYCLE.hikePool}%`} />
        </div>

        <div className="grid g2">
          <Card title="Rating distribution" sub="Against the target curve">
            <HBar rows={dist} />
          </Card>
          <Card title="Goal achievement by department" sub="Weighted average">
            <HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => v + '%'} />
          </Card>
        </div>

        <div className="grid g2">
          <Card title="Goals by category" sub="What the company is optimising for">
            <HBar rows={sortBy(byCat, (r) => -r.v)} />
          </Card>
          <Card title="Recognition by value" sub={`${PRAISE.length} shout-outs`}>
            <HBar rows={sortBy(praiseByValue, (r) => -r.v)} />
          </Card>
        </div>

        <Card title="Talent review" sub="Rating, potential and 9-box placement" flush>
          <div style={{ maxHeight: 460, overflow: 'auto' }}>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th className="num">Goal %</th>
                    <th className="num">Self</th>
                    <th className="num">Manager</th>
                    <th>Potential</th>
                    <th>9-box</th>
                    <th className="num">Increment</th>
                  </tr>
                </thead>
                <tbody>
                  {sortBy(rv, (r) => -(r.manager.rating || 0))
                    .slice(0, 60)
                    .map((r) => {
                      const e = EMAP[r.empId];
                      const rating = r.manager.rating!;
                      const perf = rating >= 4 ? 3 : rating === 3 ? 2 : 1;
                      const box = NINEBOX[perf + '-' + r.potential];
                      return (
                        <tr key={r.id} className="clickable" onClick={() => showEmp(e.id)}>
                          <td><PersonCell e={e} /></td>
                          <td className="nowrap">{deptOf(e.dept).name}</td>
                          <td className="num">{r.goalAchievement}</td>
                          <td className="num">{r.self.rating || '—'}</td>
                          <td className="num"><b>{rating}</b></td>
                          <td>{POTENTIAL.find((p) => p.v === r.potential)?.label || '—'}</td>
                          <td>
                            <span
                              className="badge"
                              style={{
                                background: `color-mix(in srgb, ${box.c} 14%, transparent)`,
                                color: box.c,
                                borderColor: `color-mix(in srgb, ${box.c} 32%, transparent)`,
                              }}
                            >
                              {box.n}
                            </span>
                          </td>
                          <td className="num">{r.final ? '+' + r.final.hike + '%' : '—'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        </Card>
      </div>
    </>
  );
}

/* ---------- Helpdesk & engagement ---------- */

export function RepService() {
  const t = TICKETS;
  const resolved = t.filter((x) => x.resolutionHrs != null);
  const rated = t.filter((x) => x.csat);
  const byCat: HBarRow[] = TICKET_CATS.map((c, i) => {
    const ts = resolved.filter((x) => x.cat === c.id);
    return { k: c.n, c: PAL[i % 8], v: ts.length ? Math.round(sum(ts, (x) => x.resolutionHrs!) / ts.length) : 0 };
  }).filter((r) => r.v);

  const pulse = SURVEYS.find((s) => s.id === 'SV1')!;
  const questions = pulse.questions || [];
  const mand = COURSES.filter((c) => c.mandatory);
  const courseCompletion = (courseId: string) =>
    pct(ACTIVE().filter((e) => ENROLL.some((x) => x.empId === e.id && x.courseId === courseId && x.status === 'Completed')).length, ACTIVE().length);
  const compliance = Math.round(sum(mand, (c) => courseCompletion(c.id)) / mand.length);

  const exportCSV = () =>
    downloadCSV('report_service.csv', [
      ['Ticket', 'Category', 'Raised by', 'Priority', 'Status', 'Resolution hrs', 'SLA breached', 'CSAT'],
      ...t.map((x) => [
        x.id,
        tCat(x.cat).n,
        empName(x.empId),
        x.priority,
        x.status,
        x.resolutionHrs || '',
        x.breached ? 'Yes' : 'No',
        x.csat || '',
      ]),
    ]);

  return (
    <>
      <RepHead title="Helpdesk & Engagement" sub="Employee service quality and sentiment" onExport={exportCSV} />
      <div className="stack">
        <div className="grid g5">
          <Tile label="Tickets raised" value={t.length} foot="Last 45 days" />
          <Tile
            label="SLA compliance"
            value={pct(resolved.filter((x) => !x.breached).length, Math.max(1, resolved.length)) + '%'}
            foot="Target 90%"
          />
          <Tile
            label="CSAT"
            value={(sum(rated, (x) => x.csat!) / Math.max(1, rated.length)).toFixed(1) + ' / 5'}
            foot={`${rated.length} rated`}
          />
          <Tile
            label="Engagement score"
            value={(sum(questions, (q) => q.score) / Math.max(1, questions.length)).toFixed(2) + ' / 5'}
            foot={`${pct(pulse.responded, pulse.sent)}% response rate`}
          />
          <Tile label="Training compliance" value={compliance + '%'} foot={`${mand.length} mandatory courses`} />
        </div>

        <div className="grid g2">
          <Card title="Average resolution time" sub="Hours, by category">
            <HBar rows={sortBy(byCat, (r) => -r.v)} fmt={(v) => v + ' h'} />
          </Card>
          <Card title="Engagement drivers" sub="Score out of 5">
            <HBar
              rows={questions.map((q) => ({
                k: q.q,
                c: q.score >= 4.2 ? 'var(--s6)' : q.score >= 3.8 ? 'var(--s1)' : 'var(--s4)',
                v: q.score,
              }))}
              fmt={(v) => v.toFixed(1)}
            />
          </Card>
        </div>

        <div className="grid g2">
          <Card title="eNPS trend" sub="Last 4 quarters">
            <LineChart
              labels={ENPS_HISTORY.map((x) => x.k)}
              height={200}
              padLeft={34}
              area
              series={[{ name: 'eNPS', color: 'var(--s1)', data: ENPS_HISTORY.map((x) => x.v) }]}
            />
          </Card>
          <Card title="Compliance training by course" sub="% of employees complete">
            <HBar rows={mand.map((c, i) => ({ k: c.t, c: PAL[i], v: courseCompletion(c.id) }))} fmt={(v) => v + '%'} />
          </Card>
        </div>
      </div>
    </>
  );
}

