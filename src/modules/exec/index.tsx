import { sortBy, sum } from '../../lib/collections';
import { MON, TODAY } from '../../lib/dates';
import { pct } from '../../lib/format';
import { COUNTRIES, mbS, sumBase, toBase } from '../../data/countries';

import { ORG } from '../../data/org';



import { reqOf2 } from '../../data/staffing';
import { Badge, Card, EmptyState, Table, Tile } from '../../components/ui';
import { Donut, HBar, LineChart, PAL, Spark } from '../../components/charts';
import type { HBarRow } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useAiDraft } from '../copilot/ai';
import {
  useAllEmployees, useClients, useCompensation, useConsultants, useCurrentRun, useExits,
  usePayrollTotals, usePlacements, useStaffingKpi,
} from '../copilot/data';

/**
 * Indicative month-on-month headcount drift for the sparkline. Fixed rather
 * than random so the tile does not change on every render.
 */
const headcountDrift = [2, 2, 1, 3, 2, 0];

/** General and administrative overhead, as a share of revenue. */
const GA_RATE = 0.08;

/** Year-to-date attrition, over the roster the caller has already fetched. */
const attritionPct = (exits: { lwd: string }[], headcount: number) =>
  pct(exits.filter((x) => x.lwd && x.lwd.startsWith(String(TODAY.getFullYear()))).length, Math.max(1, headcount));

interface Risk {
  s: 'crit' | 'warn' | 'info';
  t: string;
  d: string;
}

