import { sum } from '../../lib/collections';
import { fmtD, fmtDS, fmtTime } from '../../lib/dates';
import { inr } from '../../lib/format';
import { LETTER_TYPES } from '../../data/letters';
import { LOAN_TYPES } from '../../data/loans';
import { ltOf } from '../../data/org';
import type { AttRecord, Claim, LeaveRequest, Overtime, Timesheet } from '../../services';
import { Avatar, Badge, Card, EmptyState, PersonCell, Tile } from '../../components/ui';
import { ListRow } from '../../components/common';
import { useApp } from '../../state/AppContext';
import {
  useActOnRegularisation, useApproveClaim, useApproveLeave, useApproveLoan, useApproveOvertime,
  useApproveTimesheet, useIssueLetter, usePendingClaims, usePendingLeave, usePendingLetters,
  usePendingLoans, usePendingOvertime, usePendingRegularisations, usePendingTimesheets,
  useMyInterviews, useReimburseClaim, useRejectClaim, useRejectLeave, useReturnTimesheet,
  useVisiblePeople,
} from './data';
import { ClaimTable } from '../expenses/ClaimTable';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { pendingCount } from '../../state/pending';

function Approvals() {
  const app = useApp();
  const dir = useVisiblePeople();
  const ids = dir.ids.filter((i) => i !== app.meId);
  const isAdmin = app.role === 'admin';

  const { data: lv = [] } = usePendingLeave(ids);
  const { data: ts = [] } = usePendingTimesheets(ids);
  const { data: allRegs = [] } = usePendingRegularisations(ids);
  const { data: cl = [] } = usePendingClaims(ids);
  const { data: ot = [] } = usePendingOvertime(ids);
  const { data: ln = [] } = usePendingLoans(isAdmin);
  const { data: lt = [] } = usePendingLetters(isAdmin);
  const rg = allRegs.filter((a) => a.reg && a.reg.status === 'Pending');
  const { data: iv = [] } = useMyInterviews(app.meId);

  const doApproveLeave = useApproveLeave();
  const doRejectLeave = useRejectLeave();
  const doApproveTs = useApproveTimesheet();
  const doReturnTs = useReturnTimesheet();
  const doReg = useActOnRegularisation();
  const doApproveClaim = useApproveClaim();
  const doRejectClaim = useRejectClaim();
  const doPayClaim = useReimburseClaim();
  const doApproveOt = useApproveOvertime();
  const doApproveLoan = useApproveLoan();
  const doIssueLetter = useIssueLetter();

  /** Surfaces the reason rather than letting a refused transition pass silently. */
  const fail = (e: unknown) => app.toast(e instanceof Error ? e.message : 'Action failed', 'err');

  const approveLeave = async (l: LeaveRequest) => {
    try {
      await doApproveLeave.mutate(l.id, app.meId);
      app.toast('Leave approved for ' + dir.name(l.empId), 'ok');
    } catch (e) { fail(e); }
  };

  const rejectLeave = async (l: LeaveRequest) => {
    try {
      await doRejectLeave.mutate(l.id, app.meId);
      app.toast('Leave rejected', 'err');
    } catch (e) { fail(e); }
  };

  const approveTs = async (t: Timesheet) => {
    try {
      await doApproveTs.mutate(t.id, app.meId);
      app.toast('Approved ' + dir.name(t.empId) + "'s timesheet", 'ok');
    } catch (e) { fail(e); }
  };

  const returnTs = async (t: Timesheet) => {
    try {
      await doReturnTs.mutate(t.id, app.meId, 'Please split the hours by task type and resubmit.');
      app.toast('Timesheet returned', 'err');
    } catch (e) { fail(e); }
  };

  const approveReg = async (r: AttRecord) => {
    try {
      await doReg.mutate(r, 'Approved');
      app.toast('Regularisation approved', 'ok');
    } catch (e) { fail(e); }
  };

  const rejectReg = async (r: AttRecord) => {
    try {
      await doReg.mutate(r, 'Rejected');
      app.toast('Regularisation rejected', 'err');
    } catch (e) { fail(e); }
  };

  const approveClaim = async (c: Claim) => {
    try {
      await doApproveClaim.mutate(c.id, app.meId);
      app.toast('Claim approved', 'ok');
    } catch (e) { fail(e); }
  };

  const rejectClaim = async (c: Claim) => {
    try {
      await doRejectClaim.mutate(c.id, app.meId, 'Receipt not legible — please re-upload and resubmit.');
      app.toast('Claim rejected', 'err');
    } catch (e) { fail(e); }
  };

  const payClaim = async (c: Claim) => {
    try {
      await doPayClaim.mutate(c.id);
      app.toast('Marked for reimbursement with payroll', 'ok');
    } catch (e) { fail(e); }
  };

  const approveOt = async (o: Overtime) => {
    try {
      await doApproveOt.mutate(o.id, app.meId);
      app.toast('Overtime approved', 'ok');
    } catch (e) { fail(e); }
  };

  const nothing = !lv.length && !ts.length && !rg.length && !iv.length && !cl.length && !ot.length && !ln.length && !lt.length;

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Total pending" value={pendingCount(app.role, app.meId)} foot="Across all approval types" />
        <Tile label="Leave" value={lv.length} foot={`${sum(lv, (l) => l.days)} days requested`} />
        <Tile label="Timesheets" value={ts.length} foot={`${sum(ts, (t) => t.total)} hours to verify`} />
        <Tile label="Regularisations" value={rg.length} foot="Attendance corrections" />
      </div>

      {lv.length > 0 && (
        <Card title="Leave requests" sub={`${lv.length} pending`} flush
          actions={<button className="btn sm primary" onClick={() => { lv.forEach(approveLeave); }}>Approve all</button>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th className="num">Days</th><th>Reason</th><th className="right">Action</th></tr></thead>
              <tbody>
                {lv.map((l) => (
                  <tr key={l.id}>
                    <td>{dir.byId(l.empId) && <PersonCell e={dir.byId(l.empId)!} />}</td>
                    <td>{ltOf(l.type).name}</td>
                    <td className="nowrap">{fmtDS(l.from)}{l.days > 1 ? ' – ' + fmtDS(l.to) : ''}</td>
                    <td className="num">{l.days}</td>
                    <td>{l.reason}</td>
                    <td className="right nowrap">
                      <button className="btn sm primary" onClick={() => approveLeave(l)}>Approve</button>{' '}
                      <button className="btn sm" onClick={() => rejectLeave(l)}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {ts.length > 0 && (
        <Card title="Timesheets" sub={`${ts.length} pending`} flush
          actions={<button className="btn sm primary" onClick={() => { ts.forEach(approveTs); }}>Approve all</button>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Week</th><th className="num">Hours</th><th>Submitted</th><th className="right">Action</th></tr></thead>
              <tbody>
                {ts.map((t) => (
                  <tr key={t.id}>
                    <td>{dir.byId(t.empId) && <PersonCell e={dir.byId(t.empId)!} />}</td>
                    <td className="nowrap">{fmtD(t.weekStart)}</td>
                    <td className="num">{t.total}</td>
                    <td className="nowrap">{fmtD(t.submittedOn)}</td>
                    <td className="right nowrap">
                      <button className="btn sm primary" onClick={() => approveTs(t)}>Approve</button>{' '}
                      <button className="btn sm" onClick={() => returnTs(t)}>Return</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {rg.length > 0 && (
        <Card title="Attendance regularisations" sub={`${rg.length} pending`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Date</th><th>Reason</th><th>Proposed</th><th className="right">Action</th></tr></thead>
              <tbody>
                {rg.map((r) => (
                  <tr key={r.id}>
                    <td>{dir.byId(r.empId) && <PersonCell e={dir.byId(r.empId)!} />}</td>
                    <td className="nowrap">{fmtD(r.date)}</td>
                    <td>{r.reg!.reason}</td>
                    <td className="mono nowrap">{fmtTime(r.reg!.inT)} – {fmtTime(r.reg!.outT)}</td>
                    <td className="right nowrap">
                      <button className="btn sm primary" onClick={() => approveReg(r)}>Approve</button>{' '}
                      <button className="btn sm" onClick={() => rejectReg(r)}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {iv.length > 0 && (
        <Card title="Your upcoming interviews" sub={`${iv.length} scheduled`} flush>
          {iv.map(({ interview: i, candidate: c, requisitionTitle }) => (
            <ListRow key={i.id} to="/hiring">
              <Avatar name={c?.name ?? '—'} size="sm" />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{c?.name ?? 'Candidate'}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{i.round} · {requisitionTitle}</div>
              </div>
              <Badge kind="info">{fmtD(i.date)} {fmtTime(i.time)}</Badge>
            </ListRow>
          ))}
        </Card>
      )}

      {cl.length > 0 && (
        <Card title="Expense claims" sub={`${cl.length} pending`} flush
          actions={
            <button className="btn sm primary" onClick={() => {
              /* only claims with every line inside policy are bulk-approved */
              const within = cl.filter((c) => !c.items.some((i) => i.overLimit));
              within.forEach(approveClaim);
              app.toast(`${within.length} claims approved within policy`, 'ok');
            }}>Approve all within policy</button>
          }>
          <ClaimTable list={cl} showEmp actions onApprove={approveClaim} onReject={rejectClaim} onPay={payClaim} />
        </Card>
      )}

      {ot.length > 0 && (
        <Card title="Overtime requests" sub={`${ot.length} pending`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Date</th><th className="num">Hours</th><th>Reason</th><th>Compensation</th><th className="right">Action</th></tr></thead>
              <tbody>
                {ot.map((o) => (
                  <tr key={o.id}>
                    <td>{dir.byId(o.empId) && <PersonCell e={dir.byId(o.empId)!} />}</td>
                    <td className="nowrap">{fmtD(o.date)}</td>
                    <td className="num">{o.hours}</td>
                    <td>{o.reason}</td>
                    <td>{o.compensation}</td>
                    <td className="right"><button className="btn sm primary" onClick={() => approveOt(o)}>Approve</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {ln.length > 0 && (
        <Card title="Loan applications" sub={`${ln.length} pending`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Scheme</th><th className="num">Amount</th><th className="num">EMI</th><th>Reason</th><th className="right">Action</th></tr></thead>
              <tbody>
                {ln.map((l) => (
                  <tr key={l.id}>
                    <td>{dir.byId(l.empId) && <PersonCell e={dir.byId(l.empId)!} />}</td>
                    <td>{LOAN_TYPES.find((t) => t.id === l.type)?.n}</td>
                    <td className="num">{inr(l.principal)}</td>
                    <td className="num">{inr(l.emi)}</td>
                    <td>{l.reason}</td>
                    <td className="right">
                      <button className="btn sm primary" onClick={async () => {
                        try {
                          await doApproveLoan.mutate(l.id);
                          app.toast('Loan approved', 'ok');
                        } catch (e) { fail(e); }
                      }}>Approve</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {lt.length > 0 && (
        <Card title="Letter requests" sub={`${lt.length} pending`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Employee</th><th>Letter</th><th>Purpose</th><th>Requested</th><th className="right">Action</th></tr></thead>
              <tbody>
                {lt.map((l) => (
                  <tr key={l.id}>
                    <td>{dir.byId(l.empId) && <PersonCell e={dir.byId(l.empId)!} />}</td>
                    <td>{LETTER_TYPES.find((t) => t.id === l.type)?.n}</td>
                    <td>{l.purpose}</td>
                    <td className="nowrap">{fmtD(l.requestedOn)}</td>
                    <td className="right nowrap">
                      <button className="btn sm primary" onClick={async () => {
                        try {
                          await doIssueLetter.mutate(l.id);
                          app.toast('Letter issued', 'ok');
                        } catch (e) { fail(e); }
                      }}>Issue</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {nothing && (
        <Card><EmptyState msg="You are all caught up — nothing needs your approval right now ✓" /></Card>
      )}
    </div>
  );
}

registerModule({
  key: 'approvals',
  title: TITLES.approvals,
  subtitle: () => 'Everything waiting on your action',
  badge: (c) => pendingCount(c.role, c.meId),
  Component: Approvals,
});
