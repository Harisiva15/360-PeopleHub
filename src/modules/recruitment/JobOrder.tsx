/**
 * One job order: what it is, who is on it, and everything that has happened.
 *
 * **The timeline is the point of this page.** A desk argues about who
 * submitted a candidate first and why an order slipped, and neither question
 * can be answered from a row that only holds its current state. So the history
 * is append-only — the screen offers no way to edit or delete a line, because
 * the table underneath it revokes UPDATE and DELETE and a button that always
 * failed would be worse than no button.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { sortBy } from '../../lib/collections';
import { fmtD, fmtDS } from '../../lib/dates';
import { money } from '../../data/countries';
import {
  ACTIVITY_META, clientOf, JOB_PRIORITIES, sowOf, vendorOf,
} from '../../data/staffing';
import type { ActivityKind, AssignRole, JobActivity, JobOrderDetail } from '../../services';
import {
  Avatar, Badge, Banner, Card, EmptyState, KV, StatRow, Tile,
} from '../../components/ui';
import { Chip } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import {
  useAssign, useJobOrder, useLogActivity, useRelease, useUpdateJobOrder, useVisiblePeople,
} from './data';
import { Commercials, PriorityBadge, SlaBadge, jobNo, rateUnit } from './shared';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/* ---------------- the activity tracker ---------------- */

/** The day an instant falls on, for grouping. */
const dayOf = (at: string) => at.slice(0, 10);

/** `2026-09-18T09:30:00` → `09:30 AM`. */
function clockOf(at: string): string {
  const [h, m] = at.slice(11, 16).split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
}

/**
 * The order's history, newest first, grouped by day.
 *
 * Grouped because a desk reads it as "what happened on Thursday" rather than
 * as an undifferentiated list, and a date repeated down forty rows is forty
 * repetitions of something that changes four times.
 */
