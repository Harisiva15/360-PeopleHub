/**
 * Timesheet entry — one week, one line per piece of work.
 *
 * A timesheet is a list of entries, not a grid. One entry is one project, one
 * task, one day, and it carries its own `billable` flag: consulting weeks
 * routinely have client work in the morning and an internal standup in the
 * afternoon on the same project, which the old seven-wide grid could not say
 * because billability came off the project.
 *
 * **Totals are never computed here.** Every write returns the whole sheet with
 * `total`, `billable` and `nonBillable` already recomputed by the service. A
 * client that adds up its own hours will eventually disagree with the figure
 * the approver sees, and the approver's is the one that gets paid.
 *
 * **A new line is local until it is valid.** The service refuses an entry
 * without a project, a task, a day inside the week and a number of hours, so
 * "Add row" cannot mean "create an empty entry". It puts a draft row in the
 * table; the row becomes a real entry when it is saved. That is why draft rows
 * carry a Save button and stored rows do not.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntryDraft, Timesheet, TSEntry } from '../../services';
import { addDays, DOW, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { projOf, PROJECTS, TASK_TYPES } from '../../data/org';
import { Avatar, Badge, Banner, Card, EmptyState, KV } from '../../components/ui';
import { Donut, Legend } from '../../components/charts';
import { StatusBadge } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import {
  useAddEntry, useCopyPreviousWeek, useRecallSheet, useRemoveEntry, useSetComment,
  useSheet, useSubmitSheet, useUpdateEntry,
} from './data';
import { Icon } from '../../components/icons';

/** The contracted week. Anything past this is overtime, and is labelled so. */
export const STANDARD_WEEK = 40;

const hrs = (n: number) => n.toFixed(2);
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** The seven days of a week, as dates with their weekday names. */
export function weekDays(weekStart: string) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(parseYmd(weekStart), i);
    return { i, date: ymd(d), dow: DOW[d.getDay()], weekend: d.getDay() === 0 || d.getDay() === 6 };
  });
}

/** Overtime is the excess over the contracted week, never a negative. */
export const overtimeOf = (total: number) => Math.max(0, total - STANDARD_WEEK);

/* ---------------- one editable line ---------------- */

/** The fields a line exposes for editing — the draft shape, fully filled in. */
type Line = Required<EntryDraft>;

const lineOf = (e: TSEntry): Line => ({
  date: e.date, proj: e.proj, task: e.task,
  billable: e.billable, hours: e.hours, remarks: e.remarks,
});

const same = (a: Line, b: Line) =>
  a.date === b.date && a.proj === b.proj && a.task === b.task
  && a.billable === b.billable && a.hours === b.hours && a.remarks === b.remarks;

type Days = ReturnType<typeof weekDays>;

/**
 * The cells shared by a stored line and a draft one. Kept at module scope so
 * the inputs keep their DOM nodes between renders — an inline component would
 * remount on every keystroke and drop the caret.
 */
