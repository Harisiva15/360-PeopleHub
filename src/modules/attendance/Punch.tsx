/**
 * The punch card.
 *
 * A punch carries three things: the time, the work mode, and — since the
 * fence came back — where the device says it is.
 *
 * **The verdict is not sent.** The coordinates go to the server and it decides
 * whether they fall inside the site's fence. This screen computes the same
 * distance only to tell the employee where they stand *before* they punch; the
 * two agreeing is a convenience, not a guarantee, and if they ever disagree the
 * server is right.
 *
 * **A refused or unavailable fix is not a failure.** The punch goes through
 * with no coordinates, and the server records `geoOk: null` — nothing to
 * measure against. Blocking the punch would mean an employee whose phone
 * cannot see the sky does not get paid.
 */

import { useEffect, useState } from 'react';
import { DOW, fmtD, fmtTime, hhmm, TODAY, ymd } from '../../lib/dates';
import { siteOf } from '../../data/org';
import { KV } from '../../components/ui';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useDay, useLocationNotice, usePeople, usePunchIn, usePunchOut } from './data';
import { LocationNoticeBody } from './LocationNotice';
import { Icon } from '../../components/icons';

/** Where the device thinks it is, or null if it will not say. */
interface Fix { lat: number; lng: number; acc: number }

/**
 * Ask the browser for a fix, giving up after a few seconds.
 *
 * Resolves to null rather than rejecting on refusal or timeout: not knowing
 * where somebody is is a normal outcome here, not an error.
 */
function locate(): Promise<Fix | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let settled = false;
    const done = (v: Fix | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 6000);
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          clearTimeout(timer);
          done({
            lat: +p.coords.latitude.toFixed(6),
            lng: +p.coords.longitude.toFixed(6),
            acc: Math.round(p.coords.accuracy),
          });
        },
        () => { clearTimeout(timer); done(null); },
        { enableHighAccuracy: true, timeout: 5500, maximumAge: 30000 },
      );
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

/*
 * An instant, not a wall-clock time. The server measures lateness against the
 * shift's timezone, which a bare 'HH:MM' cannot be resolved into — and the
 * timestamptz column refused it outright, so every live punch failed.
 */
const nowInstant = () => new Date().toISOString();

const nowHMS = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
};

