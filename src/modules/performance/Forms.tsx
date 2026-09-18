/**
 * The forms that run an appraisal cycle.
 *
 * Six server methods — set a goal, log a 1:1, give praise, write a self
 * assessment, write a manager's, close it with a calibrated outcome — were
 * live, probed and unreachable. Performance could be read and a goal's progress
 * nudged; nothing else about a review could be written at all, which meant the
 * cycle could not actually be run from the app.
 *
 * **The order is the server's, not the form's.** A manager's review is refused
 * before the self-assessment is in, and calibration closes a review that has
 * both. These forms show which step is next and let the server enforce it —
 * the rule lives where it cannot be skipped by opening a different page.
 *
 * **A rating is a judgement, so nothing is pre-selected.** A form that opens on
 * "Meets expectations" collects that answer from everyone who was not paying
 * attention, which is the one outcome a review is supposed to distinguish.
 */

import { useState } from 'react';
import type { Employee, ReviewOutcome } from '../../services';
import { addDays, TODAY, ymd } from '../../lib/dates';
import { RATINGS, VALUES } from '../../data/performance';
import { useApp } from '../../state/AppContext';
import {
  useAddGoal, useCalibrateReview, useGivePraise, useLogCheckin,
  useSubmitManagerReview, useSubmitSelfReview,
} from './data';

function Form({ children, close, save, label = 'Save', busy }: {
  children: React.ReactNode;
  close: () => void;
  save: () => void;
  label?: string;
  busy?: boolean;
}) {
  return (
    <div className="stack">
      {children}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : label}
        </button>
      </div>
    </div>
  );
}

/** The scale, largest first, so the form reads the way the labels are ranked. */
function RatingPicker({ value, onChange }: { value: number | ''; onChange: (v: number) => void }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {RATINGS.map((r) => (
        <label key={r.v} className={'rate-opt' + (value === r.v ? ' on' : '')}>
          <input type="radio" name="rating" checked={value === r.v}
            onChange={() => onChange(r.v)} />
          <span style={{ flex: 1 }}>
            <b>{r.label}</b>
            <span className="muted" style={{ fontSize: 11.5, display: 'block' }}>{r.band}</span>
          </span>
          <span className="rate-v" style={{ color: r.c }}>{r.v}</span>
        </label>
      ))}
    </div>
  );
}

/* ---------------- set a goal ---------------- */

const GOAL_CATEGORIES = ['Delivery', 'Quality', 'Customer', 'People', 'Cost', 'Compliance'];

