/**
 * Moving a site's geo-fence.
 *
 * `updateFence` had been routed, guarded and tenant-scoped on the server since
 * the config module was written, and was never mapped on the client — so the
 * whole chain existed except its middle. Coordinates were collected at
 * punch-in and stored; the fence they are measured against could not be set
 * from anywhere.
 *
 * **A zero radius is refused, here and on the server.** It would put every
 * punch at the site outside the fence, which reads to whoever reviews
 * attendance as a fault in the system rather than as a policy somebody chose.
 *
 * **Moving a fence does not rewrite history.** `attendance.distance_m` is
 * stored alongside the coordinates precisely because the radius can move
 * afterwards, and the distance at the time of the punch is what the decision
 * was actually made on. The form says so, because "will this re-flag last
 * month" is the first thing anyone asks.
 */

import { useState } from 'react';
import type { Site } from '../../types/org';
import { useApp } from '../../state/AppContext';
import { useUpdateFence } from './data';
import { Icon } from '../../components/icons';

export function FenceForm({ close, site }: { close: () => void; site: Site }) {
  const app = useApp();
  const update = useUpdateFence();
  const [busy, setBusy] = useState(false);

  const [lat, setLat] = useState(String(site.lat ?? ''));
  const [lng, setLng] = useState(String(site.lng ?? ''));
  const [radius, setRadius] = useState(String(site.radius ?? 200));

  const save = async () => {
    const la = Number(lat);
    const ln = Number(lng);
    const r = Math.round(Number(radius));

    if (!Number.isFinite(la) || la < -90 || la > 90) {
      app.toast('Latitude is between −90 and 90', 'err'); return;
    }
    if (!Number.isFinite(ln) || ln < -180 || ln > 180) {
      app.toast('Longitude is between −180 and 180', 'err'); return;
    }
    if (!Number.isFinite(r) || r <= 0) {
      app.toast('A radius of zero would put every punch outside the fence', 'err'); return;
    }

    setBusy(true);
    try {
      await update.mutate(site.id, { lat: la, lng: ln, radius: r });
      app.toast(`${site.name} fence updated`, 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not move the fence', 'err');
    } finally { setBusy(false); }
  };

  /* Fills the boxes from where the person setting this up is standing. */
  const useMyPosition = () => {
    if (!navigator.geolocation) { app.toast('This browser has no location', 'err'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLng(p.coords.longitude.toFixed(6));
        app.toast('Filled from your current position', 'ok');
      },
      () => app.toast('Could not read your position', 'err'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  return (
    <div className="stack">
      <div className="muted" style={{ fontSize: 12.5 }}>
        A punch inside this circle is marked within the fence. One outside it is
        flagged for whoever reviews attendance — it is not refused.
      </div>

      <div className="grid g2" style={{ gap: '0 14px' }}>
        <label className="fld">
          <span>Latitude</span>
          <input className="input" value={lat} inputMode="decimal" autoFocus
            placeholder="12.991100" onChange={(e) => setLat(e.target.value)} />
        </label>
        <label className="fld">
          <span>Longitude</span>
          <input className="input" value={lng} inputMode="decimal"
            placeholder="80.250300" onChange={(e) => setLng(e.target.value)} />
        </label>
      </div>

      <div className="row">
        <button className="btn sm" onClick={useMyPosition}><Icon n="location" size="lg" /> Use my current position</button>
      </div>

      <label className="fld">
        <span>Radius in metres</span>
        <input className="input" type="number" min="1" value={radius}
          onChange={(e) => setRadius(e.target.value)} />
      </label>
      <div className="muted" style={{ fontSize: 12 }}>
        200–250 m suits a single building with its car park. Too tight and
        somebody punching from the far end of the floor is flagged every day.
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        Moving the fence applies from now on. Punches already recorded keep the
        distance they were measured at, so nothing is re-flagged retrospectively.
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Move the fence'}
        </button>
      </div>
    </div>
  );
}
