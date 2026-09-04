import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { sortBy } from '../../lib/collections';
import { addDays, fmtD, TODAY } from '../../lib/dates';

import { ACTIVE, EMAP, EMP } from '../../data/employees';
import { deptOf } from '../../data/org';
import type { Employee } from '../../types/employee';
import type { AppRole } from '../../types/employee';
import { Badge, Banner, Card, KV, PersonCell, Table, TableWrap, Tile } from '../../components/ui';
import { Divide } from '../../components/common';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { ACCOUNTS, PERMS, SCOPE } from '../../state/rbac';

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
const CAPS: Record<AppRole, Record<string, string>> = {
  admin: {
    dashboard: 'Org-wide', attendance: 'All employees · configure fences', timesheet: 'All · approve any',
    leave: 'All · approve & override balances', approvals: 'All queues', employees: 'Full record incl. salary · create & edit',
    org: 'Full tree', celebrations: 'All', announcements: 'Post company-wide',
    payroll: 'Run payroll · all payslips · registers', tax: 'All declarations · verify proofs',
    hiring: 'All requisitions & candidates', onboarding: 'All journeys', reports: 'All 8 reports', settings: 'Full configuration',
    shifts: 'Publish rosters · approve overtime', expenses: 'All claims · policy overrides · reimburse',
    engagement: 'Launch surveys · full results', helpdesk: 'All tickets · SLA config',
    benefits: 'Configure policies · all FBP · approve loans', performance: 'All goals & reviews · calibration',
    learning: 'Assign courses · compliance tracker', exit: 'Full exit workflow · F&F settlement',
    documents: 'Generate any letter · document repository',
  },
  manager: {
    dashboard: 'Team view', attendance: 'Own + reporting tree', timesheet: 'Own + approve team',
    leave: 'Own + approve team', approvals: 'Team queues only', employees: 'Directory + team profiles (no salary)',
    org: 'Full tree (read)', celebrations: 'All', announcements: 'Post to team',
    payroll: 'Own payslips + team cost in aggregate', tax: 'Own declaration only',
    hiring: 'Requisitions where hiring manager', onboarding: 'Own new joiners', reports: '5 team-scoped reports', settings: '—',
    shifts: 'Team roster · approve overtime', expenses: 'Own claims · approve team claims',
    engagement: 'Team results (min 5 responses)', helpdesk: 'Own tickets · assigned queue',
    benefits: 'Own benefits & FBP', performance: 'Team goals · write reviews · 9-box',
    learning: 'Team progress · nudge', exit: 'Team exits · clearance sign-off',
    documents: 'Own letters · team letters',
  },
  employee: {
    dashboard: 'Self-service', attendance: 'Own record · punch & regularise', timesheet: 'Own · submit',
    leave: 'Own · apply', approvals: '—', employees: 'Directory (contact details only)',
    org: 'Full tree (read)', celebrations: 'All', announcements: 'Read & acknowledge',
    payroll: 'Own payslips & salary structure', tax: 'Own declaration',
    hiring: '—', onboarding: '—', reports: '—', settings: '—',
    shifts: 'Own roster · log overtime', expenses: 'Own claims and advances',
    engagement: 'Take surveys · see company results', helpdesk: 'Own tickets · knowledge base',
    benefits: 'Own benefits, FBP and loans', performance: 'Own goals, self appraisal, praise wall',
    learning: 'Enrol and complete courses', exit: 'Own resignation and F&F view',
    documents: 'Own letters and documents',
  },
};

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

const adminCount = () => EMP.filter((e) => e.role === 'admin' && e.status === 'Active').length;
const managerCount = () => ACTIVE().filter((e) => e.reports.length).length;

const usersInRole = (r: AppRole) =>
  r === 'admin' ? adminCount() : r === 'manager' ? managerCount() : ACTIVE().filter((e) => !e.reports.length).length;

export function RbacTab() {
  const app = useApp();
  const nav = useNavigate();

  const preview = (r: AppRole) => {
    const acc = ACCOUNTS().find((a) => a.role === r);
    if (!acc) return;
    app.signInAs(r);
    nav('/dashboard');
    app.toast(`Previewing as ${acc.label} — ${EMAP[acc.empId].name}`);
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
                  ['Users', usersInRole(r)],
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

      <Card title="Permission matrix" sub="What each role can reach and do" flush>
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <th>Module</th>
                {ROLES.map((r) => <th key={r}>{ROLE_LABEL[r]}</th>)}
              </tr>
            </thead>
            <tbody>
              {MODULES.map((m) => (
                <tr key={m.k}>
                  <td><b>{m.n}</b></td>
                  {ROLES.map((r) => (
                    <td key={r}>
                      {PERMS[r].includes(m.k) ? (
                        <>
                          <Badge kind="good">✓</Badge> <span style={{ fontSize: 12 }}>{CAPS[r][m.k]}</span>
                        </>
                      ) : (
                        <Badge kind="mute">No access</Badge>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

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
      <Banner kind="warn" icon="⚠️">
        Changing a role takes effect immediately and is recorded in the audit log.
      </Banner>
    </>
  );
}

export function UsersTab() {
  const app = useApp();
  const layer = useLayer();
  const [q, setQ] = useState('');

  const needle = q.toLowerCase();
  const list = needle
    ? ACTIVE().filter((e) => (e.name + e.email + e.code).toLowerCase().includes(needle))
    : ACTIVE();

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
            onClick={() => {
              e.role = picked;
              close();
              app.toast('Role updated for ' + e.name, 'ok');
              app.bump();
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

      <div className="grid g4">
        <Tile label="HR Administrators" value={adminCount()} foot="Full system access" />
        <Tile label="Managers" value={managerCount()} foot="With at least one direct report" />
        <Tile
          label="Employees"
          value={ACTIVE().filter((e) => !e.reports.length && e.role !== 'admin').length}
          foot="Self-service only"
        />
        <Tile label="Total accounts" value={ACTIVE().length} foot="Single sign-on enabled" />
      </div>

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