function Timeline({ rows }: { rows: JobActivity[] }) {
  const dir = useVisiblePeople();
  if (!rows.length) return <EmptyState icon="🕑" msg="Nothing has happened on this order yet" />;

  const days = sortBy(
    Array.from(new Set(rows.map((a) => dayOf(a.at)))),
    (d) => d, 'desc');

  return (
    <div className="tl">
      {days.map((d) => (
        <div className="tl-day" key={d}>
          <div className="tl-date">{fmtD(d)}</div>
          {rows.filter((a) => dayOf(a.at) === d).map((a) => {
            const meta = ACTIVITY_META[a.kind];
            return (
              <div className="tl-row" key={a.id}>
                <div className="tl-time mono">{clockOf(a.at)}</div>
                <div className="tl-mark" aria-hidden="true">
                  <i style={{ background: meta.c }} />
                </div>
                <div className="tl-body">
                  <div className="tl-k">{meta.n}</div>
                  <div className="tl-s">{a.summary}</div>
                  {a.actorId && (
                    <div className="tl-who muted">{dir.name(a.actorId)}</div>
                  )}
                </div>
                {a.qty !== null && <div className="tl-qty mono">{a.qty}</div>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** What a recruiter can add to the history by hand. */
const LOGGABLE: { k: ActivityKind; n: string; counted?: boolean }[] = [
  { k: 'reviewed', n: 'Job reviewed' },
  { k: 'sourced', n: 'Candidates sourced', counted: true },
  { k: 'screened', n: 'Candidates screened', counted: true },
  { k: 'client_review', n: 'Client review' },
  { k: 'note', n: 'Note' },
];

function LogForm({ id, close }: { id: string; close: () => void }) {
  const app = useApp();
  const add = useLogActivity();
  const [kind, setKind] = useState<ActivityKind>('sourced');
  const [qty, setQty] = useState('20');
  const [summary, setSummary] = useState('');
  const [err, setErr] = useState('');

  const counted = LOGGABLE.find((x) => x.k === kind)?.counted;

  const save = async () => {
    const n = counted ? Number(qty) : undefined;
    const text = summary.trim()
      || (counted ? `${n} candidates ${kind === 'sourced' ? 'sourced' : 'screened'}` : '');
    if (!text) { setErr('Say what happened'); return; }
    try {
      await add.mutate(id, kind, text, n);
      app.toast('Activity logged', 'ok');
      close();
    } catch (e) {
      setErr(msg(e, 'Could not log that'));
    }
  };

  return (
    <div className="stack">
      <div className="field">
        <label>What happened</label>
        <select className="input" value={kind}
          onChange={(e) => setKind(e.target.value as ActivityKind)}>
          {LOGGABLE.map((x) => <option key={x.k} value={x.k}>{x.n}</option>)}
        </select>
      </div>
      {counted && (
        <div className="field">
          <label>How many</label>
          <input className="input" type="number" min="1" value={qty}
            onChange={(e) => setQty(e.target.value)} />
        </div>
      )}
      <div className="field">
        <label>Note {!counted && <span className="req">*</span>}</label>
        <textarea className="input" rows={3} value={summary}
          placeholder={counted ? 'Optional — the count is enough' : 'What the desk should know'}
          onChange={(e) => setSummary(e.target.value)} />
      </div>
      {err && <div className="ts-err-box">⚠ {err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={add.pending} onClick={save}>Log it</button>
      </div>
    </div>
  );
}

/* ---------------- recruiter assignment ---------------- */

function AssignForm({
  d, role, close,
}: {
  d: JobOrderDetail;
  role: AssignRole;
  close: () => void;
}) {
  const app = useApp();
  const assign = useAssign();
  const dir = useVisiblePeople();
  const held = d.assignments.find((a) => a.role === role);

  const [recruiterId, setRecruiterId] = useState(held?.recruiterId ?? '');
  const [subs, setSubs] = useState(String(held?.targetSubmissions ?? d.order.maxSubmissions));
  const [ivs, setIvs] = useState(String(held?.targetInterviews ?? d.order.positions * 2));
  const [hires, setHires] = useState(String(held?.targetHires ?? d.order.positions));
  const [daily, setDaily] = useState(String(held?.dailySubmissions ?? 1));
  const [weekly, setWeekly] = useState(String(held?.weeklySubmissions ?? 4));
  const [priority, setPriority] = useState(held?.priority ?? d.order.priority);
  const [notes, setNotes] = useState(held?.notes ?? '');
  const [err, setErr] = useState('');

  const num = (v: string) => (v.trim() === '' ? null : Number(v));

  const save = async () => {
    if (!recruiterId) { setErr('Choose who is taking this'); return; }
    try {
      await assign.mutate(d.order.id, {
        recruiterId,
        role,
        targetSubmissions: num(subs),
        targetInterviews: num(ivs),
        targetHires: num(hires),
        dailySubmissions: num(daily),
        weeklySubmissions: num(weekly),
        priority,
        notes: notes.trim(),
      });
      app.toast(held ? 'Assignment updated' : 'Recruiter assigned', 'ok');
      close();
    } catch (e) {
      setErr(msg(e, 'Could not assign'));
    }
  };

  const targets = role === 'primary';

  return (
    <div className="stack">
      <div className="field">
        <label>{role === 'manager' ? 'Recruitment manager' : `${role} recruiter`}
          <span className="req">*</span></label>
        <select className="input" value={recruiterId}
          onChange={(e) => setRecruiterId(e.target.value)}>
          <option value="">Choose somebody…</option>
          {sortBy(dir.list, (e) => e.name).map((e) => (
            <option key={e.id} value={e.id}>{e.name} · {e.designation}</option>
          ))}
        </select>
        {held && held.recruiterId !== recruiterId && (
          <div className="hint">
            {dir.name(held.recruiterId)} is released from this order, and the change is
            recorded on the timeline.
          </div>
        )}
      </div>

      {targets && (
        <>
          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Target submissions</label>
              <input className="input" type="number" min="0" value={subs}
                onChange={(e) => setSubs(e.target.value)} />
              <div className="hint">
                {clientOf(d.order.clientId).name} will read {d.order.maxSubmissions}.
              </div>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Target interviews</label>
              <input className="input" type="number" min="0" value={ivs}
                onChange={(e) => setIvs(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Target hires</label>
              <input className="input" type="number" min="0" value={hires}
                onChange={(e) => setHires(e.target.value)} />
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Daily submission target</label>
              <input className="input" type="number" min="0" value={daily}
                onChange={(e) => setDaily(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Weekly submission target</label>
              <input className="input" type="number" min="0" value={weekly}
                onChange={(e) => setWeekly(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Priority</label>
              <select className="input" value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}>
                {JOB_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </>
      )}

      <div className="field">
        <label>Notes</label>
        <textarea className="input" rows={2} value={notes}
          placeholder="Anything the recruiter should know before they start"
          onChange={(e) => setNotes(e.target.value)} />
      </div>

      {err && <div className="ts-err-box">⚠ {err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={assign.pending} onClick={save}>
          {held ? 'Update assignment' : 'Assign recruiter'}
        </button>
      </div>
    </div>
  );
}

/** The desk: who holds each role, and what they were asked to deliver. */
function Desk({ d, canEdit }: { d: JobOrderDetail; canEdit: boolean }) {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const release = useRelease();

  const open = (role: AssignRole) => layer.modal({
    title: d.assignments.some((a) => a.role === role) ? 'Change assignment' : 'Assign recruiter',
    sub: `${d.order.title} · ${role}`,
    body: (close) => <AssignForm d={d} role={role} close={close} />,
    footer: null,
  });

  const ROLES: { r: AssignRole; n: string }[] = [
    { r: 'primary', n: 'Primary recruiter' },
    { r: 'backup', n: 'Backup recruiter' },
    { r: 'manager', n: 'Recruitment manager' },
  ];

  return (
    <Card title="Recruiter assignment"
      sub={`Assigned ${d.assignments[0] ? fmtD(d.assignments[0].assignedOn) : '—'}`}
      actions={canEdit
        ? <button className="btn sm" onClick={() => open('primary')}>Assign</button>
        : undefined}>
      <div className="stack">
        {ROLES.map(({ r, n }) => {
          const a = d.assignments.find((x) => x.role === r);
          return (
            <div className="desk-row" key={r}>
              <div className="desk-role">{n}</div>
              {a ? (
                <>
                  <div className="desk-who">
                    <Avatar name={dir.name(a.recruiterId)} />
                    <div style={{ minWidth: 0 }}>
                      <div className="desk-n">{dir.name(a.recruiterId)}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        since {fmtDS(a.assignedOn)}
                      </div>
                    </div>
                  </div>
                  {canEdit && (
                    <div className="desk-acts">
                      <button className="btn ghost sm" onClick={() => open(r)}>Change</button>
                      {r !== 'primary' && (
                        <button className="btn ghost sm" onClick={async () => {
                          try {
                            await release.mutate(d.order.id, a.id);
                            app.toast('Released', 'ok');
                          } catch (e) {
                            app.toast(msg(e, 'Could not release'), 'err');
                          }
                        }}>Release</button>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="desk-who muted">Nobody assigned</div>
                  {canEdit && (
                    <div className="desk-acts">
                      <button className="btn ghost sm" onClick={() => open(r)}>Assign</button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {(() => {
        const p = d.assignments.find((a) => a.role === 'primary');
        if (!p) return null;
        return (
          <div style={{ marginTop: 14 }}>
            <KV rows={[
              ['Target submissions',
                <>
                  <b>{d.counts.submissions}</b> / {p.targetSubmissions ?? '—'}
                </>],
              ['Target interviews',
                <>
                  <b>{d.counts.interviews}</b> / {p.targetInterviews ?? '—'}
                </>],
              ['Target hires',
                <>
                  <b>{d.counts.hires}</b> / {p.targetHires ?? '—'}
                </>],
              ['Daily / weekly submissions',
                `${p.dailySubmissions ?? '—'} / ${p.weeklySubmissions ?? '—'}`],
            ]} />
            {p.notes && (
              <div className="ts-note" style={{ marginTop: 10 }}>
                <b>Notes</b>
                <div>{p.notes}</div>
              </div>
            )}
          </div>
        );
      })()}
    </Card>
  );
}

/* ---------------- the page ---------------- */

export function JobOrderPage({ id, back }: { id: string; back: () => void }) {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const { data: d, loading } = useJobOrder(id);
  const update = useUpdateJobOrder();

  if (!d) {
    return (
      <EmptyState icon="📋"
        msg={loading ? 'Loading the job order…' : 'That job order could not be found'} />
    );
  }

  const r = d.order;
  const client = clientOf(r.clientId);
  const canEdit = app.role !== 'employee';

  const setStatus = async (status: typeof r.status) => {
    try {
      await update.mutate(r.id, { status: status as 'Draft' | 'Open' });
      app.toast(`Job order ${status.toLowerCase()}`, 'ok');
    } catch (e) {
      app.toast(msg(e, 'Could not change the status'), 'err');
    }
  };

  const logActivity = () => layer.modal({
    title: 'Log activity',
    sub: `${jobNo(r)} · ${r.title}`,
    size: 'narrow',
    body: (close) => <LogForm id={r.id} close={close} />,
    footer: null,
  });

  return (
    <div className="stack">
      <PageActions>
        <button className="btn" onClick={back}>← All job orders</button>
        {canEdit && <button className="btn" onClick={logActivity}>Log activity</button>}
        {canEdit && r.status === 'Draft' && (
          <button className="btn primary" onClick={() => setStatus('Open')}>Open this order</button>
        )}
      </PageActions>

      {/* ---- §9: the order's identity ---- */}
      <div className="card jo-head">
        <div className="jo-head-l">
          <div className="mono muted" style={{ fontSize: 12, fontWeight: 700 }}>
            Job Order #{jobNo(r)}
          </div>
          <h2 className="jo-h">{r.title}</h2>
          <div className="jo-sub">
            <Link to="/clients">{client.name}</Link>
            {r.sowId && sowOf(r.sowId) && <> · {sowOf(r.sowId)!.title}</>}
            {' · '}{r.location}
          </div>
          <div className="row" style={{ gap: 7, marginTop: 9, flexWrap: 'wrap' }}>
            <Badge kind={r.status === 'Open' ? 'good' : r.status === 'Draft' ? 'mute' : 'info'}>
              {r.status}
            </Badge>
            <PriorityBadge p={r.priority} />
            <SlaBadge sla={d.sla} detail />
            <Chip>{r.jobType}</Chip>
            <Chip>{r.employmentType}</Chip>
            <Chip>{r.workMode}</Chip>
          </div>
        </div>
        <div className="jo-head-r">
          <div><span>Days open</span><b>{d.sla.daysOpen}</b></div>
          <div><span>Target fill</span><b>{fmtDS(r.targetFillOn)}</b></div>
          <div><span>Positions</span><b>{r.filled} / {r.positions}</b></div>
          <div><span>Recruiter</span><b>{r.recruiterId ? dir.name(r.recruiterId) : '—'}</b></div>
        </div>
      </div>

      {d.sla.state === 'Overdue' && (
        <Banner kind="warn" icon="⚠"
          title={`Behind on ${d.sla.behind}`}>
          This order is {d.sla.aging} {d.sla.aging === 1 ? 'day' : 'days'} past its fill target
          and has been open for {d.sla.daysOpen}.
        </Banner>
      )}

      <StatRow cols={4}>
        <Tile label="Sourced" value={d.counts.sourced} foot="Candidates found" />
        <Tile label="Submissions" value={d.counts.submissions}
          foot={`${clientOf(r.clientId).name} reads ${r.maxSubmissions}`} />
        <Tile label="Interviews" value={d.counts.interviews} foot="With the client" />
        <Tile label="Hires" value={d.counts.hires} foot={`${r.positions} needed`} />
      </StatRow>

      <div className="grid g-2-1">
        <div className="stack">
          {/* ---- §10: the activity tracker ---- */}
          <Card title="Activity tracker"
            sub={`${d.activity.length} events · newest first`}
            actions={canEdit
              ? <button className="btn sm" onClick={logActivity}>+ Log activity</button>
              : undefined}>
            <Timeline rows={d.activity} />
          </Card>
        </div>

        <div className="stack">
          <Desk d={d} canEdit={canEdit} />

          {/* ---- §7: the SLA ---- */}
          <Card title="Recruitment SLA" sub={`${r.slaDays}-day service level`}>
            <KV rows={[
              ['Job open date', fmtD(r.openedOn)],
              ['Target submission', <SlaLine on={r.targetSubmitOn} done={d.counts.submissions > 0} />],
              ['Target interview', <SlaLine on={r.targetInterviewOn} done={d.counts.interviews > 0} />],
              ['Target fill', <SlaLine on={r.targetFillOn} done={d.counts.hires >= r.positions} />],
              ['SLA days', r.slaDays],
              ['Days open', d.sla.daysOpen],
              ['Days remaining', d.sla.state === 'Closed' ? '—' : d.sla.daysRemaining],
              ['Aging', d.sla.aging ? `${d.sla.aging} days over` : '—'],
            ]} />
          </Card>

          {/* ---- §6: the commercials ---- */}
          <Card title="Commercial information">
            <KV rows={[
              ['Bill rate', <b>{money(r.billRate, r.ccy)} <span className="muted">{rateUnit(r)}</span></b>],
              ['Pay rate', r.payRate ? `${money(r.payRate, r.ccy)} ${rateUnit(r)}` : '—'],
              ['Markup', r.markupPct !== null ? `${r.markupPct}%` : '—'],
              ['Salary range', r.salaryMin !== null && r.salaryMax !== null
                ? <Commercials r={r} /> : '—'],
              ['Currency', r.ccy],
              ['Contract duration', r.duration],
              ['Client PO / SOW', r.poNumber ?? (r.sowId && sowOf(r.sowId)?.po) ?? '—'],
              ['Vendor / MSP', r.vendorId ? vendorOf(r.vendorId)?.name ?? '—' : '—'],
              ['VMS platform', r.vms ?? 'Direct'],
              ['Account manager', dir.name(r.accountManagerId)],
              ['Sales owner', dir.name(r.salesOwnerId)],
            ]} />
          </Card>

          {/* ---- §5: the job itself ---- */}
          <Card title="Job details">
            {r.description && (
              <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.55 }}>{r.description}</p>
            )}
            <KV rows={[
              ['Required skills', r.skills.length
                ? <span>{r.skills.map((k) => <Chip key={k}>{k}</Chip>)}</span> : '—'],
              ['Preferred skills', r.preferredSkills.length
                ? <span>{r.preferredSkills.map((k) => <Chip key={k}>{k}</Chip>)}</span> : '—'],
              ['Primary technology', r.primaryTech || '—'],
              ['Experience', r.expMin || r.expMax ? `${r.expMin}–${r.expMax} years` : '—'],
              ['Education', r.education || '—'],
              ['Certifications', r.certifications.length ? r.certifications.join(', ') : '—'],
              ['Industry', r.industry],
              ['Positions', r.positions],
              ['Location', r.location],
              ['Work mode', r.workMode],
              ['Work authorisation', r.workAuth || '—'],
              ['Shift', r.shift],
              ['Start date', fmtD(r.startOn)],
              ['Target end date', r.endOn ? fmtD(r.endOn) : '—'],
              ['Target closure', fmtD(r.targetFillOn)],
            ]} />
          </Card>
        </div>
      </div>
    </div>
  );
}

/** A target date, and whether the work it was for has happened. */
function SlaLine({ on, done }: { on: string; done: boolean }) {
  const late = !done && on < new Date().toISOString().slice(0, 10);
  return (
    <span className={late ? 'sla-over' : undefined}>
      {fmtD(on)}
      {done ? ' ✓' : late ? ' — missed' : ''}
    </span>
  );
}
