import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sortBy } from '../../lib/collections';
import { addDays, fmtD, TODAY } from '../../lib/dates';


import { deptOf } from '../../data/org';
import type { Employee } from '../../types/employee';
import type { AppRole } from '../../types/employee';
import type { PermScope } from '../../services';
import { Badge, Banner, Card, KV, PersonCell, Table, TableWrap, Tile, StatRow } from '../../components/ui';
import { Divide } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { ACCOUNTS, PERMS, SCOPE } from '../../state/rbac';
import {
  useAllEmployees, useSetRole,
  usePermissionGrid, useSetPermissions, useResetPermissions,
} from './data';
import { Icon } from '../../components/icons';

export const ROLES: AppRole[] = ['admin', 'manager', 'employee'];

export const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'HR Administrator',
  manager: 'Reporting Manager',
  employee: 'Employee',
};

const ROLE_COLOR: Record<AppRole, string> = { admin: 'var(--s8)', manager: 'var(--s1)', employee: 'var(--s3)' };
const ROLE_SCOPE: Record<AppRole, string> = { admin: 'All records', manager: 'Reporting tree', employee: 'Own record' };

/** Every route the permission matrix accounts for, in reading order. */
export const MODULES: { k: string; n: string }[] = [
  { k: 'dashboard', n: 'Dashboard' }, { k: 'attendance', n: 'Attendance & Geo' }, { k: 'shifts', n: 'Shifts & Roster' },
  { k: 'timesheet', n: 'Timesheet' }, { k: 'leave', n: 'Leave' }, { k: 'expenses', n: 'Expenses' },
  { k: 'approvals', n: 'Approvals' }, { k: 'employees', n: 'Employee Directory' }, { k: 'org', n: 'Org Chart' },
  { k: 'celebrations', n: 'Celebrations' }, { k: 'announcements', n: 'Announcements' }, { k: 'engagement', n: 'Engagement' },
  { k: 'helpdesk', n: 'Helpdesk' }, { k: 'payroll', n: 'Payroll & Payslips' }, { k: 'tax', n: 'Tax Declaration' },
  { k: 'benefits', n: 'Benefits & Flexi' }, { k: 'performance', n: 'Performance' }, { k: 'learning', n: 'Learning' },
  { k: 'hiring', n: 'Hiring (ATS)' }, { k: 'onboarding', n: 'Onboarding' }, { k: 'exit', n: 'Exit & F&F' },
  { k: 'reports', n: 'Reports' }, { k: 'documents', n: 'Documents & Letters' }, { k: 'settings', n: 'Settings & RBAC' },
];

/** What each role can actually do inside a module it can reach. */

const APPROVAL_CHAINS: [string, string, string, string][] = [
  ['Leave (≤ 3 days)', 'Reporting manager', '—', '24 hours'],
  ['Leave (> 3 days)', 'Reporting manager', 'Department head', '48 hours'],
  ['Maternity / Paternity leave', 'Reporting manager', 'HR', '3 days'],
  ['Attendance regularisation', 'Reporting manager', '—', '24 hours'],
  ['Timesheet', 'Reporting manager', '—', 'Weekly (Monday)'],
  ['Requisition', 'Department head', 'Finance + CEO', '5 days'],
  ['Offer (within band)', 'Hiring manager', 'HR', '2 days'],
  ['Offer (above band)', 'Hiring manager', 'CEO', '3 days'],
  ['Payroll run', 'Finance manager', 'Head of Finance', 'Monthly (25th)'],
];

/** Field-level visibility. Each row is [field, admin, manager, self]. */
const FIELD_VISIBILITY: [string, string, string, string][] = [
  ['Salary & CTC', '✓', '✗', '✓'],
  ['Bank account', '✓', '✗', '✓'],
  ['PAN / Aadhaar', '✓', '✗', '✓'],
  ['Date of birth', '✓', '✓ (team)', '✓'],
  ['Home address', '✓', '✓ (team)', '✓'],
  ['Performance rating', '✓', '✓ (team)', '✓'],
  ['Contact & designation', '✓', '✓', '✓'],
  ['Tax declaration', '✓', '✗', '✓'],
  ['Documents', '✓', '✗', '✓'],
];

const adminCount = (people: Employee[]) => people.filter((e) => e.role === 'admin').length;
const managerCount = (people: Employee[]) => people.filter((e) => e.reports.length).length;

/** How many accounts sit in each role today. */
const usersInRole = (r: AppRole, people: Employee[]) =>
  r === 'admin' ? adminCount(people)
    : r === 'manager' ? managerCount(people)
      : people.filter((e) => !e.reports.length).length;

