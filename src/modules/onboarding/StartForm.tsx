/**
 * Starting an onboarding journey directly.
 *
 * `onboarding.create` was live and the only way to reach it was to complete a
 * hire through the ATS. Anyone joining another way — a transfer between
 * entities, a rehire, someone hired before this system existed — could not be
 * onboarded at all.
 *
 * **The joining date is the spine.** The whole checklist is dated around it:
 * documents chased a week before, assets three days before, payroll the day
 * after. Getting it wrong does not fail, it produces a set of tasks already
 * overdue on the day they are created.
 */

import { useState } from 'react';
import type { Employee } from '../../services';
import { addDays, fmtD, TODAY, ymd } from '../../lib/dates';
import { DEPTS } from '../../data/org';
import { useSites } from '../../services/sites';
import { useApp } from '../../state/AppContext';
import { useCreateJourney } from './data';

export function StartJourneyForm({ close, people }: {
  close: () => void;
  people: Employee[];
}) {
  const app = useApp();
  const create = useCreateJourney();
  const sites = useSites();
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [dept, setDept] = useState(DEPTS[0]!.id);
  const [designation, setDesignation] = useState('');
  /* Empty until the locations arrive; `posting` below supplies the default. */
  const [site, setSite] = useState('');
  const [doj, setDoj] = useState(ymd(addDays(TODAY, 14)));
  const [managerId, setManagerId] = useState('');
  const [buddyId, setBuddyId] = useState('');
  const [ctc, setCtc] = useState('');

  const past = doj < ymd(TODAY);

  /* Head office where one is nominated, otherwise the first location returned. */
  const posting = site || sites.headquarters?.id || sites.list[0]?.id || '';

  const save = async () => {
    if (!name.trim()) { app.toast('The joiner needs a name', 'err'); return; }
    if (!designation.trim()) { app.toast('What are they joining as?', 'err'); return; }
    if (!posting) { app.toast('Choose a location', 'err'); return; }
    if (!doj) { app.toast('Set a joining date', 'err'); return; }
    setBusy(true);
    try {
      await create.mutate({
        name: name.trim(), dept, designation: designation.trim(), site: posting, doj,
        ...(managerId ? { managerId } : {}),
        ...(buddyId ? { buddyId } : {}),
        ...(ctc ? { ctc: Number(ctc) } : {}),
      });
      app.toast('Journey started — the checklist and documents are open', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not start the journey', 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <div className="muted" style={{ fontSize: 12.5 }}>
        For somebody joining outside the recruitment pipeline — a transfer, a
        rehire, or a hire made before this system.
      </div>

      <div className="grid g2">
        <label className="fld">
          <span>Name</span>
          <input className="input" value={name} autoFocus
            onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="fld">
          <span>Joining as</span>
          <input className="input" value={designation} placeholder="Senior Engineer"
            onChange={(e) => setDesignation(e.target.value)} />
        </label>
        <label className="fld">
          <span>Department</span>
          <select className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
            {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Location</span>
          <select className="input" value={posting} disabled={sites.loading}
            onChange={(e) => setSite(e.target.value)}>
            {sites.loading && <option value="">Loading…</option>}
            {sites.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Joining date</span>
          <input className="input" type="date" value={doj}
            onChange={(e) => setDoj(e.target.value)} />
        </label>
        <label className="fld">
          <span>Annual CTC</span>
          <input className="input" type="number" min="0" value={ctc}
            placeholder="Optional"
            onChange={(e) => setCtc(e.target.value)} />
        </label>
        <label className="fld">
          <span>Reporting manager</span>
          <select className="input" value={managerId}
            onChange={(e) => setManagerId(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((e) => (
              <option key={e.id} value={e.id}>{e.name} — {e.designation}</option>
            ))}
          </select>
        </label>
        <label className="fld">
          <span>Onboarding buddy</span>
          <select className="input" value={buddyId}
            onChange={(e) => setBuddyId(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
      </div>

      {past && (
        <div className="muted" style={{ fontSize: 12.5, color: 'var(--t-amber-ink)' }}>
          {fmtD(doj)} has passed. The checklist is dated around the joining day,
          so several tasks will be created already overdue — which is right for
          somebody who has started, and wrong if this is a typo.
        </div>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        The standard checklist and the joiner document list open with the
        journey. Completing it creates the employee record.
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Start journey'}
        </button>
      </div>
    </div>
  );
}
