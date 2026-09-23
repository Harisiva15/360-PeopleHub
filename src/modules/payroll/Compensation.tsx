/**
 * One employee's compensation — what it is, what it was, and revising it.
 *
 * **A revision is an insert, never an edit.** The previous structure closes the
 * day before this one begins and both rows stay, because an employee's pay
 * history is the evidence behind every payslip already issued and every letter
 * that quotes a salary. The history below is therefore a record, not a log
 * somebody can tidy.
 *
 * **The reconciliation is shown before the save, not after the refusal.** The
 * server will not accept a CTC the components do not add up to, so the same
 * arithmetic runs here as the number is typed. Both sides use
 * `lib/compensation.ts` and `checks/compensation.ts` fails if they disagree —
 * a preview that can differ from the outcome is worse than no preview.
 *
 * Nothing is rounded to close a gap. A few rupees quietly moved into Special
 * Allowance is how a payslip comes to disagree with an offer letter, and then
 * neither party can say which one was wrong.
 */

import { useState } from 'react';
import { fmtD, TODAY, ymd } from '../../lib/dates';
import { inr } from '../../lib/format';
import { applyComponents } from '../../lib/compensation';
import { Badge, Banner, Card, EmptyState, KV, Table, TableWrap } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useApp } from '../../state/AppContext';
import type { Employee, SalaryComponent, StructureRow } from '../../services';
import { useSalaryComponents, useSalaryHistory, useSetStructure } from './data';

const money = (n: number, ccy: string) =>
  ccy === 'INR' ? inr(n) : `${ccy} ${new Intl.NumberFormat('en-US').format(Math.round(n))}`;

/** The breakdown a CTC comes to, with the arithmetic beside each line. */
function Breakdown({ components, ctc, ccy }: {
  components: SalaryComponent[];
  ctc: number;
  ccy: string;
}) {
  const r = applyComponents(components, ctc);
  const earnings = r.lines.filter((l) => l.kind === 'earning');
  const employer = r.lines.filter((l) => l.kind === 'employer_contribution');
  const other = r.lines.filter((l) => !['earning', 'employer_contribution'].includes(l.kind));

  const section = (label: string, lines: typeof r.lines) => lines.length > 0 && (
    <>
      <tr><th colSpan={3} style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</th></tr>
      {lines.map((l) => (
        <tr key={l.code}>
          <td>{l.name}</td>
          <td className="muted" style={{ fontSize: 12 }}>{l.basis}</td>
          <td className="num">{money(l.annual, ccy)}</td>
        </tr>
      ))}
    </>
  );

  return (
    <div className="stack" style={{ gap: 10 }}>
      <TableWrap>
        <Table>
          <thead>
            <tr><th>Component</th><th>Calculated as</th><th className="num">Annual</th></tr>
          </thead>
          <tbody>
            {section('Earnings', earnings)}
            {section('Employer cost', employer)}
            {section('Other', other)}
            <tr>
              <td colSpan={2}><b>Counted towards CTC</b></td>
              <td className="num strong">{money(r.counted, ccy)}</td>
            </tr>
          </tbody>
        </Table>
      </TableWrap>

      {r.balances ? (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Reconciles to a CTC of {money(ctc, ccy)}.
        </div>
      ) : (
        <Banner kind="warn" title="This does not reconcile to the CTC">
          The components come to {money(r.counted, ccy)} against a CTC of{' '}
          {money(ctc, ccy)} — {money(Math.abs(r.difference), ccy)}{' '}
          {r.difference > 0 ? 'more' : 'short'}. Saving will be refused until they
          agree. Adjust a component under Settings → Salary components; nothing is
          rounded here to force a match.
        </Banner>
      )}
    </div>
  );
}

