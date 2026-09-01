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
}

/** An asset node — Character / Location / Item, Calliope's reusable consistency records. */
export interface AssetData extends BaseNodeData {
  kind: "asset";
  promoted?: boolean;
  inSubgraph?: boolean;
  asset: "character" | "location" | "item";
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

export interface BeatData extends BaseNodeData, ContainerNodeData {
  kind: "beat";
  /** Derived every settle from pinned descendants — never edited directly. */
  faces?: PromotedFace[];
  /** The expanded box, remembered while collapsed so expanding restores it. */
  expandedWidth?: number;
  expandedHeight?: number;
  /** The collapsed card's box, remembered while expanded. */
  collapsedWidth?: number;
  collapsedHeight?: number;
}

export type DirectorData = SceneData | AssetData | BeatData;
export type DirectorNode = GraphNode<DirectorData>;

export type NodeKind = "scene" | "character" | "location" | "item";

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

/** Rebuild a node's ports for a NEW id — used when a blueprint is instantiated. */
export function reportedPorts(kind: DirectorData["kind"], id: string): PortInfo[] {
  return kind === "scene" ? scenePorts(id) : kind === "asset" ? assetPorts(id) : [];
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
export function makeNode(kind: NodeKind, at: { x: number; y: number }, stamp = Date.now().toString(36)): DirectorNode {
  if (kind === "scene") return scene(`sc-${stamp}`, "New scene", at);
  const label = kind === "character" ? "New character" : kind === "location" ? "New location" : "New item";
  return asset(`${kind}-${stamp}`, label, kind, at);
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
