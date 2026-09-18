/**
 * The three smaller People-group modules: Org Chart, Celebrations and
 * Announcements. Grouped because each is a single view over shared data.
 */
import { useState } from 'react';
import { sortBy } from '../../lib/collections';
import type { Announcement } from '../../data/announcements';

import {
  useAllEmployees, useAnnouncements, useCelebrations, usePostAnnouncement,
  useRemoveAnnouncement, useRequisitions, useSetPinned,
} from './data';
import type { Directory } from './data';
import { DEPTS, deptOf } from '../../data/org';
import { Avatar, Badge, Card, EmptyState, PersonCell, Seg, StatRow, Tile } from '../../components/ui';
import { NoRoot, OrgTreeView } from './OrgChart';
import { OrgStructure } from './OrgStructure';
import { CelebrationsView, KIND } from './Celebrations';
import { AnnouncementsView } from './Announcements';
import type { Occasion } from './Celebrations';
import { Dot, ListRow } from '../../components/common';
import { HBar } from '../../components/charts';
import { useLayer } from '../../components/Layer';
import { useApp } from '../../state/AppContext';
import { useShowEmployee } from '../employees/Profile';
import { registerModule } from '../registry';
import { TITLES } from '../titles';

/* ============================================================
   Org chart
   ============================================================ */

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
  const [q, setQ] = useState('');
  const [view, setView] = useState<'structure' | 'tree' | 'list'>('structure');
  const [deptFilter, setDeptFilter] = useState('');
  const { data: reqs = [] } = useRequisitions();
  const asList = view === 'list';
  const rootId = picked || ceo?.id || '';
  const setRootId = setPicked;
  const root = dir.byId(rootId);
  const managers = sortBy(everyone.filter((e) => e.reports.length), (e) => e.name);
  const spans = managers.map((e) => ({ e, n: e.reports.length }));
  if (!everyone.length) return <EmptyState msg="Loading the org chart…" icon="☰" />;
  if (!root) return <NoRoot />;

  return (
    <div className="stack">
      <div className="toolbar">
        {ceo && rootId !== ceo.id && <button className="btn" onClick={() => setRootId(ceo.id)}>‹ Back to top</button>}
        <div className="search">
          <input className="input" placeholder="Search by name or department…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)} title="Limit to one department">
          <option value="">All departments</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {view === 'tree' && (
          <select className="input" style={{ width: 'auto' }} value={rootId}
            onChange={(e) => setRootId(e.target.value)} title="Draw the tree from">
            {ceo && <option value={ceo.id}>{ceo.name} — whole company</option>}
            {managers.filter((m) => m.id !== ceo?.id).map((e) => (
              <option key={e.id} value={e.id}>{e.name} — {e.designation}</option>
            ))}
          </select>
        )}
        <div className="spacer" />
        <Seg value={view} onChange={setView} options={[
          { v: 'structure', label: 'Structure' },
          { v: 'tree', label: 'Reporting tree' },
          { v: 'list', label: 'List' },
        ]} />
      </div>

      {/*
        * Headcount per department, counted from the roster rather than stored.
        * A chart is read to answer "how big is Engineering", and the answer
        * has to agree with the directory beside it.
        */}
      <StatRow cols={4}>
        <Tile icon="👥" label="Total employees" value={everyone.length}
          foot="On the roster today" />
        <Tile icon="🏢" label="Departments"
          value={DEPTS.filter((d) => everyone.some((e) => e.dept === d.id)).length}
          foot="With at least one person" />
        <Tile icon="📍" label="Locations"
          value={new Set(everyone.map((e) => e.site)).size} foot="Offices and remote" />
        <Tile icon="💼" label="Open positions"
          value={reqs.filter((r) => r.status === 'Open')
            .reduce((n, r) => n + Math.max(0, r.openings - r.filled), 0)}
          foot={`${reqs.filter((r) => r.status === 'Open').length} live requisitions`} />
      </StatRow>

      <div className={asList ? 'grid g-2-1' : 'stack'}>
        <Card
          title={asList ? 'Reporting lines' : view === 'structure' ? 'Our structure' : root.name}
          sub={asList ? `${everyone.length} people`
            : view === 'structure' ? 'Our people. Our structure. Our strength.'
              : root.designation}
          flush={asList}>
          {asList ? (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr><th>Name</th><th>Designation</th><th>Department</th><th>Reports to</th><th className="num">Reports</th></tr>
                </thead>
                <tbody>
                  {sortBy(everyone.filter((e) => !q.trim()
                    || (e.name + ' ' + e.designation + ' ' + deptOf(e.dept).name)
                      .toLowerCase().includes(q.trim().toLowerCase())), (e) => e.name).map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => show(e.id)}>
                      <td><PersonCell e={e} sub={false} /></td>
                      <td className="nowrap">{e.designation}</td>
                      <td className="nowrap">{deptOf(e.dept).name}</td>
                      <td className="nowrap">{e.managerId ? dir.name(e.managerId) : <span className="muted">—</span>}</td>
                      <td className="num">{e.reports.length || <span className="muted">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : view === 'structure' ? (
            <OrgStructure everyone={everyone} requisitions={reqs} onOpen={show}
              q={q} deptFilter={deptFilter} />
          ) : (
            <OrgTreeView root={root} everyone={everyone} onOpen={show} q={q} />
          )}
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
  const layer = useLayer();
  /*
   * A year of lookahead: the calendar can be paged to any month, and the
   * recurring dates are projected onto whichever month is on screen.
   */
  const { data: cel = [] } = useCelebrations(365);
  const { data: everyone = [] } = useAllEmployees();
  const post = usePostAnnouncement();

  const canPost = app.role === 'admin' || app.role === 'manager';

  const wish = (o: Occasion) =>
    app.toast(`Wishes sent to ${o.label} ${KIND[o.kind].icon}`, 'ok');

  /*
   * "Add celebration" posts to the noticeboard, which is a real record people
   * will actually see, rather than to a celebrations feed this system does not
   * have. Tagged so the board can group them.
   */
  const add = () => layer.modal({
    title: 'Add a celebration',
    sub: 'Posted to the noticeboard for everyone to see',
    body: (close: () => void) => <AddCelebration close={close} onPost={post} />,
    footer: null,
  });

  return (
    <CelebrationsView cel={cel} everyone={everyone} onOpen={show}
      onWish={wish} onAdd={add} canPost={canPost} />
  );
}

function AddCelebration({ close, onPost }: {
  close: () => void;
  onPost: ReturnType<typeof usePostAnnouncement>;
}) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const save = async () => {
    if (!title.trim()) { app.toast('Give it a title', 'err'); return; }
    try {
      await onPost.mutate({
        title: title.trim(),
        body: body.trim(),
        tag: 'Celebration',
        pin: false,
        dept: 'All',
      });
      app.toast('Posted to the noticeboard', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not post it', 'err');
    }
  };

  return (
    <div className="stack">
      <label className="fld">
        <span>What is being celebrated</span>
        <input className="input" value={title} autoFocus
          placeholder="August birthdays bash"
          onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="fld">
        <span>Details</span>
        <textarea className="input" rows={4} value={body}
          placeholder="Where, when, and who it is for."
          onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save}>Post</button>
      </div>
    </div>
  );
}

/* ============================================================
   Announcements
   ============================================================ */

/** Acknowledgement counts are illustrative, so they are fixed per post. */
const ackCount = (a: Announcement) => {
  let h = 0;
  for (let i = 0; i < a.id.length; i++) h = (h * 31 + a.id.charCodeAt(i)) >>> 0;
  return 12 + (h % 85);
};

function Announcements() {
  const app = useApp();
  const layer = useLayer();
  const { data: announcements = [] } = useAnnouncements();
  const post = usePostAnnouncement();
  const setPinned = useSetPinned();
  const removeOne = useRemoveAnnouncement();

  const canPost = app.role === 'admin' || app.role === 'manager';
  const [acked, setAcked] = useState<Record<string, boolean>>({});

  const ack = (a: Announcement) => {
    /*
     * Acknowledgement is local to this session. There is no per-person
     * acknowledgement record on the server, so the button remembers what you
     * pressed and says so — it does not pretend to have filed anything.
     */
    setAcked((s) => ({ ...s, [a.id]: true }));
    app.toast('Acknowledged', 'ok');
  };

  const pin = async (a: Announcement) => {
    try {
      await setPinned.mutate(a.id, !a.pin);
      app.toast(a.pin ? 'Unpinned' : 'Pinned to the top', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not change that', 'err');
    }
  };

  const remove = async (a: Announcement) => {
    if (!window.confirm(`Take down "${a.title}"? This cannot be undone.`)) return;
    try {
      await removeOne.mutate(a.id);
      app.toast('Announcement taken down', 'ok');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not take it down', 'err');
    }
  };

  const compose = () => layer.modal({
    title: 'New announcement',
    sub: app.role === 'admin' ? 'Goes to everyone' : 'Goes to your department',
    size: 'wide',
    body: (close: () => void) => <Compose close={close} onPost={post} canPin={app.role === 'admin'} />,
    footer: null,
  });

  return (
    <AnnouncementsView
      announcements={announcements}
      role={app.role}
      meName={app.me.name}
      acks={acked}
      ackCount={ackCount}
      onAck={ack}
      onPost={compose}
      onPin={pin}
      onRemove={remove}
      canPost={canPost}
    />
  );
}

function Compose({ close, onPost, canPin }: {
  close: () => void;
  onPost: ReturnType<typeof usePostAnnouncement>;
  canPin: boolean;
}) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tag, setTag] = useState('Announcement');
  const [dept, setDept] = useState('All');
  const [pin, setPin] = useState(false);

  const save = async () => {
    if (!title.trim()) { app.toast('Give it a title', 'err'); return; }
    if (!body.trim()) { app.toast('Say what it is about', 'err'); return; }
    try {
      await onPost.mutate({ title: title.trim(), body: body.trim(), tag, pin, dept });
      app.toast('Posted to the noticeboard', 'ok');
      close();
    } catch (e) {
      app.toast(e instanceof Error ? e.message : 'Could not post it', 'err');
    }
  };

  return (
    <div className="stack">
      <label className="fld">
        <span>Title</span>
        <input className="input" value={title} autoFocus
          placeholder="Bengaluru office relocation"
          onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="fld">
        <span>Body</span>
        <textarea className="input" rows={5} value={body}
          placeholder="What is happening, when, and what people need to do."
          onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="grid g2">
        <label className="fld">
          <span>Category</span>
          <select className="input" value={tag} onChange={(e) => setTag(e.target.value)}>
            {['Announcement', 'Policy', 'Payroll', 'Holiday', 'Attendance', 'Compliance', 'Hiring']
              .map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Audience</span>
          <select className="input" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="All">Everyone</option>
            {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      </div>
      {canPin && (
        <label className="row muted" style={{ gap: 7, fontSize: 12.5 }}>
          <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
          Feature this at the top of the board
        </label>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" onClick={save}>Post</button>
      </div>
    </div>
  );
}

registerModule({
  key: 'org',
  title: TITLES.org,
  Component: OrgChart,
});

registerModule({
  key: 'celebrations',
  title: TITLES.celebrations,
  Component: Celebrations,
});

registerModule({
  key: 'announcements',
  title: TITLES.announcements,
  Component: Announcements,
});
