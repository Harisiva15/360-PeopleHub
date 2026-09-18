/**
 * The organisation chart.
 *
 * Drawn top-down with real connectors, because that is what the shape is for:
 * a reporting line is a fact about two people, and an indented list makes the
 * reader reconstruct it from whitespace. Siblings sit on one bar, so "who else
 * reports to her" is answered by looking along a row rather than by counting
 * indents.
 *
 * **The tree is built from `reports`, with a guard against cycles.** A manager
 * chain that loops — A reports to B reports to A, which a bad import can
 * produce — would otherwise recurse until the tab dies. Anyone already drawn is
 * not drawn again, so a loop shows up as a truncated branch rather than a
 * crash.
 *
 * **Collapsing is per node, not a global depth.** "Everyone under Priya, three
 * levels down" is not a question anybody asks; "what does Priya's team look
 * like" is. Expand all and collapse all are conveniences over the same state,
 * not a separate mechanism.
 *
 * **Searching reveals rather than filters.** Hiding non-matches would leave a
 * match floating with no visible manager, which is the one thing a chart is
 * read for. Matches are highlighted and their ancestors forced open; everything
 * else stays where it was.
 */

import { useMemo, useRef, useState } from 'react';
import type { Employee } from '../../types/employee';
import { sortBy } from '../../lib/collections';
import { deptOf, siteOf } from '../../data/org';
import { Avatar, Card, EmptyState } from '../../components/ui';
import { Icon } from '../../components/icons';

export interface OrgTree {
  e: Employee;
  kids: OrgTree[];
  /** Everyone beneath this node, however deep. */
  total: number;
}

/**
 * Build the tree under one person.
 *
 * `seen` is carried down the recursion rather than kept outside it, so a
 * person appearing twice in different branches is drawn once per branch but a
 * genuine cycle still terminates.
 */
export function buildTree(
  root: Employee,
  byId: (id: string) => Employee | undefined,
  /** Everyone between the chart's root and this node — this node's ancestors. */
  seen: Set<string> = new Set(),
): OrgTree {
  const ancestors = new Set(seen).add(root.id);

  const kids = sortBy(
    (root.reports ?? [])
      .map((id) => byId(id))
      /* A report id naming nobody — someone who has left — is dropped rather
         than drawn as a blank card. */
      .filter((x): x is Employee => !!x)
      /*
       * Already an ancestor, so the reporting line loops back on itself.
       * Dropping them ends the branch; drawing them would put one person twice
       * in a single vertical path, which reads as a real second posting.
       * Only ancestors are excluded — the same person under two different
       * managers is a dotted line, not a cycle, and belongs under both.
       */
      .filter((x) => !ancestors.has(x.id)),
    (k) => k.name,
  ).map((k) => buildTree(k, byId, ancestors));

  return { e: root, kids, total: kids.reduce((n, k) => n + 1 + k.total, 0) };
}

/** Every id on the path from the root down to `target`, target included. */
function pathTo(node: OrgTree, target: string, trail: string[] = []): string[] | null {
  const here = [...trail, node.e.id];
  if (node.e.id === target) return here;
  for (const k of node.kids) {
    const found = pathTo(k, target, here);
    if (found) return found;
  }
  return null;
}

function idsWithChildren(node: OrgTree, out: string[] = []): string[] {
  if (node.kids.length) out.push(node.e.id);
  node.kids.forEach((k) => idsWithChildren(k, out));
  return out;
}

