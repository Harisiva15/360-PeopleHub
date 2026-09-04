/**
 * The three smaller People-group modules: Org Chart, Celebrations and
 * Announcements. Grouped because each is a single view over shared data.
 */
import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import { DOW, fmtD, MON, nextOccur, parseYmd, TODAY, yearsSince, ymd } from '../../lib/dates';
import { downloadCSV } from '../../lib/csv';

import type { Announcement } from '../../data/announcements';
import { useAllEmployees, useAnnouncements, useCelebrations, useTeam } from './data';
import type { Directory } from './data';
import type { Employee } from '../../types/employee';
import { DEPTS, deptOf, HOLIDAYS, ORG, siteOf } from '../../data/org';
import { Avatar, Badge, Card, EmptyState, PersonCell } from '../../components/ui';
import { Chip, Dot, ListRow } from '../../components/common';
import { HBar } from '../../components/charts';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { CelebRows } from '../dashboard/shared';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

/* ============================================================
   Org chart
   ============================================================ */

function OrgNode({ e, depth, dir, onOpen, onExpand }: {
  e: Employee;
  depth: number;
  dir: Directory;
  onOpen: (id: string) => void;
  onExpand: (id: string) => void;
}) {
  const kids = (e.reports || []).map((r) => dir.byId(r)).filter(Boolean) as Employee[];
  return (
    <div style={{
      marginLeft: depth ? 22 : 0,
      ...(depth ? { borderLeft: '1px solid var(--line)', paddingLeft: 14 } : {}),
    }}>
      <div className="card clickable" onClick={() => onOpen(e.id)} style={{ marginBottom: 8, display: 'inline-flex', minWidth: 290 }}>
        <div className="card-b" style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <Avatar name={e.name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{e.name}</div>
            <div className="muted" style={{ fontSize: 11.5 }}>{e.designation}</div>
          </div>
          <div className="right">
            <Chip>{siteOf(e.site).city === '—' ? 'Remote' : siteOf(e.site).city}</Chip>
            {kids.length > 0 && (
              <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                {kids.length} report{kids.length > 1 ? 's' : ''}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* three levels are drawn inline; deeper branches re-root the tree */}
      {kids.length > 0 && depth < 3 ? (
        <div>
          {sortBy(kids, (k) => k.name).map((k) => (
            <OrgNode key={k.id} e={k} depth={depth + 1} dir={dir} onOpen={onOpen} onExpand={onExpand} />
          ))}
        </div>
      ) : kids.length > 0 ? (
        <div style={{ marginLeft: 22, paddingLeft: 14, borderLeft: '1px solid var(--line)' }}>
          <button className="btn sm" onClick={() => onExpand(e.id)}>Expand {kids.length} more ›</button>
        </div>
      ) : null}
    </div>
  );
}

function OrgChart() {
  const show = useShowEmployee();
  const { data: everyone = [] } = useAllEmployees();
  const dir = {
    list: everyone,
    ids: everyone.map((e) => e.id),
    byId: (id) => everyone.find((e) => e.id === id),
    name: (id) => everyone.find((e) => e.id === id)?.name ?? '—',
    loading: false,
  } as Directory;
  /* The tree roots at whoever has no manager — the chief executive. */
  const ceo = everyone.find((e) => !e.managerId);
  const [picked, setPicked] = useState('');
  const rootId = picked || ceo?.id || '';
  const setRootId = setPicked;
  const root = dir.byId(rootId);
  const { data: tree = [] } = useTeam(rootId);
  const managers = sortBy(everyone.filter((e) => e.reports.length), (e) => e.name);
  const spans = managers.map((e) => ({ e, n: e.reports.length }));
  if (!root) return <EmptyState msg="Loading the org chart…" icon="☰" />;

  return (
    <div className="stack">
      <div className="toolbar">
        {ceo && rootId !== ceo.id && <button className="btn" onClick={() => setRootId(ceo.id)}>‹ Back to top</button>}
        <select className="input" style={{ width: 'auto' }} value={rootId} onChange={(e) => setRootId(e.target.value)}>
          {managers.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.designation}</option>)}
        </select>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>{1 + tree.length} people in this tree</span>
      </div>

      <div className="grid g-2-1">
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <OrgNode e={root} depth={0} dir={dir} onOpen={show} onExpand={setRootId} />
          </div>
        </Card>

        <div className="stack">
          <Card title="Department heads" sub={`${DEPTS.length} departments`} flush>
            {DEPTS.map((d) => {
              const h = dir.byId(d.head);
              if (!h) return null;
              return (
                <ListRow key={d.id} onClick={() => show(d.head!)}>
                  <Dot color={d.color} />
                  <Avatar name={h.name} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 12.5 }}>{h.name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{d.name}</div>
                  </div>
                  <Badge>{everyone.filter((e) => e.dept === d.id).length}</Badge>
                </ListRow>
              );
            })}
          </Card>

          <Card title="Largest spans of control" sub="Direct reports">
            <HBar rows={sortBy(spans, (s) => -s.n).slice(0, 8).map((s) => ({
              k: s.e.name, v: s.n, c: deptOf(s.e.dept).color,
            }))} />
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Celebrations
   ============================================================ */

function Celebrations() {
  const app = useApp();
  const show = useShowEmployee();
  const { data: cel = [] } = useCelebrations(60);
  const { data: everyone = [] } = useAllEmployees();
  const dir = {
    list: everyone,
    ids: everyone.map((e) => e.id),
    byId: (id) => everyone.find((e) => e.id === id),
    name: (id) => everyone.find((e) => e.id === id)?.name ?? '—',
    loading: false,
  } as Directory;
  const today = cel.filter((c) => c.inDays === 0);
  const week = cel.filter((c) => c.inDays > 0 && c.inDays <= 7);
  const month = cel.filter((c) => c.inDays > 7 && c.inDays <= 30);
  const milestones = everyone.filter((e) => [1, 3, 5, 7, 10].includes(yearsSince(e.doj))).slice(0, 12);

  const exportCsv = () =>
    downloadCSV(
      'celebrations.csv',
      [['Date', 'Employee', 'Occasion', 'Department', 'Location', 'In days']].concat(
        cel.flatMap((c) => {
          const e = dir.byId(c.empId);
          if (!e) return [];
          return [[c.date, e.name, c.kind === 'birthday' ? 'Birthday' : `${c.years}-year anniversary`,
            deptOf(e.dept).name, siteOf(e.site).name, String(c.inDays)]];
        }),
      ),
    );

  return (
    <div className="stack">
      {today.length > 0 && (
        <div className="card" style={{ background: 'linear-gradient(135deg,var(--brand),var(--s7))', border: 0, color: '#fff' }}>
          <div className="card-b">
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.85 }}>
              Today at {ORG.name}
            </div>
            <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-.6px', margin: '6px 0 12px' }}>
              {today.map((c) => (c.kind === 'birthday' ? '🎂 ' : '🎉 ') + dir.name(c.empId)).join('  ·  ')}
            </div>
            <div style={{ opacity: 0.9, fontSize: 13 }}>
              {today.map((c) => c.kind === 'birthday'
                ? `Wish ${dir.name(c.empId).split(' ')[0]} a happy birthday`
                : `${dir.name(c.empId).split(' ')[0]} completes ${c.years} year${(c.years ?? 0) > 1 ? 's' : ''} with us`,
              ).join(' · ')}
            </div>
            <div className="row" style={{ marginTop: 14, gap: 8 }}>
              <button className="btn solid" style={{ background: '#fff', color: 'var(--brand-ink)', borderColor: '#fff' }}
                onClick={() => app.toast('Wishes sent 🎉', 'ok')}>Send wishes</button>
              <button className="btn" style={{ background: 'rgba(255,255,255,.16)', borderColor: 'rgba(255,255,255,.3)', color: '#fff' }}
                onClick={() => app.toast('Posted to announcements', 'ok')}>Post to announcements</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid g3">
        <Card title="This week" sub={`${week.length} upcoming`} flush><CelebRows list={week} dir={dir} /></Card>
        <Card title="This month" sub={`${month.length} upcoming`} flush><CelebRows list={month} dir={dir} /></Card>
        <Card title="Work milestones" sub="Employees hitting a year milestone" flush>
          <CelebRows dir={dir} list={milestones.map((e) => ({
            kind: 'anniversary' as const, empId: e.id, date: ymd(nextOccur(e.doj)), inDays: 0, years: yearsSince(e.doj),
          }))} />
        </Card>
      </div>

      <Card title="Next 60 days" sub={`${cel.length} celebrations`} flush
        actions={<button className="btn sm" onClick={exportCsv}>⤓ Export</button>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr><th>Date</th><th>Employee</th><th>Occasion</th><th>Department</th><th>Location</th><th className="right">In</th></tr>
            </thead>
            <tbody>
              {cel.map((c, i) => {
                const e = dir.byId(c.empId);
          if (!e) return null;
                return (
                  <tr key={i} className="clickable" onClick={() => show(e.id)}>
                    <td className="nowrap">{fmtD(c.date)}</td>
                    <td><PersonCell e={e} /></td>
                    <td>{c.kind === 'birthday' ? '🎂 Birthday' : `🎉 ${c.years}-year anniversary`}</td>
                    <td>{deptOf(e.dept).name}</td>
                    <td>{siteOf(e.site).name}</td>
                    <td className="right nowrap">{c.inDays === 0 ? <Badge kind="good">Today</Badge> : `${c.inDays} days`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================
   Announcements
   ============================================================ */

const POLICY_DOCS = [
  'Employee Handbook 2026', 'Leave & Attendance Policy', 'POSH Policy',
  'Information Security Policy', 'Travel & Reimbursement Policy', 'Referral Programme',
];

/** Acknowledgement counts are illustrative, so they are fixed per post. */
const ackCount = (a: Announcement) => {
  let h = 0;
  for (let i = 0; i < a.id.length; i++) h = (h * 31 + a.id.charCodeAt(i)) >>> 0;
  return 12 + (h % 85);
};

function Announcements() {
  const app = useApp();
  const { data: announcements = [] } = useAnnouncements();
  const canPost = app.role === 'admin' || app.role === 'manager';
  const [acked, setAcked] = useState<Record<string, boolean>>({});

  return (
    <div className="stack">
      {canPost && (
        <div className="toolbar">
          <button className="btn primary" onClick={() => app.toast('Announcement composer is not wired in this build')}>
            ＋ New announcement
          </button>
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 12.5 }}>
            Posting as {app.me.name} · visible to {app.role === 'admin' ? 'all employees' : 'your team'}
          </span>
        </div>
      )}

      <div className="grid g-2-1">
        <div className="stack">
          {announcements.map((a) => (
            <Card key={a.id}>
              <div className="row" style={{ gap: 9, marginBottom: 9 }}>
                <Avatar name={a.by} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 12.5 }}>{a.by}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {fmtD(a.on)} · {a.dept === 'All' ? 'All employees' : deptOf(a.dept).name}
                  </div>
                </div>
                <Badge kind="info">{a.tag}</Badge>
                {a.pin && <span title="Pinned">📌</span>}
              </div>
              <h3 style={{ margin: '0 0 6px', fontSize: 16, letterSpacing: '-.3px' }}>{a.title}</h3>
              <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>{a.body}</div>
              <div className="row" style={{ marginTop: 12, gap: 7 }}>
                <button className="btn sm ghost" onClick={() => {
                  setAcked((s) => ({ ...s, [a.id]: true }));
                  app.toast('Acknowledged', 'ok');
                }}>
                  👍 {acked[a.id] ? 'Acknowledged' : 'Acknowledge'}
                </button>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {ackCount(a) + (acked[a.id] ? 1 : 0)} employees acknowledged
                </span>
              </div>
            </Card>
          ))}
        </div>

        <div className="stack">
          <Card title="Holiday calendar" sub={`${ORG.fy} · ${HOLIDAYS.length} holidays`} flush>
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              {HOLIDAYS.map((h) => (
                <ListRow key={h.d + h.n}>
                  <div className="right" style={{ width: 52, flex: '0 0 52px' }}>
                    <div style={{ fontWeight: 750, fontSize: 15, lineHeight: 1 }}>{parseYmd(h.d).getDate()}</div>
                    <div className="muted" style={{ fontSize: 10.5, textTransform: 'uppercase' }}>{MON[parseYmd(h.d).getMonth()]}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{h.n}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {DOW[parseYmd(h.d).getDay()]}{h.opt ? ' · Optional' : ''}
                    </div>
                  </div>
                  {h.d < ymd(TODAY) ? <Badge>Past</Badge> : <Badge kind="good">Upcoming</Badge>}
                </ListRow>
              ))}
            </div>
          </Card>

          <Card title="Quick links" sub="Policies & handbooks" flush>
            {POLICY_DOCS.map((p) => (
              <ListRow key={p} onClick={() => app.toast('Opening ' + p)}>
                <span>📄</span>
                <div style={{ flex: 1 }}>{p}</div>
                <span className="muted">PDF</span>
              </ListRow>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---------------- registration ---------------- */

registerModule({
  key: 'org',
  title: TITLES.org,
  subtitle: () => `Reporting structure across ${DEPTS.length} departments`,
  Component: OrgChart,
});

registerModule({
  key: 'celebrations',
  title: TITLES.celebrations,
  subtitle: () => 'Birthdays, work anniversaries and milestones',
  Component: Celebrations,
});

registerModule({
  key: 'announcements',
  title: TITLES.announcements,
  subtitle: () => 'Company-wide communication',
  Component: Announcements,
});
