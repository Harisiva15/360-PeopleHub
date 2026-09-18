/**
 * The forms that put things into the pipeline.
 *
 * Six server methods — open a requisition, submit a candidate, book an
 * interview, record a verdict, draft an offer, record the answer — were live
 * and proven and had no way to be called. The pipeline could be read, filtered
 * and charted; nothing could be put into it.
 *
 * **Every refusal comes from the server.** These forms check only what the
 * reader can see for themselves — a missing name, a salary of zero. The rules
 * that matter, a duplicate submission or hiring past a requisition's openings,
 * belong where they cannot be bypassed, and the toast repeats whatever comes
 * back rather than guessing at it first.
 *
 * **Nothing is pre-filled with a guess.** A budget, a joining date and a panel
 * member are decisions; a form that fills them in with something plausible
 * gets them accepted unread. Dates that follow from another field — a joining
 * date a month out — are offered as a default because they are a starting
 * point, not an answer.
 */

import { useState } from 'react';
import type { Candidate, Employee, Requisition } from '../../services';
import { addDays, TODAY, ymd } from '../../lib/dates';
import { DEPTS, GRADES, SITES } from '../../data/org';
import { SOURCES } from '../../data/ats';
import { useApp } from '../../state/AppContext';
import {
  useMakeOffer, useOpenRequisition, useRespondToOffer, useScheduleInterview,
  useSubmitCandidate, useSubmitFeedback,
} from './data';

/** Wraps the shared shape of these forms: a body, a cancel, and a save. */
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

/* ---------------- open a requisition ---------------- */

