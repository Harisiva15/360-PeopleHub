import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, daysBetween, fmtD, MON, monthKey, TODAY, ymd } from '../../lib/dates';
import { inr, lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import type { AttRecord } from '../../services';
import { DEPTS, deptOf, GRADES, LEAVE_TYPES, ORG, SITES, siteOf } from '../../data/org';
import { BarChart, Donut, HBar, Legend, LineChart, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Card, PersonCell, Table, TableWrap, Tile } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { headcountTrend } from '../dashboard/shared';
import { useShowEmployee } from '../employees/Profile';
import {
  useAllEmployees, useAttendanceIn, useDailyRates, useExitedEmployees, useLeaveBalancesIn,
  useLeaveIn, useVisiblePeople,
} from './data';
import { RepHead } from './shared';

/** Person-days that count towards an attendance rate; holidays and offs do not. */
const WORKING = ['P', 'W', 'A', 'L'];
const isWorking = (r: AttRecord) => WORKING.includes(r.status);
const attended = (r: AttRecord) => r.status === 'P' || r.status === 'W';

function lastMonths(n: number) {
  const out: { k: string; l: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    out.push({ k: monthKey(d), l: MON[d.getMonth()] });
  }
  return out;
}

/* ---------- Attendance summary ---------- */

export function RepAttendance() {
  const showEmp = useShowEmployee();
  const dir = useVisiblePeople();
  const ids = dir.ids;
  const since90 = ymd(addDays(TODAY, -90));
  const months6 = lastMonths(6);
  const { data: window6 = [] } = useAttendanceIn(ids, months6[0].k + '-01', ymd(TODAY));
  const { data: window90 = [] } = useAttendanceIn(ids, since90, ymd(TODAY));

  /**
   * NOTE: the prototype spreads the month over a `l` (leave days) key, so its
   * own month label is overwritten and the chart's x-axis ends up labelled with
   * leave counts. The label is kept under `label` here so the axis reads as
   * months, which is plainly what was meant; every figure is unchanged.
   */
  const data = months6
    .map((m) => {
      const rs = window6.filter((r) => r.date.slice(0, 7) === m.k);
      return {
        label: m.l,
        p: rs.filter((r) => r.status === 'P').length,
        w: rs.filter((r) => r.status === 'W').length,
        leave: rs.filter((r) => r.status === 'L').length,
        a: rs.filter((r) => r.status === 'A').length,
        tot: rs.filter(isWorking).length,
        late: rs.filter((r) => r.late).length,
        flags: rs.filter((r) => r.geoOk === false).length,
      };
    })
    .filter((m) => m.tot > 0);

  const byDept: HBarRow[] = DEPTS.map((d) => {
    const es = new Set(dir.list.filter((e) => e.dept === d.id).map((e) => e.id));
    const rs = window90.filter((r) => es.has(r.empId));
    return { k: d.name, c: d.color, v: pct(rs.filter(attended).length, Math.max(1, rs.filter(isWorking).length)) };
  }).filter((r) => r.v);

  const byEmp90 = new Map<string, AttRecord[]>();
  window90.forEach((r) => {
    const list = byEmp90.get(r.empId) || [];
    list.push(r);
    byEmp90.set(r.empId, list);
  });

  const worst = sortBy(
    dir.list
      .map((e) => {
        const rs = byEmp90.get(e.id) || [];
        return {
          e,
          rate: pct(rs.filter(attended).length, Math.max(1, rs.filter(isWorking).length)),
          absent: rs.filter((r) => r.status === 'A').length,
          late: rs.filter((r) => r.late).length,
          flags: rs.filter((r) => r.geoOk === false).length,
        };
      }),
    (x) => x.rate
  ).slice(0, 15);

  const exportCSV = () =>
    downloadCSV('report_attendance.csv', [
      ['Emp Code', 'Name', 'Department', 'Present', 'WFH', 'Leave', 'Absent', 'Late', 'Geo flags', 'Rate %'],
      ...dir.list.map((e) => {
        const rs = byEmp90.get(e.id) || [];
        return [
          e.code,
          e.name,
          deptOf(e.dept).name,
          rs.filter((r) => r.status === 'P').length,
          rs.filter((r) => r.status === 'W').length,
          rs.filter((r) => r.status === 'L').length,
          rs.filter((r) => r.status === 'A').length,
          rs.filter((r) => r.late).length,
          rs.filter((r) => r.geoOk === false).length,
          pct(rs.filter(attended).length, Math.max(1, rs.filter(isWorking).length)),
        ];
      }),
    ]);

  const mix = [
    { name: 'In office', color: 'var(--s1)', data: data.map((d) => d.p) },
    { name: 'WFH', color: 'var(--s3)', data: data.map((d) => d.w) },
    { name: 'Leave', color: 'var(--s4)', data: data.map((d) => d.leave) },
    { name: 'Absent', color: 'var(--s8)', data: data.map((d) => d.a) },
  ];

  return (
    <>
      <RepHead title="Attendance Summary" sub={`Last 6 months · ${ids.length} employees in scope`} onExport={exportCSV} />
      <div className="stack">
        <div className="grid g4">
          <Tile
            label="Overall attendance"
            value={pct(sum(data, (d) => d.p + d.w), Math.max(1, sum(data, (d) => d.tot))) + '%'}
            foot="Present + WFH"
          />
          <Tile
            label="WFH utilisation"
            value={pct(sum(data, (d) => d.w), Math.max(1, sum(data, (d) => d.p + d.w))) + '%'}
            foot="Of all present days"
          />
          <Tile label="Late marks" value={sum(data, (d) => d.late)} foot="Beyond 20-minute grace" />
          <Tile label="Geo-fence exceptions" value={sum(data, (d) => d.flags)} foot="Punches outside radius" />
        </div>

        <Card title="Monthly attendance mix" sub="Person-days by status">
          <BarChart labels={data.map((d) => d.label)} height={240} stacked series={mix} />
          <Legend items={mix.map((s) => ({ k: s.name, c: s.color }))} />
        </Card>

        <div className="grid g2">
          <Card title="Attendance rate by department" sub="Last 90 days">
            <HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => v + '%'} />
          </Card>
          <Card title="Lowest attendance" sub="Bottom 15 · last 90 days" flush>
            <div style={{ maxHeight: 340, overflow: 'auto' }}>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th className="num">Rate</th>
                      <th className="num">Absent</th>
                      <th className="num">Late</th>
                      <th className="num">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {worst.map((w) => (
                      <tr key={w.e.id} className="clickable" onClick={() => showEmp(w.e.id)}>
                        <td><PersonCell e={w.e} /></td>
                        <td className="num"><b>{w.rate}%</b></td>
                        <td className="num">{w.absent}</td>
                        <td className="num">{w.late}</td>
                        <td className="num">{w.flags || '—'}</td>
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

/* ---------- Headcount & diversity ---------- */

const TENURE_BANDS: [string, number, number][] = [
  ['< 1 year', 0, 1],
  ['1 – 3 years', 1, 3],
  ['3 – 5 years', 3, 5],
  ['5 – 8 years', 5, 8],
  ['8+ years', 8, 99],
];

const LEADER_GRADES = ['L4', 'L5', 'L6'];

export function RepHeadcount() {
  const app = useApp();
  const dir = useVisiblePeople();
  const act = dir.list;
  const today = ymd(TODAY);

  const byDept: HBarRow[] = DEPTS.map((d) => ({ k: d.name, c: d.color, v: act.filter((e) => e.dept === d.id).length })).filter((r) => r.v);
  const byGrade: HBarRow[] = Object.keys(GRADES)
    .map((g, i) => ({ k: GRADES[g as keyof typeof GRADES].label, c: PAL[i], v: act.filter((e) => e.grade === g).length }))
    .filter((r) => r.v);
  const bySite = SITES.map((s, i) => ({ k: s.name, c: PAL[i], v: act.filter((e) => e.site === s.id).length })).filter((r) => r.v);
  const gender = [
    { k: 'Women', c: 'var(--s5)', v: act.filter((e) => e.gender === 'F').length },
    { k: 'Men', c: 'var(--s1)', v: act.filter((e) => e.gender === 'M').length },
  ];
  const tenureB: HBarRow[] = TENURE_BANDS.map((b, i) => ({
    k: b[0],
    c: PAL[i],
    v: act.filter((e) => {
      const y = daysBetween(e.doj, today) / 365;
      return y >= b[1] && y < b[2];
    }).length,
  }));
  const { data: leavers = [] } = useExitedEmployees();
  const trend = headcountTrend(12, [...act, ...leavers]);
  const leaders = act.filter((e) => LEADER_GRADES.includes(e.grade)).length;
  const womenLeader = act.filter((e) => e.gender === 'F' && LEADER_GRADES.includes(e.grade)).length;
  const managers = act.filter((e) => e.reports.length).length;
  const medianTenure = sortBy(act.map((e) => daysBetween(e.doj, today)))[Math.floor(act.length / 2)] / 365;

  const exportCSV = () =>
    downloadCSV('report_headcount.csv', [
      ['Emp Code', 'Name', 'Gender', 'Department', 'Grade', 'Designation', 'Location', 'DOJ', 'Tenure (yrs)', 'Manager'],
      ...act.map((e) => [
        e.code,
        e.name,
        e.gender === 'F' ? 'Female' : 'Male',
        deptOf(e.dept).name,
        e.grade,
        e.designation,
        siteOf(e.site).name,
        e.doj,
        (daysBetween(e.doj, today) / 365).toFixed(1),
        dir.name(e.managerId),
      ]),
    ]);

  return (
    <>
      <RepHead title="Headcount & Diversity" sub={`${act.length} active employees · ${app.scope.label}`} onExport={exportCSV} />
      <div className="stack">
        <div className="grid g5">
          <Tile label="Total headcount" value={act.length} foot={`+${trend.data[11] - trend.data[8]} in last quarter`} />
          <Tile label="Women in workforce" value={pct(gender[0].v, act.length) + '%'} foot={`${gender[0].v} of ${act.length}`} />
          <Tile label="Women in leadership" value={pct(womenLeader, Math.max(1, leaders)) + '%'} foot={`${womenLeader} of ${leaders} L4+ roles`} />
          <Tile label="Median tenure" value={medianTenure.toFixed(1) + ' yrs'} foot="Across all employees" />
          <Tile label="Manager ratio" value={'1 : ' + Math.round(act.length / Math.max(1, managers))} foot={`${managers} people managers`} />
        </div>

        <Card title="Headcount trend" sub="Last 12 months">
          <LineChart labels={trend.labels} height={220} area series={[{ name: 'Headcount', color: 'var(--s1)', data: trend.data }]} />
        </Card>

        <div className="grid g2">
          <Card title="By department" sub={`${act.length} employees`}>
            <HBar rows={sortBy(byDept, (r) => -r.v)} />
          </Card>
          <Card title="By grade" sub="Career levels">
            <HBar rows={byGrade} />
          </Card>
        </div>

        <div className="grid g3">
          <Card title="By location" sub="Including remote">
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Donut size={140} center={act.length} centerSub="people" slices={bySite} />
              <div style={{ flex: 1, minWidth: 120 }}>
                <Legend items={bySite} />
              </div>
            </div>
          </Card>
          <Card title="Gender split" sub="Company-wide">
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <Donut size={140} center={pct(gender[0].v, act.length) + '%'} centerSub="women" slices={gender} />
              <div style={{ flex: 1, minWidth: 110 }}>
                <Legend items={gender} />
              </div>
            </div>
          </Card>
          <Card title="Tenure distribution" sub={`Years at ${ORG.name}`}>
            <HBar rows={tenureB} />
          </Card>
        </div>
      </div>
    </>
  );
}

/* ---------- Attrition & retention ---------- */

export function RepAttrition() {
  const { data: exits = [] } = useExitedEmployees();
  const { data: everyone = [] } = useAllEmployees();
  const months = lastMonths(12);
  const ex12 = exits.filter((e) => e.dol! >= ymd(addDays(TODAY, -365)));
  const rate = pct(ex12.length, everyone.length + ex12.length);
  const reasonOf = (e: (typeof exits)[number]) => e.exitReason || '—';
  const byReason: HBarRow[] = uniq(exits.map(reasonOf)).map((r, i) => ({
    k: r,
    c: PAL[i % 8],
    v: exits.filter((e) => reasonOf(e) === r).length,
  }));
  const byDept: HBarRow[] = DEPTS.map((d) => ({ k: d.name, c: d.color, v: exits.filter((e) => e.dept === d.id).length })).filter((r) => r.v);
  const tenureAtExit = exits.map((e) => daysBetween(e.doj, e.dol!) / 365);

  const exportCSV = () =>
    downloadCSV('report_attrition.csv', [
      ['Emp Code', 'Name', 'Department', 'Designation', 'DOJ', 'Last Working Day', 'Tenure (yrs)', 'Reason'],
      ...exits.map((e) => [
        e.code,
        e.name,
        deptOf(e.dept).name,
        e.designation,
        e.doj,
        e.dol,
        (daysBetween(e.doj, e.dol!) / 365).toFixed(1),
        e.exitReason,
      ]),
    ]);

  const flow = [
    { name: 'Joiners', color: 'var(--s3)', data: months.map((m) => everyone.filter((e) => e.doj.slice(0, 7) === m.k).length) },
    { name: 'Exits', color: 'var(--s8)', data: months.map((m) => exits.filter((e) => e.dol!.slice(0, 7) === m.k).length) },
  ];

  return (
    <>
      <RepHead title="Attrition & Retention" sub={`${exits.length} exits recorded · rolling 12-month rate ${rate}%`} onExport={exportCSV} />
      <div className="stack">
        <div className="grid g4">
          <Tile label="Attrition rate" value={rate + '%'} foot="Rolling 12 months · industry avg 18%" />
          <Tile label="Exits (12 months)" value={ex12.length} foot="Voluntary and involuntary" />
          <Tile
            label="Avg tenure at exit"
            value={(sum(tenureAtExit) / Math.max(1, tenureAtExit.length)).toFixed(1) + ' yrs'}
            foot="Across all exits"
          />
          <Tile label="Retention rate" value={(100 - rate).toFixed(1) + '%'} foot="Employees retained year on year" />
        </div>

        <Card title="Joiners vs exits" sub="Last 12 months">
          <BarChart labels={months.map((m) => m.l)} height={230} series={flow} />
          <Legend items={flow.map((s) => ({ k: s.name, c: s.color }))} />
        </Card>

        <div className="grid g2">
          <Card title="Exit reasons" sub={`${exits.length} exits`}>
            <HBar rows={sortBy(byReason, (r) => -r.v)} />
          </Card>
          <Card title="Exits by department" sub="All-time">
            <HBar rows={sortBy(byDept, (r) => -r.v)} />
          </Card>
        </div>

        <Card title="Exit register" sub={`${exits.length} records`} flush>
          <div style={{ maxHeight: 400, overflow: 'auto' }}>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>Joined</th>
                    <th>Last working day</th>
                    <th>Tenure</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {sortBy(exits, (e) => e.dol!, 'desc').map((e) => (
                    <tr key={e.id}>
                      <td><PersonCell e={e} sub={e.code} /></td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="nowrap">{e.designation}</td>
                      <td className="nowrap">{fmtD(e.doj)}</td>
                      <td className="nowrap">{fmtD(e.dol)}</td>
                      <td>{(daysBetween(e.doj, e.dol!) / 365).toFixed(1)} yrs</td>
                      <td>{e.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        </Card>
      </div>
    </>
  );
}

/* ---------- Leave liability ---------- */

export function RepLeave() {
  const showEmp = useShowEmployee();
  const dir = useVisiblePeople();
  const ids = dir.ids;
  const emps = dir.list;
  const { data: leaveRows = [] } = useLeaveIn(ids);
  const { data: balances = {} } = useLeaveBalancesIn(ids);
  const { data: rates = {} } = useDailyRates(ids);
  const balOf = (id: string, type: string) => balances[id]?.find((b) => b.type === type);

  const byType: HBarRow[] = LEAVE_TYPES.map((t) => ({
    k: t.name,
    c: t.color,
    v: sum(leaveRows.filter((l) => l.type === t.id && l.status === 'Approved'), (l) => l.days),
  })).filter((r) => r.v);

  const liabilityRows = emps.map((e) => {
    const el = balOf(e.id, 'EL');
    const perDay = rates[e.id] ?? 0;
    const avail = el ? el.avail : 0;
    return { e, avail, perDay, liab: avail * perDay };
  });
  const totalLiab = sum(liabilityRows, (r) => r.liab);
  const byDept: HBarRow[] = DEPTS.map((d) => ({
    k: d.name,
    c: d.color,
    v: Math.round(sum(liabilityRows.filter((r) => r.e.dept === d.id), (r) => r.liab)),
  })).filter((r) => r.v);

  const util: HBarRow[] = LEAVE_TYPES.filter((t) => t.quota).map((t) => ({
    k: t.name,
    c: t.color,
    v: pct(
      sum(emps.map((e) => balOf(e.id, t.id)?.used || 0)),
      Math.max(1, sum(emps.map((e) => {
        const b = balOf(e.id, t.id);
        return b ? b.quota + b.carry : 0;
      })))
    ),
  }));

  const exportCSV = () =>
    downloadCSV('report_leave_liability.csv', [
      ['Emp Code', 'Name', 'Department', 'CL avail', 'SL avail', 'EL avail', 'Per-day cost', 'EL liability'],
      ...emps.map((e) => {
        const el = balOf(e.id, 'EL');
        const pd = rates[e.id] ?? 0;
        return [
          e.code,
          e.name,
          deptOf(e.dept).name,
          balOf(e.id, 'CL')?.avail || 0,
          balOf(e.id, 'SL')?.avail || 0,
          el ? el.avail : 0,
          pd,
          Math.round((el ? el.avail : 0) * pd),
        ];
      }),
    ]);

  return (
    <>
      <RepHead title="Leave Liability & Utilisation" sub={`${emps.length} employees · ${ORG.fy}`} onExport={exportCSV} />
      <div className="stack">
        <div className="grid g4">
          <Tile label="Encashment liability" value={lakh(totalLiab)} foot="Unused earned leave at Basic + HRA" />
          <Tile
            label="Leave days taken"
            value={sum(leaveRows.filter((l) => l.status === 'Approved'), (l) => l.days)}
            foot="Approved this year"
          />
          <Tile label="Avg utilisation" value={Math.round(sum(util, (u) => u.v) / Math.max(1, util.length)) + '%'} foot="Of entitlement consumed" />
          <Tile label="Employees at risk" value={liabilityRows.filter((r) => r.avail > 20).length} foot="More than 20 EL days accrued" />
        </div>

        <div className="grid g2">
          <Card title="Days taken by leave type" sub="Approved leave">
            <HBar rows={sortBy(byType, (r) => -r.v)} fmt={(v) => v + ' d'} />
          </Card>
          <Card title="Utilisation of entitlement" sub="% of quota used">
            <HBar rows={util} fmt={(v) => v + '%'} />
          </Card>
        </div>

        <Card title="Encashment liability by department" sub="Estimated cost">
          <HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => inr(v)} />
        </Card>

        <Card title="Top balances" sub="Highest earned-leave accrual" flush>
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th className="num">EL available</th>
                    <th className="num">Per-day cost</th>
                    <th className="num">Liability</th>
                  </tr>
                </thead>
                <tbody>
                  {sortBy(liabilityRows, (r) => -r.liab)
                    .slice(0, 20)
                    .map((r) => (
                      <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                        <td><PersonCell e={r.e} /></td>
                        <td className="nowrap">{deptOf(r.e.dept).name}</td>
                        <td className="num">{r.avail}</td>
                        <td className="num">{inr(r.perDay)}</td>
                        <td className="num strong">{inr(r.liab)}</td>
                      </tr>
                    ))}
                </tbody>
              </Table>
            </TableWrap>
          </div>
        </Card>
      </div>
    </>
  );
}
