// Beat-level topology — the part of the canvas Calliope has nowhere to store.
//
// A scene's Beat, position and pin round-trip through Calliope rows (calliope-bind / -sync).
// A Beat's own state does not: whether it is a subgraph, collapsed, its colour and box, and
// the labels the user gave its rails. v2 adds `extras` — the same problem one level down, for
// a note's text, a leaf's collapse / colour / bypass and a reroute's type. Both live in a local
// per-project sidecar and are applied on load. The rails themselves are never stored — reconcile
// derives them from the wires, which Calliope does own — only their labels are, keyed by rail
// id, so a missing sidecar costs a colour scheme and some names, never a wire. The upstream fix
// is a meta_json column on story_beats; until it lands this is the seam, and it must keep
// working if it never does.

import { promoteToSubgraph, SUBGRAPH_TYPE, type GraphEdge, type GraphNode, type GraphOpsHost } from "@benjidirector/graph-core";
import { calliopeRef } from "./calliope-bind.js";
import type { BeatData, DirectorData } from "./model.js";

export interface BeatTopology {
  subgraph: boolean;
  collapsed?: boolean;
  color?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  expandedWidth?: number;
  expandedHeight?: number;
  /** Only if the user resized the collapsed card; a collapsed Beat never stores a height. */
  collapsedWidth?: number;
  /** rail id → the label the user gave it. */
  railLabels: Record<string, string>;
}

export interface ProjectTopology {
  /** 1 = Beats only. 2 adds `extras`. A v1 sidecar still applies — it just names no extras. */
  version: 1 | 2;
  beats: Record<string, BeatTopology>;
  /**
   * [U4] Everything else the canvas remembers per node on a Calliope project that has no row
   * field for it: a note's text, a leaf's collapse / colour / bypass, a reroute's port type.
   * Keyed by node id, so an entry naming a node the projection no longer has is ignored the
   * same way a Beat entry is — the sidecar is a memory, never a source of nodes.
   */
  extras?: Record<string, NodeExtras>;
}

/** The per-node fields the sidecar carries. All optional; an empty entry is never written. */
export interface NodeExtras {
  /** A note's markdown. */
  text?: string;
  /** A leaf collapsed to its header. */
  collapsed?: boolean;
  /** A leaf's own tint. */
  color?: string;
  /** Muted — drawn faint, skipped by the render tools. */
  bypassed?: boolean;
  /** A reroute dot's type. A reroute has no row at all, so this is all it will ever have. */
  portType?: string;
}

/** The current sidecar version. Written by `captureTopology`; older ones still load. */
export const TOPOLOGY_VERSION = 2;

/**
 * Which extra fields each node kind carries.
 *
 * A whitelist rather than "everything the row does not have": a scene's heading, duration and
 * Beat are Calliope's to own, and writing them here would create a second answer to a question
 * the rows already answer. A Beat is absent on purpose — its state has its own shape above.
 */
const EXTRA_KEYS: Record<string, readonly (keyof NodeExtras)[]> = {
  scene: ["collapsed", "color", "bypassed"],
  asset: ["collapsed", "color", "bypassed"],
  note: ["text", "color"],
  reroute: ["portType"],
};

/** What this node wants remembered, or undefined when it wants nothing. */
export function extrasOf(n: GraphNode<DirectorData>): NodeExtras | undefined {
  const keys = EXTRA_KEYS[n.data.kind];
  if (!keys) return undefined;
  const d = n.data as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = d[k];
    // `false` and `""` are the defaults, not state: storing them would only grow the sidecar.
    if (v === undefined || v === null || v === false || v === "") continue;
    out[k] = v;
  }
  return Object.keys(out).length ? (out as NodeExtras) : undefined;
}

/** container id → rail id → label; what settle applies after reconcile rebuilds the rails. */
export type RailLabels = Record<string, Record<string, string>>;

export const topologyKey = (projectId: number) => `benjidirector/topology/${projectId}`;

const isBeatRow = (n: GraphNode<DirectorData>) => n.data.kind === "beat" && calliopeRef(n.id)?.kind === "beat";