export function PunchWidget({ empId }: { empId: string }) {
  const app = useApp();
  const layer = useLayer();
  const self = usePeople([empId]);
  const homeSite = self.byId(empId)?.site ?? 'CHN';
  const { data: notice } = useLocationNotice();
  const [mode, setMode] = useState('');
  /* The employee arrives asynchronously; until then fall back to their base site. */
  const activeMode = mode || (homeSite === 'WFH' ? 'WFH' : homeSite);
  const [clock, setClock] = useState(nowHMS);

  useEffect(() => {
    const t = setInterval(() => setClock(nowHMS()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: rec } = useDay(empId, ymd(TODAY));
  const punchIn = usePunchIn();
  const punchOut = usePunchOut();
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

  const modes = [homeSite === 'WFH' ? 'CHN' : homeSite, 'WFH', 'CLIENT'];

  /*
   * Shown once, before the first punch that would record a position. Resolves
   * to whether they acknowledged — a decline is a normal answer, not a
   * cancellation, so the punch continues either way with no fix attached.
   */
  const tellThemFirst = () => new Promise<boolean>((resolve) => {
    layer.modal({
      title: notice!.title,
      sub: 'Please read this before you check in',
      size: 'narrow',
      body: (close: () => void) => (
        <LocationNoticeBody close={close} notice={notice!} onDone={resolve} />
      ),
      footer: null,
      /* Dismissing without choosing is a decline, not a hang. */
      onClose: () => resolve(false),
    });
  });

  const doPunch = async (kind: 'in' | 'out') => {
    const ds = ymd(TODAY);
    const site = siteOf(activeMode);

    /*
     * Only for a mode that is actually fenced. Telling somebody their home
     * address is recorded, before a punch that never asks for one, would be
     * a false statement in the other direction.
     */
    let mayLocate = site.remote ? false : Boolean(notice?.acknowledgedAt);
    if (!site.remote && notice && !notice.acknowledgedAt) {
      mayLocate = await tellThemFirst();
    }

    if (mayLocate) app.toast('Checking your location…');
    const fix = mayLocate ? await locate() : null;
    const at = {
      site: activeMode,
      lat: fix?.lat ?? null,
      lng: fix?.lng ?? null,
      src: 'Web',
      at: nowInstant(),
    };
    const r = kind === 'in'
      ? await punchIn.mutate(empId, ds, at)
      : await punchOut.mutate(empId, ds, at);

    layer.modal({
      title: kind === 'in' ? 'Punched in at ' + fmtTime(r.inT) : 'Punched out at ' + fmtTime(r.outT),
      sub: siteOf(r.site).name,
      size: 'narrow',
      body: (
        <KV rows={[
          ['Punch in', <span className="mono">{r.inT ? fmtTime(r.inT) : '—'}</span>],
          ['Punch out', <span className="mono">{r.outT ? fmtTime(r.outT) : '—'}</span>],
          ['Worked', r.mins ? hhmm(r.mins) + ' h' : '—'],
          ['Work mode', siteOf(r.site).name],
          ['Shift', self.byId(empId)?.shift ?? '—'],
          ['Location', r.geoOk === null
            ? (fix ? 'Recorded — this work mode is not fenced' : 'Not available')
            : r.geoOk
              ? `Inside the fence · ${r.dist} m from ${siteOf(r.site).name}`
              : `Outside the fence · ${r.dist} m from ${siteOf(r.site).name}`],
          ...(r.late ? [['Marked late', 'Beyond the shift grace period'] as [string, string]] : []),
        ]} />
      ),
      footer: (close) => <button className="btn primary" onClick={close}>Done</button>,
    });
    app.toast(kind === 'in' ? 'Punched in' : 'Punched out', 'ok');
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
          <div style={{ fontWeight: 700, fontSize: 14 }}>{self.byId(empId)?.shift ?? '—'}</div>
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
              className={activeMode === m ? 'on' : ''}
              style={{ color: activeMode === m ? 'var(--brand-ink)' : '#fff' }}
              onClick={() => setMode(m)}
            >
              {m === 'WFH' ? '🏠 WFH' : m === 'CLIENT' ? '🚗 Client' : '🏢 ' + siteOf(m).city}
            </button>
          ))}
        </div>

        {state === 'out' ? (
          <button className="btn solid" onClick={() => doPunch('in')}><Icon n="timer" size="lg" /> Punch In</button>
        ) : state === 'in' ? (
          <button className="btn solid" onClick={() => doPunch('out')}><Icon n="stop" size="lg" /> Punch Out</button>
        ) : (
          <span className="badge" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}><Icon n="ok" size="lg" /> Day completed
          </span>
        )}
      </div>

      {rec?.geoOk === false && (
        <div style={{ marginTop: 11, background: 'rgba(255,255,255,.16)', padding: '8px 11px', borderRadius: 9, fontSize: 12.5 }}>
          <Icon n="warn" size="lg" /> Today&rsquo;s punch was {rec.dist} m from {siteOf(rec.site).name} — outside the fence,
          flagged for your manager. You can raise a regularisation from the Regularisation tab.
        </div>
      )}
      {rec?.late && rec?.geoOk !== false && (
        <div style={{ marginTop: 11, background: 'rgba(255,255,255,.16)', padding: '8px 11px', borderRadius: 9, fontSize: 12.5 }}>
          <Icon n="warn" size="lg" /> Today&rsquo;s punch was after the shift grace period.
        </div>
      )}
    </div>
  );
}