/** Revise what somebody is paid, from a date. */
function ReviseForm({ person, current, close }: {
  person: Employee;
  current: StructureRow | undefined;
  close: () => void;
}) {
  const app = useApp();
  const set = useSetStructure();
  const { data: components = [] } = useSalaryComponents();

  const [ctc, setCtc] = useState(String(current?.ctc ?? person.ctc ?? ''));
  const [from, setFrom] = useState(ymd(TODAY));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const n = Number(ctc);
  const valid = Number.isFinite(n) && n > 0;
  const check = valid ? applyComponents(components, n) : null;
  const ccy = current?.currency ?? person.ccy ?? 'INR';

  /* A revision must start after the one it replaces, which is the rule the
     server enforces; saying so here saves a round trip to be told. */
  const tooEarly = current ? from <= current.validFrom : false;

  const save = async () => {
    setBusy(true);
    try {
      await set.mutate(person.id, {
        ctc: n, validFrom: from, currency: ccy, reason: reason.trim(),
      });
      app.toast('Compensation recorded', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not save the compensation', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="grid g2">
        <label className="fld">
          <span>Annual CTC</span>
          <input className="input" type="number" min="1" value={ctc} autoFocus
            onChange={(e) => setCtc(e.target.value)} />
        </label>
        <label className="fld">
          <span>Effective from</span>
          <input className="input" type="date" value={from}
            onChange={(e) => setFrom(e.target.value)} />
        </label>
      </div>
      <label className="fld">
        <span>Reason for the change</span>
        <input className="input" value={reason}
          placeholder="Annual revision, promotion to L4, market correction…"
          onChange={(e) => setReason(e.target.value)} />
      </label>

      {current && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          The compensation in force — {money(current.ctc, current.currency)} from{' '}
          {fmtD(current.validFrom)} — will close on the day before this one begins.
          It stays on the record.
        </div>
      )}
      {tooEarly && (
        <Banner kind="warn" title="That date is not after the current compensation">
          The one in force starts on {fmtD(current!.validFrom)}. A revision has to
          begin after it, so the two do not describe the same day.
        </Banner>
      )}

      {components.length === 0 ? (
        <Banner kind="info" title="No components are defined">
          The CTC will be recorded and the payslip will use the built-in defaults —
          basic at 40% of CTC, HRA at half of basic. Define components under
          Settings → Salary components to use the company&rsquo;s own structure.
        </Banner>
      ) : valid ? (
        <Breakdown components={components} ctc={n} ccy={ccy} />
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>Enter a CTC to see the breakdown.</div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save}
          disabled={busy || !valid || tooEarly || (check !== null && components.length > 0 && !check.balances)}>
          {busy ? 'Saving…' : 'Save compensation'}
        </button>
      </div>
    </div>
  );
}

/**
 * The whole compensation picture for one person.
 *
 * Read-only for anybody but an admin — an employee reaches this through My
 * Payroll to see their own, and the Revise button is simply not there. The
 * server refuses the write either way; this is so nobody is offered a button
 * that cannot work.
 */
export function CompensationPanel({ person, canRevise, onRevise }: {
  person: Employee;
  canRevise: boolean;
  onRevise: (current: StructureRow | undefined) => void;
}) {
  const { data: history = [], loading } = useSalaryHistory(person.id);
  const { data: components = [] } = useSalaryComponents();
  const current = history.find((h) => h.current);
  const ccy = current?.currency ?? person.ccy ?? 'INR';

  return (
    <div className="stack">
      <Card title="Current compensation" sub={current ? `Effective ${fmtD(current.validFrom)}` : undefined}
        actions={canRevise
          ? <button className="btn sm primary" onClick={() => onRevise(current)}>
              {current ? 'Revise' : 'Set compensation'}
            </button>
          : undefined}>
        <KV rows={[
          ['Employee', `${person.name} · ${person.code}`],
          ['Designation', person.designation],
          ['Annual CTC', current
            ? <b>{money(current.ctc, ccy)}</b>
            : <span className="muted">
                {person.ctc ? `${money(person.ctc, ccy)} — from the employee record` : 'Not set'}
              </span>],
          ['Annual gross', current ? money(current.gross, ccy) : '—'],
          ['Source', current
            ? 'A recorded compensation structure'
            : 'Derived from the employee record — no structure has been recorded'],
        ]} />
      </Card>

      {current && components.length > 0 && (
        <Card title="Breakdown" sub="The company’s components applied to this CTC">
          <Breakdown components={components} ctc={current.ctc} ccy={ccy} />
        </Card>
      )}

      <Card title="Compensation history"
        sub={history.length > 1 ? `${history.length} versions` : undefined} flush>
        {loading ? (
          <div style={{ padding: 16 }} className="muted">Loading…</div>
        ) : history.length === 0 ? (
          <div style={{ padding: 16 }}>
            <EmptyState icon={<Icon n="money" size="lg" />}
              msg="No compensation has been recorded. Payroll uses the CTC on the employee record until one is." />
          </div>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Effective</th><th>Until</th><th className="num">CTC</th>
                  <th className="num">Gross</th><th>Reason</th><th>Recorded by</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="nowrap">{fmtD(h.validFrom)}</td>
                    <td className="nowrap">{h.validTo ? fmtD(h.validTo) : '—'}</td>
                    <td className="num strong">{money(h.ctc, h.currency)}</td>
                    <td className="num">{money(h.gross, h.currency)}</td>
                    <td>{h.reason || <span className="muted">—</span>}</td>
                    <td>{h.createdBy || <span className="muted">—</span>}</td>
                    <td>
                      {h.current
                        ? <Badge kind="good">In force</Badge>
                        : <Badge kind="mute">Superseded</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

export { ReviseForm };
