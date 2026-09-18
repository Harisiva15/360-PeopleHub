/**
 * The noticeboard.
 *
 * **Featured is pinned.** The banner across the top is not a separate concept
 * to be curated — it is the posts somebody already pinned, which is the
 * decision "this matters more than the rest" already made once. A second
 * mechanism would need its own rules about which wins.
 *
 * **Every action here is real.** Posting, pinning and taking a post down all
 * go to the service and are refused for anyone who may not do them. The button
 * that used to raise "the composer is not wired in this build" now posts.
 *
 * **No view counts.** The reference shows them and there is no such record;
 * acknowledgements are shown instead, because the Acknowledge button beside
 * them actually does something. Inventing a second number would make the first
 * one look invented too.
 */

import { useMemo, useState } from 'react';
import type { Announcement } from '../../data/announcements';
import { daysBetween, fmtD, TODAY, ymd } from '../../lib/dates';
import { DEPTS, deptOf } from '../../data/org';
import { Avatar, Badge, Card, EmptyState } from '../../components/ui';
import { ListRow } from '../../components/common';
import { can } from '../../state/rbac';
import type { AppRole } from '../../types/employee';
import { Icon } from '../../components/icons';

/** A post is new for a week — long enough to be seen, short enough to mean it. */
const NEW_DAYS = 7;

/** Tag colours, cycled in a fixed order so a tag keeps its colour. */
const TAG_TONES = ['blue', 'violet', 'rose', 'green', 'amber'] as const;
export const toneOf = (tag: string, tags: string[]) =>
  TAG_TONES[Math.max(0, tags.indexOf(tag)) % TAG_TONES.length];

const WINDOWS: { v: string; label: string; days: number }[] = [
  { v: '', label: 'All time', days: 0 },
  { v: '7', label: 'Last 7 days', days: 7 },
  { v: '30', label: 'Last 30 days', days: 30 },
  { v: '90', label: 'Last 90 days', days: 90 },
];

/**
 * Where the quick links go.
 *
 * Every one is a route that exists, and the list is filtered by what the
 * reader may actually open — a link to a page that refuses them is worse than
 * no link.
 */
const QUICK: { to: string; key: string; icon: string; label: string }[] = [
  { to: '/documents', key: 'documents', icon: '📄', label: 'Policies & handbook' },
  { to: '/leave', key: 'leave', icon: '📅', label: 'Holiday calendar' },
  { to: '/org', key: 'org', icon: '🗂', label: 'Org chart' },
  { to: '/employees', key: 'employees', icon: '👥', label: 'Employee directory' },
  { to: '/helpdesk', key: 'helpdesk', icon: '💬', label: 'Raise a query' },
  { to: '/settings', key: 'settings', icon: '⚙️', label: 'Office locations' },
];

