/**
 * Adding a new joiner.
 *
 * The same form for both roles, and deliberately so — a manager filling in a
 * different, lesser form would learn that theirs is the second-class path.
 * What differs is the outcome, and the form says which before it is submitted:
 * an admin's creates the person, a manager's queues for approval.
 *
 * Nothing here decides that. The server does, from the session; the wording
 * below only reflects it. A form that made the choice would be a form that
 * could be edited to make a different one.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Banner, Card } from '../../components/ui';
import { useApp } from '../../state/AppContext';
import { DEPTS, GRADES, SITES } from '../../data/org';
import { getServices } from '../../services';
import type { Grade } from '../../types/country';

export interface JoinerDraft {
  fullName: string;
  workEmail: string;
  employeeCode: string;
  designation: string;
  dept: string;
  site: string;
  grade: string;
  joiningOn: string;
  employmentType: string;
}

const EMPTY: JoinerDraft = {
  fullName: '',
  workEmail: '',
  employeeCode: '',
  designation: '',
  dept: '',
  site: '',
  grade: '',
  joiningOn: '',
  employmentType: 'permanent',
};

export function AddJoinerForm({ close, onDone }: { close: () => void; onDone: () => void }) {
  const app = useApp();
  const [d, setD] = useState<JoinerDraft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = app.role === 'admin';
  const set = <K extends keyof JoinerDraft>(k: K, v: JoinerDraft[K]) =>
    setD((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!d.fullName.trim()) return setError('Enter the joiner’s full name');
    if (!d.workEmail.trim()) return setError('Enter a work email address');
    if (!d.joiningOn) return setError('Enter a joining date');

    setBusy(true);
    try {
      /*
       * Called through the service seam rather than fetch, so this screen works
       * against the mock when no API is configured — the public demo still has
       * to run.
       */
      const services = getServices() as unknown as {
        joiners?: { request: (draft: JoinerDraft) => Promise<{ status: string }> };
      };
      if (!services.joiners) {
        throw new Error('Adding people needs the API — this build is the demo.');
      }

      const created = await services.joiners.request({
        ...d,
        fullName: d.fullName.trim(),
        workEmail: d.workEmail.trim(),
      });

      app.toast(
        created.status === 'approved'
          ? `${d.fullName} added — employee record created`
          : `${d.fullName} sent to an admin for approval`,
        'ok',
      );
      onDone();
      close();
    } catch (err) {
      // The server's message is the useful one: duplicate address, unknown
      // department, a code already in use.
      setError(err instanceof Error ? err.message : 'Could not add this person');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <Banner kind={isAdmin ? 'info' : 'warn'} icon={isAdmin ? 'ℹ' : '⏳'}>
        {isAdmin
          ? 'Creates the employee record immediately, with opening leave balances.'
          : 'Goes to an admin for approval. The employee record is created once they approve.'}
      </Banner>

      <div className="grid g2" style={{ gap: '0 14px', marginTop: 14 }}>
        <div className="field">
          <label htmlFor="j-name">Full name</label>
          <input id="j-name" className="input" autoFocus value={d.fullName}
            onChange={(e) => set('fullName', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="j-email">Work email</label>
          <input id="j-email" className="input" type="email" value={d.workEmail}
            onChange={(e) => set('workEmail', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="j-doj">Joining date</label>
          <input id="j-doj" className="input" type="date" value={d.joiningOn}
            onChange={(e) => set('joiningOn', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="j-desig">Designation</label>
          <input id="j-desig" className="input" value={d.designation}
            onChange={(e) => set('designation', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="j-dept">Department</label>
          <select id="j-dept" className="input" value={d.dept}
            onChange={(e) => set('dept', e.target.value)}>
            <option value="">—</option>
            {DEPTS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="j-site">Location</label>
          <select id="j-site" className="input" value={d.site}
            onChange={(e) => set('site', e.target.value)}>
            <option value="">—</option>
            {SITES.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="j-grade">Grade</label>
          <select id="j-grade" className="input" value={d.grade}
            onChange={(e) => set('grade', e.target.value)}>
            <option value="">—</option>
            {(Object.keys(GRADES) as Grade[]).map((g) =>
              <option key={g} value={g}>{GRADES[g].label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="j-type">Employment type</label>
          <select id="j-type" className="input" value={d.employmentType}
            onChange={(e) => set('employmentType', e.target.value)}>
            <option value="permanent">Full-time</option>
            <option value="contract">Contract</option>
            <option value="intern">Intern</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="j-code">Employee code</label>
        <input id="j-code" className="input" placeholder="Leave blank to generate the next one"
          value={d.employeeCode} onChange={(e) => set('employeeCode', e.target.value)} />
        <div className="hint">Blank continues the VHM series from the highest code in use.</div>
      </div>

      {error && <div className="login-msg err" role="alert">{error}</div>}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 8 }}>
        <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : isAdmin ? 'Create employee' : 'Send for approval'}
        </button>
      </div>
    </form>
  );
}

/** The admin's approval queue, and a manager's view of what they have raised. */
export function JoinerQueue({ rows, onDecide }: {
  rows: {
    id: string; fullName: string; workEmail: string; dept: string | null;
    designation: string | null; joiningOn: string; status: string;
    requestedByName: string | null;
  }[];
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
}) {
  const app = useApp();
  const pending = rows.filter((r) => r.status === 'pending');

  if (!pending.length) return null;

  return (
    <Card title="Awaiting approval" sub={`${pending.length} joiner(s)`} flush>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Joining</th><th>Raised by</th>
              {app.role === 'admin' && <th className="right">Decision</th>}
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => (
              <tr key={r.id}>
                <td><b>{r.fullName}</b></td>
                <td className="muted">{r.workEmail}</td>
                <td>{r.designation ?? '—'}{r.dept ? ` · ${r.dept}` : ''}</td>
                <td className="nowrap">{r.joiningOn}</td>
                <td className="muted">{r.requestedByName ?? '—'}</td>
                {app.role === 'admin' && (
                  <td className="right">
                    <button className="btn sm" onClick={() => onDecide(r.id, 'reject')}>Reject</button>
                    {' '}
                    <button className="btn sm primary" onClick={() => onDecide(r.id, 'approve')}>
                      Approve
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
