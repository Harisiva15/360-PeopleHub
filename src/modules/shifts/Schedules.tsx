/**
 * Working patterns — which days a person is expected in.
 *
 * The companion screen to "Shift profiles", and the distinction between the two
 * is the whole reason this exists: a **shift** says which hours, in which
 * timezone, with how much break and grace; a **work schedule** says which days.
 * Migration 0015 put the hours on the shift and 0054 put the days here, and
 * nothing in this screen copies one into the other.
 *
 * ## It configures, it does not calculate
 *
 * Every rule lives in `server/src/modules/schedules/service.ts`: seven weekdays or
 * nothing, a day off names no shift, an inactive shift cannot be newly assigned, a
 * code never changes. The form keeps somebody from reaching most of those, and
 * where it cannot, the service refuses and this screen shows what it said. There
 * is no second copy of the rules here to drift from the first.
 *
 * ## Withdrawing is not deleting
 *
 * There is no delete, because the service has none. An assignment may still name a
 * pattern — withdrawing one moves nobody — and a historical row has to keep
 * resolving. So a withdrawn pattern stays listed, keeps its days, and simply stops
 * being offered for a new assignment. The list says so in words as well as tone.
 */

import { useMemo, useState } from 'react';
import { Badge, Banner, Card, EmptyState, StatRow, Tile } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useApp } from '../../state/AppContext';
import { useLayer } from '../../components/Layer';
import type { WorkSchedule } from '../../services';
import {
  useCreateWorkSchedule, useSetWorkScheduleActive, useSetWorkScheduleDay,
  useShiftProfiles, useUpdateWorkSchedule, useWorkSchedules,
} from './data';
import { ScheduleForm } from './ScheduleForm';
import { draftOf, monToFriDraft, WEEKDAYS, type ScheduleDraft } from './weekdays';

/**
 * The pattern as a row of seven day-letters.
 *
 * Read far faster than "Monday, Tuesday, Wednesday, Thursday, Friday", which is
 * the point of a list: somebody scanning for the six-day pattern should spot it
 * without reading a sentence. The worked days are also counted in words beside it,
 * because a strip of letters alone communicates by shape and this has to survive
 * being read aloud.
 */
function PatternStrip({ s }: { s: WorkSchedule }) {
  if (!s.days.length) {
    return <span className="muted" style={{ fontSize: 12 }}>—</span>;
  }
  return (
    <span className="row" style={{ gap: 3 }}>
      {WEEKDAYS.map((w) => {
        const row = s.days.find((d) => d.dayOfWeek === w.dow);
        const on = row?.working === true;
        return (
          <abbr key={w.dow} title={`${w.name}: ${on ? 'working' : 'off'}`
            + (row?.shiftCode ? ` (${row.shiftName ?? row.shiftCode})` : '')}
            style={{
              display: 'inline-block', width: 20, textAlign: 'center',
              fontSize: 10.5, fontWeight: 700, borderRadius: 3, padding: '2px 0',
              textDecoration: 'none',
              background: on ? 'var(--brand-wash)' : 'var(--surface-3)',
              color: on ? 'var(--brand-text)' : 'var(--ink-3)',
              border: row?.shiftCode ? '1px solid var(--brand)' : '1px solid transparent',
            }}>
            {w.short[0]}
          </abbr>
        );
      })}
    </span>
  );
}

