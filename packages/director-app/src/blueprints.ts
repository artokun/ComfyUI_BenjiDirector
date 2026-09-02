// Blueprints — save a Beat as a reusable template and stamp copies of it.
//
// Ported from ifr-node-lab's user blueprints, with one deliberate simplification that the
// algebra makes safe: a blueprint stores the Beat in its DISSOLVED form (logical child-to-
// child and child-to-outside edges, no rails), and instantiating re-promotes it. Rails are
// derived state — reconcile rebuilds them from the crossings — so storing them would only
// create a second source of truth that could disagree with the wires. The price is that
// user-renamed rail labels do not survive a round-trip; that is a v2 item, not a bug.
//
// Ids are rebuilt rather than string-replaced. Port ids embed the node id
// (`sc-01:in:PROMPT`), and boundary ids embed both a container id and a port id, so a naive
// `replace("sc-01", ...)` would also hit `sc-010`. Regenerating the ports from the node's
// kind and new id, and mapping each edge handle through the same rule, cannot mis-hit.

import { GROUP_TYPE, SUBGRAPH_TYPE, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { reportedPorts, type BeatData, type DirectorData, type DirectorNode } from "./model.js";

export const BLUEPRINTS_KEY = "benjidirector/blueprints";

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
}

export function loadBlueprints(): Record<string, Blueprint> {
  try {
    const raw = JSON.parse(localStorage.getItem(BLUEPRINTS_KEY) || "null");
    return raw && typeof raw === "object" ? (raw as Record<string, Blueprint>) : {};
  } catch {
    return {};
  }
}

export function writeBlueprints(all: Record<string, Blueprint>): void {
  try {
    localStorage.setItem(BLUEPRINTS_KEY, JSON.stringify(all));
  } catch {
    /* quota or storage disabled — the in-memory copy still works for this session */
  }
}

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
  while (existing[id]) id = `bp-${slug}-${i++}`;
  return id;
}

/** Fields that are derived every settle, or are React Flow runtime state. Never persisted. */
function cleanData(d: DirectorData): DirectorData {
  const copy = { ...d } as DirectorData & Record<string, unknown>;
  delete copy.faces;
  delete copy.proxies;
  delete copy.inSubgraph;
  if (copy.kind === "beat") {
    // Rails are rebuilt from the wires on instantiate.
    (copy as BeatData).promotedIn = [];
    (copy as BeatData).promotedOut = [];
    delete (copy as Partial<BeatData>).blueprintId;
    delete (copy as Partial<BeatData>).blueprintVersion;
  }
  return copy as DirectorData;
}

/**
 * Serialise a container and everything under it.
 *
 * `edges` must already be in LOGICAL form for this subtree — call `dissolveSubgraph` on a
 * copy first if the root is a subgraph. Edges leaving the subtree are dropped: a blueprint is a
 * self-contained thing, and whatever it gets wired to later is the user's business.
 */
export function serializeSubtree(
  rootId: string,
  nodes: readonly GraphNode<DirectorData>[],
  edges: readonly GraphEdge[],
  wasSubgraph: boolean,
): Pick<Blueprint, "rootId" | "nodes" | "edges"> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
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

/**
 * Stamp a copy of a blueprint at a canvas position.
 *
 * Returns a plain GROUP root (plus children and logical edges) and says whether the caller
 * should promote it. Promotion goes through the real algebra so the rails come out exactly as
 * they would for a hand-built Beat.
 */
export function instantiateBlueprint(
  bp: Blueprint,
  at: { x: number; y: number },
  stamp = Date.now().toString(36),
): { nodes: DirectorNode[]; edges: GraphEdge[]; rootId: string; promote: boolean } {
  const idMap = new Map<string, string>();
  for (const n of bp.nodes) idMap.set(n.id, `${n.id}-${stamp}`);
  const mapId = (id: string) => idMap.get(id) ?? id;
  const mapHandle = (h: string): string => {
    // `${nodeId}:${side}:${NAME}` — the node id is everything before the first ":".
    const i = h.indexOf(":");
    if (i < 0) return h;
    return `${mapId(h.slice(0, i))}${h.slice(i)}`;
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

  const root = bp.nodes.find((n) => n.id === bp.rootId);
  return { nodes, edges, rootId: mapId(bp.rootId), promote: !!root?.wasSubgraph || root?.type === SUBGRAPH_TYPE };
}