function Node({
  node, collapsed, onToggle, onOpen, hits, forced,
}: {
  node: OrgTree;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  hits: Set<string>;
  /** Ancestors of a search hit, opened regardless of collapse state. */
  forced: Set<string>;
}) {
  const { e, kids } = node;
  const shut = collapsed.has(e.id) && !forced.has(e.id);
  const hit = hits.has(e.id);

  return (
    <li>
      <div className={'org-node' + (hit ? ' hit' : '')}>
        <button className="org-card" onClick={() => onOpen(e.id)}
          title={`${e.name} — ${e.designation}`}>
          <Avatar name={e.name} />
          <span className="org-t">
            <span className="org-n">{e.name}</span>
            <span className="org-d">{e.designation}</span>
            <span className="org-m">
              {deptOf(e.dept).name} · {siteOf(e.site).city === '—' ? 'Remote' : siteOf(e.site).city}
            </span>
          </span>
        </button>

        {kids.length > 0 && (
          <button className="org-tog" onClick={() => onToggle(e.id)}
            aria-expanded={!shut}
            title={shut ? `Show ${kids.length} direct reports` : 'Hide reports'}>
            {shut ? `+${node.total}` : '−'}
          </button>
        )}
      </div>

      {kids.length > 0 && !shut && (
        <ul>
          {kids.map((k) => (
            <Node key={k.e.id} node={k} collapsed={collapsed} onToggle={onToggle}
              onOpen={onOpen} hits={hits} forced={forced} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTreeView({
  root, everyone, onOpen, q,
}: {
  root: Employee;
  everyone: Employee[];
  onOpen: (id: string) => void;
  q: string;
}) {
  const byId = useMemo(() => {
    const m = new Map(everyone.map((e) => [e.id, e]));
    return (id: string) => m.get(id);
  }, [everyone]);

  const tree = useMemo(() => buildTree(root, byId), [root, byId]);

  /*
   * Everything below the top two levels starts shut. A chart that opens with
   * four hundred boxes is a chart nobody reads; the shape of the leadership
   * is what someone wants first.
   */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const shut = new Set<string>();
    tree.kids.forEach((k) => k.kids.forEach((g) => idsWithChildren(g).forEach((id) => shut.add(id))));
    tree.kids.forEach((k) => { if (k.kids.length) shut.add(k.e.id); });
    return shut;
  });

  const [zoom, setZoom] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!needle) return new Set<string>();
    return new Set(everyone.filter((e) =>
      (e.name + ' ' + e.designation + ' ' + deptOf(e.dept).name).toLowerCase().includes(needle),
    ).map((e) => e.id));
  }, [everyone, needle]);

  /* Ancestors of every hit, so a match is never shown orphaned. */
  const forced = useMemo(() => {
    const open = new Set<string>();
    hits.forEach((id) => pathTo(tree, id)?.forEach((x) => open.add(x)));
    return open;
  }, [tree, hits]);

  const toggle = (id: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(idsWithChildren(tree).filter((id) => id !== tree.e.id)));

  /*
   * Fit measures the laid-out width rather than the painted one: a transform
   * does not change layout, so scrollWidth is still the unscaled size and the
   * ratio is the scale that would make it fit.
   */
  const fit = () => {
    const w = wrap.current, i = inner.current;
    if (!w || !i) return;
    const available = w.clientWidth - 8;
    const needed = i.scrollWidth;
    setZoom(needed > available ? Math.max(0.3, available / needed) : 1);
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <button className="btn sm" onClick={expandAll}>⤢ Expand all</button>
        <button className="btn sm" onClick={collapseAll}>⤡ Collapse all</button>
        <div className="spacer" />
        {needle && (
          <span className="muted" style={{ fontSize: 12 }}>
            {hits.size} match{hits.size === 1 ? '' : 'es'}
          </span>
        )}
        <button className="btn icon sm" title="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.3, Math.round((z - 0.1) * 10) / 10))}>−</button>
        <span className="muted" style={{ fontSize: 12, minWidth: 40, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button className="btn icon sm" title="Zoom in"
          onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10))}>+</button>
        <button className="btn sm" onClick={fit}>Fit to screen</button>
      </div>

      <div className="org-wrap" ref={wrap}>
        <div ref={inner} className="orgtree"
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
          <ul>
            <Node node={tree} collapsed={collapsed} onToggle={toggle}
              onOpen={onOpen} hits={hits} forced={forced} />
          </ul>
        </div>
      </div>
    </div>
  );
}

/** A compact summary card, for when there is no root to draw from. */
export function NoRoot() {
  return (
    <Card>
      <EmptyState icon={<Icon n="menu" size="lg" />}
        msg="Nobody sits at the top of the chart — every employee has a manager, so there is no root to draw from." />
    </Card>
  );
}
