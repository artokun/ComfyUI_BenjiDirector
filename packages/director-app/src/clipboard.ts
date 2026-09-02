// Clipboard — copy a selection out of the graph, paste it back with fresh ids.
//
// Ported from ifr-node-lab's ⌘C / ⌘V (App.tsx, the `clipboard` ref) and its blueprint id
// remap (`remapHandle`). Three things are different here, each on purpose:
//
//   1. A selection carries its DESCENDANTS. Copying a Beat without its scenes would paste an
//      empty box; copying a scene inside a Beat pastes just the scene. So the clip is the
//      selected roots plus everything under them, and a node is a "root" when its parent is
//      not in the clip — roots are stored in ABSOLUTE coordinates and lose their parentId,
//      children keep their parent-relative position and their (remapped) parentId.
//   2. Ids are REBUILT, never string-replaced. Port ids embed the node id (`sc-01:in:PROMPT`),
//      boundary ids embed a container id and a port id (`beat-1::sc-01:in:PROMPT`), and a
//      nested rail embeds three (`beat-a::beat-b::sc-x:out:VIDEO`). `replace("sc-01", …)`
//      would also hit `sc-010`; regenerating ports from (kind, newId) and mapping every
//      `::`-segment's leading node id through one rule cannot mis-hit.
//   3. Rails are KEPT. ifr cleared `promotedIn/Out` on paste and asked the user to re-promote;
//      here the pasted subgraph keeps its type and its remapped rails, and `settle()`'s
//      reconcile (dissolve → promote, then labels / pins / order restored by derived id) does
//      the rest: a pinned rail survives with its label, a rail whose crossing was left behind
//      is pruned, and a crossing that came along (both ends in the clip) gets its rail back
//      under the very same derived id. That is why this module does not call
//      `promoteToSubgraph` itself — it refuses a node that is already a subgraph, and calling
//      it on a demoted copy would throw the pins away.
//
// Calliope: a pasted scene is an EDITOR-LOCAL scene. Only `cal-*` ids sync (calliope-sync
// diffs by `calliopeRef`), and a copy of `cal-sc-12` is minted as `sc-…`, so pasting inside a
// loaded project adds nothing to the film until an agent or tool creates rows for it. The
// row-derived fields (`orderIndex`, `renderStatus`) are dropped for the same reason: the copy
// has no place in the cut and nothing has rendered it. Content (heading, action, duration,
// prompts, refs) comes along — that is what a copy is for.

