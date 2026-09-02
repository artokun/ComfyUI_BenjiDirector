// Reroute dots — the pure graph ops behind the dot you drop on a wire.
//
// A reroute is a pass-through: one typed input, one typed output, the same type, drawn as a
// point rather than a card. Splicing one in replaces ONE edge with two; removing one merges
// them back into the direct wire. Both directions are pure functions over (nodes, edges), so
// `settle` stays the only thing that mutates editor state and the algebra can be tested
// without React — the same split graph-core uses for promote/dissolve.
//
// EDGE IDS ARE DERIVED, NOT MINTED
// -------------------------------
// `lg:<sourceHandle>-><targetHandle>`, the convention the rest of the editor already writes.
// That is what makes splice → remove → splice reproduce the very same ids instead of growing
// a `__spliced__merged__spliced` tail, exactly as dissolveSubgraph derives its merged ids from
// the endpoints rather than suffixing the outer half.
//
// THE RAIL LABEL IS DECIDED HERE
// ------------------------------
// A reroute's ports would otherwise be called IN and OUT, and a dot dragged into a promoted
// Beat would put a rail called "IN" on its boundary — true and useless. So the splice names
// both ports after the port the wire was heading for ("IN FRAME"), uniquified against the rail
// it is about to land on. `reconcileBoundary` then produces a rail that says what the wire
// carries, and a later rename still wins, because reconcile restores labels by id.

import {
  containmentFor,
  isContainerData,
  uniquifyLabel,
  type GraphEdge,
  type GraphNode,
  type PortInfo,
} from "@benjidirector/graph-core";
import { makeNode, type DirectorData, type DirectorPortType, type RerouteData } from "./model.js";

/** The dot's box in flow units. Small enough to read as a point ON the wire, not as a node. */
export const REROUTE_SIZE = 14;

type N = GraphNode<DirectorData>;

/** True for a reroute node, for the ops in this file. */
export const isRerouteNode = (n: N | undefined): boolean => n?.data.kind === "reroute";