export function NewRequisitionForm({ close, people }: {
  close: () => void;
  people: Employee[];
}) {
  const app = useApp();
  const open = useOpenRequisition();
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState('');
  const [dept, setDept] = useState(DEPTS[0]!.id);
  const [grade, setGrade] = useState('L2');
  const [site, setSite] = useState(SITES[0]!.id);
  const [openings, setOpenings] = useState('1');
  const [priority, setPriority] = useState('Medium');
  const [hm, setHm] = useState('');
  const [recruiter, setRecruiter] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [exp, setExp] = useState('');
  const [desc, setDesc] = useState('');
  const [skills, setSkills] = useState('');

  const save = async () => {
    if (!title.trim()) { app.toast('Give the role a title', 'err'); return; }
    if (!hm) { app.toast('Name the hiring manager', 'err'); return; }
    const n = Number(openings);
    if (!Number.isInteger(n) || n < 1) { app.toast('A requisition needs at least one opening', 'err'); return; }
    /* A band the wrong way round is arithmetic anyone can check here. */
    if (min && max && Number(min) > Number(max)) {
      app.toast('The budget minimum is above the maximum', 'err');
      return;
    }

    setBusy(true);
    try {
      await open.mutate({
        title: title.trim(), dept, grade, site, openings: n, priority,
        hiringManagerId: hm,
        ...(recruiter ? { recruiterId: recruiter } : {}),
        ...(min ? { budgetMin: Number(min) } : {}),
        ...(max ? { budgetMax: Number(max) } : {}),
        ...(exp.trim() ? { exp: exp.trim() } : {}),
        ...(desc.trim() ? { desc: desc.trim() } : {}),
        ...(skills.trim()
          ? { must: skills.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      });
      app.toast('Requisition opened', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not open the requisition', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Open requisition">
      <label className="fld">
        <span>Role title</span>
        <input className="input" value={title} autoFocus placeholder="Senior Software Engineer"
          onChange={(e) => setTitle(e.target.value)} />
      </label>

      <div className="grid g2">
        <label className="fld">
          <span>Department</span>
          <select className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
            {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Location</span>
          <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
            {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Grade</span>
          <select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}>
            {Object.keys(GRADES).map((g) => (
              <option key={g} value={g}>{GRADES[g as keyof typeof GRADES].label}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>Openings</span>
          <input className="input" type="number" min="1" value={openings}
            onChange={(e) => setOpenings(e.target.value)} />
        </label>
        <label className="fld">
          <span>Priority</span>
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Experience</span>
          <input className="input" value={exp} placeholder="5–8 years"
            onChange={(e) => setExp(e.target.value)} />
        </label>
      </div>

      <div className="grid g2">
        <label className="fld">
          <span>Hiring manager</span>
          <select className="input" value={hm} onChange={(e) => setHm(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.designation}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Recruiter</span>
          <select className="input" value={recruiter} onChange={(e) => setRecruiter(e.target.value)}>
            <option value="">Same as hiring manager</option>
            {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Budget from</span>
          <input className="input" type="number" value={min} placeholder="Annual CTC"
            onChange={(e) => setMin(e.target.value)} />
        </label>
        <label className="fld">
          <span>Budget to</span>
          <input className="input" type="number" value={max} placeholder="Annual CTC"
            onChange={(e) => setMax(e.target.value)} />
        </label>
      </div>

      <label className="fld">
        <span>Must-have skills</span>
        <input className="input" value={skills} placeholder="React, TypeScript, Node — comma separated"
          onChange={(e) => setSkills(e.target.value)} />
      </label>
      <label className="fld">
        <span>What the role is</span>
        <textarea className="input" rows={4} value={desc}
          placeholder="What this person will work on and who they will work with."
          onChange={(e) => setDesc(e.target.value)} />
      </label>
    </Form>
  );
}

/* ---------------- submit a candidate ---------------- */

export function NewCandidateForm({ close, reqs, reqId }: {
  close: () => void;
  reqs: Requisition[];
  /** Pre-selected when the form is opened from a requisition. */
  reqId?: string;
}) {
  const app = useApp();
  const submit = useSubmitCandidate();
  const [busy, setBusy] = useState(false);

  const open = reqs.filter((r) => r.status === 'Open');
  const [req, setReq] = useState(reqId ?? open[0]?.id ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState(SOURCES[0]!);
  const [exp, setExp] = useState('');
  const [current, setCurrent] = useState('');
  const [loc, setLoc] = useState('');
  const [notice, setNotice] = useState('');
  const [ctcCur, setCtcCur] = useState('');
  const [ctcExp, setCtcExp] = useState('');
  const [skills, setSkills] = useState('');

  const save = async () => {
    if (!req) { app.toast('Choose the role they are for', 'err'); return; }
    if (!name.trim()) { app.toast('The candidate needs a name', 'err'); return; }
    if (!email.trim()) { app.toast('The candidate needs an email address', 'err'); return; }

    setBusy(true);
    try {
      await submit.mutate({
        reqId: req, name: name.trim(), email: email.trim().toLowerCase(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        source,
        ...(exp.trim() ? { exp: exp.trim() } : {}),
        ...(current.trim() ? { current: current.trim() } : {}),
        ...(loc.trim() ? { loc: loc.trim() } : {}),
        ...(notice.trim() ? { notice: notice.trim() } : {}),
        ...(ctcCur ? { ctcCur: Number(ctcCur) } : {}),
        ...(ctcExp ? { ctcExp: Number(ctcExp) } : {}),
        ...(skills.trim()
          ? { skills: skills.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      });
      app.toast(`${name.trim()} submitted`, 'ok');
      close();
    } catch (e) {
      /* A duplicate submission is refused by the schema; say so plainly. */
      app.toast(e instanceof Error ? e.message : 'Could not submit the candidate', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Submit candidate">
      <label className="fld">
        <span>Applying for</span>
        <select className="input" value={req} onChange={(e) => setReq(e.target.value)}>
          <option value="">Choose a role…</option>
          {open.map((r) => (
            <option key={r.id} value={r.id}>
              {r.title} — {r.openings - r.filled} of {r.openings} to fill
            </option>
          ))}
        </select>
      </label>

      <div className="grid g2">
        <label className="fld">
          <span>Name</span>
          <input className="input" value={name} autoFocus
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="fld">
          <span>Email</span>
          <input className="input" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="fld">
          <span>Phone</span>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="fld">
          <span>Source</span>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Experience</span>
          <input className="input" value={exp} placeholder="6 years"
            onChange={(e) => setExp(e.target.value)} />
        </label>
        <label className="fld">
          <span>Current employer</span>
          <input className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="fld">
          <span>Location</span>
          <input className="input" value={loc} placeholder="Chennai"
            onChange={(e) => setLoc(e.target.value)} />
        </label>
        <label className="fld">
          <span>Notice period</span>
          <input className="input" value={notice} placeholder="60 days"
            onChange={(e) => setNotice(e.target.value)} />
        </label>
        <label className="fld">
          <span>Current CTC</span>
          <input className="input" type="number" value={ctcCur}
            onChange={(e) => setCtcCur(e.target.value)} />
        </label>
        <label className="fld">
          <span>Expected CTC</span>
          <input className="input" type="number" value={ctcExp}
            onChange={(e) => setCtcExp(e.target.value)} />
        </label>
      </div>

      <label className="fld">
        <span>Skills</span>
        <input className="input" value={skills} placeholder="Java, Spring Boot, Kafka"
          onChange={(e) => setSkills(e.target.value)} />
      </label>
    </Form>
  );
}

/* ---------------- book an interview ---------------- */

const ROUNDS = ['Screening', 'Technical I', 'Technical II', 'System Design',
  'Manager Round', 'HR / Fitment', 'Client Interview'];

export function ScheduleInterviewForm({ close, cand, people }: {
  close: () => void;
  cand: Candidate;
  people: Employee[];
}) {
  const app = useApp();
  const book = useScheduleInterview();
  const [busy, setBusy] = useState(false);

  const [round, setRound] = useState(ROUNDS[0]!);
  const [panel, setPanel] = useState('');
  /* Tomorrow is a starting point, not an answer — the time is left blank-ish. */
  const [date, setDate] = useState(ymd(addDays(TODAY, 1)));
  const [time, setTime] = useState('10:00');
  const [mode, setMode] = useState('video');

  const save = async () => {
    if (!panel) { app.toast('Choose who is taking it', 'err'); return; }
    if (!date || !time) { app.toast('Set the date and time', 'err'); return; }

    setBusy(true);
    try {
      /*
       * Sent with an explicit offset rather than as a bare local string: the
       * server stores an instant, and "10:00" means nothing without saying
       * where. IST is this tenant's zone.
       */
      await book.mutate({
        candId: cand.id, round, panelId: panel, mode,
        at: `${date}T${time}:00+05:30`,
      });
      app.toast('Interview booked', 'ok');
      close();
    } catch (e) {
      /* A clash on the panel member's calendar is refused by the server. */
      app.toast(e instanceof Error ? e.message : 'Could not book the interview', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Book interview">
      <label className="fld">
        <span>Round</span>
        <select className="input" value={round} onChange={(e) => setRound(e.target.value)}>
          {ROUNDS.map((r) => <option key={r}>{r}</option>)}
        </select>
      </label>
      <label className="fld">
        <span>Panel member</span>
        <select className="input" value={panel} autoFocus
          onChange={(e) => setPanel(e.target.value)}>
          <option value="">Choose…</option>
          {people.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.designation}</option>)}
        </select>
      </label>
      <div className="grid g2">
        <label className="fld">
          <span>Date</span>
          <input className="input" type="date" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="fld">
          <span>Time</span>
          <input className="input" type="time" value={time}
            onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <label className="fld">
        <span>Mode</span>
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
          {['video', 'phone', 'onsite', 'take_home'].map((m) => (
            <option key={m} value={m}>{m.replace('_', ' ')}</option>
          ))}
        </select>
      </label>
    </Form>
  );
}

/* ---------------- record a verdict ---------------- */

const VERDICTS: { v: 'strong_hire' | 'hire' | 'hold' | 'no_hire'; label: string }[] = [
  { v: 'strong_hire', label: 'Strong hire' },
  { v: 'hire', label: 'Hire' },
  { v: 'hold', label: 'Hold' },
  { v: 'no_hire', label: 'No hire' },
];

export function FeedbackForm({ close, interviewId, who, round }: {
  close: () => void;
  interviewId: string;
  who: string;
  round: string;
}) {
  const app = useApp();
  const submit = useSubmitFeedback();
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<typeof VERDICTS[number]['v'] | ''>('');
  const [text, setText] = useState('');

  const save = async () => {
    if (!verdict) { app.toast('Give a verdict', 'err'); return; }
    /*
     * A verdict with no reasoning is the thing a hiring review cannot use. The
     * server does not insist on it; the form does, because the person typing
     * is the only one who can supply it.
     */
    if (text.trim().length < 20) {
      app.toast('Say why — a verdict on its own is not feedback', 'err');
      return;
    }

    setBusy(true);
    try {
      await submit.mutate(interviewId, verdict, text.trim());
      app.toast('Feedback recorded', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not record the feedback', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Record feedback">
      <div className="muted" style={{ fontSize: 12.5 }}>{round} · {who}</div>
      <label className="fld">
        <span>Verdict</span>
        <select className="input" value={verdict} autoFocus
          onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
          <option value="">Choose…</option>
          {VERDICTS.map((v) => <option key={v.v} value={v.v}>{v.label}</option>)}
        </select>
      </label>
      <label className="fld">
        <span>What you saw</span>
        <textarea className="input" rows={6} value={text}
          placeholder="What they were asked, how they approached it, and what convinced you either way."
          onChange={(e) => setText(e.target.value)} />
      </label>
    </Form>
  );
}

/* ---------------- draft an offer ---------------- */

export function MakeOfferForm({ close, cand, req }: {
  close: () => void;
  cand: Candidate;
  req: Requisition | undefined;
}) {
  const app = useApp();
  const make = useMakeOffer();
  const [busy, setBusy] = useState(false);

  const [designation, setDesignation] = useState(req?.title ?? '');
  const [ctc, setCtc] = useState('');
  const [grade, setGrade] = useState<string>(req?.grade ?? 'L2');
  /* A month out is the usual shape of a notice period; it is still editable. */
  const [doj, setDoj] = useState(ymd(addDays(TODAY, 30)));

  const save = async () => {
    if (!designation.trim()) { app.toast('Give the offer a designation', 'err'); return; }
    const n = Number(ctc);
    if (!Number.isFinite(n) || n <= 0) { app.toast('An offer needs a salary above zero', 'err'); return; }
    if (!doj) { app.toast('Set a joining date', 'err'); return; }

    setBusy(true);
    try {
      await make.mutate({ candId: cand.id, designation: designation.trim(), ctc: n, grade, doj });
      app.toast('Offer drafted — review the letter before releasing it', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not draft the offer', 'err');
    } finally { setBusy(false); }
  };

  const band = req && (req.budgetMin || req.budgetMax)
    ? `Budget ${req.budgetMin.toLocaleString('en-IN')} – ${req.budgetMax.toLocaleString('en-IN')}`
    : null;
  /* Shown, not enforced: going over budget is a decision, not a mistake. */
  const over = req?.budgetMax ? Number(ctc) > req.budgetMax : false;

  return (
    <Form close={close} save={save} busy={busy} label="Draft offer">
      <div className="muted" style={{ fontSize: 12.5 }}>
        {cand.name} · expects {cand.ctcExp ? cand.ctcExp.toLocaleString('en-IN') : '—'}
        {band ? ` · ${band}` : ''}
      </div>
      <label className="fld">
        <span>Designation</span>
        <input className="input" value={designation} autoFocus
          onChange={(e) => setDesignation(e.target.value)} />
      </label>
      <div className="grid g2">
        <label className="fld">
          <span>Annual CTC</span>
          <input className="input" type="number" value={ctc}
            onChange={(e) => setCtc(e.target.value)} />
        </label>
        <label className="fld">
          <span>Grade</span>
          <select className="input" value={grade} onChange={(e) => setGrade(e.target.value)}>
            {Object.keys(GRADES).map((g) => (
              <option key={g} value={g}>{GRADES[g as keyof typeof GRADES].label}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="fld">
        <span>Joining date</span>
        <input className="input" type="date" value={doj}
          onChange={(e) => setDoj(e.target.value)} />
      </label>
      {over && (
        <div className="muted" style={{ fontSize: 12, color: 'var(--crit)' }}>
          This is above the requisition&rsquo;s budget.
        </div>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        The offer is created as a draft. Nobody sees it until it is released.
      </div>
    </Form>
  );
}

/* ---------------- record the answer ---------------- */

export function OfferResponseForm({ close, cand }: { close: () => void; cand: Candidate }) {
  const app = useApp();
  const respond = useRespondToOffer();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<'accepted' | 'declined' | 'negotiating' | ''>('');

  const save = async () => {
    if (!answer) { app.toast('What did they say?', 'err'); return; }
    setBusy(true);
    try {
      await respond.mutate(cand.id, answer);
      app.toast(answer === 'accepted'
        ? `${cand.name} accepted — moved to hired`
        : answer === 'declined' ? `${cand.name} declined` : 'Marked as negotiating', 'ok');
      close();
    } catch (e) {
      /* A draft has not been released, so there is nothing to answer yet. */
      app.toast(e instanceof Error ? e.message : 'Could not record the answer', 'err');
    } finally { setBusy(false); }
  };

  return (
    <Form close={close} save={save} busy={busy} label="Record answer">
      <div className="muted" style={{ fontSize: 12.5 }}>
        {cand.name} · offered {cand.offer ? cand.offer.ctc.toLocaleString('en-IN') : '—'}
      </div>
      <label className="fld">
        <span>What did they say?</span>
        <select className="input" value={answer} autoFocus
          onChange={(e) => setAnswer(e.target.value as typeof answer)}>
          <option value="">Choose…</option>
          <option value="accepted">Accepted</option>
          <option value="negotiating">Negotiating</option>
          <option value="declined">Declined</option>
        </select>
      </label>
      {answer === 'accepted' && (
        <div className="muted" style={{ fontSize: 12 }}>
          Accepting moves them to hired and fills one of the requisition&rsquo;s openings.
        </div>
      )}
      {answer === 'declined' && (
        <div className="muted" style={{ fontSize: 12 }}>
          Declining withdraws the offer and moves them out of the pipeline.
        </div>
      )}
    </Form>
  );
}