import { absolutePos, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { mintId, reportedPorts, type BeatData, type DirectorData, type DirectorNode } from "./model.js";

/** A node as it sits in the clip. Roots: absolute position, no parentId. */
export interface ClipNode {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  data: DirectorData;
}

export interface ClipEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

export interface Clip {
  nodes: ClipNode[];
  edges: ClipEdge[];
}

type Selectable = GraphNode<DirectorData> & { selected?: boolean };

/** Fields derived every settle, or owned by a Calliope row / a blueprint link. Never copied. */
function cleanData(d: DirectorData): DirectorData {
  const copy = { ...d } as DirectorData & Record<string, unknown>;
  delete copy.faces;
  delete copy.inSubgraph;
  delete copy.orderIndex;
  delete copy.renderStatus;
  if (copy.kind === "beat") {
    delete (copy as Partial<BeatData>).blueprintId;
    delete (copy as Partial<BeatData>).blueprintVersion;
  }
  return copy as DirectorData;
}

/** Grow a set of ids to every descendant. */
function withDescendants(rootIds: Iterable<string>, nodes: readonly GraphNode<DirectorData>[]): Set<string> {
  const inside = new Set(rootIds);
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
  return inside;
}

/**
 * Copy the selection: the selected nodes, their descendants, and every edge with BOTH ends
 * inside. `roots` overrides the `selected` flags (the drive command names ids). An empty
 * selection gives an empty clip; the caller decides whether that is worth a note.
 */
export function copySelection(nodes: readonly Selectable[], edges: readonly GraphEdge[], roots?: Iterable<string>): Clip {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const wanted = roots ? [...roots].filter((id) => byId.has(id)) : nodes.filter((n) => n.selected).map((n) => n.id);
  const inside = withDescendants(wanted, nodes);
  const out: ClipNode[] = [];
  for (const n of nodes) {
    if (!inside.has(n.id)) continue;
    const isRoot = !n.parentId || !inside.has(n.parentId);
    out.push({
      id: n.id,
      ...(n.type !== undefined ? { type: n.type } : {}),
      ...(isRoot ? {} : { parentId: n.parentId }),
      position: isRoot ? absolutePos(n, nodes) : { ...n.position },
      ...(n.width !== undefined ? { width: n.width } : {}),
      ...(n.height !== undefined ? { height: n.height } : {}),
      data: cleanData(n.data),
    });
  }
  const kept: ClipEdge[] = [];
  for (const e of edges) {
    if (!inside.has(e.source) || !inside.has(e.target) || !e.sourceHandle || !e.targetHandle) continue;
    kept.push({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle });
  }
  return { nodes: out, edges: kept };
}

/** Top-left of the clip's roots — the point `pasteClip` puts at `at`. */
export function clipAnchor(clip: Clip): { x: number; y: number } {
  const roots = clip.nodes.filter((n) => !n.parentId);
  if (!roots.length) return { x: 0, y: 0 };
  return { x: Math.min(...roots.map((n) => n.position.x)), y: Math.min(...roots.map((n) => n.position.y)) };
}

/**
 * Remap a handle id through an id map. Shapes handled:
 *   `${nodeId}:dir:NAME`                       a port
 *   `${cid}::${nodeId}:dir:NAME`               a boundary port (outer handle)
 *   `${cid}::${inner}::${nodeId}:dir:NAME`     a rail promoted through a nested subgraph
 *   `…__inner`                                 the inner relay handle of any of the above
 *   `${cid}::+in`                              a rail's empty `+` slot (only the cid maps)
 * Every `::`-segment's leading id maps independently, so nesting depth does not matter.
 */
export function remapHandle(h: string, idMap: ReadonlyMap<string, string>): string {
  const inner = h.endsWith("__inner");
  const core = inner ? h.slice(0, -"__inner".length) : h;
  const mapLead = (s: string): string => {
    const i = s.indexOf(":");
    const id = i >= 0 ? s.slice(0, i) : s;
    return (idMap.get(id) ?? id) + (i >= 0 ? s.slice(i) : "");
  };
  const mapped = core.split("::").map(mapLead).join("::");
  return inner ? `${mapped}__inner` : mapped;
}

const prefixFor = (d: DirectorData): string => {
  switch (d.kind) {
    case "scene":
      return "sc";
    case "asset":
      return d.asset;
    case "beat":
      return "beat";
    case "note":
      return "note";
    case "reroute":
      return "reroute";
    default:
      return "node";
  }
};

/**
 * Paste a clip with the roots' top-left at `at` (or, when `at` is null, 40px down-right of
 * where they were copied from — the duplicate offset). Every id is fresh and absent from
 * `existingIds`; parentId, ports, rails, boundary ids and edge handles are remapped together.
 * Returns plain graph nodes; the caller settles them (which reconciles any pasted subgraph).
 */
export function pasteClip(clip: Clip, at: { x: number; y: number } | null, existingIds: Iterable<string>): { nodes: DirectorNode[]; edges: GraphEdge[]; ids: string[] } {
  const taken = new Set(existingIds);
  const idMap = new Map<string, string>();
  for (const n of clip.nodes) {
    let id = mintId(prefixFor(n.data));
    // mintId is counter-suffixed, so this loop is a belt for a strap that already holds;
    // bounded so a pathological `existingIds` cannot spin it forever.
    let safety = 0;
    while (taken.has(id) && safety++ < 10_000) id = mintId(prefixFor(n.data));
    taken.add(id);
    idMap.set(n.id, id);
  }
  const mapId = (id: string) => idMap.get(id) ?? id;
  const mapHandle = (h: string) => remapHandle(h, idMap);

  const anchor = clipAnchor(clip);
  const target = at ?? { x: anchor.x + 40, y: anchor.y + 40 };
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;

  const nodes: DirectorNode[] = clip.nodes.map((n) => {
    const id = mapId(n.id);
    let data = { ...n.data } as DirectorData;
    if (data.kind === "beat") {
      const remapRail = (list: BeatData["promotedIn"]) =>
        list.map((p) => ({
          ...p,
          id: mapHandle(p.id),
          childId: mapId(p.childId),
          childPortId: mapHandle(p.childPortId),
          ...(p.fanout ? { fanout: p.fanout.map((t) => ({ childId: mapId(t.childId), childPortId: mapHandle(t.childPortId) })) } : {}),
        }));
      data = { ...data, promotedIn: remapRail(data.promotedIn), promotedOut: remapRail(data.promotedOut) };
    } else {
      data = { ...data, ports: reportedPorts(data.kind, id, data.kind === "reroute" ? data.portType : undefined) } as DirectorData;
    }
    const root = !n.parentId;
    return {
      id,
      ...(n.type !== undefined ? { type: n.type } : {}),
      position: root ? { x: n.position.x + dx, y: n.position.y + dy } : { ...n.position },
      ...(n.parentId ? { parentId: mapId(n.parentId) } : {}),
      ...(n.width !== undefined ? { width: n.width } : {}),
      ...(n.height !== undefined ? { height: n.height } : {}),
      data,
    };
  });

  const edges: GraphEdge[] = clip.edges.map((e) => {
    const sh = mapHandle(e.sourceHandle);
    const th = mapHandle(e.targetHandle);
    // Edge ids embed handle ids (`lg:<sh>-><th>`, `<bp>__inneredge`), so they are rebuilt
    // from the mapped handles rather than mapped as strings. A relay's rebuilt id is only
    // transient: settle's reconcile re-derives every relay under its own naming.
    return { id: `lg:${sh}->${th}`, source: mapId(e.source), target: mapId(e.target), sourceHandle: sh, targetHandle: th };
  });

  return { nodes, edges, ids: nodes.map((n) => n.id) };
}

/**
 * Duplicate: copy `ids` (with descendants) and paste the copy 40px down-right. One call, no
 * clipboard involved — Ctrl+D must not clobber what Ctrl+C put there.
 */
export function duplicateNodes(nodes: readonly Selectable[], edges: readonly GraphEdge[], ids: Iterable<string>): { nodes: DirectorNode[]; edges: GraphEdge[]; ids: string[] } {
  const clip = copySelection(nodes, edges, ids);
  if (!clip.nodes.length) return { nodes: [], edges: [], ids: [] };
  return pasteClip(clip, null, nodes.map((n) => n.id));
}
