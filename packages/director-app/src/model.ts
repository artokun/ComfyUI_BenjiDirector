// The Director's domain layer: what a Scene's ports are, how they colour, and the demo
// project the prototype opens with when Calliope is not reachable.
//
// graph-core knows nothing about any of this — it asks the host `portsOf` and `edgeStyle`
// and does the boundary algebra. Everything film-shaped lives here.

import {
  GROUP_TYPE,
  type BaseNodeData,
  type ContainerNodeData,
  type GraphEdge,
  type GraphNode,
  type GraphOpsHost,
  type PortInfo,
} from "@benjidirector/graph-core";
import type { IconName } from "./icons.js";
import { CONTAINER_Z, nextZ } from "./z-order.js"; // [U1]

/** Port types. Deliberately few — these are the things that actually flow between scenes. */
export type DirectorPortType = "text" | "ref" | "image" | "video";

export const PORT_COLOR: Record<DirectorPortType, string> = {
  text: "#60a5fa",
  ref: "#f59e0b",
  image: "#c084fc",
  video: "#22c55e",
};

/** Container tints. Eight is enough to tell Beats apart at a glance and few enough to pick. */
export const GROUP_PRESET_COLORS = [
  "#c084fc",
  "#60a5fa",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#f87171",
  "#a3e635",
  "#22d3ee",
];

/** A Scene node's payload. Mirrors the fields Calliope actually stores on `scenes`. */
export interface SceneData extends BaseNodeData {
  kind: "scene";
  /**
   * Pinned to the Beat's collapsed face.
   *
   * ifr-node-lab's yellow pin: a collapsed container is not just a box with rails, it is a
   * composed node showing the controls its author chose to surface. Everything else inside
   * stays hidden. This is the flag that decides which.
   */
  promoted?: boolean;
  /** Derived: an ancestor is a SUBGRAPH. Pinning is meaningless anywhere else. */
  inSubgraph?: boolean;
  heading: string;
  action?: string;
  durationSec?: number;
  /**
   * Calliope's cut order (`order_index`), set at load. Continuity in Calliope means "from
   * the scene before this one in the cut", so a LAST FRAME → IN FRAME wire between
   * Calliope scenes is only meaningful between consecutive ones; the editor refuses others.
   */
  orderIndex?: number;
  /** Populated once a render lands. */
  videoPath?: string;
  ports: PortInfo[];
  // ── [U0] shared fields the units fill ──
  /** Muted: rendered at low opacity, skipped by render tools. */
  bypassed?: boolean;
  /** Per-node tint (header stripe). */
  color?: string;
  /** Collapsed to its header; handles converge on the header edges. */
  collapsed?: boolean;
  dialog?: string;
  characterIds?: number[];
  locationId?: number | null;
  workflowId?: number | null;
  /** From the live jobs store: queued | rendering | failed | rendered. */
  renderStatus?: "queued" | "rendering" | "failed" | "rendered" | null;
}

/** An asset node — Character / Location / Item, Calliope's reusable consistency records. */
export interface AssetData extends BaseNodeData {
  kind: "asset";
  promoted?: boolean;
  inSubgraph?: boolean;
  asset: "character" | "location" | "item";
  ports: PortInfo[];
  // ── [U0] ──
  bypassed?: boolean;
  color?: string;
  collapsed?: boolean;
  /** Sheet / reference image path (Calliope), shown as a thumbnail. */
  imagePath?: string | null;
}

/** A markdown sticky note. No ports. */
export interface NoteData extends BaseNodeData {
  kind: "note";
  text: string;
  ports: PortInfo[];
  color?: string;
}

/** A pass-through dot on a wire: one typed input, one typed output, same type. */
export interface RerouteData extends BaseNodeData {
  kind: "reroute";
  portType: DirectorPortType;
  ports: PortInfo[];
}

/** One row on a collapsed Beat's face: a descendant its author pinned. */
export interface PromotedFace {
  id: string;
  kind: "scene" | "asset";
  label: string;
  durationSec?: number;
  videoPath?: string;
  assetKind?: AssetData["asset"];
}

