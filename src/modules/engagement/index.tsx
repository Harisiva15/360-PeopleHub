import { useState } from 'react';
import { sum } from '../../lib/collections';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { ACTIVE } from '../../data/employees';
import { ENPS_HISTORY, enpsOf, SURVEYS } from '../../data/engagement';
import type { Survey } from '../../data/engagement';
import { DEPTS } from '../../data/org';
import { Badge, Banner, Card, EmptyState, Tabs, Tile } from '../../components/ui';
import { Divide, ListRow } from '../../components/common';
import { Donut, HBar, Legend, LineChart, Ring } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

const SCALE = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

const TEMPLATES: [string, string, string][] = [
  ['Quarterly engagement pulse', '6 questions · anonymous · all employees', '📊'],
  ['eNPS', '1 question + comment · anonymous · all employees', '📈'],
  ['New joiner experience (30 / 90 days)', '5 questions · attributed · new hires', '🚀'],
  ['Manager effectiveness', '8 questions · anonymous · direct reports', '🧭'],
  ['Exit survey', '10 questions · attributed · leavers', '👋'],
  ['Return to office preference', '4 questions · anonymous · all employees', '🏢'],
];

const ACTIONS: [string, string, string][] = [
  ['Publish career frameworks for every job family', 'Priya Raghavan', 'In Progress'],
  ['Cap on-call to one week in six', 'Karthik Shetty', 'Completed'],
  ['Quarterly skip-level 1:1s for every team', 'Vikram Sundaram', 'In Progress'],
  ['Learning wallet raised to ₹40,000', 'Priya Raghavan', 'Completed'],
  ['Fix meeting overload — no-meeting Wednesdays', 'Ravi Natarajan', 'Pending'],
];

/** Driver colour bands: strengths green, watch amber, problems red. */
const driverColor = (v: number) =>
  v >= 4.2 ? 'var(--s6)' : v >= 3.8 ? 'var(--s1)' : v >= 3.4 ? 'var(--s4)' : 'var(--s8)';

/* ---------------- survey form ---------------- */

