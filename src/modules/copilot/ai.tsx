import { useNavigate } from 'react-router-dom';
import { sortBy, sum } from '../../lib/collections';
import { daysBetween, fmtD, tenure, TODAY, yearsSince, ymd } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import { countryOf, mbS, money, toBase } from '../../data/countries';
import { ACTIVE, EMAP } from '../../data/employees';
import { deptOf, ORG } from '../../data/org';
import { REVIEWS } from '../../data/performance';
import {
  benchCost, benchDays, benchList, clientOf, CONSULTANTS, INVOICES, invAgeing, PLACEMENTS,
  reqOf2, SOWS, sowOf, staffingKPI, SUBMISSIONS,
} from '../../data/staffing';
import type { Client, Consultant, Invoice, Placement, StaffingRequirement } from '../../data/staffing';
import { REQUIREMENTS } from '../../data/staffing';
import { matchBand, matchExplain, matchScore, MATCH_FLOOR, openReqs } from '../../data/matching';
import type { MatchExplain } from '../../data/matching';
import { Avatar, Badge, EmptyState, Table, TableWrap, Tile } from '../../components/ui';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';

/* ---------- shared presentation ---------- */

/** The fit score, tinted by band so a weak match reads as weak at a glance. */
export function FitPill({ n }: { n: number }) {
  const b = matchBand(n);
  return (
    <span
      className="badge"
      style={{
        background: `color-mix(in srgb, ${b.c} 16%, transparent)`,
        color: b.c,
        borderColor: `color-mix(in srgb, ${b.c} 34%, transparent)`,
      }}
    >
      {n}% {b.l}
    </span>
  );
}

/** The component breakdown behind a score — shown wherever a match is proposed. */
export function ExplainBlock({ x }: { x: MatchExplain }) {
  return (
    <div className="tl">
      {x.parts.map((p) => (
        <div className="tl-i" key={p.k}>
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <b style={{ fontSize: 12.5 }}>{p.k}</b>
            <span className="mono" style={{ fontSize: 12 }}>{p.v} / {p.max}</span>
          </div>
          <div className="bar" style={{ margin: '4px 0 3px' }}>
            <i style={{ width: Math.round((p.v / p.max) * 100) + '%', background: 'var(--s1)' }} />
          </div>
          <div className="mt">{p.d}</div>
        </div>
      ))}
    </div>
  );
}

function OffshoreBadge({ x }: { x: MatchExplain }) {
  if (!x.offshore) return null;
  return x.eligible ? <Badge kind="info">Offshore</Badge> : <Badge kind="warn">Onsite required</Badge>;
}

/* ---------- drafting ---------- */

export type DraftKind = 'dunning' | 'account' | 'renewal' | 'jd' | 'summary';

export interface SummaryDraft {
  t: string;
  s: string;
  text: string;
}

function dunningText(inv: Invoice, meName: string, meTitle: string, meEmail: string): string {
  const c = clientOf(inv.clientId);
  const age = invAgeing(inv);
  const contact = c.contacts[1] || c.contacts[0];
  const body =
    age > 45
      ? `This invoice is now ${age} days past its due date of ${fmtD(inv.dueOn)}. As this sits well outside our agreed terms, I would like to arrange a short call this week with your accounts payable team to resolve it. If there is a dispute or a missing approval on any timesheet line, please let me know today and we will clear it immediately.\n\n`
      : age > 0
        ? `The invoice fell due on ${fmtD(inv.dueOn)} and remains open. Could you confirm the payment run it has been scheduled into? If anything is outstanding on our side — timesheet approvals, PO references or supporting documentation — I will turn it around the same day.\n\n`
        : `The invoice is due on ${fmtD(inv.dueOn)}. This is a courtesy note to confirm it has been received and approved for payment, and to flag anything you need from us before the run.\n\n`;

  return (
    `Subject: ${age > 30 ? 'Escalation: ' : ''}Invoice ${inv.id} — ${money(inv.total, inv.ccy)}` +
    `${age > 0 ? ` (${age} days overdue)` : ' approaching due date'}\n\n` +
    `Dear ${contact.n},\n\n` +
    `I hope you are well. I am writing regarding invoice ${inv.id} for ${money(inv.total, inv.ccy)}, issued on ` +
    `${fmtD(inv.issuedOn)} against ${sowOf(inv.sowId)?.title || 'the statement of work'} with payment terms of ${c.paymentTerms} days.\n\n` +
    body +
    'Supporting timesheets and the consultant breakdown are attached. Thank you for your continued partnership.\n\n' +
    `Kind regards,\n${meName}\n${meTitle} · ${ORG.legal}\n${meEmail}`
  );
}