/**
 * [U6] A handle on a COLLAPSED container that stands in for a hidden descendant's port, so a
 * wire crossing the boundary has somewhere to land. `id` is derived —
 * `${containerId}::proxy:${childPortId}` (collapse-view's `proxyHandleId`) — never minted.
 */
export interface ProxyHandle {
  id: string;
  childId: string;
  childPortId: string;
  side: "in" | "out";
  type: string;
  label: string;
}

export interface BeatData extends BaseNodeData, ContainerNodeData {
  kind: "beat";
  /** Derived every settle from pinned descendants — never edited directly. */
  faces?: PromotedFace[];
  /** [U6] Derived every settle while collapsed, from the wires crossing the boundary — never edited directly. */
  proxies?: ProxyHandle[];
  /** The expanded box, remembered while collapsed so expanding restores it. */
  expandedWidth?: number;
  expandedHeight?: number;
  /** The collapsed card's box, remembered while expanded. */
  collapsedWidth?: number;
  collapsedHeight?: number;
}

export type DirectorData = SceneData | AssetData | BeatData | NoteData | RerouteData;
export type DirectorNode = GraphNode<DirectorData>;

export type NodeKind = "scene" | "character" | "location" | "item" | "note" | "reroute";

/** What the palette and the sidebar offer, in order. Reroute is placed from an edge, not here. */
export const PALETTE_KINDS: { kind: NodeKind; label: string; icon: IconName; hint?: string }[] = [
  { kind: "scene", label: "Scene", icon: "clapper" },
  { kind: "character", label: "Character", icon: "user" },
  { kind: "location", label: "Location", icon: "mapPin" },
  { kind: "item", label: "Item", icon: "box" },
  { kind: "note", label: "Note", icon: "note", hint: "markdown" },
];

