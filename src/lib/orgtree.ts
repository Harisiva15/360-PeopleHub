/**
 * A department reports to a department, and these two functions are what a
 * screen needs to show that.
 *
 * `department.parent_id` has been in the database since `0002_org_config.sql` and
 * was never reachable from the product. The server has always held the rules —
 * a recursive CTE refuses a cycle, and the composite key `(tenant_id, parent_id)`
 * makes a cross-tenant parent unrepresentable — so nothing here decides anything.
 * These only shape a list the server already validated: which departments a
 * select may offer, and what order the table reads in.
 *
 * Kept out of the screen so the behaviour can be exercised directly instead of
 * inferred from the markup, and structural rather than typed to `Department` so a
 * check can call them with four fields and no service import.
 */

/** The shape both functions need: an id, who it reports to, and how to label it. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  name: string;
}

/**
 * Every node at or below `rootId`, including `rootId` itself.
 *
 * The parent selector subtracts this from its options: offering a department one
 * of its own descendants is the cycle the server refuses, and a select should not
 * propose a refusal. Being only as fresh as the last read is fine — the server
 * decides, so a stale list costs an explained refusal, never a cycle.
 *
 * Grows the set by repeated sweeps rather than recursing, so a loop in the input
 * terminates instead of overflowing the stack.
 */
export function subtreeOf<T extends TreeNode>(nodes: T[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let growing = true;
  while (growing) {
    growing = false;
    for (const n of nodes) {
      if (n.parentId !== null && out.has(n.parentId) && !out.has(n.id)) {
        out.add(n.id);
        growing = true;
      }
    }
  }
  return out;
}

/**
 * The nodes in the order a tree reads: parents, then their children under them.
 *
 * Each level is ordered by name, which is the order the server already returns
 * them in — the nesting is the only thing added, and it is a presentation
 * decision, which is why it lives here and not in a SQL `ORDER BY`.
 *
 * Two properties matter more than the ordering. The walk cannot loop, and
 * **nothing is dropped**: a node whose parent is not in the list, or one caught in
 * a cycle, is emitted at depth 0 rather than silently disappearing — which is what
 * a plain recursion down from the roots would do. A configuration screen that
 * loses a row is worse than one that shows it in the wrong place.
 */
export function inTreeOrder<T extends TreeNode>(nodes: T[]): { node: T; depth: number }[] {
  const byName = [...nodes].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const ids = new Set(byName.map((n) => n.id));
  const out: { node: T; depth: number }[] = [];
  const placed = new Set<string>();

  /* Depth is capped by the number of nodes, so a cycle cannot drive this deeper. */
  const walk = (parentId: string | null, depth: number) => {
    for (const n of byName) {
      if (placed.has(n.id)) continue;
      /* A parent outside the list is no parent, so the node sits at the top. */
      const under = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
      if (under !== parentId) continue;
      placed.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);

  /* Whatever a cycle kept out of the tree. Shown, not lost. */
  for (const n of byName) if (!placed.has(n.id)) out.push({ node: n, depth: 0 });
  return out;
}
