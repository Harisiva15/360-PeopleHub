import { useEffect, useState } from 'react';
import { sum } from '../../lib/collections';
import { DOW, fmtD, fmtTime, hhmm, TODAY, ymd } from '../../lib/dates';
import { clamp, distM } from '../../lib/format';
import { ATT, ATT_IDX, attOf } from '../../data/attendance';
import type { AttRecord } from '../../data/attendance';
import { EMAP } from '../../data/employees';
import { siteOf } from '../../data/org';
import type { Site } from '../../types/org';
import { Banner, KV } from '../../components/ui';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';

const nowHM = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

const nowHMS = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
};

export interface Loc {
  lat: number;
  lng: number;
  /** Accuracy radius in metres. */
  acc: number;
  /** False when the browser refused or timed out and we fell back. */
  real: boolean;
}

/**
 * Ask the browser for a fix, falling back to a plausible point near the
 * employee's base site if permission is denied or it takes too long.
 */
export function resolveLocation(empId: string, mode: string, cb: (l: Loc) => void): void {
  const e = EMAP[empId];
  const base = siteOf(e.site === 'WFH' ? 'CHN' : e.site);
  const fallback = () => {
    const spread = mode === 'WFH' ? 0.09 : 0.0016;
    cb({
      lat: +(base.lat! + (Math.random() - 0.5) * spread).toFixed(5),
      lng: +(base.lng! + (Math.random() - 0.5) * spread).toFixed(5),
      acc: 12 + Math.round(Math.random() * 30),
      real: false,
    });
  };

  if (!navigator.geolocation) return fallback();
  let done = false;
  const t = setTimeout(() => {
    if (!done) {
      done = true;
      fallback();
    }
  }, 2500);

  try {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        cb({
          lat: +p.coords.latitude.toFixed(5),
          lng: +p.coords.longitude.toFixed(5),
          acc: Math.round(p.coords.accuracy),
          real: true,
        });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        fallback();
      },
      { timeout: 2400, maximumAge: 60000 },
    );
  } catch {
    clearTimeout(t);
    fallback();
  }
}

export interface Fence {
  ok: boolean;
  dist: number | null;
  site: string;
  msg: string;
}

/** WFH and client-site punches are logged but not fenced. */
export function evalFence(mode: string, loc: Loc): Fence {
  if (mode === 'WFH' || mode === 'CLIENT') {
    return {
      ok: true,
      dist: null,
      site: mode,
      msg:
        mode === 'WFH'
          ? 'Work-from-home punch — location logged, fence not enforced'
          : 'Client-site punch — location logged for audit',
    };
  }
  const s = siteOf(mode);
  const d = distM(s.lat!, s.lng!, loc.lat, loc.lng);
  return {
    ok: d <= s.radius,
    dist: d,
    site: mode,
    msg:
      d <= s.radius
        ? `Inside ${s.name} geo-fence (${d} m of ${s.radius} m)`
        : `Outside ${s.name} geo-fence — ${d} m away (limit ${s.radius} m). Punch will be flagged for approval.`,
  };
}

/* ---------------- schematic map ---------------- */

export interface MapPoint {
  lat: number | null;
  lng: number | null;
  label: string;
  sub?: string;
  me?: boolean;
  bad?: boolean;
}

