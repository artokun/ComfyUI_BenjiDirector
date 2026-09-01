// The domain-free graph model, ported from ifr-node-lab's `src/engine` + `src/flow`.
//
// WHY THESE SHAPES ARE HAND-WRITTEN RATHER THAN IMPORTED FROM REACT FLOW
// ----------------------------------------------------------------------
// The editor renders with @xyflow/react, but `director-tools` runs inside the MCP
// server, where React Flow has no business being installed. So graph-core declares
// the minimum structural shape it needs. React Flow's own `Node`/`Edge` are
// assignable to these, which is the whole trick: the editor passes its real nodes
// straight in, and the server side never sees the dependency.
//
// WHAT WAS STRIPPED IN THE PORT
// -----------------------------
// ifr-node-lab's ops were written against concrete engine classes (`BenchNode`,
// `BenchPort`, `Group`, `Subgraph`) whose instances carried live simulation state.
// Nothing here is a class. Our nodes are projections of Calliope rows, so identity
// lives in the id and the data is plain and serialisable. Port TYPES are likewise
// opaque strings plus a host-supplied compatibility predicate, instead of the fixed
// Power/Number/Signal/Vector enum the Bench contract needed.

/** Opaque port-type identifier. The host decides what these mean and what connects to what. */
export type PortTypeId = string;

/** Container kinds. A subgraph IS a group — see `ContainerNodeData` for why that matters. */
export const GROUP_TYPE = "groupbox";
export const SUBGRAPH_TYPE = "subgraph";
export const GROUP_TYPES: ReadonlySet<string> = new Set([GROUP_TYPE, SUBGRAPH_TYPE]);
export const isGroupLikeType = (t?: string): boolean => !!t && GROUP_TYPES.has(t);

/**
 * A port promoted from an inner child onto a container's boundary rail.
 *
 * `id` is DERIVED, never random: `${containerId}::${childPortId}`. That is the single
 * decision the whole reconcile algorithm rests on. Because the id is a pure function of
 * what it aliases, dissolving a container and immediately re-promoting it reproduces the
 * exact same ids for every port that still exists — which is what makes `reconcileBoundary`
 * idempotent, and what lets user-authored labels and ordering survive a reconcile.
 *
 * `::` is safe as the separator because a childPortId uses single colons
 * (`<nodeId>:<in|out>:<NAME>`), and the container id prefix is itself unique per nesting
 * level, so ids stay unique across nested containers and stable across reload.
 */
export interface BoundaryPort {
  /** `${containerId}::${childPortId}` — derived, stable, never minted randomly. */
  id: string;
  /** The node INSIDE the container that actually owns this port. */
  childId: string;
  /** The inner port this boundary port aliases. */
  childPortId: string;
  type: PortTypeId;
  /** User-editable rail label. Survives reconcile by id. */
  label: string;
  /** User-pinned: kept on the rail even with no wire crossing the boundary. */
  forced?: boolean;
}

/** Minimal port descriptor. The host resolves handles to these. */
export interface PortInfo {
  id: string;
  type: PortTypeId;
  isInput: boolean;
}

/**
 * Resolves a React Flow handle id to a real port.
 *
 * Supplied by the host so graph-core never has to know how ports are stored. In the editor
 * this is backed by the live ports map; in a test it is a plain Map.
 */
export interface PortResolver {
  get(handleId: string): PortInfo | undefined;
}

/** Data carried by every node. Hosts extend this with their own domain payload. */
export interface BaseNodeData {
  label: string;
}

/**
 * Data carried by a container node.
 *
 * A container is a group when both rails are empty and a subgraph when they are not — the
 * distinction is the node `type`, and promote/dissolve swaps that type IN PLACE at the same
 * node id. ifr-node-lab did this as a class swap for the same reason we do it as a type
 * swap: every index keyed by node id stays valid across the conversion, so nothing
 * downstream has to be rebuilt.
 */
export interface ContainerNodeData extends BaseNodeData {
  promotedIn: BoundaryPort[];
  promotedOut: BoundaryPort[];
  collapsed?: boolean;
  color?: string;
  width?: number;
  height?: number;
  blueprintId?: string;
  blueprintVersion?: number;
}

/** Structurally compatible with @xyflow/react's `Node`. */
export interface GraphNode<D = BaseNodeData> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  parentId?: string;
  measured?: { width?: number; height?: number };
  data: D;
}

/** Structurally compatible with @xyflow/react's `Edge`. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export type AnyGraphNode = GraphNode<BaseNodeData | ContainerNodeData>;

/** True when this node's data carries boundary rails. */
export function isContainerData(d: unknown): d is ContainerNodeData {
  return (
    !!d &&
    typeof d === "object" &&
    Array.isArray((d as ContainerNodeData).promotedIn) &&
    Array.isArray((d as ContainerNodeData).promotedOut)
  );
}

/** The one true boundary-port id derivation. Never inline this. */
export const boundaryPortId = (containerId: string, childPortId: string): string =>
  `${containerId}::${childPortId}`;

/**
 * Inner-handle id for a boundary port.
 *
 * Every boundary port becomes TWO edges — an outer one facing the world and an inner one
 * facing the child — and the inner terminates on this synthetic handle. Inner handles are
 * pure visual relays: the OUTER edge of the same boundary port owns the real wiring, so a
 * caller that walks edges to derive links must skip these or it will double-count.
 */
const INNER_SUFFIX = "__inner";
export const innerHandleId = (boundaryId: string): string => `${boundaryId}${INNER_SUFFIX}`;
export const isRelayHandle = (handleId: string | null | undefined): boolean =>
  !!handleId && handleId.endsWith(INNER_SUFFIX);
export const outerHandleId = (handleId: string): string =>
  isRelayHandle(handleId) ? handleId.slice(0, -INNER_SUFFIX.length) : handleId;
