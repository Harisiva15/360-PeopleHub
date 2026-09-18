/**
 * Raising an exit, and the conversation at the end of it.
 *
 * Both services were live and unreachable — the resignation button said "not
 * wired in this build" while clearance, settlement and the full-and-final
 * computation all worked perfectly well on an exit nobody could create.
 *
 * **The last working day is the fact everything else hangs off.** Notice,
 * clearance dates and the settlement all count from it, so the form works out
 * what the notice period implies and shows the gap rather than letting someone
 * put a date in and discover the shortfall in the settlement.
 */

import { useState } from 'react';
import type { Employee } from '../../services';
import { addDays, daysBetween, fmtD, parseYmd, TODAY, ymd } from '../../lib/dates';
import { useApp } from '../../state/AppContext';
import { useRaiseExit, useRecordExitInterview } from './data';

const TYPES = [
  { v: 'resignation', n: 'Resignation' },
  { v: 'termination', n: 'Termination' },
  { v: 'retirement', n: 'Retirement' },
  { v: 'end_of_contract', n: 'End of contract' },
  { v: 'absconding', n: 'Absconding' },
];

export function RaiseExitForm({ close, people, meId, canChoosePerson }: {
  close: () => void;
  people: Employee[];
  meId: string;
  /** A manager raises one for somebody; an employee only for themselves. */
  canChoosePerson: boolean;
}) {
  const app = useApp();
  const raise = useRaiseExit();
  const [busy, setBusy] = useState(false);

  const [empId, setEmpId] = useState(meId);
  const [type, setType] = useState('resignation');
  const [resignedOn, setResignedOn] = useState(ymd(TODAY));
  const [noticeDays, setNoticeDays] = useState('60');
  const [lwd, setLwd] = useState(ymd(addDays(TODAY, 60)));
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState('');
  const [buyout, setBuyout] = useState('');

  const person = people.find((e) => e.id === empId);

  /*
   * The notice actually served, against what was agreed. A shortfall is not an
   * error — it is usually bought out or waived — but it should be visible
   * while the date is being chosen rather than turn up in the settlement.
   */
  const served = lwd && resignedOn && lwd >= resignedOn
    ? daysBetween(resignedOn, lwd) : null;
  const owed = Number(noticeDays);
  const short = served !== null && Number.isFinite(owed) ? Math.max(0, owed - served) : 0;

  /* Keep the last working day following the notice period until it is touched. */
  const setNotice = (days: string) => {
    setNoticeDays(days);
    const n = Number(days);
    if (Number.isFinite(n) && n >= 0 && resignedOn) {
      setLwd(ymd(addDays(parseYmd(resignedOn), n)));
    }
  };

  const save = async () => {
    if (!empId) { app.toast('Whose exit is this?', 'err'); return; }
    if (!lwd) { app.toast('Set the last working day', 'err'); return; }
    if (lwd < resignedOn) {
      app.toast('The last working day cannot be before the notice was given', 'err');
      return;
    }
    setBusy(true);
    try {
      await raise.mutate({
        empId, type, resignedOn, lwd,
        noticeDays: Number.isFinite(owed) ? owed : 0,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(destination.trim() ? { destination: destination.trim() } : {}),
        ...(buyout ? { buyout: Number(buyout) } : {}),
      });
      app.toast('Exit raised — clearance starts now', 'ok');
      close();
    } catch (e) {
      /* Somebody already leaving cannot leave twice; the server says so. */
      app.toast(e instanceof Error ? e.message : 'Could not raise the exit', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      {canChoosePerson ? (
        <label className="fld">
          <span>Who is leaving</span>
          <select className="input" value={empId} autoFocus
            onChange={(e) => setEmpId(e.target.value)}>
            {people.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}{e.id === meId ? ' (me)' : ''} — {e.designation}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Resignation for {person?.name ?? 'you'}
        </div>
      )}

      <div className="grid g2">
        <label className="fld">
          <span>Type</span>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}
            disabled={!canChoosePerson}>
            {TYPES.filter((t) => canChoosePerson || t.v === 'resignation')
              .map((t) => <option key={t.v} value={t.v}>{t.n}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Notice given on</span>
          <input className="input" type="date" value={resignedOn}
            onChange={(e) => setResignedOn(e.target.value)} />
        </label>
        <label className="fld">
          <span>Notice period (days)</span>
          <input className="input" type="number" min="0" value={noticeDays}
            onChange={(e) => setNotice(e.target.value)} />
        </label>
        <label className="fld">
          <span>Last working day</span>
          <input className="input" type="date" value={lwd}
            onChange={(e) => setLwd(e.target.value)} />
        </label>
      </div>

      {served !== null && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {served} day{served === 1 ? '' : 's'} of notice served
          {short > 0 && (
            <span style={{ color: 'var(--crit)' }}>
              {' '}— {short} day{short === 1 ? '' : 's'} short of the {owed} agreed
            </span>
          )}
          {' · last day '}{fmtD(lwd)}
        </div>
      )}

      {short > 0 && canChoosePerson && (
        <label className="fld">
          <span>Notice bought out (days)</span>
          <input className="input" type="number" min="0" max={short} value={buyout}
            placeholder={`Up to ${short}`}
            onChange={(e) => setBuyout(e.target.value)} />
        </label>
      )}

      <label className="fld">
        <span>Reason</span>
        <textarea className="input" rows={3} value={reason}
          placeholder="Kept on the record and read at the exit interview."
          onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="fld">
        <span>Going to</span>
        <input className="input" value={destination}
          placeholder="Company, or higher studies — optional"
          onChange={(e) => setDestination(e.target.value)} />
      </label>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Raise exit'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- the exit interview ---------------- */

export function ExitInterviewForm({ close, exitId, who }: {
  close: () => void;
  exitId: string;
  who: string;
}) {
  const app = useApp();
  const record = useRecordExitInterview();
  const [busy, setBusy] = useState(false);

  const [rating, setRating] = useState<number | ''>('');
  const [wouldRejoin, setWouldRejoin] = useState<'' | 'yes' | 'no'>('');
  const [comments, setComments] = useState('');

  const save = async () => {
    if (!comments.trim()) {
      app.toast('Write down what they said — that is the whole point of it', 'err');
      return;
    }
    setBusy(true);
    try {
      await record.mutate(exitId, {
        ...(rating === '' ? {} : { rating }),
        ...(wouldRejoin === '' ? {} : { wouldRejoin: wouldRejoin === 'yes' }),
        comments: comments.trim(),
      });
      app.toast('Exit interview recorded', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not record it', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="muted" style={{ fontSize: 12.5 }}>Exit interview with {who}</div>

      <label className="fld">
        <span>How they rate their time here</span>
        <select className="input" value={rating} autoFocus
          onChange={(e) => setRating(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">Not asked</option>
          <option value="5">5 — Very good</option>
          <option value="4">4 — Good</option>
          <option value="3">3 — Mixed</option>
          <option value="2">2 — Poor</option>
          <option value="1">1 — Very poor</option>
        </select>
      </label>

      <label className="fld">
        <span>Would they come back</span>
        <select className="input" value={wouldRejoin}
          onChange={(e) => setWouldRejoin(e.target.value as typeof wouldRejoin)}>
          <option value="">Not asked</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>

      <label className="fld">
        <span>What they said</span>
        <textarea className="input" rows={7} value={comments}
          placeholder="Why they are leaving, what would have kept them, and what you would change. Written down because the pattern across several of these is what tells you something."
          onChange={(e) => setComments(e.target.value)} />
      </label>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Record interview'}
        </button>
      </div>
    </div>
  );
}