let idCounter = 0;
/** A fresh id. Counter-suffixed: two nodes minted in the same millisecond must not collide. */
export function mintId(prefix: string): string {
  idCounter = (idCounter + 1) % 46656;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36).padStart(3, "0")}`;
}

const p = (
  nodeId: string,
  side: "in" | "out",
  name: string,
  type: DirectorPortType,
): PortInfo => ({
  id: `${nodeId}:${side}:${name}`,
  type,
  isInput: side === "in",
  label: name,
});

/**
 * A Scene's ports.
 *
 * `IN FRAME` / `LAST FRAME` are the continuity pair — wiring one scene's last frame into the
 * next scene's in-frame is what makes a sequence hold together, and it is precisely the wire
 * that becomes a promoted rail when the scenes end up in different Beats.
 */
export const scenePorts = (id: string): PortInfo[] => [
  p(id, "in", "PROMPT", "text"),
  p(id, "in", "CHARACTER", "ref"),
  p(id, "in", "LOCATION", "ref"),
  p(id, "in", "IN FRAME", "image"),
  p(id, "out", "VIDEO", "video"),
  p(id, "out", "LAST FRAME", "image"),
];

export const assetPorts = (id: string): PortInfo[] => [p(id, "out", "REF", "ref")];
export const reroutePorts = (id: string, type: DirectorPortType): PortInfo[] => [p(id, "in", "IN", type), p(id, "out", "OUT", type)];

/** Rebuild a node's ports for a NEW id — used when a blueprint is instantiated. */
export function reportedPorts(kind: DirectorData["kind"], id: string, portType?: DirectorPortType): PortInfo[] {
  return kind === "scene" ? scenePorts(id) : kind === "asset" ? assetPorts(id) : kind === "reroute" ? reroutePorts(id, portType ?? "image") : [];
}

export const scene = (
  id: string,
  heading: string,
  position: { x: number; y: number },
  extra: Partial<SceneData> = {},
  parentId?: string,
): DirectorNode => ({
  id,
  type: "scene",
  position,
  ...(parentId ? { parentId } : {}),
  data: { kind: "scene", label: heading, heading, durationSec: 5, ports: scenePorts(id), ...extra },
});

export const asset = (
  id: string,
  label: string,
  kind: AssetData["asset"],
  position: { x: number; y: number },
): DirectorNode => ({
  id,
  type: "asset",
  position,
  data: { kind: "asset", label, asset: kind, ports: assetPorts(id) },
});

export const beat = (
  id: string,
  label: string,
  position: { x: number; y: number },
  size = { width: 460, height: 380 },
): DirectorNode => ({
  id,
  type: GROUP_TYPE,
  position,
  // Size lives on the NODE, because that is what React Flow's NodeResizer writes to. The copy
  // in `data` is only a fallback for graph-core's containment maths before anything is
  // measured — rendering from `data` is what made resizing appear to do nothing.
  width: size.width,
  height: size.height,
  zIndex: CONTAINER_Z, // [U1] a container paints below the wires (z-order.ts)
  data: {
    kind: "beat",
    label,
    promotedIn: [],
    promotedOut: [],
    width: size.width,
    height: size.height,
  },
});

/** Make a node of a palette kind at a position. One place, so every entry point agrees. */
export function makeNode(kind: NodeKind, at: { x: number; y: number }, stamp?: string, opts: { portType?: DirectorPortType; label?: string } = {}): DirectorNode {
  const id = stamp ? `${kind === "scene" ? "sc" : kind}-${stamp}` : mintId(kind === "scene" ? "sc" : kind);
  const zIndex = nextZ(); // [U1] a fresh leaf lands on top of the stack (z-order.ts)
  if (kind === "scene") return { ...scene(id, opts.label ?? "New scene", at), zIndex };
  if (kind === "note") {
    return { id, type: "note", position: at, width: 220, height: 120, zIndex, data: { kind: "note", label: opts.label ?? "Note", text: "", ports: [] } };
  }
  if (kind === "reroute") {
    const portType = opts.portType ?? "image";
    return { id, type: "reroute", position: at, zIndex, data: { kind: "reroute", label: "reroute", portType, ports: reroutePorts(id, portType) } };
  }
  const label = opts.label ?? (kind === "character" ? "New character" : kind === "location" ? "New location" : "New item");
  return { ...asset(id, label, kind, at), zIndex };
}

/** What graph-core needs from us, and nothing else. */
export const directorHost: GraphOpsHost = {
  portsOf: (n, side) => {
    const data = (n as unknown as DirectorNode).data as SceneData | AssetData;
    const ports = "ports" in data ? data.ports : [];
    return ports.filter((q) => (side === "in" ? q.isInput : !q.isInput));
  },
  edgeStyle: (type) => ({
    stroke: PORT_COLOR[type as DirectorPortType] ?? "#9ca3af",
    strokeWidth: 2,
  }),
};

const link = (a: string, ah: string, b: string, bh: string): GraphEdge => ({
  id: `lg:${a}:out:${ah}->${b}:in:${bh}`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:${ah}`,
  targetHandle: `${b}:in:${bh}`,
});

/**
 * The demo project.
 *
 * Shaped so the interesting case is one drag away: SC-03 sits OUTSIDE the Beat while being
 * fed by SC-02 inside it, so the Beat already has a real crossing to promote, and dragging
 * SC-03 in makes that rail disappear again.
 */
export function demoProject(): { nodes: DirectorNode[]; edges: GraphEdge[] } {
  const nodes: DirectorNode[] = [
    asset("char-nadia", "Nadia", "character", { x: 40, y: 60 }),
    asset("loc-rooftop", "Rooftop, night", "location", { x: 40, y: 190 }),

    beat("beat-1", "Beat 1 — The approach", { x: 340, y: 40 }),
    scene("sc-01", "SC-01 · Nadia climbs out", { x: 40, y: 60 }, { durationSec: 6 }, "beat-1"),
    scene("sc-02", "SC-02 · She sees the city", { x: 40, y: 220 }, { durationSec: 4 }, "beat-1"),

    scene("sc-03", "SC-03 · The call comes", { x: 900, y: 300 }, { durationSec: 8 }),
  ];

  const edges: GraphEdge[] = [
    link("char-nadia", "REF", "sc-01", "CHARACTER"),
    link("loc-rooftop", "REF", "sc-01", "LOCATION"),
    link("char-nadia", "REF", "sc-02", "CHARACTER"),
    link("sc-01", "LAST FRAME", "sc-02", "IN FRAME"),
    // Crosses the Beat boundary — this is the one that becomes a rail on promote.
    link("sc-02", "LAST FRAME", "sc-03", "IN FRAME"),
  ];

  return { nodes, edges };
}
