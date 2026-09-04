import { sortBy } from '../../lib/collections';
import { fmtD, monthLabel } from '../../lib/dates';
import { inr } from '../../lib/format';
import { EMAP } from '../../data/employees';
import type { Claim } from '../../data/expenses';
import { Badge, EmptyState, PersonCell } from '../../components/ui';
import { useApp } from '../../state/AppContext';

const CLAIM_TONE: Record<string, 'good' | 'info' | 'warn' | 'crit'> = {
  Reimbursed: 'good', Approved: 'info', Submitted: 'warn', Rejected: 'crit',
};

export function ClaimBadge({ status }: { status: string }) {
  return <Badge kind={CLAIM_TONE[status] || 'mute'}>{status}</Badge>;
}

/**
 * The claims table, shared between the Expenses module and the unified
 * approvals queue.
 */
export function ClaimTable({
  list, showEmp, actions, onOpen, onApprove, onReject, onPay,
}: {
  list: Claim[];
  showEmp?: boolean;
  actions?: boolean;
  onOpen?: (c: Claim) => void;
  onApprove?: (c: Claim) => void;
  onReject?: (c: Claim) => void;
  onPay?: (c: Claim) => void;
}) {
  const app = useApp();
  if (!list.length) return <EmptyState msg="No claims here yet" icon="🧾" />;

  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {showEmp && <th>Employee</th>}
            <th>Claim</th><th className="num">Items</th><th className="num">Amount</th>
            <th>Submitted</th><th>Status</th><th>Paid with</th>
            {actions && <th className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {sortBy(list, (c) => c.submittedOn, 'desc').map((c) => (
            <tr key={c.id} className={onOpen ? 'clickable' : ''} onClick={() => onOpen?.(c)}>
              {showEmp && <td><PersonCell e={EMAP[c.empId]} /></td>}
              <td>
                <b>{c.title}</b>
                <div className="muted" style={{ fontSize: 11 }}>{c.id}</div>
              </td>
              <td className="num">
                {c.items.length}
                {c.items.some((i) => i.overLimit) && <> <Badge kind="warn">!</Badge></>}
              </td>
              <td className="num strong">{inr(c.total)}</td>
              <td className="nowrap">{fmtD(c.submittedOn)}</td>
              <td><ClaimBadge status={c.status} /></td>
              <td className="nowrap">{c.payrollMonth ? monthLabel(c.payrollMonth) + ' payroll' : '—'}</td>
              {actions && (
                <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                  {c.status === 'Submitted' ? (
                    <>
                      <button className="btn sm primary" onClick={() => onApprove?.(c)}>Approve</button>{' '}
                      <button className="btn sm" onClick={() => onReject?.(c)}>Reject</button>
                    </>
                  ) : c.status === 'Approved' && app.role === 'admin' ? (
                    <button className="btn sm" onClick={() => onPay?.(c)}>Mark reimbursed</button>
                  ) : <span className="muted">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