/** Plots points relative to a site centre. Not a real map — a schematic. */
export function MapBox({ points, site, height = 200 }: { points: MapPoint[]; site?: Site | null; height?: number }) {
  const pts = points.filter((p) => p.lat != null) as { lat: number; lng: number; label: string; sub?: string; me?: boolean; bad?: boolean }[];

  let cLat: number;
  let cLng: number;
  let span: number;

  if (site) {
    cLat = site.lat!;
    cLng = site.lng!;
    span = Math.max(
      (site.radius * 2.8) / 111000,
      ...pts.map((p) => Math.max(Math.abs(p.lat - cLat), Math.abs(p.lng - cLng)) * 2.3),
    );
  } else if (pts.length) {
    cLat = sum(pts, (p) => p.lat) / pts.length;
    cLng = sum(pts, (p) => p.lng) / pts.length;
    span = Math.max(0.02, ...pts.map((p) => Math.max(Math.abs(p.lat - cLat), Math.abs(p.lng - cLng)) * 2.4));
  } else {
    return (
      <div className="map" style={{ height }}>
        <div className="grid-lines" />
      </div>
    );
  }

  const X = (lng: number) => ((lng - cLng) / span + 0.5) * 100;
  const Y = (lat: number) => (0.5 - (lat - cLat) / span) * 100;
  const rPct = site ? ((site.radius / 111000) / span) * 200 : 0;

  return (
    <div className="map" style={{ height, marginTop: 12 }}>
      <div className="grid-lines" />
      <div className="mapsq">
        {site && (
          <>
            <div
              className="fence"
              style={{ left: '50%', top: '50%', width: rPct.toFixed(2) + '%', height: rPct.toFixed(2) + '%', transform: 'translate(-50%,-50%)' }}
            />
            <div className="pin" style={{ left: '50%', top: '50%', zIndex: 3 }} data-tip={`${site.name} · fence ${site.radius} m`}>
              🏢
            </div>
            <div className="lbl" style={{ left: '50%', top: '51%', zIndex: 3 }}>
              {site.name}
            </div>
          </>
        )}
        {pts.map((p, i) => (
          <div
            key={i}
            className="pin"
            style={{
              left: clamp(X(p.lng), 2, 98).toFixed(2) + '%',
              top: clamp(Y(p.lat), 5, 97).toFixed(2) + '%',
              ...(p.bad ? { zIndex: 4 } : {}),
            }}
            data-tip={`${p.label} · ${p.lat}, ${p.lng}${p.sub ? ' · ' + p.sub : ''}`}
          >
            {p.me ? '📍' : p.bad ? '❗' : '👤'}
          </div>
        ))}
      </div>
      <div
        style={{
          position: 'absolute', left: 8, bottom: 8, fontSize: 10, color: 'var(--ink-3)',
          background: 'var(--surface)', padding: '2px 7px', borderRadius: 5, border: '1px solid var(--line)',
        }}
      >
        Schematic view · {Math.round(span * 111000)} m across
      </div>
    </div>
  );
}

/* ---------------- punch widget ---------------- */