/** Is this container collapsed, or nested inside one that is? */
function isUnderCollapsed(node: N, nodes: readonly N[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  let cur: N | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (isContainerData(cur.data) && cur.data.collapsed) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

const wireId = (sourceHandle: string, targetHandle: string) => `lg:${sourceHandle}->${targetHandle}`;

const portsOf = (n: N): readonly PortInfo[] => ("ports" in n.data ? n.data.ports : []);

/**
 * What a handle is CALLED, whether it is a real port or a Beat's boundary rail. Used only to
 * name the dot after the wire it sits on, so an unknown handle is not an error.
 */
function labelOfHandle(nodes: readonly N[], handleId: string): string | undefined {
  for (const n of nodes) {
    const p = portsOf(n).find((q) => q.id === handleId);
    if (p) return p.label;
    if (isContainerData(n.data)) {
      const bp = [...n.data.promotedIn, ...n.data.promotedOut].find((b) => b.id === handleId || handleId.startsWith(`${b.id}__`));
      if (bp) return bp.label;
    }
  }
  return undefined;
}

export interface SpliceResult {
  nodes: N[];
  edges: GraphEdge[];
  /** The dot's id — what the drive command returns. */
  id: string;
  type: DirectorPortType;
}

/** Why a wire cannot take a dot. Returned rather than thrown, so the caller can set a note. */
export interface SpliceRefusal {
  error: string;
}

export const isRefusal = (r: SpliceResult | SpliceRefusal): r is SpliceRefusal => "error" in r;

/**
 * Splice a reroute onto `targetEdgeId`, centred on the flow point given.
 *
 * The dot carries the wire's own type, so the two halves are the same wire with a bend in it
 * and `isValidConnection` would accept both. The prospective parent is resolved with
 * graph-core's own `containmentFor` — the same function `settle` re-runs a moment later — so a
 * dot dropped inside a Beat is already in it when the boundary is reconciled, and the rail
 * label it earns is uniquified against the rails already there.
 */
export function spliceReroute(
  nodes: readonly N[],
  edges: readonly GraphEdge[],
  targetEdgeId: string,
  at: { x: number; y: number },
  types: ReadonlyMap<string, DirectorPortType>,
): SpliceResult | SpliceRefusal {
  const wire = edges.find((e) => e.id === targetEdgeId);
  if (!wire) return { error: `no wire "${targetEdgeId}" — read the outline for edge ids` };
  const { sourceHandle, targetHandle } = wire;
  if (!sourceHandle || !targetHandle) return { error: "that wire has no handles to reroute between" };
  const type = types.get(sourceHandle) ?? types.get(targetHandle);
  if (!type) return { error: "that wire carries no known type — nothing for a reroute to pass through" };

  const base = makeNode("reroute", { x: at.x - REROUTE_SIZE / 2, y: at.y - REROUTE_SIZE / 2 }, undefined, { portType: type });
  const data = base.data as RerouteData;

  // Where the dot will land, decided by the same containment maths settle uses. Only the
  // parent matters here; settle re-runs it and gets the node back unchanged.
  const sized: N = { ...base, width: REROUTE_SIZE, height: REROUTE_SIZE };
  const placed = containmentFor(sized, [...nodes, sized]);
  const parent = placed.parentId ? nodes.find((n) => n.id === placed.parentId) : undefined;
  // A dot inside a COLLAPSED Beat is a dot nobody can see or reach: settle pins it to that
  // parent and the collapsed card hides every descendant, taking both halves of the wire with
  // it. Refusing is the only outcome that leaves the user somewhere they can act.
  if (parent && isUnderCollapsed(parent, nodes)) {
    return { error: `expand ${parent.data.label} first — a reroute dropped on a collapsed Beat would be hidden inside it` };
  }
  // Both rails, not just the inbound one: a dot whose OUTPUT crosses the boundary earns a
  // promotedOut rail, and uniquifying it against promotedIn alone would let it collide there.
  const rails = parent && isContainerData(parent.data) ? [...parent.data.promotedIn, ...parent.data.promotedOut] : [];
  const label = uniquifyLabel(labelOfHandle(nodes, targetHandle) ?? "IN", new Set(rails.map((p) => p.label)));

  const node: N = { ...placed, data: { ...data, label, ports: data.ports.map((p) => ({ ...p, label })) } };
  const ports = portsOf(node);
  const inPort = ports.find((p) => p.isInput);
  const outPort = ports.find((p) => !p.isInput);
  if (!inPort || !outPort) return { error: "a reroute needs one input and one output" };

  const head: GraphEdge = {
    ...wire,
    id: wireId(sourceHandle, inPort.id),
    source: wire.source,
    sourceHandle,
    target: node.id,
    targetHandle: inPort.id,
  };
  const tail: GraphEdge = {
    ...wire,
    id: wireId(outPort.id, targetHandle),
    source: node.id,
    sourceHandle: outPort.id,
    target: wire.target,
    targetHandle,
  };

  return {
    nodes: [...nodes, node],
    edges: [...edges.filter((e) => e.id !== targetEdgeId), head, tail],
    id: node.id,
    type,
  };
}

/**
 * The edges left once a reroute is removed: the wire it sat on, rejoined.
 *
 * One feed, N drains — a source handle broadcasts, so a dot whose output fans out to three
 * inputs rebuilds as three direct wires from the original source, the same shape
 * `dissolveSubgraph` reconstructs for a promoted output. A dot with nothing feeding it has no
 * wire to rebuild, so its drains simply go.
 */
export function rejoinReroute(nodes: readonly N[], edges: readonly GraphEdge[], id: string): GraphEdge[] {
  const node = nodes.find((n) => n.id === id);
  // Only a dot rejoins. Anything else is a real node whose wires are its own, and quietly
  // eating them because a caller passed the wrong id is the worse failure by far.
  if (!node || !isRerouteNode(node)) return [...edges];
  const ports = portsOf(node);
  const inId = ports.find((p) => p.isInput)?.id;
  const outId = ports.find((p) => !p.isInput)?.id;
  const kept = edges.filter((e) => e.source !== id && e.target !== id);
  const feed = edges.find((e) => e.target === id && e.targetHandle === inId);
  const feedHandle = feed?.sourceHandle;
  if (!feed || !feedHandle) return kept;

  const merged: GraphEdge[] = [];
  for (const drain of edges) {
    if (drain.source !== id || drain.sourceHandle !== outId || !drain.targetHandle) continue;
    merged.push({ ...drain, id: wireId(feedHandle, drain.targetHandle), source: feed.source, sourceHandle: feedHandle });
  }
  // An input socket takes one cable, so a rebuilt wire displaces anything already on the socket
  // it lands in — it is the wire that was there before the dot.
  const ids = new Set(merged.map((m) => m.id));
  const sockets = new Set(merged.map((m) => `${m.target}|${m.targetHandle}`));
  return [...kept.filter((k) => !ids.has(k.id) && !sockets.has(`${k.target}|${k.targetHandle}`)), ...merged];
}
