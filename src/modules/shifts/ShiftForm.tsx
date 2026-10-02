/**
 * The shift editor.
 *
 * Its own file because `index.tsx` already holds seven components and oxlint's
 * `only-export-components` fires on each one that is not exported — the warning is
 * about fast refresh, and a form rendered inside a modal is exactly the thing worth
 * reloading without losing the rest of the screen. The other six are left where
 * they are: this moves the component that arrived with 2g-B, not the file's history.
 *
 * `RosterView` sets the precedent — the shift module already keeps one exported
 * component per file next to `index.tsx`.
 */

import { useState } from 'react';

import { Banner } from '../../components/ui';
import { COUNTRIES } from '../../data/countries';
import type { ShiftDraft } from '../../services';
/**
 * The zones a profile may be measured against.
 *
 * Derived from the countries this product already knows, rather than offering the
 * browser's several hundred: a shift exists for a region the company operates in,
 * and the server verifies whatever arrives against the database's own zone list
 * anyway. A free-text field would let somebody save a string that breaks punching.
 */
const TIMEZONES = [
  'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'Europe/London',
  'Asia/Dubai', 'America/Toronto', 'Asia/Singapore', 'Australia/Sydney', 'UTC',
];

/**
 * The shift editor.
 *
 * The code is the profile's identity — `employee.shift_id`, `attendance.shift_id`
 * and `site.default_shift_id` all point at the row, and a roster and a joining
 * request quote the code — so it is set once and shown afterwards. Renaming is what
 * the name field is for.
 *
 * Nothing here decides what may be saved. A duplicate code, an unknown timezone,
 * hours that run backwards, and the refusal that matters most — editing an
 * attendance-relevant setting on a profile that already has punches against it —
 * are all the server's, and the refusal is shown where it happened rather than
 * guessed at first.
 */
export function ShiftForm({ initial, editing, hasHistory, onChange }: {
  initial: ShiftDraft;
  editing: boolean;
  /**
   * Whether the server will refuse the attendance-relevant fields.
   *
   * Derived from headcount, which is the only signal this screen has — the profile
   * list does not carry an attendance count. So it is a warning, not a gate: the
   * fields stay editable and the server decides, because guessing wrong here would
   * lock an administrator out of a change that is actually allowed.
   */
  hasHistory: boolean;
  onChange: (v: ShiftDraft) => void;
}) {
  const [v, setV] = useState<ShiftDraft>(initial);
  const set = (patch: ShiftDraft) => {
    const next = { ...v, ...patch };
    setV(next);
    onChange(next);
  };

  return (
    <div className="stack">
      <div className="grid g2" style={{ gap: '0 14px' }}>
        <div className="field">
          <label htmlFor="sh-code">Code</label>
          <input id="sh-code" className="input" value={v.code ?? ''} disabled={editing}
            maxLength={12} placeholder="IN"
            onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          <span className="muted" style={{ fontSize: 11.5 }}>
            {editing
              ? 'Every employee, punch and site default joins on the code, so it cannot change.'
              : '2–12 characters: letters, digits, hyphen or underscore. It cannot be changed later.'}
          </span>
        </div>
        <div className="field">
          <label htmlFor="sh-name">Name</label>
          <input id="sh-name" className="input" value={v.name ?? ''}
            placeholder="India Shift" onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sh-start">Starts at</label>
          <input id="sh-start" className="input" type="time" value={v.startsAt ?? ''}
            onChange={(e) => set({ startsAt: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sh-end">Ends at</label>
          <input id="sh-end" className="input" type="time" value={v.endsAt ?? ''}
            onChange={(e) => set({ endsAt: e.target.value })} />
          <span className="muted" style={{ fontSize: 11.5 }}>
            Must be after the start. Overnight hours are not supported yet.
          </span>
        </div>
        <div className="field">
          <label htmlFor="sh-tz">Measured against</label>
          <select id="sh-tz" className="input" value={v.timezone ?? ''}
            onChange={(e) => set({ timezone: e.target.value })}>
            <option value="">Choose a timezone</option>
            {TIMEZONES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 11.5 }}>
            The clock lateness is judged against — not the office somebody sits in.
          </span>
        </div>
        <div className="field">
          <label htmlFor="sh-region">Region</label>
          <select id="sh-region" className="input" value={v.region ?? ''}
            onChange={(e) => set({ region: e.target.value || null })}>
            <option value="">None</option>
            {COUNTRIES.map((c) => <option key={c.id} value={c.id}>{c.flag} {c.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sh-break">Unpaid break (minutes)</label>
          <input id="sh-break" className="input" type="number" min={0} max={480}
            value={v.breakMinutes ?? 60}
            onChange={(e) => set({ breakMinutes: Number(e.target.value) })} />
          <span className="muted" style={{ fontSize: 11.5 }}>
            Deducted from worked time on every punch-out.
          </span>
        </div>
        <div className="field">
          <label htmlFor="sh-grace">Late grace (minutes)</label>
          <input id="sh-grace" className="input" type="number" min={0} max={240}
            value={v.graceMinutes ?? 10}
            onChange={(e) => set({ graceMinutes: Number(e.target.value) })} />
          <span className="muted" style={{ fontSize: 11.5 }}>
            How late somebody may punch in before being marked late.
          </span>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 14 }}>
        <label className="row" style={{ gap: 6 }}>
          <input id="sh-night" type="checkbox" checked={v.isNight ?? false}
            onChange={(e) => set({ isNight: e.target.checked })} />
          <span>Night shift</span>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input id="sh-flexible" type="checkbox" checked={v.isFlexible ?? false}
            onChange={(e) => set({ isFlexible: e.target.checked })} />
          <span>Flexible hours</span>
        </label>
      </div>

      {/*
        * The refusal this form is most likely to meet, said before it is met.
        *
        * Shown on any profile with people on it rather than only on one with
        * punches, because the list does not carry an attendance count — so this
        * over-warns rather than under-warns, and the server is what actually
        * decides.
        */}
      {editing && hasHistory && (
        <Banner kind="warn">
          People are on this profile, so it may already have attendance recorded
          against it. The start time, timezone, break and grace cannot be changed
          once it has — create a new profile instead. The name, end time, region and
          flags can always be corrected.
        </Banner>
      )}
    </div>
  );
}
