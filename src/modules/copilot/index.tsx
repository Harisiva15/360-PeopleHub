import { useState } from 'react';
import { uniq } from '../../lib/collections';
import { daysBetween, TODAY, ymd } from '../../lib/dates';
import { mbS, toBase } from '../../data/countries';

import { Badge, Card, EmptyState, Tile } from '../../components/ui';
import { Chip } from '../../components/common';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useInsights, useMatchViews } from './ai';
import {
  useAllEmployees, useBench, useClients, useConsultants, useCurrentRun, useExits,
  useInvoices, useLeaveAll, useOpenRequirements, usePlacements, usePayrollTotals,
  useStaffingKpi, useVendors,
} from './data';
import type { AnswerSources } from './data';
import { LEAVE_TYPES } from '../../data/org';
import type { InsightSev } from './ai';
import { AnswerCard, answerFor, SUGGESTIONS } from './answer';

const SEV_LABEL: Record<InsightSev, string> = { crit: 'Act now', warn: 'Watch', info: 'FYI' };
const SEV_KIND: Record<InsightSev, 'crit' | 'warn' | 'info'> = { crit: 'crit', warn: 'warn', info: 'info' };

/** Assignments ending inside this window count as revenue at risk. */
const RISK_WINDOW_DAYS = 30;

function AskPanel({ sources }: { sources: AnswerSources | null }) {
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<string | null>(null);

  const ask = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setQ(t);
    setAsked(t);
  };

  return (
    <Card title="Ask the copilot" sub="Natural-language questions answered from live data — no records leave the system">
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Try: who is on bench, what is my margin, which invoices are overdue, headcount by country"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') ask(q); }}
        />
        <button className="btn primary" onClick={() => ask(q)}>Ask</button>
      </div>

      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {SUGGESTIONS.map((s) => (
          <button key={s} className="btn sm ghost" onClick={() => ask(s)}>{s}</button>
        ))}
      </div>

      {asked && sources && (
        <div style={{ marginTop: 12 }}>
          <AnswerCard answer={answerFor(asked, ask, sources)} />
        </div>
      )}
    </Card>
  );
}

function CopilotView() {
  const insights = useInsights();
  const { matchAll } = useMatchViews();
  const [cat, setCat] = useState('');

  const { data: k } = useStaffingKpi();
  const { data: bench = [] } = useBench();
  const { data: consultants = [] } = useConsultants();
  const { data: clients = [] } = useClients();
  const { data: vendors = [] } = useVendors();
  const { data: invoices = [] } = useInvoices();
  const { data: placements = [] } = usePlacements();
  const { data: openRequirements = [] } = useOpenRequirements();
  const { data: employees = [] } = useAllEmployees();
  const { data: exits = [] } = useExits();
  const { data: leave = [] } = useLeaveAll(employees.map((e) => e.id));
  const { data: curRun } = useCurrentRun();
  const { data: payTotals } = usePayrollTotals(curRun?.mk ?? '');

  /* Everything the answerer needs, gathered once and handed over. */
  const sources: AnswerSources | null = k && payTotals && curRun
    ? {
        kpi: k, bench, consultants, clients, vendors, invoices, placements,
        openRequirements, employees, exits, leave,
        leaveTypes: LEAVE_TYPES, payrollTotals: payTotals, currentRunKey: curRun.mk,
      }
    : null;
  const cats = uniq(insights.map((i) => i.cat));
  const active = cats.includes(cat) ? cat : '';
  const list = active ? insights.filter((i) => i.cat === active) : insights;
  const critical = insights.filter((i) => i.sev === 'crit').length;

  const atRisk = placements.filter((p) => {
    const left = daysBetween(ymd(TODAY), p.endOn);
    return p.status === 'Active' && left <= RISK_WINDOW_DAYS && left >= 0;
  }).reduce((t, p) => t + toBase(p.billRate * (p.unit === 'per day' ? 21 : 173), p.ccy), 0);

  return (
    <div className="stack">
      <AskPanel sources={sources} />

      <div className="grid g4">
        <Tile label="Signals raised" value={insights.length} foot={`Across ${cats.length} areas`} />
        <Tile label="Needing action now" value={critical} foot="Margin, cash and bench breaches" />
        <Tile label="Revenue at risk" value={mbS(atRisk)} foot={`Assignments ending inside ${RISK_WINDOW_DAYS} days`} />
        <Tile label="Recoverable bench cost" value={mbS(k?.benchCostMonthly ?? 0)} foot="If the bench were fully redeployed" />
      </div>

      <Card
        title="Insight feed"
        sub={`${list.length} signals · ranked by urgency`}
        actions={
          <div className="row">
            <select className="input sm" style={{ width: 'auto' }} value={active} onChange={(e) => setCat(e.target.value)}>
              <option value="">All areas</option>
              {cats.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn sm primary" onClick={matchAll}>✨ Redeployment plan</button>
          </div>
        }
        flush
      >
        {list.length ? (
          <div className="lst">
            {list.map((i, n) => (
              <div className="lst-i" key={n}>
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, marginBottom: 3 }}>
                      <Badge kind={SEV_KIND[i.sev]}>{SEV_LABEL[i.sev]}</Badge>
                      <Chip>{i.cat}</Chip>
                    </div>
                    <b>{i.t}</b>
                    <div className="mt" style={{ marginTop: 3 }}>{i.d}</div>
                  </div>
                  <button className="btn sm" onClick={i.act.f}>{i.act.l}</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState msg="Nothing needs your attention — every signal is clear" icon="✓" />
        )}
      </Card>
    </div>
  );
}

registerModule({
  key: 'copilot',
  title: TITLES.copilot,
  subtitle: () => 'Signals computed from live records · nothing leaves the system',
  Component: CopilotView,
});
