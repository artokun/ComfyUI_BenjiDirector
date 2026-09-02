// Deleting a Beat — the pure part.
//
// A Beat is the one node whose deletion has two honest meanings: take everything inside with
// it, or drop only the shell and let its scenes stand where they were. Both are planned here
// as pure functions of (nodes, edges, id) so the container toolbar, the Delete key, the pane
// toolbar and the agent's `delete_container` all run the same arithmetic — and vitest can
// check it without a canvas.
//
// The shell plan is ifr-node-lab's `deleteContainerOnly`: dissolve first if it is a subgraph
// (rails → direct wires, so the children stay wired to the outside), re-parent the DIRECT
// children to the grandparent with absolute-corrected positions (nothing moves on screen),
// then drop the empty shell. Nested Beats ride along as children: their rails are keyed by
// their own id, so they survive untouched. An OUTER subgraph whose rails aliased the deleted
// Beat's ports is re-derived by settle's reconcile — boundary ids are derived, never minted.

import {
  SUBGRAPH_TYPE,
  absolutePos,
  dissolveSubgraph,
  isGroupLikeType,
  sortParentsFirst,
  type BaseNodeData,
  type GraphEdge,
  type GraphNode,
} from "@benjidirector/graph-core";
import type { DirectorData } from "./model.js";

/** Every node under `id`: each direct child, followed by its own descendants (pre-order). */
export function descendantsOf<D>(nodes: readonly GraphNode<D>[], id: string): GraphNode<D>[] {
  const out: GraphNode<D>[] = [];
  // Cycle guard: a parent chain that loops (an import, a tool call) must terminate, not spin.
  const seen = new Set<string>([id]);
  const walk = (pid: string) => {
    for (const n of nodes) {
      if (n.parentId !== pid || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
      walk(n.id);
    }
  };
  walk(id);
  return out;
}

/** What the confirm modal prints for a node: the palette's word for it, not the data kind. */
export function kindOf(n: GraphNode<DirectorData>): string {
  if (isGroupLikeType(n.type)) return n.type === SUBGRAPH_TYPE ? "subgraph" : "group";
  const d = n.data;
  return d.kind === "asset" ? d.asset : d.kind;
}

export interface DescendantRow {
  id: string;
  label: string;
  kind: string;
  /** 1 for a direct child, 2 for a grandchild, … — the modal indents by it. */
  depth: number;
}

/** The rows the confirm modal lists, in the order `descendantsOf` walks them. */
export function describeDescendants(nodes: readonly GraphNode<DirectorData>[], id: string): DescendantRow[] {
  const depthOf = new Map<string, number>([[id, 0]]);
  return descendantsOf(nodes, id).map((n) => {
    // Pre-order: a parent's depth is always recorded before its children are visited.
    const depth = (depthOf.get(n.parentId ?? "") ?? 0) + 1;
    depthOf.set(n.id, depth);
    return { id: n.id, label: n.data.label, kind: kindOf(n), depth };
  });
}

export interface DeletePlan<D> {
  nodes: GraphNode<D>[];
  edges: GraphEdge[];
  /** Ids that are gone. */
  removed: string[];
  /** Ids that moved up to the grandparent (shell mode only). */
  reparented: string[];
}

/** Delete `id` and everything inside it, and every wire that touched any of them. */
export function cascadeDeletePlan<D extends BaseNodeData>(nodes: readonly GraphNode<D>[], edges: readonly GraphEdge[], id: string): DeletePlan<D> {
  if (!nodes.some((n) => n.id === id)) throw new Error(`no node "${id}"`);
  const removed = [id, ...descendantsOf(nodes, id).map((n) => n.id)];
  const gone = new Set(removed);
  return {
    nodes: nodes.filter((n) => !gone.has(n.id)),
    edges: edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
    removed,
    reparented: [],
  };
}

/**
 * Delete only the shell of Beat `id`: its direct children move up to its parent (or the
 * canvas) at the same absolute position, their wiring intact.
 */
export function shellDeletePlan<D extends BaseNodeData>(nodes: readonly GraphNode<D>[], edges: readonly GraphEdge[], id: string): DeletePlan<D> {
  const target = nodes.find((n) => n.id === id);
  if (!target) throw new Error(`no node "${id}"`);
  if (!isGroupLikeType(target.type)) throw new Error(`"${id}" is not a Beat — only a Beat has a shell to drop`);

  let ns: GraphNode<D>[] = [...nodes];
  let es: GraphEdge[] = [...edges];
  if (target.type === SUBGRAPH_TYPE) {
    // Rails back to direct wires FIRST, so the children keep their connections to the outside
    // once the container that relayed them is gone.
    const out = dissolveSubgraph(id, ns, es);
    ns = out.nodes;
    es = out.edges;
  }

  const shell = ns.find((n) => n.id === id) ?? target;
  const grandparent = shell.parentId ? ns.find((n) => n.id === shell.parentId) : undefined;
  const gpAbs = grandparent ? absolutePos(grandparent, ns) : { x: 0, y: 0 };
  const reparented: string[] = [];
  const next = ns
    .filter((n) => n.id !== id)
    .map((n): GraphNode<D> => {
      if (n.parentId !== id) return n;
      // Absolute position from the graph as it stands NOW, then re-expressed against the
      // grandparent — the child does not move on screen, only its frame of reference does.
      const abs = absolutePos(n, ns);
      reparented.push(n.id);
      const { parentId: _dropped, ...rest } = n;
      return {
        ...rest,
        ...(grandparent ? { parentId: grandparent.id } : {}),
        position: { x: abs.x - gpAbs.x, y: abs.y - gpAbs.y },
      } as GraphNode<D>;
    });

  return {
    nodes: sortParentsFirst(next),
    // After a dissolve nothing should still touch the shell; anything that does (an unknown
    // handle dissolve passed through) has no endpoint left and goes with it.
    edges: es.filter((e) => e.source !== id && e.target !== id),
    removed: [id],
    reparented,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Where a right-click on a container counts as its BODY
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Parts of a container card that are real targets: a right-click there is theirs, not the body's. */
const CONTAINER_CHROME = [
  ".bd-group-title",
  ".bd-collapsed", // a collapsed card has no body to drop a node into
  ".bd-nodebar",
  ".bd-rail",
  ".react-flow__handle",
  ".react-flow__resize-control",
  "button",
  "input",
];

/** Structural so it can be checked without a DOM: anything with `closest` will do. */
export interface ClosestLike {
  closest(selector: string): unknown;
}

/** True when `el` sits in a container's empty body rather than on its title, buttons, handles or rails. */
export function isContainerBodyTarget(el: ClosestLike | null | undefined): boolean {
  if (!el) return false;
  return !CONTAINER_CHROME.some((sel) => !!el.closest(sel));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The confirm dispatcher
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// DirectorApp (the Delete key, the pane toolbar) and the container toolbar all ASK for a
// deletion; the component that owns the modal (container-delete.tsx, mounted through a slot)
// answers. A plain module-level hand-off keeps DirectorApp free of any React dependency on
// the feature module.

export type DeleteContainerRequest = (id: string) => void;

let handler: DeleteContainerRequest | null = null;

/** Install the confirm flow. Returns the uninstaller; a stale uninstall is a no-op. */
export function setDeleteContainerHandler(fn: DeleteContainerRequest): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Ask the user how to delete a Beat. False when no confirm UI is mounted — the caller must NOT cascade instead. */
export function requestDeleteContainer(id: string): boolean {
  if (!handler) return false;
  handler(id);
  return true;
}
