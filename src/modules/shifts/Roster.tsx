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
 * **The rota shows what is expected. It is not attendance.** A working day with no
 * attendance row is drawn as a working day, never as an absence: the roster writes
 * nothing and infers nothing about what happened.
 */

import { useMemo, useState } from 'react';
import { addDays, DOW, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';

import { DEPTS, deptOf, siteOf, SITES } from '../../data/org';
import { downloadCSV } from '../../lib/csv';
import { Avatar, Badge, Banner, Card, EmptyState, Seg, StatRow, Tile } from '../../components/ui';
import type { RosterDay } from '../../services';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import { useAllEmployees, useRoster, useSetShift, useShiftProfiles } from './data';
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
   * The whole reason the timezone moved onto the shift: people measured
   * against a clock that is not their office's. Compared by country rather
   * than by code, because the UK shift's region is GB and its code is not.
   */
  const awayHours = rows.filter((e) => {
    const s = shiftList.find((x) => x.id === standingOf(e.id));
    return s ? s.region !== siteOf(e.site).country : false;
  }).length;
  const loading = roster.loading && !roster.data;

  const mayEdit = app.role === 'admin' || app.role === 'manager';

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
      'Hours', 'Timezone', ...dates.map((d) => fmtDS(d))]].concat(
      rows.map((e) => {
        const code = standingOf(e.id);
        const s = resolveProfile(profiles, code);
        return [e.name, e.designation, deptOf(e.dept).name, siteOf(e.site).city,
          scheduleOver(roster.data?.[e.id], dates) ?? 'Not assigned',
          s.name, `${s.start}–${s.end}`, s.timezone,
          ...dates.map((d) => {
            const look = lookOf(cellOf(e.id, d));
            if (!look) return '';
            return look.working ? code : look.label;
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

      <StatRow cols={4}>
        <Tile icon={<Icon n="people" size="lg" />} label="On the rota" value={rows.length}
          foot={`of ${people.length} people`} />
        <Tile icon={<Icon n="calendar" size="lg" />} label="Covered today"
          value={working[dates.indexOf(ymd(TODAY))] ?? '—'}
          foot={dates.includes(ymd(TODAY)) ? 'Working today' : 'Today is outside this range'} />
        <Tile icon={<Icon n="globe" size="lg" />} label="On another country's hours" value={awayHours}
          foot="Measured against a client's clock" />
        <Tile icon={<Icon n="rest" size="lg" />} label="Days off" value={offDays}
          foot={holidayDays ? `Plus ${holidayDays} holiday day(s)` : 'Across the period shown'} />
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
                        const tip = look.working
                          ? `${fmtD(d)} · ${resolveProfile(profiles, dayShift).name} · `
                            + `${h12(s.start)} – ${h12(s.end)}`
                          : `${fmtD(d)} · ${look.label}`
                            + (cell!.holiday ? ` · ${cell!.holiday}` : '');
                        return (
                          <td key={d} className="rost-cell">
                            <div className={'rost' + (look.working ? '' : ' off')}
                              style={look.working
                                ? { borderLeftColor: sColour }
                                : { background: look.tint ?? undefined }}
                              title={tip}>
                              {look.working ? dayShift : look.short}
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
        </div>
      </Card>

      {mayEdit
        ? (
          <Badge kind="info">
            A work schedule says which days; a shift says which hours. Changing the
            shift applies from now on, every working day — the days themselves come
            from the schedule, and this rota shows what is expected rather than what
            was attended.
          </Badge>
        )
        : <Badge kind="info">Your manager sets the shift; this is a read-only view</Badge>}
    </div>
  );
}
