/**
 * Creating a job order.
 *
 * Four sections in the order a desk fills them: who it is for, what the work
 * is, what it pays, and when it has to be done by. Nothing here validates
 * independently of the service — the form asks, the service refuses, and the
 * refusal is shown where it happened. A second copy of the rules in the screen
 * is a second place for them to drift.
 *
 * **The engagement decides the commercials.** A permanent order is quoted as a
 * salary band and has no rates; a contract is quoted as a rate pair. Showing
 * both at once would invite somebody to fill in both, and only one of them can
 * be true.
 */

import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { addDays, TODAY, ymd } from '../../lib/dates';
import {
  EDUCATION_LEVELS, EMPLOYMENT_TYPES, INDUSTRIES, JOB_PRIORITIES, JOB_SHIFTS, JOB_TYPES,
  RATE_ROLES, WORK_MODES, clientOf,
} from '../../data/staffing';
import { SKILLS } from '../../data/org';
import type { EmploymentType, JobOrderDraft, JobPriority, JobType, WorkMode } from '../../services';
import { Banner, Card } from '../../components/ui';
import { Chip } from '../../components/common';
import { useApp } from '../../state/AppContext';
import { PageActions } from '../../shell/PageActions';
import { useClients, useCreateJobOrder, useSows, useVendors, useVisiblePeople } from './data';
import { Icon } from '../../components/icons';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const Req = () => <span className="req" aria-hidden="true">*</span>;

