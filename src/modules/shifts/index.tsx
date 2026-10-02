import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, DOW, dowOf, fmtD, TODAY, ymd } from '../../lib/dates';
import { inr } from '../../lib/format';

import type { Overtime } from '../../services';
import { Badge, Banner, Card, EmptyState, PersonCell, Tabs, Tile, StatRow } from '../../components/ui';
import { notBacked } from '../../components/NotBacked';
import { Dot, StatusBadge } from '../../components/common';
import { Legend } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import type { ShiftDraft, ShiftProfile } from '../../services';
import {
  useApproveOvertime, useCreateShift, useLeaveBalance, useOvertime, useRaiseOvertime,
  useRejectOvertime, useRoster, useSetShiftActive, useShiftProfiles, useTodayCoverage,
  useUpdateShift, useVisiblePeople,
} from './data';
import type { Directory } from './data';
import { RosterView } from './Roster';
import { SchedulesView } from './Schedules';
import { colourOf, resolveProfile } from './profile';
import { EXPECTED_LEGEND, lookOf, scheduleOver, standingShift } from './expected';
import { ShiftForm } from './ShiftForm';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { Icon } from '../../components/icons';

/** Indicative hourly rate used to price approved overtime. */
const OT_HOURLY = 450;


/** The time where a shift's hours are kept, when that is not where you are. */
function localNow(tz: string): string | null {
  try {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || tz === here) return null;
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
  } catch { return null; }
}

/* ---------------- My roster ---------------- */

/**
 * One person's own four weeks.
 *
 * Read-only by design, and not only because an employee cannot change their own
 * schedule: the days come from the server's calendar resolver, so this screen has
 * nothing to compute and no second opinion to offer. It shows which pattern they
 * are on, which hours, and what each day is expected to be.
 */
