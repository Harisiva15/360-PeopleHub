/**
 * What somebody is told before a punch ever records where they are.
 *
 * **Notice, not consent.** The retention register declares legitimate interest
 * as the basis. Asking somebody to agree and then processing anyway if they
 * decline is worse than not asking, so this does not pretend to be a choice
 * about whether location is lawful to collect — it is the telling, which is
 * what the DPDP Act requires alongside that basis.
 *
 * **Declining is real.** Until the notice is acknowledged the server discards
 * any coordinates a punch carries, and it keeps discarding them if the person
 * closes this without acknowledging. The punch still goes through and still
 * counts; it is simply recorded with nothing measured. A dialog that blocked
 * the punch would be a payroll fault dressed as a privacy control.
 *
 * The wording lives on the server and arrives with its version number, so what
 * was acknowledged and what is shown cannot drift apart.
 */

import { useState } from 'react';
import type { LocationNotice } from '../../services';
import { useApp } from '../../state/AppContext';
import { useAcknowledgeLocationNotice } from './data';

export function LocationNoticeBody(
  { close, notice, onDone }:
  { close: () => void; notice: LocationNotice; onDone: (acknowledged: boolean) => void },
) {
  const app = useApp();
  const ack = useAcknowledgeLocationNotice();
  const [busy, setBusy] = useState(false);

  const accept = async () => {
    setBusy(true);
    try {
      await ack.mutate();
      onDone(true);
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not record that', 'err');
      setBusy(false);
    }
  };

  const decline = () => {
    onDone(false);
    close();
  };

  return (
    <div className="stack">
      {notice.body.map((para) => (
        <p key={para} style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{para}</p>
      ))}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        {/*
          * "Not now" rather than "Cancel": nothing is being cancelled, the
          * punch happens either way. The two buttons differ only in whether a
          * position goes with it.
          */}
        <button className="btn" onClick={decline} disabled={busy}>
          Punch without location
        </button>
        <button className="btn primary" onClick={accept} disabled={busy}>
          {busy ? 'Saving…' : 'I understand — continue'}
        </button>
      </div>
    </div>
  );
}
