import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { TODAY, tenure, ymd } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';
import {
  useAllEmployees, useApproveJoiner, useExitedEmployees, useJoiners, usePeople,
  useRejectJoiner, useVisiblePeople,
} from './data';
import { AddJoinerForm, JoinerQueue } from './AddJoiner';
import { useLayer } from '../../components/Layer';
import { DEPTS, deptOf, GRADES, siteOf, SITES } from '../../data/org';
import { Avatar, Badge, Card, EmptyState, pageOf, Pager, Tile, StatRow } from '../../components/ui';
import { Chip, StatusBadge } from '../../components/common';
import { useShowEmployee } from './Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';
import { useApp } from '../../state/AppContext';
import type { Grade } from '../../types/country';
import { Icon } from '../../components/icons';

function Employees() {
  const app = useApp();
  const show = useShowEmployee();
  const layer = useLayer();

  /* Adding people is a manager-and-above action; employees never see it. */
  const canAddPeople = app.role === 'admin' || app.role === 'manager';
  const { data: joiners = [], refetch: refetchJoiners } = useJoiners('pending');
  const approveJoiner = useApproveJoiner();
  const rejectJoiner = useRejectJoiner();

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    try {
      if (decision === 'approve') await approveJoiner.mutate(id);
      else await rejectJoiner.mutate(id);
      app.toast(decision === 'approve' ? 'Joiner approved — employee created' : 'Joiner rejected', 'ok');
      refetchJoiners();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not record that decision', 'err');
    }
  };

  const addJoiner = () =>
    layer.modal({
      title: 'Add a new joiner',
      sub: app.role === 'admin' ? 'Creates the employee record' : 'Sent to an admin for approval',
      size: 'wide',
      body: (close) => <AddJoinerForm close={close} onDone={refetchJoiners} />,
      footer: null,
    });

  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [site, setSite] = useState('');
  const [grade, setGrade] = useState('');
  const [status, setStatus] = useState<'Active' | 'Exited'>('Active');
  const [view, setView] = useState<'grid' | 'list'>('list');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);

  /* the directory itself is open to everyone; sensitive fields are gated in the profile */
  const dir = useVisiblePeople();
  const { data: everyone = [] } = useAllEmployees();
  const { data: leavers = [] } = useExitedEmployees();
  const all = app.role === 'employee' ? everyone : dir.list;
  const managers = usePeople(all.map((e) => e.managerId));

  let list = status === 'Exited' ? leavers : all;
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

  /*
   * Paged rather than truncated. A directory of a hundred people that shows
   * the first twenty-five and stops is a directory that cannot find the
   * twenty-sixth.
   */
  const paged = pageOf(list, page, size);

  const exportCsv = () =>
    downloadCSV(
      'employee-directory.csv',
      [['Code', 'Name', 'Department', 'Designation', 'Grade', 'Location', 'Manager', 'Joined', 'Status']].concat(
        list.map((e) => [
          e.code, e.name, deptOf(e.dept).name, e.designation, e.grade,
          siteOf(e.site).name, managers.name(e.managerId), e.doj, e.status,
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
        <button className="btn" onClick={exportCsv}><Icon n="download" size="lg" /> Export</button>
        {canAddPeople && (
          <button className="btn primary" onClick={addJoiner}><Icon n="add" size="lg" /> Add employee</button>
        )}
      </div>

      {canAddPeople && <JoinerQueue rows={joiners} onDecide={decide} />}

      <StatRow cols={4}>
        <Tile icon={<Icon n="people" size="lg" />} label="Total employees" value={list.length}
          foot="Matching current filters" />
        <Tile icon={<Icon n="building" size="lg" />} label="Departments"
          value={new Set(list.map((e) => e.dept)).size} foot="Represented in this list" />
        <Tile icon={<Icon n="location" size="lg" />} label="Locations"
          value={new Set(list.map((e) => e.site)).size} foot="Offices and remote" />
        <Tile icon={<Icon n="party" size="lg" />} label="New joiners"
          value={list.filter((e) => e.doj.slice(0, 4) === ymd(TODAY).slice(0, 4)).length}
          foot={`Joined in ${ymd(TODAY).slice(0, 4)}`} />
      </StatRow>

      {view === 'grid' ? (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(232px,1fr))' }}>
          {paged.rows.map((e) => (
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
                  <th className="num">#</th><th>Photo</th><th>Name</th><th>Designation</th>
                  <th>Department</th><th>Location</th><th>Email</th><th>Status</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((e, i) => (
                  <tr key={e.id} className="clickable" onClick={() => show(e.id)}>
                    {/* Numbered from the whole list, not the page — row 27 is
                        row 27 wherever it is being read. */}
                    <td className="num muted">{paged.first + i}</td>
                    <td><Avatar name={e.name} size="sm" /></td>
                    <td>
                      <b>{e.name}</b>
                      <div className="muted" style={{ fontSize: 11 }}>{e.code}</div>
                    </td>
                    <td className="nowrap">{e.designation}</td>
                    <td className="nowrap">{deptOf(e.dept).name}</td>
                    <td className="nowrap">{siteOf(e.site).city === '—' ? 'Remote' : siteOf(e.site).city}</td>
                    <td className="nowrap">{e.email}</td>
                    <td>
                      <StatusBadge status={e.status} />
                      {e.probation && <> <Badge kind="warn">Probation</Badge></>}
                    </td>
                    <td className="right">
                      <button className="btn ghost icon sm" title={`Open ${e.name}`}
                        onClick={(ev) => { ev.stopPropagation(); show(e.id); }}>⋯</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager {...paged} noun="employees" onPage={setPage} size={size} onSize={setSize} />
        </Card>
      )}

      {!list.length && <Card><EmptyState msg="No employees match these filters" /></Card>}
    </div>
  );
}

registerModule({
  key: 'employees',
  title: TITLES.employees,
  Component: Employees,
});

export { useShowEmployee };
