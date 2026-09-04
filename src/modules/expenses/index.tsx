import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { fmtD, MON, monthKey, monthLabel, TODAY, ymd } from '../../lib/dates';
import { inr, lakh } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { uid } from '../../lib/rng';
import { EMAP, empName } from '../../data/employees';
import { ADVANCES, CLAIMS, EXP_CATS, expCat } from '../../data/expenses';
import type { Advance, Claim, ExpItem } from '../../data/expenses';
import { DEPTS, PROJECTS, projOf } from '../../data/org';
import { Badge, Banner, Card, EmptyState, KV, PersonCell, Tabs, Tile } from '../../components/ui';
import { Chip, Divide } from '../../components/common';
import { BarChart, HBar } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { isMyReport, SCOPE, visibleIds } from '../../state/rbac';
import { ClaimBadge, ClaimTable } from './ClaimTable';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

/** Per-category guidance shown in the policy table. */
const CAT_NOTES: Record<string, string> = {
  AIR: 'Economy only. Book 14 days ahead where possible.',
  HOTEL: 'Per night, metro cities. Non-metro ₹4,000.',
  LOCAL: 'Per day. Use the corporate cab account where available.',
  MEAL: 'Per day while on official travel.',
  CLIENT: 'Prior approval from the department head needed.',
  NET: 'Per month, against a bill in your name.',
  MOB: 'Per month for eligible roles.',
  LEARN: 'Per year. Needs manager approval before enrolling.',
  RELOC: 'One time, on joining or company-initiated transfer.',
  FUEL: 'Per month, ₹12 per km for own vehicle.',
};

const RULES: [string, string][] = [
  ['Submission window', 'Claims must be raised within 30 days of the expense date. Older claims need Finance approval.'],
  ['Receipts', 'Digital receipts are accepted. Anything above ₹500 needs a legible bill showing the vendor GSTIN where applicable.'],
  ['Above-limit spend', 'Allowed with a written justification. Your manager records an override, which is visible in the audit log.'],
  ['Advances', 'Must be settled within 15 days of returning. Unsettled advances are recovered from payroll.'],
  ['Reimbursement', 'Approved claims are paid with the next payroll cycle. Amounts above ₹50,000 can be paid off-cycle.'],
  ['Tax', 'Reimbursements against valid bills are not taxable. Amounts without proof are added to taxable salary.'],
  ['Client billing', 'Tag the project so recoverable expenses are invoiced to the client.'],
];

function exportClaims(list: Claim[], name: string) {
  const rows: (string | number)[][] = [
    ['Claim ID', 'Emp Code', 'Name', 'Claim title', 'Category', 'Expense date', 'Merchant', 'Amount', 'Over limit', 'Project', 'Status', 'Submitted', 'Reimbursed with'],
  ];
  list.forEach((c) =>
    c.items.forEach((i) => {
      const e = EMAP[c.empId];
      rows.push([c.id, e.code, e.name, c.title, expCat(i.cat).n, i.date, i.merchant, i.amount,
        i.overLimit ? 'Yes' : 'No', i.project ? projOf(i.project).name : '', c.status, c.submittedOn, c.payrollMonth || '']);
    }),
  );
  downloadCSV(name, rows);
}

/* ---------------- shared claim actions ---------------- */

function useClaimActions() {
  const app = useApp();
  return {
    approve: (c: Claim) => {
      c.status = 'Approved';
      c.actedOn = ymd(TODAY);
      app.toast('Claim approved — queued for reimbursement', 'ok');
      app.bump();
    },
    reject: (c: Claim) => {
      c.status = 'Rejected';
      c.note = 'Receipt not legible — please re-upload and resubmit.';
      c.actedOn = ymd(TODAY);
      app.toast('Claim rejected', 'err');
      app.bump();
    },
    pay: (c: Claim) => {
      c.status = 'Reimbursed';
      c.reimbursedOn = ymd(TODAY);
      c.payrollMonth = monthKey(TODAY);
      app.toast('Marked reimbursed with ' + monthLabel(c.payrollMonth) + ' payroll', 'ok');
      app.bump();
    },
  };
}

/* ---------------- claim drawer ---------------- */

