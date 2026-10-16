/**
 * The right-side drawers: create, edit and view.
 *
 * Create and edit are one form. They ask for the same things and refuse on the
 * same grounds, and two forms would be two sets of validation drifting apart —
 * the second one always missing the rule somebody added to the first.
 *
 * **Nothing here decides what may be saved.** The form asks, the service
 * refuses, and the refusal is shown where it happened. A form that pre-empts
 * the rules is a second copy of them.
 */

import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { TODAY, ymd, fmtD } from '../../lib/dates';
import { DEPTS } from '../../data/org';
import { useSites } from '../../services/sites';
import { Badge, Banner, EmptyState, KV, Tabs } from '../../components/ui';
import { Avatar } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useApp } from '../../state/AppContext';
import { mayAssignRole } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import { SignInTable } from './SignIns';
import type { UserAccount, UserDraft } from '../../services';
import {
  useCreateUser, useLoginHistory, useNextCode, useUpdateUser, useVisiblePeople,
  useWorkSchedules,
} from './data';
import { ROLE_BLURB, ROLE_LABEL, RoleBadge, UserStatusBadge, whenOf } from './shared';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const Req = () => <span className="req" aria-hidden="true">*</span>;

const EMP_TYPES = ['Full-time', 'Contract', 'Intern', 'Consultant'];

/* ---------------- create / edit ---------------- */

