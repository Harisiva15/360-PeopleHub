/**
 * The week as a grid — rows of work, columns of days.
 *
 * **A row is a project, a task and a billing flag; a cell is one entry.** That
 * triple is the only thing that can be a row without lying. The storage key is
 * (project, task, day), so the same project and task can be billable on Monday
 * and internal on Tuesday, and a grid keyed on project alone would have to pick
 * one of those to show. Two rows is the honest rendering of two records.
 *
 * This is why the editor was a flat list before: the grid it replaced *was*
 * keyed on project, and it could not say that. The list was right about the
 * data and wrong about how people read a week, so this keeps the shape and
 * restores the reading.
 *
 * **A cell edit is one of three calls, chosen by what is already there.**
 * Hours onto an empty cell is `addEntry`; a change is `updateEntry`; clearing
 * it is `removeEntry`. Never `addEntry` onto an existing cell — it merges on
 * the unique key and would *add* to the hours, which is right for "log some
 * more" and wrong for "the number is eight".
 *
 * **Nothing is totalled here.** Every figure on the screen comes back from the
 * service with the sheet, because a client that adds up its own hours will
 * eventually disagree with the approver's, and the approver's is the one that
 * matters.
 */

import { useEffect, useRef, useState } from 'react';
import { DOW, fmtD, parseYmd, TODAY, ymd } from '../../lib/dates';
import { Badge } from '../../components/ui';
import { Icon } from '../../components/icons';
import type { Timesheet, TimesheetProject, TSEntry } from '../../services';
import { useAddEntry, useRemoveEntry, useUpdateEntry } from './data';

export interface Day { date: string; dow: string; dom: string; weekend: boolean; today: boolean }

/** The seven days of a week, with what a column header needs to say. */
export function gridDays(weekStart: string): Day[] {
  const start = parseYmd(weekStart);
  const today = ymd(TODAY);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const date = ymd(d);
    return {
      date,
      dow: DOW[d.getDay()]!,
      dom: String(d.getDate()),
      weekend: d.getDay() === 0 || d.getDay() === 6,
      today: date === today,
    };
  });
}

export interface Row {
  key: string;
  proj: string;
  task: string;
  billable: boolean;
  /** One entry per day, or null where nothing is logged. */
  cells: (TSEntry | null)[];
  total: number;
}

/**
 * Group the week's entries into rows.
 *
 * Keyed by project, task and billability — see the note above. The totals here
 * are a row subtotal for display; the week's figures come from the service.
 */
export function rowsOf(sheet: Timesheet, days: Day[]): Row[] {
  const byKey = new Map<string, Row>();
  for (const e of sheet.entries) {
    const key = JSON.stringify([e.proj, e.task, e.billable]);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key, proj: e.proj, task: e.task, billable: e.billable,
        cells: days.map(() => null), total: 0,
      };
      byKey.set(key, row);
    }
    const at = days.findIndex((d) => d.date === e.date);
    if (at >= 0) row.cells[at] = e;
    row.total += e.hours;
  }
  return [...byKey.values()].sort((a, b) =>
    a.proj.localeCompare(b.proj) || a.task.localeCompare(b.task)
    || Number(b.billable) - Number(a.billable));
}

const fmtCell = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));

/**
 * One editable hour cell.
 *
 * Commits on blur rather than on every keystroke: each commit is a round trip
 * that returns the whole sheet, and doing that per character would make the
 * totals flicker and the limits fire halfway through typing "12".
 */
function HourCell({
  sheet, row, day, entry, editable, onError,
}: {
  sheet: Timesheet;
  row: Row;
  day: Day;
  entry: TSEntry | null;
  editable: boolean;
  onError: (key: string, msg: string) => void;
}) {
  const add = useAddEntry();
  const update = useUpdateEntry();
  const remove = useRemoveEntry();
  const [draft, setDraft] = useState(entry ? fmtCell(entry.hours) : '');
  const [busy, setBusy] = useState(false);
  const cellKey = `${row.key}|${day.date}`;

  /* The service is the source. A sheet that came back different wins. */
  useEffect(() => { setDraft(entry ? fmtCell(entry.hours) : ''); }, [entry?.id, entry?.hours]);

  const commit = async () => {
    /*
     * Enter blurs the input, so a keystroke and the blur it causes both land
     * here. The input being disabled is a picture of the state, not the state,
     * and a second addEntry would merge onto the first and double the hours.
     */
    if (busy) return;
    const text = draft.trim();
    const was = entry ? entry.hours : 0;
    const now = text === '' ? 0 : Number(text);

    if (text !== '' && !Number.isFinite(now)) {
      onError(cellKey, 'Hours must be a number');
      setDraft(entry ? fmtCell(entry.hours) : '');
      return;
    }
    if (now === was) { onError(cellKey, ''); return; }
    if (now < 0) {
      onError(cellKey, 'Hours cannot be negative');
      setDraft(entry ? fmtCell(entry.hours) : '');
      return;
    }

    setBusy(true);
    onError(cellKey, '');
    try {
      if (entry && now === 0) await remove.mutate(sheet.id, entry.id);
      else if (entry) await update.mutate(sheet.id, entry.id, { hours: now });
      else {
        await add.mutate(sheet.id, {
          date: day.date, proj: row.proj, task: row.task,
          billable: row.billable, hours: now,
        });
      }
    } catch (e) {
      /* The server's words, not a guess at them — it owns the day and week caps. */
      onError(cellKey, e instanceof Error ? e.message : 'Could not save that');
      setDraft(entry ? fmtCell(entry.hours) : '');
    } finally { setBusy(false); }
  };

  if (!editable) {
    return (
      <td className={'ts-cell' + (day.weekend ? ' ts-weekend' : '')}>
        {entry ? <span className="ts-cell-read">{fmtCell(entry.hours)}</span> : <span className="ts-cell-empty">–</span>}
      </td>
    );
  }

  return (
    <td className={'ts-cell' + (day.weekend ? ' ts-weekend' : '')}>
      <input
        className="ts-cell-input"
        inputMode="decimal"
        aria-label={`${row.task} on ${fmtD(day.date)}`}
        value={draft}
        disabled={busy}
        placeholder="–"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(entry ? fmtCell(entry.hours) : '');
        }}
      />
    </td>
  );
}

