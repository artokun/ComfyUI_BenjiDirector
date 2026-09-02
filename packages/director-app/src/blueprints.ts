// Blueprints — save a Beat as a reusable template and stamp copies of it.
//
// Ported from ifr-node-lab's user blueprints, with one deliberate simplification that the
// algebra makes safe: a blueprint stores the Beat in its DISSOLVED form (logical child-to-
// child edges, no rails), and instantiating re-promotes it. Rails are derived state —
// reconcile rebuilds them from the crossings — so storing them as wiring would only create a
// second source of truth that could disagree with the wires.
//
// What DOES travel is the Beat's INTERFACE. Every rail a saved subgraph exposed was derived
// from a wire to something outside it, and that something does not come along — so a freshly
// stamped instance has no crossings and, left to the algebra, no rails. ifr-node-lab's answer
// is the right one: a blueprint's boundary is its authored interface, so each saved rail is
// re-pinned (`forced`) on the instance and the user's rail labels are re-applied. Both are
// keyed by the CHILD port id, because node ids are re-minted on instantiate and the child port
// is the one thing a rail aliases that survives that.
//
// Ids are rebuilt rather than string-replaced. Port ids embed the node id
// (`sc-01:in:PROMPT`), and boundary ids embed both a container id and a port id, so a naive
// `replace("sc-01", ...)` would also hit `sc-010`. Regenerating the ports from the node's
// kind and new id, and mapping each edge handle through the same rule, cannot mis-hit.
//
// Known gap: a subgraph NESTED inside the saved Beat keeps its type but loses the wires that
// crossed its own boundary (they are stored in relay form and dropped). Only the root is
// dissolved before serialising. Fixing that means dissolving inside-out; a later increment.

import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  boundaryPortId,
  boundaryTargets,
  promoteToSubgraph,
  uniquifyLabel,
  type BoundaryPort,
  type GraphEdge,
  type GraphNode,
} from "@benjidirector/graph-core";
import { asset, beat, directorHost, reportedPorts, scene, type BeatData, type DirectorData, type DirectorNode } from "./model.js";

export const BLUEPRINTS_KEY = "benjidirector/blueprints";

/** One rail a saved container exposed, keyed by the child port it aliases. */
export interface BlueprintRail {
  side: "in" | "out";
  /** `${childNodeId}:${side}:${NAME}` — the node id part is remapped on instantiate. */
  childPortId: string;
  /** Further child ports the same rail fed (fan-in), inputs only. Remapped the same way. */
  fanout?: string[];
}

export interface BlueprintNode {
  id: string;
  type: string;
  parentId?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  /** Serialisable data with every derived field stripped. */
  data: DirectorData;
  /** Only meaningful on the root: was it a subgraph when saved? */
  wasSubgraph?: boolean;
  /**
   * Containers only: every rail the Beat exposed when saved, in rail order. All of them are
   * pinned on the instance — the wires that derived them stay behind with the original.
   */
  forcedRails?: BlueprintRail[];
  /** Containers only: child port id → the label the user gave that rail. */
  railLabels?: Record<string, string>;
}

export interface BlueprintEdge {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

export interface Blueprint {
  id: string;
  label: string;
  savedAt: number;
  rootId: string;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
  /** Bumped on every save into the same id. Instances carry the version they were stamped from. */
  version?: number;
  /** Ships with the editor: listed and placeable, never updated or deleted. */
  builtin?: boolean;
  description?: string;
}

export const blueprintVersion = (bp: Pick<Blueprint, "version">): number => bp.version ?? 1;

// ── storage ───────────────────────────────────────────────────────────────────────────────

function readStored(): Record<string, Blueprint> {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(BLUEPRINTS_KEY) || "null");
    return raw && typeof raw === "object" ? (raw as Record<string, Blueprint>) : {};
  } catch {
    return {};
  }
}

/** Every blueprint the editor knows: the built-ins (read-only) plus what the user saved. */
export function loadBlueprints(): Record<string, Blueprint> {
  const all: Record<string, Blueprint> = {};
  for (const b of BUILTIN_BLUEPRINTS) all[b.id] = b;
  // A stored entry can never shadow a built-in — the built-in is code, the store is data.
  for (const [id, b] of Object.entries(readStored())) if (!all[id]) all[id] = { ...b, builtin: false };
  return all;
}