export function UserForm({
  existing, close,
}: {
  /** Absent for a new account. Present makes this an edit of that one. */
  existing?: UserAccount;
  close: () => void;
}) {
  const app = useApp();
  const dir = useVisiblePeople();
  const sites = useSites();
  const create = useCreateUser();
  const schedules = useWorkSchedules();
  const update = useUpdateUser();
  const nextCode = useNextCode();

  const [tab, setTab] = useState<'basic' | 'more' | 'perm'>('basic');
  const [err, setErr] = useState('');

  const [name, setName] = useState(existing?.name ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [code, setCode] = useState(existing?.code ?? '');
  const [autoCode, setAutoCode] = useState(!existing);
  const [dept, setDept] = useState(existing?.dept ?? '');
  const [designation, setDesignation] = useState(existing?.designation ?? '');
  const [site, setSite] = useState(existing?.site ?? '');
  const [managerId, setManagerId] = useState(existing?.managerId ?? '');
  const [empType, setEmpType] = useState(existing?.empType ?? EMP_TYPES[0]);
  const [joinedOn, setJoinedOn] = useState(existing?.joinedOn ?? ymd(TODAY));
  const [role, setRole] = useState<AppRole>(existing?.role ?? 'employee');
  const [invite, setInvite] = useState(true);
  const [workScheduleCode, setWorkScheduleCode] = useState('');

  /*
   * Only patterns the server would accept for a new assignment. An inactive one
   * is refused by the schedule service, so offering it would be offering a
   * failure — and the service remains the authority either way.
   */
  const patterns = (schedules.data ?? []).filter((w) => w.active);

  /* The roles this caller may hand out. An admin is the only one who makes one. */
  const roles = (['employee', 'manager', 'admin'] as AppRole[])
    .filter((r) => r === existing?.role || mayAssignRole(app.role, r));

  const fillCode = async () => {
    try { setCode(await nextCode.mutate()); setAutoCode(false); }
    catch (e) { setErr(msg(e, 'Could not generate an ID')); }
  };

  const save = async () => {
    setErr('');
    const draft: UserDraft = {
      name, email, phone, dept, designation, site,
      managerId: managerId || null,
      role, empType, joinedOn,
      code: autoCode ? undefined : code,
      empId: existing?.empId ?? null,
      sendInvitation: invite,
      /*
       * Omitted entirely on an edit: `updateUser` does not take it, and a pattern
       * change is effective-dated through the employee's own record.
       */
      ...(existing ? {} : { workScheduleCode: workScheduleCode || null }),
    };
    try {
      if (existing) {
        await update.mutate(existing.id, draft);
        app.toast('User updated', 'ok');
      } else {
        await create.mutate(draft);
        app.toast(
          !app.reaches('users', 'write', 'all') && app.hasReports
            ? 'Request submitted for approval'
            : 'User created successfully.',
          'ok',
        );
      }
      close();
    } catch (e) {
      setErr(msg(e, 'Could not save'));
    }
  };

  const busy = create.pending || update.pending;
  const people = sortBy(dir.list, (e) => e.name);

  return (
    <div className="stack">
      <Tabs
        value={tab}
        options={[
          { v: 'basic' as const, label: 'Basic Details' },
          { v: 'more' as const, label: 'Additional Information' },
          { v: 'perm' as const, label: 'Permissions' },
        ]}
        onChange={setTab}
      />

      {err && <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Not saved">{err}</Banner>}

      {tab === 'basic' && (
        <>
          <div className="field">
            <label>Full name <Req /></label>
            <input className="input" value={name} placeholder="Priya Nair"
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label>Email <Req /></label>
            <input className="input" type="email" value={email} placeholder="priya@360vhm.com"
              onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label>Phone</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>

          <div className="field">
            <label>Employee ID</label>
            <label className="row" style={{ gap: 7, alignItems: 'center', marginBottom: 6 }}>
              <input type="checkbox" checked={autoCode}
                onChange={(e) => { setAutoCode(e.target.checked); if (e.target.checked) setCode(''); }} />
              <span className="muted" style={{ fontSize: 12.5 }}>Generate one automatically</span>
            </label>
            {!autoCode && (
              <div className="row" style={{ gap: 8 }}>
                <input className="input" value={code} placeholder="VHM1042"
                  onChange={(e) => setCode(e.target.value)} />
                <button className="btn sm" onClick={fillCode}>Suggest</button>
              </div>
            )}
          </div>

          <div className="field">
            <label>Department <Req /></label>
            <select className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">Choose…</option>
              {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Designation <Req /></label>
            <input className="input" value={designation} placeholder="Senior Engineer"
              onChange={(e) => setDesignation(e.target.value)} />
          </div>
          <div className="field">
            <label>Location <Req /></label>
            <select className="input" value={site} disabled={sites.loading}
              onChange={(e) => setSite(e.target.value)}>
              <option value="">{sites.loading ? 'Loading…' : 'Choose…'}</option>
              {sites.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Manager</label>
            <select className="input" value={managerId}
              onChange={(e) => setManagerId(e.target.value)}>
              <option value="">No manager</option>
              {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
        </>
      )}

      {tab === 'more' && (
        <>
          <div className="field">
            <label>Employment type</label>
            <select className="input" value={empType} onChange={(e) => setEmpType(e.target.value)}>
              {EMP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Joining date</label>
            <input className="input" type="date" value={joinedOn}
              onChange={(e) => setJoinedOn(e.target.value)} />
          </div>

          {/*
            * Which days they work, chosen here because this is where the joining
            * date is — the assignment starts on it.
            *
            * Only offered when creating. Changing somebody's pattern afterwards
            * is effective-dated and belongs on their own record, where the
            * history is visible; a second editor here would quietly rewrite the
            * current period instead of opening a new one.
            */}
          {!existing && (
            <div className="field">
              <label htmlFor="user-sched">Work schedule</label>
              {patterns.length ? (
                <>
                  <select id="user-sched" className="input" value={workScheduleCode}
                    aria-describedby="user-sched-hint"
                    onChange={(e) => setWorkScheduleCode(e.target.value)}>
                    <option value="">Not assigned</option>
                    {patterns.map((w) => (
                      <option key={w.code} value={w.code}>
                        {w.name} ({w.days.filter((d) => d.working).length} days a week)
                      </option>
                    ))}
                  </select>
                  <div className="hint" id="user-sched-hint">
                    {workScheduleCode
                      ? <>Applies from {fmtD(joinedOn)}, the joining date above.</>
                      : (
                        <>
                          Leaving this unassigned is a real choice, not a gap: their
                          calendar falls back to Monday&ndash;Friday and their record
                          shows &ldquo;Not assigned&rdquo; until somebody sets one.
                        </>
                      )}
                  </div>
                </>
              ) : (
                <div className="hint">
                  No working pattern has been set up yet. Add one under Shifts &amp; work
                  schedules, or leave this person unassigned for now.
                </div>
              )}
            </div>
          )}

          {existing && (
            <div style={{ marginTop: 6 }}>
              <KV rows={[
                ['Created', fmtD(existing.createdOn)],
                ['Created by', existing.createdById ? dir.name(existing.createdById) : '—'],
                ['Last modified', existing.modifiedOn ? fmtD(existing.modifiedOn) : '—'],
                ['Modified by', existing.modifiedById ? dir.name(existing.modifiedById) : '—'],
                ['Last login', whenOf(existing.lastLoginAt)],
              ]} />
            </div>
          )}
        </>
      )}

      {tab === 'perm' && (
        <>
          <div className="field">
            <label>Role <Req /></label>
            <select className="input" value={role}
              onChange={(e) => setRole(e.target.value as AppRole)}>
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <div className="hint">{ROLE_BLURB[role]}</div>
          </div>

          {!app.reaches('users', 'write', 'all') && app.hasReports && (
            <Banner kind="info" icon={<Icon n="info" size="lg" />} title="This will need approval">
              Accounts you raise arrive as Pending Approval. An administrator decides
              them, and the account becomes active once they do.
            </Banner>
          )}

          {!existing && (
            <>
              <div className="field">
                <label>Password</label>
                <label className="row" style={{ gap: 7, alignItems: 'center' }}>
                  <input type="radio" checked={invite} onChange={() => setInvite(true)} />
                  <span style={{ fontSize: 13 }}>Send an invitation to set their own</span>
                </label>
                <label className="row" style={{ gap: 7, alignItems: 'center', marginTop: 5 }}>
                  <input type="radio" checked={!invite} onChange={() => setInvite(false)} />
                  <span style={{ fontSize: 13 }}>Set one now, changed at first sign-in</span>
                </label>
              </div>
              {invite && (
                <div className="hint" style={{ marginTop: -4 }}>
                  An invitation email will be sent to this user with login instructions.
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="row" style={{ justifyContent: 'flex-end', gap: 9, marginTop: 6 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>
          {existing ? 'Save changes'
          : app.reaches('users', 'write', 'all') ? 'Create user' : 'Submit request'}
        </button>
      </div>
    </div>
  );
}

/* ---------------- view ---------------- */

/** The read-only profile — §9. */
export function UserProfile({ u }: { u: UserAccount }) {
  const dir = useVisiblePeople();
  const [tab, setTab] = useState<'profile' | 'access' | 'activity' | 'signins'>('profile');
  /*
   * Fetched whichever tab is open. The drawer is opened to look at one
   * person and the history is a few dozen rows — deferring it buys a
   * spinner on the tab somebody is most likely to click.
   */
  const { data: signIns = [], loading: signInsLoading } = useLoginHistory(u.empId ?? undefined);

  return (
    <div className="stack">
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <Avatar name={u.name} size="lg" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 750, fontSize: 16 }}>{u.name}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{u.designation}</div>
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <UserStatusBadge s={u.status} />
            <RoleBadge r={u.role} />
            <Badge kind="mute">{u.code}</Badge>
          </div>
        </div>
      </div>

      <Tabs
        value={tab}
        options={[
          { v: 'profile' as const, label: 'Profile' },
          { v: 'access' as const, label: 'Access & Role' },
          { v: 'activity' as const, label: 'Activity' },
          { v: 'signins' as const, label: 'Sign-ins' },
        ]}
        onChange={setTab}
      />

      {tab === 'profile' && (
        <KV rows={[
          ['Employee ID', u.code],
          ['Email', u.email],
          ['Phone', u.phone || '—'],
          ['Department', u.dept],
          ['Designation', u.designation],
          ['Location', u.site],
          ['Manager', u.managerId ? dir.name(u.managerId) : '—'],
          ['Employment type', u.empType],
          ['Joining date', fmtD(u.joinedOn)],
        ]} />
      )}

      {tab === 'access' && (
        <>
          <KV rows={[
            ['Role', <RoleBadge r={u.role} />],
            ['Status', <UserStatusBadge s={u.status} />],
            ['Can sign in', u.status === 'Active' ? 'Yes' : 'No'],
            ['Must change password', u.mustChangePassword ? 'At next sign-in' : 'No'],
            ['Two-factor sign-in', u.mfaRequired
              ? 'Required — they must set it up before using the account'
              : 'Optional'],
            ['Invitations sent', u.invitedCount],
            ['Invitation sent', u.inviteSentAt ? fmtD(u.inviteSentAt) : '—'],
          ]} />
          <div className="hint" style={{ marginTop: 10 }}>{ROLE_BLURB[u.role]}</div>
          {u.status === 'Locked' && (
            <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="Locked">
              {u.lockReason || 'Locked by an administrator'}
              {u.lockedAt && <>, {fmtD(u.lockedAt)}</>}
            </Banner>
          )}
          {u.status !== 'Active' && u.deactivationReason && (
            <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title={`${u.status}`}>
              {u.deactivationReason}
              {u.deactivatedById && <> — {dir.name(u.deactivatedById)}</>}
              {u.deactivatedAt && <>, {fmtD(u.deactivatedAt)}</>}
            </Banner>
          )}
        </>
      )}

      {tab === 'signins' && (
        <div className="stack">
          {signInsLoading
            ? <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>
            : (
              <SignInTable
                rows={signIns}
                emptyMsg={u.empId
                  ? 'No sign-ins recorded for this account yet'
                  : 'This account has no employee record, so nothing is recorded against it'}
              />
            )}
        </div>
      )}

      {tab === 'activity' && (
        <KV rows={[
          ['Last login', whenOf(u.lastLoginAt)],
          ['Created', fmtD(u.createdOn)],
          ['Created by', u.createdById ? dir.name(u.createdById) : '—'],
          ['Last modified', u.modifiedOn ? fmtD(u.modifiedOn) : '—'],
          ['Modified by', u.modifiedById ? dir.name(u.modifiedById) : '—'],
          ['Requested by', u.requestedById ? dir.name(u.requestedById) : '—'],
          ['Approved by', u.approvedById ? dir.name(u.approvedById) : '—'],
          ['Approved on', u.approvedAt ? fmtD(u.approvedAt) : '—'],
        ]} />
      )}
    </div>
  );
}

/* ---------------- delete ---------------- */

/**
 * §11's typed confirmation.
 *
 * The typing is checked by the service too. A confirmation the client can skip
 * protects nobody — this one is here so somebody has to mean it, not so the
 * rule is enforced.
 */
export function DeleteConfirmation({
  u, onConfirm, close,
}: {
  u: UserAccount;
  onConfirm: (typed: string) => Promise<void>;
  close: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try { await onConfirm(typed); close(); }
    catch (e) { setErr(msg(e, 'Could not delete')); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
        Are you sure you want to delete <b>{u.name}</b>?
      </p>
      <Banner kind="warn" icon={<Icon n="warn" size="lg" />} title="What this does">
        Deleting the account removes login access. The employment record is kept —
        historical HR records are retained according to company policy, and this
        does not touch them.
      </Banner>
      <div className="field">
        <label>Type <b>DELETE</b> to confirm</label>
        <input className="input" value={typed} autoFocus placeholder="DELETE"
          onChange={(e) => setTyped(e.target.value)} />
      </div>
      {err && <div className="ts-err-box">⚠ {err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn danger" disabled={busy || typed !== 'DELETE'} onClick={go}>
          Delete user
        </button>
      </div>
    </div>
  );
}

/** §10's confirmation — deactivation asks why, because the audit is asked why. */
export function DeactivateConfirmation({
  u, onConfirm, close,
}: {
  u: UserAccount;
  onConfirm: (reason: string) => Promise<void>;
  close: () => void;
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try { await onConfirm(reason); close(); }
    catch (e) { setErr(msg(e, 'Could not deactivate')); }
    finally { setBusy(false); }
  };

  return (
    <div className="stack">
      <p style={{ margin: 0, fontSize: 13.5 }}>
        <b>{u.name}</b> will no longer be able to sign in. The account and every
        record attached to it are kept.
      </p>
      <div className="field">
        <label>Reason <Req /></label>
        <input className="input" value={reason} autoFocus placeholder="Left the company"
          onChange={(e) => setReason(e.target.value)} />
        <div className="hint">Shown on the account and recorded against your name.</div>
      </div>
      {err && <div className="ts-err-box">⚠ {err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 9 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn danger" disabled={busy || !reason.trim()} onClick={go}>
          Deactivate user
        </button>
      </div>
    </div>
  );
}

export { EmptyState };
