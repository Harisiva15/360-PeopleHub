import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, daysBetween, fmtD, fmtTime, MON, monthKey, TODAY, ymd } from '../../lib/dates';
import { inr, lakh, pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { reqOf, SOURCES, STAGES } from '../../data/ats';
import type { Candidate, Interview, Requisition } from '../../services';

import { DEPTS, deptOf, GRADES, siteOf } from '../../data/org';
import {
  Avatar, Badge, Banner, Card, EmptyState, KV, pageOf, Pager, Tabs, Tile, StatRow,
} from '../../components/ui';
import { Chip, Divide, Dot, StatusBadge } from '../../components/common';
import { BarChart, Donut, HBar, Legend, PAL } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { isMyReport } from '../../state/rbac';
import {
  useAllEmployees as usePanel, useCandidates, useInterviews, useMoveCandidate,
  useRequisitions, useVisiblePeople,
} from './data';
import {
  FeedbackForm, MakeOfferForm, NewCandidateForm, NewRequisitionForm,
  OfferResponseForm, ScheduleInterviewForm,
} from './Intake';
import { HiringOverview } from './Overview';
import { OfferLetter } from './OfferLetter';
import { TrackerView } from './Tracker';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import type { AppRole } from '../../types/employee';

/** Managers see only requisitions they own or that sit under them. */
export function reqScope(role: AppRole, meId: string, list: Requisition[]): Requisition[] {
  if (role === 'admin') return list;
  return list.filter((r) => r.hiringManagerId === meId || isMyReport(meId, r.hiringManagerId));
}

export function hiringScope(role: AppRole, meId: string, list: Candidate[]): Candidate[] {
  if (role === 'admin') return list;
  return list.filter((c) => {
    const r = reqOf(c.reqId);
    return !!r && (r.hiringManagerId === meId || isMyReport(meId, r.hiringManagerId));
  });
}

function Stars({ n }: { n: number }) {
  return (
    <span style={{ letterSpacing: 1 }}>
      {'★'.repeat(n)}
      <span style={{ opacity: 0.25 }}>{'★'.repeat(5 - n)}</span>
    </span>
  );
}

function CandCell({ c, sub }: { c: Candidate; sub: string }) {
  return (
    <div className="person">
      <Avatar name={c.name} size="sm" />
      <div>
        <div className="nm">{c.name}</div>
        <div className="mt">{sub}</div>
      </div>
    </div>
  );
}

/** Hire / Strong Hire read positive; No Hire negative; Hold sits between. */
function VerdictBadge({ v }: { v: string }) {
  const kind = v.includes('Hire') && !v.includes('No') ? 'good' : v === 'Hold' ? 'warn' : 'crit';
  return <Badge kind={kind}>{v}</Badge>;
}

/* ---------------- candidate drawer ---------------- */

function CandidateBody({ c }: { c: Candidate }) {
  const dir = useVisiblePeople();
  const { data: INTERVIEWS = [] } = useInterviews();
  const r = reqOf(c.reqId);
  const ivs = sortBy(INTERVIEWS.filter((i) => i.candId === c.id), (i) => i.date);
  const stageIdx = STAGES.findIndex((s) => s.id === c.stage);

  return (
    <>
      <div className="row" style={{ gap: 14, marginBottom: 16 }}>
        <Avatar name={c.name} size="xl" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 750 }}>{c.name}</div>
          <div className="muted" style={{ fontSize: 13 }}>{c.current} · {c.exp} experience</div>
          <div style={{ letterSpacing: 2, marginTop: 5 }}><Stars n={c.rating} /></div>
        </div>
      </div>

      <div className="stepper">
        {STAGES.filter((s) => s.id !== 'rejected').map((s, i) => (
          <div key={s.id} className={'st ' + (i < stageIdx ? 'done' : i === stageIdx ? 'now' : '')}>
            <i>{i < stageIdx ? '✓' : i + 1}</i>
            {s.name.split(' ')[0]}
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <KV rows={[
          ['Applied for', `${r ? r.title : '—'} (${c.reqId})`],
          ['Current stage', STAGES.find((s) => s.id === c.stage)!.name],
          ['Email', c.email],
          ['Phone', <span className="mono">{c.phone}</span>],
          ['Location', c.loc],
          ['Current CTC', inr(c.ctcCur)],
          ['Expected CTC', inr(c.ctcExp)],
          ['Notice period', c.notice],
          ['Applied on', fmtD(c.appliedOn)],
          ['Skills', <>{c.skills.map((s) => <Chip key={s}>{s}</Chip>)}</>],
          ['Resume', <a>📄 {c.resume}</a>],
        ]} />
      </div>

      {c.offer && (
        <div style={{ marginBottom: 16 }}>
          <Banner kind="good" icon="📄" title={'Offer ' + c.offer.status.toLowerCase()}>
            {inr(c.offer.ctc)} p.a. · {GRADES[c.offer.grade].label} · joining {fmtD(c.offer.doj)}
          </Banner>
        </div>
      )}

      <h4 style={{ margin: '0 0 8px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--ink-3)' }}>
        Interviews ({ivs.length})
      </h4>
      {ivs.length ? ivs.map((i) => (
        <Card key={i.id} style={{ marginBottom: 8 }}>
          <div className="row">
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{i.round}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                {fmtD(i.date)} · {fmtTime(i.time)} · {i.mode} · {dir.name(i.panelId)}
              </div>
            </div>
            {i.verdict ? <VerdictBadge v={i.verdict} /> : <StatusBadge status={i.status} />}
          </div>
          {i.feedback && <div style={{ marginTop: 7, fontSize: 12.5, color: 'var(--ink-2)' }}>{i.feedback}</div>}
        </Card>
      )) : <div className="muted">No interviews scheduled yet</div>}

      <Divide />
      {c.notes.map((n, i) => (
        <div key={i} style={{ marginBottom: 7 }}>
          <Banner icon="💬" title={`${n.by} · ${n.on}`}>{n.text}</Banner>
        </div>
      ))}
    </>
  );
}

function useShowCandidate() {
  const layer = useLayer();
  const app = useApp();
  const { data: CANDS = [] } = useCandidates();

  return (id: string) => {
    const c = CANDS.find((x) => x.id === id);
    if (!c) return;
    const r = reqOf(c.reqId);

    layer.drawer({
      title: c.name,
      sub: (r ? r.title : '') + ' · ' + c.source,
      body: <CandidateBody c={c} />,
      footer: (close) => <StageFooter c={c} close={close} />,
    });
  };

  /**
   * What can be done to a candidate depends on where they are.
   *
   * Booking an interview, drafting an offer and recording an answer are three
   * different moments in one conversation, and offering all three at once
   * invites somebody to record an answer to an offer that was never made.
   */
  function StageActions({ c }: { c: Candidate }) {
    const { data: people = [] } = usePanel();
    const r = reqOf(c.reqId);
    const terminal = c.stage === 'hired' || c.stage === 'rejected';

    const open = (title: string, body: (close: () => void) => React.ReactNode) =>
      layer.modal({ title, sub: c.name, size: 'wide', body, footer: null });

    if (terminal) return null;

    return (
      <>
        <button className="btn sm" onClick={() => open('Book an interview',
          (x) => <ScheduleInterviewForm close={x} cand={c} people={people} />)}>
          📅 Interview
        </button>
        {!c.offer && (
          <button className="btn sm" onClick={() => open('Draft an offer',
            (x) => <MakeOfferForm close={x} cand={c} req={r} />)}>
            📄 Offer
          </button>
        )}
        {c.offer && c.offer.status !== 'Draft' && c.offer.status !== 'Accepted' && (
          <button className="btn sm" onClick={() => open('Record the answer',
            (x) => <OfferResponseForm close={x} cand={c} />)}>
            ✓ Answer
          </button>
        )}
      </>
    );
  }

  function StageFooter({ c, close }: { c: Candidate; close: () => void }) {
    const [stage, setStage] = useState(c.stage);
    const move = useMoveCandidate();
    /*
     * Goes through the service, like the pipeline board does. Assigning to
     * c.stage here only repainted this drawer: the move never reached the
     * server, and the refusal that matters — hiring past a requisition's
     * openings — could not happen at all.
     */
    const update = async () => {
      try {
        await move.mutate(c.id, stage);
        close();
        app.toast(`${c.name} moved to ${STAGES.find((s) => s.id === stage)!.name}`, 'ok');
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Could not move the candidate', 'err');
      }
    };
    return (
      <>
        <button className="btn" onClick={close}>Close</button>
        <StageActions c={c} />
        <div className="spacer" />
        <select className="input" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value)}>
          {STAGES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button className="btn primary" onClick={update}>Update</button>
      </>
    );
  }
}

/* ---------------- Pipeline (kanban) ---------------- */

function HrPipeline() {
  const { data: CANDS = [] } = useCandidates();
  const { data: REQS = [] } = useRequisitions();
  const layer = useLayer();
  const { data: INTERVIEWS = [] } = useInterviews();
  const move = useMoveCandidate();
  const app = useApp();
  const show = useShowCandidate();
  const [reqF, setReqF] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);

  const scope = reqScope(app.role, app.meId, REQS);
  let cands = hiringScope(app.role, app.meId, CANDS).filter((c) => c.stage !== 'rejected');
  if (reqF) cands = cands.filter((c) => c.reqId === reqF);
  const stages = STAGES.filter((s) => s.id !== 'rejected');

  const drop = async (stageId: string) => {
    const c = CANDS.find((x) => x.id === dragId);
    setDragId(null);
    if (!c || c.stage === stageId) return;
    try {
      await move.mutate(c.id, stageId);
      app.toast(`${c.name} moved to ${STAGES.find((s) => s.id === stageId)!.name}`, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not move the candidate', 'err');
    }
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <select className="input" style={{ width: 'auto', maxWidth: 320 }} value={reqF} onChange={(e) => setReqF(e.target.value)}>
          <option value="">All requisitions ({scope.length})</option>
          {scope.map((r) => <option key={r.id} value={r.id}>{r.id} — {r.title}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn primary" onClick={() => layer.modal({
          title: 'Submit a candidate',
          sub: 'Against an open requisition',
          size: 'wide',
          body: (close: () => void) => <NewCandidateForm close={close} reqs={REQS} />,
          footer: null,
        })}>＋ Add candidate</button>
      </div>

      <Banner kind="info" icon="🖱️">
        Drag a candidate card between columns to move them through the pipeline. Click a card to open the full profile,
        interview history and feedback.
      </Banner>

      <div className="kb">
        {stages.map((s) => {
          const list = cands.filter((c) => c.stage === s.id);
          return (
            <div key={s.id} className="kb-col"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(s.id)}>
              <h5>
                <Dot color={s.color} />{s.name}<span className="n">{list.length}</span>
              </h5>
              <div className="kb-body">
                {list.map((c) => {
                  const r = reqOf(c.reqId);
                  return (
                    <div key={c.id} className="kb-card" draggable
                      onDragStart={() => setDragId(c.id)}
                      onClick={() => show(c.id)}>
                      <div className="row" style={{ gap: 8 }}>
                        <Avatar name={c.name} size="sm" />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 650, fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c.name}
                          </div>
                          <div className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {r ? r.title : ''}
                          </div>
                        </div>
                      </div>
                      <div className="row wrap" style={{ gap: 4, marginTop: 7 }}>
                        <Chip>{c.exp}</Chip>
                        <Chip>{c.notice}</Chip>
                        <Chip>{lakh(c.ctcExp)}</Chip>
                      </div>
                      <div className="row" style={{ marginTop: 7, justifyContent: 'space-between' }}>
                        <span className="muted" style={{ fontSize: 10.5 }}>{c.source}</span>
                        <span style={{ fontSize: 10.5 }}><Stars n={c.rating} /></span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <StatRow cols={4}>
        <Tile label="Active candidates" value={cands.length} foot="In pipeline right now" />
        <Tile label="In offer stage" value={cands.filter((c) => c.stage === 'offer').length} foot="Awaiting acceptance" />
        <Tile label="Interviews this week"
          value={INTERVIEWS.filter((i) => i.status === 'Scheduled' && i.date <= ymd(addDays(TODAY, 7))).length}
          foot="Scheduled across panels" />
        <Tile label="Avg time to hire" value="34 days" foot="From application to offer accepted" />
      </StatRow>
    </div>
  );
}

/* ---------------- Requisitions ---------------- */

function HrReqs() {
  const { data: REQS = [] } = useRequisitions();
  const { data: CANDS = [] } = useCandidates();
  const { data: people = [] } = usePanel();
  const dir = useVisiblePeople();
  const app = useApp();
  const layer = useLayer();
  /* The server refuses anyone else; the button is hidden for the same reason. */
  const canOpen = app.role === 'admin' || app.role === 'manager';
  const list = reqScope(app.role, app.meId, REQS);
  const open = list.filter((r) => r.status === 'Open');

  const showReq = (r: Requisition) =>
    layer.modal({
      title: r.title,
      sub: `${r.id} · ${deptOf(r.dept).name} · ${siteOf(r.site).name}`,
      size: 'wide',
      body: (
        <>
          <KV rows={[
            ['Status', <StatusBadge status={r.status} />],
            ['Priority', r.priority],
            ['Grade', GRADES[r.grade].label],
            ['Experience', r.exp],
            ['Openings', `${r.filled} filled of ${r.openings}`],
            ['Budget', `${inr(r.budgetMin)} – ${inr(r.budgetMax)}`],
            ['Hiring manager', dir.name(r.hiringManagerId)],
            ['Recruiter', dir.name(r.recruiterId)],
            ['Opened on', fmtD(r.openedOn)],
            ['Must-have skills', <>{r.must.map((s) => <Chip key={s}>{s}</Chip>)}</>],
          ]} />
          <Divide />
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>{r.desc}</div>
        </>
      ),
    });

  const exportCsv = () =>
    downloadCSV('requisitions.csv',
      [['ID', 'Title', 'Department', 'Location', 'Grade', 'Openings', 'Filled', 'Priority', 'Hiring manager', 'Recruiter', 'Opened', 'Status']].concat(
        list.map((r) => [r.id, r.title, deptOf(r.dept).name, siteOf(r.site).name, r.grade,
          String(r.openings), String(r.filled), r.priority, dir.name(r.hiringManagerId), dir.name(r.recruiterId), r.openedOn, r.status]),
      ));

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
        {canOpen && (
          <button className="btn primary" onClick={() => layer.modal({
            title: 'Open a requisition',
            sub: 'A role to hire for',
            size: 'wide',
            body: (close: () => void) => <NewRequisitionForm close={close} people={people} />,
            footer: null,
          })}>＋ Create requisition</button>
        )}
      </div>

      <StatRow cols={4}>
        <Tile label="Open requisitions" value={open.length} foot={`${sum(open, (r) => r.openings - r.filled)} positions to fill`} />
        <Tile label="Positions filled" value={sum(list, (r) => r.filled)} foot="This hiring cycle" />
        <Tile label="Critical priority" value={list.filter((r) => r.priority === 'Critical' && r.status === 'Open').length}
          foot="Escalated to leadership" />
        <Tile label="Avg age of requisition"
          value={Math.round(sum(open, (r) => daysBetween(r.openedOn, ymd(TODAY))) / Math.max(1, open.length)) + ' days'}
          foot="Since opened" />
      </StatRow>

      <Card title="Requisitions" sub={`${list.length} total`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>ID</th><th>Role</th><th>Department</th><th>Location</th><th className="num">Openings</th>
                <th>Progress</th><th>Priority</th><th>Hiring manager</th><th>Recruiter</th><th>Opened</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const cs = CANDS.filter((c) => c.reqId === r.id);
                return (
                  <tr key={r.id} className="clickable" onClick={() => showReq(r)}>
                    <td className="mono">{r.id}</td>
                    <td>
                      <b>{r.title}</b>
                      <div className="muted" style={{ fontSize: 11 }}>{r.exp} · {GRADES[r.grade].label}</div>
                    </td>
                    <td className="nowrap">{deptOf(r.dept).name}</td>
                    <td className="nowrap">{siteOf(r.site).city}</td>
                    <td className="num">{r.filled} / {r.openings}</td>
                    <td style={{ minWidth: 130 }}>
                      <div className="bar"><i style={{ width: pct(r.filled, r.openings) + '%' }} /></div>
                      <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                        {cs.length} applicants · {cs.filter((c) => !['hired', 'rejected'].includes(c.stage)).length} active
                      </div>
                    </td>
                    <td>
                      <Badge kind={r.priority === 'Critical' ? 'crit' : r.priority === 'High' ? 'warn' : 'mute'}>{r.priority}</Badge>
                    </td>
                    <td className="nowrap">{dir.name(r.hiringManagerId)}</td>
                    <td className="nowrap">{dir.name(r.recruiterId)}</td>
                    <td className="nowrap">{fmtD(r.openedOn)}</td>
                    <td><StatusBadge status={r.status} /></td>
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

/* ---------------- Candidates ---------------- */

function HrCands({ stage, onStage }: { stage: string; onStage: (s: string) => void }) {
  const { data: CANDS = [] } = useCandidates();
  const { data: REQS = [] } = useRequisitions();
  const dir = useVisiblePeople();
  const app = useApp();
  const show = useShowCandidate();
  const [q, setQ] = useState('');
  const [job, setJob] = useState('');
  const [rec, setRec] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);

  let list = hiringScope(app.role, app.meId, CANDS);
  if (stage) list = list.filter((c) => c.stage === stage);
  if (job) list = list.filter((c) => c.reqId === job);
  if (rec) list = list.filter((c) => reqOf(c.reqId)?.recruiterId === rec);
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((c) =>
      (c.name + ' ' + c.email + ' ' + c.current + ' ' + c.loc + ' ' + c.skills.join(' '))
        .toLowerCase().includes(needle));
  }
  list = sortBy(list, (c) => c.appliedOn, 'desc');
  const paged = pageOf(list, page, size);

  /* Recruiters who actually own a requisition — not the whole directory. */
  const recruiters = [...new Set(REQS.map((r) => r.recruiterId).filter(Boolean))];

  const exportCsv = () =>
    downloadCSV('candidates.csv',
      [['Name', 'Email', 'Phone', 'Applied for', 'Stage', 'Experience', 'Location',
        'Current employer', 'Skills', 'Notice', 'Source', 'Rating', 'Recruiter', 'Applied']].concat(
        list.map((c) => [c.name, c.email, c.phone, reqOf(c.reqId)?.title || '', c.stage, c.exp,
          c.loc, c.current, c.skills.join(' / '), c.notice, c.source, String(c.rating),
          dir.name(reqOf(c.reqId)?.recruiterId ?? ''), c.appliedOn]),
      ));

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <input className="input" placeholder="Search by name, email, skill or location…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={job}
          onChange={(e) => setJob(e.target.value)}>
          <option value="">All jobs</option>
          {REQS.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={stage}
          onChange={(e) => onStage(e.target.value)}>
          <option value="">All statuses</option>
          {STAGES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={rec}
          onChange={(e) => setRec(e.target.value)}>
          <option value="">All recruiters</option>
          {recruiters.map((id) => <option key={id} value={id}>{dir.name(id)}</option>)}
        </select>
        <div className="spacer" />
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
      </div>

      <Card title="Candidates" sub={`${list.length} of ${CANDS.length}`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Candidate</th><th>Job title</th><th>Experience</th><th>Location</th>
                <th>Skills</th><th>Status</th><th>Applied on</th><th>Recruiter</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((c) => {
                const r = reqOf(c.reqId);
                const st = STAGES.find((x) => x.id === c.stage)!;
                return (
                  <tr key={c.id} className="clickable" onClick={() => show(c.id)}>
                    <td>
                      <div className="person">
                        <Avatar name={c.name} size="sm" />
                        <div style={{ minWidth: 0 }}>
                          <div className="nm">{c.name}</div>
                          <div className="mt">{c.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="nowrap">{r ? r.title : '—'}</td>
                    <td className="nowrap">{c.exp}</td>
                    <td className="nowrap">{c.loc}</td>
                    <td>
                      {/* Three is what fits; the drawer has the rest. */}
                      <div className="skills">
                        {c.skills.slice(0, 3).map((k) => <Chip key={k}>{k}</Chip>)}
                        {c.skills.length > 3 && (
                          <span className="muted" style={{ fontSize: 10.5 }}>
                            +{c.skills.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{
                        background: `color-mix(in srgb, ${st.color} 15%, transparent)`,
                        color: st.color,
                        borderColor: `color-mix(in srgb, ${st.color} 35%, transparent)`,
                      }}>{st.name}</span>
                    </td>
                    <td className="nowrap">{fmtD(c.appliedOn)}</td>
                    <td className="nowrap">
                      {r?.recruiterId ? dir.name(r.recruiterId) : <span className="muted">—</span>}
                    </td>
                    <td className="right nowrap">
                      <button className="btn ghost icon sm" title={`Open ${c.name}`}
                        onClick={(e) => { e.stopPropagation(); show(c.id); }}>👁</button>
                      <a className="btn ghost icon sm" title={`Email ${c.name}`}
                        href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}>✉</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager {...paged} noun="candidates" onPage={setPage} size={size} onSize={setSize} />
      </Card>
    </div>
  );
}

function HrIvs() {
  const { data: CANDS = [] } = useCandidates();
  const { data: INTERVIEWS = [] } = useInterviews();
  const dir = useVisiblePeople();
  const app = useApp();
  const layer = useLayer();
  const show = useShowCandidate();
  const candOf = (id: string) => CANDS.find((x) => x.id === id);
  const mine = INTERVIEWS.filter((i) => app.role === 'admin' || i.panelId === app.meId || isMyReport(app.meId, i.panelId));
  const upcoming = sortBy(mine.filter((i) => i.status === 'Scheduled'), (i) => i.date);
  const done = sortBy(mine.filter((i) => i.status !== 'Scheduled'), (i) => i.date, 'desc');
  const withVerdict = done.filter((i) => i.verdict);

  const Row = ({ i, showV }: { i: Interview; showV: boolean }) => {
    const c = CANDS.find((x) => x.id === i.candId);
    if (!c) return null;
    return (
      <tr className="clickable" onClick={() => show(c.id)}>
        <td><CandCell c={c} sub={reqOf(i.reqId)?.title || ''} /></td>
        <td>{i.round}</td>
        <td className="nowrap">{fmtD(i.date)} · {fmtTime(i.time)}</td>
        <td>{i.mode}</td>
        <td className="nowrap">{dir.name(i.panelId)}</td>
        <td><StatusBadge status={i.status} /></td>
        {showV
          ? <td>{i.verdict ? <VerdictBadge v={i.verdict} /> : '—'}</td>
          : (
            <td className="right">
              <button className="btn sm" onClick={(e) => {
                e.stopPropagation();
                layer.modal({
                  title: 'Interview feedback',
                  sub: candOf(i.candId)?.name ?? '',
                  body: (close: () => void) => (
                    <FeedbackForm close={close} interviewId={i.id}
                      who={candOf(i.candId)?.name ?? ''} round={i.round} />
                  ),
                  footer: null,
                });
              }}>Feedback</button>
            </td>
          )}
      </tr>
    );
  };

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Scheduled" value={upcoming.length} foot="Upcoming interviews" />
        <Tile label="This week" value={upcoming.filter((i) => i.date <= ymd(addDays(TODAY, 7))).length} foot="Next 7 days" />
        <Tile label="Completed" value={done.filter((i) => i.status === 'Completed').length} foot="With feedback recorded" />
        <Tile label="Selection rate"
          value={pct(withVerdict.filter((i) => i.verdict!.includes('Hire') && !i.verdict!.includes('No')).length, Math.max(1, withVerdict.length)) + '%'}
          foot="Hire / strong-hire verdicts" />
      </StatRow>

      <Card title="Upcoming interviews" sub={`${upcoming.length} scheduled`} flush>
        {upcoming.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Candidate</th><th>Round</th><th>When</th><th>Mode</th><th>Panel</th><th>Status</th><th className="right">Action</th></tr></thead>
              <tbody>{upcoming.map((i) => <Row key={i.id} i={i} showV={false} />)}</tbody>
            </table>
          </div>
        ) : <EmptyState msg="No interviews scheduled" icon="🎯" />}
      </Card>

      <Card title="Interview history" sub={`${done.length} completed`} flush>
        <div className="tbl-wrap" style={{ maxHeight: 460, overflow: 'auto' }}>
          <table className="tbl">
            <thead><tr><th>Candidate</th><th>Round</th><th>When</th><th>Mode</th><th>Panel</th><th>Status</th><th>Verdict</th></tr></thead>
            <tbody>{done.map((i) => <Row key={i.id} i={i} showV />)}</tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Offers ---------------- */

function HrOffers() {
  const { data: CANDS = [] } = useCandidates();
  const app = useApp();
  const show = useShowCandidate();
  const layer = useLayer();
  const list = hiringScope(app.role, app.meId, CANDS).filter((c) => c.offer);
  /* Draft leads: an offer waiting to be read back is the thing to act on. */
  const byStatus = ['Draft', 'Sent', 'Negotiating', 'Accepted'].map((s, i) => ({
    k: s, c: PAL[i], v: list.filter((c) => c.offer!.status === s).length,
  }));
  const drafts = list.filter((c) => c.offer!.status === 'Draft').length;

  const openLetter = (c: Candidate) => layer.modal({
    title: 'Offer letter — ' + c.name,
    sub: reqOf(c.reqId)?.title ?? '',
    size: 'wide',
    body: (close) => <OfferLetter c={c} onDone={close} />,
  });

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Awaiting release" value={drafts} foot="Drafted, not yet sent" />
        <Tile label="Accepted" value={list.filter((c) => c.offer!.status === 'Accepted').length}
          foot={pct(list.filter((c) => c.offer!.status === 'Accepted').length, Math.max(1, list.length)) + '% acceptance rate'} />
        <Tile label="In negotiation" value={list.filter((c) => c.offer!.status === 'Negotiating').length} foot="Compensation discussions" />
        <Tile label="Avg offered CTC" value={lakh(sum(list, (c) => c.offer!.ctc) / Math.max(1, list.length))} foot="Across all levels" />
      </StatRow>

      <div className="grid g-2-1">
        <Card title="Offers" sub={`${list.length} records`} flush
          actions={<button className="btn sm" onClick={() =>
            downloadCSV('offers.csv',
              [['Candidate', 'Role', 'Grade', 'Offered CTC', 'Expected', 'Date of joining', 'Sent on', 'Status']].concat(
                list.map((c) => [c.name, reqOf(c.reqId)?.title || '', c.offer!.grade,
                  String(c.offer!.ctc), String(c.ctcExp), c.offer!.doj, c.offer!.sentOn ?? '—', c.offer!.status]),
              ))}>⤓ Export</button>}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Candidate</th><th>Role</th><th>Grade</th><th className="num">Offered CTC</th>
                  <th className="num">Expected</th><th>Date of joining</th><th>Sent on</th><th>Status</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortBy(list, (c) => c.offer!.sentOn ?? '', 'desc').map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => show(c.id)}>
                    <td><CandCell c={c} sub={c.current} /></td>
                    <td className="nowrap">{reqOf(c.reqId)?.title || '—'}</td>
                    <td><Badge>{c.offer!.grade}</Badge></td>
                    <td className="num strong">{inr(c.offer!.ctc)}</td>
                    <td className="num">{inr(c.ctcExp)}</td>
                    <td className="nowrap">{fmtD(c.offer!.doj)}</td>
                    <td className="nowrap">{fmtD(c.offer!.sentOn)}</td>
                    <td><StatusBadge status={c.offer!.status} /></td>
                    <td className="right">
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); openLetter(c); }}>
                        {c.offer!.status === 'Draft' ? 'Review & release' : 'Letter'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Offer status" sub="Current cycle">
          <Donut size={160} center={list.length} centerSub="offers" slices={byStatus} />
          <Legend items={byStatus} />
        </Card>
      </div>
    </div>
  );
}

/* ---------------- Analytics ---------------- */

function HrFunnel() {
  const { data: CANDS = [] } = useCandidates();
  const { data: REQS = [] } = useRequisitions();
  const app = useApp();
  const cands = hiringScope(app.role, app.meId, CANDS);
  const stages = STAGES.filter((s) => s.id !== 'rejected');

  /* cumulative funnel — everyone who reached at least this stage */
  const cum = stages.map((s, i) => ({
    k: s.name, c: s.color,
    v:
      cands.filter((c) => {
        if (c.stage === 'rejected') return false;
        return STAGES.findIndex((x) => x.id === c.stage) >= i;
      }).length + (i === 0 ? cands.filter((c) => c.stage === 'rejected').length : 0),
  }));

  const bySource = SOURCES.map((s, i) => ({ k: s, c: PAL[i % 8], v: cands.filter((c) => c.source === s).length }));
  const byDept = DEPTS.map((d) => ({
    k: d.name, c: d.color, v: cands.filter((c) => reqOf(c.reqId)?.dept === d.id).length,
  })).filter((r) => r.v);
  const hiredBySource = SOURCES.map((s, i) => ({
    k: s, c: PAL[i % 8], v: cands.filter((c) => c.source === s && c.stage === 'hired').length,
  })).filter((r) => r.v);

  const months: { k: string; l: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(TODAY.getFullYear(), TODAY.getMonth() - i, 1);
    months.push({ k: monthKey(d), l: MON[d.getMonth()] });
  }

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile label="Total applicants" value={cands.length} foot={`Across ${reqScope(app.role, app.meId, REQS).length} requisitions`} />
        <Tile label="Offer conversion" value={pct(cands.filter((c) => c.offer).length, Math.max(1, cands.length)) + '%'} foot="Applicant → offer" />
        <Tile label="Hired" value={cands.filter((c) => c.stage === 'hired').length} foot="Joined or joining" />
        <Tile label="Rejection rate" value={pct(cands.filter((c) => c.stage === 'rejected').length, Math.max(1, cands.length)) + '%'}
          foot="Screened out at any stage" />
      </StatRow>

      <div className="grid g2">
        <Card title="Hiring funnel" sub="Candidates reaching each stage"><HBar rows={cum} /></Card>
        <Card title="Applications by source" sub={`${cands.length} applicants`}>
          <HBar rows={sortBy(bySource, (r) => -r.v)} />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Applications over time" sub="Last 6 months">
          <BarChart labels={months.map((m) => m.l)} height={200}
            series={[
              { name: 'Applications', color: 'var(--s1)', data: months.map((m) => cands.filter((c) => c.appliedOn.slice(0, 7) === m.k).length) },
              { name: 'Hires', color: 'var(--s3)', data: months.map((m) => cands.filter((c) => c.stage === 'hired' && c.offer?.sentOn?.slice(0, 7) === m.k).length) },
            ]} />
          <Legend items={[{ k: 'Applications', c: 'var(--s1)' }, { k: 'Hires', c: 'var(--s3)' }]} />
        </Card>

        <Card title="Pipeline by department" sub="Active + closed">
          <HBar rows={sortBy(byDept, (r) => -r.v)} />
          {hiredBySource.length > 0 && (
            <>
              <Divide />
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Hires by source</div>
              <HBar rows={sortBy(hiredBySource, (r) => -r.v)} />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'cands' | 'pipe' | 'reqs' | 'ivs' | 'offers' | 'track' | 'fun';

const TABS: { v: Tab; label: string }[] = [
  { v: 'cands', label: 'Candidates' },
  { v: 'pipe', label: 'Pipeline board' },
  { v: 'reqs', label: 'Job requisitions' },
  { v: 'ivs', label: 'Interviews' },
  { v: 'offers', label: 'Offers' },
  { v: 'track', label: 'Activity tracker' },
  { v: 'fun', label: 'Analytics' },
];

/**
 * The module: one overview, then the detail underneath.
 *
 * The pipeline used to be a tab of its own beside Candidates, which meant
 * leaving the picture to read the detail and leaving the detail to check the
 * picture. It is now a band that stays, and clicking a stage filters the
 * candidates below — the same list, looked at from the top or from the side.
 */
function Hiring() {
  const app = useApp();
  const show = useShowCandidate();
  const { data: CANDS = [] } = useCandidates();
  const { data: REQS = [] } = useRequisitions();
  const [tab, setTab] = useState<Tab>('cands');
  const [stage, setStage] = useState('');

  const mine = hiringScope(app.role, app.meId, CANDS);
  const myReqs = reqScope(app.role, app.meId, REQS);

  /* Filtering by stage is a question about candidates, so it opens that tab. */
  const pickStage = (s: string) => {
    setStage(s);
    if (s) setTab('cands');
  };

  return (
    <div className="stack">
      <HiringOverview cands={mine} reqs={myReqs} onCandidate={show}
        onStage={pickStage} stage={stage} />

      <Tabs value={tab} options={TABS} onChange={setTab} />
      {tab === 'cands' && <HrCands stage={stage} onStage={pickStage} />}
      {tab === 'pipe' && <HrPipeline />}
      {tab === 'reqs' && <HrReqs />}
      {tab === 'ivs' && <HrIvs />}
      {tab === 'offers' && <HrOffers />}
      {tab === 'track' && <TrackerView />}
      {tab === 'fun' && <HrFunnel />}
    </div>
  );
}

registerModule({
  key: 'hiring',
  title: TITLES.hiring,
  Component: Hiring,
});
