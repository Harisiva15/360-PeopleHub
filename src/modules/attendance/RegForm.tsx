/**
 * The attendance-correction request, and the one way to open it.
 *
 * ## Why it moved out of `index.tsx`
 *
 * The punch card needs to open this dialog. A punch outside every shift window
 * is refused — more than two hours before a shift starts or four after one
 * ends, there is no instance to attach it to — and the only honest answer is
 * "that is a correction, not a punch". Offering the correction at the moment of
 * the refusal, on the right day, is the difference between a dead end and a
 * next step.
 *
 * `index.tsx` imports `Punch.tsx`, so `Punch.tsx` cannot import `index.tsx`.
 * Rather than a second copy of the form beside the punch card — which is how
 * two dialogs with the same title and different fields happen — the form and
 * the opener live here and both screens call `useOpenRegularisation`.
 *
 * ## Why the prefill is a date and not a day the server offered
 *
 * `useRegularisableDays` lists days with an attendance row that needs fixing:
 * absences and missing punches. A punch refused outside the window left *no*
 * row at all, so the day it should be raised for is not in that list and the
 * select could not show it. It is passed in instead, and the server's own
 * refusal is where it comes from — `detail.localDate`, the day in the shift's
 * own timezone, not the browser's, because for anybody on hours measured in
 * another zone those are different days twice a day.
 */

import { useState } from 'react';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { usePeople, useRaiseRegularisation, useRegularisableDays } from './data';

/** What the screen already knows, so the person does not retype it. */
export interface RegPrefill {
  /** `YYYY-MM-DD`, in the shift's own zone. Offered even if not in the list. */
  date?: string | undefined;
  /** One of the reasons the select holds; anything else is ignored. */
  reason?: string | undefined;
  /** Dropped into the notes box, where it can be edited or deleted. */
  note?: string | undefined;
}

const REASONS = [
  'Forgot to punch in', 'Forgot to punch out', 'Biometric device down',
  'Working from client location', 'Network / app issue', 'On official travel',
  'Worked outside my shift window', 'Other',
];

export function RegForm({ close, prefill }: { close: () => void; prefill?: RegPrefill }) {
  const app = useApp();
  const me = app.me;
  const { data: missing = [] } = useRegularisableDays(me.id, ymd(addDays(TODAY, -30)));
  const raise = useRaiseRegularisation();

  const [picked, setPicked] = useState(prefill?.date ?? '');
  const [inT, setInT] = useState('09:30');
  const [outT, setOutT] = useState('18:30');
  const [reason, setReason] = useState(
    prefill?.reason && REASONS.includes(prefill.reason) ? prefill.reason : REASONS[0]!);
  const [note, setNote] = useState(prefill?.note ?? '');
  const [err, setErr] = useState('');

  /* The candidate days arrive asynchronously, so default once they are in. */
  const date = picked || prefill?.date || missing[0]?.date || ymd(addDays(TODAY, -1));

  /*
   * The prefilled day, as an option, when the server's list does not hold it —
   * which is the whole point of the prefill. Without this the select would
   * silently show a different day from the one the refusal named, and the
   * request would be raised against it.
   */
  const extra = prefill?.date && !missing.some((r) => r.date === prefill.date)
    ? prefill.date
    : null;

  const submit = async () => {
    setErr('');
    try {
      await raise.mutate(me.id, date, inT, outT, reason + (note ? ' — ' + note : ''));
      close();
      app.toast('Regularisation request submitted', 'ok');
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'Could not submit the request');
    }
  };

  return (
    <>
      {err && <div className="banner err" role="alert">{err}</div>}
      <div className="field">
        <label htmlFor="reg-date">Date</label>
        <select id="reg-date" className="input" value={date}
          onChange={(e) => setPicked(e.target.value)}>
          {extra && (
            <option value={extra}>{fmtD(extra)} — the day this is about</option>
          )}
          {missing.length ? missing.map((r) => (
            <option key={r.date} value={r.date}>
              {fmtD(r.date)} — {r.status === 'A' ? 'Absent' : 'Missing punch'}
            </option>
          )) : !extra && (
            <option value={ymd(addDays(TODAY, -1))}>{fmtD(addDays(TODAY, -1))}</option>
          )}
        </select>
      </div>
      <div className="grid g2">
        <div className="field">
          <label htmlFor="reg-in">Punch in</label>
          <input id="reg-in" type="time" className="input" value={inT}
            onChange={(e) => setInT(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="reg-out">Punch out</label>
          <input id="reg-out" type="time" className="input" value={outT}
            onChange={(e) => setOutT(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="reg-reason">Reason</label>
        <select id="reg-reason" className="input" value={reason}
          onChange={(e) => setReason(e.target.value)}>
          {REASONS.map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="reg-note">Additional notes</label>
        <textarea id="reg-note" className="input" placeholder="Give your manager context…"
          value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={() => void submit()}
          disabled={raise.pending}>
          Submit request
        </button>
      </div>
    </>
  );
}

/**
 * Opens the correction dialog, optionally knowing what it is about.
 *
 * One opener, so the title, the "goes to <manager> for approval" subtitle and
 * the form are the same wherever it is reached from — the Regularisation tab,
 * My Attendance, or a refused punch.
 */
export function useOpenRegularisation(): (prefill?: RegPrefill) => void {
  const app = useApp();
  const layer = useLayer();
  const approver = usePeople([app.me.managerId]);

  return (prefill?: RegPrefill) => layer.modal({
    title: 'Request attendance regularisation',
    sub: 'Goes to ' + approver.name(app.me.managerId) + ' for approval',
    body: (close: () => void) => <RegForm close={close} prefill={prefill} />,
    footer: null,
  });
}
