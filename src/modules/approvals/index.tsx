import { sum } from '../../lib/collections';
import { fmtD, fmtDS, fmtTime, monthKey, TODAY, ymd } from '../../lib/dates';
import { inr } from '../../lib/format';
import { ATT } from '../../data/attendance';
import type { AttRecord } from '../../data/attendance';
import { CANDS, INTERVIEWS, reqOf } from '../../data/ats';
import { EMAP, empName } from '../../data/employees';
import { CLAIMS } from '../../data/expenses';
import type { Claim } from '../../data/expenses';
import { LEAVE_BAL, LEAVES } from '../../data/leave';
import type { LeaveRequest } from '../../data/leave';
import { LETTER_REQS, LETTER_TYPES } from '../../data/letters';
import { LOANS, LOAN_TYPES } from '../../data/loans';
import { ltOf } from '../../data/org';
import { OVERTIME } from '../../data/shifts';
import type { Overtime } from '../../data/shifts';
import { TS } from '../../data/timesheet';
import type { Timesheet } from '../../data/timesheet';
import { Avatar, Badge, Card, EmptyState, PersonCell, Tile } from '../../components/ui';
import { ListRow } from '../../components/common';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import { ClaimTable } from '../expenses/ClaimTable';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { pendingCount } from '../../state/pending';

function Approvals() {
  const app = useApp();
  const ids = visibleIds(app.role, app.meId).filter((i) => i !== app.meId);

  const lv = LEAVES.filter((l) => l.status === 'Pending' && ids.includes(l.empId));
  const ts = TS.filter((t) => t.status === 'Submitted' && ids.includes(t.empId));
  const rg = ATT.filter((a) => a.reg && a.reg.status === 'Pending' && ids.includes(a.empId));
  const iv = INTERVIEWS.filter((i) => i.panelId === app.meId && i.status === 'Scheduled');
  const cl = CLAIMS.filter((c) => c.status === 'Submitted' && ids.includes(c.empId));
  const ot = OVERTIME.filter((o) => o.status === 'Pending' && ids.includes(o.empId));
  const ln = app.role === 'admin' ? LOANS.filter((l) => l.status === 'Pending Approval') : [];
  const lt = app.role === 'admin' ? LETTER_REQS.filter((l) => l.status === 'Pending') : [];

  const approveLeave = (l: LeaveRequest) => {
    l.status = 'Approved';
    l.actedOn = ymd(TODAY);
    if (LEAVE_BAL[l.empId]?.[l.type]) LEAVE_BAL[l.empId][l.type].used += l.days;
    app.toast('Leave approved for ' + empName(l.empId), 'ok');
    app.bump();
  };

  const rejectLeave = (l: LeaveRequest) => {
    l.status = 'Rejected';
    l.actedOn = ymd(TODAY);
    app.toast('Leave rejected', 'err');
    app.bump();
  };

  const approveTs = (t: Timesheet) => {
    t.status = 'Approved';
    app.toast('Approved ' + empName(t.empId) + "'s timesheet", 'ok');
    app.bump();
  };

  const returnTs = (t: Timesheet) => {
    t.status = 'Rejected';
    t.note = 'Please split the hours by task type and resubmit.';
    app.toast('Timesheet returned', 'err');
    app.bump();
  };

  const approveReg = (r: AttRecord) => {
    r.reg!.status = 'Approved';
    r.status = 'P';
    r.inT = r.reg!.inT;
    r.outT = r.reg!.outT;
    r.mins = 495;
    app.toast('Regularisation approved', 'ok');
    app.bump();
  };

  const rejectReg = (r: AttRecord) => {
    r.reg!.status = 'Rejected';
    app.toast('Regularisation rejected', 'err');
    app.bump();
  };

  const approveClaim = (c: Claim) => {
    c.status = 'Approved';
    c.actedOn = ymd(TODAY);
    app.toast('Claim approved', 'ok');
    app.bump();
  };

  const rejectClaim = (c: Claim) => {
    c.status = 'Rejected';
    c.actedOn = ymd(TODAY);
    c.note = 'Receipt not legible — please re-upload and resubmit.';
    app.toast('Claim rejected', 'err');
    app.bump();
  };

  const payClaim = (c: Claim) => {
    c.status = 'Reimbursed';
    c.reimbursedOn = ymd(TODAY);
    c.payrollMonth = monthKey(TODAY);
    app.toast('Marked for reimbursement with payroll', 'ok');
    app.bump();
  };

  const approveOt = (o: Overtime) => {
    o.status = 'Approved';
    app.toast('Overtime approved', 'ok');
    app.bump();
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
                    <td><PersonCell e={EMAP[l.empId]} /></td>
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
                    <td><PersonCell e={EMAP[t.empId]} /></td>
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
                    <td><PersonCell e={EMAP[r.empId]} /></td>
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
          {iv.map((i) => {
            const c = CANDS.find((x) => x.id === i.candId)!;
            return (
              <ListRow key={i.id} to="/hiring">
                <Avatar name={c.name} size="sm" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{c.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{i.round} · {reqOf(i.reqId)?.title}</div>
                </div>
                <Badge kind="info">{fmtD(i.date)} {fmtTime(i.time)}</Badge>
              </ListRow>
            );
          })}
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
                    <td><PersonCell e={EMAP[o.empId]} /></td>
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
                    <td><PersonCell e={EMAP[l.empId]} /></td>
                    <td>{LOAN_TYPES.find((t) => t.id === l.type)?.n}</td>
                    <td className="num">{inr(l.principal)}</td>
                    <td className="num">{inr(l.emi)}</td>
                    <td>{l.reason}</td>
                    <td className="right">
                      <button className="btn sm primary" onClick={() => {
                        l.status = 'Active';
                        app.toast('Loan approved', 'ok');
                        app.bump();
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
                    <td><PersonCell e={EMAP[l.empId]} /></td>
                    <td>{LETTER_TYPES.find((t) => t.id === l.type)?.n}</td>
                    <td>{l.purpose}</td>
                    <td className="nowrap">{fmtD(l.requestedOn)}</td>
                    <td className="right nowrap">
                      <button className="btn sm primary" onClick={() => {
                        l.status = 'Issued';
                        l.issuedOn = ymd(TODAY);
                        app.toast('Letter issued', 'ok');
                        app.bump();
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
