/**
 * The punch card.
 *
 * This used to ask the browser for a GPS fix on every punch, measure it
 * against the site's fence, and send the verdict along. None of that is here
 * any more: a punch records when you started, when you stopped, and the work
 * mode you chose. `navigator.geolocation` is not called at all, so nobody sees
 * a permission prompt and there is no coordinate to store, leak or subpoena.
 *
 * The work mode survives because it is a different kind of fact. "I am working
 * from home today" is something the employee states, and it is what the WFH
 * figures have always been counted from — it was never the fence that knew.
 */

import { useEffect, useState } from 'react';
import { DOW, fmtD, fmtTime, hhmm, TODAY, ymd } from '../../lib/dates';
import { siteOf } from '../../data/org';
import { KV } from '../../components/ui';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useDay, usePeople, usePunchIn, usePunchOut } from './data';

const nowHM = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};

const nowHMS = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
};

export function PunchWidget({ empId }: { empId: string }) {
  const app = useApp();
  const layer = useLayer();
  const self = usePeople([empId]);
  const homeSite = self.byId(empId)?.site ?? 'CHN';
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

  const doPunch = async (kind: 'in' | 'out') => {
    const ds = ymd(TODAY);
    const at = { site: activeMode, src: 'Web', at: nowHM() };
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
          <button className="btn solid" onClick={() => doPunch('in')}>⏱ Punch In</button>
        ) : state === 'in' ? (
          <button className="btn solid" onClick={() => doPunch('out')}>⏹ Punch Out</button>
        ) : (
          <span className="badge" style={{ background: 'rgba(255,255,255,.2)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}>
            ✓ Day completed
          </span>
        )}
      </div>

      {rec?.late && (
        <div style={{ marginTop: 11, background: 'rgba(255,255,255,.16)', padding: '8px 11px', borderRadius: 9, fontSize: 12.5 }}>
          ⚠ Today&rsquo;s punch was after the shift grace period.
        </div>
      )}
    </div>
  );
}
