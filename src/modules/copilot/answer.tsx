import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { sortBy, sum, uniq } from '../../lib/collections';
import { daysBetween, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { BASE_CCY, COUNTRIES, countryOf, mbS, money } from '../../data/countries';

import { deptOf } from '../../data/org';



import { clientOf, invAgeing, reqOf2 } from '../../data/staffing';

import { HBar, PAL } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { Badge, Table } from '../../components/ui';
import type { AnswerSources } from './data';

/** The canned questions, offered as chips and reused in the fallback. */
export const SUGGESTIONS = [
  'Who is on bench?',
  'What is our gross margin?',
  'Which invoices are overdue?',
  'Headcount by country',
  'Open requirements',
  'Attrition this year',
  'Payroll cost this month',
];

interface Answer {
  title: string;
  body: ReactNode;
  route?: string;
}

/** The answer card. Bordered in the series-1 hue so it reads as a response. */
export function AnswerCard({ answer }: { answer: Answer }) {
  return (
    <div className="card" style={{ borderColor: 'var(--s1)' }}>
      <div className="card-b">
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <span className="chip" style={{ borderColor: 'var(--s1)', color: 'var(--s1)' }}>✨ Answer</span>
          <b>{answer.title}</b>
        </div>
        {answer.body}
        {answer.route && (
          <div className="row" style={{ marginTop: 10 }}>
            <Link className="btn sm" to={answer.route}>Open the full view →</Link>
          </div>
        )}
      </div>
    </div>
  );
}

const Lead = ({ children }: { children: ReactNode }) => (
  <p className="muted" style={{ margin: '0 0 8px' }}>{children}</p>
);

/**
 * Intent matching over the live records. Deliberately narrow: where the
 * question does not map onto data we hold, it says so rather than inventing
 * an answer.
 */
export function answerFor(q: string, onAsk: (q: string) => void, src: AnswerSources): Answer {
  const s = q.toLowerCase();
  const has = (...w: string[]) => w.some((x) => s.includes(x));
  const {
    kpi: k, bench, consultants, clients, vendors, invoices, placements, openRequirements,
    employees, exits, leave, leaveTypes, payrollTotals: payTotals,
  } = src;

  if (has('bench', 'unbilled', 'idle')) {
    const b = sortBy(bench, (c) => -(c.benchSince ? daysBetween(c.benchSince, ymd(TODAY)) : 0));
    return {
      title: `${b.length} consultants are on bench`,
      route: '/bench',
      body: (
        <>
          <Lead>
            Costing {mbS(k.benchCostMonthly)} a month, averaging {k.avgBenchDays} days idle.{' '}
            {b.filter((c) => c.benchSince && daysBetween(c.benchSince, ymd(TODAY)) >= 60).length} have been unbilled for over 60 days.
          </Lead>
          <Table>
            <thead>
              <tr><th>Consultant</th><th>Role</th><th className="num">Days</th><th className="num">Cost to date</th></tr>
            </thead>
            <tbody>
              {b.slice(0, 8).map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td><td>{c.role}</td>
                  <td className="num">{c.benchSince ? daysBetween(c.benchSince, ymd(TODAY)) : 0}</td>
                  <td className="num">{money((c.benchSince ? daysBetween(c.benchSince, ymd(TODAY)) : 0) * c.costPerDay, c.ccy)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ),
    };
  }

  if (has('margin', 'profit', 'gross')) {
    const act = placements.filter((p) => ['Active', 'Ending Soon'].includes(p.status));
    const low = act.filter((p) => p.billRate > 0 && (p.billRate - p.payRate) / p.billRate < 0.18);
    const byClient: HBarRow[] = uniq(act.map((p) => clientOf(reqOf2(p.reqId)?.clientId || clients[0]?.id || '').name))
      .map((n, i) => {
        const ps = act.filter((p) => clientOf(reqOf2(p.reqId)?.clientId || clients[0]?.id || '').name === n);
        const r = sum(ps, (p) => p.billRate);
        const c2 = sum(ps, (p) => p.payRate);
        return { k: n, c: PAL[i % 8], v: r ? +(((r - c2) / r) * 100).toFixed(1) : 0 };
      })
      .slice(0, 8);
    return {
      title: `Gross margin is ${k.grossMargin}%`,
      route: '/placements',
      body: (
        <>
          <Lead>
            {mbS(k.revenueMonthly)} of monthly billing against {mbS(k.costMonthly)} of delivery cost, across{' '}
            {k.placements} active placements.{' '}
            {low.length
              ? `${low.length} placement(s) sit below the 18% floor and are dragging the blended number down.`
              : 'Every active placement clears the 18% floor.'}
          </Lead>
          <HBar rows={byClient} fmt={(v) => v + '%'} />
        </>
      ),
    };
  }

  if (has('overdue', 'invoice', 'receivable', 'cash', 'dso', 'unpaid')) {
    const ov = sortBy(invoices.filter((i) => i.status !== 'Paid' && invAgeing(i) > 0), (i) => -invAgeing(i));
    return {
      title: `${mbS(k.arOverdue)} of invoices are overdue`,
      route: '/billing',
      body: (
        <>
          <Lead>
            {ov.length} overdue of {invoices.filter((i) => i.status !== 'Paid').length} open invoices. Total
            receivables {mbS(k.ar)}, days sales outstanding {k.dso}.
          </Lead>
          <Table>
            <thead>
              <tr><th>Invoice</th><th>Client</th><th className="num">Amount</th><th className="num">Days late</th></tr>
            </thead>
            <tbody>
              {ov.slice(0, 8).map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.id}</td>
                  <td>{clientOf(i.clientId).name}</td>
                  <td className="num">{money(i.total, i.ccy)}</td>
                  <td className="num">{invAgeing(i)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ),
    };
  }

  if (has('headcount', 'how many employee', 'country', 'where are')) {
    const rows: HBarRow[] = COUNTRIES.map((c, i) => ({
      k: c.flag + ' ' + c.name,
      c: PAL[i % 8],
      v: employees.filter((e) => e.country === c.id).length,
    })).filter((r) => r.v);
    return {
      title: `${employees.length} active employees across ${rows.length} countries`,
      route: '/employees',
      body: (
        <>
          <HBar rows={sortBy(rows, (r) => -r.v)} />
          <p className="muted" style={{ margin: '8px 0 0' }}>
            Payroll cost this month is {mbS(payTotals.net)} in base currency across all entities.
          </p>
        </>
      ),
    };
  }

  if (has('requirement', 'open role', 'demand', 'req ', 'vacanc')) {
    const o = openRequirements;
    return {
      title: `${o.length} open requirements covering ${k.openPositions} positions`,
      route: '/requirements',
      body: (
        <>
          <Lead>
            Fill rate is {k.fillRate}%. Submission-to-interview conversion {k.sub2int}%, interview-to-placement{' '}
            {k.int2place}%.
          </Lead>
          <Table>
            <thead>
              <tr><th>Requirement</th><th>Client</th><th>Priority</th><th className="num">Open</th><th className="num">Closes</th></tr>
            </thead>
            <tbody>
              {sortBy(o, (r) => daysBetween(ymd(TODAY), r.closeBy)).slice(0, 8).map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td>{clientOf(r.clientId).name}</td>
                  <td><Badge kind={r.priority === 'Critical' ? 'crit' : 'warn'}>{r.priority}</Badge></td>
                  <td className="num">{r.positions - r.filled}</td>
                  <td className="num">{Math.max(0, daysBetween(ymd(TODAY), r.closeBy))}d</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ),
    };
  }

  if (has('attrition', 'resign', 'leaving', 'turnover', 'exit')) {
    const yr = String(TODAY.getFullYear());
    const ex = exits.filter((x) => x.lwd && x.lwd.startsWith(yr));
    const deptOfEmp = (id: string) => employees.find((e) => e.id === id)?.dept;
    const rows: HBarRow[] = uniq(ex.map((x) => deptOfEmp(x.empId)).filter(Boolean) as string[]).map((d, i) => ({
      k: deptOf(d).name,
      c: PAL[i % 8],
      v: ex.filter((x) => deptOfEmp(x.empId) === d).length,
    }));
    return {
      title: `${ex.length} exits recorded this year`,
      route: '/exit',
      body: (
        <>
          <Lead>
            Annualised attrition is {pct(ex.length, Math.max(1, employees.length))}%. Voluntary resignations account
            for {ex.filter((x) => x.type === 'Resignation').length}.
          </Lead>
          <HBar rows={rows} />
        </>
      ),
    };
  }

  if (has('payroll', 'salary cost', 'wage', 'net pay')) {
    const t = payTotals;
    const rows: HBarRow[] = Object.keys(t.byCountry).map((c, i) => ({
      k: countryOf(c).flag + ' ' + countryOf(c).name,
      c: PAL[i % 8],
      v: Math.round(t.byCountry[c].net / 100000),
    }));
    return {
      title: `Payroll for this month is ${mbS(t.net)} net`,
      route: '/payroll',
      body: (
        <>
          <Lead>
            Gross {mbS(t.gross)}, deductions {mbS(t.gross - t.net)}, across {t.count} employees in{' '}
            {Object.keys(t.byCountry).length} entities. All figures converted to {BASE_CCY}.
          </Lead>
          <HBar rows={rows} fmt={(v) => '₹' + v + 'L'} />
        </>
      ),
    };
  }

  if (has('vendor', 'supplier', 'partner')) {
    const ranked = sortBy(vendors, (v) => -(v.score || 0));
    const top = ranked[0];
    return {
      title: `${vendors.length} vendors on the panel`,
      route: '/vendors',
      body: (
        <>
          <Lead>
            {vendors.filter((v) => v.status === 'Active').length} active, supplying{' '}
            {consultants.filter((c) => c.external).length} consultants. Top performer by scorecard is {top?.name ?? '—'} at{' '}
            {top?.score ?? 0}/100.
          </Lead>
          <HBar rows={ranked.slice(0, 8).map((v, i) => ({ k: v.name, c: PAL[i % 8], v: v.score || 0 }))} />
        </>
      ),
    };
  }

  if (has('client', 'account', 'customer')) {
    const rows: HBarRow[] = uniq(clients.map((c) => c.industry)).map((n, i) => ({
      k: n,
      c: PAL[i % 8],
      v: clients.filter((c) => c.industry === n).length,
    }));
    return {
      title: `${clients.filter((c) => c.status === 'Active').length} active clients`,
      route: '/clients',
      body: (
        <>
          <Lead>
            Across {uniq(clients.map((c) => c.country)).length} countries and{' '}
            {uniq(clients.map((c) => c.industry)).length} industries. {clients.filter((c) => c.riskFlag).length}{' '}
            flagged for risk.
          </Lead>
          <HBar rows={rows} />
        </>
      ),
    };
  }

  if (has('leave', 'absent', 'time off')) {
    const pend = leave.filter((l) => l.status === 'Pending').length;
    const busiest = sortBy(
      leaveTypes.map((t) => ({ t, n: leave.filter((l) => l.type === t.id).length })),
      (o) => -o.n
    )[0];
    return {
      title: `${pend} leave requests are pending approval`,
      route: '/leave',
      body: (
        <p className="muted" style={{ margin: 0 }}>
          {leave.filter((l) => l.status === 'Approved').length} approved so far. The highest-volume type is{' '}
          {busiest?.t.name || '—'}.
        </p>
      ),
    };
  }

  return {
    title: 'I could not map that to the data',
    body: (
      <>
        <Lead>I answer from live records only — I do not guess. Try one of these instead:</Lead>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {SUGGESTIONS.slice(0, 6).map((x) => (
            <button key={x} className="btn sm ghost" onClick={() => onAsk(x)}>{x}</button>
          ))}
        </div>
      </>
    ),
  };
}
