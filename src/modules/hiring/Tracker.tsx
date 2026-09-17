/**
 * The recruitment activity tracker.
 *
 * Two questions, and they are different ones. **By job order**: how many people
 * have been submitted against this role, how many are still in play, and where
 * are they. **By recruiter**: who is carrying the load.
 *
 * Every number comes from the service, computed from the pipeline at read time.
 * None of it is tallied here from a fetched candidate list — that would mean
 * shipping every candidate's salary and phone number to a screen that wants to
 * show a count, and it would drift from what the pipeline actually says the
 * moment the two were computed differently.
 *
 * **Stalled is the finding worth surfacing.** An open role with openings left
 * and nothing happening for weeks is invisible in a table of counts, because
 * its counts look the same as a healthy role's. It is called out explicitly.
 */

import { useState } from 'react';
import type { ReqActivity } from '../../services';
import { sum } from '../../lib/collections';
import { daysBetween, fmtD, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { STAGES } from '../../data/ats';
import { deptOf, siteOf } from '../../data/org';
import { downloadCSV } from '../../lib/csv';
import { Badge, Banner, Card, EmptyState, Seg, Tile } from '../../components/ui';
import { StatusBadge } from '../../components/common';
import { useApp } from '../../state/AppContext';
import { isMyReport } from '../../state/rbac';
import { useRecruiterTracker, useRequisitionTracker, useVisiblePeople } from './data';

/** A role is stalled when it still needs people and nothing has happened. */
const STALL_DAYS = 21;

export function stalled(r: ReqActivity, today: string): boolean {
  if (r.status !== 'Open' || r.filled >= r.openings) return false;
  /* Never any activity counts from the day it opened, not from never. */
  return daysBetween(r.lastActivity ?? r.openedOn, today) >= STALL_DAYS;
}

/** Submissions per hire — the number that says whether sourcing is working. */
export const perHire = (r: ReqActivity): number | null =>
  r.hires > 0 ? Math.round((r.submissions / r.hires) * 10) / 10 : null;

const VISIBLE_STAGES = STAGES.filter((s) => s.id !== 'hired' && s.id !== 'rejected');

function StageStrip({ byStage }: { byStage: Record<string, number> }) {
  const total = sum(VISIBLE_STAGES, (s) => byStage[s.id] ?? 0);
  if (!total) return <span className="muted" style={{ fontSize: 11 }}>No one in play</span>;
  return (
    <div className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
      {VISIBLE_STAGES.map((s) => {
        const n = byStage[s.id] ?? 0;
        if (!n) return null;
        return (
          <span key={s.id} className="chip" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}
            title={`${n} at ${s.name}`}>
            {s.name.split(' ')[0]} {n}
          </span>
        );
      })}
    </div>
  );
}