function LineCells({
  v, set, days, disabled, onCommit,
}: {
  v: Line;
  set: (patch: Partial<Line>) => void;
  days: Days;
  disabled?: boolean;
  /** Called when a field is finished with — blur for typing, change for the rest. */
  onCommit: (patch: Partial<Line>) => void;
}) {
  const p = projOf(v.proj);
  const dow = /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? DOW[parseYmd(v.date).getDay()] : '—';

  return (
    <>
      <td className="nowrap">
        <select className="input sm" aria-label="Date" value={v.date} disabled={disabled}
          onChange={(e) => { set({ date: e.target.value }); onCommit({ date: e.target.value }); }}>
          {days.map((d) => <option key={d.date} value={d.date}>{fmtDS(d.date)}</option>)}
        </select>
      </td>
      <td className="nowrap muted">{dow}</td>
      <td>
        <select className="input sm" aria-label="Project" value={v.proj} disabled={disabled}
          onChange={(e) => {
            /* Billability defaults from the project, and stays overridable. */
            const next = { proj: e.target.value, billable: projOf(e.target.value).billable };
            set(next);
            onCommit(next);
          }}>
          {PROJECTS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{p.client}</div>
      </td>
      <td>
        <input className="input sm" aria-label="Task or activity" list="ts-tasks"
          value={v.task} disabled={disabled} placeholder="What was the work?"
          onChange={(e) => set({ task: e.target.value })}
          onBlur={(e) => onCommit({ task: e.target.value })} />
      </td>
      <td className="center">
        <input type="checkbox" aria-label="Billable" checked={v.billable} disabled={disabled}
          onChange={(e) => { set({ billable: e.target.checked }); onCommit({ billable: e.target.checked }); }} />
      </td>
      <td className="num">
        <input className="input sm hrs" type="number" aria-label="Hours"
          min="0" max="24" step="0.25" value={v.hours} disabled={disabled}
          onChange={(e) => set({ hours: e.target.value === '' ? 0 : Number(e.target.value) })}
          onBlur={(e) => onCommit({ hours: e.target.value === '' ? 0 : Number(e.target.value) })} />
      </td>
      <td>
        <input className="input sm" aria-label="Remarks" value={v.remarks} disabled={disabled}
          placeholder="Optional"
          onChange={(e) => set({ remarks: e.target.value })}
          onBlur={(e) => onCommit({ remarks: e.target.value })} />
      </td>
    </>
  );
}

function StoredRow({
  sheet, entry, days, editable,
}: {
  sheet: Timesheet; entry: TSEntry; days: Days; editable: boolean;
}) {
  const app = useApp();
  const update = useUpdateEntry();
  const remove = useRemoveEntry();

  const [v, setV] = useState<Line>(() => lineOf(entry));
  const [err, setErr] = useState('');

  /*
   * Re-sync only when the *server's* values actually changed. Every mutation
   * anywhere refetches every query, so a blind sync would wipe out whatever
   * somebody was halfway through typing in this row.
   */
  const seen = useRef<Line>(lineOf(entry));
  useEffect(() => {
    const next = lineOf(entry);
    if (!same(next, seen.current)) { seen.current = next; setV(next); }
  }, [entry]);

  const commit = async (patch: Partial<Line>) => {
    const next = { ...v, ...patch };
    if (same(next, seen.current)) return;
    try {
      await update.mutate(sheet.id, entry.id, patch);
      seen.current = next;
      setErr('');
    } catch (e) {
      setErr(msg(e, 'Could not save that change'));
      setV(seen.current);          /* put the refused value back */
    }
  };

  const drop = async () => {
    try {
      await remove.mutate(sheet.id, entry.id);
      app.toast('Line removed', 'ok');
    } catch (e) {
      app.toast(msg(e, 'Could not remove it'), 'err');
    }
  };

  return (
    <>
      <tr>
        <LineCells v={v} set={(p) => setV({ ...v, ...p })} days={days}
          disabled={!editable} onCommit={commit} />
        <td className="right nowrap">
          {editable
            ? <button className="btn ghost icon sm" title="Remove this line"
              aria-label="Remove this line" onClick={drop}><Icon n="remove" size="lg" /> </button>
            : <span className="muted">—</span>}
        </td>
      </tr>
      {err && <tr className="ts-err"><td colSpan={8}><Icon n="warn" size="lg" /> {err}</td></tr>}
    </>
  );
}

function DraftRow({
  sheet, draft, days, onDone, onDrop,
}: {
  sheet: Timesheet;
  draft: { key: number; line: Line };
  days: Days;
  onDone: (key: number) => void;
  onDrop: (key: number) => void;
}) {
  const app = useApp();
  const add = useAddEntry();
  const [v, setV] = useState<Line>(draft.line);
  const [err, setErr] = useState('');

  const save = async () => {
    try {
      await add.mutate(sheet.id, v);
      app.toast('Line added', 'ok');
      onDone(draft.key);
    } catch (e) {
      setErr(msg(e, 'Could not add that line'));
    }
  };

  return (
    <>
      <tr className="ts-draft">
        <LineCells v={v} set={(p) => setV({ ...v, ...p })} days={days} onCommit={() => setErr('')} />
        <td className="right nowrap">
          <button className="btn primary sm" disabled={add.pending} onClick={save}>Save</button>{' '}
          <button className="btn ghost icon sm" title="Discard this line"
            aria-label="Discard this line" onClick={() => onDrop(draft.key)}>✕</button>
        </td>
      </tr>
      {err && <tr className="ts-err"><td colSpan={8}><Icon n="warn" size="lg" /> {err}</td></tr>}
    </>
  );
}

/* ---------------- bulk entry ---------------- */

function BulkForm({ sheet, close }: { sheet: Timesheet; close: () => void }) {
  const app = useApp();
  const add = useAddEntry();
  const days = weekDays(sheet.weekStart);

  const [proj, setProj] = useState(PROJECTS[0].id);
  const [task, setTask] = useState(TASK_TYPES[0]);
  const [billable, setBillable] = useState(PROJECTS[0].billable);
  const [hours, setHours] = useState('8');
  const [remarks, setRemarks] = useState('');
  const [picked, setPicked] = useState<string[]>(days.filter((d) => !d.weekend).map((d) => d.date));
  const [err, setErr] = useState('');

  const toggle = (date: string) =>
    setPicked((s) => (s.includes(date) ? s.filter((x) => x !== date) : [...s, date]));

  const apply = async () => {
    const h = Number(hours);
    if (!picked.length) { setErr('Pick at least one day'); return; }
    if (!Number.isFinite(h) || h <= 0) { setErr('Enter the hours'); return; }
    /*
     * One call per day rather than one batched call: the service applies the
     * daily and weekly limits per entry, so a day that would overflow has to
     * be refused on its own without taking the rest of the week with it.
     */
    const failed: string[] = [];
    for (const date of picked.slice().sort()) {
      try {
        await add.mutate(sheet.id, { date, proj, task, billable, hours: h, remarks });
      } catch (e) {
        failed.push(`${fmtDS(date)}: ${msg(e, 'refused')}`);
      }
    }
    if (failed.length) { setErr(failed.join(' · ')); return; }
    app.toast(`${picked.length} lines added`, 'ok');
    close();
  };

  return (
    <div className="stack">
      <div className="field">
        <label>Days</label>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {days.map((d) => (
            <button key={d.date} type="button"
              className={'chip x' + (picked.includes(d.date) ? ' on' : '')}
              aria-pressed={picked.includes(d.date)}
              onClick={() => toggle(d.date)}>{d.dow} {fmtDS(d.date)}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Project</label>
        <select className="input" value={proj}
          onChange={(e) => { setProj(e.target.value); setBillable(projOf(e.target.value).billable); }}>
          {PROJECTS.map((p) => (
            <option key={p.id} value={p.id}>{p.name} · {p.client}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Task or activity</label>
        <input className="input" list="ts-tasks" value={task}
          onChange={(e) => setTask(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Hours per day</label>
          <input className="input" type="number" min="0" max="24" step="0.25"
            value={hours} onChange={(e) => setHours(e.target.value)} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Billable</label>
          <label className="row" style={{ gap: 7, alignItems: 'center', height: 36 }}>
            <input type="checkbox" checked={billable}
              onChange={(e) => setBillable(e.target.checked)} />
            <span className="muted" style={{ fontSize: 12.5 }}>Charge to the client</span>
          </label>
        </div>
      </div>
      <div className="field">
        <label>Remarks</label>
        <input className="input" value={remarks} placeholder="Optional"
          onChange={(e) => setRemarks(e.target.value)} />
      </div>

      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not everything went in">{err}</Banner>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={add.pending} onClick={apply}>
          Add {picked.length} {picked.length === 1 ? 'line' : 'lines'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- the week ---------------- */

export function MyWeek({ ws, setWs }: { ws: string; setWs: (s: string) => void }) {
  const app = useApp();
  const layer = useLayer();
  const { data: sheet, loading } = useSheet(app.meId, ws);

  const copyPrev = useCopyPreviousWeek();
  const setComment = useSetComment();
  const submit = useSubmitSheet();
  const recall = useRecallSheet();

  const [drafts, setDrafts] = useState<{ key: number; line: Line }[]>([]);
  /* What is in the box, and what the service last confirmed — the gap is "unsaved". */
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const draftSeq = useRef(0);

  /* Drafts belong to the week they were started in. */
  useEffect(() => { setDrafts([]); }, [ws]);

  useEffect(() => {
    if (sheet && sheet.note !== savedNote) { setSavedNote(sheet.note); setNote(sheet.note); }
  }, [sheet, savedNote]);

  const days = useMemo(() => weekDays(ws), [ws]);

  if (!sheet) {
    return <EmptyState msg={loading ? 'Loading your week…' : 'That week could not be loaded'} />;
  }

  const editable = sheet.status === 'Draft' || sheet.status === 'Returned';
  const overtime = overtimeOf(sheet.total);

  /* The first day with nothing on it — where somebody is most likely to type next. */
  const nextDay = days.find((d) => !sheet.entries.some((e) => e.date === d.date))?.date ?? days[0].date;

  const addRow = () => {
    const p = PROJECTS[0];
    draftSeq.current += 1;
    setDrafts((d) => [...d, {
      key: draftSeq.current,
      line: { date: nextDay, proj: p.id, task: '', billable: p.billable, hours: 8, remarks: '' },
    }]);
  };

  const doCopy = async () => {
    try {
      await copyPrev.mutate(sheet.id);
      app.toast("Last week's lines copied across", 'ok');
    } catch (e) {
      app.toast(msg(e, 'Could not copy the previous week'), 'err');
    }
  };

  const saveNote = async () => {
    if (note === savedNote) return;
    try {
      await setComment.mutate(sheet.id, note);
      setSavedNote(note);
    } catch (e) {
      app.toast(msg(e, 'Could not save the comment'), 'err');
    }
  };

  const doSubmit = async () => {
    try {
      await submit.mutate(sheet.id);
      app.toast('Timesheet submitted for approval', 'ok');
    } catch (e) {
      app.toast(msg(e, 'Could not submit'), 'err');
    }
  };

  const confirmSubmit = () => layer.modal({
    title: 'Submit for approval',
    sub: `${fmtD(ws)} – ${fmtD(ymd(addDays(parseYmd(ws), 6)))}`,
    size: 'narrow',
    body: (
      <div className="stack">
        <p style={{ margin: 0, fontSize: 13.5 }}>
          Your manager will see this week as it stands. You can recall it while it is
          still waiting on them.
        </p>
        <KV rows={[
          ['Lines', sheet.entries.length],
          ['Total hours', <b>{hrs(sheet.total)}</b>],
          ['Billable', hrs(sheet.billable)],
          ['Non-billable', hrs(sheet.nonBillable)],
          ...(overtime ? [['Overtime', hrs(overtime)] as [string, string]] : []),
        ]} />
        {drafts.length > 0 && (
          <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Unsaved lines">
            {drafts.length} {drafts.length === 1 ? 'line has' : 'lines have'} not been saved,
            and will not be submitted.
          </Banner>
        )}
      </div>
    ),
    footer: (close) => (
      <>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={submit.pending}
          onClick={async () => { await doSubmit(); close(); }}>Submit for approval</button>
      </>
    ),
  });

  const bulk = () => layer.modal({
    title: 'Bulk entry',
    sub: 'The same work across several days',
    body: (close) => <BulkForm sheet={sheet} close={close} />,
    footer: null,
  });

  const slices = [
    { k: 'Billable', v: sheet.billable, c: 'var(--brand)' },
    { k: 'Non-billable', v: sheet.nonBillable, c: 'var(--good)' },
  ];

  return (
    <div className="stack">
      {/* every task box on the page offers the same suggestions */}
      <datalist id="ts-tasks">
        {TASK_TYPES.map((t) => <option key={t} value={t} />)}
      </datalist>

      {/* ---- who, and how the week stands ---- */}
      <div className="card ts-who">
        <div className="ts-who-p">
          <Avatar name={app.me.name} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div className="ts-who-n">{app.me.name}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>{app.me.designation}</div>
            <div className="muted mono" style={{ fontSize: 11.5, marginTop: 2 }}>{app.me.code}</div>
          </div>
        </div>
        <div className="ts-who-m">
          <div><span>Total hours</span><b>{hrs(sheet.total)}</b></div>
          <div><span>Billable</span><b>{hrs(sheet.billable)}</b></div>
          <div><span>Non-billable</span><b>{hrs(sheet.nonBillable)}</b></div>
          <div><span>Overtime</span><b>{hrs(overtime)}</b></div>
          <div><span>Status</span><StatusBadge status={sheet.status} /></div>
        </div>
      </div>

      {/*
        * The week's one primary action goes up into the page header, where
        * every module's does. The week navigator and the two secondary
        * actions stay with the table they act on.
        */}
      <PageActions>
        {editable && (
          <button className="btn primary" disabled={!sheet.total || submit.pending}
            onClick={confirmSubmit}>Submit for approval</button>
        )}
        {sheet.status === 'Submitted' && (
          <button className="btn" disabled={recall.pending} onClick={async () => {
            try {
              await recall.mutate(sheet.id);
              app.toast('Recalled — you can edit it again', 'ok');
            } catch (e) {
              app.toast(msg(e, 'Could not recall it'), 'err');
            }
          }}>Recall for editing</button>
        )}
      </PageActions>

      {/* ---- which week ---- */}
      <div className="toolbar">
        <button className="btn icon" title="Previous week" aria-label="Previous week"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), -7)))}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 14, minWidth: 210, textAlign: 'center' }}>
          {fmtD(ws)} – {fmtD(ymd(addDays(parseYmd(ws), 6)))}
        </div>
        <button className="btn icon" title="Next week" aria-label="Next week"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), 7)))}>›</button>
        <button className="btn sm" onClick={() => setWs(ymd(mondayOf(TODAY)))}>This week</button>
        <div className="spacer" />
        {editable && (
          <>
            <button className="btn sm" disabled={copyPrev.pending} onClick={doCopy}><Icon n="swap" size="lg" /> Copy previous week
            </button>
            <button className="btn sm" onClick={bulk}><Icon n="goal" size="lg" /> Bulk entry</button>
          </>
        )}
      </div>

      {sheet.status === 'Returned' && sheet.note && (
        <Banner kind="warn" icon={<Icon n="undo" size="lg" />} title="Returned for correction">{sheet.note}</Banner>
      )}
      {sheet.status === 'Rejected' && sheet.note && (
        <Banner kind="warn" icon={<Icon n="close" size="lg" />} title="Rejected">{sheet.note}</Banner>
      )}
      {sheet.status === 'Approved' && (
        <Banner kind="good" icon={<Icon n="ok" size="lg" />} title="Approved">
          This week is closed. Ask your manager to reopen it if something is wrong.
        </Banner>
      )}

      <div className="grid g-2-1">
        <div className="stack">
          <Card title="Timesheet entry"
            sub={`${sheet.entries.length} ${sheet.entries.length === 1 ? 'line' : 'lines'} this week`}
            flush
            actions={editable
              ? <button className="btn sm" onClick={addRow}>+ Add row</button>
              : undefined}>
            <div className="tbl-wrap">
              <table className="tbl ts-entry">
                <thead>
                  <tr>
                    <th>Date</th><th>Day</th><th>Project / Client</th><th>Task / Activity</th>
                    <th className="center">Billable</th><th className="num">Hours</th>
                    <th>Remarks</th><th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.entries.map((e) => (
                    <StoredRow key={e.id} sheet={sheet} entry={e} days={days} editable={editable} />
                  ))}
                  {drafts.map((d) => (
                    <DraftRow key={d.key} sheet={sheet} draft={d} days={days}
                      onDone={(k) => setDrafts((s) => s.filter((x) => x.key !== k))}
                      onDrop={(k) => setDrafts((s) => s.filter((x) => x.key !== k))} />
                  ))}
                  {!sheet.entries.length && !drafts.length && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState icon={<Icon n="timer" size="lg" />}
                          msg={editable
                            ? 'Nothing logged yet — add a row, or copy last week'
                            : 'No hours were logged this week'} />
                      </td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={5} className="right">Total hours</th>
                    <th className="num">{hrs(sheet.total)}</th>
                    <th colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          <Card title="Comments" sub="Anything your manager should know before approving">
            <textarea className="input" rows={3} value={note} disabled={!editable}
              placeholder="Worked the weekend to close the CareLink release…"
              onChange={(e) => setNote(e.target.value)} onBlur={saveNote} />
            {editable && note !== savedNote && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 5 }}>
                Saved when you click away.
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Weekly summary" sub={`Against the contracted ${STANDARD_WEEK} h week`}>
            <div className="row" style={{ justifyContent: 'center', padding: '4px 0 10px' }}>
              <Donut slices={slices} center={hrs(sheet.total)} centerSub="Hours"
                fmt={(v) => hrs(Number(v)) + ' h'} />
            </div>
            <Legend items={slices.map((s) => ({ k: s.k, c: s.c, v: hrs(s.v) }))} />
            <div style={{ marginTop: 12 }}>
              <KV rows={[
                ['Total hours', <b>{hrs(sheet.total)}</b>],
                ['Billable hours', hrs(sheet.billable)],
                ['Non-billable hours', hrs(sheet.nonBillable)],
                ['Overtime hours', hrs(overtime)],
              ]} />
            </div>
          </Card>

          <Card title="Where the week went" flush>
            {sheet.entries.length ? (
              <div style={{ padding: '4px 0 8px' }}>
                {Object.entries(sheet.entries.reduce<Record<string, number>>((acc, e) => {
                  acc[e.proj] = (acc[e.proj] ?? 0) + e.hours;
                  return acc;
                }, {})).sort((a, b) => b[1] - a[1]).map(([id, h]) => (
                  <div key={id} style={{ padding: '7px 14px' }}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span>{projOf(id).name}</span>
                      <b className="mono">{hrs(h)}</b>
                    </div>
                    <div className="bar" style={{ marginTop: 5 }}>
                      <i style={{
                        width: (sheet.total ? (h / sheet.total) * 100 : 0) + '%',
                        background: projOf(id).color,
                      }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : <EmptyState msg="Nothing logged yet this week" icon={<Icon n="timer" size="lg" />} />}
          </Card>

          <Card title="Submission">
            <div className="row" style={{ gap: 9, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <StatusBadge status={sheet.status} />
              {sheet.submittedOn && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Submitted {fmtD(sheet.submittedOn)}
                </span>
              )}
              {sheet.actedOn && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Decided {fmtD(sheet.actedOn)}
                </span>
              )}
            </div>
            {editable && (
              <button className="btn primary" style={{ width: '100%' }}
                disabled={!sheet.total || submit.pending} onClick={confirmSubmit}>
                {sheet.total ? 'Submit for approval' : 'Log some hours first'}
              </button>
            )}
            {!editable && sheet.status !== 'Approved' && (
              <Badge kind="info">A submitted week cannot be edited until it is recalled</Badge>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