export function GoalForm({ close, empId, who }: {
  close: () => void;
  empId: string;
  who: string;
}) {
  const app = useApp();
  const add = useAddGoal();
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(GOAL_CATEGORIES[0]!);
  const [weight, setWeight] = useState('25');
  const [due, setDue] = useState(ymd(addDays(TODAY, 90)));
  const [krs, setKrs] = useState('');

  const save = async () => {
    if (!title.trim()) { app.toast('Say what the goal is', 'err'); return; }
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0 || w > 100) {
      app.toast('Weight is a share of the scorecard, 1 to 100', 'err');
      return;
    }
    setBusy(true);
    try {
      await add.mutate({
        empId, title: title.trim(), category, weight: w, due,
        ...(krs.trim()
          ? { keyResults: krs.split('\n').map((k) => k.trim()).filter(Boolean) } : {}),
      });
      app.toast('Goal set', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not set the goal', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Set goal">
      <div className="muted" style={{ fontSize: 12.5 }}>For {who}</div>
      <label className="fld">
        <span>What is to be achieved</span>
        <input className="input" value={title} autoFocus
          placeholder="Cut p95 checkout latency below 400ms"
          onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="grid g2">
        <label className="fld">
          <span>Category</span>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {GOAL_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Weight</span>
          <input className="input" type="number" min="1" max="100" value={weight}
            onChange={(e) => setWeight(e.target.value)} />
        </label>
      </div>
      <label className="fld">
        <span>Due</span>
        <input className="input" type="date" value={due}
          onChange={(e) => setDue(e.target.value)} />
      </label>
      <label className="fld">
        <span>Key results</span>
        <textarea className="input" rows={4} value={krs}
          placeholder={'One per line — each measurable on its own.\np95 under 400ms on the checkout path\nNo regression in conversion'}
          onChange={(e) => setKrs(e.target.value)} />
      </label>
      <div className="muted" style={{ fontSize: 12 }}>
        Weights across someone&rsquo;s goals should come to 100. The server does not
        insist, because a scorecard is often part-written.
      </div>
    </Form>
  );
}

/* ---------------- log a 1:1 ---------------- */

export function CheckinForm({ close, empId, who }: {
  close: () => void;
  empId: string;
  who: string;
}) {
  const app = useApp();
  const log = useLogCheckin();
  const [busy, setBusy] = useState(false);

  const [on, setOn] = useState(ymd(TODAY));
  const [wins, setWins] = useState('');
  const [blockers, setBlockers] = useState('');
  const [next, setNext] = useState('');

  const save = async () => {
    /*
     * A 1:1 with nothing written down is a meeting that happened, not a record
     * of it. One of the three is enough — often a conversation is only about
     * what is in the way.
     */
    if (!wins.trim() && !blockers.trim() && !next.trim()) {
      app.toast('Write down at least one of the three', 'err');
      return;
    }
    setBusy(true);
    try {
      await log.mutate({
        empId, on,
        ...(wins.trim() ? { wins: wins.trim() } : {}),
        ...(blockers.trim() ? { blockers: blockers.trim() } : {}),
        ...(next.trim() ? { next: next.trim() } : {}),
      });
      app.toast('Check-in logged', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not log the check-in', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Log check-in">
      <div className="muted" style={{ fontSize: 12.5 }}>1:1 with {who}</div>
      <label className="fld">
        <span>Date</span>
        <input className="input" type="date" value={on} max={ymd(TODAY)}
          onChange={(e) => setOn(e.target.value)} />
      </label>
      <label className="fld">
        <span>What went well</span>
        <textarea className="input" rows={3} value={wins} autoFocus
          onChange={(e) => setWins(e.target.value)} />
      </label>
      <label className="fld">
        <span>What is in the way</span>
        <textarea className="input" rows={3} value={blockers}
          placeholder="Blockers you can actually do something about."
          onChange={(e) => setBlockers(e.target.value)} />
      </label>
      <label className="fld">
        <span>Agreed next</span>
        <textarea className="input" rows={3} value={next}
          onChange={(e) => setNext(e.target.value)} />
      </label>
    </Form>
  );
}

/* ---------------- give praise ---------------- */

export function PraiseForm({ close, people, meId }: {
  close: () => void;
  people: Employee[];
  meId: string;
}) {
  const app = useApp();
  const give = useGivePraise();
  const [busy, setBusy] = useState(false);

  const [toId, setToId] = useState('');
  const [value, setValue] = useState(VALUES[0]!.k);
  const [text, setText] = useState('');

  /* Praising yourself is refused by the server; do not offer it here either. */
  const others = people.filter((e) => e.id !== meId);

  const save = async () => {
    if (!toId) { app.toast('Who is it for?', 'err'); return; }
    if (text.trim().length < 10) {
      app.toast('Say what they did — praise without a reason reads as a formality', 'err');
      return;
    }
    setBusy(true);
    try {
      await give.mutate(toId, value, text.trim());
      app.toast('Praise posted', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not post the praise', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Post praise">
      <label className="fld">
        <span>Who</span>
        <select className="input" value={toId} autoFocus
          onChange={(e) => setToId(e.target.value)}>
          <option value="">Choose a colleague…</option>
          {others.map((e) => (
            <option key={e.id} value={e.id}>{e.name} — {e.designation}</option>
          ))}
        </select>
      </label>
      <label className="fld">
        <span>Which value</span>
        <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
          {VALUES.map((v) => <option key={v.k} value={v.k}>{v.ic} {v.k}</option>)}
        </select>
      </label>
      <label className="fld">
        <span>What they did</span>
        <textarea className="input" rows={4} value={text}
          placeholder="Specific enough that they would recognise the moment."
          onChange={(e) => setText(e.target.value)} />
      </label>
    </Form>
  );
}

/* ---------------- self assessment ---------------- */

export function SelfReviewForm({ close, cycle }: { close: () => void; cycle: string }) {
  const app = useApp();
  const submit = useSubmitSelfReview();
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState<number | ''>('');
  const [comments, setComments] = useState('');

  const save = async () => {
    if (rating === '') { app.toast('Rate yourself on the scale', 'err'); return; }
    if (comments.trim().length < 40) {
      app.toast('A rating with no reasoning gives your manager nothing to read', 'err');
      return;
    }
    setBusy(true);
    try {
      await submit.mutate(rating, comments.trim());
      app.toast('Self-assessment submitted', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not submit it', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Submit assessment">
      <div className="muted" style={{ fontSize: 12.5 }}>{cycle}</div>
      <label className="fld">
        <span>How you rate the period</span>
      </label>
      <RatingPicker value={rating} onChange={setRating} />
      <label className="fld">
        <span>What you did, and what you would do differently</span>
        <textarea className="input" rows={7} value={comments}
          placeholder="What you delivered, what you learned, and where you needed help. Your manager reads this before writing theirs."
          onChange={(e) => setComments(e.target.value)} />
      </label>
      <div className="muted" style={{ fontSize: 12 }}>
        Your manager cannot write theirs until this is in.
      </div>
    </Form>
  );
}

/* ---------------- manager's review ---------------- */

export function ManagerReviewForm({ close, empId, who, selfRating, selfComments }: {
  close: () => void;
  empId: string;
  who: string;
  selfRating: number | null;
  selfComments: string;
}) {
  const app = useApp();
  const submit = useSubmitManagerReview();
  const [busy, setBusy] = useState(false);
  const [rating, setRating] = useState<number | ''>('');
  const [comments, setComments] = useState('');

  const save = async () => {
    if (rating === '') { app.toast('Give a rating', 'err'); return; }
    if (comments.trim().length < 40) {
      app.toast('Say why — this is what the person will read', 'err');
      return;
    }
    setBusy(true);
    try {
      await submit.mutate(empId, rating, comments.trim());
      app.toast('Review submitted', 'ok');
      close();
    } catch (e) {
      /* Refused before the self-assessment is in — the server says so. */
      app.toast(e instanceof Error ? e.message : 'Could not submit the review', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Submit review">
      <div className="muted" style={{ fontSize: 12.5 }}>{who}</div>

      {/* Their own assessment, in front of you while you write yours. */}
      {selfRating !== null && (
        <div className="self-box">
          <div className="self-h">
            Their self-assessment
            <b>{RATINGS.find((r) => r.v === selfRating)?.label ?? selfRating}</b>
          </div>
          <p>{selfComments || <span className="muted">No comments written.</span>}</p>
        </div>
      )}

      <label className="fld"><span>Your rating</span></label>
      <RatingPicker value={rating} onChange={setRating} />

      <label className="fld">
        <span>Your assessment</span>
        <textarea className="input" rows={7} value={comments}
          placeholder="What they delivered, how they worked, and what you want to see next. Written to be read by them."
          onChange={(e) => setComments(e.target.value)} />
      </label>
    </Form>
  );
}

/* ---------------- calibration ---------------- */

export function CalibrateForm({ close, empId, who, managerRating }: {
  close: () => void;
  empId: string;
  who: string;
  managerRating: number | null;
}) {
  const app = useApp();
  const calibrate = useCalibrateReview();
  const [busy, setBusy] = useState(false);

  const [rating, setRating] = useState<number | ''>(managerRating ?? '');
  const [potential, setPotential] = useState('2');
  const [hike, setHike] = useState('');
  const [promoted, setPromoted] = useState(false);
  const [pip, setPip] = useState(false);

  const moved = rating !== '' && managerRating !== null && rating !== managerRating;

  const save = async () => {
    if (rating === '') { app.toast('Set the final rating', 'err'); return; }
    const h = hike === '' ? undefined : Number(hike);
    if (h !== undefined && (!Number.isFinite(h) || h < 0 || h > 100)) {
      app.toast('An increment is a percentage between 0 and 100', 'err');
      return;
    }
    setBusy(true);
    try {
      const outcome: ReviewOutcome = {
        rating,
        potential: Number(potential),
        promoted,
        pip,
        ...(h === undefined ? {} : { hike: h }),
      };
      await calibrate.mutate(empId, outcome);
      app.toast('Review calibrated and closed', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not calibrate', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Close review">
      <div className="muted" style={{ fontSize: 12.5 }}>{who}</div>

      <label className="fld"><span>Final rating</span></label>
      <RatingPicker value={rating} onChange={setRating} />
      {moved && (
        <div className="muted" style={{ fontSize: 12, color: 'var(--t-amber-ink)' }}>
          This differs from the manager&rsquo;s rating of{' '}
          {RATINGS.find((r) => r.v === managerRating)?.label}. Calibration is
          allowed to move it — the manager should hear why from you, not from
          the letter.
        </div>
      )}

      <div className="grid g2">
        <label className="fld">
          <span>Potential</span>
          <select className="input" value={potential}
            onChange={(e) => setPotential(e.target.value)}>
            <option value="3">High</option>
            <option value="2">Medium</option>
            <option value="1">Low</option>
          </select>
        </label>
        <label className="fld">
          <span>Increment %</span>
          <input className="input" type="number" min="0" max="100" step="0.5" value={hike}
            placeholder="Leave blank for none"
            onChange={(e) => setHike(e.target.value)} />
        </label>
      </div>

      <label className="row muted" style={{ gap: 7, fontSize: 12.5 }}>
        <input type="checkbox" checked={promoted}
          onChange={(e) => setPromoted(e.target.checked)} />
        Promoted this cycle
      </label>
      <label className="row muted" style={{ gap: 7, fontSize: 12.5 }}>
        <input type="checkbox" checked={pip}
          onChange={(e) => { setPip(e.target.checked); if (e.target.checked) setPromoted(false); }} />
        Going on a performance plan
      </label>

      <div className="muted" style={{ fontSize: 12 }}>
        Closing the review fixes the rating and the increment. The increment is
        recorded here; payroll does not read it yet.
      </div>
    </Form>
  );
}
