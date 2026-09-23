/**
 * The confirmation before a payroll cycle is processed.
 *
 * Processing was one click from the runs screen with nothing in between, and a
 * real September 2026 cycle was processed that way during development — on
 * live data, by accident. Nothing was corrupted, because a payslip is stored
 * rather than recomputed and a paid run locks. But the click that did it was
 * indistinguishable from the click that opens a register.
 *
 * **This says what will happen, not "are you sure".** A generic prompt teaches
 * people to dismiss prompts. This one names the month, the head count and the
 * two figures, so the thing being agreed to is legible before the agreement:
 * somebody who clicked the wrong row sees the wrong month here.
 *
 * **The acknowledgement is a checkbox, not typing.** Deleting a user asks for
 * the word DELETE because it is destructive and rare. Processing payroll is
 * neither destructive nor rare — it is meant to happen every month — so the
 * bar is deliberateness rather than ceremony. Making it tedious would train
 * people to rush it.
 *
 * **It is not the protection.** The server refuses a cycle that is paid,
 * locked, cancelled or mid-process, holding the row `FOR UPDATE` while it
 * decides, so a second request waits and is then refused rather than
 * overwriting the first one's payslips. This dialog stops the accident; the
 * server stops the damage.
 */

import { useState } from 'react';
import { inr } from '../../lib/format';
import { monthLabelLong } from '../../lib/dates';
import { Banner, KV } from '../../components/ui';
import { Icon } from '../../components/icons';

export interface RunPreview {
  mk: string;
  count: number;
  gross: number;
  net: number;
}

export function ProcessConfirmation({ run, onConfirm, close }: {
  run: RunPreview;
  onConfirm: () => Promise<void>;
  close: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const go = async () => {
    /*
     * Guarded as well as disabled. A second call can arrive from a double
     * click, a keyboard repeat, or a re-render that lands between the click
     * and the disable — and the button being disabled is a picture of the
     * state, not the state itself.
     */
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await onConfirm();
      close();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not process the run');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
        You are about to process payroll for <b>{monthLabelLong(run.mk)}</b>.
      </p>

      <KV rows={[
        ['Payroll period', <b>{monthLabelLong(run.mk)}</b>],
        ['Employees', <b>{run.count}</b>],
        ['Estimated gross payroll', inr(run.gross)],
        ['Estimated net payroll', <b>{inr(run.net)}</b>],
        ['Payslips', `${run.count} will be generated and frozen`],
        ['Bank batch', 'Will be generated'],
      ]} />

      <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="After processing">
        The cycle is locked and its payslips are frozen — they are stored, not
        recomputed, so a later change to a salary or an attendance record will
        not alter them. A bank advice is generated. The run cannot be processed
        again, and there is no undo from this screen.
      </Banner>

      {run.count === 0 && (
        <Banner kind="warn" title="Nobody is on this payroll">
          There are no employees to pay for this period. Processing would lock
          the cycle and produce an empty bank advice.
        </Banner>
      )}

      <label className="row" style={{ gap: 9, cursor: 'pointer', alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={understood}
          disabled={busy}
          style={{ marginTop: 3 }}
          onChange={(e) => setUnderstood(e.target.checked)}
        />
        <span style={{ fontSize: 12.5, lineHeight: 1.55 }}>
          I understand that processing this payroll will lock the payroll run
          and generate payslips and a bank advice.
        </span>
      </label>

      {err && <div className="ts-err-box">⚠ {err}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button className="btn primary" disabled={!understood || busy} onClick={go}>
          {busy ? 'Processing…' : 'Process payroll'}
        </button>
      </div>
    </div>
  );
}
