/**
 * Asking HR for a letter.
 *
 * `issue` was live and the HR queue could act on a request, but nothing could
 * raise one — so the queue was permanently empty and the workflow existed only
 * for rows somebody had invented. This is the end it starts at.
 *
 * **An instant letter is not a request.** A salary certificate states what you
 * are paid, which is true the moment you ask; queuing it for a human is
 * ceremony. The form says which is which before you commit, because "your
 * letter is ready" and "we will get back to you in two working days" are very
 * different answers to plan around.
 */

import { useState } from 'react';
import type { LetterTypeRow } from '../../services';
import { useApp } from '../../state/AppContext';
import { useRequestLetter } from './data';

/** Purposes people actually give, offered so the box is not a blank stare. */
const PURPOSES = [
  'Home loan', 'Visa application', 'Passport renewal', 'Bank account opening',
  'Higher studies', 'New employer', 'Rental agreement',
];

export function RequestLetterForm(
  { close, types, preselect }:
  { close: () => void; types: LetterTypeRow[]; preselect?: string },
) {
  const app = useApp();
  const request = useRequestLetter();
  const [busy, setBusy] = useState(false);

  const [type, setType] = useState(preselect ?? types[0]?.code ?? '');
  const [purpose, setPurpose] = useState('');

  const chosen = types.find((t) => t.code === type);

  const save = async () => {
    if (!type) { app.toast('Choose which letter you need', 'err'); return; }
    setBusy(true);
    try {
      const made = await request.mutate({ type, ...(purpose.trim() ? { purpose: purpose.trim() } : {}) });
      app.toast(made.status === 'Issued'
        ? 'Letter issued — it is in your documents now'
        : 'Request sent to HR', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not request the letter', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <label className="fld">
        <span>Which letter</span>
        <select className="input" value={type} autoFocus
          onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}{t.instant ? ' — instant' : ''}
            </option>
          ))}
        </select>
      </label>

      {chosen && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          {chosen.instant
            ? 'Generated straight away from your employment record. No waiting.'
            : 'Goes to HR to check and issue. You will see it here once it is ready.'}
        </div>
      )}

      <label className="fld">
        <span>What it is for</span>
        <input className="input" value={purpose} list="letter-purposes"
          placeholder="Home loan · visa application · new employer"
          onChange={(e) => setPurpose(e.target.value)} />
        <datalist id="letter-purposes">
          {PURPOSES.map((p) => <option key={p} value={p} />)}
        </datalist>
      </label>
      <div className="muted" style={{ fontSize: 12 }}>
        {/*
          * The purpose is printed in the letter, so it is worth saying what it
          * is used for rather than letting somebody write something they would
          * not want a bank to read.
          */}
        This appears in the letter itself, and HR sees it.
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Sending…' : chosen?.instant ? 'Generate letter' : 'Send request'}
        </button>
      </div>
    </div>
  );
}