function accountText(cl: Client): string {
  const sows = SOWS.filter((s) => s.clientId === cl.id);
  const act = PLACEMENTS.filter((p) => reqOf2(p.reqId)?.clientId === cl.id && p.status === 'Active');
  const open = REQUIREMENTS.filter((r) => r.clientId === cl.id && r.filled < r.positions);
  const inv = INVOICES.filter((i) => i.clientId === cl.id);
  const overdue = inv.filter((i) => i.status === 'Overdue');
  const msaMonths = (new Date(cl.msaExpiry).getTime() - TODAY.getTime()) / 86400000;

  const risks =
    (cl.riskFlag ? '• Account flagged for delivery or commercial risk — needs an owner action plan.\n' : '') +
    (msaMonths < 220 ? `• MSA expires ${fmtD(cl.msaExpiry)} — start the renewal conversation now.\n` : '') +
    (cl.nps < 8 ? `• Satisfaction below target at ${cl.nps}/10.\n` : '') +
    (!cl.riskFlag && cl.nps >= 8 ? '• No material risks flagged.\n' : '');

  return (
    `ACCOUNT REVIEW — ${cl.name.toUpperCase()}\nPrepared ${fmtD(ymd(TODAY))} for ${EMAP[cl.ownerId]?.name || '—'}\n\n` +
    `POSITION\n${cl.name} is a ${cl.tier}-tier ${cl.industry.toLowerCase()} account, live since ${cl.since.slice(0, 4)} ` +
    `under a ${cl.engagement.toLowerCase()} model${cl.vms ? ' procured through ' + cl.vms : ' contracted directly'}. ` +
    `The MSA runs to ${fmtD(cl.msaExpiry)}. Payment terms are ${cl.paymentTerms} days against a credit limit of ${money(cl.creditLimit, cl.ccy)}.\n\n` +
    `DELIVERY\n${sows.length} statements of work, ${sows.filter((s) => s.status === 'Active').length} active. ` +
    `${act.length} consultants currently billing. Client satisfaction sits at ${cl.nps}/10.\n\n` +
    `PIPELINE\n${open.length
      ? `${open.length} open requirements covering ${sum(open, (r) => r.positions - r.filled)} positions. ` +
        `Highest priority: ${sortBy(open, (r) => (r.priority === 'Critical' ? 0 : 1))[0]?.title || '—'}.`
      : 'No open requirements. Recommend a demand-generation conversation with the hiring manager this quarter.'}\n\n` +
    `COMMERCIAL\n${inv.length} invoices raised, ${money(sum(inv.filter((i) => i.status !== 'Paid'), (i) => i.total), cl.ccy)} outstanding` +
    `${overdue.length
      ? `, of which ${money(sum(overdue, (i) => i.total), cl.ccy)} is overdue across ${overdue.length} invoice(s) — raise at the review.`
      : ' and nothing overdue.'}\n\n` +
    `RISKS\n${risks}\n` +
    'RECOMMENDED ACTIONS\n1. ' +
    (open.length
      ? 'Close the open requirement book — bench matching has candidates ready to submit.'
      : 'Book a demand review with the hiring manager.') +
    '\n2. ' + (overdue.length ? 'Escalate the overdue balance with procurement.' : 'Confirm the next invoicing cycle.') +
    '\n3. ' + (cl.tier === 'Bronze' ? 'Build the case for a tier upgrade at renewal.' : 'Explore a second delivery track to grow wallet share.')
  );
}