/** Persist the user's blueprints. Built-ins are never written; they come back from code. */
export function writeBlueprints(all: Record<string, Blueprint>): void {
  const user: Record<string, Blueprint> = {};
  for (const [id, b] of Object.entries(all)) if (!b.builtin && !isBuiltinBlueprint(id)) user[id] = b;
  try {
    globalThis.localStorage?.setItem(BLUEPRINTS_KEY, JSON.stringify(user));
  } catch {
    /* quota or storage disabled — the in-memory copy still works for this session */
  }
}

export const isBuiltinBlueprint = (id: string): boolean => BUILTIN_BLUEPRINTS.some((b) => b.id === id);

/** Stable id from a name, uniquified against what exists. */
export function blueprintIdFromName(name: string, existing: Record<string, Blueprint>): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "blueprint";
  let id = `bp-${slug}`;
  let i = 1;
  while (existing[id] || isBuiltinBlueprint(id)) id = `bp-${slug}-${i++}`;
  return id;
}

/**
 * Store a serialised container as a blueprint.
 *
 * With `into`, the new body becomes the next VERSION of that blueprint (its id is kept, the
 * label may change). Without it, a fresh id is minted from the label. Updating a built-in is
 * refused rather than silently forked: the caller decides what the user meant.
 */
export function storeBlueprint(body: Pick<Blueprint, "rootId" | "nodes" | "edges">, label: string, into?: string): Blueprint {
  const existing = loadBlueprints();
  const prior = into ? existing[into] : undefined;
  if (into && !prior) throw new Error(`no blueprint "${into}" to update`);
  if (prior?.builtin) throw new Error(`“${prior.label}” ships with the editor — save a copy under a new name`);
  const bp: Blueprint = {
    id: prior ? prior.id : blueprintIdFromName(label, existing),
    label,
    savedAt: Date.now(),
    version: prior ? blueprintVersion(prior) + 1 : 1,
    ...body,
  };
  writeBlueprints({ ...existing, [bp.id]: bp });
  return bp;
}

/** Remove a user blueprint. False when there is nothing to remove or it is a built-in. */
export function deleteBlueprint(id: string): boolean {
  if (isBuiltinBlueprint(id)) return false;
  const stored = readStored();
  if (!stored[id]) return false;
  delete stored[id];
  writeBlueprints(stored);
  return true;
}

// ── dialogs: filled by the blueprint-modal module, called by the editor ──────────────────
//
// The editor's action surface is built above the modal provider, so it cannot call
// `useModal()` itself. The React module mounts a host inside the provider and registers its
// dialogs here; the editor asks through this seam and never touches a window.* prompt.

export interface BlueprintSaveRequest {
  defaultName: string;
  /** The blueprint this container was saved from (or placed from), when it still exists. */
  linked?: { id: string; label: string; version: number; builtin: boolean };
}
export type BlueprintSaveResult = { name: string; mode: "update" | "new" } | null;

export interface BlueprintDialogs {
  save(req: BlueprintSaveRequest): Promise<BlueprintSaveResult>;
  confirmDelete(bp: Pick<Blueprint, "id" | "label">): Promise<boolean>;
}

let dialogs: BlueprintDialogs | null = null;
export function setBlueprintDialogs(d: BlueprintDialogs | null): void {
  dialogs = d;
}
export function blueprintDialogs(): BlueprintDialogs | null {
  return dialogs;
}

// ── serialise ─────────────────────────────────────────────────────────────────────────────

/** Fields that are derived every settle, or are React Flow runtime state. Never persisted. */
function cleanData(d: DirectorData): DirectorData {
  const copy = { ...d } as DirectorData & Record<string, unknown>;
  delete copy.faces;
  delete copy.inSubgraph;
  if (copy.kind === "beat") {
    // Rails are rebuilt from the wires on instantiate; the interface travels as forcedRails.
    (copy as BeatData).promotedIn = [];
    (copy as BeatData).promotedOut = [];
    delete (copy as Partial<BeatData>).blueprintId;
    delete (copy as Partial<BeatData>).blueprintVersion;
  }
  return copy as DirectorData;
}

