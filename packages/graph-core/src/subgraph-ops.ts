// Promote / dissolve / reconcile — the boundary-port algebra.
//
// Ported from ifr-node-lab `src/flow/subgraph-ops.ts`. Pure functions: no React, no store
// access, no mutation of the arrays handed in. Every op takes (containerId, nodes, edges)
// and returns fresh arrays the caller drops into setNodes/setEdges.
//
// WHAT CHANGED IN THE PORT
// ------------------------
// The original operated on engine class instances — `Group`, `Subgraph extends Group`,
// `BenchNode` carrying live `inputs`/`outputs`. Promotion was a class swap at the same node
// id. Here there are no classes: a container is a group when `type === GROUP_TYPE` and a
// subgraph when `type === SUBGRAPH_TYPE`, and promote/dissolve swaps that string in place at
// the same id. The reason is identical to the reason the original swapped classes in place —
// every index keyed by node id stays valid across the conversion.
//
// A node's ports came from the engine instance; here the host answers `portsOf`, because our
// nodes are projections of Calliope rows and do not carry their own ports. Edge colouring was
// `PORT_COLOR[type]`; here it is the host's optional `edgeStyle`.
//
// THE IDEA EVERYTHING RESTS ON
// ----------------------------
// Boundary port ids are DERIVED — `${containerId}::${childPortId}` — never minted. So
// dissolving and immediately re-promoting reproduces the exact same id for every port whose
// crossing still exists. That is what makes `reconcileBoundary` idempotent, and it is why it
// can be implemented as dissolve→re-promote rather than as a diff: user labels, rail order
// and pinned ports are restored by id afterwards, and anything that genuinely vanished simply
// does not come back.
//
// TWO-EDGE MODEL
// --------------
// Every boundary port becomes two edges: an OUTER one between the container and the outside
// world, and an INNER one between the container and the child. The asymmetry matters —
// exactly ONE inner edge per boundary port, because an input socket takes one cable, while
// the outer side of a promoted output may fan out to N externals, because source handles
// broadcast.
//
// NESTING
// -------
// `childIds` is direct-children-only, and that is correct rather than a simplification: an
// edge crossing an outer boundary has already crossed the inner one first, so by the time the
// outer container is processed the only edges left to rewrite are between its immediate child
// layer and the outside.

import {
  boundaryTargets,
  type BoundaryTarget,
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  boundaryPortId,
  innerHandleId,
  isContainerData,
  isRelayHandle,
  outerHandleId,
  type BaseNodeData,
  type BoundaryPort,
  type ContainerNodeData,
  type GraphEdge,
  type GraphNode,
  type GraphOpsHost,
  type PortInfo,
  type PortResolver,
} from "./types.js";

type AnyNode<D extends BaseNodeData> = GraphNode<D>;

export interface OpResult<D extends BaseNodeData> {
  nodes: AnyNode<D>[];
  edges: GraphEdge[];
}

/** Read a node's rails, or undefined when it is not a container. */
function railsOf<D extends BaseNodeData>(n: AnyNode<D> | undefined): ContainerNodeData | undefined {
  return n && isContainerData(n.data) ? (n.data as unknown as ContainerNodeData) : undefined;
}

const isSubgraph = <D extends BaseNodeData>(n: AnyNode<D> | undefined): boolean =>
  !!n && n.type === SUBGRAPH_TYPE;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Handle resolution
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface PortLookup {
  port: PortInfo | undefined;
  type: string;
  isInput: boolean;
  /** True for an inner relay handle. Callers must skip engine writes for these: the matching
   *  OUTER edge already owns the real link, and counting both double-wires the graph. */
  isRelay: boolean;
}

/**
 * Resolve a handle id to its port.
 *
 * Real ports come from the resolver. If the handle is not one, it is a boundary handle: walk
 * the subgraphs looking for a promoted port whose id matches (with `__inner` stripped for an
 * inner handle) and report the RF-side semantics, which invert between the two sides.
 */
