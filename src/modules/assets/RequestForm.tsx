/**
 * Asking for kit.
 *
 * `requestAsset` was live and the approval side already worked — a request
 * could be approved, rejected and fulfilled from stock. Nobody could raise
 * one, so the queue was always empty and the whole workflow was unreachable
 * from the end it starts at.
 *
 * **What you are entitled to is shown, not enforced.** Grades carry an
 * entitlement, and asking for something outside it is a normal thing to do
 * with a reason attached. The form says what the grade covers and lets the
 * approver decide, rather than refusing and leaving no record of the ask.
 */

import { useState } from 'react';
import type { Employee } from '../../services';
import { ASSET_CATS } from '../../data/assets';
import { entitledTo } from '../../data/assetWorkflow';
import { inr } from '../../lib/format';
import { useApp } from '../../state/AppContext';
import { useRequestAsset } from './data';

export function RequestAssetForm({ close, me }: { close: () => void; me: Employee }) {
  const app = useApp();
  const request = useRequestAsset();
  const [busy, setBusy] = useState(false);

  const [cat, setCat] = useState(ASSET_CATS[0]!.id);
  const [type, setType] = useState('');
  const [reason, setReason] = useState('');
  const [cost, setCost] = useState('');

  const allowed = entitledTo(me);
  const outside = allowed.length > 0 && !allowed.includes(cat);

  const save = async () => {
    if (!type.trim()) { app.toast('Say what you need', 'err'); return; }
    /*
     * A reason is what the approver reads. "Laptop" with no reason is a
     * request somebody has to come back and ask about, which is slower for
     * everyone than writing a line now.
     */
    if (reason.trim().length < 10) {
      app.toast('Say what it is for — that is what the approver reads', 'err');
      return;
    }
    setBusy(true);
    try {
      await request.mutate({
        cat, type: type.trim(), reason: reason.trim(),
        ...(cost ? { cost: Number(cost) } : {}),
      });
      app.toast('Request raised', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not raise the request', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <label className="fld">
        <span>What kind</span>
        <select className="input" value={cat} autoFocus
          onChange={(e) => setCat(e.target.value)}>
          {ASSET_CATS.map((c) => <option key={c.id} value={c.id}>{c.n}</option>)}
        </select>
      </label>

      {outside && (
        <div className="muted" style={{ fontSize: 12.5, color: 'var(--t-amber-ink)' }}>
          Outside what grade {me.grade} usually covers. You can still ask — say why
          below and it goes to your approver like any other request.
        </div>
      )}

      <label className="fld">
        <span>Which one</span>
        <input className="input" value={type}
          placeholder='MacBook Pro 14" · Dell 24" monitor · Jabra headset'
          onChange={(e) => setType(e.target.value)} />
      </label>

      <label className="fld">
        <span>What it is for</span>
        <textarea className="input" rows={4} value={reason}
          placeholder="What you are doing that needs it, and what you have now."
          onChange={(e) => setReason(e.target.value)} />
      </label>

      <label className="fld">
        <span>Indicative cost</span>
        <input className="input" type="number" min="0" value={cost}
          placeholder="Optional — helps the approver"
          onChange={(e) => setCost(e.target.value)} />
      </label>
      {cost && Number(cost) > 100000 && (
        <div className="muted" style={{ fontSize: 12 }}>
          Above {inr(100000)} this needs a second approval from finance.
        </div>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Raise request'}
        </button>
      </div>
    </div>
  );
}