/** A container's rails as the blueprint stores them: pins keyed by child port, plus labels. */
function captureRails(n: GraphNode<DirectorData> | undefined): Pick<BlueprintNode, "forcedRails" | "railLabels"> {
  const d = n?.data as BeatData | undefined;
  if (!n || !d || d.kind !== "beat") return {};
  const forcedRails: BlueprintRail[] = [];
  const railLabels: Record<string, string> = {};
  const take = (side: "in" | "out", ports: BoundaryPort[] | undefined) => {
    for (const p of ports ?? []) {
      const extra = boundaryTargets(p)
        .slice(1)
        .map((t) => t.childPortId);
      forcedRails.push({ side, childPortId: p.childPortId, ...(extra.length ? { fanout: extra } : {}) });
      railLabels[p.childPortId] = p.label;
    }
  };
  take("in", d.promotedIn);
  take("out", d.promotedOut);
  if (!forcedRails.length) return {};
  return { forcedRails, railLabels };
}

/**
 * Serialise a container and everything under it.
 *
 * `edges` must already be in LOGICAL form for this subtree — call `dissolveSubgraph` on a
 * copy first if the root is a subgraph. Edges leaving the subtree are dropped: a blueprint is a
 * self-contained thing, and whatever it gets wired to later is the user's business.
 *
 * `original` is the graph as it stood BEFORE that dissolve: dissolving drops the rails, and
 * the rails are the interface the blueprint has to remember. Omit it and the blueprint saves
 * with no interface, as v1 did.
 */
export function serializeSubtree(
  rootId: string,
  nodes: readonly GraphNode<DirectorData>[],
  edges: readonly GraphEdge[],
  wasSubgraph: boolean,
  original?: readonly GraphNode<DirectorData>[],
): Pick<Blueprint, "rootId" | "nodes" | "edges"> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const originalById = new Map((original ?? nodes).map((n) => [n.id, n] as const));
  const inside = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (!inside.has(n.id) && n.parentId && inside.has(n.parentId)) {
        inside.add(n.id);
        grew = true;
      }
    }
  }
  const out: BlueprintNode[] = [];
  for (const id of inside) {
    const n = byId.get(id);
    if (!n) continue;
    const root = id === rootId;
    out.push({
      id: n.id,
      type: root ? GROUP_TYPE : (n.type ?? "scene"),
      ...(root ? {} : n.parentId ? { parentId: n.parentId } : {}),
      position: root ? { x: 0, y: 0 } : { ...n.position },
      ...(n.width !== undefined ? { width: n.width } : {}),
      ...(n.height !== undefined ? { height: n.height } : {}),
      data: cleanData(n.data),
      ...(root ? { wasSubgraph } : {}),
      ...captureRails(originalById.get(id)),
    });
  }
  const kept: BlueprintEdge[] = edges
    .filter((e) => inside.has(e.source) && inside.has(e.target) && e.sourceHandle && e.targetHandle)
    .filter((e) => !e.sourceHandle!.includes("::") && !e.targetHandle!.includes("::"))
    .map((e) => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle!,
      targetHandle: e.targetHandle!,
    }));
  return { rootId, nodes: out, edges: kept };
}

// ── instantiate ───────────────────────────────────────────────────────────────────────────

/** A rail to pin on a freshly stamped container, already re-keyed to the instance's ids. */
export interface InstanceRail {
  side: "in" | "out";
  childId: string;
  childPortId: string;
  fanout?: { childId: string; childPortId: string }[];
}

/** Per NEW container id: what to pin and what to call it, once the container is a subgraph. */
export type InstanceRails = Record<string, { forcedRails: InstanceRail[]; railLabels: Record<string, string> }>;

/**
 * Stamp a copy of a blueprint at a canvas position.
 *
 * Returns a plain GROUP root (plus children and logical edges) and says whether the caller
 * should promote it. Promotion goes through the real algebra so the rails come out exactly as
 * they would for a hand-built Beat; `rails` is what the caller pins and labels AFTER that,
 * since promote only knows about crossings and an instance has none yet.
 */
