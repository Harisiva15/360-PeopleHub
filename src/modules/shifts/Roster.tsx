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
 */

import { useMemo, useState } from 'react';
import { addDays, DOW, fmtD, fmtDS, mondayOf, parseYmd, TODAY, ymd } from '../../lib/dates';
import { SHIFTS, shiftOf } from '../../data/shifts';
import { DEPTS, deptOf, siteOf, SITES } from '../../data/org';
import { downloadCSV } from '../../lib/csv';
import { Avatar, Badge, Card, EmptyState, Seg, StatRow, Tile } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { visibleIds } from '../../state/rbac';
import { useAllEmployees, useRoster, useSetShift, useShiftProfiles } from './data';

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

  /* Profiles come from the server where it is live, and fall back to the
     four the mock knows about, so the legend is never empty. */
  const shiftList = profiles.length
    ? profiles.map((p) => ({ id: p.code, n: p.name, tz: p.timezone, region: p.region, c: shiftOf(p.code).c }))
    : SHIFTS.map((s) => ({ id: s.id, n: s.n, tz: s.tz, region: s.region, c: s.c }));

  const cellOf = (empId: string, date: string) => roster.data?.[empId]?.[date] ?? 'IN';
  /** Somebody's standing profile: whichever code their working days carry. */
  const standingOf = (empId: string) =>
    dates.map((d) => cellOf(empId, d)).find((s) => s !== 'OFF') ?? 'IN';

  const rows = visible
    .filter((e) => (!dept || e.dept === dept) && (!site || e.site === site))
    .filter((e) => !q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((e) => !shift || standingOf(e.id) === shift);

  /* Coverage counts people working, so a day off is not a shift. */
  const working = dates.map((d) => rows.filter((e) => cellOf(e.id, d) !== 'OFF').length);
  const offDays = rows.reduce((n, e) =>
    n + dates.filter((d) => cellOf(e.id, d) === 'OFF').length, 0);
  /*
   * The whole reason the timezone moved onto the shift: people measured
   * against a clock that is not their office's. Compared by country rather
   * than by code, because the UK shift's region is GB and its code is not.
   */
  const awayHours = rows.filter((e) => {
    const s = shiftList.find((x) => x.id === standingOf(e.id));
    return s ? s.region !== siteOf(e.site).country : false;
  }).length;

  const mayEdit = app.role === 'admin' || app.role === 'manager';

  const assign = async (empId: string, shiftCode: string) => {
    try {
      await setShift.mutate(empId, shiftCode);
      app.toast('Shift changed', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not change the shift', 'err');
    }
  };

  const exportCsv = () => downloadCSV(`roster-${ws}.csv`,
    [['Employee', 'Designation', 'Department', 'Location', 'Shift', 'Hours', 'Timezone',
      ...dates.map((d) => fmtDS(d))]].concat(
      rows.map((e) => {
        const code = standingOf(e.id);
        const s = shiftOf(code);
        return [e.name, e.designation, deptOf(e.dept).name, siteOf(e.site).city,
          s.n, `${s.start}–${s.end}`, s.tz,
          ...dates.map((d) => (cellOf(e.id, d) === 'OFF' ? 'Off' : code))];
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
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
      </div>

      <StatRow cols={4}>
        <Tile icon="👥" label="On the rota" value={rows.length}
          foot={`of ${people.length} people`} />
        <Tile icon="📅" label="Covered today"
          value={working[dates.indexOf(ymd(TODAY))] ?? '—'}
          foot={dates.includes(ymd(TODAY)) ? 'Working today' : 'Today is outside this range'} />
        <Tile icon="🌍" label="On another country's hours" value={awayHours}
          foot="Measured against a client's clock" />
        <Tile icon="🛌" label="Days off" value={offDays} foot="Across the period shown" />
      </StatRow>

      <Card title="Roster" sub={`${rows.length} people · ${fmtD(ws)} onwards`} flush>
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl roster">
              <thead>
                <tr>
                  <th style={{ minWidth: 190 }}>Employee</th>
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
                  const s = shiftOf(code);
                  const away = offsetNote(s.tz);
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
                        {mayEdit ? (
                          <select className="rost" style={{ borderLeftColor: s.c }}
                            value={code} onChange={(ev) => assign(e.id, ev.target.value)}
                            title={`${s.n} · ${h12(s.start)} – ${h12(s.end)} ${s.tz}`}>
                            {shiftList.map((o) => (
                              <option key={o.id} value={o.id}>{o.n}</option>
                            ))}
                          </select>
                        ) : (
                          <div className="rost" style={{ borderLeftColor: s.c }}>{s.n}</div>
                        )}
                        <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                          {h12(s.start)} – {h12(s.end)}{away ? ` · ${away}` : ''}
                        </div>
                      </td>
                      {dates.map((d) => {
                        const cell = cellOf(e.id, d);
                        const off = cell === 'OFF';
                        return (
                          <td key={d} className="rost-cell">
                            <div className={'rost' + (off ? ' off' : '')}
                              style={off ? undefined : { borderLeftColor: s.c }}
                              title={off ? 'Week off' : `${s.n} · ${h12(s.start)} – ${h12(s.end)}`}>
                              {off ? 'Off' : cell}
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
        ) : <EmptyState msg="Nobody matches those filters" icon="🗓" />}

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
          <span className="row" style={{ gap: 5, fontSize: 11.5 }}>
            <i style={{
              width: 9, height: 9, borderRadius: 3, background: 'var(--line-2)', display: 'inline-block',
            }} />
            Off
          </span>
        </div>
      </Card>

      {mayEdit
        ? (
          <Badge kind="info">
            A shift is the hours somebody keeps, not a day's assignment — changing it
            applies from now on, every working day.
          </Badge>
        )
        : <Badge kind="info">Your manager sets the shift; this is a read-only view</Badge>}
    </div>
  );
}