function SurveyForm({ s, close }: { s: Survey; close: () => void }) {
  const app = useApp();
  const [answers, setAnswers] = useState<Record<string, number>>({});

  const pick = (group: string, value: number) => setAnswers((a) => ({ ...a, [group]: value }));

  return (
    <>
      {s.type === 'eNPS' ? (
        <>
          <div className="field">
            <label>How likely are you to recommend 360 Technology as a place to work? (0 = not at all, 10 = extremely likely)</label>
            <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
              {Array.from({ length: 11 }, (_, i) => (
                <button key={i} type="button" className={'chip x' + (answers.nps === i ? ' on' : '')}
                  style={{ minWidth: 38, justifyContent: 'center' }} onClick={() => pick('nps', i)}>{i}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>What is the main reason for your score?</label>
            <textarea className="input" style={{ minHeight: 90 }} />
          </div>
        </>
      ) : (
        <>
          {(s.questions || []).map((q, i) => (
            <div className="field" key={i}>
              <label>{i + 1}. {q.q}</label>
              <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
                {SCALE.map((x, j) => (
                  <button key={j} type="button" className={'chip x' + (answers['q' + i] === j ? ' on' : '')}
                    onClick={() => pick('q' + i, j)}>{x}</button>
                ))}
              </div>
            </div>
          ))}
          <div className="field">
            <label>Anything else you want leadership to know?</label>
            <textarea className="input" />
          </div>
        </>
      )}

      <Banner kind="good" icon="🔒">
        {s.anonymous ? 'Your identity is not attached to this response.' : 'Your name is visible to HR for this survey.'}
      </Banner>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={() => {
          s.responded++;
          close();
          app.toast('Thank you — your response has been recorded', 'ok');
          app.bump();
        }}>Submit response</button>
      </div>
    </>
  );
}

/* ---------------- Open surveys ---------------- */

function EnOpen() {
  const layer = useLayer();
  const live = SURVEYS.filter((s) => s.status === 'Live');

  const take = (s: Survey) =>
    layer.modal({
      title: s.name,
      sub: `${s.type} · ${s.anonymous ? 'anonymous' : 'attributed'} · about 2 minutes`,
      size: 'wide',
      body: (close) => <SurveyForm s={s} close={close} />,
      footer: null,
    });

  return (
    <div className="stack">
      <Banner kind="info" icon="🔒" title="Your answers are anonymous">
        Pulse and eNPS responses are aggregated — neither your manager nor HR can see individual answers. Results are
        only shown when at least 5 people in a group have responded.
      </Banner>

      <div className="grid g2">
        {live.map((s) => (
          <Card key={s.id} title={s.name} sub={`${s.type} · closes ${fmtD(s.closesOn)}`}>
            <div className="row" style={{ gap: 16, alignItems: 'center', marginBottom: 12 }}>
              <Ring value={pct(s.responded, s.sent)} color="var(--s1)" size={78} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 650 }}>{s.responded} of {s.sent} responded</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {s.anonymous ? 'Anonymous' : 'Attributed'} · {s.questions ? s.questions.length : 1} question(s) · about 2 minutes
                </div>
              </div>
            </div>
            <button className="btn primary" style={{ width: '100%' }} onClick={() => take(s)}>Take the survey</button>
          </Card>
        ))}
      </div>

      {!live.length && <Card><EmptyState msg="No open surveys right now" icon="📋" /></Card>}
    </div>
  );
}

/* ---------------- Results ---------------- */

function EnResults() {
  const pulse = SURVEYS.find((s) => s.id === 'SV1')!;
  const enps = SURVEYS.find((s) => s.id === 'SV2')!;
  const score = enpsOf(enps);
  const total = (enps.promoters ?? 0) + (enps.passives ?? 0) + (enps.detractors ?? 0);
  const questions = pulse.questions || [];
  const lowest = questions.length ? Math.min(...questions.map((q) => q.score)) : 0;

  return (
    <div className="stack">
      <div className="grid g4">
        <Tile label="eNPS" value={(score > 0 ? '+' : '') + score} trend="up" foot="▲ 9 vs last quarter · benchmark +30" />
        <Tile label="Engagement score" value={(sum(questions, (q) => q.score) / Math.max(1, questions.length)).toFixed(2) + ' / 5'}
          foot={`${pulse.responded} of ${pulse.sent} responded`} />
        <Tile label="Response rate" value={pct(pulse.responded, pulse.sent) + '%'} foot="Target 75%" />
        <Tile label="Lowest driver" value={lowest.toFixed(1)} foot="Career growth clarity — needs action" />
      </div>

      <div className="grid g-2-1">
        <Card title="Engagement drivers" sub={`Average score out of 5 · ${pulse.name}`}>
          <HBar rows={questions.map((q) => ({ k: q.q, c: driverColor(q.score), v: q.score }))} fmt={(v) => v.toFixed(1)} />
          <Divide />
          <div className="muted" style={{ fontSize: 12 }}>
            Scores above 4.0 are strengths to protect; below 3.5 needs a named owner and an action in the next quarter.
          </div>
        </Card>

        <div className="stack">
          <Card title="eNPS breakdown" sub={`${total} responses`}>
            <Donut size={160} center={(score > 0 ? '+' : '') + score} centerSub="eNPS"
              slices={[
                { k: 'Promoters (9–10)', v: enps.promoters ?? 0, c: 'var(--s6)' },
                { k: 'Passives (7–8)', v: enps.passives ?? 0, c: 'var(--s4)' },
                { k: 'Detractors (0–6)', v: enps.detractors ?? 0, c: 'var(--s8)' },
              ]} />
            <Legend items={[
              { k: 'Promoters', v: enps.promoters ?? 0, c: 'var(--s6)' },
              { k: 'Passives', v: enps.passives ?? 0, c: 'var(--s4)' },
              { k: 'Detractors', v: enps.detractors ?? 0, c: 'var(--s8)' },
            ]} />
          </Card>

          <Card title="eNPS trend" sub="Last 4 quarters">
            <LineChart labels={ENPS_HISTORY.map((x) => x.k)} height={170} padLeft={34} area
              series={[{ name: 'eNPS', color: 'var(--s1)', data: ENPS_HISTORY.map((x) => x.v) }]} />
          </Card>
        </div>
      </div>

      <Card title="Survey history" sub={`${SURVEYS.length} surveys`} flush>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Survey</th><th>Type</th><th>Sent</th><th className="num">Recipients</th><th className="num">Responses</th><th className="num">Rate</th><th>Status</th></tr>
            </thead>
            <tbody>
              {SURVEYS.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td>{s.type}</td>
                  <td className="nowrap">{fmtD(s.sentOn)}</td>
                  <td className="num">{s.sent}</td>
                  <td className="num">{s.responded}</td>
                  <td className="num">{pct(s.responded, s.sent)}%</td>
                  <td><Badge kind={s.status === 'Live' ? 'info' : 'mute'}>{s.status === 'Live' ? 'Live' : 'Closed'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Manage ---------------- */

function EnManage() {
  const app = useApp();
  const layer = useLayer();

  const newSurvey = () =>
    layer.modal({
      title: 'New survey',
      sub: 'Choose a template and audience',
      body: (
        <>
          <div className="field">
            <label>Template</label>
            <select className="input">
              {['Quarterly engagement pulse', 'eNPS', 'Manager effectiveness', 'New joiner experience', 'Custom'].map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="grid g2" style={{ gap: '0 14px' }}>
            <div className="field">
              <label>Audience</label>
              <select className="input">
                <option>All employees</option>
                {DEPTS.map((d) => <option key={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Closes on</label>
              <input type="date" className="input" defaultValue={ymd(addDays(TODAY, 14))} />
            </div>
          </div>
          <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" defaultChecked />
            <span>Anonymous responses (minimum 5 per group before results are shown)</span>
          </label>
        </>
      ),
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={() => {
            close();
            app.toast('Survey sent to ' + ACTIVE().length + ' employees', 'ok');
          }}>Send survey</button>
        </>
      ),
    });

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={newSurvey}>＋ New survey</button>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>Surveys are sent by email and appear in employee self-service</span>
      </div>

      <div className="grid g2">
        <Card title="Survey templates" sub="Ready to send" flush>
          {TEMPLATES.map(([name, meta, icon]) => (
            <ListRow key={name} onClick={() => app.toast(`Template "${name}" ready — choose an audience to send`)}>
              <span style={{ fontSize: 16 }}>{icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{name}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{meta}</div>
              </div>
              <span className="muted">Send ›</span>
            </ListRow>
          ))}
        </Card>

        <Card title="Action tracker" sub="Commitments from the last pulse" flush>
          {ACTIONS.map(([action, owner, status]) => (
            <ListRow key={action}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>{action}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>Owner: {owner}</div>
              </div>
              <Badge kind={status === 'Completed' ? 'good' : status === 'In Progress' ? 'warn' : 'mute'}>{status}</Badge>
            </ListRow>
          ))}
        </Card>
      </div>
    </div>
  );
}

/* ---------------- entry ---------------- */

type Tab = 'open' | 'results' | 'manage';

function Engagement() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'open', label: 'Open Surveys' }, { v: 'results', label: 'Results' }]
    : [{ v: 'results', label: 'Results' }, { v: 'open', label: 'Open Surveys' }, { v: 'manage', label: 'Manage Surveys' }];

  const [tab, setTab] = useState<Tab>(tabs[0].v);
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'open' && <EnOpen />}
      {active === 'results' && <EnResults />}
      {active === 'manage' && <EnManage />}
    </>
  );
}

registerModule({
  key: 'engagement',
  title: TITLES.engagement,
  subtitle: () => 'Pulse surveys, eNPS and the action tracker',
  Component: Engagement,
});