export function instantiateBlueprint(
  bp: Blueprint,
  at: { x: number; y: number },
  stamp = Date.now().toString(36),
): { nodes: DirectorNode[]; edges: GraphEdge[]; rootId: string; promote: boolean; rails: InstanceRails } {
  const idMap = new Map<string, string>();
  for (const n of bp.nodes) idMap.set(n.id, `${n.id}-${stamp}`);
  const mapId = (id: string) => idMap.get(id) ?? id;
  const mapHandle = (h: string): string => {
    // `${nodeId}:${side}:${NAME}` — the node id is everything before the first ":".
    const i = h.indexOf(":");
    if (i < 0) return h;
    return `${mapId(h.slice(0, i))}${h.slice(i)}`;
  };
  const nodeOfHandle = (h: string): string => {
    const i = h.indexOf(":");
    return i < 0 ? h : h.slice(0, i);
  };

  const nodes: DirectorNode[] = bp.nodes.map((n) => {
    const id = mapId(n.id);
    const root = n.id === bp.rootId;
    const data = { ...n.data } as DirectorData;
    if (data.kind !== "beat") (data as { ports: unknown }).ports = reportedPorts(data.kind, id);
    return {
      id,
      type: root ? GROUP_TYPE : n.type,
      position: root ? { ...at } : { ...n.position },
      ...(n.parentId ? { parentId: mapId(n.parentId) } : {}),
      ...(n.width !== undefined ? { width: n.width } : {}),
      ...(n.height !== undefined ? { height: n.height } : {}),
      data,
    };
  });

  const edges: GraphEdge[] = bp.edges.map((e) => {
    const sh = mapHandle(e.sourceHandle);
    const th = mapHandle(e.targetHandle);
    return { id: `lg:${sh}->${th}`, source: mapId(e.source), target: mapId(e.target), sourceHandle: sh, targetHandle: th };
  });

  const rails: InstanceRails = {};
  for (const n of bp.nodes) {
    if (!n.forcedRails?.length && !n.railLabels) continue;
    const forcedRails: InstanceRail[] = (n.forcedRails ?? []).map((r) => {
      const childPortId = mapHandle(r.childPortId);
      const fanout = (r.fanout ?? []).map((h) => ({ childId: mapId(nodeOfHandle(h)), childPortId: mapHandle(h) }));
      return { side: r.side, childId: mapId(nodeOfHandle(r.childPortId)), childPortId, ...(fanout.length ? { fanout } : {}) };
    });
    const railLabels: Record<string, string> = {};
    for (const [h, label] of Object.entries(n.railLabels ?? {})) railLabels[mapHandle(h)] = label;
    rails[mapId(n.id)] = { forcedRails, railLabels };
  }

  const root = bp.nodes.find((n) => n.id === bp.rootId);
  return { nodes, edges, rootId: mapId(bp.rootId), promote: !!root?.wasSubgraph || root?.type === SUBGRAPH_TYPE, rails };
}

/**
 * Pin and label an instance's rails. Call after `promoteToSubgraph`, before settle: reconcile
 * re-injects pinned ports and rebuilds their inner relays, so this only has to put the ports on
 * the container — the wiring follows. Containers that are not subgraphs are left alone.
 */
export function applyInstanceRails(nodes: readonly GraphNode<DirectorData>[], rails: InstanceRails): GraphNode<DirectorData>[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const portOf = (childId: string, childPortId: string) => {
    const child = byId.get(childId);
    const ports = child && "ports" in child.data ? child.data.ports : [];
    return ports.find((p) => p.id === childPortId);
  };
  return nodes.map((n) => {
    const spec = rails[n.id];
    if (!spec || n.type !== SUBGRAPH_TYPE || n.data.kind !== "beat") return n;
    const d = n.data;
    const lists = { in: [...d.promotedIn], out: [...d.promotedOut] };
    for (const r of spec.forcedRails) {
      const list = lists[r.side];
      const id = boundaryPortId(n.id, r.childPortId);
      if (list.some((p) => p.id === id)) continue;
      const port = portOf(r.childId, r.childPortId);
      if (!port || port.isInput !== (r.side === "in")) continue;
      const fanout = (r.fanout ?? []).filter((t) => portOf(t.childId, t.childPortId));
      list.push({
        id,
        childId: r.childId,
        childPortId: r.childPortId,
        type: port.type,
        label: port.label,
        forced: true,
        ...(fanout.length ? { fanout } : {}),
      });
    }
    // Labels last, deduped against the rest of the same rail — a rename can collide.
    for (const side of ["in", "out"] as const) {
      const list = lists[side];
      lists[side] = list.map((p, i) => {
        const wanted = spec.railLabels[p.childPortId];
        if (!wanted) return p;
        const taken = new Set(list.filter((_, j) => j !== i).map((q) => q.label));
        return { ...p, label: uniquifyLabel(wanted, taken) };
      });
    }
    return { ...n, data: { ...d, promotedIn: lists.in, promotedOut: lists.out } } as GraphNode<DirectorData>;
  });
}

/** A graph node carrying React Flow's selection flag — what a placement hands back. */
export type PlacedNode = GraphNode<DirectorData> & { selected?: boolean };