export function AnnouncementsView({
  announcements, role, meName, acks, ackCount, onAck, onPost, onPin, onRemove, canPost,
}: {
  announcements: Announcement[];
  role: AppRole;
  meName: string;
  /** Posts this reader has acknowledged in this session. */
  acks: Record<string, boolean>;
  onAck: (a: Announcement) => void;
  onPost: () => void;
  onPin: (a: Announcement) => void;
  onRemove: (a: Announcement) => void;
  canPost: boolean;
  /** Passed in rather than computed here: it is illustrative, and the module
      that owns that decision should be the one making it. */
  ackCount: (a: Announcement) => number;
}) {
  const [tag, setTag] = useState('');
  const [dept, setDept] = useState('');
  const [win, setWin] = useState('');
  const [q, setQ] = useState('');
  const [featured, setFeatured] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  const today = ymd(TODAY);

  /*
   * Tabs and categories are built from the tags in use, not a fixed list. A
   * tab that is always empty is worse than no tab, and a post tagged something
   * new would otherwise be reachable only from "All".
   */
  const tags = useMemo(
    () => [...new Set(announcements.map((a) => a.tag))].sort(),
    [announcements]);

  const pinned = announcements.filter((a) => a.pin);
  const spot = pinned[featured % Math.max(1, pinned.length)];

  const shown = announcements.filter((a) =>
    (!tag || a.tag === tag)
    && (!dept || a.dept === dept)
    && (!win || daysBetween(a.on, today) <= Number(win))
    && (!q.trim() || (a.title + ' ' + a.body + ' ' + a.by).toLowerCase()
      .includes(q.trim().toLowerCase())));

  return (
    <div className="stack">
      {spot && (
        <div className="ann-hero">
          <div className="ann-hero-t">
            <Badge kind="warn">Featured</Badge>
            <h2>{spot.title}</h2>
            <p>{spot.body}</p>
            <div className="row" style={{ gap: 9, marginTop: 13 }}>
              <button className="btn solid" onClick={() => setOpen(spot.id)}>Read more →</button>
              <span className="muted" style={{ fontSize: 12 }}>
                {spot.by} · {fmtD(spot.on)}
              </span>
            </div>
          </div>
          {pinned.length > 1 && (
            <div className="ann-dots">
              {pinned.map((p, i) => (
                <button key={p.id}
                  className={'ann-dot' + (i === featured % pinned.length ? ' on' : '')}
                  onClick={() => setFeatured(i)}
                  aria-label={`Featured post ${i + 1}: ${p.title}`} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="search">
          <input className="input" placeholder="Search announcements…"
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={tag}
          onChange={(e) => setTag(e.target.value)}>
          <option value="">All categories</option>
          {tags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={dept}
          onChange={(e) => setDept(e.target.value)}>
          <option value="">Everyone</option>
          <option value="All">Company-wide</option>
          {DEPTS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="input" style={{ width: 'auto' }} value={win}
          onChange={(e) => setWin(e.target.value)}>
          {WINDOWS.map((w) => <option key={w.v} value={w.v}>{w.label}</option>)}
        </select>
        <div className="spacer" />
        {canPost && (
          <button className="btn primary" onClick={onPost}><Icon n="add" size="lg" /> New announcement</button>
        )}
      </div>

      <div className="grid g-2-1">
        <Card
          title={tag || 'All announcements'}
          sub={`${shown.length} of ${announcements.length}`}
          flush>
          {shown.length ? shown.map((a) => {
            const age = daysBetween(a.on, today);
            const isOpen = open === a.id;
            return (
              <div key={a.id} className="ann-row">
                <div className={'ann-ic t-' + toneOf(a.tag, tags)}>📣</div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 7, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <button className="ann-title" onClick={() => setOpen(isOpen ? null : a.id)}>
                      {a.title}
                    </button>
                    {age <= NEW_DAYS && <Badge kind="good">New</Badge>}
                    {a.pin && <span title="Pinned"><Icon n="flag" size="lg" /> </span>}
                  </div>

                  <div className={'ann-body' + (isOpen ? ' open' : '')}>{a.body}</div>

                  <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <Avatar name={a.by} size="sm" />
                    <span style={{ fontSize: 11.5, fontWeight: 600 }}>{a.by}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {fmtD(a.on)} · {a.dept === 'All' ? 'All employees' : deptOf(a.dept).name}
                    </span>
                    <button className="btn sm ghost" onClick={() => onAck(a)}>
                      <Icon n="applause" size="lg" /> {acks[a.id] ? 'Acknowledged' : 'Acknowledge'}
                    </button>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {ackCount(a) + (acks[a.id] ? 1 : 0)} acknowledged
                    </span>
                  </div>
                </div>

                <div className="ann-side">
                  <Badge kind="info">{a.tag}</Badge>
                  {canPost && (
                    <div className="row" style={{ gap: 3, marginTop: 7 }}>
                      <button className="btn ghost icon sm" title={a.pin ? 'Unpin' : 'Pin to the top'}
                        onClick={() => onPin(a)}>📌</button>
                      <button className="btn ghost icon sm" title="Take it down"
                        onClick={() => onRemove(a)}>🗑</button>
                    </div>
                  )}
                </div>
              </div>
            );
          }) : <EmptyState msg="Nothing matches those filters" icon={<Icon n="announcements" size="lg" />} />}
        </Card>

        <div className="stack">
          <Card title="Quick links" sub="Where people usually go next" flush>
            {QUICK.filter((l) => can(role, l.key)).map((l) => (
              <ListRow key={l.to} to={l.to}>
                <span style={{ fontSize: 15 }}>{l.icon}</span>
                <div style={{ flex: 1 }}>{l.label}</div>
                <span className="muted">›</span>
              </ListRow>
            ))}
          </Card>

          <Card title="Categories" sub={`${tags.length} in use`} flush>
            {tags.map((t) => (
              <ListRow key={t} onClick={() => setTag(tag === t ? '' : t)}
                style={tag === t ? { background: 'var(--brand-wash)' } : undefined}>
                <i className={'cal-dot t-' + toneOf(t, tags)} />
                <div style={{ flex: 1 }}>{t}</div>
                <Badge>{announcements.filter((a) => a.tag === t).length}</Badge>
              </ListRow>
            ))}
          </Card>

          {canPost && (
            <Card title="Posting as" sub={meName}>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {role === 'admin'
                  ? 'Your posts go to everyone.'
                  : 'Your posts go to your own department.'}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