export function TrackerView() {
  const { data: rows = [], loading } = useRequisitionTracker();
  const { data: recruiters = [] } = useRecruiterTracker();
  const dir = useVisiblePeople();
  const app = useApp();
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const today = ymd(TODAY);

  /* A manager sees the job orders they own or that sit under them. */
  const mine = app.role === 'admin' ? rows : rows.filter(
    (r) => r.hiringManagerId === app.meId || r.recruiterId === app.meId
      || isMyReport(app.meId, r.hiringManagerId));

  const list = scope === 'open' ? mine.filter((r) => r.status === 'Open') : mine;
  const open = mine.filter((r) => r.status === 'Open');
  const stuck = open.filter((r) => stalled(r, today));

  const exportCsv = () => downloadCSV('recruitment-tracker.csv',
    [['Job order', 'Role', 'Department', 'Location', 'Status', 'Priority', 'Openings',
      'Filled', 'Submissions', 'Active', 'Rejected', 'Interviews', 'Interviews done',
      'Offers', 'Hires', 'Submissions per hire', 'Age (days)', 'Last activity',
      'Hiring manager', 'Recruiter']].concat(
      list.map((r) => [r.reqId, r.title, deptOf(r.dept).name, siteOf(r.site).city,
        r.status, r.priority, String(r.openings), String(r.filled), String(r.submissions),
        String(r.active), String(r.rejected), String(r.interviews), String(r.interviewsDone),
        String(r.offers), String(r.hires), perHire(r) === null ? '' : String(perHire(r)),
        String(r.ageDays), r.lastActivity ?? '',
        dir.name(r.hiringManagerId), dir.name(r.recruiterId)])));

  /* Averaged over roles that have actually hired; the rest have no ratio. */
  const withHires = mine.filter((r) => r.hires > 0);
  const avgPerHire = withHires.length
    ? Math.round((sum(withHires, (r) => r.submissions) / sum(withHires, (r) => r.hires)) * 10) / 10
    : null;

  return (
    <div className="stack">
      <div className="toolbar">
        <Seg value={scope} onChange={setScope} options={[
          { v: 'open', label: 'Open roles' },
          { v: 'all', label: 'All job orders' },
        ]} />
        <div className="spacer" />
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
      </div>

      <div className="grid g4">
        <Tile label="Open job orders" value={open.length}
          foot={`${sum(open, (r) => r.openings - r.filled)} positions to fill`} tone="blue" />
        <Tile label="Submissions" value={sum(list, (r) => r.submissions)}
          foot={scope === 'open' ? 'Against open roles' : 'Against all job orders'} tone="violet" />
        <Tile label="Active candidates" value={sum(list, (r) => r.active)}
          foot="In play — not hired or rejected" tone="green" />
        <Tile label="Submissions per hire" value={avgPerHire === null ? '—' : avgPerHire}
          foot={withHires.length ? `Across ${withHires.length} filled roles` : 'No hires yet'}
          tone="amber" />
      </div>

      {stuck.length > 0 && (
        <Banner kind="warn" icon="🐢"
          title={`${stuck.length} open ${stuck.length === 1 ? 'role has' : 'roles have'} gone quiet`}>
          No submission, interview or offer in {STALL_DAYS} days:{' '}
          {stuck.map((r) => r.title).join(', ')}.
        </Banner>
      )}

      <Card title="Activity by job order" sub={`${list.length} ${scope === 'open' ? 'open' : 'total'}`} flush>
        {list.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Job order</th><th>Department</th>
                  <th className="num">Openings</th>
                  <th className="num">Submissions</th>
                  <th className="num">Active</th>
                  <th>In pipeline</th>
                  <th className="num">Interviews</th>
                  <th className="num">Offers</th>
                  <th className="num">Hires</th>
                  <th className="num">Per hire</th>
                  <th className="num">Age</th>
                  <th>Last activity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const quiet = stalled(r, today);
                  const idle = daysBetween(r.lastActivity ?? r.openedOn, today);
                  return (
                    <tr key={r.reqId}>
                      <td>
                        <b>{r.title}</b>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {siteOf(r.site).city} · {dir.name(r.recruiterId)}
                        </div>
                      </td>
                      <td className="nowrap">{deptOf(r.dept).name}</td>
                      <td className="num">
                        {r.filled} / {r.openings}
                        <div className="bar" style={{ marginTop: 3 }}>
                          <i style={{ width: pct(r.filled, r.openings) + '%' }} />
                        </div>
                      </td>
                      <td className="num strong">{r.submissions}</td>
                      <td className="num">{r.active}</td>
                      <td style={{ minWidth: 190 }}><StageStrip byStage={r.byStage} /></td>
                      <td className="num">
                        {r.interviewsDone}
                        {r.interviews > r.interviewsDone && (
                          <span className="muted"> / {r.interviews}</span>
                        )}
                      </td>
                      <td className="num">{r.offers}</td>
                      <td className="num">{r.hires}</td>
                      <td className="num">{perHire(r) ?? <span className="muted">—</span>}</td>
                      <td className="num nowrap">{r.ageDays}d</td>
                      <td className="nowrap">
                        {r.lastActivity
                          ? <span className={quiet ? 'crit' : undefined}>{fmtD(r.lastActivity)}</span>
                          : <span className="muted">Never</span>}
                        <div className="muted" style={{ fontSize: 10.5 }}>
                          {idle === 0 ? 'today' : `${idle}d ago`}
                        </div>
                      </td>
                      <td>
                        {quiet
                          ? <Badge kind="warn">Stalled</Badge>
                          : <StatusBadge status={r.status} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon="📋"
            msg={loading ? 'Loading the tracker…'
              : scope === 'open' ? 'No open job orders' : 'No job orders yet'} />
        )}
      </Card>

      <Card title="Activity by recruiter" sub={`${recruiters.length} recruiters`} flush>
        {recruiters.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Recruiter</th>
                  <th className="num">Open roles</th><th className="num">Openings</th>
                  <th className="num">Submissions</th><th className="num">In pipeline</th>
                  <th className="num">Interviews</th><th className="num">Offers</th>
                  <th className="num">Hires</th>
                </tr>
              </thead>
              <tbody>
                {recruiters.map((s) => (
                  <tr key={s.recruiterId}>
                    <td><b>{s.name}</b></td>
                    <td className="num">{s.openReqs}</td>
                    <td className="num">{s.openings}</td>
                    <td className="num strong">{s.submissions}</td>
                    <td className="num">{s.inPipeline}</td>
                    <td className="num">{s.interviews}</td>
                    <td className="num">{s.offers}</td>
                    <td className="num">{s.hires}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState msg="No recruiter activity yet" icon="👥" />}
      </Card>
    </div>
  );
}