export function SchedulesView() {
  const app = useApp();
  const layer = useLayer();
  const { data: schedules = [], loading, error, refetch } = useWorkSchedules();
  const { data: profiles = [] } = useShiftProfiles();
  const create = useCreateWorkSchedule();
  const update = useUpdateWorkSchedule();
  const setActive = useSetWorkScheduleActive();
  const setDay = useSetWorkScheduleDay();

  const [q, setQ] = useState('');
  const [showWithdrawn, setShowWithdrawn] = useState(true);

  /* The service refuses a non-admin outright; this only decides what is offered. */
  const admin = app.role === 'admin';

  const rows = useMemo(() => schedules
    .filter((s) => showWithdrawn || s.active)
    .filter((s) => {
      const t = q.trim().toLowerCase();
      return !t || s.code.toLowerCase().includes(t) || s.name.toLowerCase().includes(t);
    }), [schedules, q, showWithdrawn]);

  const edit = (existing?: WorkSchedule) => {
    let draft: ScheduleDraft = existing
      ? draftOf(existing)
      : { code: '', name: '', description: '', days: monToFriDraft() };

    layer.modal({
      title: existing ? `Edit ${existing.name}` : 'Add a working pattern',
      size: 'wide',
      body: (
        <ScheduleForm initial={draft} editing={Boolean(existing)} profiles={profiles}
          onChange={(v) => { draft = v; }} />
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={async () => {
            try {
              if (existing) {
                /*
                 * Two calls, because the service deliberately takes them
                 * separately: the details through `updateWorkSchedule`, and each
                 * weekday through `setWorkScheduleDay`. Sending days to the first
                 * is refused rather than ignored, so a rename that silently
                 * dropped a weekday change is not possible.
                 *
                 * Only the changed weekdays are sent, so an unchanged pattern
                 * costs one request rather than eight.
                 */
                await update.mutate(existing.code, {
                  name: draft.name, description: draft.description || null,
                });
                const before = draftOf(existing);
                for (const d of draft.days) {
                  const was = before.days.find((x) => x.dayOfWeek === d.dayOfWeek)!;
                  if (was.working === d.working && (was.shiftCode ?? null) === (d.shiftCode ?? null)) {
                    continue;
                  }
                  await setDay.mutate(existing.code, d);
                }
              } else {
                await create.mutate({
                  code: draft.code, name: draft.name,
                  description: draft.description || null, days: draft.days,
                });
              }
              app.toast(existing ? 'Pattern saved' : 'Pattern added', 'ok');
              refetch();
              close();
            } catch (e) {
              /* The service's own words: it names the field, the code or the clash. */
              app.toast(e instanceof Error ? e.message : 'Could not save the pattern', 'err');
            }
          }}>{existing ? 'Save' : 'Add'}</button>
        </>
      ),
    });
  };

  const toggle = async (s: WorkSchedule) => {
    try {
      await setActive.mutate(s.code, !s.active);
      app.toast(s.active ? `${s.code} withdrawn from use` : `${s.code} back in use`, 'ok');
      refetch();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not change the pattern', 'err');
    }
  };

  const live = schedules.filter((s) => s.active).length;
  const onPatterns = schedules.reduce((n, s) => n + s.assignedNow, 0);

  if (error) {
    return (
      <Card title="Working patterns">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  return (
    <div className="stack">
      <StatRow cols={3}>
        <Tile icon={<Icon n="schedule" size="lg" />} label="Patterns in use" value={live}
          foot={`of ${schedules.length} defined`} />
        <Tile icon={<Icon n="people" size="lg" />} label="People on a pattern" value={onPatterns}
          foot="Currently assigned" />
        <Tile icon={<Icon n="calendar" size="lg" />} label="Days a week"
          value={schedules.length
            ? `${Math.min(...schedules.map((s) => s.days.filter((d) => d.working).length || 5))}–${Math.max(...schedules.map((s) => s.days.filter((d) => d.working).length || 5))}`
            : '—'}
          foot="Across the patterns defined" />
      </StatRow>

      <Card title="Working patterns"
        sub="Which days each pattern expects — the hours come from the shift"
        actions={(
          <div className="row" style={{ gap: 8 }}>
            <input className="input sm" style={{ width: 160 }} value={q} type="search"
              aria-label="Search patterns" placeholder="Code or name…"
              onChange={(e) => setQ(e.target.value)} />
            <label className="row" style={{ gap: 5, fontSize: 12 }}>
              <input type="checkbox" checked={showWithdrawn}
                onChange={(e) => setShowWithdrawn(e.target.checked)} />
              Show withdrawn
            </label>
            {admin && (
              <button className="btn sm" onClick={() => edit()}>
                <Icon n="add" size="lg" /> Add
              </button>
            )}
          </div>
        )}
        flush>
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ minWidth: 150 }}>Pattern</th>
                  <th style={{ minWidth: 170 }}>Days worked</th>
                  <th>Different hours on</th>
                  <th className="num">People</th>
                  <th>Status</th>
                  {admin && <th className="right">&nbsp;</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const overrides = s.days.filter((d) => d.shiftCode);
                  const worked = s.days.filter((d) => d.working).length;
                  return (
                    <tr key={s.code}>
                      <td>
                        <b>{s.name}</b> <Badge kind="mute">{s.code}</Badge>
                        {s.description && (
                          <div className="muted" style={{ fontSize: 11.5 }}>{s.description}</div>
                        )}
                      </td>
                      <td>
                        <PatternStrip s={s} />
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                          {s.days.length ? `${worked} day${worked === 1 ? '' : 's'} a week` : 'Open to see'}
                        </div>
                      </td>
                      <td>
                        {overrides.length
                          ? (
                            <span style={{ fontSize: 12 }}>
                              {overrides.map((d) =>
                                `${WEEKDAYS.find((w) => w.dow === d.dayOfWeek)?.short}: ${d.shiftName ?? d.shiftCode}`)
                                .join(', ')}
                            </span>
                          )
                          : <span className="muted" style={{ fontSize: 12 }}>Their own shift</span>}
                      </td>
                      <td className="num">{s.assignedNow}</td>
                      <td>
                        {s.active
                          ? <Badge kind="good">In use</Badge>
                          : <Badge kind="mute">Withdrawn</Badge>}
                      </td>
                      {admin && (
                        <td className="right nowrap">
                          <button className="btn sm ghost" onClick={() => edit(s)}>Edit</button>{' '}
                          <button className="btn sm ghost" onClick={() => toggle(s)}>
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
        ) : (
          <EmptyState icon={<Icon n="schedule" size="lg" />}
            msg={loading ? 'Reading the patterns…'
              : q || !showWithdrawn ? 'No pattern matches that'
                : 'No working pattern yet. Add one to say which days a group works.'} />
        )}
      </Card>

      <Banner kind="info" icon={<Icon n="schedule" size="lg" />} title="Patterns and shifts">
        A pattern says <b>which days</b>; a shift says <b>which hours</b>. Withdrawing a
        pattern moves nobody and deletes nothing — the people on it keep it, and it
        simply stops being offered for a new assignment. Assign a pattern to somebody
        from their record under People.
      </Banner>
    </div>
  );
}