function renewalText(p: Placement, meName: string, meTitle: string): string {
  const c = reqOf2(p.reqId);
  const cl = c ? clientOf(c.clientId) : null;
  const con = CONSULTANTS.find((x) => x.id === p.conId);
  return (
    `Subject: Extension — ${con?.name || p.id} (${c?.title || 'assignment'})\n\n` +
    `Dear ${cl?.contacts[0]?.n || 'there'},\n\n` +
    `${con?.name || 'The consultant'} has been supporting ${c?.title || 'this engagement'} since ${fmtD(p.startOn)} ` +
    `and the current assignment ends on ${fmtD(p.endOn)}.\n\n` +
    'Feedback from the delivery team has been consistently positive and there is no gap in coverage planned. ' +
    `I would like to propose a twelve month extension on the existing rate of ${money(p.billRate, p.ccy)} ${p.unit}, ` +
    `effective from ${fmtD(p.endOn)}.\n\n` +
    'If you would prefer a rate review at the same time, I am happy to bring the current market benchmark to a call. ' +
    'To keep continuity we would need the extension confirmed at least two weeks before the end date.\n\n' +
    `Kind regards,\n${meName}\n${meTitle} · ${ORG.legal}`
  );
}

function jdText(r: StaffingRequirement): string {
  const cl = clientOf(r.clientId);
  const yrs = /Architect|Lead/.test(r.role) ? '8+' : /Senior/.test(r.role) ? '5+' : '3+';
  const tzCity = countryOf(cl.country).tz.split('/')[1]?.replace('_', ' ') || countryOf(cl.country).tz;
  return (
    `${r.title.toUpperCase()}\n${r.location} · ${r.duration} · ${r.priority} priority\n\n` +
    `ABOUT THE ENGAGEMENT\n${ORG.name} is hiring a ${r.role} for a ${cl.industry.toLowerCase()} client delivering ` +
    `${r.title.split('—').slice(1).join('').trim()}. This is a ${r.duration.toLowerCase()} engagement based ${r.location.toLowerCase()}.\n\n` +
    'WHAT YOU WILL DO\n' +
    r.skills.map((s) => `• Build and maintain production systems using ${s}.`).join('\n') +
    `\n• Work directly with the client delivery team in ${tzCity} hours.\n` +
    '• Own quality end to end — design review, testing and production support.\n\n' +
    `WHAT WE ARE LOOKING FOR\n• ${yrs} years of hands-on engineering experience.\n` +
    r.skills.map((s) => `• Demonstrable production experience with ${s}.`).join('\n') +
    `\n• Right to work in ${countryOf(cl.country).name}.\n\n` +
    `ENGAGEMENT\nRate: ${money(r.billRate, r.ccy)} ${r.unit} (indicative, dependent on experience)\n` +
    `Duration: ${r.duration}\nStart: within ${Math.max(7, daysBetween(ymd(TODAY), r.closeBy))} days\n\n` +
    `${ORG.legal} is an equal opportunity employer.`
  );
}

function DraftBody({ text }: { text: string }) {
  return (
    <>
      <div className="note" style={{ marginBottom: 10 }}>
        Generated from the live record. Review before sending — you are accountable for what goes out.
      </div>
      <textarea
        className="input mono"
        defaultValue={text}
        style={{ minHeight: 380, fontSize: 12.5, lineHeight: 1.6 }}
      />
    </>
  );
}

/**
 * Opens a draft built from a live record. The templates are deterministic —
 * the same invoice always produces the same chase letter.
 */
