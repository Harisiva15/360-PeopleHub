/**
 * The roster — who works which hours, a week at a time.
 *
 * People down the side, days across the top, and a coloured cell where they
 * meet. That shape is the point: a rota is read by scanning a row to see one
 * person's week and scanning a column to see whether Tuesday is covered, and
 * both have to be possible without clicking anything.
 *
 * **The row is one shift, not seven decisions.** Migration 0015 dropped the
 * per-day roster table: this business does not rotate, it spans timezones, so
 * a shift is a standing working-hours profile tagged on the person. Changing
 * it changes every day, which is why the control sits at the start of the row
 * rather than in each cell — a per-cell dropdown would offer a choice the
 * system cannot store, and would quietly discard four of the five days you set.
 *
 * **The cell says the shift, not a location.** What the system knows is which
 * hours somebody keeps. Labelling cells "Office" or "Remote" would invent a
 * fact nobody recorded; the work mode is captured at punch-in, on attendance.
 *
 * **Every colour is repeated by a word.** The legend explains the palette, but
 * the shift code is in the cell regardless, because a rota read by someone
 * colour-blind, or printed in grey, still has to say who works which hours.
 *
 * **Which days are worked is the server's answer, not this file's.** Until Phase
 * 2h-F this grid called Saturday and Sunday off for everybody, from a weekday test
 * on the server and `isWeekend` in the demo — so a tenant working Monday to
 * Saturday saw a rota that disagreed with their own schedule, their leave counts
 * and their calendar. Every cell now carries a `RosterDay` from the same resolver
 * leave reads, in one request for the whole team and span.
 *
 * **Expected, leave and actual, since Phases 2h-H and 2h-I.** The cell's tint is
 * what the schedule expected; approved leave marks the cell; a recorded punch adds
 * its status and times on top. A working day with no attendance row stays a
 * working day with no attendance row — never an absence. `A` is a status something
 * writes deliberately, a missing row is missing information, and the rota writes
 * neither. Approved leave explains a gap without becoming one.
 */

import { useMemo, useState } from 'react';
import { addDays, DOW, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';

import { DEPTS, deptOf, siteOf, SITES } from '../../data/org';
import { downloadCSV } from '../../lib/csv';
import { Avatar, Badge, Banner, Card, EmptyState, Seg, StatRow, Tile } from '../../components/ui';
import type { RosterDay } from '../../services';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import {
  useAllEmployees, useApprovedLeave, useAttendance, useRoster, useSetShift, useShiftProfiles,
} from './data';
import {
  ACTUAL_LABEL, leaveByEmployee, leaveOn, NO_ATTENDANCE, recordsByEmployee,
} from '../attendance/day';
import { colourOf, resolveProfile } from './profile';
import { EXPECTED_LEGEND, lookOf, scheduleOver, standingShift } from './expected';
import { Icon } from '../../components/icons';

/** 12-hour clock, because a rota is read by people not machines. */
function h12(t: string): string {
  if (!/^\d{2}:\d{2}$/.test(t)) return t;
  const [h, m] = t.split(':').map(Number);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * The local time in a shift's own zone, so "09:00 New York" is not read as
 * nine o'clock here. Only shown where the zone differs from the reader's.
 */
function offsetNote(tz: string): string | null {
  try {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || tz === here) return null;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()) + ' there now';
  } catch { return null; }
}