/**
 * The whole placement, in one call: instantiate, promote if it was saved as a subgraph, pin
 * and label its rails, link the instance to the blueprint, and make it the selection. The
 * caller settles the result; reconcile finishes the rails' wiring.
 */
export function stampBlueprint(
  bp: Blueprint,
  at: { x: number; y: number },
  nodes: readonly GraphNode<DirectorData>[],
  edges: readonly GraphEdge[],
  stamp?: string,
): { nodes: PlacedNode[]; edges: GraphEdge[]; rootId: string } {
  const inst = instantiateBlueprint(bp, at, stamp);
  let merged: PlacedNode[] = [...nodes.map((n) => ({ ...n, selected: false }) as PlacedNode), ...inst.nodes];
  let mergedEdges: GraphEdge[] = [...edges, ...inst.edges];
  if (inst.promote) {
    const out = promoteToSubgraph(inst.rootId, merged, mergedEdges, directorHost);
    merged = applyInstanceRails(out.nodes as GraphNode<DirectorData>[], inst.rails) as PlacedNode[];
    mergedEdges = out.edges;
  }
  merged = merged.map((n) =>
    n.id === inst.rootId
      ? ({ ...n, selected: true, data: { ...n.data, blueprintId: bp.id, blueprintVersion: blueprintVersion(bp) } } as PlacedNode)
      : n,
  );
  return { nodes: merged, edges: mergedEdges, rootId: inst.rootId };
}

// ── built-ins ─────────────────────────────────────────────────────────────────────────────
//
// Authored with placeholder ids (`tpl-…`); instantiate re-mints every one. Kept minimal: a
// built-in is a starting shape the user recognises, not a showcase.

function builtin(bp: Omit<Blueprint, "savedAt" | "builtin" | "version">): Blueprint {
  return { ...bp, savedAt: 0, version: 1, builtin: true };
}

const chain = (a: string, ah: string, b: string, bh: string): BlueprintEdge => ({
  source: a,
  target: b,
  sourceHandle: `${a}:out:${ah}`,
  targetHandle: `${b}:in:${bh}`,
});

const toBlueprintNode = (n: DirectorNode, root = false): BlueprintNode => ({
  id: n.id,
  type: root ? GROUP_TYPE : (n.type ?? "scene"),
  ...(n.parentId ? { parentId: n.parentId } : {}),
  position: n.position,
  ...(n.width !== undefined ? { width: n.width } : {}),
  ...(n.height !== undefined ? { height: n.height } : {}),
  data: cleanData(n.data),
});

/** "Two-shot Beat": a character feeding two chained scenes, with the continuity pair on the rails. */
const TWO_SHOT: Blueprint = builtin({
  id: "bp-two-shot",
  label: "Two-shot Beat",
  description: "Two chained scenes sharing one character, exposing the continuity pair as rails.",
  rootId: "tpl-two-shot",
  nodes: [
    {
      ...toBlueprintNode(beat("tpl-two-shot", "Two-shot Beat", { x: 0, y: 0 }, { width: 620, height: 400 }), true),
      wasSubgraph: true,
      forcedRails: [
        { side: "in", childPortId: "tpl-shot-a:in:IN FRAME" },
        { side: "out", childPortId: "tpl-shot-b:out:LAST FRAME" },
      ],
      railLabels: { "tpl-shot-a:in:IN FRAME": "Lead-in", "tpl-shot-b:out:LAST FRAME": "Hand-off" },
    },
    toBlueprintNode({ ...asset("tpl-lead", "Lead", "character", { x: 28, y: 70 }), parentId: "tpl-two-shot" }),
    toBlueprintNode(scene("tpl-shot-a", "Shot A · Two-shot", { x: 250, y: 44 }, { durationSec: 5 }, "tpl-two-shot")),
    toBlueprintNode(scene("tpl-shot-b", "Shot B · Reverse", { x: 250, y: 214 }, { durationSec: 4 }, "tpl-two-shot")),
  ],
  edges: [
    chain("tpl-lead", "REF", "tpl-shot-a", "CHARACTER"),
    chain("tpl-lead", "REF", "tpl-shot-b", "CHARACTER"),
    chain("tpl-shot-a", "LAST FRAME", "tpl-shot-b", "IN FRAME"),
  ],
});

export const BUILTIN_BLUEPRINTS: readonly Blueprint[] = [TWO_SHOT];
