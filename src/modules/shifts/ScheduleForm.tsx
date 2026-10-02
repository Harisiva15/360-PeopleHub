/**
 * The seven-weekday form behind "Add a working pattern".
 *
 * Its own module so the screen that opens it stays a screen, and because a form
 * with seven interdependent rows is the one piece of this phase worth reading on
 * its own.
 *
 * ## Seven rows, always
 *
 * The server writes all seven weekdays on every create and refuses a partial
 * schedule — a gap would answer "is Wednesday worked" with nothing. So the form
 * starts from seven rows rather than letting somebody add them, which also means
 * there is no way to produce a duplicate weekday: the row *is* the weekday.
 *
 * ## A day off names no shift
 *
 * `work_schedule_day_off_has_no_shift` enforces that in the database. Turning a
 * row off here clears its shift and disables the selector, so the refusal is
 * something the form cannot reach rather than something it reports.
 *
 * ## Only shifts the server would accept
 *
 * An inactive shift cannot be newly assigned, so the selector offers active ones —
 * except where this schedule already names an inactive shift, which stays in the
 * list so editing an unrelated row does not silently drop it. That mirrors exactly
 * what the service allows, and the service is still the authority: if it refuses,
 * the screen shows what it said.
 */

import { useState } from 'react';
import { Badge } from '../../components/ui';
import type { ShiftProfile, WorkScheduleDayDraft } from '../../services';
import { WEEKDAYS, type ScheduleDraft } from './weekdays';

export function ScheduleForm(
  { initial, editing, profiles, onChange }: {
    initial: ScheduleDraft;
    editing: boolean;
    profiles: ShiftProfile[];
    onChange: (v: ScheduleDraft) => void;
  },
) {
  const [v, setV] = useState<ScheduleDraft>(initial);
  const set = (patch: Partial<ScheduleDraft>) => {
    const next = { ...v, ...patch };
    setV(next);
    onChange(next);
  };

  const setDay = (dow: number, patch: Partial<WorkScheduleDayDraft>) =>
    set({
      days: v.days.map((d) => (d.dayOfWeek === dow ? { ...d, ...patch } : d)),
    });

  /*
   * Immediate feedback on the two things the server requires, so somebody is not
   * told after pressing Save. These are a convenience, never a gate: the service
   * checks the same things and is what actually decides.
   */
  const codeBad = v.code.trim() === '' ? 'A code is needed' : null;
  const nameBad = v.name.trim() === '' ? 'A name is needed' : null;
  const workingCount = v.days.filter((d) => d.working).length;

  /* Active shifts, plus any inactive one this schedule already names. */
  const named = new Set(v.days.map((d) => d.shiftCode).filter(Boolean) as string[]);
  const offerable = profiles.filter((p) => p.active || named.has(p.code));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid g2">
        <div className="field">
          <label htmlFor="sched-code">Code<span className="req">*</span></label>
          <input id="sched-code" className="input" value={v.code} disabled={editing}
            maxLength={16} placeholder="SIX_DAY"
            aria-invalid={codeBad ? true : undefined}
            aria-describedby={codeBad ? 'sched-code-err' : 'sched-code-hint'}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          {codeBad
            ? <div id="sched-code-err" style={{ fontSize: 11.5, color: 'var(--crit-text)' }}>{codeBad}</div>
            : (
              <div className="muted" id="sched-code-hint" style={{ fontSize: 11.5 }}>
                {editing
                  ? 'A code cannot change — every assignment joins on it'
                  : '2–16 characters: letters, digits, hyphen or underscore'}
              </div>
            )}
        </div>
        <div className="field">
          <label htmlFor="sched-name">Name<span className="req">*</span></label>
          <input id="sched-name" className="input" value={v.name} maxLength={120}
            placeholder="Six-day week"
            aria-invalid={nameBad ? true : undefined}
            aria-describedby={nameBad ? 'sched-name-err' : undefined}
            onChange={(e) => set({ name: e.target.value })} />
          {nameBad && <div id="sched-name-err" style={{ fontSize: 11.5, color: 'var(--crit-text)' }}>{nameBad}</div>}
        </div>
      </div>

      <div className="field">
        <label htmlFor="sched-desc">Description</label>
        <input id="sched-desc" className="input" value={v.description} maxLength={240}
          placeholder="Who this pattern is for"
          onChange={(e) => set({ description: e.target.value })} />
      </div>

      <div>
        <div className="row" style={{ alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Which days are worked</div>
          <Badge kind={workingCount === 0 ? 'warn' : 'info'}>
            {workingCount} of 7 worked
          </Badge>
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
          A pattern says <b>which days</b>. The hours come from the shift — leave a day
          on the person&rsquo;s own shift unless that weekday genuinely runs different hours.
        </div>

        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ minWidth: 104 }}>Day</th>
                <th style={{ minWidth: 150 }}>Worked</th>
                <th>Shift</th>
              </tr>
            </thead>
            <tbody>
              {WEEKDAYS.map((w) => {
                const row = v.days.find((d) => d.dayOfWeek === w.dow)!;
                return (
                  <tr key={w.dow}>
                    <th scope="row" style={{ fontWeight: 600, textAlign: 'left' }}>{w.name}</th>
                    <td>
                      <select className="input sm" value={row.working ? 'y' : 'n'}
                        aria-label={`Is ${w.name} worked?`}
                        onChange={(e) => {
                          const working = e.target.value === 'y';
                          /* A day off carries no shift — the schema refuses one. */
                          setDay(w.dow, { working, shiftCode: working ? row.shiftCode : null });
                        }}>
                        <option value="y">Working</option>
                        <option value="n">Off</option>
                      </select>
                    </td>
                    <td>
                      <select className="input sm" value={row.shiftCode ?? ''}
                        disabled={!row.working}
                        aria-label={`Shift on ${w.name}`}
                        onChange={(e) => setDay(w.dow, { shiftCode: e.target.value || null })}>
                        <option value="">
                          {row.working ? 'The person’s own shift' : '—'}
                        </option>
                        {offerable.map((p) => (
                          <option key={p.code} value={p.code}>
                            {p.name}{p.active ? '' : ' (withdrawn)'}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