export function PunchWidget({ empId }: { empId: string }) {
  const app = useApp();
  const layer = useLayer();
  const e = EMAP[empId];
  const [mode, setMode] = useState(e.site === 'WFH' ? 'WFH' : e.site);
  const [clock, setClock] = useState(nowHMS);

  useEffect(() => {
    const t = setInterval(() => setClock(nowHMS()), 1000);
    return () => clearInterval(t);
  }, []);

  const rec = attOf(empId, ymd(TODAY));
  const inT = rec?.inT ?? null;
  const outT = rec?.outT ?? null;
  const state = !inT ? 'out' : !outT ? 'in' : 'done';

  let worked = 0;
  if (inT && outT) worked = rec!.mins;
  else if (inT) {
    const p = inT.split(':');
    const n = new Date();
    worked = Math.max(0, n.getHours() * 60 + n.getMinutes() - (+p[0] * 60 + +p[1]));
  }

  const modes = [e.site === 'WFH' ? 'CHN' : e.site, 'WFH', 'CLIENT'];

  const showLocation = (title: string, f: Fence, loc: Loc, extra?: boolean) =>
    layer.modal({
      title,
      sub: siteOf(f.site).name,
      size: 'narrow',
      body: (
        <>
          <Banner kind={f.ok ? 'good' : 'warn'} icon={<span style={{ fontSize: 19 }}>{f.ok ? '✅' : '⚠️'}</span>}
            title={extra ? (f.ok ? 'Location verified' : 'Geo-fence exception') : undefined}>
            {f.msg}
          </Banner>
          {extra && (
            <>
              <div className="divide" />
              <KV
                rows={[
                  ['Coordinates', <span className="mono">{loc.lat}, {loc.lng}</span>],
                  ['Accuracy', `±${loc.acc} m ${loc.real ? '(device GPS)' : '(simulated — browser location unavailable)'}`],
                  ['Source', loc.real ? 'Mobile GPS' : 'Web'],
                  ['Work mode', siteOf(f.site).name],
                ]}
              />
            </>
          )}
          <MapBox
            points={[{ lat: loc.lat, lng: loc.lng, label: 'You', me: true }]}
            site={mode === 'WFH' || mode === 'CLIENT' ? null : siteOf(mode)}
          />
        </>
      ),
      footer: extra ? (close) => (
        <button className="btn primary" onClick={close}>Done</button>
      ) : undefined,
    });

  const doPunch = (kind: 'in' | 'out') => {
    app.toast('Acquiring GPS location…');
    resolveLocation(empId, mode, (loc) => {
      const f = evalFence(mode, loc);
      const ds = ymd(TODAY);
      let r = attOf(empId, ds);
      if (!r) {
        r = {
          id: 'A-' + empId + '-' + ds, empId, date: ds, status: 'P', inT: null, outT: null,
          mins: 0, lat: null, lng: null, dist: null, site: e.site, geoOk: true, src: 'Web',
          late: false, reg: null, notes: '',
        } as AttRecord;
        ATT.push(r);
        (ATT_IDX[empId] = ATT_IDX[empId] || {})[ds] = r;
      }

      r.lat = loc.lat;
      r.lng = loc.lng;
      r.site = f.site;
      r.geoOk = f.ok;
      r.dist = f.dist;
      r.src = loc.real ? 'Mobile GPS' : 'Web';
      r.status = mode === 'WFH' ? 'W' : 'P';

      if (kind === 'in') {
        r.inT = nowHM();
        r.late = false;
      } else {
        r.outT = nowHM();
        const a = r.inT!.split(':');
        const b = r.outT.split(':');
        /* 45 minutes unpaid break */
        r.mins = Math.max(0, +b[0] * 60 + +b[1] - (+a[0] * 60 + +a[1]) - 45);
      }
      if (!f.ok) r.notes = 'Outside geo-fence — flagged';

      app.bump();
      showLocation(
        kind === 'in' ? 'Punched in at ' + fmtTime(r.inT) : 'Punched out at ' + fmtTime(r.outT),
        f, loc, true,
      );
      app.toast(kind === 'in' ? 'Punched in' : 'Punched out', 'ok');
    });
  };

  return (
    <div className="punch-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="lb">{DOW[TODAY.getDay()]}, {fmtD(TODAY)}</div>
          <div className="clock">{clock}</div>
        </div>
        <div className="right">
          <div className="lb">Shift</div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{e.shift}</div>
        </div>
      </div>

      <div className="row" style={{ gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
        <div>
          <div className="lb">Punch In</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{inT ? fmtTime(inT) : '—'}</div>
        </div>
        <div>
          <div className="lb">Punch Out</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{outT ? fmtTime(outT) : '—'}</div>
        </div>
        <div>
          <div className="lb">Worked</div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{worked ? hhmm(worked) + ' h' : '—'}</div>
        </div>
        <div style={{ flex: 1 }} />
      </div>

      <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
        <div className="seg" style={{ background: 'rgba(255,255,255,.15)' }}>
          {modes.map((m) => (
            <button
              key={m}
              className={mode === m ? 'on' : ''}
              style={{ color: mode === m ? 'var(--brand-ink)' : '#fff' }}
              onClick={() => setMode(m)}
            >
              {m === 'WFH' ? '🏠 WFH' : m === 'CLIENT' ? '🚗 Client' : '🏢 ' + siteOf(m).city}
            </button>
          ))}
        </div>

        {state === 'out' ? (
          <button className="btn solid" onClick={() => doPunch('in')}>⏱ Punch In</button>
        ) : state === 'in' ? (
          <button className="btn solid" onClick={() => doPunch('out')}>⏹ Punch Out</button>
        ) : (
          <span className="badge" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}>
            ✓ Day completed
          </span>
        )}

        <button
          className="btn"
          onClick={() => resolveLocation(empId, mode, (loc) => showLocation('Location check', evalFence(mode, loc), loc))}
        >
          📍 Verify location
        </button>
      </div>

      {rec?.geoOk === false && (
        <div style={{ marginTop: 11, background: 'rgba(255,255,255,.16)', padding: '8px 11px', borderRadius: 9, fontSize: 12.5 }}>
          ⚠ Today&rsquo;s punch was recorded {rec.dist} m from {siteOf(e.site).name} — flagged for manager review.
        </div>
      )}
    </div>
  );
}
