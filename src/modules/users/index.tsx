/**
 * User Management.
 *
 * An account is not an employee. An employee is somebody the company employs;
 * an account is a way to sign in as them. Most people have both, some have one
 * — a contractor with a login and no payroll record, a leaver whose employment
 * history is kept long after their account is gone — and this module
 * administers the second without touching the first. That is why delete is
 * soft: removing the login must never take the employment record with it.
 *
 * **Nothing here is a permission.** Every control is hidden when the role
 * cannot use it, and every one is refused again by the service. The hiding is
 * a courtesy so nobody is offered a button that answers "you cannot do that";
 * the refusal is the boundary, and it is the one that holds when somebody
 * types a URL.
 */

import { useState } from 'react';
import { sortBy, uniq } from '../../lib/collections';
import { downloadCSV } from '../../lib/csv';
import { DEPTS, SITES, deptOf, siteOf } from '../../data/org';
import { USER_STATUSES } from '../../services';
import type { UserAccount, UserFilter, UserStatus } from '../../services';
import { Avatar, Card, EmptyState, StatRow, Tabs, Tile } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useLayer } from '../../components/Layer';
import { Menu } from '../../components/Menu';
import { useApp } from '../../state/AppContext';
import type { AppRole } from '../../types/employee';
import { PageActions } from '../../shell/PageActions';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useTabFromUrl } from '../tabParam';
import {
  useBulkUpdate, useDecideUser, useDeleteUser, useResendInvitation, useResetPassword,
  useSetUserStatus, useUserStats, useUsers, useVisiblePeople,
  useTenantLoginHistory,
  useSetMfaRequired,
} from './data';
import {
  DeactivateConfirmation, DeleteConfirmation, UserForm, UserProfile,
} from './Drawers';
import { SignInTable } from './SignIns';
import { PermissionGuard, RoleBadge, UserStatusBadge, useMay, whenOf } from './shared';

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/* ---------------- filters ---------------- */

