import { sortBy, sum } from '../../lib/collections';
import { addDays, daysBetween, fmtD, fmtDS, fmtTime, monthKey, monthLabel, monthLabelLong, mondayOf, TODAY, ymd } from '../../lib/dates';
import { inr, lakh, pct } from '../../lib/format';

import { STAGES } from '../../data/ats';

import { countryOf, money } from '../../data/countries';


import { DEPTS, ltOf, ORG, PROJECTS, projOf, siteOf, SITES } from '../../data/org';





import { tCat } from '../../data/helpdesk';



import { Badge, Card, EmptyState, KV, Tile } from '../../components/ui';
import { Avatar, PersonCell } from '../../components/ui';
import { Chip, Dot, Divide, ListRow, StatusBadge } from '../../components/common';
import { BarChart, Donut, HBar, Legend, LineChart, PAL, Ring, Spark } from '../../components/charts';
import { PunchWidget } from '../attendance/Punch';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useApp } from '../../state/AppContext';
import {
  ApprovalSummary, attendanceToday, attendanceTrend, CelebRows, GoLink,
  headcountTrend, joinersExits, MonthCalendar,
} from './shared';
import {
  useAllEmployees, useAnnouncements, useAttendanceIn, useCandidates, useCelebrations,
  useClaimsIn, useCompliancePayments, useCourses, useCurrentCycle, useCurrentRun,
  useDeclarations, useEnrolments, useExits, useGoals, useLeaveIn, useMyAttendance,
  useMyBalances, usePayRuns, usePayrollTotals, usePayslipHistory, usePendingCount,
  useRequisitions,
  useSurveys, useTeam, useTickets, useTimesheetsIn,
} from './data';
import type { Directory } from './data';

/** Build a directory view over an already-fetched roster. */
const asDirectory = (list: { id: string; name: string }[]): Directory => ({
  list: list as never,
  ids: list.map((e) => e.id),
  byId: (id) => list.find((e) => e.id === id) as never,
  name: (id) => list.find((e) => e.id === id)?.name ?? '—',
  loading: false,
});

/* ---------------- admin ---------------- */