export function useAiDraft() {
  const layer = useLayer();
  const app = useApp();

  return (kind: DraftKind, obj: Invoice | Client | Placement | StaffingRequirement | SummaryDraft) => {
    const me = app.me;
    let title = 'AI draft';
    let sub = '';
    let text = '';

    if (kind === 'dunning') {
      const inv = obj as Invoice;
      const c = clientOf(inv.clientId);
      const age = invAgeing(inv);
      title = '✨ Collection email — ' + inv.id;
      sub = `${c.name} · ${money(inv.total, inv.ccy)} · ${age > 0 ? age + ' days past due' : 'due in ' + Math.abs(age) + ' days'}`;
      text = dunningText(inv, me.name, me.designation, me.email);
    } else if (kind === 'account') {
      const cl = obj as Client;
      title = '✨ Account review brief — ' + cl.name;
      sub = `${cl.tier} tier · ${cl.industry} · client since ${cl.since.slice(0, 4)}`;
      text = accountText(cl);
    } else if (kind === 'renewal') {
      const p = obj as Placement;
      const con = CONSULTANTS.find((x) => x.id === p.conId);
      const cl = reqOf2(p.reqId) ? clientOf(reqOf2(p.reqId)!.clientId) : null;
      title = '✨ Extension request — ' + (con?.name || p.id);
      sub = `${cl?.name || '—'} · ends ${fmtD(p.endOn)}`;
      text = renewalText(p, me.name, me.designation);
    } else if (kind === 'jd') {
      const r = obj as StaffingRequirement;
      title = '✨ Job description — ' + r.title;
      sub = `${clientOf(r.clientId).name} · ${r.location}`;
      text = jdText(r);
    } else {
      const s = obj as SummaryDraft;
      title = '✨ ' + (s.t || 'Summary');
      sub = s.s || '';
      text = s.text || '';
    }

    layer.modal({
      title,
      sub,
      size: 'wide',
      body: <DraftBody text={text} />,
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Close</button>
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(
                () => app.toast('Copied to clipboard'),
                () => app.toast('Select and copy manually')
              );
            }}
          >
            Copy
          </button>
          <button className="btn primary" onClick={() => { close(); app.toast('Queued for sending · logged against the record'); }}>
            Send
          </button>
        </>
      ),
    });
  };
}

/* ---------- match views ---------- */

/**
 * The three match surfaces: one consultant against the book, one requirement
 * against the bench, and a greedy sweep of both. Actions route to the module
 * that owns the follow-up rather than submitting from here.
 */
