// The DISPLAYED graph versus the canonical one.
//
// State stays CANONICAL: every edge in React state joins the two real ports it always did,
// which is what the Calliope write-back diffs and what `outline` reports. What React Flow
// DRAWS is a projection computed here on every render. When a container is collapsed its
// descendants are hidden, so an edge that touched one of them has nowhere to land: that end
// is re-routed to a PROXY handle on the outermost collapsed container instead, and an edge
// whose both ends sit under the same collapsed container is not drawn at all. Nothing here is
// ever written back into state — a proxy edge in state would look to `chainedFrom` like a real
// wire feeding IN FRAME and flip `chain_from_prev` on a row.
//
// Ported from ifr-node-lab's `displayedEdges` and GroupNode proxies, with two changes. Proxy
// handle ids are DERIVED (`${containerId}::proxy:${childPortId}`) rather than reusing the
// child's own handle id, so a proxy can never be mistaken for the port it stands in for and
// the type check refuses a wire dropped on one. And a displayed edge carries a derived id
// (`${canonicalId}@display`), so a React Flow change or a midpoint-menu click that names one
// maps back to the canonical edge it came from with `canonicalEdgeId`.
//
// Subgraphs keep their rails: a crossing that reconcile promoted already terminates on a real
// boundary handle of the collapsed card, and the inner relay behind it is hidden here. Only a
// crossing that no rail carries — every crossing of a plain group, and a deep one that passes
// through a plain group inside a subgraph — is proxied.

import type { Edge, EdgeChange, Node } from "@xyflow/react";
import { useMemo } from "react";
import { isContainerData, isGroupLikeType, type PortInfo } from "@benjidirector/graph-core";
import type { ProxyHandle } from "./model.js";
import "./styles/u6-group-collapse.css";

/** The shape of a node this module reads. React Flow's `Node` and graph-core's `GraphNode` fit. */
export interface ViewNode {
  id: string;
  type?: string;
  parentId?: string;
  data: unknown;
}

/** The shape of an edge this module reads and re-routes. */
export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  hidden?: boolean;
}

const PROXY_MARK = "::proxy:";
const DISPLAY_SUFFIX = "@display";

/** The one proxy-handle id derivation. Never inline this. */
export const proxyHandleId = (containerId: string, childPortId: string): string => `${containerId}${PROXY_MARK}${childPortId}`;

/** Recognise a proxy handle and say which container carries it and which port it fronts. */
export function parseProxyHandle(handleId: string | null | undefined): { containerId: string; childPortId: string } | undefined {
  if (!handleId) return undefined;
  const i = handleId.indexOf(PROXY_MARK);
  if (i <= 0) return undefined;
  return { containerId: handleId.slice(0, i), childPortId: handleId.slice(i + PROXY_MARK.length) };
}

/** The id a displayed edge carries. Derived from the canonical id, so React Flow keys stay stable. */
export const displayedEdgeId = (canonicalId: string): string => `${canonicalId}${DISPLAY_SUFFIX}`;
export const isDisplayedEdgeId = (id: string): boolean => id.endsWith(DISPLAY_SUFFIX);
/** The canonical edge a displayed id stands for. A canonical id comes back unchanged. */
export const canonicalEdgeId = (id: string): string => (isDisplayedEdgeId(id) ? id.slice(0, -DISPLAY_SUFFIX.length) : id);

/** Collapsed = `data.collapsed` on a container, group or subgraph alike. A leaf's own collapse is not this. */
const isCollapsedContainer = (n: ViewNode | undefined): boolean =>
  !!n && isGroupLikeType(n.type) && !!(n.data as { collapsed?: boolean } | undefined)?.collapsed;

const index = (nodes: readonly ViewNode[]): Map<string, ViewNode> => new Map(nodes.map((n) => [n.id, n] as const));

/**
 * The OUTERMOST collapsed container above a node, walking the whole parent chain, or
 * undefined. Outermost, not nearest: a grandchild inside a collapsed Beat re-routes to that
 * Beat, not to a (possibly expanded) intermediate group nobody can see. Cycle-guarded.
 */
function outermostCollapsed(nodeId: string, byId: ReadonlyMap<string, ViewNode>): string | undefined {
  let outer: string | undefined;
  let p = byId.get(nodeId)?.parentId;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    seen.add(p);
    const a = byId.get(p);
    if (!a) break;
    if (isCollapsedContainer(a)) outer = p;
    p = a.parentId;
  }
  return outer;
}

export function collapsedAncestor(nodeId: string, nodes: readonly ViewNode[]): string | undefined {
  return outermostCollapsed(nodeId, index(nodes));
}

/** Every node under a container, at any depth, plus the container itself. */
function familyOf(containerId: string, byId: ReadonlyMap<string, ViewNode>): Set<string> {
  const inside = new Set<string>([containerId]);
  for (const n of byId.values()) {
    let p = n.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      if (p === containerId) {
        inside.add(n.id);
        break;
      }
      seen.add(p);
      p = byId.get(p)?.parentId;
    }
  }
  return inside;
}

/**
 * What a handle on a child is: a real port on a leaf, or a boundary port on a nested
 * subgraph (whose "ports" are its rails). Inner relay handles are never external, so they are
 * not resolved.
 */