export function CreateJobOrder({ done }: { done: (id: string) => void }) {
  const app = useApp();
  const dir = useVisiblePeople();
  const create = useCreateJobOrder();
  const { data: clients = [] } = useClients();
  const { data: sows = [] } = useSows();
  const { data: vendors = [] } = useVendors();

  /* ---- basic ---- */
  const [clientId, setClientId] = useState('');
  const [contact, setContact] = useState('');
  const [sowId, setSowId] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState(RATE_ROLES[0]);
  const [jobType, setJobType] = useState<JobType>('Contract');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('W2');
  const [priority, setPriority] = useState<JobPriority>('High');
  const [status, setStatus] = useState<'Draft' | 'Open'>('Draft');

  /* ---- details ---- */
  const [description, setDescription] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [preferred, setPreferred] = useState<string[]>([]);
  const [primaryTech, setPrimaryTech] = useState('');
  const [expMin, setExpMin] = useState('5');
  const [expMax, setExpMax] = useState('9');
  const [education, setEducation] = useState(EDUCATION_LEVELS[0]);
  const [certs, setCerts] = useState('');
  const [industry, setIndustry] = useState('');
  const [positions, setPositions] = useState('1');
  const [location, setLocation] = useState('');
  const [workMode, setWorkMode] = useState<WorkMode>('Hybrid');
  const [workAuth, setWorkAuth] = useState('');
  const [shift, setShift] = useState(JOB_SHIFTS[0]);
  const [startOn, setStartOn] = useState(ymd(addDays(TODAY, 21)));
  const [endOn, setEndOn] = useState('');

  /* ---- commercials ---- */
  const [billRate, setBillRate] = useState('');
  const [payRate, setPayRate] = useState('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [duration, setDuration] = useState('12 months');
  const [poNumber, setPoNumber] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [vms, setVms] = useState('');
  const [accountManagerId, setAccountManagerId] = useState('');
  const [salesOwnerId, setSalesOwnerId] = useState('');
  const [maxSubmissions, setMaxSubmissions] = useState('5');

  /* ---- SLA ---- */
  const [slaDays, setSlaDays] = useState('30');

  const [err, setErr] = useState('');

  const client = clientId ? clientOf(clientId) : null;
  const perm = jobType === 'Full Time' || jobType === 'Part Time';

  /* Choosing a client fills in what the client already tells us. */
  const pickClient = (id: string) => {
    setClientId(id);
    setContact('');
    setSowId('');
    if (!id) return;
    const c = clientOf(id);
    setIndustry(c.industry);
    setVms(c.vms ?? '');
    setAccountManagerId(c.ownerId);
    setSalesOwnerId(c.ownerId);
  };

  /* A permanent order is a direct hire, and has no rates to quote. */
  const pickJobType = (t: JobType) => {
    setJobType(t);
    if (t === 'Full Time' || t === 'Part Time') {
      setEmploymentType('Direct Hire');
      setDuration('Permanent');
      setPayRate('');
    } else if (employmentType === 'Direct Hire') {
      setEmploymentType('W2');
      setDuration('12 months');
    }
  };

  const toggle = (list: string[], set: (v: string[]) => void, k: string) =>
    set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  const save = async () => {
    setErr('');
    const draft: JobOrderDraft = {
      clientId,
      sowId: sowId || undefined,
      title,
      role,
      jobType,
      employmentType,
      priority,
      positions: Number(positions || 1),
      location,
      workMode,
      billRate: Number(billRate || 0),
      payRate: perm ? null : num(payRate) ?? null,
      salaryMin: perm ? num(salaryMin) ?? null : null,
      salaryMax: perm ? num(salaryMax) ?? null : null,
      skills,
      preferredSkills: preferred,
      primaryTech: primaryTech || undefined,
      description: description || undefined,
      expMin: num(expMin),
      expMax: num(expMax),
      education,
      certifications: certs.split(',').map((c) => c.trim()).filter(Boolean),
      industry: industry || undefined,
      workAuth: workAuth || undefined,
      shift,
      startOn,
      endOn: endOn || null,
      duration,
      maxSubmissions: num(maxSubmissions),
      poNumber: poNumber || null,
      vendorId: vendorId || null,
      vms: vms || null,
      accountManagerId: accountManagerId || undefined,
      salesOwnerId: salesOwnerId || undefined,
      slaDays: num(slaDays),
      status,
    };

    try {
      const made = await create.mutate(draft);
      app.toast(`Job order created${status === 'Open' ? ' and opened' : ' as a draft'}`, 'ok');
      done(made.id);
    } catch (e) {
      setErr(msg(e, 'Could not create the job order'));
    }
  };

  const people = sortBy(dir.list, (e) => e.name);

  return (
    <div className="stack">
      <PageActions>
        <button className="btn primary" disabled={create.pending} onClick={save}>
          Create job order
        </button>
      </PageActions>

      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="The job order was not created">{err}</Banner>}

      <div className="grid g2">
        {/* ---- §4 ---- */}
        <Card title="Basic information" sub="Who the order is for, and what kind it is">
          <div className="field">
            <label>Job order ID</label>
            <input className="input" value="Generated on save" disabled />
            <div className="hint">The number is issued when the order is created.</div>
          </div>

          <div className="field">
            <label>Client / account <Req /></label>
            <select className="input" value={clientId} onChange={(e) => pickClient(e.target.value)}>
              <option value="">Choose a client…</option>
              {sortBy(clients.filter((c) => c.status === 'Active'), (c) => c.name).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Client contact</label>
            <select className="input" value={contact} disabled={!client}
              onChange={(e) => setContact(e.target.value)}>
              <option value="">{client ? 'Choose a contact…' : 'Choose a client first'}</option>
              {client?.contacts.map((c) => (
                <option key={c.e} value={c.e}>{c.n} · {c.r}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Statement of work</label>
            <select className="input" value={sowId} disabled={!client}
              onChange={(e) => setSowId(e.target.value)}>
              <option value="">Not under an SOW</option>
              {sows.filter((s) => s.clientId === clientId).map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Job title <Req /></label>
            <input className="input" value={title} placeholder="Senior Data Engineer"
              onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="field">
            <label>Role <Req /></label>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              {RATE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Job type <Req /></label>
              <select className="input" value={jobType}
                onChange={(e) => pickJobType(e.target.value as JobType)}>
                {JOB_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Employment type <Req /></label>
              <select className="input" value={employmentType} disabled={perm}
                onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}>
                {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {perm && <div className="hint">A permanent role is a direct hire.</div>}
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Priority <Req /></label>
              <select className="input" value={priority}
                onChange={(e) => setPriority(e.target.value as JobPriority)}>
                {JOB_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Status <Req /></label>
              <select className="input" value={status}
                onChange={(e) => setStatus(e.target.value as 'Draft' | 'Open')}>
                <option value="Draft">Draft — not on a desk yet</option>
                <option value="Open">Open — start working it</option>
              </select>
            </div>
          </div>
        </Card>

        {/* ---- §5 ---- */}
        <Card title="Job details" sub="What the work is and who can do it">
          <div className="field">
            <label>Job description</label>
            <textarea className="input" rows={4} value={description}
              placeholder="What the team is building and what this person will own"
              onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div className="field">
            <label>Required skills</label>
            <div className="chip-pick">
              {SKILLS.slice(0, 24).map((k) => (
                <button key={k} type="button"
                  className={'chip x' + (skills.includes(k) ? ' on' : '')}
                  aria-pressed={skills.includes(k)}
                  onClick={() => toggle(skills, setSkills, k)}>{k}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Preferred skills</label>
            <div className="chip-pick">
              {SKILLS.slice(0, 24).map((k) => (
                <button key={k} type="button"
                  className={'chip x' + (preferred.includes(k) ? ' on' : '')}
                  aria-pressed={preferred.includes(k)}
                  onClick={() => toggle(preferred, setPreferred, k)}>{k}</button>
              ))}
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Primary technology</label>
              <input className="input" list="rec-skills" value={primaryTech}
                onChange={(e) => setPrimaryTech(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Experience (years)</label>
              <div className="row" style={{ gap: 7 }}>
                <input className="input" type="number" min="0" value={expMin}
                  aria-label="Minimum years" onChange={(e) => setExpMin(e.target.value)} />
                <span className="muted">to</span>
                <input className="input" type="number" min="0" value={expMax}
                  aria-label="Maximum years" onChange={(e) => setExpMax(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Education</label>
              <select className="input" value={education}
                onChange={(e) => setEducation(e.target.value)}>
                {EDUCATION_LEVELS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Certifications</label>
              <input className="input" value={certs} placeholder="AWS Solutions Architect, CKA"
                onChange={(e) => setCerts(e.target.value)} />
              <div className="hint">Comma separated.</div>
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Industry</label>
              <select className="input" value={industry}
                onChange={(e) => setIndustry(e.target.value)}>
                <option value="">—</option>
                {INDUSTRIES.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Number of positions <Req /></label>
              <input className="input" type="number" min="1" value={positions}
                onChange={(e) => setPositions(e.target.value)} />
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Location <Req /></label>
              <input className="input" value={location} placeholder="Dallas, TX"
                onChange={(e) => setLocation(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Work mode <Req /></label>
              <select className="input" value={workMode}
                onChange={(e) => setWorkMode(e.target.value as WorkMode)}>
                {WORK_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Work authorisation required</label>
              <input className="input" value={workAuth}
                placeholder="US Citizen or Green Card"
                onChange={(e) => setWorkAuth(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Shift</label>
              <select className="input" value={shift} onChange={(e) => setShift(e.target.value)}>
                {JOB_SHIFTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Start date</label>
              <input className="input" type="date" value={startOn}
                onChange={(e) => setStartOn(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Target end date</label>
              <input className="input" type="date" value={endOn} disabled={perm}
                onChange={(e) => setEndOn(e.target.value)} />
              {perm && <div className="hint">A permanent role has no end date.</div>}
            </div>
          </div>
        </Card>

        {/* ---- §6 ---- */}
        <Card title="Commercial information"
          sub={perm ? 'Quoted as a salary band' : 'Quoted as a rate pair'}>
          {perm ? (
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Salary from</label>
                <input className="input" type="number" min="0" value={salaryMin}
                  onChange={(e) => setSalaryMin(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Salary to</label>
                <input className="input" type="number" min="0" value={salaryMax}
                  onChange={(e) => setSalaryMax(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="row" style={{ gap: 12 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Bill rate <Req /></label>
                <input className="input" type="number" min="0" value={billRate}
                  onChange={(e) => setBillRate(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Pay rate</label>
                <input className="input" type="number" min="0" value={payRate}
                  onChange={(e) => setPayRate(e.target.value)} />
                <div className="hint">
                  {billRate && payRate && Number(payRate) > 0 && Number(payRate) < Number(billRate)
                    ? `Markup ${(((Number(billRate) - Number(payRate)) / Number(payRate)) * 100).toFixed(1)}%`
                    : 'Has to sit below the bill rate.'}
                </div>
              </div>
            </div>
          )}

          {perm && (
            <div className="field">
              <label>Bill rate <Req /></label>
              <input className="input" type="number" min="0" value={billRate}
                onChange={(e) => setBillRate(e.target.value)} />
              <div className="hint">
                The fee basis for a permanent placement. Still required.
              </div>
            </div>
          )}

          <div className="field">
            <label>Currency</label>
            <input className="input" value={client?.ccy ?? '—'} disabled />
            <div className="hint">Taken from the client's account.</div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Contract duration</label>
              <input className="input" value={duration} disabled={perm}
                onChange={(e) => setDuration(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Client PO / SOW number</label>
              <input className="input" value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)} />
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Vendor / MSP</label>
              <select className="input" value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}>
                <option value="">Direct</option>
                {sortBy(vendors, (v) => v.name).map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>VMS platform</label>
              <input className="input" value={vms} placeholder="Direct"
                onChange={(e) => setVms(e.target.value)} />
            </div>
          </div>

          <div className="row" style={{ gap: 12 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Account manager</label>
              <select className="input" value={accountManagerId}
                onChange={(e) => setAccountManagerId(e.target.value)}>
                <option value="">—</option>
                {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Sales owner</label>
              <select className="input" value={salesOwnerId}
                onChange={(e) => setSalesOwnerId(e.target.value)}>
                <option value="">—</option>
                {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          </div>
        </Card>

        {/* ---- §7 ---- */}
        <Card title="Recruitment SLA" sub="The clock the desk is held to">
          <div className="field">
            <label>SLA days <Req /></label>
            <input className="input" type="number" min="1" value={slaDays}
              onChange={(e) => setSlaDays(e.target.value)} />
            <div className="hint">Days from opening to the fill target.</div>
          </div>

          <div className="field">
            <label>How many profiles the client will read</label>
            <input className="input" type="number" min="1" value={maxSubmissions}
              onChange={(e) => setMaxSubmissions(e.target.value)} />
            <div className="hint">
              A recruiter cannot be targeted above this — the client would not look at them.
            </div>
          </div>

          {/*
            * The three targets are derived from the SLA rather than typed, so
            * they cannot be entered out of order. Shown because a recruiter
            * being measured against a date has a right to see it.
            */}
          {Number(slaDays) > 0 && (
            <div className="sla-preview">
              <div className="sla-pv-h">Derived targets</div>
              {[
                ['Target submission', Math.max(2, Math.round(Number(slaDays) * 0.18))],
                ['Target interview', Math.max(5, Math.round(Number(slaDays) * 0.5))],
                ['Target fill', Number(slaDays)],
              ].map(([k, d]) => (
                <div className="sla-pv-row" key={k as string}>
                  <span>{k}</span>
                  <b className="mono">{ymd(addDays(TODAY, d as number))}</b>
                  <span className="muted mono">+{d}d</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <datalist id="rec-skills">
        {SKILLS.map((k) => <option key={k} value={k} />)}
      </datalist>

      {skills.length > 0 && (
        <Card title="Summary" sub="What this order will say">
          <div className="row" style={{ gap: 7, flexWrap: 'wrap' }}>
            <Chip>{jobType}</Chip>
            <Chip>{employmentType}</Chip>
            <Chip>{workMode}</Chip>
            <Chip>{priority}</Chip>
            <Chip>{positions} {Number(positions) === 1 ? 'position' : 'positions'}</Chip>
            <Chip>{slaDays}-day SLA</Chip>
            {skills.map((k) => <Chip key={k}>{k}</Chip>)}
          </div>
        </Card>
      )}
    </div>
  );
}