export function useMatchViews() {
  const layer = useLayer();
  const app = useApp();
  const nav = useNavigate();

  const goTo = (route: string) => { layer.close(); nav(route); };

  const matchConsultant = (id: string) => {
    const c = CONSULTANTS.find((x) => x.id === id);
    if (!c) return;
    const rows = sortBy(openReqs().map((r) => ({ r, x: matchExplain(c, r) })), (o) => -o.x.total).slice(0, 8);

    layer.drawer({
      title: '✨ Redeployment matches — ' + c.name,
      sub: `${c.role} · ${c.exp} yrs · ${c.workAuth} · ${c.status === 'Bench' ? benchDays(c) + ' days on bench' : c.status}`,
      body: (
        <>
          {!rows.length && <EmptyState msg="No open requirements to match against" icon="✨" />}
          <div className="note" style={{ marginBottom: 12 }}>
            Scored on skill coverage, role fit, work authorisation, margin at the client bill rate, availability and
            experience. Work authorisation acts as a gate, not just a weight — a consultant who cannot work in the
            client’s country only ranks where the role is remote. Expand a row for the breakdown.
          </div>
          {rows.map((o, i) => {
            const cl = clientOf(o.r.clientId);
            return (
              <details className="acc" key={o.r.id} open={i === 0}>
                <summary>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 10, width: '100%' }}>
                    <div style={{ minWidth: 0 }}>
                      <b>{o.r.title}</b>
                      <div className="mt">
                        {cl.name} · {countryOf(cl.country).flag} {o.r.location} · {money(o.r.billRate, o.r.ccy)} {o.r.unit}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <OffshoreBadge x={o.x} />
                      <FitPill n={o.x.total} />
                    </div>
                  </div>
                </summary>
                <div style={{ padding: '10px 2px 4px' }}>
                  <ExplainBlock x={o.x} />
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn sm primary" onClick={() => goTo('/requirements')}>Open requirement book</button>
                  </div>
                </div>
              </details>
            );
          })}
        </>
      ),
    });
  };

  const matchRequirement = (id: string) => {
    const r = reqOf2(id);
    if (!r) return;
    const cl = clientOf(r.clientId);
    const available = CONSULTANTS.filter((c) => c.status !== 'Placed');
    const already = new Set(SUBMISSIONS.filter((s) => s.reqId === r.id).map((s) => s.conId));
    const rows = sortBy(available.map((c) => ({ c, x: matchExplain(c, r) })), (o) => -o.x.total).slice(0, 10);

    layer.drawer({
      title: '✨ Shortlist — ' + r.title,
      sub: `${cl.name} · ${Math.max(0, r.positions - r.filled)} open of ${r.positions} · ${money(r.billRate, r.ccy)} ${r.unit}`,
      body: (
        <>
          <div className="note" style={{ marginBottom: 12 }}>
            Ranked across {available.length} available consultants. Submissions already sent are marked.
          </div>
          {rows.map((o, i) => (
            <details className="acc" key={o.c.id} open={i === 0}>
              <summary>
                <div className="row" style={{ justifyContent: 'space-between', gap: 10, width: '100%' }}>
                  <div className="person" style={{ minWidth: 0 }}>
                    <Avatar name={o.c.name} size="sm" />
                    <div>
                      <div className="nm">{o.c.name}</div>
                      <div className="mt">
                        {o.c.role} · {o.c.exp} yrs · {o.c.workAuth}
                        {already.has(o.c.id) ? ' · already submitted' : ''}
                      </div>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <OffshoreBadge x={o.x} />
                    <FitPill n={o.x.total} />
                  </div>
                </div>
              </summary>
              <div style={{ padding: '10px 2px 4px' }}>
                <ExplainBlock x={o.x} />
                <div className="row" style={{ marginTop: 10 }}>
                  {already.has(o.c.id) ? (
                    <Badge kind="info">Submitted</Badge>
                  ) : (
                    <button className="btn sm primary" onClick={() => goTo('/requirements')}>
                      Submit to {cl.name.split(' ')[0]}
                    </button>
                  )}
                  <button className="btn sm" onClick={() => goTo('/bench')}>Consultant profile</button>
                </div>
              </div>
            </details>
          ))}
        </>
      ),
    });
  };

  const matchAll = () => {
    const bench = CONSULTANTS.filter((c) => c.status !== 'Placed');
    const reqs = openReqs();
    if (!bench.length || !reqs.length) {
      app.toast('Nothing to match — bench or requirement book is empty');
      return;
    }

    const pairs: { c: Consultant; r: StaffingRequirement; t: number }[] = [];
    bench.forEach((c) =>
      reqs.forEach((r) => {
        const t = matchScore(c, r);
        if (t >= MATCH_FLOOR) pairs.push({ c, r, t });
      })
    );

    /* Greedy assignment — one suggestion per consultant, respecting open positions. */
    const usedC = new Set<string>();
    const cap: Record<string, number> = {};
    const picks: typeof pairs = [];
    sortBy(pairs, (p) => -p.t).forEach((p) => {
      if (usedC.has(p.c.id)) return;
      const room = Math.max(0, p.r.positions - p.r.filled) - (cap[p.r.id] || 0);
      if (room <= 0) return;
      usedC.add(p.c.id);
      cap[p.r.id] = (cap[p.r.id] || 0) + 1;
      picks.push(p);
    });

    const recovered = sum(picks.filter((p) => p.c.status === 'Bench'), (p) => toBase(p.c.costPerDay * 21, p.c.ccy));
    const rev = sum(picks, (p) => toBase(p.r.billRate * (p.r.unit === 'per day' ? 21 : 173), p.r.ccy));

    layer.modal({
      title: '✨ AI redeployment plan',
      size: 'xl',
      sub: `${bench.length} available consultants matched against ${reqs.length} open requirements`,
      body: (
        <>
          <div className="grid g4" style={{ marginBottom: 14 }}>
            <Tile label="Matches proposed" value={picks.length} foot={`Scoring ${MATCH_FLOOR}% or better`} />
            <Tile
              label="Bench cleared"
              value={`${picks.filter((p) => p.c.status === 'Bench').length} of ${benchList().length}`}
              foot="If every submission converts"
            />
            <Tile label="Bench cost recovered" value={mbS(recovered) + '/mo'} foot="Currently unbilled" />
            <Tile label="Revenue unlocked" value={mbS(rev) + '/mo'} foot="At client bill rates" />
          </div>

          {picks.length ? (
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <th>Consultant</th><th>Status</th><th>Requirement</th><th>Client</th>
                      <th className="num">Margin</th><th className="num">Fit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picks.map((p) => {
                      const x = matchExplain(p.c, p.r);
                      return (
                        <tr key={p.c.id + p.r.id}>
                          <td>
                            <div className="person">
                              <Avatar name={p.c.name} size="sm" />
                              <div>
                                <div className="nm">{p.c.name}</div>
                                <div className="mt">{p.c.role}</div>
                              </div>
                            </div>
                          </td>
                          <td className="nowrap">
                            {p.c.status === 'Bench' ? <Badge kind="warn">{benchDays(p.c)}d bench</Badge> : <Badge kind="mute">{p.c.status}</Badge>}
                          </td>
                          <td>{p.r.title}</td>
                          <td className="nowrap">{clientOf(p.r.clientId).name}</td>
                          <td className="num">{x.margin}%</td>
                          <td className="num"><FitPill n={p.t} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </TableWrap>
            </div>
          ) : (
            <EmptyState msg={`No pairing scored above ${MATCH_FLOOR}% — widen the requirement book or reskill the bench`} icon="✨" />
          )}
        </>
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Close</button>
          <button
            className="btn primary"
            onClick={() =>
              downloadCSV('ai_redeployment_plan.csv', [
                ['Consultant', 'Role', 'Status', 'Bench days', 'Requirement', 'Client', 'Bill rate', 'Fit %'],
                ...picks.map((p) => [
                  p.c.name, p.c.role, p.c.status, p.c.status === 'Bench' ? benchDays(p.c) : 0,
                  p.r.title, clientOf(p.r.clientId).name, p.r.billRate, p.t,
                ]),
              ])
            }
          >
            ⤓ Export plan
          </button>
        </>
      ),
    });
  };

  return { matchConsultant, matchRequirement, matchAll };
}

/* ---------- the insight engine ---------- */

export type InsightSev = 'crit' | 'warn' | 'info';

export interface Insight {
  sev: InsightSev;
  cat: string;
  t: string;
  d: string;
  act: { l: string; f: () => void };
}

const SEV_RANK: Record<InsightSev, number> = { crit: 0, warn: 1, info: 2 };

/** Margin floor below which an active placement is worth flagging. */
const MARGIN_FLOOR = 18;

/**
 * Everything the copilot actually knows. Each signal is computed from live
 * records and carries the action that resolves it, so the feed is a worklist
 * rather than a wall of observations.
 */
export function useInsights(): Insight[] {
  const nav = useNavigate();
  const draft = useAiDraft();
  const { matchConsultant, matchRequirement, matchAll } = useMatchViews();

  const out: Insight[] = [];
  const k = staffingKPI();
  const go = (route: string) => () => nav(route);

  /* Bench sitting long enough to cost real money */
  benchList()
    .filter((c) => benchDays(c) >= 45)
    .forEach((c) => {
      const best = sortBy(openReqs().map((r) => ({ r, t: matchScore(c, r) })), (o) => -o.t)[0];
      const matched = best && best.t >= MATCH_FLOOR;
      out.push({
        sev: benchDays(c) >= 75 ? 'crit' : 'warn',
        cat: 'Bench',
        t: `${c.name} has been on bench ${benchDays(c)} days`,
        d:
          `${money(benchCost(c), c.ccy)} of unrecovered cost. ` +
          (matched
            ? `Best open match is ${best.r.title} at ${best.t}% fit.`
            : `No open requirement scores above ${MATCH_FLOOR}% — reskilling or an exit conversation is the realistic path.`),
        act: matched
          ? { l: 'Match now', f: () => matchConsultant(c.id) }
          : { l: 'Open bench', f: go('/bench') },
      });
    });

  /* Placements billing below the margin floor */
  PLACEMENTS.filter((p) => p.status === 'Active').forEach((p) => {
    const mgn = p.billRate > 0 ? Math.round(((p.billRate - p.payRate) / p.billRate) * 100) : 0;
    if (mgn >= MARGIN_FLOOR) return;
    out.push({
      sev: mgn < 12 ? 'crit' : 'warn',
      cat: 'Margin',
      t: `${CONSULTANTS.find((c) => c.id === p.conId)?.name || p.id} is billing at ${mgn}% margin`,
      d: `Below the ${MARGIN_FLOOR}% floor on ${reqOf2(p.reqId)?.title || 'the assignment'}. Either the pay rate was negotiated up or the bill rate has drifted from the rate card.`,
      act: { l: 'Open placements', f: go('/placements') },
    });
  });

  /* Receivables running past terms */
  INVOICES.filter((i) => invAgeing(i) > 30 && i.status !== 'Paid').forEach((i) =>
    out.push({
      sev: invAgeing(i) > 60 ? 'crit' : 'warn',
      cat: 'Cash',
      t: `${i.id} is ${invAgeing(i)} days overdue`,
      d: `${money(i.total, i.ccy)} from ${clientOf(i.clientId).name}. DSO across the book is ${k.dso} days.`,
      act: { l: 'Draft chase', f: () => draft('dunning', i) },
    })
  );

  /* Requirements about to lapse */
  openReqs()
    .filter((r) => daysBetween(ymd(TODAY), r.closeBy) <= 7)
    .forEach((r) =>
      out.push({
        sev: 'warn',
        cat: 'Demand',
        t: `${r.title} closes in ${Math.max(0, daysBetween(ymd(TODAY), r.closeBy))} days`,
        d: `${clientOf(r.clientId).name} · ${SUBMISSIONS.filter((s) => s.reqId === r.id).length} of ${r.maxSubmissions} submissions used, ${r.positions - r.filled} position(s) still open.`,
        act: { l: 'Shortlist', f: () => matchRequirement(r.id) },
      })
    );

  /* Assignments running out without an extension on record */
  PLACEMENTS.filter((p) => {
    const left = daysBetween(ymd(TODAY), p.endOn);
    return p.status === 'Active' && left <= 30 && left >= 0;
  }).forEach((p) =>
    out.push({
      sev: 'info',
      cat: 'Renewal',
      t: `${CONSULTANTS.find((c) => c.id === p.conId)?.name || p.id}’s assignment ends in ${daysBetween(ymd(TODAY), p.endOn)} days`,
      d: `No extension recorded. ${mbS(toBase(p.billRate * (p.unit === 'per day' ? 21 : 173), p.ccy))}/month of revenue at risk.`,
      act: { l: 'Draft extension', f: () => draft('renewal', p) },
    })
  );

  /* Flight risk from the HR side */
  ACTIVE()
    .filter((e) => {
      const r = REVIEWS.filter((x) => x.empId === e.id).slice(-1)[0];
      return !!r && !!r.final && r.final.rating <= 2 && yearsSince(e.doj) >= 2;
    })
    .slice(0, 4)
    .forEach((e) => {
      const r = REVIEWS.filter((x) => x.empId === e.id).slice(-1)[0];
      out.push({
        sev: 'warn',
        cat: 'Retention',
        t: `${e.name} is a flight risk`,
        d: `Last review rated ${r?.final?.rating}/5 after ${tenure(e.doj)} in role. ${deptOf(e.dept).name} attrition is running above plan.`,
        act: { l: 'Open directory', f: go('/employees') },
      });
    });

  if (k.arOverdue > 0)
    out.push({
      sev: 'info',
      cat: 'Cash',
      t: `${mbS(k.arOverdue)} of receivables are overdue`,
      d: `Against ${mbS(k.ar)} total outstanding. At the current gross margin of ${k.grossMargin}%, this is roughly ${Math.round((k.arOverdue / Math.max(1, k.revenueMonthly)) * 30)} days of billing.`,
      act: { l: 'Open billing', f: go('/billing') },
    });

  if (k.utilisation < 80)
    out.push({
      sev: 'warn',
      cat: 'Utilisation',
      t: `Utilisation is ${k.utilisation}%, below the 80% target`,
      d: `${k.bench} consultants unbilled costing ${mbS(k.benchCostMonthly)} per month. Closing half the bench would add roughly ${mbS(k.benchCostMonthly / 2)} back to margin.`,
      act: { l: 'Redeployment plan', f: matchAll },
    });

  return sortBy(out, (o) => SEV_RANK[o.sev]);
}