function useShowClaim() {
  const layer = useLayer();
  const app = useApp();
  const { approve, reject } = useClaimActions();

  return (id: string) => {
    const c = CLAIMS.find((x) => x.id === id);
    if (!c) return;
    const e = EMAP[c.empId];
    const canAct = c.status === 'Submitted' && (app.role === 'admin' || isMyReport(app.meId, c.empId));

    layer.drawer({
      title: c.title,
      sub: `${c.id} · ${e.name} · ${inr(c.total)}`,
      body: (
        <>
          <div className="row" style={{ gap: 10, marginBottom: 14 }}>
            <ClaimBadge status={c.status} />
            <Chip>{c.items.length} line items</Chip>
            <Chip>Approver: {empName(c.approverId || '')}</Chip>
          </div>
          {c.note && (
            <div style={{ marginBottom: 14 }}>
              <Banner kind="warn" icon="⚠️">{c.note}</Banner>
            </div>
          )}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Category</th><th>Date</th><th>Merchant</th><th>Project</th><th className="num">Amount</th><th>Receipt</th></tr>
              </thead>
              <tbody>
                {c.items.map((i: ExpItem) => (
                  <tr key={i.id}>
                    <td>
                      {expCat(i.cat).ic} {expCat(i.cat).n}
                      {i.overLimit && <div><Badge kind="warn">Above limit {inr(expCat(i.cat).limit)}</Badge></div>}
                    </td>
                    <td className="nowrap">{fmtD(i.date)}</td>
                    <td>{i.merchant}</td>
                    <td>{i.project ? projOf(i.project).name : <span className="muted">—</span>}</td>
                    <td className="num strong">{inr(i.amount)}</td>
                    <td>{i.receipt ? <a>📎 View</a> : <span className="muted">Not required</span>}</td>
                  </tr>
                ))}
                <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                  <td colSpan={4}>Total</td><td className="num">{inr(c.total)}</td><td />
                </tr>
              </tbody>
            </table>
          </div>
          <Divide />
          <KV rows={[
            ['Submitted on', fmtD(c.submittedOn)],
            ['Acted on', c.actedOn ? fmtD(c.actedOn) : 'Pending'],
            ['Reimbursed on', c.reimbursedOn ? `${fmtD(c.reimbursedOn)} · ${monthLabel(c.payrollMonth!)} payroll` : 'Not yet'],
            ['Tax treatment', 'Non-taxable — supported by bills'],
          ]} />
        </>
      ),
      footer: (close) =>
        canAct ? (
          <>
            <button className="btn" onClick={close}>Close</button>
            <button className="btn" onClick={() => { reject(c); close(); }}>Reject</button>
            <button className="btn primary" onClick={() => { approve(c); close(); }}>Approve {inr(c.total)}</button>
          </>
        ) : <button className="btn" onClick={close}>Close</button>,
    });
  };
}

/* ---------------- new claim / advance ---------------- */

