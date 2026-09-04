import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { addDays, daysBetween, fmtD, monthLabelLong, TODAY, yearsSince, ymd } from '../../lib/dates';
import { inr, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';

import { CLEARANCE_DEPTS } from '../../data/exit';
import type { ExitRecord } from '../../services';


import { DEPTS, deptOf } from '../../data/org';
import { Avatar, Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile } from '../../components/ui';
import { Chip, Divide, ListRow, StatusBadge } from '../../components/common';
import { HBar, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { isMyReport } from '../../state/rbac';
import {
  useActiveLoans, useAllEmployees, useExitDetail, useExits, useMyLeaveBalance,
  useSetClearance, useSettleExit, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const EXIT_TONE: Record<string, 'warn' | 'info' | 'good' | 'mute'> = {
  'Notice Period': 'warn', 'In Clearance': 'info', Settled: 'good',
};
const ExitBadge = ({ s }: { s: string }) => <Badge kind={EXIT_TONE[s] || 'mute'}>{s}</Badge>;

/** Reasons the company would rather have retained. */
const REGRETTED = ['Better opportunity', 'Compensation', 'Career growth'];

const INTERVIEW_DIMS: [string, string][] = [
  ['manager', 'Manager & leadership'], ['growth', 'Career growth'], ['comp', 'Compensation'],
  ['culture', 'Culture & team'], ['worklife', 'Work-life balance'],
];

const RETENTION_ACTIONS: [string, string, string][] = [
  ['Publish career frameworks by job family', 'Career growth is the top cited reason after compensation', 'In Progress'],
  ['Off-cycle correction for below-median L3 engineers', 'Compensation cited in 30% of exits', 'In Progress'],
  ['Cap on-call to one week in six', 'Work-life balance scores lowest in DevOps and Support', 'Completed'],
  ['Manager effectiveness programme for new managers', 'Manager fit cited in 14% of exits', 'Pending'],
  ['Stay interviews for every high performer at 18 months', 'Early attrition peaks between 12 and 24 months', 'Pending'],
];

const EXIT_TIMELINE: [string, string][] = [
  ['Knowledge transfer', 'Agree a handover plan with your manager in the first week of notice.'],
  ['Exit interview', 'HR will schedule a 30-minute conversation in your final week. It is confidential and aggregated.'],
  ['Asset return', 'Return your laptop, accessories and access card on or before your last working day.'],
  ['Documents', 'Relieving and experience letters are issued on the last working day once clearance is complete.'],
  ['Full & final', 'Settled within 45 days of your last working day, credited to your salary account.'],
  ['PF & insurance', 'PF can be transferred or withdrawn after 60 days. Insurance cover ends on your last working day.'],
];

/** Exits the signed-in user may act on. */
/** Managers see exits from their own line; admins see the whole book. */
function exitScope(role: string, meId: string, exits: ExitRecord[], dir: Directory): ExitRecord[] {
  if (role === 'admin') return exits;
  return exits.filter((x) => {
    const e = dir.byId(x.empId);
    return !!e && (e.managerId === meId || isMyReport(meId, x.empId));
  });
}

/* ---------------- Exit board ---------------- */

function XtBoard({ openFnf }: { openFnf: (id: string) => void }) {
  const { data: allExits = [] } = useExits();
  const dir = useVisiblePeople();
  const app = useApp();
  const list = exitScope(app.role, app.meId, allExits, dir);
  const byReason = uniq(list.map((x) => x.reason)).map((r, i) => ({
    k: r, c: PAL[i % 8], v: list.filter((x) => x.reason === r).length,
  }));

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="In notice period" value={list.filter((x) => x.status === 'Notice Period').length} foot="Serving notice right now" />
        <Tile label="In clearance" value={list.filter((x) => x.status === 'In Clearance').length} foot="Handover and clearance open" />
        <Tile label="Settled" value={list.filter((x) => x.status === 'Settled').length} foot="F&F paid, exit closed" />
        <Tile label="Avg notice served"
          value={Math.round(sum(list, (x) => x.noticeDays - x.buyout) / Math.max(1, list.length)) + ' days'}
          foot="Against 60-day standard" />
        <Tile label="Regretted exits" value={list.filter((x) => REGRETTED.includes(x.reason)).length} foot="Would have retained" />
      </div>

      {list.length ? (
        <Card title="Exits in progress" sub={`${list.length} employees`} flush
          actions={<button className="btn sm" onClick={() =>
            downloadCSV('exits.csv',
              [['Emp Code', 'Name', 'Department', 'Resigned', 'LWD', 'Reason', 'Destination', 'Status']].concat(
                list.map((x) => {
                  const e = dir.byId(x.empId)!;
                  return [e.code, e.name, deptOf(e.dept).name, x.resignedOn, x.lwd, x.reason, x.destination, x.status];
                }),
              ))}>⤓ Export</button>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Employee</th><th>Department</th><th>Resigned</th><th>Last working day</th>
                  <th className="num">Days left</th><th>Reason</th><th>Clearance</th><th>Status</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortBy(list, (x) => x.lwd).map((x) => {
                  const e = dir.byId(x.empId)!;
                  const left = daysBetween(ymd(TODAY), x.lwd);
                  const done = x.clearance.filter((c) => c.done).length;
                  return (
                    <tr key={x.id}>
                      <td><PersonCell e={e} /></td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="nowrap">{fmtD(x.resignedOn)}</td>
                      <td className="nowrap"><b>{fmtD(x.lwd)}</b></td>
                      <td className="num">{left > 0 ? left : <span className="muted">Served</span>}</td>
                      <td>{x.reason}</td>
                      <td style={{ minWidth: 110 }}>
                        <div className="row" style={{ gap: 6 }}>
                          <div className="bar" style={{ flex: 1 }}>
                            <i style={{ width: pct(done, x.clearance.length) + '%', background: done === x.clearance.length ? 'var(--good)' : 'var(--brand)' }} />
                          </div>
                          <span className="mono" style={{ fontSize: 11 }}>{done}/{x.clearance.length}</span>
                        </div>
                      </td>
                      <td><ExitBadge s={x.status} /></td>
                      <td className="right nowrap"><button className="btn sm" onClick={() => openFnf(x.id)}>F&amp;F</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : <Card><EmptyState msg="No exits in progress 🎉" /></Card>}

      <div className="grid g2">
        <Card title="Exit reasons" sub="Current pipeline">
          {byReason.length ? <HBar rows={sortBy(byReason, (r) => -r.v)} /> : <EmptyState msg="No data" />}
        </Card>
        <Card title="Exit checklist template" sub={`${CLEARANCE_DEPTS.length} clearance owners`} flush>
          {CLEARANCE_DEPTS.map((c) => (
            <ListRow key={c.k}>
              <span>✔️</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{c.k}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{c.d}</div>
              </div>
            </ListRow>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Full & final ---------------- */

function XtFnf({ sel, setSel }: { sel: string | null; setSel: (id: string) => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const { data: allExits = [] } = useExits();
  const setClearance = useSetClearance();
  const settleExit = useSettleExit();
  const list = exitScope(app.role, app.meId, allExits, dir);
  const picked = list.find((a) => a.id === sel) || list[0];
  const { data: detail } = useExitDetail(picked?.id ?? '');

  if (!picked) return <Card><EmptyState msg="No exits to settle" /></Card>;
  if (!detail) return <Card><EmptyState msg="Loading the settlement…" icon="↩" /></Card>;

  const x = detail.exit;
  const e = detail.employee;
  const f = detail.settlement;
  const done = x.clearance.filter((c) => c.done).length;

  const toggleClearance = (i: number, checked: boolean) => {
    void setClearance.mutate(x.id, i, checked);
  };

  return (
    <div className="stack">
      <div className="grid g-1-2">
        <Card title="Exits" sub={`${list.length} employees`} flush>
          <div style={{ maxHeight: 600, overflow: 'auto' }}>
            {list.map((a) => (
              <ListRow key={a.id} onClick={() => setSel(a.id)}
                style={a.id === x.id ? { background: 'var(--brand-wash)' } : undefined}>
                <Avatar name={dir.name(a.empId)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(a.empId)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>LWD {fmtD(a.lwd)}</div>
                </div>
                <ExitBadge s={a.status} />
              </ListRow>
            ))}
          </div>
        </Card>

        <div className="stack">
          <Card title={'Full & final settlement — ' + e.name}
            sub={`${e.code} · ${e.designation} · LWD ${fmtD(x.lwd)}`} flush
            actions={
              <div className="row">
                <button className="btn sm" onClick={() => window.print()}>🖨 Statement</button>
                {app.role === 'admin' && x.status !== 'Settled' && (
                  <button className="btn sm primary" onClick={async () => {
                    try {
                      await settleExit.mutate(x.id);
                      app.toast('Settlement released — credited within 45 days', 'ok');
                    } catch (err) {
                      app.toast(err instanceof Error ? err.message : 'Could not settle', 'err');
                    }
                  }}>Settle &amp; pay</button>
                )}
              </div>
            }>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Payable</th><th className="num">Amount</th><th>Basis</th></tr></thead>
                <tbody>
                  <tr>
                    <td>Salary for {f.payDays} days of {monthLabelLong(x.lwd.slice(0, 7))}</td>
                    <td className="num">{inr(f.salary)}</td>
                    <td className="muted">Pro-rated monthly gross</td>
                  </tr>
                  <tr>
                    <td>Leave encashment — {f.elDays} earned leave days</td>
                    <td className="num">{inr(f.encash)}</td>
                    <td className="muted">(Basic + HRA) ÷ 365 × days</td>
                  </tr>
                  <tr>
                    <td>Gratuity{f.gratuity ? '' : ' (not eligible)'}</td>
                    <td className="num">{inr(f.gratuity)}</td>
                    <td className="muted">
                      {f.gratuity ? `15/26 × last Basic × ${f.yrs} years` : 'Requires 5 years of continuous service'}
                    </td>
                  </tr>
                  <tr>
                    <td>Pending reimbursements</td>
                    <td className="num">{inr(f.pending)}</td>
                    <td className="muted">Approved expense claims</td>
                  </tr>
                  <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                    <td>Gross payable</td><td className="num">{inr(f.gross)}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Recovery / deduction</th><th className="num">Amount</th><th>Basis</th></tr></thead>
                <tbody>
                  <tr><td>Provident fund (employee)</td><td className="num">{inr(f.pf)}</td><td className="muted">12% of pro-rated basic</td></tr>
                  <tr><td>Professional tax</td><td className="num">{inr(f.ptax)}</td><td className="muted">State slab</td></tr>
                  <tr><td>Income tax (TDS)</td><td className="num">{inr(f.tds)}</td><td className="muted">Section 192 on final settlement</td></tr>
                  <tr>
                    <td>Notice period shortfall{f.noticeShort ? ` — ${x.buyout} days` : ''}</td>
                    <td className="num">{inr(f.noticeShort)}</td>
                    <td className="muted">{f.noticeShort ? 'Recovered at gross per day' : 'Full notice served'}</td>
                  </tr>
                  <tr>
                    <td>Outstanding loans</td><td className="num">{inr(f.loanDue)}</td>
                    <td className="muted">{f.loanDue ? 'Balance recovered in full' : 'None'}</td>
                  </tr>
                  <tr>
                    <td>Unsettled travel advances</td><td className="num">{inr(f.advDue)}</td>
                    <td className="muted">{f.advDue ? 'Not settled against a claim' : 'None'}</td>
                  </tr>
                  <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                    <td>Total deductions</td><td className="num">{inr(f.ded)}</td><td />
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={{
              padding: '14px 16px', borderTop: '1px solid var(--line)', display: 'flex',
              justifyContent: 'space-between', alignItems: 'center', background: 'var(--surface-2)',
            }}>
              <div style={{ fontWeight: 750, fontSize: 14 }}>Net settlement payable</div>
              <div style={{ fontWeight: 750, fontSize: 22, letterSpacing: '-.7px', color: f.net >= 0 ? 'var(--good-text)' : 'var(--crit)' }}>
                {inr(f.net)}
              </div>
            </div>
          </Card>

          <div className="grid g2">
            <Card title="Clearance" sub={`${done} of ${x.clearance.length} complete`} flush>
              {x.clearance.map((c, i) => (
                <ListRow key={c.k}>
                  <input type="checkbox" checked={c.done} disabled={app.role === 'employee'}
                    style={{ width: 17, height: 17, cursor: 'pointer' }}
                    onChange={(ev) => toggleClearance(i, ev.target.checked)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5, ...(c.done ? { opacity: 0.6, textDecoration: 'line-through' } : {}) }}>
                      {c.k}
                    </div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{c.d}</div>
                  </div>
                  <Badge kind={c.done ? 'good' : 'warn'}>{c.done ? 'Cleared' : 'Pending'}</Badge>
                </ListRow>
              ))}
            </Card>

            <Card title="Documents to issue" sub="On the last working day" flush>
              {['Relieving Letter', 'Experience Letter', 'Full & Final Statement', 'Form 16 (part year)', 'PF transfer / withdrawal form'].map((d) => (
                <ListRow key={d}>
                  <span>📄</span>
                  <div style={{ flex: 1, fontWeight: 650, fontSize: 12.5 }}>{d}</div>
                  <button className="btn sm" onClick={() => app.toast(d + ' generated', 'ok')}>Generate</button>
                </ListRow>
              ))}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Exit interviews ---------------- */

function XtInterviews() {
  const { data: EXITS = [] } = useExits();
  const dir = useVisiblePeople();
  const done = EXITS.filter((x) => x.interview && x.interview.done);
  const avg = (k: string) => sum(done, (x) => x.interview.ratings![k]) / Math.max(1, done.length);
  const scores = INTERVIEW_DIMS.map(([k, label]) => ({ k: label, key: k, v: +avg(k).toFixed(1) }));
  const lowest = sortBy(scores, (s) => s.v)[0];

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Interviews completed" value={done.length} foot={`Out of ${EXITS.length} exits`} />
        <Tile label="Would rejoin" value={pct(done.filter((x) => x.interview.wouldRejoin).length, Math.max(1, done.length)) + '%'}
          foot="Boomerang potential" />
        <Tile label="Avg leaver NPS"
          value={(sum(done, (x) => x.interview.npsToCompany!) / Math.max(1, done.length)).toFixed(1) + ' / 10'}
          foot="Would recommend as a workplace" />
        <Tile label="Lowest driver" value={lowest?.k || '—'} foot="Most common reason for leaving" />
      </div>

      <div className="grid g-2-1">
        <Card title="Exit interview feedback" sub={`${done.length} responses`} flush>
          {done.length ? done.map((x) => (
            <div key={x.id} style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 9, marginBottom: 7 }}>
                <Avatar name={dir.name(x.empId)} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{dir.name(x.empId)}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {deptOf(dir.byId(x.empId)!.dept).name} · left {fmtD(x.lwd)} · {x.reason}
                  </div>
                </div>
                <Badge kind={x.interview.wouldRejoin ? 'good' : 'mute'}>
                  {x.interview.wouldRejoin ? 'Would rejoin' : 'Would not rejoin'}
                </Badge>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>{x.interview.comments}</div>
              <div className="row wrap" style={{ gap: 9, marginTop: 8 }}>
                {INTERVIEW_DIMS.map(([k, label]) => (
                  <Chip key={k}>{label} {x.interview.ratings![k]}/5</Chip>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Moving to: {x.destination}</div>
            </div>
          )) : <EmptyState msg="No exit interviews recorded yet" icon="👋" />}
        </Card>

        <Card title="Average scores" sub="Across all exit interviews">
          <HBar fmt={(v) => v + ' / 5'}
            rows={scores.map((s) => ({
              k: s.k, v: s.v,
              c: s.v >= 4 ? 'var(--s6)' : s.v >= 3.2 ? 'var(--s1)' : 'var(--s8)',
            }))} />
          <Divide />
          <Banner kind="warn" icon="💡">
            Anything below 3.2 is a systemic issue rather than an individual one — it should have a named owner in the
            engagement action tracker.
          </Banner>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Attrition insights ---------------- */

function XtAna() {
  const { data: everyone = [] } = useAllEmployees();
  const { data: EXITS = [] } = useExits();
  const dir = useVisiblePeople();
  /* Everyone who has left, resolved from the exit records. */
  const past = EXITS.flatMap((x) => {
    const e = dir.byId(x.empId);
    return e ? [e] : [];
  });
  const byTenure = ([['< 1 year', 0, 1], ['1–2 years', 1, 2], ['2–4 years', 2, 4], ['4+ years', 4, 99]] as [string, number, number][])
    .map((b, i) => ({
      k: b[0], c: PAL[i],
      v: past.filter((e) => {
        const y = daysBetween(e.doj, e.dol!) / 365;
        return y >= b[1] && y < b[2];
      }).length,
    }));

  const byDept = DEPTS.map((d) => ({ k: d.name, c: d.color, v: past.filter((e) => e.dept === d.id).length })).filter((r) => r.v);
  const byMgr = sortBy(
    uniq(past.map((e) => e.managerId)).map((m) => ({ k: dir.name(m || ''), c: 'var(--s8)', v: past.filter((e) => e.managerId === m).length })),
    (r) => -r.v,
  ).slice(0, 8);

  const rate = pct(past.filter((e) => e.dol! >= ymd(addDays(TODAY, -365))).length, everyone.length);

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="12-month attrition" value={rate + '%'} foot="Industry benchmark 18%" />
        <Tile label="Regretted attrition" value={Math.round(rate * 0.6 * 10) / 10 + '%'} foot="High performers who left" />
        <Tile label="Early attrition" value={past.filter((e) => daysBetween(e.doj, e.dol!) < 365).length} foot="Left within the first year" />
        <Tile label="Avg tenure at exit"
          value={(sum(past, (e) => daysBetween(e.doj, e.dol!) / 365) / Math.max(1, past.length)).toFixed(1) + ' yrs'}
          foot="Across all exits" />
      </div>

      <div className="grid g3">
        <Card title="Exits by tenure" sub="When people leave"><HBar rows={byTenure} /></Card>
        <Card title="Exits by department" sub="All time"><HBar rows={sortBy(byDept, (r) => -r.v)} /></Card>
        <Card title="Exits by manager" sub="Hotspots worth a conversation">
          {byMgr.length ? <HBar rows={byMgr} /> : <EmptyState msg="No data" />}
        </Card>
      </div>

      <Card title="Retention actions" sub="Derived from exit interviews and engagement data" flush>
        {RETENTION_ACTIONS.map(([a, why, status]) => (
          <ListRow key={a} style={{ alignItems: 'flex-start' }}>
            <span style={{ fontSize: 15 }}>🎯</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{a}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>{why}</div>
            </div>
            <StatusBadge status={status} />
          </ListRow>
        ))}
      </Card>
    </div>
  );
}

/* ---------------- My exit ---------------- */

function XtMe() {
  const app = useApp();
  const me = app.me;
  /* Every hook runs before the branch — the exit may or may not exist. */
  const { data: allExits = [] } = useExits();
  const { data: allLoans = [] } = useActiveLoans();
  const { data: elBalance } = useMyLeaveBalance(me.id, 'EL');
  const mine = allExits.find((e) => e.empId === me.id);
  const { data: detail } = useExitDetail(mine?.id ?? '');

  if (!mine) {
    const loans = allLoans.filter((l) => l.empId === me.id);
    const yrs = yearsSince(me.doj);
    return (
      <div className="stack">
        <Card title="Resignation" sub="Nothing in progress">
          <Banner kind="info" icon="ℹ️" title="Thinking of moving on?">
            Before you resign, consider talking to your manager or HR — many concerns around role, compensation or
            workload can be addressed. If you do decide to leave, submitting here starts the formal notice period.
          </Banner>
          <Divide />
          <KV rows={[
            ['Your notice period', me.probation ? '30 days (on probation)' : '60 days (confirmed)'],
            ['Earned leave balance', `${elBalance?.avail ?? 0} days — encashable at exit`],
            ['Gratuity eligibility', yrs >= 5 ? `Eligible · ${yrs} years of service` : `Not yet — needs 5 years (${5 - yrs} to go)`],
            ['Active loans', loans.length ? `${inr(sum(loans, (l) => l.outstanding))} outstanding — recovered from F&F` : 'None'],
          ]} />
          <button className="btn danger" style={{ marginTop: 14 }}
            onClick={() => app.toast('Resignation flow is not wired in this build')}>Submit resignation</button>
        </Card>
      </div>
    );
  }

  if (!detail) return <Card><EmptyState msg="Loading your settlement…" icon="↩" /></Card>;
  const x = detail.exit;
  const f = detail.settlement;
  const done = x.clearance.filter((c) => c.done).length;

  return (
    <div className="stack">
      <Banner kind="warn" icon={<span style={{ fontSize: 19 }}>📤</span>}
        title={`Resignation accepted — last working day ${fmtD(x.lwd)}`}
        actions={<ExitBadge s={x.status} />}>
        {daysBetween(ymd(TODAY), x.lwd)} days of notice remaining · {done} of {x.clearance.length} clearance items complete
      </Banner>

      <div className="grid g4">
        <Tile label="Last working day" value={fmtD(x.lwd)} foot={`${x.noticeDays}-day notice period`} />
        <Tile label="Leave encashment" value={inr(f.encash)} foot={`${f.elDays} earned leave days`} />
        <Tile label="Gratuity" value={inr(f.gratuity)} foot={f.gratuity ? `${f.yrs} years of service` : 'Not eligible'} />
        <Tile label="Estimated F&F" value={inr(f.net)} foot="Paid within 45 days of LWD" />
      </div>

      <div className="grid g2">
        <Card title="Your clearance" sub={`${done} of ${x.clearance.length} complete`} flush>
          {x.clearance.map((c) => (
            <ListRow key={c.k}>
              <span>{c.done ? '✅' : '⏳'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{c.k}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{c.d}</div>
              </div>
              <Badge kind={c.done ? 'good' : 'warn'}>{c.done ? 'Cleared' : 'Pending'}</Badge>
            </ListRow>
          ))}
        </Card>

        <Card title="What happens next" sub="Your exit timeline">
          <div className="stack" style={{ gap: 12, fontSize: 13 }}>
            {EXIT_TIMELINE.map(([t, d]) => (
              <div key={t}>
                <div style={{ fontWeight: 700, fontSize: 12.5 }}>{t}</div>
                <div className="muted">{d}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'board' | 'fnf' | 'interviews' | 'ana' | 'me';

function ExitView() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'me', label: 'My Exit' }]
    : [
        { v: 'board', label: 'Exit Board' }, { v: 'fnf', label: 'Full & Final' },
        { v: 'interviews', label: 'Exit Interviews' }, { v: 'ana', label: 'Attrition Insights' }, { v: 'me', label: 'My Exit' },
      ];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const [fnfSel, setFnfSel] = useState<string | null>(null);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  const openFnf = (id: string) => { setFnfSel(id); setTab('fnf'); };

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'board' && <XtBoard openFnf={openFnf} />}
      {active === 'fnf' && <XtFnf sel={fnfSel} setSel={setFnfSel} />}
      {active === 'interviews' && <XtInterviews />}
      {active === 'ana' && <XtAna />}
      {active === 'me' && <XtMe />}
    </>
  );
}

registerModule({
  key: 'exit',
  title: TITLES.exit,
  Component: ExitView,
});