export function RbacTab() {
  const app = useApp();
  const nav = useNavigate();
  const { data: people = [] } = useAllEmployees();

  const preview = (r: AppRole) => {
    const acc = ACCOUNTS().find((a) => a.role === r);
    if (!acc) return;
    app.signInAs(r);
    nav('/dashboard');
    app.toast(`Previewing as ${acc.label} — ${people.find((e) => e.id === acc.empId)?.name ?? ''}`);
  };

  return (
    <div className="stack">
      <div className="grid g3">
        {ROLES.map((r) => (
          <Card key={r}>
            <div className="row" style={{ gap: 9, marginBottom: 9 }}>
              <div className="av" style={{ background: ROLE_COLOR[r] }}>{ROLE_LABEL[r][0]}</div>
              <div>
                <div style={{ fontWeight: 750, fontSize: 14 }}>{ROLE_LABEL[r]}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{SCOPE[r].label}</div>
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', minHeight: 52 }}>{SCOPE[r].desc}</div>
            <Divide />
            <div style={{ fontSize: 12 }}>
              <KV
                rows={[
                  ['Modules', `${PERMS[r].length} of ${MODULES.length}`],
                  ['Users', usersInRole(r, people)],
                  ['Data scope', ROLE_SCOPE[r]],
                ]}
              />
            </div>
            <button className="btn sm" style={{ marginTop: 11, width: '100%' }} onClick={() => preview(r)}>
              Preview as this role
            </button>
          </Card>
        ))}
      </div>

      <PermissionMatrix />

      <div className="grid g2">
        <Card title="Approval chains" sub="Who signs off on what" flush>
          <TableWrap>
            <Table>
              <thead>
                <tr><th>Request type</th><th>Level 1</th><th>Level 2</th><th>SLA</th></tr>
              </thead>
              <tbody>
                {APPROVAL_CHAINS.map((r) => (
                  <tr key={r[0]}>
                    <td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>

        <Card title="Data protection" sub="Field-level visibility" flush>
          <TableWrap>
            <Table>
              <thead>
                <tr><th>Field</th><th>Admin</th><th>Manager</th><th>Self</th></tr>
              </thead>
              <tbody>
                {FIELD_VISIBILITY.map((r) => (
                  <tr key={r[0]}>
                    <td>{r[0]}</td>
                    {r.slice(1).map((c, i) => (
                      <td key={i}>{c === '✓' ? <Badge kind="good">✓</Badge> : c === '✗' ? <Badge kind="crit">✗</Badge> : <Badge kind="good">{c}</Badge>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>
    </div>
  );
}

/* ---------- User roles ---------- */

/** The role a user actually operates under, whatever the flag on the record says. */
const effectiveRole = (e: Employee): AppRole => (e.role === 'admin' ? 'admin' : e.reports.length ? 'manager' : 'employee');
const EFF_KIND: Record<AppRole, 'crit' | 'info' | 'mute'> = { admin: 'crit', manager: 'info', employee: 'mute' };
const EFF_LABEL: Record<AppRole, string> = { admin: 'HR Administrator', manager: 'Manager', employee: 'Employee' };

function ChangeRoleBody({ e, onPick }: { e: Employee; onPick: (r: AppRole) => void }) {
  return (
    <>
      <div className="field">
        <label>Access role</label>
        <select className="input" defaultValue={e.role} onChange={(ev) => onPick(ev.target.value as AppRole)}>
          <option value="admin">HR Administrator — full access</option>
          <option value="manager">Manager — team scope</option>
          <option value="employee">Employee — self-service</option>
        </select>
      </div>
      <Banner kind="warn" icon={<Icon n="warn" size="lg" />}>
        Changing a role takes effect immediately and is recorded in the audit log.
      </Banner>
    </>
  );
}

export function UsersTab() {
  const app = useApp();
  const layer = useLayer();
  const [q, setQ] = useState('');
  const { data: people = [] } = useAllEmployees();
  const setRole = useSetRole();

  const needle = q.toLowerCase();
  const list = needle
    ? people.filter((e) => (e.name + e.email + e.code).toLowerCase().includes(needle))
    : people;

  /* Illustrative last-active dates, stable for the life of the row. */
  const lastActive = (e: Employee) => fmtD(addDays(TODAY, -(e.id.charCodeAt(e.id.length - 1) % 7)));

  const changeRole = (e: Employee) => {
    let picked: AppRole = e.role;
    layer.modal({
      title: 'Change access role',
      sub: e.name + ' · ' + e.designation,
      size: 'narrow',
      body: <ChangeRoleBody e={e} onPick={(r) => { picked = r; }} />,
      footer: (close) => (
        <>
          <button className="btn" onClick={close}>Cancel</button>
          <button
            className="btn primary"
            onClick={async () => {
              await setRole.mutate(e.id, picked);
              close();
              app.toast('Role updated for ' + e.name, 'ok');
            }}
          >
            Apply
          </button>
        </>
      ),
    });
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <input className="input" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>{list.length} user accounts</span>
      </div>

      <StatRow cols={4}>
        <Tile label="HR Administrators" value={adminCount(people)} foot="Full system access" />
        <Tile label="Managers" value={managerCount(people)} foot="With at least one direct report" />
        <Tile
          label="Employees"
          value={people.filter((e) => !e.reports.length && e.role !== 'admin').length}
          foot="Self-service only"
        />
        <Tile label="Total accounts" value={people.length} foot="Single sign-on enabled" />
      </StatRow>

      <Card title="User accounts" sub={`${list.length} active`} flush>
        <div style={{ maxHeight: 600, overflow: 'auto' }}>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>User</th><th>Email</th><th>Department</th><th>Direct reports</th>
                  <th>Effective role</th><th>Last active</th><th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {sortBy(list, (e) => e.name).map((e) => {
                  const eff = effectiveRole(e);
                  return (
                    <tr key={e.id}>
                      <td><PersonCell e={e} sub={e.code} /></td>
                      <td className="muted">{e.email}</td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="num">{e.reports.length || '—'}</td>
                      <td><Badge kind={EFF_KIND[eff]}>{EFF_LABEL[eff]}</Badge></td>
                      <td className="muted nowrap">{lastActive(e)}</td>
                      <td className="right">
                        <button className="btn sm" onClick={() => changeRole(e)}>Change role</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      </Card>
    </div>
  );
}


/* ---------------- the permission matrix ---------------- */

/**
 * Which modules each role may open, per tenant.
 *
 * **Read only, and that is deliberate.** `role_permission` carries read, write
 * and approve scopes, and this screen edits the first. Narrowing write or
 * approve would change nothing today: the services decide those for
 * themselves — "only an administrator can suspend an account" is a line in
 * users/service.ts, not a lookup — so a control for them would be a switch
 * wired to nothing. Read is different: the API dispatcher refuses any route
 * whose module a role cannot read, so switching it off here actually closes
 * the door.
 *
 * **The code is a ceiling and this can only lower it.** An option above what
 * `policy.ts` grants is not offered, because the server clamps it and the
 * setting would appear to save while changing nothing.
 */
function PermissionMatrix() {
  const app = useApp();
  const { data: grid = [], loading, error, refetch } = usePermissionGrid();
  const setPerms = useSetPermissions();
  const reset = useResetPermissions();
  const [busy, setBusy] = useState<string | null>(null);

  const change = async (module: string, role: AppRole, read: PermScope) => {
    setBusy(`${module}|${role}`);
    try {
      await setPerms.mutate([{ module, role, read }]);
      refetch();
      app.toast(read === 'none'
        ? `${ROLE_LABEL[role]}s can no longer open ${module}`
        : `${ROLE_LABEL[role]}s can open ${module}`);
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not save that', 'err');
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <Card title="Permission matrix">
        <div className="hint">{error.message}</div>
      </Card>
    );
  }

  return (
    <Card
      title="Permission matrix"
      sub="Which modules each role may open here. The product's own limits still apply on top."
      flush
    >
      <div style={{ padding: 12 }}>
        <div className="hint" style={{ marginBottom: 10 }}>
          Lowering a setting takes access away for this company only; it can never
          grant more than the role already has. What a person may <em>do</em> inside
          a module they can open is decided by the module itself and is not set here.
        </div>
        {loading ? (
          <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <th>Module</th>
                  {ROLES.map((r) => <th key={r}>{ROLE_LABEL[r]}</th>)}
                  <th className="right">Reset</th>
                </tr>
              </thead>
              <tbody>
                {grid.map((row) => (
                  <tr key={row.module}>
                    <td><b>{row.module}</b></td>
                    {ROLES.map((r) => {
                      const ceiling = row.ceiling[r].read;
                      const current = row.effective[r].read;
                      /* Only the scopes at or below what the code grants. */
                      const options = SCOPE_ORDER.slice(0, SCOPE_ORDER.indexOf(ceiling) + 1);
                      return (
                        <td key={r}>
                          {ceiling === 'none' ? (
                            <Badge kind="mute">No access</Badge>
                          ) : (
                            <select
                              className="input sm"
                              value={current}
                              aria-label={`${row.module} for ${ROLE_LABEL[r]}`}
                              disabled={busy === `${row.module}|${r}`}
                              onChange={(e) =>
                                void change(row.module, r, e.target.value as PermScope)}
                            >
                              {options.map((o) => (
                                <option key={o} value={o}>{SCOPE_LABEL[o]}</option>
                              ))}
                            </select>
                          )}
                        </td>
                      );
                    })}
                    <td className="right">
                      <button
                        type="button"
                        className="linkish"
                        style={{ fontSize: 12 }}
                        onClick={() => {
                          void (async () => {
                            try {
                              await reset.mutate(row.module);
                              refetch();
                              app.toast(`${row.module} restored to its defaults`);
                            } catch (e) {
                              app.toast(e instanceof Error ? e.message : 'Could not reset', 'err');
                            }
                          })();
                        }}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </div>
    </Card>
  );
}

const SCOPE_ORDER: PermScope[] = ['none', 'own', 'team', 'all'];
const SCOPE_LABEL: Record<PermScope, string> = {
  none: 'No access',
  own: 'Their own',
  team: 'Their team',
  all: 'Everyone',
};