export function RosterView() {
  const app = useApp();
  const { data: people = [] } = useAllEmployees();
  const { data: profiles = [] } = useShiftProfiles();
  const setShift = useSetShift();

  const [ws, setWs] = useState(() => ymd(mondayOf(TODAY)));
  const [dept, setDept] = useState('');
  const [site, setSite] = useState('');
  const [shift, setShiftFilter] = useState('');
  const [q, setQ] = useState('');
  const [span, setSpan] = useState<'week' | 'fortnight'>('week');

  const days = span === 'week' ? 7 : 14;
  const dates = useMemo(
    () => Array.from({ length: days }, (_, i) => ymd(addDays(parseYmd(ws), i))),
    [ws, days]);

  /* Only people the caller may see; a rota is still a list of colleagues. */
  const allowed = useMemo(() => new Set(visibleIds(app.role, app.meId)), [app.role, app.meId]);
  const visible = useMemo(() => people.filter((e) => allowed.has(e.id)), [people, allowed]);
  const ids = useMemo(() => visible.map((e) => e.id), [visible]);
  const roster = useRoster(ids, ws, days);
  /*
   * What actually happened, in one range read for the whole team — the same shape
   * `listAttendance` already scopes by role, so a manager sees their line and
   * nobody else's. Never one request per person and never one per cell.
   */
  const attendance = useAttendance(ids, ws, dates[dates.length - 1] ?? ws);
  const actuals = useMemo(
    () => recordsByEmployee(attendance.data ?? []), [attendance.data]);
  /*
   * Approved leave for the same team and span, in one more range read. Three
   * requests for the whole grid: expected, leave, actual.
   */
  const leaveRead = useApprovedLeave(ids, ws, dates[dates.length - 1] ?? ws);
  const leaves = useMemo(
    () => leaveByEmployee(leaveRead.data ?? []), [leaveRead.data]);

  /*
   * Profiles come from the service in both modes — the mock returns the same four,
   * so there is nothing to fall back to and no client-side copy to drift from.
   */
  const shiftList = profiles.map((p, i) => ({
    id: p.code, n: p.name, tz: p.timezone, region: p.region, c: colourOf(p, i),
  }));

  /*
   * One cell, exactly as the server answered it — or undefined where it did not.
   * Nothing is substituted for a missing answer: a blank cell reads as no answer,
   * which is the truth, where a fabricated 'IN' would read as an expectation
   * nobody recorded.
   */
  const cellOf = (empId: string, date: string): RosterDay | undefined =>
    roster.data?.[empId]?.[date];
  /** Somebody's standing profile, read off the days they are expected to work. */
  const standingOf = (empId: string) =>
    standingShift(roster.data?.[empId], dates) ?? '';

  const rows = visible
    .filter((e) => (!dept || e.dept === dept) && (!site || e.site === site))
    .filter((e) => !q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((e) => !shift || standingOf(e.id) === shift);

  /*
   * Coverage counts people the schedule expects in. Counted off the verdict rather
   * than "not off", so a holiday and a date outside somebody's employment are both
   * excluded instead of being quietly counted as cover.
   */
  const working = dates.map((d) =>
    rows.filter((e) => cellOf(e.id, d)?.expected === 'WORKING').length);
  const offDays = rows.reduce((n, e) =>
    n + dates.filter((d) => cellOf(e.id, d)?.expected === 'WEEKLY_OFF').length, 0);
  const holidayDays = rows.reduce((n, e) =>
    n + dates.filter((d) => cellOf(e.id, d)?.expected === 'HOLIDAY').length, 0);
  /* People the server answered for with no schedule assignment of their own. */
  const unassigned = rows.filter((e) => scheduleOver(roster.data?.[e.id], dates) === null).length;
  /*
   * Working days up to today with nothing recorded against them. Counted and
   * named as exactly that — days awaiting a record. It is deliberately not called
   * absences: nothing here decides that, and the figure exists so somebody can go
   * and look rather than so a deduction can be computed from it.
   */
  const today = ymd(TODAY);
  const awaiting = rows.reduce((n, e) => n + dates.filter((d) =>
    d <= today
    && cellOf(e.id, d)?.expected === 'WORKING'
    && !actuals.get(e.id)?.get(d)
    /* Approved leave explains the gap, so it is not one awaiting a record. */
    && !leaveOn(leaves.get(e.id) ?? [], d)).length, 0);
  /* Working days across the period covered by approved leave. */
  const onLeave = rows.reduce((n, e) => n + dates.filter((d) =>
    cellOf(e.id, d)?.expected === 'WORKING'
    && leaveOn(leaves.get(e.id) ?? [], d) !== null).length, 0);
  /*
   * The whole reason the timezone moved onto the shift: people measured
   * against a clock that is not their office's. Compared by country rather
   * than by code, because the UK shift's region is GB and its code is not.
   */
  const awayHours = rows.filter((e) => {
    const s = shiftList.find((x) => x.id === standingOf(e.id));
    return s ? s.region !== siteOf(e.site).country : false;
  }).length;
  const loading = roster.loading && !roster.data;

  const mayEdit = app.reaches('shifts', 'write', 'team');

  const assign = async (empId: string, shiftCode: string) => {
    try {
      await setShift.mutate(empId, shiftCode);
      app.toast('Shift changed', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not change the shift', 'err');
    }
  };

  /*
   * The export carries the schedule as well as the shift, because "which days"
   * and "which hours" are two different questions and a rota exported without the
   * first is the thing this phase set out to fix.
   */
  const exportCsv = () => downloadCSV(`roster-${ws}.csv`,
    [['Employee', 'Designation', 'Department', 'Location', 'Work schedule', 'Shift',
      'Hours', 'Timezone',
      ...dates.flatMap((d) => [
        `${fmtDS(d)} expected`, `${fmtDS(d)} leave status`,
        `${fmtDS(d)} leave type`, `${fmtDS(d)} actual`,
      ])]].concat(
      rows.map((e) => {
        const code = standingOf(e.id);
        const s = resolveProfile(profiles, code);
        return [e.name, e.designation, deptOf(e.dept).name, siteOf(e.site).city,
          scheduleOver(roster.data?.[e.id], dates) ?? 'Not assigned',
          s.name, `${s.start}–${s.end}`, s.timezone,
          /*
           * Two columns per date, because the export carries two answers. One
           * merged column is how a reader ends up treating a gap as a result.
           */
          ...dates.flatMap((d) => {
            const look = lookOf(cellOf(e.id, d));
            const act = actuals.get(e.id)?.get(d) ?? null;
            const lv = leaveOn(leaves.get(e.id) ?? [], d);
            return [
              look ? (look.working ? code : look.label) : '',
              lv ? (lv.half ? `Approved (${lv.half})` : 'Approved') : '',
              lv ? lv.type : '',
              act ? (ACTUAL_LABEL[act.status] ?? act.status) : NO_ATTENDANCE,
            ];
          })];
      })));

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn icon" title="Previous"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), -days)))}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 13.5, minWidth: 200, textAlign: 'center' }}>
          {fmtD(ws)} – {fmtD(dates[dates.length - 1]!)}
        </div>
        <button className="btn icon" title="Next"
          onClick={() => setWs(ymd(addDays(parseYmd(ws), days)))}>›</button>
        <button className="btn sm" onClick={() => setWs(ymd(mondayOf(TODAY)))}>Today</button>

        <select className="input sm" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="input sm" value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All locations</option>
          {SITES.map((s) => <option key={s.id} value={s.id}>{s.city}</option>)}
        </select>
        <select className="input sm" value={shift} onChange={(e) => setShiftFilter(e.target.value)}>
          <option value="">All shifts</option>
          {shiftList.map((s) => <option key={s.id} value={s.id}>{s.n}</option>)}
        </select>
        <Seg value={span} onChange={setSpan} options={[
          { v: 'week', label: 'Week' },
          { v: 'fortnight', label: 'Fortnight' },
        ]} />

        <div className="spacer" />
        <input className="input sm" style={{ width: 180 }} value={q}
          placeholder="Search employee…" onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={exportCsv}><Icon n="download" size="lg" /> Export</button>
      </div>

      <StatRow cols={5}>
        <Tile icon={<Icon n="people" size="lg" />} label="On the rota" value={rows.length}
          foot={`of ${people.length} people`} />
        <Tile icon={<Icon n="calendar" size="lg" />} label="Covered today"
          value={working[dates.indexOf(ymd(TODAY))] ?? '—'}
          foot={dates.includes(ymd(TODAY)) ? 'Working today' : 'Today is outside this range'} />
        <Tile icon={<Icon n="globe" size="lg" />} label="On another country's hours" value={awayHours}
          foot="Measured against a client's clock" />
        <Tile icon={<Icon n="rest" size="lg" />} label="Days off" value={offDays}
          foot={holidayDays ? `Plus ${holidayDays} holiday day(s)` : 'Across the period shown'} />
        {/*
          * Both figures in one tile: StatRow takes at most five columns, and
          * widening a shared component for one screen is not worth it. They belong
          * together anyway — the leave count is most of why the other is small.
          */}
        <Tile icon={<Icon n="clock" size="lg" />} label="Awaiting a record" value={awaiting}
          foot={`Expected in, no record · ${onLeave} day(s) on approved leave`} />
      </StatRow>

      {unassigned > 0 && (
        <Banner kind="warn" icon={<Icon n="schedule" size="lg" />}
          title={`${unassigned} ${unassigned === 1 ? 'person has' : 'people have'} no work schedule`}>
          Their days come from the default Monday-to-Friday rule rather than a pattern
          anybody assigned. Assign one from the person&rsquo;s lifecycle record to make
          the expectation explicit.
        </Banner>
      )}

      <Card title="Roster" sub={`${rows.length} people · ${fmtD(ws)} onwards`} flush>
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl roster">
              <thead>
                <tr>
                  <th style={{ minWidth: 190 }}>Employee</th>
                  <th style={{ minWidth: 132 }}>Work schedule</th>
                  <th style={{ minWidth: 150 }}>Shift</th>
                  {dates.map((d) => {
                    const today = d === ymd(TODAY);
                    return (
                      <th key={d} className="nowrap" style={today ? { color: 'var(--brand)' } : undefined}>
                        {DOW[parseYmd(d).getDay()]}
                        <div className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>
                          {fmtDS(d)}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const code = standingOf(e.id);
                  const s = resolveProfile(profiles, code);
                  const away = offsetNote(s.timezone);
                  const sched = scheduleOver(roster.data?.[e.id], dates);
                  /* The colour the legend uses for this profile, so the two agree. */
                  const sColour = shiftList.find((o) => o.id === code)?.c ?? 'var(--line-2)';
                  return (
                    <tr key={e.id}>
                      <td>
                        <div className="person">
                          <Avatar name={e.name} size="sm" />
                          <div style={{ minWidth: 0 }}>
                            <div className="nm">{e.name}</div>
                            <div className="mt">{e.designation}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {sched
                          ? <Badge kind="info">{sched}</Badge>
                          : <span className="muted" style={{ fontSize: 12 }}>Not assigned</span>}
                      </td>
                      <td>
                        {mayEdit ? (
                          <select className="rost" style={{ borderLeftColor: sColour }}
                            value={code} onChange={(ev) => assign(e.id, ev.target.value)}
                            title={`${s.name} · ${h12(s.start)} – ${h12(s.end)} ${s.timezone}`}>
                            {shiftList.map((o) => (
                              <option key={o.id} value={o.id}>{o.n}</option>
                            ))}
                          </select>
                        ) : (
                          <div className="rost" style={{ borderLeftColor: sColour }}>{s.name}</div>
                        )}
                        <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                          {h12(s.start)} – {h12(s.end)}{away ? ` · ${away}` : ''}
                        </div>
                      </td>
                      {dates.map((d) => {
                        const cell = cellOf(e.id, d);
                        const look = lookOf(cell);
                        /*
                         * No answer for this person and date. Left blank, because
                         * the alternative is inventing one — and an invented day
                         * off on a rota is what somebody plans around.
                         */
                        if (!look) {
                          return <td key={d} className="rost-cell">
                            <div className="rost off" title="No answer for this date">&nbsp;</div>
                          </td>;
                        }
                        /* The shift the schedule expects that day, which may differ from the standing one. */
                        const dayShift = cell!.shift ?? code;
                        /* What was actually recorded, if anything. */
                        const act = actuals.get(e.id)?.get(d) ?? null;
                        const lv = leaveOn(leaves.get(e.id) ?? [], d);
                        const actualWords = act
                          ? (ACTUAL_LABEL[act.status] ?? act.status)
                          : NO_ATTENDANCE;
                        const expectedWords = look.working
                          ? `${resolveProfile(profiles, dayShift).name} `
                            + `${h12(s.start)} – ${h12(s.end)}`
                          : look.label + (cell!.holiday ? ` (${cell!.holiday})` : '');
                        /*
                         * Both answers in the tooltip, expected first. A missing
                         * record reads as "No attendance" and nothing else.
                         */
                        const tip = `${fmtD(d)} · Expected: ${expectedWords}`
                          + (lv
                            ? ` · Leave: Approved — ${lv.type}${lv.half ? ` (${lv.half})` : ''}`
                            : '')
                          + ` · Actual: ${actualWords}`
                          + (act?.inT ? ` ${act.inT}–${act.outT ?? '—'}` : '')
                          + (act?.late ? ' · late' : '')
                          + (lv && act && act.status !== 'L'
                            ? ' · attendance recorded during approved leave'
                            : '');
                        return (
                          <td key={d} className="rost-cell">
                            <div className={'rost' + (look.working ? '' : ' off')}
                              style={look.working
                                ? { borderLeftColor: sColour }
                                : { background: look.tint ?? undefined }}
                              title={tip} aria-label={tip}>
                              {look.working ? dayShift : look.short}
                              {/*
                                * Approved leave, as a word beside the expectation.
                                * It does not replace the shift code: the schedule
                                * still expected them on those hours.
                                */}
                              {lv && (
                                <small className="rost-lv" title={`Approved leave · ${lv.type}`}>
                                  LV{lv.half ? '½' : ''}
                                </small>
                              )}
                              {/*
                                * The recorded status, under the expectation rather
                                * than instead of it. Absent only ever appears here
                                * because attendance holds an 'A'.
                                */}
                              {act && (
                                <small className="rost-act">
                                  {act.status}{act.mins ? ` ${(act.mins / 60).toFixed(1)}h` : ''}
                                </small>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<Icon n="schedule" size="lg" />}
            msg={loading ? 'Reading the roster…'
              : roster.error ? roster.error.message
                : 'Nobody matches those filters'} />
        )}

        <div className="row" style={{
          gap: 14, flexWrap: 'wrap', padding: '11px 14px', borderTop: '1px solid var(--line)',
        }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Showing {rows.length} of {people.length} employees
          </span>
          <div className="spacer" />
          {shiftList.map((s) => (
            <span key={s.id} className="row" style={{ gap: 5, fontSize: 11.5 }}>
              <i style={{
                width: 9, height: 9, borderRadius: 3, background: s.c, display: 'inline-block',
              }} />
              {s.n}
            </span>
          ))}
          <span className="muted" style={{ fontSize: 11, fontWeight: 650 }}>Expected:</span>
          {EXPECTED_LEGEND.map((x) => (
            <span key={x.reason} className="row" style={{ gap: 5, fontSize: 11.5 }}>
              <i style={{
                width: 9, height: 9, borderRadius: 3, display: 'inline-block',
                background: x.look.tint ?? 'var(--line-2)',
                border: '1px solid var(--line-2)',
              }} />
              {x.look.label}
            </span>
          ))}
          <span className="muted" style={{ fontSize: 11, fontWeight: 650 }}>Recorded:</span>
          {Object.entries(ACTUAL_LABEL).map(([k, label]) => (
            <span key={k} className="row" style={{ gap: 4, fontSize: 11.5 }}>
              <b style={{ fontSize: 10.5 }}>{k}</b>{label}
            </span>
          ))}
          <span className="row" style={{ gap: 4, fontSize: 11.5 }}>
            <b style={{ fontSize: 10.5 }}>—</b>{NO_ATTENDANCE}
          </span>
          <span className="muted" style={{ fontSize: 11, fontWeight: 650 }}>Leave:</span>
          <span className="row" style={{ gap: 4, fontSize: 11.5 }}>
            <b style={{ fontSize: 10.5 }}>LV</b>Approved
          </span>
          <span className="row" style={{ gap: 4, fontSize: 11.5 }}>
            <b style={{ fontSize: 10.5 }}>LV½</b>Approved half day
          </span>
        </div>
      </Card>

      {/*
        * A `Banner`, not a `Badge`.
        *
        * `.badge` is a pill: `display:inline-flex` and `white-space:nowrap`,
        * sized to a word or two. This paragraph was inside one, so it laid out
        * as a single unbroken line 2097px wide in a 1164px column — and
        * because a badge absorbs nothing, that width was handed up through
        * every ancestor to the document. Both roster views scrolled sideways
        * at **every** width, 1440px included, which is how it was clear this
        * was not a phone-layout problem: the page was 2350px wide whatever the
        * viewport was.
        *
        * No CSS could fix it without changing every pill in the product.
        * `Banner` is the component for a paragraph of guidance, it wraps, and
        * it is what the rest of these screens already use.
        */}
      {mayEdit
        ? (
          <Banner kind="info">
            A work schedule says which days; a shift says which hours. Changing the
            shift applies from now on, every working day — the days themselves come
            from the schedule. Each cell shows what was expected, whether approved
            leave covers it, and what attendance actually recorded — three separate
            facts. A working day with nothing recorded is exactly that, and not an
            absence.
          </Banner>
        )
        : <Banner kind="info">Your manager sets the shift; this is a read-only view</Banner>}
    </div>
  );
}