/** What the sidecar remembers about every Calliope-backed Beat on the canvas. */
export function captureTopology(nodes: readonly GraphNode<DirectorData>[]): ProjectTopology {
  const beats: Record<string, BeatTopology> = {};
  for (const n of nodes) {
    if (!isBeatRow(n)) continue;
    const d = n.data as BeatData;
    const railLabels: Record<string, string> = {};
    for (const p of [...(d.promotedIn ?? []), ...(d.promotedOut ?? [])]) railLabels[p.id] = p.label;
    // `width`/`height` always describe the EXPANDED box. While collapsed the node's own size
    // is the card's (or nothing, when it sizes itself), and the expanded box is stashed in
    // data by toggleCollapse — so read it from there.
    const expandedW = d.collapsed ? d.expandedWidth : n.width;
    const expandedH = d.collapsed ? d.expandedHeight : n.height;
    beats[n.id] = {
      subgraph: n.type === SUBGRAPH_TYPE,
      ...(d.collapsed ? { collapsed: true } : {}),
      ...(d.color ? { color: d.color } : {}),
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      ...(expandedW ? { width: expandedW } : {}),
      ...(expandedH ? { height: expandedH } : {}),
      ...(d.expandedWidth ? { expandedWidth: d.expandedWidth } : {}),
      ...(d.expandedHeight ? { expandedHeight: d.expandedHeight } : {}),
      ...(d.collapsedWidth ? { collapsedWidth: d.collapsedWidth } : {}),
      railLabels,
    };
  }
  // Extras cover every NON-Beat node, Calliope-backed or not: a scene's colour has a row-shaped
  // home the sync unit may one day use, but a note or a reroute has no row at all, and this is
  // the only place either is remembered.
  const extras: Record<string, NodeExtras> = {};
  for (const n of nodes) {
    const e = extrasOf(n);
    if (e) extras[n.id] = e;
  }
  return { version: TOPOLOGY_VERSION, beats, ...(Object.keys(extras).length ? { extras } : {}) };
}

/**
 * Lay a sidecar over a fresh projection. Beats it names get their box, colour and collapse
 * back; subgraphs are re-promoted through the algebra so their rails come from the wires as
 * they are NOW, not as they were saved. Rail labels are returned for settle to apply after
 * reconcile, since reconcile is what mints the rails. Every other node gets its extras back.
 */
export function applyTopology(
  nodes: readonly GraphNode<DirectorData>[],
  edges: readonly GraphEdge[],
  topo: ProjectTopology | null,
  host: GraphOpsHost,
): { nodes: GraphNode<DirectorData>[]; edges: GraphEdge[]; railLabels: RailLabels } {
  if (!topo || (topo.version !== 1 && topo.version !== 2)) return { nodes: [...nodes], edges: [...edges], railLabels: {} };
  let out: GraphNode<DirectorData>[] = nodes.map((n) => {
    const t = topo.beats[n.id];
    if (!t || !isBeatRow(n)) {
      // Not a Beat this sidecar knows — it may still have extras. A reroute's portType is left
      // alone: the ports are already built from it, and rewriting it would desync the handles.
      const e = topo.extras?.[n.id];
      if (!e || !EXTRA_KEYS[n.data.kind]) return n;
      const { portType: _pt, ...rest } = e;
      return Object.keys(rest).length ? ({ ...n, data: { ...n.data, ...rest } } as GraphNode<DirectorData>) : n;
    }
    const d = n.data as BeatData;
    // Collapsed: the node's size is the collapsed card's — an explicit one only if the user
    // resized it while collapsed, otherwise none so the card sizes itself — and the expanded
    // box waits in data for the next expand. Expanded: the node's size is the box.
    const { width: _w, height: _h, ...bare } = n;
    // Never a height while collapsed: the card is content-height by definition.
    const sized = t.collapsed
      ? { ...bare, ...(t.collapsedWidth ? { width: t.collapsedWidth } : {}) }
      : { ...bare, ...(t.width ? { width: t.width } : {}), ...(t.height ? { height: t.height } : {}) };
    return {
      ...sized,
      position: t.position,
      data: {
        ...d,
        ...(t.color ? { color: t.color } : {}),
        ...(t.collapsed ? { collapsed: true } : {}),
        ...(t.collapsed && t.width ? { expandedWidth: t.width } : t.expandedWidth ? { expandedWidth: t.expandedWidth } : {}),
        ...(t.collapsed && t.height ? { expandedHeight: t.height } : t.expandedHeight ? { expandedHeight: t.expandedHeight } : {}),
        ...(t.collapsedWidth ? { collapsedWidth: t.collapsedWidth } : {}),
      },
    } as GraphNode<DirectorData>;
  });
  let outEdges: GraphEdge[] = [...edges];
  const railLabels: RailLabels = {};
  for (const [id, t] of Object.entries(topo.beats)) {
    if (!t.subgraph || !out.some((n) => n.id === id)) continue;
    const res = promoteToSubgraph(id, out, outEdges, host);
    out = res.nodes as GraphNode<DirectorData>[];
    outEdges = res.edges;
    if (Object.keys(t.railLabels ?? {}).length) railLabels[id] = t.railLabels;
  }
  return { nodes: out, edges: outEdges, railLabels };
}

export function loadTopology(projectId: number): ProjectTopology | null {
  try {
    const raw = globalThis.localStorage?.getItem(topologyKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectTopology;
    // A v1 sidecar written before extras existed still loads — it simply names none. A version
    // this build has never heard of does not: applying half of a newer shape is worse than a
    // default layout, and the next save rewrites it at the version we do understand.
    const known = parsed?.version === 1 || parsed?.version === 2;
    return known && parsed.beats && typeof parsed.beats === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveTopology(projectId: number, topo: ProjectTopology): void {
  try {
    globalThis.localStorage?.setItem(topologyKey(projectId), JSON.stringify(topo));
  } catch {
    // A full or disabled store loses a colour scheme, not a film.
  }
}