function NewClaimForm({ close }: { close: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [cat, setCat] = useState(EXP_CATS[0].id);
  const [date, setDate] = useState(ymd(TODAY));
  const [amount, setAmount] = useState(0);
  const [merchant, setMerchant] = useState('');
  const [project, setProject] = useState('');

  const limit = expCat(cat).limit;
  const over = amount > limit;

  return (
    <>
      <div className="field"><label>Claim title</label>
        <input className="input" placeholder="Client visit — Mumbai" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="grid g2" style={{ gap: '0 14px' }}>
        <div className="field"><label>Category</label>
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
            {EXP_CATS.map((c) => <option key={c.id} value={c.id}>{c.ic} {c.n} — limit {inr(c.limit)}</option>)}
          </select>
        </div>
        <div className="field"><label>Expense date</label>
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field"><label>Amount</label>
          <input type="number" className="input" value={amount} onChange={(e) => setAmount(+e.target.value || 0)} />
        </div>
        <div className="field"><label>Merchant</label>
          <input className="input" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
        </div>
      </div>
      <div className="field"><label>Bill to project (optional)</label>
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">Not project-billable</option>
          {PROJECTS.filter((p) => p.billable).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <Banner kind={over ? 'warn' : 'info'} icon={over ? '⚠️' : 'ℹ️'}>
        {over
          ? `${inr(amount)} is above the ${expCat(cat).n} limit of ${inr(limit)} — your manager will need to record an override.`
          : `Within the ${expCat(cat).n} limit of ${inr(limit)}. ${expCat(cat).proof ? 'A receipt is mandatory.' : 'No receipt required.'}`}
      </Banner>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!amount} onClick={() => {
          CLAIMS.unshift({
            id: 'EXP-' + (4200 + CLAIMS.length),
            empId: app.meId,
            title: title || 'Expense claim',
            items: [{
              id: uid('EX'), cat, date, amount, merchant: merchant || '—',
              desc: 'Self-service claim', receipt: expCat(cat).proof ? 'receipt.pdf' : null,
              project: project || null, overLimit: over,
            }],
            total: amount,
            status: 'Submitted',
            submittedOn: ymd(TODAY),
            approverId: app.me.managerId,
            actedOn: null, reimbursedOn: null, payrollMonth: null, note: '',
          });
          close();
          app.toast('Claim submitted to ' + empName(app.me.managerId || ''), 'ok');
          app.bump();
        }}>Submit claim</button>
      </div>
    </>
  );
}

function NewAdvanceForm({ close }: { close: () => void }) {
  const app = useApp();
  const [amount, setAmount] = useState(25000);
  const [reason, setReason] = useState('');
  return (
    <>
      <div className="field"><label>Amount</label>
        <input type="number" className="input" value={amount} onChange={(e) => setAmount(+e.target.value || 0)} />
      </div>
      <div className="field"><label>Reason</label>
        <textarea className="input" placeholder="Client travel to Singapore…" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <Banner kind="info" icon="💳">
        Paid within 2 working days of approval. Settle it with an expense claim within 15 days of returning.
      </Banner>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={() => {
          ADVANCES.unshift({
            id: 'ADV-' + (300 + ADVANCES.length), empId: app.meId, amount,
            reason: reason || 'Travel advance', requestedOn: ymd(TODAY), status: 'Pending', settled: 0,
          });
          close();
          app.toast('Advance request submitted', 'ok');
          app.bump();
        }}>Request advance</button>
      </div>
    </>
  );
}

function useExpenseModals() {
  const layer = useLayer();
  return {
    newClaim: () => layer.modal({ title: 'New expense claim', sub: 'Goes to your reporting manager', body: (c) => <NewClaimForm close={c} />, footer: null }),
    newAdvance: () => layer.modal({ title: 'Request travel advance', sub: 'Paid within 2 working days of approval', size: 'narrow', body: (c) => <NewAdvanceForm close={c} />, footer: null }),
  };
}

/* ---------------- My claims ---------------- */

function ExMy() {
  const app = useApp();
  const show = useShowClaim();
  const { newClaim, newAdvance } = useExpenseModals();

  const mine = CLAIMS.filter((c) => c.empId === app.meId);
  const settled = mine.filter((c) => c.status === 'Reimbursed');
  const pend = mine.filter((c) => ['Submitted', 'Approved'].includes(c.status));
  const byCat = EXP_CATS.map((c) => ({
    k: c.n, c: c.c, v: sum(mine.flatMap((x) => x.items).filter((i) => i.cat === c.id), (i) => i.amount),
  })).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={newClaim}>＋ New expense claim</button>
        <button className="btn" onClick={newAdvance}>＋ Request travel advance</button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          Approver: {empName(app.me.managerId || '')} · reimbursed with the next payroll
        </span>
      </div>

      <div className="grid g4">
        <Tile label="Reimbursed" value={inr(sum(settled, (c) => c.total))} foot={`${settled.length} claims settled`} />
        <Tile label="Awaiting payment" value={inr(sum(pend, (c) => c.total))} foot={`${pend.length} in progress`} />
        <Tile label="Claims raised" value={mine.length} foot="All time" />
        <Tile label="Avg processing" value="4 days" foot="Submission to reimbursement" />
      </div>

      <div className="grid g-2-1">
        <Card title="My claims" sub={`${mine.length} total`} flush
          actions={<button className="btn sm" onClick={() => exportClaims(mine, 'my_expense_claims.csv')}>⤓ Export</button>}>
          <ClaimTable list={mine} onOpen={(c) => show(c.id)} />
        </Card>
        <Card title="Spend by category" sub="All time">
          {byCat.length ? <HBar rows={sortBy(byCat, (r) => -r.v)} fmt={(v) => inr(v)} /> : <EmptyState msg="No claims yet" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Approvals ---------------- */

function ExAppr() {
  const app = useApp();
  const show = useShowClaim();
  const { approve, reject, pay } = useClaimActions();
  const ids = visibleIds(app.role, app.meId).filter((i) => i !== app.meId);
  const pend = CLAIMS.filter((c) => c.status === 'Submitted' && ids.includes(c.empId));
  const overLimit = pend.filter((c) => c.items.some((i) => i.overLimit));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Awaiting approval" value={pend.length} foot={inr(sum(pend, (c) => c.total)) + ' total value'} />
        <Tile label="Above policy limit" value={overLimit.length} foot="Need an explicit override" />
        <Tile label="Approved this month"
          value={CLAIMS.filter((c) => ids.includes(c.empId) && c.actedOn && monthKey(c.actedOn) === monthKey(TODAY)).length}
          foot="Moving to payroll" />
        <Tile label="Avg claim value" value={inr(sum(pend, (c) => c.total) / Math.max(1, pend.length))} foot="Pending queue" />
      </div>

      <Card title="Claims awaiting your approval" sub={`${pend.length} claims`} flush
        actions={pend.length ? (
          <button className="btn sm primary" onClick={() => {
            const within = pend.filter((c) => !c.items.some((i) => i.overLimit));
            within.forEach(approve);
            app.toast(within.length + ' claims approved', 'ok');
          }}>Approve all within policy</button>
        ) : undefined}>
        <ClaimTable list={pend} showEmp actions onOpen={(c) => show(c.id)} onApprove={approve} onReject={reject} onPay={pay} />
      </Card>

      {overLimit.length > 0 && (
        <Banner kind="warn" icon="⚠️" title={`${overLimit.length} claim(s) exceed policy limits`}>
          Open the claim to see which line items are above limit. Approving them records an explicit override in the audit log.
        </Banner>
      )}
    </div>
  );
}

/* ---------------- All claims ---------------- */

function ExAll() {
  const app = useApp();
  const show = useShowClaim();
  const { approve, reject, pay } = useClaimActions();
  const [status, setStatus] = useState('');
  const ids = visibleIds(app.role, app.meId);
  const list = CLAIMS.filter((c) => ids.includes(c.empId));
  const shown = status ? list.filter((c) => c.status === status) : list;

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['Submitted', 'Approved', 'Reimbursed', 'Rejected'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() => exportClaims(list, 'expense_claims.csv')}>⤓ Export</button>
      </div>

      <Card title="All claims" sub={`${list.length} records · ${SCOPE[app.role].label}`} flush>
        <ClaimTable list={shown} showEmp actions={app.role === 'admin'} onOpen={(c) => show(c.id)}
          onApprove={approve} onReject={reject} onPay={pay} />
      </Card>
    </div>
  );
}

/* ---------------- Travel advances ---------------- */

function AdvTable({ list, act, onApprove }: { list: Advance[]; act: boolean; onApprove: (a: Advance) => void }) {
  if (!list.length) return <EmptyState msg="No advances" icon="💳" />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {act && <th>Employee</th>}
            <th>Reference</th><th className="num">Amount</th><th>Reason</th><th>Requested</th>
            <th className="num">Settled</th><th>Status</th>
            {act && <th className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id}>
              {act && <td><PersonCell e={EMAP[a.empId]} /></td>}
              <td className="mono">{a.id}</td>
              <td className="num strong">{inr(a.amount)}</td>
              <td>{a.reason}</td>
              <td className="nowrap">{fmtD(a.requestedOn)}</td>
              <td className="num">{inr(a.settled)}</td>
              <td><Badge kind={a.status === 'Settled' ? 'good' : a.status === 'Approved' ? 'info' : 'warn'}>{a.status}</Badge></td>
              {act && (
                <td className="right">
                  {a.status === 'Pending'
                    ? <button className="btn sm primary" onClick={() => onApprove(a)}>Approve</button>
                    : <span className="muted">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExAdv() {
  const app = useApp();
  const { newAdvance } = useExpenseModals();
  const ids = visibleIds(app.role, app.meId);
  const mine = ADVANCES.filter((a) => a.empId === app.meId);
  const team = app.role === 'employee' ? [] : ADVANCES.filter((a) => ids.includes(a.empId) && a.empId !== app.meId);

  const approve = (a: Advance) => {
    a.status = 'Approved';
    app.toast('Advance approved — payout in 2 working days', 'ok');
    app.bump();
  };

  return (
    <div className="stack">
      <Banner kind="info" icon="💳" title="How travel advances work">
        Request an advance before travel; it is paid within 2 working days. Submit the expense claim within 15 days of
        returning — the advance is adjusted against it and any balance is recovered from payroll.
      </Banner>

      <Card title="My advances" sub={`${mine.length} requests`} flush
        actions={<button className="btn sm primary" onClick={newAdvance}>＋ Request advance</button>}>
        <AdvTable list={mine} act={false} onApprove={approve} />
      </Card>

      {app.role !== 'employee' && (
        <Card title="Team advances" sub={`${team.length} requests`} flush>
          <AdvTable list={team} act onApprove={approve} />
        </Card>
      )}
    </div>
  );
}

/* ---------------- Analytics ---------------- */

function ExAna() {
  const app = useApp();
  const ids = visibleIds(app.role, app.meId);
  const list = CLAIMS.filter((c) => ids.includes(c.empId));
  const items = list.flatMap((c) => c.items.map((i) => ({ ...i, empId: c.empId, status: c.status })));

  const byCat = EXP_CATS.map((c) => ({ k: c.n, c: c.c, v: sum(items.filter((i) => i.cat === c.id), (i) => i.amount) })).filter((r) => r.v);
  const byDept = DEPTS.map((d) => ({
    k: d.name, c: d.color, v: sum(items.filter((i) => EMAP[i.empId]?.dept === d.id), (i) => i.amount),
  })).filter((r) => r.v);
  const byProject = PROJECTS.map((p) => ({
    k: p.name, c: p.color, v: sum(items.filter((i) => i.project === p.id), (i) => i.amount),
  })).filter((r) => r.v);

  const months: { k: string; l: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    months.push({ k: monthKey(d), l: MON[d.getMonth()] });
  }
  const trend = months.map((m) => sum(list.filter((c) => monthKey(c.submittedOn) === m.k), (c) => c.total));

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="Total claimed" value={lakh(sum(items, (i) => i.amount))} foot={`${list.length} claims`} />
        <Tile label="Reimbursed" value={lakh(sum(list.filter((c) => c.status === 'Reimbursed'), (c) => c.total))} foot="Settled through payroll" />
        <Tile label="Policy breaches" value={items.filter((i) => i.overLimit).length} foot="Line items above limit" />
        <Tile label="Avg per employee"
          value={inr(sum(items, (i) => i.amount) / Math.max(1, uniq(list.map((c) => c.empId)).length))}
          foot="Among claimants" />
      </div>

      <Card title="Expense trend" sub="Claim value submitted per month">
        <BarChart labels={months.map((m) => m.l)} height={210} padLeft={56}
          fmt={(v) => inr(v)} tickFmt={(v) => lakh(v)}
          series={[{ name: 'Claimed', color: 'var(--s1)', data: trend }]} />
      </Card>

      <div className="grid g3">
        <Card title="By category" sub="All claims"><HBar rows={sortBy(byCat, (r) => -r.v)} fmt={(v) => inr(v)} /></Card>
        <Card title="By department" sub="Cost centre view"><HBar rows={sortBy(byDept, (r) => -r.v)} fmt={(v) => inr(v)} /></Card>
        <Card title="Billable to project" sub="Client-recoverable spend">
          {byProject.length ? <HBar rows={sortBy(byProject, (r) => -r.v)} fmt={(v) => inr(v)} /> : <EmptyState msg="No project-tagged spend" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Policy ---------------- */

function ExPolicy() {
  return (
    <div className="grid g-2-1">
      <Card title="Expense policy" sub="Effective 1 April 2026 · limits are per claim line unless stated" flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Category</th><th className="num">Limit</th><th>Receipt required</th><th>Notes</th></tr></thead>
            <tbody>
              {EXP_CATS.map((c) => (
                <tr key={c.id}>
                  <td><span style={{ marginRight: 7 }}>{c.ic}</span><b>{c.n}</b></td>
                  <td className="num">{inr(c.limit)}</td>
                  <td>{c.proof ? <Badge kind="warn">Mandatory</Badge> : <Badge>Not required</Badge>}</td>
                  <td className="muted">{CAT_NOTES[c.id]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Rules" sub="Read before you claim">
        <div className="stack" style={{ gap: 11, fontSize: 13 }}>
          {RULES.map(([k, v]) => (
            <div key={k}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{k}</div>
              <div className="muted">{v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'my' | 'appr' | 'all' | 'adv' | 'ana' | 'policy';

function Expenses() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'my', label: 'My Claims' }, { v: 'adv', label: 'Travel Advances' }, { v: 'policy', label: 'Expense Policy' }]
    : [
        { v: 'my', label: 'My Claims' }, { v: 'appr', label: 'Approvals' }, { v: 'all', label: 'All Claims' },
        { v: 'adv', label: 'Travel Advances' }, { v: 'ana', label: 'Analytics' }, { v: 'policy', label: 'Expense Policy' },
      ];

  const [tab, setTab] = useState<Tab>('my');
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'my' && <ExMy />}
      {active === 'appr' && <ExAppr />}
      {active === 'all' && <ExAll />}
      {active === 'adv' && <ExAdv />}
      {active === 'ana' && <ExAna />}
      {active === 'policy' && <ExPolicy />}
    </>
  );
}

registerModule({
  key: 'expenses',
  title: TITLES.expenses,
  subtitle: () => 'Claims, travel advances and policy limits · reimbursed with payroll',
  Component: Expenses,
});