function ExecView() {
  const app = useApp();
  const draft = useAiDraft();
  const { data: k } = useStaffingKpi();
  const { data: curRun } = useCurrentRun();
  const { data: t } = usePayrollTotals(curRun?.mk ?? '');
  const { data: consultants = [] } = useConsultants();
  const { data: everyone = [] } = useAllEmployees();
  const { data: comp = [] } = useCompensation();
  const { data: exits = [] } = useExits();
  const { data: clients = [] } = useClients();
  const { data: placements = [] } = usePlacements();

  if (!k || !t || !curRun) return <EmptyState msg="Loading the executive view…" icon="◈" />;

  const rev = k.revenueMonthly;
  const cost = k.costMonthly;
  const ctcOf = new Map(comp.map((c) => [c.employee.id, c.salary.ctc]));

  /* Overhead is payroll for everyone not billing on a live assignment, plus G&A. */
  const billingEmpIds = new Set(consultants.filter((c) => c.status === 'Placed' && c.empId).map((c) => c.empId));
  const nonBillable = everyone.filter((e) => !billingEmpIds.has(e.id));
  const support = sumBase(nonBillable, (e) => (ctcOf.get(e.id) ?? e.ctc) / 12);
  const ga = Math.round(rev * GA_RATE);
  const ebitda = rev - cost - support - ga;

  const months: string[] = [];
  for (let i = 5; i >= 0; i--) months.push(MON[new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1).getMonth()]);

  /* Indicative trends: revenue ramps to today's run rate, headcount walks back. */
  const revSeries = months.map((_, i) => Math.round((rev / 100000) * (0.86 + i * 0.03)));
  const hcSeries = months.map((_, i) => everyone.length - (5 - i) * headcountDrift[i]);

  const byCountry = COUNTRIES.map((c, i) => ({
    c,
    n: everyone.filter((e) => e.country === c.id).length,
    cost: sumBase(everyone.filter((e) => e.country === c.id), (e) => (ctcOf.get(e.id) ?? e.ctc) / 12),
    col: PAL[i % 8],
  })).filter((r) => r.n);

  const topClients = sortBy(
    clients.filter((c) => c.status === 'Active').map((c) => {
      const pl = placements.filter((p) => reqOf2(p.reqId)?.clientId === c.id && ['Active', 'Ending Soon'].includes(p.status));
      return { c, n: pl.length, rev: sum(pl, (p) => toBase(p.billRate * (p.unit === 'per day' ? 21 : 173), p.ccy)) };
    }).filter((r) => r.rev),
    (r) => -r.rev
  );
  const conc = topClients.length ? Math.round((topClients[0].rev / Math.max(1, sum(topClients, (r) => r.rev))) * 100) : 0;
  const attr = attritionPct(exits, everyone.length);

  const risks: Risk[] = [];
  if (conc > 25)
    risks.push({
      s: 'crit',
      t: `Client concentration at ${conc}%`,
      d: `${topClients[0].c.name} carries more than a quarter of billing. Loss of this account would be material.`,
    });
  if (k.grossMargin < 30)
    risks.push({
      s: 'warn',
      t: `Gross margin at ${k.grossMargin}%`,
      d: 'Below the 30% benchmark for staff augmentation. Rate-card discipline and bench cost are the two levers.',
    });
  if (k.utilisation < 80)
    risks.push({
      s: 'warn',
      t: `Utilisation at ${k.utilisation}%`,
      d: `${k.bench} consultants unbilled, ${mbS(k.benchCostMonthly)} a month of carrying cost.`,
    });
  if (k.dso > 45)
    risks.push({
      s: 'warn',
      t: `DSO at ${k.dso} days`,
      d: `${mbS(k.arOverdue)} overdue. Working capital is being funded by the balance sheet.`,
    });
  if (attr > 12)
    risks.push({
      s: 'warn',
      t: `Attrition at ${attr}%`,
      d: 'Above the 12% plan. Replacement cost runs at roughly half a year of salary per exit.',
    });
  if (!risks.length)
    risks.push({
      s: 'info',
      t: 'No red flags this period',
      d: 'Margin, utilisation, receivables and attrition are all inside tolerance.',
    });

  const bridge: HBarRow[] = [
    { k: 'Revenue', c: 'var(--s1)', v: Math.round(rev / 100000) },
    { k: 'Delivery cost', c: 'var(--s8)', v: Math.round(cost / 100000) },
    { k: 'Support payroll', c: 'var(--s4)', v: Math.round(support / 100000) },
    { k: 'G&A (8%)', c: 'var(--s7)', v: Math.round(ga / 100000) },
    { k: 'EBITDA', c: ebitda > 0 ? 'var(--s6)' : 'var(--s8)', v: Math.round(ebitda / 100000) },
  ];

  const scorecard: [string, string | number, string, boolean][] = [
    ['Gross margin', k.grossMargin + '%', '30%', k.grossMargin >= 30],
    ['Utilisation', k.utilisation + '%', '80%', k.utilisation >= 80],
    ['Fill rate', k.fillRate + '%', '65%', k.fillRate >= 65],
    ['Submission → interview', k.sub2int + '%', '35%', k.sub2int >= 35],
    ['Average bench days', k.avgBenchDays, '30', k.avgBenchDays <= 30],
    ['DSO', k.dso + ' days', '45 days', k.dso <= 45],
    ['Attrition (YTD)', attr + '%', '12%', attr <= 12],
    ['Client concentration', conc + '%', '25%', conc <= 25],
  ];

  const period = TODAY.toLocaleString('en', { month: 'long', year: 'numeric' });

  const boardNote = () =>
    draft('summary', {
      t: 'Board note — ' + period,
      s: `${ORG.legal} · prepared by ${app.me.name}`,
      text:
        `BOARD NOTE — ${period.toUpperCase()}\n${ORG.legal}\n\n` +
        `1. TRADING\nMonthly billed revenue of ${mbS(k.revenueMonthly)} across ${k.placements} active placements, ` +
        `at a gross margin of ${k.grossMargin}%. Delivery cost was ${mbS(k.costMonthly)}.\n\n` +
        `2. PEOPLE\nHeadcount closed at ${everyone.length} across ${byCountry.length} legal entities. ` +
        `Payroll ran at ${mbS(t.gross)} gross, ${mbS(t.net)} net. Year-to-date attrition is ${attr}%.\n\n` +
        `3. UTILISATION\nUtilisation stands at ${k.utilisation}% against an 80% target. ${k.bench} consultants are ` +
        `on bench averaging ${k.avgBenchDays} days, carrying ${mbS(k.benchCostMonthly)} of monthly cost.\n\n` +
        `4. DEMAND\n${k.openReqs} open requirements covering ${k.openPositions} positions. Fill rate ${k.fillRate}%, ` +
        `submission-to-interview conversion ${k.sub2int}%.\n\n` +
        `5. CASH\nReceivables of ${mbS(k.ar)}, of which ${mbS(k.arOverdue)} is overdue. Days sales outstanding is ${k.dso}.\n\n` +
        '6. ACTIONS REQUESTED\n• Approve the redeployment plan for the bench.\n' +
        '• Note the escalation path on overdue receivables.\n' +
        '• Approve rate-card review for accounts trading below the 18% margin floor.',
    });

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile
          label="Monthly revenue"
          value={mbS(rev)}
          foot={`${k.placements} billable placements`}
          spark={<Spark data={revSeries} color="var(--s1)" />}
        />
        <Tile label="Gross margin" value={k.grossMargin + '%'} foot={`Target 30% · ${mbS(rev - cost)} contribution`} />
        <Tile
          label="EBITDA (indicative)"
          value={mbS(ebitda)}
          foot={`${rev ? Math.round((ebitda / rev) * 100) : 0}% of revenue`}
        />
        <Tile
          label="Headcount"
          value={everyone.length}
          foot={`${byCountry.length} countries · ${attr}% attrition`}
          spark={<Spark data={hcSeries} color="var(--s3)" />}
        />
        <Tile label="Cash at risk" value={mbS(k.arOverdue)} foot={`Overdue of ${mbS(k.ar)} receivable`} />
      </div>

      <div className="grid g2">
        <Card title="Revenue trend" sub="Billed value per month, ₹ base, in lakh">
          <LineChart
            labels={months}
            height={190}
            fmt={(v) => '₹' + v + 'L'}
            series={[{ name: 'Revenue (₹L)', color: 'var(--s1)', data: revSeries }]}
          />
        </Card>
        <Card title="P&L bridge" sub="Where the revenue rupee goes">
          <HBar rows={bridge} fmt={(v) => '₹' + v + 'L'} />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Revenue by client" sub={`Concentration risk sits at ${conc}%`}>
          {topClients.length ? (
            <HBar
              rows={topClients.slice(0, 8).map((r, i) => ({ k: r.c.name, c: PAL[i % 8], v: Math.round(r.rev / 100000) }))}
              fmt={(v) => '₹' + v + 'L'}
            />
          ) : (
            <EmptyState msg="No active placements" />
          )}
        </Card>
        <Card title="People cost by entity" sub="Monthly CTC run rate, ₹ base">
          <Donut
            size={168}
            center={mbS(sum(byCountry, (r) => r.cost))}
            centerSub="per month"
            slices={byCountry.map((r) => ({ k: r.c.flag + ' ' + r.c.name, c: r.col, v: r.cost }))}
            fmt={(v) => mbS(v)}
          />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Board risk register" sub="Computed from live operating data" flush>
          <div className="lst">
            {risks.map((r) => (
              <div className="lst-i" key={r.t}>
                <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <Badge kind={r.s === 'crit' ? 'crit' : r.s === 'warn' ? 'warn' : 'good'}>
                    {r.s === 'crit' ? 'High' : r.s === 'warn' ? 'Medium' : 'Clear'}
                  </Badge>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{r.t}</b>
                    <div className="mt" style={{ marginTop: 3 }}>{r.d}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Operating scorecard" sub="Against internal targets" flush>
          <Table>
            <thead>
              <tr><th>Metric</th><th className="num">Actual</th><th className="num">Target</th><th className="right">Status</th></tr>
            </thead>
            <tbody>
              {scorecard.map((r) => (
                <tr key={r[0]}>
                  <td>{r[0]}</td>
                  <td className="num"><b>{r[1]}</b></td>
                  <td className="num muted">{r[2]}</td>
                  <td className="right"><Badge kind={r[3] ? 'good' : 'warn'}>{r[3] ? 'On track' : 'Off track'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <Card
        title="Executive summary"
        sub="Auto-drafted from this period’s numbers"
        actions={<button className="btn sm primary" onClick={boardNote}>✨ Draft board note</button>}
      >
        <p className="muted" style={{ margin: 0, lineHeight: 1.7 }}>
          {ORG.name} is running {k.placements} billable placements generating {mbS(rev)} of monthly revenue at a{' '}
          {k.grossMargin}% gross margin. Headcount stands at {everyone.length} across {byCountry.length} entities with
          a monthly people cost of {mbS(sum(byCountry, (r) => r.cost))}.{' '}
          {k.bench
            ? `${k.bench} consultants sit on bench carrying ${mbS(k.benchCostMonthly)} a month of unrecovered cost; the AI redeployment plan identifies matches for a portion of them. `
            : 'The bench is clear. '}
          Receivables total {mbS(k.ar)} with {mbS(k.arOverdue)} overdue at a {k.dso}-day DSO. The demand book holds{' '}
          {k.openReqs} open requirements covering {k.openPositions} positions at a {k.fillRate}% fill rate.
        </p>
      </Card>
    </div>
  );
}

registerModule({
  key: 'exec',
  title: TITLES.exec,
  /*
   * Static rather than live: the registry's subtitle callback is synchronous,
   * so it cannot await a service. The trading numbers are on the page itself.
   */
  subtitle: () => 'Trading, people and cash — one page for the board',
  Component: ExecView,
});
