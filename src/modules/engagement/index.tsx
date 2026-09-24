import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';


import type { Survey } from '../../services';
import { DEPTS } from '../../data/org';
import { Avatar, Badge, Banner, Card, EmptyState, Tabs, Tile, StatRow } from '../../components/ui';
import { Divide, ListRow } from '../../components/common';
import { Donut, HBar, Legend, LineChart, PAL, Ring } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useEnpsHistory, useEnps, usePraise, useRespondToSurvey, useSurveyQuestions, useSurveys, useVisiblePeople } from './data';
import type { SurveyAnswer } from '../../services';
import { useTabFromUrl } from '../tabParam';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { Icon } from '../../components/icons';
import { notBacked } from '../../components/NotBacked';

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

/**
 * Answering a survey.
 *
 * This used to be a form over hard-coded questions whose Submit button did
 * exactly three things: increment `s.responded` on the object in memory,
 * close the dialog, and say "your response has been recorded". Nothing was
 * sent anywhere. The count went up on screen and back down on reload.
 *
 * It renders `surveyQuestions` now — the questions as asked, each with the id
 * the answer is filed against. The previous source, `s.questions`, is the
 * aggregate: means, withheld below the response floor, so a fresh survey
 * showed no questions at all and there was nothing to submit even in
 * principle.
 */
function SurveyForm({ s, close }: { s: Survey; close: () => void }) {
  const app = useApp();
  const { data: questions = [], loading, error } = useSurveyQuestions(s.id);
  const respond = useRespondToSurvey();
  const [scores, setScores] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const pick = (qid: string, value: number) => setScores((a) => ({ ...a, [qid]: value }));

  /* Every scale question needs an answer; free text is optional throughout. */
  const scaled = questions.filter((q) => q.kind === 'scale' || q.kind === 'nps');
  const unanswered = scaled.filter((q) => scores[q.id] === undefined);
  const ready = scaled.length > 0 && unanswered.length === 0;

  const submit = async () => {
    const answers: SurveyAnswer[] = questions
      .map((q) => ({
        questionId: q.id,
        score: scores[q.id] ?? null,
        text: (notes[q.id] ?? '').trim() || null,
      }))
      .filter((a) => a.score !== null || a.text !== null);

    try {
      await respond.mutate(s.id, answers);
      close();
      app.toast('Thank you — your response has been recorded', 'ok');
      app.bump();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not record your response', 'err');
    }
  };

  if (loading) return <div className="muted">Loading the questions…</div>;
  if (error) {
    return (
      <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="The questions could not be loaded">
        {error instanceof Error ? error.message : 'Try again in a moment.'}
      </Banner>
    );
  }
  if (!questions.length) {
    return (
      <Banner kind="info" icon={<Icon n="vote" size="lg" />} title="This survey has no questions yet">
        Nothing has been set up to answer.
      </Banner>
    );
  }

  return (
    <>
      {questions.map((q, i) => (
        <div className="field" key={q.id}>
          <label>{questions.length > 1 ? `${i + 1}. ` : ''}{q.prompt}</label>
          {q.kind === 'nps' && (
            <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
              {Array.from({ length: 11 }, (_, n) => (
                <button key={n} type="button" className={'chip x' + (scores[q.id] === n ? ' on' : '')}
                  style={{ minWidth: 38, justifyContent: 'center' }}
                  onClick={() => pick(q.id, n)}>{n}</button>
              ))}
            </div>
          )}
          {q.kind === 'scale' && (
            <div className="row wrap" style={{ gap: 5, marginTop: 6 }}>
              {SCALE.map((x, j) => (
                <button key={j} type="button" className={'chip x' + (scores[q.id] === j + 1 ? ' on' : '')}
                  onClick={() => pick(q.id, j + 1)}>{x}</button>
              ))}
            </div>
          )}
          {(q.kind === 'text' || q.kind === 'choice') && (
            <textarea className="input" style={{ minHeight: 80 }}
              value={notes[q.id] ?? ''}
              onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value }))} />
          )}
        </div>
      ))}

      <Banner kind="good" icon={<Icon n="lock" size="lg" />}>
        {s.anonymous
          ? 'Your identity is not attached to this response. That a person answered is '
            + 'recorded separately, so nobody can be matched to what they said.'
          : 'Your name is visible to HR for this survey.'}
      </Banner>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 14 }}>
        <button className="btn" onClick={close} disabled={respond.pending}>Cancel</button>
        <button className="btn primary" onClick={submit}
          disabled={!ready || respond.pending}
          title={ready ? '' : `Answer ${unanswered.length} more question${unanswered.length === 1 ? '' : 's'}`}
        >{respond.pending ? 'Recording…' : 'Submit response'}</button>
      </div>
    </>
  );
}

/* ---------------- Open surveys ---------------- */

function EnOpen() {
  const { data: SURVEYS = [] } = useSurveys();
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
      <Banner kind="info" icon={<Icon n="lock" size="lg" />} title="Your answers are anonymous">
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

      {!live.length && <Card><EmptyState msg="No open surveys right now" icon={<Icon n="goal" size="lg" />} /></Card>}
    </div>
  );
}

/* ---------------- Results ---------------- */