/**
 * The grid.
 *
 * Horizontally scrollable with the work column pinned, because seven days plus
 * a total does not fit a narrow window and squashing them is how a 4 becomes
 * a 1 at a glance.
 */
export function WeekGrid({
  sheet, days, rows, editable, projects, onRowMenu,
}: {
  sheet: Timesheet;
  days: Day[];
  rows: Row[];
  editable: boolean;
  projects: TimesheetProject[];
  onRowMenu: (row: Row) => void;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const setError = (key: string, msg: string) =>
    setErrors((e) => (msg ? { ...e, [key]: msg } : Object.fromEntries(
      Object.entries(e).filter(([k]) => k !== key))));

  const nameOf = (code: string) => projects.find((p) => p.id === code)?.name ?? code;
  const clientOf = (code: string) => projects.find((p) => p.id === code)?.client;

  /* Column totals, for the footer. Row and week figures come from the service. */
  const dayTotal = days.map((d) =>
    sheet.entries.filter((e) => e.date === d.date).reduce((n, e) => n + e.hours, 0));

  const shown = Object.entries(errors).filter(([, v]) => v);

  return (
    <div className="ts-grid-wrap">
      <table className="ts-grid">
        <thead>
          <tr>
            <th className="ts-col-work">Project / Task</th>
            {days.map((d) => (
              <th key={d.date}
                className={'ts-col-day' + (d.weekend ? ' ts-weekend' : '') + (d.today ? ' ts-today' : '')}>
                <span className="ts-dow">{d.dow}</span>
                <span className="ts-dom">{d.dom}</span>
              </th>
            ))}
            <th className="ts-col-total">Total</th>
            <th className="ts-col-menu" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th className="ts-col-work" scope="row">
                <div className="ts-work-name">{nameOf(row.proj)}</div>
                <div className="ts-work-task">
                  {row.task}
                  {row.billable
                    ? <Badge kind="good">Billable</Badge>
                    : <Badge>Internal</Badge>}
                </div>
                {clientOf(row.proj) && (
                  <div className="ts-work-client">{clientOf(row.proj)}</div>
                )}
              </th>
              {days.map((d, i) => (
                <HourCell
                  key={d.date}
                  sheet={sheet}
                  row={row}
                  day={d}
                  entry={row.cells[i] ?? null}
                  editable={editable}
                  onError={setError}
                />
              ))}
              <td className="ts-col-total ts-row-total">{fmtCell(row.total)}</td>
              <td className="ts-col-menu">
                <button className="btn ghost icon sm" aria-label={`Actions for ${row.task}`}
                  title="Row actions" onClick={() => onRowMenu(row)}>⋯</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={days.length + 3} className="ts-grid-empty">
                Nothing logged this week yet.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th className="ts-col-work" scope="row">Daily total</th>
            {days.map((d, i) => (
              <td key={d.date}
                className={'ts-cell ts-foot' + (d.weekend ? ' ts-weekend' : '') + (d.today ? ' ts-today' : '')}>
                {dayTotal[i] ? fmtCell(dayTotal[i]!) : '0'}
              </td>
            ))}
            {/* The week's total is the service's figure, not a sum of the above. */}
            <td className="ts-col-total ts-week-total">{fmtCell(sheet.total)}</td>
            <td className="ts-col-menu" />
          </tr>
        </tfoot>
      </table>

      {shown.length > 0 && (
        <div className="ts-grid-errors">
          {shown.map(([key, msg]) => {
            const [rowKey, date] = key.split('|');
            const row = rows.find((r) => r.key === rowKey);
            return (
              <div key={key} className="ts-grid-error">
                <Icon n="warn" size="lg" />
                <span>
                  <b>{row ? `${nameOf(row.proj)} · ${row.task}` : 'This week'}</b>
                  {date ? ` · ${fmtD(date)}` : ''} — {msg}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Focus the first editable cell — where somebody filling in a week starts. */
export function useFocusFirstCell(ready: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ready) return;
    const first = ref.current?.querySelector<HTMLInputElement>('.ts-cell-input');
    first?.focus();
  }, [ready]);
  return ref;
}