function ShMy() {
  const app = useApp();
  const me = app.me;
  const { data: profiles = [] } = useShiftProfiles();
  const start = addDays(TODAY, -7);
  const { data: roster = {} } = useRoster([me.id], ymd(start), 28);
  const { data: compOff } = useLeaveBalance(me.id, 'CO');
  const days: Date[] = [];
  for (let i = 0; i < 28; i++) days.push(addDays(start, i));

  const mine = roster[me.id];
  const dates = days.map((d) => ymd(d));
  /* The standing profile and the pattern, both read off the server's verdicts. */
  const standing = standingShift(mine, dates) ?? '';
  const sched = scheduleOver(mine, dates);
  const sh = resolveProfile(profiles, standing);
  /* Its own colour where the tenant chose one, otherwise its slot in the list. */
  const shColour = colourOf(sh, Math.max(0, profiles.findIndex((p) => p.code === standing)));
  const todayLook = lookOf(mine?.[ymd(TODAY)]);
  const offs = dates.filter((d) => mine?.[d]?.expected === 'WEEKLY_OFF').length;
  const workDays = dates.filter((d) => mine?.[d]?.expected === 'WORKING').length;
  const lead = days[0].getDay();
  const there = localNow(sh.timezone);

  return (
    <div className="stack">
      <StatRow cols={5}>
        <Tile label="My shift" value={sh.name}
          foot={todayLook && !todayLook.working
            ? `Today is ${todayLook.label.toLowerCase()}`
            : `${sh.start} – ${sh.end}`} />
        <Tile label="My working pattern" value={sched ?? 'Not assigned'}
          foot={sched
            ? 'Which days you are expected in'
            : 'Monday to Friday is assumed until one is set'} />
        <Tile label="Measured against"
          value={sh.timezone.split('/')[1]?.replace('_', ' ') ?? sh.timezone}
          foot={there ? `${there} there right now` : 'Your own clock'} />
        <Tile label="Working days" value={workDays} foot={`${offs} week offs in the 4 weeks shown`} />
        <Tile label="Comp off balance" value={(compOff?.avail ?? 0) + ' days'} foot="Earned from extra working days" />
      </StatRow>

      <Card title="My roster" sub={`4-week view · ${fmtD(ymd(days[0]))} – ${fmtD(ymd(days[27]))}`}
        actions={<button className="btn sm"
          {...notBacked('a shift swap has no request to raise against yet — ask your shift lead directly')}
        >⇄ Request a swap</button>}>
        <div className="cal">
          {DOW.map((d) => <div className="dow" key={d}>{d[0]}</div>)}
          {Array.from({ length: lead }, (_, i) => <div className="day mut" key={'l' + i} />)}
          {days.map((d) => {
            const ds = ymd(d);
            const cell = mine?.[ds];
            const look = lookOf(cell);
            const isToday = ds === ymd(TODAY);
            /*
             * No verdict for this date — left blank rather than filled in. The
             * server answers every date it is asked about, so a gap means the read
             * has not arrived, and a guess would be a day somebody plans around.
             */
            if (!look) {
              return <div key={ds} className="day mut"
                style={isToday ? { outline: '2px solid var(--brand)', outlineOffset: -2 } : undefined}
              >{d.getDate()}</div>;
            }
            const dayShift = cell!.shift ?? standing;
            return (
              <div key={ds} className="day"
                style={{
                  ...(look.working
                    ? { background: `color-mix(in srgb, ${shColour} 15%, transparent)` }
                    : { background: look.tint ?? 'var(--surface-3)', color: 'var(--ink-3)' }),
                  ...(isToday ? { outline: '2px solid var(--brand)', outlineOffset: -2 } : {}),
                }}
                data-tip={`${fmtD(ds)} · ${look.working
                  ? `${resolveProfile(profiles, dayShift).name} ${sh.start}–${sh.end} ${sh.timezone}`
                  : look.label}${cell!.holiday ? ` · ${cell!.holiday}` : ''}`}>
                {d.getDate()}<small>{look.working ? dayShift : look.short}</small>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12 }}>
          <Legend items={profiles.map((p, i) => ({ k: p.name, c: colourOf(p, i) }))
            .concat(EXPECTED_LEGEND.map((x) => ({
              k: x.look.label, c: x.look.tint ?? 'var(--line-2)',
            })))} />
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Overtime & comp off ---------------- */

function OtTable(
  { list, dir, act, onApprove, onReject }:
  {
    list: Overtime[]; dir: Directory; act: boolean;
    onApprove: (o: Overtime) => void; onReject: (o: Overtime) => void;
  },
) {
  if (!list.length) return <EmptyState msg="Nothing logged" icon={<Icon n="timer" size="lg" />} />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {act && <th>Employee</th>}
            <th>Date</th><th className="num">Hours</th><th>Reason</th><th>Compensation</th><th>Status</th><th>Outcome</th>
            {act && <th className="right">Action</th>}
          </tr>
        </thead>
        <tbody>
          {sortBy(list, (o) => o.date, 'desc').map((o) => (
            <tr key={o.id}>
              {act && <td><PersonCell e={dir.byId(o.empId)!} /></td>}
              <td className="nowrap">{fmtD(o.date)} <span className="muted">{dowOf(o.date)}</span></td>
              <td className="num strong">{o.hours}</td>
              <td>{o.reason}</td>
              <td>
                <Badge kind={o.compensation === 'Comp Off' ? 'info' : 'good'}>
                  {o.compensation === 'Comp Off' ? 'Comp off' : 'Overtime pay'}
                </Badge>
              </td>
              <td><StatusBadge status={o.status} /></td>
              <td className="muted" style={{ fontSize: 12 }}>{outcomeOf(o)}</td>
              {act && (
                <td className="right">
                  {o.status === 'Pending' ? (
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => onReject(o)}>Reject</button>
                      <button className="btn sm primary" onClick={() => onApprove(o)}>Approve</button>
                    </div>
                  ) : <span className="muted">—</span>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the claim actually bought.
 *
 * Eight hours to the day, rounded down — so five approved hours credit nothing,
 * and saying "Approved" without saying that is how somebody goes looking for a
 * comp-off day that was never earned.
 */
function outcomeOf(o: Overtime): string {
  if (o.status === 'Pending') return 'Awaiting approval';
  if (o.status === 'Rejected') return 'Not approved';
  if (o.compensation === 'Overtime Pay') return 'With the next payroll run';
  if (o.credited > 0) return `${o.credited} day${o.credited === 1 ? '' : 's'} comp off credited`;
  return `Under 8 hours — no comp off day earned`;
}

function LogForm({ close }: { close: () => void }) {
  const app = useApp();
  const raiseOvertime = useRaiseOvertime();
  const [date, setDate] = useState(ymd(addDays(TODAY, -1)));
  const [hours, setHours] = useState(4);
  const [reason, setReason] = useState('');
  const [comp, setComp] = useState<'Comp Off' | 'Overtime Pay'>('Comp Off');
  return (
      <>
        <div className="field"><label>Date</label><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="field">
          <label>Hours worked beyond your shift</label>
          <input type="number" className="input" min={1} max={12} value={hours} onChange={(e) => setHours(+e.target.value || 1)} />
        </div>
        <div className="field">
          <label>Reason</label>
          <textarea className="input" placeholder="Release support, escalation, migration window…" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="field">
          <label>Preferred compensation</label>
          <select className="input" value={comp} onChange={(e) => setComp(e.target.value as 'Comp Off' | 'Overtime Pay')}>
            <option>Comp Off</option><option>Overtime Pay</option>
          </select>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            try {
              await raiseOvertime.mutate({
                empId: app.meId, date, hours, reason: reason || 'Extra hours', compensation: comp,
              });
              close();
              app.toast('Submitted for approval', 'ok');
            } catch (e) {
              app.toast(e instanceof Error ? e.message : 'Could not log the hours', 'err');
            }
          }}>Submit</button>
        </div>
      </>
  );
}

function ShOt() {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const { data: overtime = [] } = useOvertime(dir.ids);
  const { data: compOff } = useLeaveBalance(app.meId, 'CO');
  const approveOvertime = useApproveOvertime();
  const rejectOvertime = useRejectOvertime();

  const mine = overtime.filter((o) => o.empId === app.meId);
  const team = app.role === 'employee' ? [] : overtime.filter((o) => o.empId !== app.meId);
  const pend = team.filter((o) => o.status === 'Pending');

  /* Approving credits the comp off, so the service does both together. */
  const approve = async (o: Overtime) => {
    try {
      const done = await approveOvertime.mutate(o.id);
      /*
       * The toast reports what was credited, not what was requested. Eight
       * hours buy a day; five buy nothing, and saying "comp off credited"
       * regardless is a promise the balance will not keep.
       */
      const note = o.compensation !== 'Comp Off' ? ' — goes to the next payroll run'
        : done.credited > 0 ? ` — ${done.credited} day${done.credited === 1 ? '' : 's'} comp off credited`
          : ' — under 8 hours, so no comp off day';
      app.toast('Overtime approved' + note, 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not approve the overtime', 'err');
    }
  };

  const reject = async (o: Overtime) => {
    try {
      await rejectOvertime.mutate(o.id);
      app.toast('Overtime rejected', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not reject the overtime', 'err');
    }
  };

  return (
    <div className="stack">
      <Banner kind="info" icon={<Icon n="timer" size="lg" />} title="How extra hours are compensated">
        Hours worked beyond your shift can be claimed as comp off — one day per full eight
        hours, rounded down — or as overtime pay at 1.5× the hourly rate, paid with the next
        run. Your manager approves; the comp-off day is credited the moment they do.
      </Banner>

      <StatRow cols={4}>
        <Tile label="My overtime" value={sum(mine.filter((o) => o.status === 'Approved'), (o) => o.hours) + ' h'} foot="Approved, last 45 days" />
        <Tile label="Comp off balance" value={(compOff?.avail ?? 0) + ' days'} foot="Use within 60 days" />
        <Tile label="Team pending" value={pend.length} foot="Awaiting your approval" />
        <Tile label="Overtime cost"
          value={inr(sum(team.filter((o) => o.status === 'Approved' && o.compensation === 'Overtime Pay'), (o) => o.hours * OT_HOURLY))}
          foot="Payable this cycle" />
      </StatRow>

      <Card title="My overtime" sub={`${mine.length} entries`} flush
        actions={
          <button className="btn sm primary" onClick={() =>
            layer.modal({
              title: 'Log extra hours',
              sub: 'Sent to ' + dir.name(app.me.managerId) + ' for approval',
              size: 'narrow',
              body: (close) => <LogForm close={close} />,
              footer: null,
            })}><Icon n="add" size="lg" /> Log extra hours</button>
        }>
        <OtTable list={mine} dir={dir} act={false} onApprove={approve} onReject={reject} />
      </Card>

      {app.role !== 'employee' && (
        <Card title="Team overtime" sub={`${team.length} entries · ${pend.length} pending`} flush>
          <OtTable list={team} dir={dir} act onApprove={approve} onReject={reject} />
        </Card>
      )}
    </div>
  );
}

/* ---------------- Shift definitions ---------------- */

/*
 * Written against the model 0015 left behind. The prototype's rules were about
 * rotation — consecutive nights, moving one shift forward each week — and none
 * of them describe a business where a shift is the hours somebody keeps.
 */
const SHIFT_RULES: [string, string][] = [
  ['One shift per person', 'A shift is the hours you keep, not a day’s assignment. Changing it applies from the day it is changed.'],
  ['The timezone decides lateness', 'Attendance is measured against the shift’s own clock, not the office you sit in. Somebody in Chennai on the US shift is late at 09:00 New York.'],
  ['Weekly offs', 'Saturday and Sunday on every profile. A holiday follows the calendar of the shift’s region.'],
  ['Changing a shift', 'A manager may move anyone in their line; an admin, anyone. It is a change to the person and is recorded as one.'],
  ['Extra hours', 'Anything beyond your shift is claimed as overtime — comp off at one day per eight hours, or overtime pay.'],
  ['Night work', 'None of the four profiles currently runs overnight. If one is added, the night allowance and the statutory transport duty apply from that day.'],
];

function ShDef() {
  const app = useApp();
  const layer = useLayer();
  const { data: coverage = {} } = useTodayCoverage();
  const { data: profiles = [], refetch } = useShiftProfiles();
  const create = useCreateShift();
  const update = useUpdateShift();
  const setActive = useSetShiftActive();
  /* The service refuses a non-admin outright; this only decides what is offered. */
  const admin = app.role === 'admin';

  const editShift = (existing?: ShiftProfile) => {
    let draft: ShiftDraft = existing
      ? {
        code: existing.code, name: existing.name,
        startsAt: existing.start === '—' ? '' : existing.start,
        endsAt: existing.end === '—' ? '' : existing.end,
        timezone: existing.timezone, region: existing.region || null,
        breakMinutes: existing.breakMinutes, graceMinutes: existing.graceMinutes,
        isNight: existing.night, isFlexible: existing.flexible,
      }
      : {
        code: '', name: '', startsAt: '09:30', endsAt: '18:30',
        timezone: 'Asia/Kolkata', region: null, breakMinutes: 60, graceMinutes: 10,
        isNight: false, isFlexible: false,
      };

    layer.modal({
      title: existing ? `Edit ${existing.name}` : 'Add a working-hours profile',
      size: 'wide',
      body: (
        <ShiftForm initial={draft} editing={Boolean(existing)}
          hasHistory={(existing?.headcount ?? 0) > 0}
          onChange={(v) => { draft = v; }} />
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            try {
              if (existing) await update.mutate(existing.code, draft);
              else await create.mutate(draft);
              app.toast(existing ? 'Shift saved' : 'Shift added', 'ok');
              refetch();
              close();
            } catch (e) {
              /* Shown where it happened: the refusal names the field or the history. */
              app.toast(e instanceof Error ? e.message : 'Could not save the shift', 'err');
            }
          }}>{existing ? 'Save' : 'Add'}</button>
        </>
      ),
    });
  };

  const toggle = async (sh: ShiftProfile) => {
    try {
      await setActive.mutate(sh.code, !sh.active);
      app.toast(sh.active ? `${sh.code} withdrawn from use` : `${sh.code} back in use`, 'ok');
      refetch();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not change the shift', 'err');
    }
  };

  /*
   * Every column comes from the service, break and grace included.
   *
   * There is deliberately no fallback to `src/data/shifts.ts`: that constant held
   * a 45-minute break and a 20-minute grace for the India shift while the column
   * holds 60 and 10, and the column is what attendance deducts and measures
   * lateness against. A table that falls back to the wrong number when a read is
   * slow is the same defect with extra steps.
   *
   * `coverage` is still read because it is the one figure the profile list does not
   * carry per code — headcount on the profile is anyone not yet left, and coverage
   * is today's.
   */
  const rows = profiles.map((p, i) => ({
    id: p.code, n: p.name, start: p.start, end: p.end, tz: p.timezone,
    region: p.region, night: p.night, c: colourOf(p, i),
    brk: p.breakMinutes, grace: p.graceMinutes, active: p.active,
    people: p.headcount || coverage[p.code] || 0,
    profile: p,
  }));

  return (
    <div className="grid g-2-1">
      <Card title="Working-hours profiles"
        sub={`${rows.filter((r) => r.active).length} in use of ${rows.length}`}
        actions={admin && (
          <button className="btn sm" onClick={() => editShift()}>
            <Icon n="add" size="lg" /> Add
          </button>
        )}
        flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Shift</th><th>Hours</th><th>Measured against</th>
                <th className="num">Break</th><th className="num">Grace</th><th className="num">People</th>
                {admin && <th className="right">&nbsp;</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const there = localNow(s.tz);
                return (
                  <tr key={s.id}>
                    <td>
                      <Dot color={s.c} /> <b>{s.n}</b>
                      {s.night && <> <Badge kind="info">Night</Badge></>}
                      {!s.active && <> <Badge kind="mute">Inactive</Badge></>}
                    </td>
                    <td className="mono">{s.start} – {s.end}</td>
                    <td>
                      <div className="mono" style={{ fontSize: 12 }}>{s.tz}</div>
                      {there && <div className="muted" style={{ fontSize: 11 }}>{there} there now</div>}
                    </td>
                    <td className="num">{s.brk} min</td>
                    <td className="num">{s.grace} min</td>
                    <td className="num">{s.people}</td>
                    {admin && (
                      <td className="right nowrap">
                        <button className="btn sm ghost"
                          onClick={() => editShift(s.profile)}>Edit</button>{' '}
                        <button className="btn sm ghost" onClick={() => toggle(s.profile)}>
                          {s.active ? 'Withdraw' : 'Reinstate'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="How shifts work here" sub="What the rules actually are">
        <div className="stack" style={{ gap: 11, fontSize: 13 }}>
          {SHIFT_RULES.map(([k, v]) => (
            <div key={k}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{k}</div>
              <div className="muted">{v}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'roster' | 'my' | 'ot' | 'def' | 'sched';

function Shifts() {
  const app = useApp();
  /*
   * Working patterns sit beside shift profiles, under the navigation item that
   * already reads 'Shifts & work schedules' — the second half of which had nothing
   * behind it until this phase. No new route and no new nav entry.
   *
   * Readable by everyone, as the service allows: which days the company works is
   * not privileged, and the write controls inside are an admin's.
   */
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [
        { v: 'my', label: 'My shift' }, { v: 'ot', label: 'Overtime & comp off' },
        { v: 'def', label: 'Shift profiles' }, { v: 'sched', label: 'Working patterns' },
      ]
    : [
        { v: 'roster', label: 'Team roster' }, { v: 'my', label: 'My shift' },
        { v: 'ot', label: 'Overtime & comp off' }, { v: 'def', label: 'Shift profiles' },
        { v: 'sched', label: 'Working patterns' },
      ];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'roster' && <RosterView />}
      {active === 'my' && <ShMy />}
      {active === 'ot' && <ShOt />}
      {active === 'def' && <ShDef />}
      {active === 'sched' && <SchedulesView />}
    </>
  );
}

registerModule({
  key: 'shifts',
  title: TITLES.shifts,
  Component: Shifts,
});