function DashAdmin() {
  const today = ymd(TODAY);
  const { data: pendingTotal = 0 } = usePendingCount();
  const { data: act = [] } = useAllEmployees();
  const { data: leavers = [] } = useExits();
  const ids = act.map((e) => e.id);
  const dir = asDirectory(act);

  const { data: todayRecs = [] } = useAttendanceIn(ids, today, today);
  const { data: sixMonths = [] } = useAttendanceIn(ids, ymd(addDays(TODAY, -190)), today);
  const { data: runs = [] } = usePayRuns();
  const { data: curRun } = useCurrentRun();
  const { data: run } = usePayrollTotals(curRun?.mk ?? '');
  const { data: reqs = [] } = useRequisitions();
  const { data: cands = [] } = useCandidates();
  const { data: cel = [] } = useCelebrations(14);
  const { data: goals = [] } = useGoals(ids);
  const { data: cycle } = useCurrentCycle();
  const { data: surveys = [] } = useSurveys();
  const { data: tickets = [] } = useTickets();
  const { data: claims = [] } = useClaimsIn(ids);
  const { data: courses = [] } = useCourses();
  const { data: enrolments = [] } = useEnrolments();
  const { data: compliance = [] } = useCompliancePayments();
  const { data: announcements = [] } = useAnnouncements();

  const at = attendanceToday(todayRecs);
  const present = at.c.P + at.c.W;
  const working = at.total - at.c.H - at.c.O;
  /* Leavers still count towards the months they were employed in. */
  const roster = [...act, ...(leavers.map((x) => dir.byId(x.empId)).filter(Boolean) as typeof act)];
  const ht = headcountTrend(8, act);

  const openReq = reqs.filter((r) => r.status === 'Open');
  const openings = sum(openReq, (r) => Math.max(0, r.openings - r.filled));
  const exitsYear = leavers.filter((x) => x.lwd >= ymd(addDays(TODAY, -365)));
  const attrition = pct(exitsYear.length, act.length + exitsYear.length);
  if (!curRun || !run || runs.length < 2) return <EmptyState msg="Loading your dashboard…" icon="◧" />;
  const CUR_RUN = curRun;
  /* eNPS comes from the quarterly survey, not a stored figure. */
  const enpsSurvey = surveys.find((x) => x.id === 'SV2');
  const enps = enpsSurvey
    ? Math.round(((enpsSurvey.promoters ?? 0) - (enpsSurvey.detractors ?? 0)) /
        Math.max(1, (enpsSurvey.promoters ?? 0) + (enpsSurvey.passives ?? 0) + (enpsSurvey.detractors ?? 0)) * 100)
    : 0;

  const byDept = DEPTS.map((d) => ({ k: d.name, v: act.filter((e) => e.dept === d.id).length, c: d.color }));
  const bySite = ['CHN', 'BLR', 'HYD'].map((s, i) => ({ k: siteOf(s).city, v: act.filter((e) => e.site === s).length, c: PAL[i] }));
  const pend = pendingTotal ?? 0;
  const funnel = STAGES.filter((s) => s.id !== 'rejected').map((s) => ({
    k: s.name, v: cands.filter((c) => c.stage === s.id).length, c: s.color,
  }));

  const trend = attendanceTrend(6, sixMonths);
  const je = joinersExits(8, roster);
  const lastRunMk = runs[runs.length - 2].mk;

  const donutSlices = [
    { k: 'In office', v: at.c.P, c: 'var(--s1)' },
    { k: 'Work from home', v: at.c.W, c: 'var(--s3)' },
    { k: 'On leave', v: at.c.L, c: 'var(--s4)' },
    { k: 'Absent', v: at.c.A, c: 'var(--s8)' },
  ];

  const mandatory = courses.filter((c) => c.mandatory);

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="Headcount" value={act.length} trend="up"
          foot={<>▲ {ht.data[7] - ht.data[4]} vs 3 months ago</>}
          spark={<Spark data={ht.data} color="var(--s1)" />} />
        <Tile label="Present today"
          value={<>{present} <span style={{ fontSize: 14, color: 'var(--ink-3)', fontWeight: 600 }}>/ {working}</span></>}
          foot={`${at.c.W} WFH · ${at.c.L} on leave · ${at.c.A} absent`} />
        <Tile label={'Net payable · ' + monthLabel(CUR_RUN.mk)} value={lakh(run.net)}
          foot={<><StatusBadge status={CUR_RUN.status} /> <span className="muted">{run.count} employees</span></>} />
        <Tile label="Open positions" value={openings}
          foot={`${openReq.length} live requisitions · ${cands.filter((c) => c.stage === 'offer').length} in offer`} />
        <Tile label="Attrition (12 mo)" value={attrition + '%'} foot={`${exitsYear.length} exits · industry avg 18%`} />
      </div>

      <div className="grid g-2-1">
        <Card title="Attendance rate" sub="Present + WFH as % of working days · last 6 months"
          actions={<Legend items={[{ k: 'Attendance %', c: 'var(--s1)' }, { k: 'WFH share %', c: 'var(--s3)' }]} />}>
          <LineChart labels={trend.labels} height={214} area fmt={(v) => v + '%'} tickFmt={(v) => v + '%'}
            series={[
              { name: 'Attendance', color: 'var(--s1)', data: trend.rate },
              { name: 'WFH share', color: 'var(--s3)', data: trend.wfh },
            ]} />
        </Card>

        <Card title="Today at a glance" sub={fmtD(TODAY)}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Donut size={150} slices={donutSlices} center={pct(present, Math.max(1, working)) + '%'} centerSub="present" />
            <div style={{ flex: 1, minWidth: 130 }}>
              <div className="legend" style={{ flexDirection: 'column', gap: 7 }}>
                {[
                  { k: 'In office', v: at.c.P, c: 'var(--s1)' },
                  { k: 'WFH', v: at.c.W, c: 'var(--s3)' },
                  { k: 'Leave', v: at.c.L, c: 'var(--s4)' },
                  { k: 'Absent', v: at.c.A, c: 'var(--s8)' },
                ].map((i) => (
                  <span key={i.k}><i style={{ background: i.c }} />{i.k} <b className="mono">{i.v}</b></span>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid g3">
        <Card title="Headcount by department" sub={`${act.length} active employees`}>
          <HBar rows={sortBy(byDept, (r) => -r.v)} />
        </Card>
        <Card title="Hiring funnel" sub={`${cands.length} candidates all-time`} actions={<GoLink to="hiring">Open ATS</GoLink>}>
          <HBar rows={funnel} />
        </Card>
        <Card title="Pending your action" sub={`${pend} items`} actions={<GoLink to="approvals">Review</GoLink>} flush>
          <ApprovalSummary />
        </Card>
      </div>

      <div className="grid g-2-1">
        <Card title="Headcount trend" sub="Joiners vs exits · last 8 months">
          <BarChart labels={je.lb} height={200}
            series={[
              { name: 'Joiners', color: 'var(--s3)', data: je.j },
              { name: 'Exits', color: 'var(--s8)', data: je.x },
            ]} />
          <Legend items={[{ k: 'Joiners', c: 'var(--s3)' }, { k: 'Exits', c: 'var(--s8)' }]} />
        </Card>
        <Card title="Celebrations" sub="Next 14 days" actions={<GoLink to="celebrations">All</GoLink>} flush>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <CelebRows list={cel.slice(0, 8)} dir={dir} />
          </div>
        </Card>
      </div>

      <div className="grid g4">
        <Tile label="Goal achievement"
          value={Math.round(sum(goals, (g) => g.progress * g.weight) / Math.max(1, sum(goals, (g) => g.weight))) + '%'}
          foot={`${goals.filter((g) => ['At Risk', 'Behind'].includes(g.status)).length} goals at risk · ${(cycle?.name ?? '').split(' Appraisal')[0]}`} />
        <Tile label="eNPS" value={'+' + enps} trend="up" foot="▲ 9 vs last quarter" />
        <Tile label="Open tickets" value={tickets.filter((t) => ['Open', 'In Progress'].includes(t.status)).length}
          foot={`${tickets.filter((t) => t.breached && ['Open', 'In Progress'].includes(t.status)).length} past SLA`} />
        <Tile label="Expenses pending"
          value={inr(sum(claims.filter((c) => ['Submitted', 'Approved'].includes(c.status)), (c) => c.total))}
          foot={`${claims.filter((c) => c.status === 'Submitted').length} claims awaiting approval`} />
      </div>

      <div className="grid g3">
        <Card title="Compliance training" sub="Mandatory courses" actions={<GoLink to="learning">Tracker</GoLink>}>
          <HBar fmt={(v) => v + '%'}
            rows={mandatory.map((c, i) => ({
              k: c.t, c: PAL[i],
              v: pct(act.filter((e) => enrolments.some((x) => x.empId === e.id && x.courseId === c.id && x.status === 'Completed')).length, Math.max(1, act.length)),
            }))} />
        </Card>

        <Card title="Statutory dues" sub={monthLabelLong(lastRunMk)} actions={<GoLink to="payroll">Pay</GoLink>} flush>
          {compliance.filter((c) => c.mk === lastRunMk).map((c) => (
            <ListRow key={c.type}>
              <Dot color={c.status === 'Paid' ? 'var(--good)' : c.status === 'Overdue' ? 'var(--crit)' : 'var(--warn)'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{c.name}</div>
                <div className="muted" style={{ fontSize: 11 }}>Due {fmtD(c.dueDate)}</div>
              </div>
              <span className="strong">{inr(c.amount)}</span>
            </ListRow>
          ))}
        </Card>

        <Card title="Exits in progress" sub={`${leavers.filter((x) => x.status !== 'Settled').length} employees`}
          actions={<GoLink to="exit">Manage</GoLink>} flush>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {leavers.length ? sortBy(leavers, (x) => x.lwd).slice(0, 6).map((x) => (
              <ListRow key={x.id}>
                <Avatar name={dir.name(x.empId)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(x.empId)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{x.reason} · LWD {fmtD(x.lwd)}</div>
                </div>
                <Badge kind="warn">{Math.max(0, daysBetween(ymd(TODAY), x.lwd))}d</Badge>
              </ListRow>
            )) : <EmptyState msg="No exits 🎉" />}
          </div>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Headcount by location" sub="Excludes full-time WFH">
          <HBar rows={bySite} />
          <Divide />
          <div className="row wrap" style={{ gap: 8 }}>
            {SITES.filter((s) => s.lat).map((s) => (
              <Chip key={s.id}>📍 {s.name} · {s.radius} m fence</Chip>
            ))}
          </div>
        </Card>

        <Card title="Latest announcements" sub={`${announcements.length} posts`} actions={<GoLink to="announcements">View all</GoLink>} flush>
          {announcements.slice(0, 4).map((a) => (
            <ListRow key={a.id}>
              <Badge kind="info">{a.tag}</Badge>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 13 }}>{a.title}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{a.by} · {fmtD(a.on)}</div>
              </div>
              {a.pin && <span title="Pinned">📌</span>}
            </ListRow>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- manager ---------------- */

const ATT_BADGE: Record<string, { kind: 'good' | 'info' | 'warn' | 'crit' | 'mute'; label: string }> = {
  P: { kind: 'good', label: 'Present' },
  W: { kind: 'info', label: 'WFH' },
  L: { kind: 'warn', label: 'On leave' },
  A: { kind: 'crit', label: 'Absent' },
  H: { kind: 'mute', label: 'Holiday' },
  O: { kind: 'mute', label: 'Week off' },
};

function DashManager() {
  const app = useApp();
  const me = app.me;
  const { data: team = [] } = useTeam(me.id);
  const dir = asDirectory(team);
  const ids = team.map((t) => t.id);

  const { data: teamLeave = [] } = useLeaveIn(ids);
  const { data: teamSheets = [] } = useTimesheetsIn(ids);
  const { data: teamAtt = [] } = useAttendanceIn(ids, ymd(addDays(TODAY, -35)), ymd(TODAY));
  const at = attendanceToday(teamAtt.filter((r) => r.date === ymd(TODAY)));
  const { data: cel = [] } = useCelebrations(21);
  const pendLeave = teamLeave.filter((l) => l.status === 'Pending');
  const pendTS = teamSheets.filter((t) => t.status === 'Submitted');
  const pendReg = teamAtt.filter((a) => a.reg && a.reg.status === 'Pending');
  const awaiting = pendLeave.length + pendTS.length + pendReg.length;

  const last4 = [];
  for (let w = 3; w >= 0; w--) {
    const ws = ymd(mondayOf(addDays(TODAY, -w * 7)));
    const sheets = teamSheets.filter((t) => t.weekStart === ws);
    last4.push({
      label: 'W' + (4 - w),
      hours: sum(sheets, (s) => s.total),
      billable: sum(sheets, (s) => sum(s.rows.filter((r) => projOf(r.proj).billable), (r) => sum(r.h))),
    });
  }

  const teamCel = cel.filter((c) => ids.includes(c.empId) || c.empId === me.id);
  const onLeaveSoon = teamLeave.filter(
    (l) => l.status === 'Approved' && ids.includes(l.empId) && l.from >= ymd(TODAY) && l.from <= ymd(addDays(TODAY, 21)),
  );

  const projRows = PROJECTS.map((p) => ({
    k: p.name, c: p.color,
    v: sum(
      teamSheets.filter((t) => t.weekStart >= ymd(mondayOf(addDays(TODAY, -21)))),
      (t) => sum(t.rows.filter((r) => r.proj === p.id), (r) => sum(r.h)),
    ),
  })).filter((r) => r.v > 0);

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <div><PunchWidget empId={me.id} /></div>
        <Card title="Awaiting you" sub={`${awaiting} items`}
          actions={<GoLink to="approvals">Review all</GoLink>} flush>
          <ApprovalSummary />
        </Card>
      </div>

      <div className="grid g4">
        <Tile label="Team size" value={team.length}
          foot={`${team.filter((t) => t.managerId === me.id).length} direct · ${team.length - team.filter((t) => t.managerId === me.id).length} skip-level`} />
        <Tile label="Present today" value={at.c.P + at.c.W} foot={`${at.c.W} WFH · ${at.c.L} leave · ${at.c.A} absent`} />
        <Tile label="Hours logged (4 wks)" value={sum(last4, (w) => w.hours) + ' h'}
          foot={Math.round((sum(last4, (w) => w.billable) / Math.max(1, sum(last4, (w) => w.hours))) * 100) + '% billable'}
          spark={<Spark data={last4.map((w) => w.hours)} color="var(--s3)" />} />
        <Tile label="Pending approvals" value={awaiting}
          foot={`${pendLeave.length} leave · ${pendTS.length} timesheets · ${pendReg.length} regularisations`} />
      </div>

      <div className="grid g-2-1">
        <Card title="Team attendance — today" sub={fmtD(TODAY)} actions={<GoLink to="attendance">Full log</GoLink>} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Mode</th><th>Geo</th></tr>
              </thead>
              <tbody>
                {team.map((t) => {
                  const r = teamAtt.find((a) => a.empId === t.id && a.date === ymd(TODAY));
                  const b = ATT_BADGE[r ? r.status : 'O'];
                  return (
                    <tr key={t.id}>
                      <td><PersonCell e={t} /></td>
                      <td><Badge kind={b.kind}>{b.label}</Badge></td>
                      <td className="mono">{r?.inT ? fmtTime(r.inT) : '—'}</td>
                      <td className="mono">{r?.outT ? fmtTime(r.outT) : '—'}</td>
                      <td>{r ? siteOf(r.site).name : '—'}</td>
                      <td>
                        {r && r.status === 'P'
                          ? <Badge kind={r.geoOk ? 'good' : 'crit'}>{r.geoOk ? '✓' : '⚠'} {r.dist} m</Badge>
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Team calendar" sub="Approved leave · next 3 weeks" flush>
          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {onLeaveSoon.length ? sortBy(onLeaveSoon, (l) => l.from).map((l) => (
              <ListRow key={l.id}>
                <Dot color={ltOf(l.type).color} />
                <Avatar name={dir.name(l.empId)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(l.empId)}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{ltOf(l.type).name} · {l.days} d</div>
                </div>
                <div className="right nowrap" style={{ fontSize: 11.5 }}>
                  {fmtDS(l.from)}{l.days > 1 ? ' – ' + fmtDS(l.to) : ''}
                </div>
              </ListRow>
            )) : <EmptyState msg="No approved leave in the next 3 weeks" icon="🗓" />}
          </div>
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Team effort by project" sub="Last 4 weeks · hours">
          {projRows.length ? <HBar rows={sortBy(projRows, (r) => -r.v)} fmt={(v) => v + ' h'} /> : <EmptyState msg="No hours logged yet" />}
        </Card>
        <Card title="Team celebrations" sub="Next 21 days" actions={<GoLink to="celebrations">All</GoLink>} flush>
          <div style={{ maxHeight: 280, overflow: 'auto' }}>
            <CelebRows list={teamCel.slice(0, 8)} dir={dir} />
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- employee ---------------- */

function DashEmployee() {
  const app = useApp();
  const me = app.me;
  const mk = monthKey(TODAY);

  const { data: monthRecs = [] } = useMyAttendance(me.id, mk + '-01', mk + '-31');
  const { data: mySheets = [] } = useTimesheetsIn([me.id]);
  const { data: history = [] } = usePayslipHistory(me.id);
  const { data: bals = [] } = useMyBalances(me.id);
  const { data: myLeaveRows = [] } = useLeaveIn([me.id]);
  const { data: cel = [] } = useCelebrations(14);
  const { data: decls = {} } = useDeclarations();
  const { data: myGoals = [] } = useGoals([me.id]);
  const { data: myTickets = [] } = useTickets([me.id]);
  const { data: everyone = [] } = useAllEmployees();
  const { data: myClaims = [] } = useClaimsIn([me.id]);
  const { data: courses = [] } = useCourses();
  const { data: myEnrolments = [] } = useEnrolments([me.id]);
  const { data: announcements = [] } = useAnnouncements();
  const dir = asDirectory(everyone);
  const recs = monthRecs;
  const work = recs.filter((r) => ['P', 'W', 'A', 'L'].includes(r.status));
  const present = recs.filter((r) => r.status === 'P' || r.status === 'W').length;
  const hrs = sum(recs, (r) => r.mins) / 60;

  const myTS = mySheets.find((t) => t.weekStart === ymd(mondayOf(TODAY)));
  const lastSlip = history[history.length - 1];
  const lastRun = lastSlip?.run;
  const ps = lastSlip?.payslip;

  const myLeaves = sortBy(myLeaveRows, (l) => l.from, 'desc').slice(0, 5);
  const dec = decls[me.id];

  const wk = [];
  for (let w = 7; w >= 0; w--) {
    const ws = ymd(mondayOf(addDays(TODAY, -w * 7)));
    const t = mySheets.find((x) => x.weekStart === ws);
    wk.push({ l: fmtDS(ws), v: t ? t.total : 0 });
  }

  const g = myGoals;
  const achv = Math.round(sum(g, (x) => x.progress * x.weight) / Math.max(1, sum(g, (x) => x.weight)));
  const tk = myTickets.filter((t) => ['Open', 'In Progress'].includes(t.status));
  const cl = myClaims.filter((c) => ['Submitted', 'Approved'].includes(c.status));
  const mand = courses.filter((c) => c.mandatory);
  const done = mand.filter((c) => myEnrolments.some((x) => x.courseId === c.id && x.status === 'Completed')).length;

  const ctry = countryOf(me.country);
  const m = (a: number) => money(a, me.ccy);

  return (
    <div className="stack">
      <div className="grid g-2-1">
        <div><PunchWidget empId={me.id} /></div>
        <Card title="This month" sub={monthLabelLong(mk)}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Ring value={pct(present, Math.max(1, work.length))} color="var(--s3)" size={96} />
            <div style={{ flex: 1 }}>
              <KV rows={[
                ['Present', `${present} / ${work.length} days`],
                ['Hours', hrs.toFixed(1) + ' h'],
                ['WFH', recs.filter((r) => r.status === 'W').length + ' days'],
                ['Leave', recs.filter((r) => r.status === 'L').length + ' days'],
              ]} />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid g4">
        <Tile label="Leave available"
          value={<>{sum(bals, (b) => b.avail).toFixed(1)} <span style={{ fontSize: 13, color: 'var(--ink-3)', fontWeight: 600 }}>days</span></>}
          foot={bals.map((b) => `${b.type} ${b.avail}`).slice(0, 3).join(' · ')} />
        <Tile label="This week" value={(myTS ? myTS.total : 0) + ' h'}
          foot={myTS ? <><StatusBadge status={myTS.status} /> <span className="muted">target 40 h</span></> : 'Not started'}
          spark={<Spark data={wk.map((w) => w.v)} color="var(--s1)" />} />
        <Tile label={'Net pay' + (lastRun ? ' · ' + monthLabel(lastRun.mk) : '')} value={ps ? m(ps.net) : '—'}
          foot={ps
            ? <span className="muted">Gross {m(ps.gross)} · {ctry.empTax.split(' ')[0]} {m(ps.statutory.tax)}</span>
            : <span className="muted">No payslip yet</span>} />
        {me.country === 'IN' ? (
          <Tile label="Tax regime" value={dec?.regime ?? '—'}
            foot={dec
              ? <><StatusBadge status={dec.status} /> <span className="muted">{ORG.fy}</span></>
              : <span className="muted">{ORG.fy}</span>} />
        ) : (
          <Tile label="Tax withholding" value={ctry.empTax.split(' ')[0]}
            foot={<span className="muted">{ctry.flag} {ctry.name} · {ctry.fy}</span>} />
        )}
      </div>

      <div className="grid g-2-1">
        <Card title="My attendance calendar" sub={monthLabelLong(mk)} actions={<GoLink to="attendance">Details</GoLink>}>
          <MonthCalendar records={monthRecs} mk={mk} />
        </Card>
        <Card title="Leave balances" sub={ORG.fy} actions={<GoLink to="leave">Apply</GoLink>}>
          <div className="stack" style={{ gap: 11 }}>
            {bals.map((b) => {
              const total = b.quota + b.carry;
              return (
                <div key={b.type} data-tip={`${ltOf(b.type).name}: ${b.avail} of ${total} available`}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{ltOf(b.type).name}</span>
                    <span className="mono"><b>{b.avail}</b><span className="muted"> / {total}</span></span>
                  </div>
                  <div className="bar"><i style={{ width: pct(b.avail, total) + '%', background: ltOf(b.type).color }} /></div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="grid g4">
        <Tile label="Goal achievement" value={achv + '%'} foot={`${g.length} goals this cycle`} />
        <Tile label="Open tickets" value={tk.length} foot={tk.length ? tCat(tk[0].cat).n : 'Nothing pending'} />
        <Tile label="Expense pending" value={inr(sum(cl, (c) => c.total))} foot={`${cl.length} claims in progress`} />
        <Tile label="Compliance training" value={`${done} / ${mand.length}`}
          trend={done === mand.length ? 'up' : undefined}
          foot={done === mand.length ? '✓ All done' : 'Due 30 September'} />
      </div>

      <div className="grid g3">
        <Card title="My hours" sub="Last 8 weeks">
          <BarChart labels={wk.map((w) => w.l)} height={180} padLeft={34} fmt={(v) => v + ' h'}
            series={[{ name: 'Hours', color: 'var(--s1)', data: wk.map((w) => w.v) }]} />
        </Card>

        <Card title="My leave requests" sub={`${myLeaves.length} recent`} actions={<GoLink to="leave">All</GoLink>} flush>
          {myLeaves.length ? myLeaves.map((l) => (
            <ListRow key={l.id}>
              <Dot color={ltOf(l.type).color} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{ltOf(l.type).name}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {fmtDS(l.from)}{l.days > 1 ? ' – ' + fmtDS(l.to) : ''} · {l.days} d
                </div>
              </div>
              <StatusBadge status={l.status} />
            </ListRow>
          )) : <EmptyState msg="No requests yet" />}
        </Card>

        <Card title="Celebrations" sub="Next 14 days" actions={<GoLink to="celebrations">All</GoLink>} flush>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            <CelebRows list={cel.slice(0, 7)} dir={dir} />
          </div>
        </Card>
      </div>

      <Card title="Announcements" sub="From HR & leadership" actions={<GoLink to="announcements">View all</GoLink>} flush>
        {announcements.slice(0, 3).map((a) => (
          <ListRow key={a.id} style={{ alignItems: 'flex-start' }}>
            <Badge kind="info">{a.tag}</Badge>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: 13 }}>{a.title}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{a.body.slice(0, 150)}…</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{a.by} · {fmtD(a.on)}</div>
            </div>
          </ListRow>
        ))}
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

function Dashboard() {
  const app = useApp();
  return app.role === 'employee' ? <DashEmployee /> : app.role === 'manager' ? <DashManager /> : <DashAdmin />;
}

registerModule({
  key: 'dashboard',
  title: TITLES.dashboard,
  subtitle: (c) => 'Welcome back, ' + c.me.name.split(' ')[0] + ' · ' + new Date().toDateString(),
  Component: Dashboard,
});