function Filters({
  f, set, rows,
}: {
  f: UserFilter;
  set: (next: UserFilter) => void;
  rows: UserAccount[];
}) {
  const dir = useVisiblePeople();
  const managers = uniq(rows.map((u) => u.managerId).filter(Boolean) as string[]);
  const types = uniq(rows.map((u) => u.empType));
  const one = (k: keyof UserFilter) => (v: string) => set({ ...f, [k]: v || undefined });

  return (
    <div className="toolbar">
      <div className="gsearch" style={{ width: 260, flex: '0 0 auto' }}>
        <span className="gsearch-ic" aria-hidden="true"><Icon n="search" /></span>
        <input
          className="gsearch-in"
          type="search"
          value={f.q ?? ''}
          placeholder="Name, email or employee ID…"
          aria-label="Search users"
          onChange={(e) => one('q')(e.target.value)}
        />
      </div>

      <select className="input sm" value={f.dept ?? ''} aria-label="Department"
        onChange={(e) => one('dept')(e.target.value)}>
        <option value="">All departments</option>
        {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>

      <select className="input sm" value={f.role ?? ''} aria-label="Role"
        onChange={(e) => one('role')(e.target.value)}>
        <option value="">All roles</option>
        <option value="admin">Administrator</option>
        <option value="manager">Manager</option>
        <option value="employee">Employee</option>
      </select>

      <select className="input sm" value={f.site ?? ''} aria-label="Location"
        onChange={(e) => one('site')(e.target.value)}>
        <option value="">All locations</option>
        {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <select className="input sm" value={f.managerId ?? ''} aria-label="Manager"
        onChange={(e) => one('managerId')(e.target.value)}>
        <option value="">All managers</option>
        {managers.map((id) => <option key={id} value={id}>{dir.name(id)}</option>)}
      </select>

      <select className="input sm" value={f.empType ?? ''} aria-label="Employment type"
        onChange={(e) => one('empType')(e.target.value)}>
        <option value="">All types</option>
        {types.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      <input className="input sm" type="date" value={f.joinedFrom ?? ''}
        aria-label="Joined on or after" style={{ width: 150 }}
        onChange={(e) => one('joinedFrom')(e.target.value)} />

      <div className="spacer" />
      {Object.values(f).some(Boolean) && (
        <button className="btn sm" onClick={() => set({})}>Reset</button>
      )}
    </div>
  );
}

/* ---------------- the page ---------------- */

type Tab = 'all' | 'pending' | 'active' | 'inactive' | 'locked' | 'invited' | 'signins';

/*
 * `signins` is the one tab that is not a filter over the same list — it
 * answers a different question against a different table. Undefined here,
 * and the render branches on it rather than pretending it is a status.
 */
const TAB_STATUS: Record<Tab, UserStatus | undefined> = {
  all: undefined,
  pending: 'Pending Approval',
  active: 'Active',
  inactive: 'Inactive',
  locked: 'Locked',
  invited: 'Invitation Pending',
  signins: undefined,
};

function UsersView() {
  const app = useApp();
  const layer = useLayer();
  const dir = useVisiblePeople();
  const can = useMay();

  const [tab, setTab] = useTabFromUrl<Tab>('all',
    ['all', 'pending', 'active', 'inactive', 'locked', 'invited', 'signins']);
  const [f, setF] = useState<UserFilter>({});
  const [picked, setPicked] = useState<string[]>([]);

  const filter: UserFilter = { ...f, status: TAB_STATUS[tab] ?? f.status };
  const { data: rows = [], loading, error } = useUsers(filter);
  const { data: all = [] } = useUsers({});
  const { data: stats } = useUserStats();
  /*
   * Only fetched on the tab that shows it: this is every account's history
   * rather than one person's, and it is not worth pulling on the way to the
   * list somebody actually opened the page for.
   */
  const { data: signIns = [], loading: signInsLoading } =
    useTenantLoginHistory(tab === 'signins');

  const setStatus = useSetUserStatus();
  const remove = useDeleteUser();
  const decide = useDecideUser();
  const resend = useResendInvitation();
  const reset = useResetPassword();
  const mfaReq = useSetMfaRequired();
  const bulk = useBulkUpdate();

  /*
   * An employee reaching this by URL gets the refusal, not an empty table. The
   * service is what refused; this only says so legibly.
   */
  if (error) {
    return (
      <Card title="User Management">
        <EmptyState icon={<Icon n="lock" size="xl" />} msg={error.message} />
      </Card>
    );
  }

  const act = async (run: () => Promise<unknown>, done: string) => {
    try { await run(); app.toast(done, 'ok'); }
    catch (e) { app.toast(msg(e, 'That did not work'), 'err'); }
  };

  const openForm = (u?: UserAccount) => layer.drawer({
    title: u ? 'Edit user' : 'Create new user',
    sub: u?.name ?? 'A new account',
    body: (close) => <UserForm existing={u} close={close} />,
    footer: null,
  });

  const openProfile = (u: UserAccount) => layer.drawer({
    title: 'User profile',
    sub: u.email,
    body: <UserProfile u={u} />,
  });

  const confirmDelete = (u: UserAccount) => layer.modal({
    title: 'Delete user',
    sub: u.name,
    size: 'narrow',
    body: (close) => (
      <DeleteConfirmation u={u} close={close}
        onConfirm={async (typed) => {
          await remove.mutate(u.id, typed);
          app.toast('User deleted', 'ok');
        }} />
    ),
    footer: null,
  });

  const confirmDeactivate = (u: UserAccount) => layer.modal({
    title: 'Deactivate user?',
    sub: u.name,
    size: 'narrow',
    body: (close) => (
      <DeactivateConfirmation u={u} close={close}
        onConfirm={async (reason) => {
          await setStatus.mutate(u.id, 'Inactive', reason);
          app.toast('User deactivated', 'ok');
        }} />
    ),
    footer: null,
  });

  const toggleAll = () =>
    setPicked(picked.length === rows.length ? [] : rows.map((u) => u.id));
  const toggleOne = (id: string) =>
    setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const exportCsv = () => downloadCSV('users.csv', [
    ['Employee ID', 'Name', 'Email', 'Department', 'Designation', 'Location',
      'Role', 'Manager', 'Status', 'Employment type', 'Joined', 'Last login'],
    ...rows.map((u) => [
      u.code, u.name, u.email, deptOf(u.dept).name, u.designation, siteOf(u.site).name,
      u.role, u.managerId ? dir.name(u.managerId) : '—', u.status, u.empType,
      u.joinedOn, u.lastLoginAt ?? 'Never',
    ]),
  ]);

  const bulkSet = async (patch: Parameters<typeof bulk.mutate>[1]) => {
    await act(() => bulk.mutate(picked, patch), `${picked.length} users updated`);
    setPicked([]);
  };

  const tabs: { v: Tab; label: string }[] = [
    { v: 'all', label: 'All Users' },
    { v: 'pending', label: 'Pending Approval' },
    { v: 'active', label: 'Active Users' },
    { v: 'inactive', label: 'Inactive Users' },
    { v: 'locked', label: 'Locked' },
    { v: 'invited', label: 'Invitations' },
    { v: 'signins', label: 'Sign-in Activity' },
  ];

  return (
    <div className="stack">
      <PageActions>
        <PermissionGuard action="user.export">
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>
            <Icon n="download" size="lg" /> Export
          </button>
        </PermissionGuard>
        <PermissionGuard action="user.create">
          <button className="btn primary" onClick={() => openForm()}>
            <Icon n="add" size="lg" /> Create New User
          </button>
        </PermissionGuard>
      </PageActions>

      <StatRow cols={5}>
        <Tile icon={<Icon n="people" size="lg" />} label="Total users"
          value={stats?.total ?? '—'} foot="Accounts you administer" />
        <Tile icon={<Icon n="done" size="lg" />} label="Active"
          value={stats?.active ?? '—'} foot="Able to sign in" />
        <Tile icon={<Icon n="pending" size="lg" />} label="Pending approval"
          value={stats?.pendingApproval ?? '—'} foot="Raised, awaiting a decision" />
        <Tile icon={<Icon n="blocked" size="lg" />} label="Inactive"
          value={stats?.inactive ?? '—'} foot="Deactivated or held" />
        <Tile icon={<Icon n="mail" size="lg" />} label="Invitations pending"
          value={stats?.invitationPending ?? '—'} foot="Sent, not yet accepted" />
      </StatRow>

      <Tabs value={tab} options={tabs} onChange={(v) => { setTab(v); setPicked([]); }} />

      {tab === 'signins' ? (
        <Card
          title="Sign-in Activity"
          sub={`${signIns.length} ${signIns.length === 1 ? 'event' : 'events'}, newest first`}
          flush
        >
          <div style={{ padding: 12 }}>
            {/*
              * Said before the table rather than after it: somebody arriving
              * here is looking for a wrong password and will otherwise read
              * its absence as "there were none".
              */}
            <div className="hint" style={{ marginBottom: 10 }}>
              Sessions that started, ended, or were refused. Wrong passwords are
              checked by the sign-in provider and are not recorded here.
            </div>
            {signInsLoading
              ? <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>
              : <SignInTable rows={signIns} dir={dir} showWho />}
          </div>
        </Card>
      ) : (
        <>
      <Filters f={f} set={setF} rows={all} />

      {picked.length > 0 && (
        <div className="bulkbar">
          <b>{picked.length} selected</b>
          <div className="spacer" />
          <PermissionGuard action="user.activate">
            <button className="btn sm" onClick={() => bulkSet({})}>Activate</button>
          </PermissionGuard>
          <PermissionGuard action="user.bulk_update">
            <select className="input sm" defaultValue="" aria-label="Change department"
              onChange={(e) => e.target.value && bulkSet({ dept: e.target.value })}>
              <option value="">Change department…</option>
              {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select className="input sm" defaultValue="" aria-label="Change location"
              onChange={(e) => e.target.value && bulkSet({ site: e.target.value })}>
              <option value="">Change location…</option>
              {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select className="input sm" defaultValue="" aria-label="Assign manager"
              onChange={(e) => e.target.value && bulkSet({ managerId: e.target.value })}>
              <option value="">Assign manager…</option>
              {sortBy(dir.list, (e) => e.name).map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </PermissionGuard>
          <PermissionGuard action="user.export">
            <button className="btn sm" onClick={exportCsv}>Export</button>
          </PermissionGuard>
          <button className="btn sm" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}

      <Card
        title={tabs.find((t) => t.v === tab)!.label}
        sub={`${rows.length} ${rows.length === 1 ? 'account' : 'accounts'}`}
        flush
      >
        {rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <input type="checkbox" aria-label="Select all"
                      checked={picked.length === rows.length && rows.length > 0}
                      onChange={toggleAll} />
                  </th>
                  <th>User</th><th>Employee ID</th><th>Department</th>
                  <th>Role</th><th>Manager</th><th>Status</th><th>Last login</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <input type="checkbox" checked={picked.includes(u.id)}
                        aria-label={`Select ${u.name}`}
                        onChange={() => toggleOne(u.id)} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 9, alignItems: 'center' }}>
                        <Avatar name={u.name} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 650, fontSize: 13 }}>{u.name}</div>
                          <div className="muted" style={{ fontSize: 11.5 }}>{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="mono nowrap">{u.code}</td>
                    <td className="nowrap">{deptOf(u.dept).name}</td>
                    <td><RoleBadge r={u.role} /></td>
                    <td className="nowrap">{u.managerId ? dir.name(u.managerId) : '—'}</td>
                    <td><UserStatusBadge s={u.status} /></td>
                    <td className="nowrap muted">{whenOf(u.lastLoginAt)}</td>
                    <td className="right nowrap">
                      <button className="btn ghost sm" onClick={() => openProfile(u)}>View</button>
                      <PermissionGuard action="user.edit">
                        <button className="btn ghost sm" onClick={() => openForm(u)}>Edit</button>
                      </PermissionGuard>
                      <Menu label={`More actions for ${u.name}`}
                        icon={<Icon n="more" size="lg" />} width={226}>
                        {(close) => (
                          <>
                            {u.status === 'Pending Approval' && can('user.approve') && (
                              <>
                                <button className="menu-row" onClick={() => {
                                  close();
                                  act(() => decide.mutate(u.id, 'Approved'), 'Request approved');
                                }}>
                                  <span className="gs-ic"><Icon n="done" /></span> Approve
                                </button>
                                <button className="menu-row" onClick={() => {
                                  close();
                                  act(() => decide.mutate(u.id, 'Rejected', 'Not approved'),
                                    'Request rejected');
                                }}>
                                  <span className="gs-ic"><Icon n="close" /></span> Reject
                                </button>
                                <div className="menu-sep" />
                              </>
                            )}

                            {u.status === 'Invitation Pending' && can('user.resend_invite') && (
                              <button className="menu-row" onClick={() => {
                                close();
                                act(() => resend.mutate(u.id), 'Invitation resent');
                              }}>
                                <span className="gs-ic"><Icon n="mail" /></span> Resend invitation
                              </button>
                            )}

                            {/*
                              * Requiring is an administrator's to set and only
                              * the person's to satisfy — nothing here enrols on
                              * their behalf, because that would mean handling
                              * their secret.
                              */}
                            {can('user.suspend') && u.status !== 'Deleted' && (
                              <button className="menu-row" onClick={() => {
                                close();
                                act(() => mfaReq.mutate(u.id, !u.mfaRequired),
                                  u.mfaRequired
                                    ? 'Two-factor sign-in no longer required'
                                    : 'They must set up two-factor sign-in before next use');
                              }}>
                                <span className="gs-ic"><Icon n="lock" /></span>
                                {u.mfaRequired ? 'Stop requiring two-factor' : 'Require two-factor sign-in'}
                              </button>
                            )}

                            {can('user.reset_password') && (
                              <button className="menu-row" onClick={() => {
                                close();
                                act(() => reset.mutate(u.id, true),
                                  'Reset link sent — they must change it at next sign-in');
                              }}>
                                <span className="gs-ic"><Icon n="lock" /></span> Reset password
                              </button>
                            )}

                            {u.status !== 'Active' && u.status !== 'Deleted' && can('user.activate') && (
                              <button className="menu-row" onClick={() => {
                                close();
                                act(() => setStatus.mutate(u.id, 'Active'), 'User activated');
                              }}>
                                <span className="gs-ic"><Icon n="done" /></span> Activate
                              </button>
                            )}

                            {u.status === 'Active' && can('user.deactivate') && (
                              <button className="menu-row" onClick={() => { close(); confirmDeactivate(u); }}>
                                <span className="gs-ic"><Icon n="blocked" /></span> Deactivate
                              </button>
                            )}

                            {u.status === 'Active' && can('user.suspend') && (
                              <button className="menu-row" onClick={() => {
                                close();
                                act(() => setStatus.mutate(u.id, 'Suspended', 'Suspended by an administrator'),
                                  'User suspended');
                              }}>
                                <span className="gs-ic"><Icon n="warn" /></span> Suspend
                              </button>
                            )}

                            {can('user.delete') && u.status !== 'Deleted' && (
                              <>
                                <div className="menu-sep" />
                                <button className="menu-row" onClick={() => { close(); confirmDelete(u); }}>
                                  <span className="gs-ic"><Icon n="remove" /></span> Delete
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </Menu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={<Icon n="people" size="xl" />}
            msg={loading ? 'Loading accounts…' : 'No accounts match this filter'}
          />
        )}
      </Card>

      {tab === 'pending' && rows.length > 0 && (
        <Card title="Approval workflow" sub="What happens to these">
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            Each of these was raised by a manager and is waiting on an administrator.
            Approving sends the invitation and the account becomes active once it is
            accepted; rejecting retires the account with the reason recorded against it.
            Nobody can decide a request they raised themselves.
          </p>
        </Card>
      )}

      {tab === 'locked' && (
        <Card title="About locking" sub="Who sets it, and who can lift it">
          <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            A lock is applied by an administrator and only an administrator can lift
            it — a manager who could not lock an account cannot decide the reason for
            it has passed. It is not applied automatically after failed sign-ins:
            counting those would mean trusting the sign-in page to report its own
            failures, which would let anybody lock an account whose email address
            they can guess.
          </p>
        </Card>
      )}
        </>
      )}
    </div>
  );
}

registerModule({
  key: 'users',
  title: TITLES.users,
  Component: UsersView,
});

/** Exported for the checks, which mount it directly. */
export { UsersView };
export type { AppRole };
export { USER_STATUSES };
