// What the agent sees when it asks for the graph. Kind-tolerant: a node type this file has
// never heard of still summarises (id, type, label, position) instead of crashing `outline`.

import type { Edge, Node } from "@xyflow/react";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";
import type { AssetData, BeatData, DirectorData, NoteData, RerouteData, SceneData } from "./model.js";

type RFNode = Node & { data: DirectorData };

export function summarizeNode(n: RFNode): Record<string, unknown> {
  const base = {
    id: n.id,
    type: n.type,
    label: n.data.label,
    parentId: n.parentId ?? null,
    position: n.position,
    hidden: !!n.hidden,
    ...(n.width ? { width: n.width } : {}),
    ...(n.height ? { height: n.height } : {}),
  };
  if (n.type === GROUP_TYPE || n.type === SUBGRAPH_TYPE) {
    const d = n.data as BeatData;
    return { ...base, kind: "beat", collapsed: !!d.collapsed, color: d.color ?? null, promotedIn: d.promotedIn, promotedOut: d.promotedOut, faces: d.faces ?? [], proxies: d.proxies ?? [], blueprintId: d.blueprintId ?? null };
  }
  const d = n.data as SceneData | AssetData | NoteData | RerouteData;
  switch (d.kind) {
    case "scene":
      return {
        ...base,
        kind: "scene",
        heading: d.heading,
        durationSec: d.durationSec ?? null,
        videoPath: d.videoPath ?? null,
        promoted: !!d.promoted,
        inSubgraph: !!d.inSubgraph,
        bypassed: !!d.bypassed,
        color: d.color ?? null,
        collapsed: !!d.collapsed,
        renderStatus: d.renderStatus ?? null,
        ports: d.ports.map((p) => ({ id: p.id, type: p.type, isInput: p.isInput, label: p.label })),
      };
    case "asset":
      return {
        ...base,
        kind: "asset",
        asset: d.asset,
        promoted: !!d.promoted,
        inSubgraph: !!d.inSubgraph,
        bypassed: !!d.bypassed,
        color: d.color ?? null,
        collapsed: !!d.collapsed,
        imagePath: d.imagePath ?? null,
        ports: d.ports.map((p) => ({ id: p.id, type: p.type, isInput: p.isInput, label: p.label })),
      };
    case "note":
      return { ...base, kind: "note", text: d.text };
    case "reroute":
      return { ...base, kind: "reroute", portType: d.portType, ports: d.ports.map((p) => ({ id: p.id, type: p.type, isInput: p.isInput, label: p.label })) };
    default:
      return { ...base, kind: (d as { kind?: string }).kind ?? "unknown" };
  }
}

export function summarizeEdge(e: Edge): Record<string, unknown> {
  return { id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle, relay: e.id.includes("__inneredge") };
}
