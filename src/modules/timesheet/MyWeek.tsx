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

import { useEffect, useState } from 'react';
import type { Timesheet, TimesheetProject, TSEntry } from '../../services';
import { addDays, DOW, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { TASK_TYPES } from '../../data/org';
import { Badge, Banner, Card, EmptyState, KV } from '../../components/ui';
import { Donut, Legend, PAL } from '../../components/charts';
import { StatusBadge } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import {
  useAddEntry, useBookableProjects, useCopyPreviousWeek, useRecallSheet, useRemoveEntry,
  useSetComment,
  useSheet, useSubmitSheet,
} from './data';
import { gridDays, rowsOf, WeekGrid } from './WeekGrid';
import type { Row } from './WeekGrid';
import { Icon } from '../../components/icons';


const hrs = (n: number) => n.toFixed(2);
const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** The seven days of a week, as dates with their weekday names. */
export function weekDays(weekStart: string) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(parseYmd(weekStart), i);
    return { i, date: ymd(d), dow: DOW[d.getDay()], weekend: d.getDay() === 0 || d.getDay() === 6 };
  });
}


/* ---------------- bulk entry ---------------- */

function BulkForm({ sheet, close, projects }: {
  sheet: Timesheet; close: () => void; projects: TimesheetProject[];
}) {
  const app = useApp();
  const add = useAddEntry();
  const days = weekDays(sheet.weekStart);

  const [proj, setProj] = useState(projects[0]?.id ?? '');
  const [task, setTask] = useState(TASK_TYPES[0]);
  const [billable, setBillable] = useState(projects[0]?.billable ?? true);
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
          onChange={(e) => {
            setProj(e.target.value);
            setBillable(projects.find((x) => x.id === e.target.value)?.billable ?? true);
          }}>
          {projects.map((p) => (
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

/**
 * What a row can be asked to do.
 *
 * A row is a set of entries sharing a project, a task and a billing flag, so
 * every action here is that set acted on together. Nothing is offered that the
 * service cannot do: there is no rename, because changing a task is changing
 * the key those entries are stored under, which is a delete and an insert and
 * would lose the hours if either half failed.
 */
function RowMenu({ sheet, row, editable, close }: {
  sheet: Timesheet; row: Row; editable: boolean; close: () => void;
}) {
  const app = useApp();
  const remove = useRemoveEntry();
  const [busy, setBusy] = useState(false);

  const entries = row.cells.filter((c): c is TSEntry => c !== null);

  const clearRow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      /* One call per entry — the service has no bulk delete, and inventing
         one on the client would hide a partial failure. */
      for (const e of entries) await remove.mutate(sheet.id, e.id);
      app.toast('Row cleared', 'ok');
      close();
    } catch (e) {
      app.toast(msg(e, 'Could not clear the row'), 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <KV rows={[
        ['Task', row.task],
        ['Billing', row.billable ? 'Billable' : 'Internal'],
        ['Days logged', String(entries.length)],
        ['Row total', hrs(row.total)],
      ]} />

      {entries.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Day</th><th className="num">Hours</th><th>Note</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{fmtD(e.date)}</td>
                  <td className="num">{hrs(e.hours)}</td>
                  <td className="muted">{e.remarks || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        Hours are edited in the grid. A note belongs to one day&rsquo;s entry and is
        shown above; the week&rsquo;s comment to your manager is below the grid.
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Close</button>
        {editable && entries.length > 0 && (
          <button className="btn danger" disabled={busy} onClick={clearRow}>
            {busy
              ? 'Clearing…'
              : `Clear ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
          </button>
        )}
      </div>
    </div>
  );
}


/* ---------------- the week ---------------- */

export function MyWeek({ ws, setWs }: { ws: string; setWs: (s: string) => void }) {
  const app = useApp();
  const layer = useLayer();
  const { data: sheet, loading } = useSheet(app.meId, ws);
  /* Projects come from the API, which is what addEntry validates against. */
  const proj = useBookableProjects();
  const projects = proj.list;

  const copyPrev = useCopyPreviousWeek();
  const setComment = useSetComment();
  const submit = useSubmitSheet();
  const recall = useRecallSheet();

  /* What is in the box, and what the service last confirmed — the gap is "unsaved". */
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');


  useEffect(() => {
    if (sheet && sheet.note !== savedNote) { setSavedNote(sheet.note); setNote(sheet.note); }
  }, [sheet, savedNote]);


  if (!sheet) {
    return <EmptyState msg={loading ? 'Loading your week…' : 'That week could not be loaded'} />;
  }

  const editable = sheet.status === 'Draft' || sheet.status === 'Returned';

  /* Columns and rows for the grid. Rows group the week's entries by
     project, task and billability — see WeekGrid for why all three. */
  const gridCols = gridDays(ws);
  const rows = rowsOf(sheet, gridCols);

  /*
   * What a row offers. Only what the service can actually do: a row is a
   * set of entries, so removing one is removing each of its entries, and
   * there is nothing else to offer that would not be a pretend button.
   */
  const rowMenu = (row: Row) => layer.modal({
    title: proj.name(row.proj),
    sub: `${row.task} · ${row.billable ? 'Billable' : 'Internal'}`,
    size: 'narrow',
    body: (close: () => void) => (
      <RowMenu sheet={sheet} row={row} editable={editable} close={close} />
    ),
    footer: null,
  });



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
        ]} />
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
    body: (close) => <BulkForm sheet={sheet} close={close} projects={projects} />,
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

      {/* ---- the week, and how it stands ---- */}
      <div className="card" style={{ padding: 16 }}>
        <div className="ts-weekbar">
          <div>
            <h2 style={{ margin: 0, fontSize: 19, letterSpacing: '-0.01em' }}>My Timesheet</h2>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              {app.me.name} · {app.me.code}
            </div>
          </div>

          <div className="ts-weekbar-mid">
            <button className="btn icon" title="Previous week" aria-label="Previous week"
              onClick={() => setWs(ymd(addDays(parseYmd(ws), -7)))}>‹</button>
            <div className="ts-weekbar-range">
              {fmtD(ws)} – {fmtD(ymd(addDays(parseYmd(ws), 6)))}
            </div>
            <button className="btn icon" title="Next week" aria-label="Next week"
              onClick={() => setWs(ymd(addDays(parseYmd(ws), 7)))}>›</button>
            <button className="btn sm" disabled={ws === ymd(mondayOf(TODAY))}
              onClick={() => setWs(ymd(mondayOf(TODAY)))}>This week</button>
          </div>

          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Status</span>
            <StatusBadge status={sheet.status} />
          </div>
        </div>

        {/*
          * Four figures, and all four come back with the sheet. There is no
          * regular-versus-overtime split and no leave in the timesheet model,
          * so those are absent rather than computed against an assumed week —
          * a number the payslip would not recognise is worse than none.
          */}
        <div className="ts-summary" style={{ marginTop: 14 }}>
          <div className="tile"><span className="tile-l">Total hours</span>
            <b className="tile-v">{hrs(sheet.total)}</b></div>
          <div className="tile"><span className="tile-l">Billable</span>
            <b className="tile-v">{hrs(sheet.billable)}</b></div>
          <div className="tile"><span className="tile-l">Non-billable</span>
            <b className="tile-v">{hrs(sheet.nonBillable)}</b></div>
          <div className="tile"><span className="tile-l">Entries</span>
            <b className="tile-v">{sheet.entries.length}</b></div>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 9 }}>
          Overtime and leave are managed separately; this screen reports only
          what the timesheet records.
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

      {/* ---- what can be done to the week ---- */}
      {editable && (
        <div className="toolbar">
          <button className="btn sm" disabled={copyPrev.pending} onClick={doCopy}>
            <Icon n="swap" size="lg" /> Copy previous week
          </button>
          <button className="btn sm" onClick={bulk}>
            <Icon n="goal" size="lg" /> Fill week
          </button>
          <div className="spacer" />
          {/*
            * No "Save draft". Every cell commits to the service as it is left,
            * so there is nothing held back to save — a button implying
            * otherwise would be the only thing on the page that lies.
            */}
          <span className="muted" style={{ fontSize: 12 }}>
            Changes save as you make them.
          </span>
        </div>
      )}

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
          <Card
            title="Week grid"
            sub={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'} · ${sheet.entries.length} ${sheet.entries.length === 1 ? 'entry' : 'entries'}`}
            flush
            actions={editable
              ? (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={bulk}>+ Add project / task</button>
                </div>
              )
              : undefined}>
            <div style={{ padding: 12 }}>
              <WeekGrid
                sheet={sheet}
                days={gridCols}
                rows={rows}
                editable={editable}
                projects={projects}
                onRowMenu={rowMenu}
              />
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
          <Card title="Weekly summary" sub="As the service totals it">
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
                ['Entries', String(sheet.entries.length)],
              ]} />
            </div>
          </Card>

          <Card title="Where the week went" flush>
            {sheet.entries.length ? (
              <div style={{ padding: '4px 0 8px' }}>
                {Object.entries(sheet.entries.reduce<Record<string, number>>((acc, e) => {
                  acc[e.proj] = (acc[e.proj] ?? 0) + e.hours;
                  return acc;
                }, {})).sort((a, b) => b[1] - a[1]).map(([id, h], i) => (
                  <div key={id} style={{ padding: '7px 14px' }}>
                    <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                      <span>{proj.name(id)}</span>
                      <b className="mono">{hrs(h)}</b>
                    </div>
                    <div className="bar" style={{ marginTop: 5 }}>
                      <i style={{
                        width: (sheet.total ? (h / sheet.total) * 100 : 0) + '%',
                        background: PAL[i % PAL.length],
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
