import { useState } from 'react';
import { sortBy, sum, uniq } from '../../lib/collections';
import { daysBetween, fmtD, fmtDS, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { money } from '../../data/countries';
import { EMAP } from '../../data/employees';
import {
  CLIENTS, REQUIREMENTS, SUBMISSIONS, SUB_STAGES, clientOf, conOf, reqOf2, staffingKPI, subStage, vendorOf,
} from '../../data/staffing';
import { Avatar, Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile } from '../../components/ui';
import { Chip, Dot } from '../../components/common';
import { HBar, PAL } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { Rate } from './shared';

/** Below this the deal desk flags the margin. */
const MARGIN_FLOOR = 20;

const INTERVIEWED = ['interview', 'selected', 'placed'];

/* ---------------- Open requirements ---------------- */

function RqOpen() {
  const app = useApp();
  const k = staffingKPI();
  const list = sortBy(REQUIREMENTS.filter((r) => r.status === 'Open' && r.filled < r.positions), (r) => r.closeBy);

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn" onClick={() => app.toast('AI matching runs from the Copilot module')}>
          ✨ AI match bench to open roles
        </button>
        <div className="spacer" />
        <button className="btn" onClick={() =>
          downloadCSV('requirements.csv',
            [['ID', 'Title', 'Client', 'Role', 'Location', 'Bill rate', 'Unit', 'Positions', 'Filled', 'Priority', 'Source', 'Received', 'Close by', 'Status']].concat(
              REQUIREMENTS.map((r) => [r.id, r.title, clientOf(r.clientId).name, r.role, r.location,
                String(r.billRate), r.unit, String(r.positions), String(r.filled), r.priority, r.source,
                r.receivedOn, r.closeBy, r.status]),
            ))}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Open requirements" value={list.length} foot={`${k.openPositions} positions to fill`} />
        <Tile label="Fill rate" value={k.fillRate + '%'} foot="Positions filled against received" />
        <Tile label="Submission → interview" value={k.sub2int + '%'} foot="Industry benchmark 22%" />
        <Tile label="Interview → placement" value={k.int2place + '%'} foot="Industry benchmark 35%" />
        <Tile label="Ageing beyond 30 days"
          value={list.filter((r) => daysBetween(r.receivedOn, ymd(TODAY)) > 30).length}
          foot="Escalate to the account owner" />
      </div>

      <Card title="Open requirements" sub={`${list.length} live roles`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Requirement</th><th>Client</th><th>Location</th><th className="num">Bill rate</th>
                <th className="num">Positions</th><th className="num">Submissions</th><th>Priority</th>
                <th>Source</th><th className="num">Age</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const subs = SUBMISSIONS.filter((s) => s.reqId === r.id);
                const age = daysBetween(r.receivedOn, ymd(TODAY));
                return (
                  <tr key={r.id}>
                    <td>
                      <b>{r.title}</b>
                      <div className="muted" style={{ fontSize: 11 }}>{r.id} · {r.skills.slice(0, 3).join(', ')}</div>
                    </td>
                    <td className="nowrap">{clientOf(r.clientId).name}</td>
                    <td className="nowrap">{r.location}</td>
                    <td className="num strong"><Rate v={r.billRate} ccy={r.ccy} unit={r.unit} /></td>
                    <td className="num">{r.filled} / {r.positions}</td>
                    <td className="num">{subs.length} <span className="muted">/ {r.maxSubmissions}</span></td>
                    <td>
                      <Badge kind={r.priority === 'Critical' ? 'crit' : r.priority === 'High' ? 'warn' : 'mute'}>{r.priority}</Badge>
                    </td>
                    <td>
                      {r.source === 'VMS' ? <Badge kind="info">{r.vms || 'VMS'}</Badge> : <Badge>Direct</Badge>}
                    </td>
                    <td className="num" style={age > 30 ? { color: 'var(--crit)', fontWeight: 700 } : undefined}>{age}d</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Submission pipeline ---------------- */

function RqPipe() {
  const app = useApp();
  const [dragId, setDragId] = useState<string | null>(null);
  const stages = SUB_STAGES.filter((s) => s.id !== 'rejected');
  const subs = SUBMISSIONS.filter((s) => s.stage !== 'rejected');

  const drop = (stageId: string) => {
    if (!dragId) return;
    const s = SUBMISSIONS.find((x) => x.id === dragId);
    if (s && s.stage !== stageId) {
      s.stage = stageId;
      app.toast(
        stageId === 'placed'
          ? 'Placed — rate locked and billing clock started'
          : 'Moved to ' + subStage(stageId).n,
        'ok',
      );
      app.bump();
    }
    setDragId(null);
  };

  return (
    <div className="stack">
      <Banner kind="info" icon="🖱️">
        Drag a submission between columns to move it through the client process. Moving a card to <b>Placed</b> creates
        the placement, locks the rate and starts the billing clock.
      </Banner>

      <div className="kb">
        {stages.map((st) => {
          const list = subs.filter((s) => s.stage === st.id);
          return (
            <div key={st.id} className="kb-col" onDragOver={(e) => e.preventDefault()} onDrop={() => drop(st.id)}>
              <h5><Dot color={st.c} />{st.n}<span className="n">{list.length}</span></h5>
              <div className="kb-body">
                {list.map((s) => {
                  const c = conOf(s.consultantId);
                  const r = reqOf2(s.reqId);
                  return (
                    <div key={s.id} className="kb-card" draggable onDragStart={() => setDragId(s.id)}>
                      <div className="row" style={{ gap: 8 }}>
                        <Avatar name={c ? c.name : '?'} size="sm" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 650, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c ? c.name : '—'}
                          </div>
                          <div className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {r ? clientOf(r.clientId).name : ''}
                          </div>
                        </div>
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>{r ? r.role : ''}</div>
                      <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
                        <Chip>{money(s.billRate, s.ccy)}</Chip>
                        <span className="chip" style={{ fontSize: 10, ...(s.margin < MARGIN_FLOOR ? { color: 'var(--crit)' } : {}) }}>
                          {s.margin}% GM
                        </span>
                        {c?.external && <Chip>Vendor</Chip>}
                      </div>
                      <div className="muted" style={{ fontSize: 10.5, marginTop: 6 }}>
                        {fmtDS(s.submittedOn)} · {c ? c.workAuth : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid g4">
        <Tile label="Live submissions" value={subs.length} foot={`${SUBMISSIONS.filter((s) => s.stage === 'rejected').length} rejected`} />
        <Tile label="At client interview" value={subs.filter((s) => s.stage === 'interview').length} foot="Awaiting client feedback" />
        <Tile label="Selected, not started" value={subs.filter((s) => s.stage === 'selected').length} foot="Onboarding in progress" />
        <Tile label="Avg submitted margin" value={(sum(subs, (s) => s.margin) / Math.max(1, subs.length)).toFixed(1) + '%'}
          foot="Across live submissions" />
      </div>
    </div>
  );
}

/* ---------------- All submissions ---------------- */

function RqSubs() {
  const [f, setF] = useState('');
  const list = sortBy(f ? SUBMISSIONS.filter((s) => s.stage === f) : SUBMISSIONS, (s) => s.submittedOn, 'desc');

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto' }} value={f} onChange={(e) => setF(e.target.value)}>
          <option value="">All stages</option>
          {SUB_STAGES.map((s) => <option key={s.id} value={s.id}>{s.n}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={() =>
          downloadCSV('submissions.csv',
            [['ID', 'Consultant', 'Client', 'Requirement', 'Source', 'Bill', 'Pay', 'Margin %', 'RTR', 'Submitted', 'Stage']].concat(
              SUBMISSIONS.map((s) => {
                const c = conOf(s.consultantId);
                const r = reqOf2(s.reqId);
                return [s.id, c?.name || '', r ? clientOf(r.clientId).name : '', r?.title || '',
                  c?.external ? vendorOf(c.vendorId || '')?.name || 'Vendor' : 'Internal',
                  String(s.billRate), String(s.payRate), String(s.margin), s.rtr.signed ? 'Signed' : 'Missing',
                  s.submittedOn, s.stage];
              }),
            ))}>⤓ Export</button>
      </div>

      <Card title="Submissions" sub={`${list.length} records`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 640, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Consultant</th><th>Client / Requirement</th><th>Source</th><th className="num">Bill</th>
                <th className="num">Pay</th><th className="num">Margin</th><th>RTR</th><th>Submitted</th><th>Stage</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => {
                const c = conOf(s.consultantId);
                const r = reqOf2(s.reqId);
                const st = subStage(s.stage);
                return (
                  <tr key={s.id}>
                    <td>
                      {c ? (
                        <div className="person">
                          <Avatar name={c.name} size="sm" />
                          <div>
                            <div className="nm">{c.name}</div>
                            <div className="mt">{c.workAuth}</div>
                          </div>
                        </div>
                      ) : '—'}
                    </td>
                    <td>
                      <b>{r ? clientOf(r.clientId).name : ''}</b>
                      <div className="muted" style={{ fontSize: 11 }}>{r ? r.title : ''}</div>
                    </td>
                    <td>
                      {c?.external
                        ? <Badge kind="warn">{vendorOf(c.vendorId || '')?.name || 'Vendor'}</Badge>
                        : <Badge kind="good">Internal</Badge>}
                    </td>
                    <td className="num">{money(s.billRate, s.ccy)}</td>
                    <td className="num">{money(s.payRate, s.ccy)}</td>
                    <td className="num">
                      <b style={{ color: s.margin < MARGIN_FLOOR ? 'var(--crit)' : 'var(--good-text)' }}>{s.margin}%</b>
                    </td>
                    <td>{s.rtr.signed ? <Badge kind="good">Signed</Badge> : <Badge kind="crit">Missing</Badge>}</td>
                    <td className="nowrap">{fmtD(s.submittedOn)}</td>
                    <td>
                      <span className="badge" style={{
                        background: `color-mix(in srgb, ${st.c} 15%, transparent)`,
                        color: st.c,
                        borderColor: `color-mix(in srgb, ${st.c} 35%, transparent)`,
                      }}>{st.n}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Analytics ---------------- */

function RqAna() {
  const showEmp = useShowEmployee();
  const k = staffingKPI();

  const funnel = [
    { k: 'Requirements received', c: 'var(--s1)', v: REQUIREMENTS.length },
    { k: 'Submissions made', c: 'var(--s4)', v: SUBMISSIONS.length },
    { k: 'Client interviews', c: 'var(--s7)', v: SUBMISSIONS.filter((s) => INTERVIEWED.includes(s.stage)).length },
    { k: 'Selected', c: 'var(--s6)', v: SUBMISSIONS.filter((s) => ['selected', 'placed'].includes(s.stage)).length },
    { k: 'Placed', c: 'var(--s3)', v: SUBMISSIONS.filter((s) => s.stage === 'placed').length },
  ];

  const byRecruiter = uniq(SUBMISSIONS.map((s) => s.submittedById)).map((id) => {
    const subs = SUBMISSIONS.filter((s) => s.submittedById === id);
    const placed = subs.filter((s) => s.stage === 'placed').length;
    return { e: EMAP[id], n: subs.length, placed, conv: pct(placed, Math.max(1, subs.length)) };
  });

  const rejReasons = uniq(SUBMISSIONS.filter((s) => s.feedback).map((s) => s.feedback)).map((r, i) => ({
    k: r, c: PAL[i % 8], v: SUBMISSIONS.filter((s) => s.feedback === r).length,
  }));

  const byClient = CLIENTS.map((c) => ({
    k: c.name, c: 'var(--s1)', v: SUBMISSIONS.filter((s) => s.clientId === c.id).length,
  })).filter((r) => r.v);

  return (
    <div className="stack">
      <div className="grid g5">
        <Tile label="Submissions" value={k.submissions} foot="All time" />
        <Tile label="Fill rate" value={k.fillRate + '%'} foot="Target 65%" />
        <Tile label="Sub → interview" value={k.sub2int + '%'} foot="Quality of submissions" />
        <Tile label="Interview → place" value={k.int2place + '%'} foot="Closing effectiveness" />
        <Tile label="Avg time to submit" value="2.1 days" foot="Requirement received to first submission" />
      </div>

      <div className="grid g2">
        <Card title="Staffing funnel" sub="Requirement to placement"><HBar rows={funnel} /></Card>
        <Card title="Submissions by client" sub="Where effort goes">
          <HBar rows={sortBy(byClient, (r) => -r.v).slice(0, 10)} />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Recruiter performance" sub={`${byRecruiter.length} recruiters`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Recruiter</th><th className="num">Submissions</th><th className="num">Placements</th><th className="num">Conversion</th></tr></thead>
              <tbody>
                {sortBy(byRecruiter, (r) => -r.placed).map((r) => (
                  <tr key={r.e.id} className="clickable" onClick={() => showEmp(r.e.id)}>
                    <td><PersonCell e={r.e} /></td>
                    <td className="num">{r.n}</td>
                    <td className="num">{r.placed}</td>
                    <td className="num"><b>{r.conv}%</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Rejection reasons" sub="Client feedback on submissions">
          {rejReasons.length ? <HBar rows={sortBy(rejReasons, (r) => -r.v)} /> : <EmptyState msg="No rejections recorded" />}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'open' | 'pipe' | 'subs' | 'ana';

const TABS: { v: Tab; label: string }[] = [
  { v: 'open', label: 'Open Requirements' }, { v: 'pipe', label: 'Submission Pipeline' },
  { v: 'subs', label: 'All Submissions' }, { v: 'ana', label: 'Staffing Analytics' },
];

function Requirements() {
  const [tab, setTab] = useState<Tab>('open');
  return (
    <>
      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'open' && <RqOpen />}
      {tab === 'pipe' && <RqPipe />}
      {tab === 'subs' && <RqSubs />}
      {tab === 'ana' && <RqAna />}
    </>
  );
}

registerModule({
  key: 'requirements',
  title: TITLES.requirements,
  subtitle: () => {
    const k = staffingKPI();
    return `${REQUIREMENTS.filter((r) => r.status === 'Open' && r.filled < r.positions).length} open requirements · ${k.openPositions} positions to fill`;
  },
  Component: Requirements,
});
