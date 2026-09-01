// Containment helpers — which container should a node belong to, and in what order do
// nodes have to be handed to React Flow.
//
// Ported from ifr-node-lab `src/flow/parenting.ts`, which already described itself as
// editor-independent. The only changes are the ones that remove the IFR domain: the node
// type is generic instead of `BenchRFNode`, and the group-like test comes from
// `./types` instead of a set duplicated out of a 278KB App.tsx.
//
// Used by the drag-stop AND resize-end paths — a container that grows over a node adopts
// it just as a node dragged into a container does, which is why this is a pure function of
// (node, all) rather than something driven by a drag event.

import { isGroupLikeType, type GraphNode } from "./types";

const DEFAULT_W = 140;
const DEFAULT_H = 60;

/** Width/height a node currently occupies. Measured wins; the data hint is the fallback. */
function sizeOf(n: GraphNode<unknown>): { w: number; h: number } {
  const data = n.data as { width?: number; height?: number } | undefined;
  return {
    w: n.measured?.width ?? data?.width ?? DEFAULT_W,
    h: n.measured?.height ?? data?.height ?? DEFAULT_H,
  };
}

/**
 * A node's position in absolute canvas coordinates.
 *
 * React Flow stores a child's position RELATIVE to its parent, so anything comparing two
 * nodes geometrically has to lift both into the same space first. `seen` guards a cyclic
 * parent chain: cycles should not exist in well-formed state, but an import or a tool call
 * can introduce one, and bailing out beats spinning forever.
 */
export function absolutePos<D>(node: GraphNode<D>, all: readonly GraphNode<D>[]): { x: number; y: number } {
  let { x, y } = node.position;
  let p = node.parentId;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    seen.add(p);
    const parent = all.find((n) => n.id === p);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    p = parent.parentId;
  }
  return { x, y };
}

/** Centre of a node's rendered card, in absolute coordinates. */
function centerOf<D>(node: GraphNode<D>, all: readonly GraphNode<D>[]): { x: number; y: number } {
  const { w, h } = sizeOf(node);
  const { x, y } = absolutePos(node, all);
  return { x: x + w / 2, y: y + h / 2 };
}

/** How many ancestors a node has. Cycle-guarded, same reasoning as `absolutePos`. */
function depthOf<D>(id: string, all: readonly GraphNode<D>[]): number {
  let d = 0;
  let p = all.find((n) => n.id === id)?.parentId;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    seen.add(p);
    d += 1;
    p = all.find((n) => n.id === p)?.parentId;
  }
  return d;
}

/**
 * Would parenting `childId` under `candidateParentId` create a cycle?
 *
 * True when the candidate IS the child, or when the child appears anywhere in the
 * candidate's ancestor chain. This is what stops a Beat from being dragged into itself or
 * into one of its own descendants.
 */
export function wouldCreateCycle<D>(
  childId: string,
  candidateParentId: string,
  all: readonly GraphNode<D>[],
): boolean {
  if (childId === candidateParentId) return true;
  let current: string | undefined = candidateParentId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current === childId) return true;
    current = all.find((n) => n.id === current)?.parentId;
  }
  return false;
}

/**
 * Decide which container a node belongs to and return a node with `parentId` and
 * `position` updated accordingly.
 *
 * - centre inside a container, and not already parented there → reparent
 * - has a parent but the centre is no longer inside any valid container → unparent
 * - otherwise → unchanged
 *
 * Returns the SAME reference when nothing changes, so a caller can `===` it and skip a
 * re-render. That identity check is the reason this returns a node rather than a patch.
 *
 * "Which container" means the INNERMOST one: candidates are sorted deepest-first so a Beat
 * nested inside another Beat wins over its parent.
 */
export function containmentFor<D>(
  node: GraphNode<D>,
  all: readonly GraphNode<D>[],
  isFixed: (id: string) => boolean = () => false,
): GraphNode<D> {
  if (isFixed(node.id)) return node;

  const center = centerOf(node, all);
  const candidates = all
    .filter((n) => isGroupLikeType(n.type) && n.id !== node.id)
    .sort((a, b) => depthOf(b.id, all) - depthOf(a.id, all));

  let containing: GraphNode<D> | null = null;
  for (const g of candidates) {
    if (wouldCreateCycle(node.id, g.id, all)) continue;
    const gPos = absolutePos(g, all);
    const { w, h } = sizeOf(g);
    if (
      center.x >= gPos.x &&
      center.x <= gPos.x + w &&
      center.y >= gPos.y &&
      center.y <= gPos.y + h
    ) {
      containing = g;
      break;
    }
  }

  const abs = absolutePos(node, all);

  if (containing && node.parentId !== containing.id) {
    const containerAbs = absolutePos(containing, all);
    return {
      ...node,
      parentId: containing.id,
      position: { x: abs.x - containerAbs.x, y: abs.y - containerAbs.y },
    };
  }
  if (!containing && node.parentId) {
    const { parentId: _dropped, ...rest } = node;
    return { ...rest, position: { x: abs.x, y: abs.y } } as GraphNode<D>;
  }
  return node;
}

/**
 * Order nodes so every parent precedes its children.
 *
 * React Flow v12 requires this, and a pairwise comparator is NOT sufficient — for
 * [C(parent B), B(parent A), A] a pairwise sort can yield B, C, A and leave A after its own
 * descendants. So this is a proper iterative DFS that emits each ancestor before the node
 * that depends on it. A cyclic chain terminates via `visiting` and lands in arbitrary order,
 * which is the right failure mode: wrong-looking, not hung.
 */
export function sortParentsFirst<D>(nodes: readonly GraphNode<D>[]): GraphNode<D>[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: GraphNode<D>[] = [];
  const visit = (n: GraphNode<D>): void => {
    if (visited.has(n.id) || visiting.has(n.id)) return;
    visiting.add(n.id);
    if (n.parentId) {
      const parent = byId.get(n.parentId);
      if (parent && parent.id !== n.id) visit(parent);
    }
    visiting.delete(n.id);
    visited.add(n.id);
    out.push(n);
  };
  for (const n of nodes) visit(n);
  return out;
}