export function findPort<D extends BaseNodeData>(
  handleId: string | null | undefined,
  nodes: readonly AnyNode<D>[],
  resolver: PortResolver,
): PortLookup | undefined {
  if (!handleId) return undefined;
  const real = resolver.get(handleId);
  if (real) return { port: real, type: real.type, isInput: real.isInput, isRelay: false };

  const inner = isRelayHandle(handleId);
  const outerId = outerHandleId(handleId);
  for (const n of nodes) {
    if (!isSubgraph(n)) continue;
    const rails = railsOf(n);
    if (!rails) continue;

    const inBp = rails.promotedIn.find((p) => p.id === outerId);
    if (inBp) {
      // promotedIn: the outer side is a target (an input), the inner side is a source.
      return { port: resolver.get(inBp.childPortId), type: inBp.type, isInput: !inner, isRelay: inner };
    }
    const outBp = rails.promotedOut.find((p) => p.id === outerId);
    if (outBp) {
      // promotedOut: the outer side is a source, the inner side is a target.
      return { port: resolver.get(outBp.childPortId), type: outBp.type, isInput: inner, isRelay: inner };
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Label hygiene
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Strip a trailing `.N` to find a label's base. */
const baseOf = (label: string): string => {
  const m = /^(.*)\.\d+$/.exec(label);
  return m && m[1] !== undefined ? m[1] : label;
};

/**
 * Number duplicate labels within ONE rail: two ports sharing a base both become `base.0` and
 * `base.1`, while a base occurring once is left alone.
 *
 * Grouping by BASE rather than by the literal label is deliberate — it makes three ports
 * called `VALUE.0` renumber to `.0/.1/.2` instead of stacking into `VALUE.0.0`. Inputs and
 * outputs are separate rails, so an input `A` and an output `A` never collide.
 *
 * Mutates the array it is given; it is only ever called on freshly built rails.
 */
function dedupeRailLabels(ports: BoundaryPort[]): void {
  const counts = new Map<string, number>();
  for (const p of ports) counts.set(baseOf(p.label), (counts.get(baseOf(p.label)) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const p of ports) {
    const base = baseOf(p.label);
    if ((counts.get(base) ?? 0) > 1) {
      const i = seen.get(base) ?? 0;
      seen.set(base, i + 1);
      p.label = `${base}.${i}`;
    }
  }
}

/** Make `desired` unique against `taken`, returning the smallest free `base.N`. Rename flow. */
export function uniquifyLabel(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  const base = baseOf(desired);
  let n = 0;
  while (taken.has(`${base}.${n}`)) n += 1;
  return `${base}.${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Promote
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a handle on a child, which may itself be a container.
 *
 * A nested subgraph's "ports" are its promoted rails, not real ports — which is exactly why
 * this indirection exists rather than calling `host.portsOf` directly.
 */
function resolveChildHandle<D extends BaseNodeData>(
  child: AnyNode<D>,
  handleId: string,
  side: "in" | "out",
  host: GraphOpsHost,
): { type: string; label: string } | undefined {
  if (isSubgraph(child)) {
    const rails = railsOf(child);
    const list = side === "in" ? rails?.promotedIn : rails?.promotedOut;
    const bp = list?.find((p) => p.id === handleId);
    return bp ? { type: bp.type, label: bp.label } : undefined;
  }
  const p = host.portsOf(child as unknown as GraphNode<never>, side).find((q) => q.id === handleId);
  return p ? { type: p.type, label: p.label } : undefined;
}

/**
 * Promote a group to a subgraph in place.
 *
 * Scans edges crossing the boundary, creates one boundary port per unique crossing child
 * port, and rewrites each crossing edge into an outer half plus an inner relay. Edges wholly
 * inside, wholly outside, or unrelated pass through untouched and keep their order.
 *
 * Throws when the target is missing, is not a container, or is already a subgraph — all three
 * are caller bugs rather than states to paper over.
 */
export function promoteToSubgraph<D extends BaseNodeData>(
  containerId: string,
  nodes: readonly AnyNode<D>[],
  edges: readonly GraphEdge[],
  host: GraphOpsHost,
): OpResult<D> {
  const target = nodes.find((n) => n.id === containerId);
  if (!target) throw new Error(`promoteToSubgraph: no node ${containerId}`);
  if (isSubgraph(target)) throw new Error(`promoteToSubgraph: ${containerId} is already a subgraph`);
  if (target.type !== GROUP_TYPE) throw new Error(`promoteToSubgraph: ${containerId} is not a group`);

  const childIds = new Set(nodes.filter((n) => n.parentId === containerId).map((n) => n.id));

  // Outbound crossings are keyed by `${childId}::${childPortId}`: one child port feeding N
  // externals is ONE boundary port with N outer halves.
  //
  // Inbound crossings are keyed by the EXTERNAL SOURCE: one external port feeding N children
  // is one thing entering the container — one rail entry — and the split happens inside as N
  // relays. Nadia's REF wired to two scenes is one CHARACTER rail, not CHARACTER.0 and .1.
  const outByKey = new Map<string, BoundaryPort>();
  const inBySource = new Map<string, Array<BoundaryTarget & { type: string; label: string }>>();

  for (const e of edges) {
    // An edge with no handles, or referencing a handle neither endpoint has, cannot be safely
    // re-routed. Skipping beats throwing: that state comes from a partial import or a
    // transient editor moment, and dropping one crossing from the re-route is a far smaller
    // problem than aborting the whole conversion.
    if (!e.sourceHandle || !e.targetHandle) continue;
    const srcInside = childIds.has(e.source);
    const tgtInside = childIds.has(e.target);
    if (srcInside === tgtInside) continue;

    if (srcInside) {
      const child = nodes.find((n) => n.id === e.source);
      const port = child && resolveChildHandle(child, e.sourceHandle, "out", host);
      if (!port) continue;
      const key = `${e.source}::${e.sourceHandle}`;
      if (!outByKey.has(key)) {
        outByKey.set(key, {
          id: boundaryPortId(containerId, e.sourceHandle),
          childId: e.source,
          childPortId: e.sourceHandle,
          type: port.type,
          label: port.label,
        });
      }
    } else {
      const child = nodes.find((n) => n.id === e.target);
      const port = child && resolveChildHandle(child, e.targetHandle, "in", host);
      if (!port) continue;
      const key = `${e.source}|${e.sourceHandle}`;
      const members = inBySource.get(key) ?? [];
      if (!members.some((m) => m.childId === e.target && m.childPortId === e.targetHandle)) {
        members.push({ childId: e.target, childPortId: e.targetHandle, type: port.type, label: port.label });
      }
      inBySource.set(key, members);
    }
  }

  // The primary target — the one the id derives from — is the lexically smallest child port
  // id, so it does not depend on the order the edges happened to be scanned in.
  const promotedIn: BoundaryPort[] = [...inBySource.values()].map((members) => {
    const sorted = [...members].sort((a, b) => a.childPortId.localeCompare(b.childPortId));
    const primary = sorted[0] as (typeof sorted)[number];
    const rest = sorted.slice(1).map(({ childId, childPortId }) => ({ childId, childPortId }));
    return {
      id: boundaryPortId(containerId, primary.childPortId),
      childId: primary.childId,
      childPortId: primary.childPortId,
      type: primary.type,
      label: primary.label,
      ...(rest.length ? { fanout: rest } : {}),
    };
  });
  const promotedOut = [...outByKey.values()];
  dedupeRailLabels(promotedIn);
  dedupeRailLabels(promotedOut);

  const prior = railsOf(target);
  const newNodes: AnyNode<D>[] = nodes.map((n) =>
    n.id === containerId
      ? ({
          ...n,
          type: SUBGRAPH_TYPE,
          data: { ...n.data, ...prior, promotedIn, promotedOut },
        } as AnyNode<D>)
      : n,
  );

  const inIdByKey = new Map<string, string>();
  for (const bp of promotedIn) for (const t of boundaryTargets(bp)) inIdByKey.set(`${t.childId}::${t.childPortId}`, bp.id);
  const outIdByKey = new Map(promotedOut.map((bp) => [`${bp.childId}::${bp.childPortId}`, bp.id]));
  // One outer half per (external source → boundary port): the second child a source feeds
  // adds a relay inside, not another wire outside.
  const outerSeen = new Set<string>();

  // Pass A — outer halves, plus every untouched edge, in original order.
  const newEdges: GraphEdge[] = [];
  for (const e of edges) {
    if (!e.sourceHandle || !e.targetHandle) {
      newEdges.push(e);
      continue;
    }
    const srcInside = childIds.has(e.source);
    const tgtInside = childIds.has(e.target);
    if (srcInside === tgtInside) {
      newEdges.push(e);
      continue;
    }
    if (srcInside) {
      const bpId = outIdByKey.get(`${e.source}::${e.sourceHandle}`);
      if (!bpId) {
        newEdges.push(e);
        continue;
      }
      newEdges.push({ ...e, id: `${e.id}__outer`, source: containerId, sourceHandle: bpId });
    } else {
      const bpId = inIdByKey.get(`${e.target}::${e.targetHandle}`);
      if (!bpId) {
        newEdges.push(e);
        continue;
      }
      const seenKey = `${e.source}|${e.sourceHandle}|${bpId}`;
      if (outerSeen.has(seenKey)) continue;
      outerSeen.add(seenKey);
      newEdges.push({ ...e, id: `${e.id}__outer`, target: containerId, targetHandle: bpId });
    }
  }

  // Pass B — the inner relays: one per boundary port, plus one per fan-out target. Edge ids
  // derive from the boundary port id (and the extra target), so they are stable across
  // re-conversion.
  for (const bp of promotedIn) newEdges.push(...innerEdgesFor(containerId, bp, "in", host));
  for (const bp of promotedOut) newEdges.push(...innerEdgesFor(containerId, bp, "out", host));

  return { nodes: newNodes, edges: newEdges };
}

function innerEdgesFor(
  containerId: string,
  bp: BoundaryPort,
  side: "in" | "out",
  host: GraphOpsHost,
): GraphEdge[] {
  const style = host.edgeStyle?.(bp.type);
  const relay = (t: BoundaryTarget, primary: boolean): GraphEdge => {
    const id = primary ? `${bp.id}__inneredge` : `${bp.id}__inneredge->${t.childId}::${t.childPortId}`;
    const base =
      side === "in"
        ? { id, source: containerId, target: t.childId, sourceHandle: innerHandleId(bp.id), targetHandle: t.childPortId }
        : { id, source: t.childId, target: containerId, sourceHandle: t.childPortId, targetHandle: innerHandleId(bp.id) };
    return style ? { ...base, style } : base;
  };
  // Fan-out is an input-side notion; an output port drains exactly one inner port.
  const targets = side === "in" ? boundaryTargets(bp) : [{ childId: bp.childId, childPortId: bp.childPortId }];
  return targets.map((t, i) => relay(t, i === 0));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Dissolve
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Dissolve a subgraph back to a plain group, merging each outer+inner pair back into one
 * direct edge and dropping the promoted contract and blueprint linkage.
 *
 * One inner may pair with MANY outers — a promoted output feeding N externals rebuilds as N
 * direct edges — and one outer may pair with MANY inners: a promoted input fanning out to N
 * children rebuilds as N direct edges from the same external port.
 */
export function dissolveSubgraph<D extends BaseNodeData>(
  containerId: string,
  nodes: readonly AnyNode<D>[],
  edges: readonly GraphEdge[],
): OpResult<D> {
  const target = nodes.find((n) => n.id === containerId);
  if (!target) throw new Error(`dissolveSubgraph: no node ${containerId}`);
  if (!isSubgraph(target)) throw new Error(`dissolveSubgraph: ${containerId} is not a subgraph`);
  const rails = railsOf(target);
  if (!rails) throw new Error(`dissolveSubgraph: ${containerId} carries no rails`);

  const bpById = new Map<string, BoundaryPort>();
  for (const bp of rails.promotedIn) bpById.set(bp.id, bp);
  for (const bp of rails.promotedOut) bpById.set(bp.id, bp);

  const isOuter = (h?: string | null): h is string => !!h && bpById.has(h);
  const isInner = (h?: string | null): h is string =>
    !!h && isRelayHandle(h) && bpById.has(outerHandleId(h));

  const outerHalves: GraphEdge[] = [];
  const innerHalves: GraphEdge[] = [];
  const untouched: GraphEdge[] = [];

  for (const e of edges) {
    if (e.source !== containerId && e.target !== containerId) {
      untouched.push(e);
      continue;
    }
    if (e.source === containerId && isOuter(e.sourceHandle)) outerHalves.push(e);
    else if (e.target === containerId && isOuter(e.targetHandle)) outerHalves.push(e);
    else if (e.source === containerId && isInner(e.sourceHandle)) innerHalves.push(e);
    else if (e.target === containerId && isInner(e.targetHandle)) innerHalves.push(e);
    // Touches the container on a handle we do not recognise — pass it through rather than
    // silently eating someone else's wiring.
    else untouched.push(e);
  }

  const innersByBp = new Map<string, GraphEdge[]>();
  for (const e of innerHalves) {
    const handle = e.source === containerId ? e.sourceHandle : e.targetHandle;
    if (!handle) continue;
    const key = outerHandleId(handle);
    innersByBp.set(key, [...(innersByBp.get(key) ?? []), e]);
  }

  const merged: GraphEdge[] = [];
  for (const outer of outerHalves) {
    const onSource = outer.source === containerId;
    const bpId = onSource ? outer.sourceHandle : outer.targetHandle;
    if (!bpId) continue;
    const inners = innersByBp.get(bpId) ?? [];
    // An outer with no inner is an orphaned half: the boundary port has nothing to relay
    // through, so there is no direct edge to reconstruct.
    for (const inner of inners) {
      if (onSource) {
        // child → container (inner) → external (outer)  ⇒  child → external.
        // The id is derived from the ENDPOINTS, not `${outer.id}__merged`. reconcileBoundary
        // dissolves and re-promotes on every parent change, and a suffix-based id would chain
        // into `…__merged__outer__merged…` a few reconciles in.
        merged.push({
          ...outer,
          id: `lg:${inner.sourceHandle}->${outer.targetHandle}`,
          source: inner.source,
          sourceHandle: inner.sourceHandle,
        });
      } else {
        // external → container (outer) → child (inner)  ⇒  external → child.
        merged.push({
          ...outer,
          id: `lg:${outer.sourceHandle}->${inner.targetHandle}`,
          target: inner.target,
          targetHandle: inner.targetHandle,
        });
      }
    }
  }

  const newNodes: AnyNode<D>[] = nodes.map((n) =>
    n.id === containerId
      ? ({
          ...n,
          type: GROUP_TYPE,
          data: {
            ...n.data,
            promotedIn: [],
            promotedOut: [],
            blueprintId: undefined,
            blueprintVersion: undefined,
          },
        } as AnyNode<D>)
      : n,
  );

  return { nodes: newNodes, edges: [...untouched, ...merged] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Reconcile
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Re-derive a subgraph's boundary from its CURRENT membership and wiring.
 *
 * Run it whenever a node enters or leaves (drag, resize-engulf, a tool call) or a wire is
 * added or removed across the boundary. Implementation is dissolve → re-promote, which works
 * only because boundary ids are derived: a crossing that still exists gets the same id back,
 * so labels, pinned flags and rail order can simply be restored by id afterwards, while
 * crossings that vanished do not reappear and new ones arrive fresh.
 *
 * A no-op (returns the inputs) when the target is not a subgraph.
 */
export function reconcileBoundary<D extends BaseNodeData>(
  containerId: string,
  nodes: readonly AnyNode<D>[],
  edges: readonly GraphEdge[],
  host: GraphOpsHost,
): OpResult<D> {
  const target = nodes.find((n) => n.id === containerId);
  const rails = railsOf(target);
  if (!target || !isSubgraph(target) || !rails) return { nodes: [...nodes], edges: [...edges] };

  const oldLabels = new Map<string, string>();
  // A merged (fan-in) port's id follows its primary target; when that child's wire goes and
  // another member becomes primary, the id changes but the rail is the same rail. So every
  // old port is also findable by any of its targets, and a fresh port with no match by id
  // falls back to that — the label, the order and the pin follow the rail, not the id.
  const oldByTarget = new Map<string, BoundaryPort>();
  for (const bp of [...rails.promotedIn, ...rails.promotedOut]) {
    oldLabels.set(bp.id, bp.label);
    for (const t of boundaryTargets(bp)) oldByTarget.set(`${t.childId}::${t.childPortId}`, bp);
  }
  const priorOf = (bp: BoundaryPort): BoundaryPort | undefined => {
    if (oldLabels.has(bp.id)) return undefined;
    for (const t of boundaryTargets(bp)) {
      const old = oldByTarget.get(`${t.childId}::${t.childPortId}`);
      if (old) return old;
    }
    return undefined;
  };
  const oldOrderIn = rails.promotedIn.map((p) => p.id);
  const oldOrderOut = rails.promotedOut.map((p) => p.id);
  const { blueprintId, blueprintVersion } = rails;

  // Pinned ports exist without a crossing, and crossing-scan is the only thing re-promote
  // does — so they have to be captured and re-injected. `forcedKeys` keeps the flag sticky
  // once a pinned port also gains a real wire, so removing that wire later does not prune it.
  const forced = [
    ...rails.promotedIn.filter((p) => p.forced).map((p) => ({ side: "in" as const, p: { ...p } })),
    ...rails.promotedOut.filter((p) => p.forced).map((p) => ({ side: "out" as const, p: { ...p } })),
  ];
  const forcedKeys = new Set(forced.flatMap(({ p }) => boundaryTargets(p).map((t) => `${t.childId}::${t.childPortId}`)));

  const dissolved = dissolveSubgraph(containerId, nodes, edges);
  const repromoted = promoteToSubgraph(containerId, dissolved.nodes, dissolved.edges, host);

  const fresh = repromoted.nodes.find((n) => n.id === containerId);
  const freshRails = railsOf(fresh);
  if (!fresh || !freshRails) return repromoted;

  const promotedIn = [...freshRails.promotedIn];
  const promotedOut = [...freshRails.promotedOut];
  /** fresh id → the id to rank/label by: its own when known, else the rail it continues. */
  const alias = new Map<string, string>();
  for (const bp of [...promotedIn, ...promotedOut]) {
    const prior = priorOf(bp);
    const old = oldLabels.get(bp.id) ?? prior?.label;
    if (old !== undefined) bp.label = old;
    alias.set(bp.id, prior?.id ?? bp.id);
    if (boundaryTargets(bp).some((t) => forcedKeys.has(`${t.childId}::${t.childPortId}`))) bp.forced = true;
  }

  // Re-inject pinned ports the crossing scan did not reproduce, rebuilding the inner relay
  // that dissolve dropped (a pin with no outer half has nothing to merge with).
  //
  // A pin only survives while its child is still INSIDE — not merely still existing. Dragging
  // the child out or deleting it must drop the port, or the boundary keeps pointing at a node
  // that is no longer within it, which is the stale-contract corruption from another angle.
  const byId = new Map(repromoted.nodes.map((n) => [n.id, n] as const));
  const insideContainer = (id: string): boolean => {
    let pid = byId.get(id)?.parentId;
    const seen = new Set<string>();
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      if (pid === containerId) return true;
      pid = byId.get(pid)?.parentId;
    }
    return false;
  };

  const extraEdges: GraphEdge[] = [];
  for (const { side, p } of forced) {
    const list = side === "in" ? promotedIn : promotedOut;
    if (!insideContainer(p.childId)) continue;
    // The pin protects the RAIL, not each membership: if any target of the pinned port is
    // still fed through a fresh port, that port IS the rail (label and pin carried over
    // above) and the member whose wire went is simply no longer in it. Re-injecting here
    // would feed the survivors twice.
    const pinned = new Set(boundaryTargets(p).map((t) => `${t.childId}::${t.childPortId}`));
    if (list.some((q) => boundaryTargets(q).some((t) => pinned.has(`${t.childId}::${t.childPortId}`)))) continue;
    list.push({ ...p });
    extraEdges.push(...innerEdgesFor(containerId, p, side, host));
  }

  // Restore rail order: surviving ports keep their prior relative positions, and anything new
  // sorts to the BOTTOM rather than wherever the edge scan happened to encounter it.
  const orderBy = (oldOrder: readonly string[]) => (a: BoundaryPort, b: BoundaryPort) => {
    const rank = (id: string) => {
      const i = oldOrder.indexOf(alias.get(id) ?? id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return rank(a.id) - rank(b.id);
  };
  promotedIn.sort(orderBy(oldOrderIn));
  promotedOut.sort(orderBy(oldOrderOut));

  // Restoring labels can re-introduce a collision, and re-injected pins bypassed the
  // promote-time pass, so dedupe once more. Ids stay unique regardless — they are derived.
  dedupeRailLabels(promotedIn);
  dedupeRailLabels(promotedOut);

  const newNodes = repromoted.nodes.map((n) =>
    n.id === containerId
      ? ({
          ...n,
          data: { ...n.data, promotedIn, promotedOut, blueprintId, blueprintVersion },
        } as AnyNode<D>)
      : n,
  );

  return { nodes: newNodes, edges: [...repromoted.edges, ...extraEdges] };
}
