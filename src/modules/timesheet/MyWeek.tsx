/**
 * My timesheet — a week, read a day at a time.
 *
 * The database already stores one row per project per task per day; the
 * seven-wide grid was a presentation choice laid over it. This view shows the
 * storage as it actually is, which is also how people describe their week:
 * "Tuesday, eight hours, Meridian, feature design."
 *
 * **Every day of the week gets a line, including the empty ones.** A weekend
 * with no hours is a fact about the week, and a table that silently omits it
 * makes a missing Wednesday look identical to a Wednesday off.
 *
 * **Status is the sheet's, not the line's.** A week is submitted and approved
 * as one thing — that is what an approver acts on — so every line carries the
 * same badge. Showing a different status per line would suggest days can be
 * approved individually, which they cannot.
 */

import { useMemo, useState } from 'react';
import type { Timesheet } from '../../services';
import { addDays, DOW, fmtD, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { projOf, PROJECTS, TASK_TYPES } from '../../data/org';
import { Badge, Banner, Card, EmptyState, KV, StatRow, Tile } from '../../components/ui';
import { StatusBadge } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import {
  useAddRow, useRecallSheet, useSetEntryNote, useSetHours, useSheet, useSubmitSheet,
} from './data';

/** A day's worth of one project and task — the shape the table renders. */
interface Entry {
  rowIndex: number;
  dayIndex: number;
  date: string;
  proj: string;
  task: string;
  hours: number;
  note: string;
  billable: boolean;
}

/** The contracted week. Anything past this is overtime, and is labelled so. */
const STANDARD_WEEK = 40;

/** Flatten the stored grid into one line per day per project and task. */
export function entriesOf(t: Timesheet): Entry[] {
  const out: Entry[] = [];
  t.rows.forEach((row, rowIndex) => {
    row.h.forEach((hours, dayIndex) => {
      if (!hours) return;
      out.push({
        rowIndex,
        dayIndex,
        date: ymd(addDays(parseYmd(t.weekStart), dayIndex)),
        proj: row.proj,
        task: row.task,
        hours,
        note: row.notes[dayIndex] ?? '',
        billable: projOf(row.proj).billable,
      });
    });
  });
  return out.sort((a, b) => a.dayIndex - b.dayIndex || a.proj.localeCompare(b.proj));
}

/** Total, billable, non-billable and overtime for a week. */
export function weekSummary(entries: Entry[]) {
  const total = entries.reduce((n, e) => n + e.hours, 0);
  const billable = entries.filter((e) => e.billable).reduce((n, e) => n + e.hours, 0);
  return {
    total,
    billable,
    nonBillable: total - billable,
    /* Overtime is the excess over the contracted week, never a negative. */
    overtime: Math.max(0, total - STANDARD_WEEK),
  };
}

const hrs = (n: number) => n.toFixed(2);

export function MyWeek({ ws, setWs }: { ws: string; setWs: (s: string) => void }) {
  const app = useApp();
  const layer = useLayer();
  const { data: sheet } = useSheet(app.meId, ws);

  const addRow = useAddRow();
  const setHours = useSetHours();
  const setNote = useSetEntryNote();
  const submit = useSubmitSheet();
  const recall = useRecallSheet();

  const [proj, setProj] = useState('');
  const [task, setTask] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const entries = useMemo(() => (sheet ? entriesOf(sheet) : []), [sheet]);
  const summary = useMemo(() => weekSummary(entries), [entries]);

  if (!sheet) return <EmptyState msg="Loading your week…" />;

  const editable = sheet.status === 'Draft' || sheet.status === 'Rejected';

  /* Filters narrow what is listed; the week's totals stay the week's. */
  const shown = entries.filter((e) =>
    (!proj || e.proj === proj)
    && (!task || e.task === task)
    && (!status || sheet.status === status)
    && (!q.trim() || (projOf(e.proj).name + ' ' + e.task + ' ' + e.note)
      .toLowerCase().includes(q.trim().toLowerCase())));

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = ymd(addDays(parseYmd(ws), i));
    return { i, date, dow: DOW[parseYmd(date).getDay()], lines: shown.filter((e) => e.dayIndex === i) };
  });

  const logHours = () => layer.modal({
    title: 'Log hours',
    sub: `Week of ${fmtD(ws)}`,
    body: (close) => <LogForm sheet={sheet} close={close} />,
  });

  const removeEntry = async (e: Entry) => {
    try {
      await setHours.mutate(sheet.id, e.rowIndex, e.dayIndex, 0);
      app.toast('Entry removed', 'ok');
    } catch (err) {
      app.toast(err instanceof Error ? err.message : 'Could not remove it', 'err');
    }
  };

  const editNote = async (e: Entry) => {
    const said = window.prompt('What were these hours for?', e.note);
    if (said === null) return;
    try {
      await setNote.mutate(sheet.id, e.rowIndex, e.dayIndex, said);
    } catch (err) {
      app.toast(err instanceof Error ? err.message : 'Could not save the note', 'err');
    }
  };

  function LogForm({ sheet: t, close }: { sheet: Timesheet; close: () => void }) {
    const [d, setD] = useState(0);
    const [p, setP] = useState(PROJECTS[0].id);
    const [k, setK] = useState(TASK_TYPES[0]);
    const [h, setH] = useState('8');
    const [n, setN] = useState('');

    const save = async () => {
      const hours = Number(h);
      if (!Number.isFinite(hours) || hours <= 0) { app.toast('Enter the hours', 'err'); return; }
      try {
        /*
         * A project and task pair is one stored row across the week, so log
         * against the existing one when there is one rather than creating a
         * duplicate the storage would refuse anyway.
         */
        let idx = t.rows.findIndex((r) => r.proj === p && r.task === k);
        if (idx < 0) {
          const after = await addRow.mutate(t.id, p, k);
          idx = after.rows.findIndex((r) => r.proj === p && r.task === k);
        }
        await setHours.mutate(t.id, idx, d, hours);
        if (n.trim()) await setNote.mutate(t.id, idx, d, n.trim());
        app.toast('Hours logged', 'ok');
        close();
      } catch (err) {
        app.toast(err instanceof Error ? err.message : 'Could not log the hours', 'err');
      }
    };

    return (
      <div className="stack">
        <label className="fld">
          <span>Day</span>
          <select className="input" value={d} onChange={(e) => setD(Number(e.target.value))}>
            {Array.from({ length: 7 }, (_, i) => {
              const date = ymd(addDays(parseYmd(t.weekStart), i));
              return <option key={i} value={i}>{DOW[parseYmd(date).getDay()]} · {fmtD(date)}</option>;
            })}
          </select>
        </label>
        <label className="fld">
          <span>Project</span>
          <select className="input" value={p} onChange={(e) => setP(e.target.value)}>
            {PROJECTS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}{x.billable ? '' : ' · non-billable'}
              </option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>Task</span>
          <select className="input" value={k} onChange={(e) => setK(e.target.value)}>
            {TASK_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Hours</span>
          <input className="input" type="number" min="0" max="24" step="0.25"
            value={h} onChange={(e) => setH(e.target.value)} />
        </label>
        <label className="fld">
          <span>Notes</span>
          <input className="input" value={n} placeholder="Kickoff call with client"
            onChange={(e) => setN(e.target.value)} />
        </label>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={save}>Log hours</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn icon" title="Previous week"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), -7)))}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 13.5, minWidth: 200, textAlign: 'center' }}>
          {fmtD(ws)} – {fmtD(ymd(addDays(parseYmd(ws), 6)))}
        </div>
        <button className="btn icon" title="Next week"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), 7)))}>›</button>
        <button className="btn sm" onClick={() => setWs(ymd(mondayOf(TODAY)))}>This week</button>

        <select className="input sm" value={proj} onChange={(e) => setProj(e.target.value)}>
          <option value="">All projects</option>
          {PROJECTS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input sm" value={task} onChange={(e) => setTask(e.target.value)}>
          <option value="">All tasks</option>
          {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['Draft', 'Submitted', 'Approved', 'Rejected'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <div className="spacer" />
        <input className="input sm" style={{ width: 210 }} value={q}
          placeholder="Search by project or task…" onChange={(e) => setQ(e.target.value)} />
        {editable && <button className="btn primary sm" onClick={logHours}>+ Log hours</button>}
      </div>

      <div className="grid g-2-1">
        <Card title="Timesheet" sub={`${entries.length} entries this week`} flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Day</th><th>Project</th><th>Task</th>
                  <th className="num">Hours</th><th>Status</th><th>Notes</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (d.lines.length ? d.lines.map((e, k) => (
                  <tr key={`${d.i}-${e.rowIndex}`}>
                    <td className="nowrap">{k === 0 ? fmtD(e.date) : ''}</td>
                    <td className="nowrap">{k === 0 ? d.dow : ''}</td>
                    <td>
                      {projOf(e.proj).name}
                      {!e.billable && <div className="muted" style={{ fontSize: 11 }}>Non-billable</div>}
                    </td>
                    <td>{e.task}</td>
                    <td className="num strong">{hrs(e.hours)}</td>
                    <td><StatusBadge status={sheet.status} /></td>
                    <td className="muted" style={{ maxWidth: 220 }}>{e.note || '—'}</td>
                    <td className="right nowrap">
                      {editable ? (
                        <>
                          <button className="btn ghost icon sm" title="Edit the note"
                            onClick={() => editNote(e)}>✎</button>
                          <button className="btn ghost icon sm" title="Remove this entry"
                            onClick={() => removeEntry(e)}>🗑</button>
                        </>
                      ) : <span className="muted">—</span>}
                    </td>
                  </tr>
                )) : (
                  <tr key={d.i} className="muted">
                    <td className="nowrap">{fmtD(d.date)}</td>
                    <td className="nowrap">{d.dow}</td>
                    <td>—</td><td>—</td>
                    <td className="num">0.00</td>
                    <td>—</td><td>—</td><td className="right">—</td>
                  </tr>
                )))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={4} className="right">Total hours</th>
                  <th className="num">{hrs(summary.total)}</th>
                  <th colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        <div className="stack">
          <StatRow cols={3}>
            <Tile icon="⏱" label="Total" value={hrs(summary.total)} foot="Hours this week" />
            <Tile icon="💼" label="Billable" value={hrs(summary.billable)} foot="Charged to a client" />
            <Tile icon="⚡" label="Overtime" value={hrs(summary.overtime)}
              foot={`Beyond ${STANDARD_WEEK} h`} />
          </StatRow>

          <Card title="Weekly summary" sub="Against the contracted week">
            <KV rows={[
              ['Total hours', <b>{hrs(summary.total)}</b>],
              ['Billable hours', hrs(summary.billable)],
              ['Non-billable hours', hrs(summary.nonBillable)],
              ['Overtime hours', hrs(summary.overtime)],
            ]} />
          </Card>

          <Card title="Submission status">
            <div className="row" style={{ gap: 9, alignItems: 'center', marginBottom: 10 }}>
              <StatusBadge status={sheet.status} />
              {sheet.submittedOn && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Submitted {fmtD(sheet.submittedOn)}
                </span>
              )}
            </div>

            {sheet.status === 'Rejected' && sheet.note && (
              <Banner kind="warn" icon="↩︎" title="Returned">{sheet.note}</Banner>
            )}

            {sheet.status === 'Draft' && (
              <button className="btn primary" style={{ width: '100%' }}
                disabled={!summary.total}
                onClick={async () => {
                  try {
                    await submit.mutate(sheet.id);
                    app.toast('Timesheet submitted', 'ok');
                  } catch (e) {
                    app.toast(e instanceof Error ? e.message : 'Could not submit', 'err');
                  }
                }}>
                {summary.total ? 'Submit timesheet' : 'Log some hours first'}
              </button>
            )}

            {sheet.status === 'Submitted' && (
              <button className="btn" style={{ width: '100%' }}
                onClick={async () => {
                  try {
                    await recall.mutate(sheet.id);
                    app.toast('Timesheet recalled — you can edit it again', 'ok');
                  } catch (e) {
                    app.toast(e instanceof Error ? e.message : 'Could not recall it', 'err');
                  }
                }}>Recall for editing</button>
            )}

            {sheet.status === 'Rejected' && (
              <button className="btn primary" style={{ width: '100%' }}
                onClick={async () => {
                  try {
                    await submit.mutate(sheet.id);
                    app.toast('Timesheet resubmitted', 'ok');
                  } catch (e) {
                    app.toast(e instanceof Error ? e.message : 'Could not resubmit', 'err');
                  }
                }}>Resubmit timesheet</button>
            )}

            {sheet.status === 'Approved' && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Approved — this week is closed and can no longer be edited.
              </div>
            )}
          </Card>

          <Card title="Where the week went" flush>
            {entries.length ? (
              <div style={{ padding: '4px 0' }}>
                {Object.entries(entries.reduce<Record<string, number>>((acc, e) => {
                  acc[e.proj] = (acc[e.proj] ?? 0) + e.hours;
                  return acc;
                }, {})).sort((a, b) => b[1] - a[1]).map(([id, h]) => (
                  <div key={id} style={{ padding: '7px 14px' }}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span>{projOf(id).name}</span>
                      <b>{hrs(h)}</b>
                    </div>
                    <div className="bar" style={{ marginTop: 5 }}>
                      <i style={{
                        width: (summary.total ? (h / summary.total) * 100 : 0) + '%',
                        background: projOf(id).color,
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : <EmptyState msg="Nothing logged yet this week" icon="⏱" />}
          </Card>

          {!editable && sheet.status !== 'Approved' && (
            <Badge kind="info">Submitted sheets cannot be edited until recalled</Badge>
          )}
        </div>
      </div>
    </div>
  );
}