function portOn(node: ViewNode | undefined, handleId: string): { type: string; label: string; isInput: boolean } | undefined {
  if (!node) return undefined;
  const data = node.data as { ports?: PortInfo[] } | undefined;
  const real = data?.ports?.find((p) => p.id === handleId);
  if (real) return { type: real.type, label: real.label, isInput: real.isInput };
  if (!isContainerData(node.data)) return undefined;
  const inBp = node.data.promotedIn.find((p) => p.id === handleId);
  if (inBp) return { type: inBp.type, label: inBp.label, isInput: true };
  const outBp = node.data.promotedOut.find((p) => p.id === handleId);
  if (outBp) return { type: outBp.type, label: outBp.label, isInput: false };
  return undefined;
}

/**
 * The proxy handles a collapsed container needs: one per descendant port (any depth) that has
 * a wire to the OUTSIDE. Wires to the container itself — a subgraph's own rails and relays —
 * are not outside; the rails are real handles. One port feeding N externals is one proxy.
 * Order follows the canonical edges, so it is stable across renders.
 */
export function proxyHandlesFor(containerId: string, nodes: readonly ViewNode[], edges: readonly ViewEdge[]): ProxyHandle[] {
  const byId = index(nodes);
  const inside = familyOf(containerId, byId);
  const out: ProxyHandle[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const srcInside = inside.has(e.source);
    const tgtInside = inside.has(e.target);
    if (srcInside === tgtInside) continue;
    const childId = srcInside ? e.source : e.target;
    if (childId === containerId) continue;
    const handle = srcInside ? e.sourceHandle : e.targetHandle;
    if (!handle || seen.has(handle)) continue;
    const port = portOn(byId.get(childId), handle);
    // A port whose direction disagrees with the edge is a malformed edge, not a proxy.
    if (!port || port.isInput === srcInside) continue;
    seen.add(handle);
    out.push({
      id: proxyHandleId(containerId, handle),
      childId,
      childPortId: handle,
      side: srcInside ? "out" : "in",
      type: port.type,
      label: port.label,
    });
  }
  return out;
}

/**
 * The edges React Flow draws for a canonical edge set.
 *
 * For each edge: an end under a collapsed container moves to that container's proxy handle
 * (outermost collapsed ancestor wins); an edge wholly under ONE collapsed container, or one
 * joining a collapsed container to its own hidden descendant (a subgraph's inner relay), is
 * hidden. Every edge this touches gets a derived `@display` id; every edge it does not touch
 * is returned as the SAME object, and when nothing is collapsed the input array itself comes
 * back, so identities stay stable for React Flow.
 */
export function displayedEdges<E extends ViewEdge>(nodes: readonly ViewNode[], edges: E[]): E[] {
  const byId = index(nodes);
  let anyCollapsed = false;
  for (const n of byId.values()) {
    if (isCollapsedContainer(n)) {
      anyCollapsed = true;
      break;
    }
  }
  if (!anyCollapsed) return edges;

  const cache = new Map<string, string | undefined>();
  const outer = (id: string): string | undefined => {
    if (!cache.has(id)) cache.set(id, outermostCollapsed(id, byId));
    return cache.get(id);
  };

  let changed = false;
  const out = edges.map((e) => {
    const sg = outer(e.source);
    const tg = outer(e.target);
    if (!sg && !tg) return e;
    changed = true;
    const id = displayedEdgeId(e.id);
    const internal = (!!sg && sg === tg) || (!!sg && sg === e.target) || (!!tg && tg === e.source);
    // An end with no handle cannot be proxied: there is no port for the proxy to stand in for.
    if (internal || (sg && !e.sourceHandle) || (tg && !e.targetHandle)) return { ...e, id, hidden: true };
    return {
      ...e,
      id,
      hidden: false,
      ...(sg && e.sourceHandle ? { source: sg, sourceHandle: proxyHandleId(sg, e.sourceHandle) } : {}),
      ...(tg && e.targetHandle ? { target: tg, targetHandle: proxyHandleId(tg, e.targetHandle) } : {}),
    };
  });
  return changed ? out : edges;
}

/**
 * React Flow names DISPLAYED edges in the changes it emits (a click selects `x@display`, the
 * Delete key removes it); state holds canonical ones. Map the ids back before applying. A
 * `replace` carrying a displayed edge is dropped rather than mapped: applying it would write a
 * proxy edge into state, which is the one thing this module exists to prevent.
 */
export function canonicalEdgeChanges<E extends Edge>(changes: EdgeChange<E>[]): EdgeChange<E>[] {
  const out: EdgeChange<E>[] = [];
  for (const c of changes) {
    if (c.type === "add") out.push(c);
    else if (c.type === "replace") {
      if (!isDisplayedEdgeId(c.item.id)) out.push({ ...c, id: canonicalEdgeId(c.id) });
    } else out.push({ ...c, id: canonicalEdgeId(c.id) });
  }
  return out;
}

/** Everything the projection reads from the nodes, as one string: id, parent, type, collapsed. */
const collapseKey = (nodes: readonly ViewNode[]): string =>
  nodes.map((n) => `${n.id}|${n.parentId ?? ""}|${n.type ?? ""}|${isCollapsedContainer(n) ? 1 : 0}`).join("\n");

/**
 * The displayed edges for `<ReactFlow edges>`, memoised on the collapse SHAPE of the graph
 * rather than on the nodes array: positions change on every drag frame, and re-deriving the
 * projection then would hand React Flow a fresh edge object per frame for every re-routed wire.
 */
export function useDisplayedGraph<N extends Node, E extends Edge>(nodes: N[], edges: E[]): E[] {
  const shape = useMemo(() => collapseKey(nodes), [nodes]);
  // `shape` stands in for `nodes` on purpose: every field the projection reads is in it, so a
  // nodes array with the same shape yields the same edges.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => displayedEdges(nodes, edges), [shape, edges]);
}
