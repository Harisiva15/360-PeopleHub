import { useState } from 'react';
import { sortBy, sum } from '../../lib/collections';
import { daysBetween, fmtD, TODAY, tenure, ymd } from '../../lib/dates';
import { pct } from '../../lib/format';
import { downloadCSV } from '../../lib/csv';
import { ACTIVE, EMP, empName } from '../../data/employees';
import { DEPTS, deptOf, GRADES, siteOf, SITES } from '../../data/org';
import { Avatar, Badge, Card, EmptyState, PersonCell, Tile } from '../../components/ui';
import { Chip, StatusBadge } from '../../components/common';
import { useShowEmployee } from './Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useApp } from '../../state/AppContext';
import { SCOPE, visibleEmps } from '../../state/rbac';
import type { Grade } from '../../types/country';

function Employees() {
  const app = useApp();
  const show = useShowEmployee();

  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [site, setSite] = useState('');
  const [grade, setGrade] = useState('');
  const [status, setStatus] = useState<'Active' | 'Exited'>('Active');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  /* the directory itself is open to everyone; sensitive fields are gated in the profile */
  const all = app.role === 'employee' ? ACTIVE() : visibleEmps(app.role, app.meId);

  let list = status === 'Exited' ? EMP.filter((e) => e.status === 'Exited') : all;
  if (dept) list = list.filter((e) => e.dept === dept);
  if (site) list = list.filter((e) => e.site === site);
  if (grade) list = list.filter((e) => e.grade === grade);
  if (q) {
    const needle = q.toLowerCase();
    list = list.filter((e) =>
      (e.name + ' ' + e.code + ' ' + e.designation + ' ' + e.email + ' ' + e.skills.join(' ')).toLowerCase().includes(needle),
    );
  }
  list = sortBy(list, (e) => e.name);

  const exportCsv = () =>
    downloadCSV(
      'employee-directory.csv',
      [['Code', 'Name', 'Department', 'Designation', 'Grade', 'Location', 'Manager', 'Joined', 'Status']].concat(
        list.map((e) => [
          e.code, e.name, deptOf(e.dept).name, e.designation, e.grade,
          siteOf(e.site).name, e.managerId ? empName(e.managerId) : '', e.doj, e.status,
        ]),
      ),
    );

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="search">
          <input className="input" placeholder="Search name, code, skill…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All locations</option>
          {SITES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={grade} onChange={(e) => setGrade(e.target.value)}>
          <option value="">All grades</option>
          {(Object.keys(GRADES) as Grade[]).map((g) => <option key={g} value={g}>{GRADES[g].label}</option>)}
        </select>
        {app.role === 'admin' && (
          <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value as 'Active' | 'Exited')}>
            <option value="Active">Active</option>
            <option value="Exited">Exited</option>
          </select>
        )}
        <div className="spacer" />
        <div className="seg">
          <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="Grid">▦</button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="List">☰</button>
        </div>
        <button className="btn" onClick={exportCsv}>⤓ Export</button>
      </div>

      <div className="grid g5">
        <Tile label="Employees" value={list.length} foot="Matching current filters" />
        <Tile label="Average tenure"
          value={(sum(list, (e) => daysBetween(e.doj, ymd(TODAY))) / Math.max(1, list.length) / 365).toFixed(1) + ' yrs'}
          foot="Across filtered set" />
        <Tile label="Gender split" value={pct(list.filter((e) => e.gender === 'F').length, Math.max(1, list.length)) + '% F'}
          foot={`${list.filter((e) => e.gender === 'F').length} women · ${list.filter((e) => e.gender === 'M').length} men`} />
        <Tile label="On probation" value={list.filter((e) => e.probation).length} foot="Joined in the last 6 months" />
        <Tile label="Contractors" value={list.filter((e) => e.empType === 'Contract').length} foot="Non-payroll engagements" />
      </div>

      {view === 'grid' ? (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(232px,1fr))' }}>
          {list.map((e) => (
            <div key={e.id} className="card clickable" onClick={() => show(e.id)}>
              <div className="card-b" style={{ textAlign: 'center' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 9 }}>
                  <Avatar name={e.name} size="lg" />
                </div>
                <div style={{ fontWeight: 700, fontSize: 13.5, letterSpacing: '-.2px' }}>{e.name}</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{e.designation}</div>
                <div className="row" style={{ justifyContent: 'center', gap: 5, marginTop: 9, flexWrap: 'wrap' }}>
                  <Chip>{deptOf(e.dept).name}</Chip>
                  <Chip>{siteOf(e.site).city === '—' ? 'Remote' : siteOf(e.site).city}</Chip>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>{e.code} · {tenure(e.doj)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Employee</th><th>Code</th><th>Department</th><th>Designation</th><th>Grade</th>
                  <th>Location</th><th>Manager</th><th>Joined</th><th>Tenure</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id} className="clickable" onClick={() => show(e.id)}>
                    <td><PersonCell e={e} sub={e.email} /></td>
                    <td className="mono">{e.code}</td>
                    <td className="nowrap">{deptOf(e.dept).name}</td>
                    <td className="nowrap">{e.designation}</td>
                    <td><Badge>{e.grade}</Badge></td>
                    <td className="nowrap">{siteOf(e.site).name}</td>
                    <td className="nowrap">{e.managerId ? empName(e.managerId) : '—'}</td>
                    <td className="nowrap">{fmtD(e.doj)}</td>
                    <td>{tenure(e.doj)}</td>
                    <td><StatusBadge status={e.status} />{e.probation && <> <Badge kind="warn">Probation</Badge></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!list.length && <Card><EmptyState msg="No employees match these filters" /></Card>}
    </div>
  );
}

registerModule({
  key: 'employees',
  title: TITLES.employees,
  subtitle: (c) => visibleEmps(c.role, c.meId).length + ' employees in scope · ' + SCOPE[c.role].label,
  Component: Employees,
});

export { useShowEmployee };