function EnResults() {
  const { data: SURVEYS = [] } = useSurveys();
  const { data: ENPS_HISTORY = [] } = useEnpsHistory();
  const { data: enpsScore = 0 } = useEnps('SV2');
  const { data: praise = [] } = usePraise();
  const pulse = SURVEYS.find((s) => s.id === 'SV1');
  const enps = SURVEYS.find((s) => s.id === 'SV2');

  /* After every hook: the surveys arrive asynchronously. */
  if (!pulse || !enps) return <EmptyState msg="Loading survey results…" icon={<Icon n="chart" size="lg" />} />;

  const score = enpsScore;
  const total = (enps.promoters ?? 0) + (enps.passives ?? 0) + (enps.detractors ?? 0);
  const questions = pulse.questions || [];
  const openSurveys = SURVEYS.filter((x) => x.status === 'Live');

  return (
    <div className="stack">
      <StatRow cols={4}>
        <Tile icon={<Icon n="chart" size="lg" />} label="Engagement score"
          value={pct(sum(questions, (q) => q.score), Math.max(1, questions.length) * 5) + '%'}
          foot={`${(sum(questions, (q) => q.score) / Math.max(1, questions.length)).toFixed(2)} out of 5`} />
        <Tile icon={<Icon n="trophy" size="lg" />} label="Total recognitions" value={praise.length}
          foot="Given across the company" />
        <Tile icon={<Icon n="vote" size="lg" />} label="Active polls" value={openSurveys.length}
          foot="Open for responses" />
        <Tile icon={<Icon n="people" size="lg" />} label="Participation rate" value={pct(pulse.responded, pulse.sent) + '%'}
          foot={`${pulse.responded} of ${pulse.sent} responded`} />
      </StatRow>

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
            {/*
               * null is "too few people answered to show a result", which is
               * not the same as a score of zero — the service withholds it
               * rather than letting a small team be identified by inspection.
               */}
            <Donut size={160}
              center={score === null ? '—' : (score > 0 ? '+' : '') + score}
              centerSub={score === null ? 'Too few replies' : 'eNPS'}
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
          {/*
            * Creating and sending a survey is admin-only in the policy and has
            * no endpoint behind it — `/surveys` is read plus the response
            * path. Until it does, this says so rather than claiming to have
            * mailed everybody.
            */}
          <button className="btn primary"
            {...notBacked('a survey is created in the database directly; there is no send path yet')}
          >Send survey</button>
        </>
      ),
    });

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn primary" onClick={newSurvey}><Icon n="add" size="lg" /> New survey</button>
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

type Tab = 'open' | 'results' | 'recog' | 'manage';

/**
 * Recognition — praise people have given each other.
 *
 * Shown here as well as on Performance because it is the same record read for
 * a different reason: there it is part of someone's review, here it is a
 * measure of whether the place is a good one to work in.
 */
function EnRecognition() {
  const { data: praise = [] } = usePraise();
  const dir = useVisiblePeople();

  if (!praise.length) return <Card><EmptyState msg="No recognition given yet" icon={<Icon n="trophy" size="lg" />} /></Card>;

  const byValue = [...new Set(praise.map((p) => p.value))].map((v, i) => ({
    k: v, c: PAL[i % PAL.length], v: praise.filter((x) => x.value === v).length,
  }));

  return (
    <div className="stack">
      <StatRow cols={3}>
        <Tile icon={<Icon n="trophy" size="lg" />} label="Recognitions" value={praise.length} foot="All time" />
        <Tile icon={<Icon n="applause" size="lg" />} label="Likes" value={sum(praise, (p) => p.likes)}
          foot="On recognition posts" />
        <Tile icon={<Icon n="applause" size="lg" />} label="People recognised"
          value={new Set(praise.map((p) => p.toId)).size} foot="Distinct recipients" />
      </StatRow>

      <div className="grid g-2-1">
        <Card title="Recent recognition" sub={`${praise.length} posts`} flush>
          {sortBy(praise, (p) => p.on).reverse().slice(0, 25).map((p) => (
            <ListRow key={p.id}>
              <Avatar name={dir.name(p.fromId)} size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 650, fontSize: 12.5 }}>
                  {dir.name(p.fromId)} → {dir.name(p.toId)}
                </div>
                <div className="muted" style={{ fontSize: 11.5 }}>{p.text}</div>
              </div>
              <Badge kind="info">{p.value}</Badge>
              <span className="muted" style={{ fontSize: 11.5 }}>♥ {p.likes}</span>
            </ListRow>
          ))}
        </Card>

        <Card title="What gets recognised" sub="By company value">
          <HBar rows={byValue} />
        </Card>
      </div>
    </div>
  );
}

function Engagement() {
  const app = useApp();
  const tabs: { v: Tab; label: string }[] = app.role === 'employee'
    ? [{ v: 'open', label: 'Polls' }, { v: 'results', label: 'Overview' },
      { v: 'recog', label: 'Recognition' }]
    : [{ v: 'results', label: 'Overview' }, { v: 'open', label: 'Polls' },
      { v: 'recog', label: 'Recognition' }, { v: 'manage', label: 'Manage surveys' }];

  const [tab, setTab] = useTabFromUrl<Tab>(tabs[0]!.v, tabs.map((t) => t.v));
  const active = tabs.some((t) => t.v === tab) ? tab : tabs[0].v;

  return (
    <>
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'open' && <EnOpen />}
      {active === 'results' && <EnResults />}
      {active === 'recog' && <EnRecognition />}
      {active === 'manage' && <EnManage />}
    </>
  );
}

registerModule({
  key: 'engagement',
  title: TITLES.engagement,
  Component: Engagement,
});
