// Persistence — the working graph, named saves, export and import. [U4]
//
// Ported from ifr-node-lab's autosave / named saves / io-bar. The saved shape is the SETTLED
// graph minus what settle derives: a node keeps its rails (labels, pins, order — the things a
// user authored, which reconcile restores by id) and the edges keep their relay halves, so
// loading is the same operation as undo: decorate, and let the next settle reconcile. What is
// stripped (`faces`, `inSubgraph`, `renderStatus`) is recomputed every settle or comes from
// the live jobs store; storing it would only make a second source of truth that goes stale.
//
// Loading goes through the editor's own funnel — `loadProject(null)` to detach from Calliope
// and clear undo (for the same reason loadProject clears it: the ids belong to another
// graph), then `settle({ reparent: false, sync: false })` — never `setNodes` from here.
//
// Pure: no React, and no DOM at import time. The clipboard and file helpers touch the browser
// only when called, so this file tests under node.

import type { Edge } from "@xyflow/react";
import { GROUP_TYPE, SUBGRAPH_TYPE, sortParentsFirst, type BoundaryPort, type BoundaryTarget, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { registerDriveCommands, type DriveKit, type RFNode } from "./drive-registry.js";
import { PORT_COLOR, demoProject, reportedPorts, type AssetData, type BeatData, type DirectorData, type DirectorPortType, type NoteData, type RerouteData, type SceneData } from "./model.js";

export const GRAPH_KEY = "benjidirector/graph";
export const SAVES_KEY = "benjidirector/saves";

// ─────────────────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface SavedNode {
  id: string;
  type: string;
  parentId?: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  /** Serialisable data with every derived field stripped. Rails are kept. */
  data: DirectorData;
}

export interface SavedEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}

/** v1. `savedAt` is set by the named-saves registry; an export carries none. */
export interface SavedGraph {
  version: 1;
  savedAt?: number;
  nodes: SavedNode[];
  edges: SavedEdge[];
}

/** A graph as the editor holds it — what `deserializeGraph` returns and `settle` takes. */
export interface Graph {
  nodes: GraphNode<DirectorData>[];
  edges: GraphEdge[];
}

const KINDS = ["scene", "asset", "beat", "note", "reroute"] as const;
type Kind = (typeof KINDS)[number];
const ASSET_KINDS = ["character", "location", "item"] as const;
const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);
const isAssetKind = (v: unknown): v is AssetData["asset"] => typeof v === "string" && (ASSET_KINDS as readonly string[]).includes(v);
const isPortType = (v: unknown): v is DirectorPortType => typeof v === "string" && v in PORT_COLOR;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Fields that settle derives, or that the live unit fills from jobs. Never persisted. */
export function cleanData(d: DirectorData): DirectorData {
  const copy = { ...d } as DirectorData & Record<string, unknown>;
  delete copy.faces;
  delete copy.inSubgraph;
  delete copy.renderStatus;
  // Drop undefined values so the JSON stays compact and a round-trip compares equal.
  for (const k of Object.keys(copy)) if (copy[k] === undefined) delete copy[k];
  return copy as DirectorData;
}

const typeFor = (d: DirectorData): string => (d.kind === "beat" ? GROUP_TYPE : d.kind);

export function serializeNode(n: GraphNode<DirectorData>): SavedNode {
  return {
    id: n.id,
    type: n.type ?? typeFor(n.data),
    ...(n.parentId ? { parentId: n.parentId } : {}),
    position: { x: n.position.x, y: n.position.y },
    ...(isNum(n.width) ? { width: n.width } : {}),
    ...(isNum(n.height) ? { height: n.height } : {}),
    data: cleanData(n.data),
  };
}

export function serializeEdge(e: GraphEdge): SavedEdge | null {
  if (!e.sourceHandle || !e.targetHandle) return null;
  return { id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle };
}

/**
 * The whole canvas as a plain object. Takes the CANONICAL edges (`edgesRef`, what `run` hands
 * over), never the displayed ones — the collapse view rewrites endpoints for drawing only.
 */
export function serializeGraph(nodes: readonly GraphNode<DirectorData>[], edges: readonly GraphEdge[]): SavedGraph {
  const ids = new Set(nodes.map((n) => n.id));
  const out: SavedEdge[] = [];
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    const s = serializeEdge(e);
    if (s) out.push(s);
  }
  return { version: 1, nodes: nodes.map(serializeNode), edges: out };
}

function railsOf(list: unknown, containerId: string, side: "in" | "out"): BoundaryPort[] {
  if (list === undefined || list === null) return [];
  const where = `node "${containerId}"`;
  if (!Array.isArray(list)) throw new Error(`${where}: promoted${side === "in" ? "In" : "Out"} must be an array of rails`);
  return list.map((p, i) => {
    if (!p || typeof p !== "object") throw new Error(`${where}: rail ${i} on the ${side} side is not an object`);
    const bp = p as Record<string, unknown>;
    if (typeof bp.id !== "string" || !bp.id.includes("::")) {
      throw new Error(`${where}: rail ${i} on the ${side} side has no boundary id (containerId::childPortId)`);
    }
    if (!bp.id.startsWith(`${containerId}::`)) throw new Error(`${where}: rail "${bp.id}" belongs to another Beat`);
    for (const k of ["childId", "childPortId", "type", "label"] as const) {
      if (typeof bp[k] !== "string") throw new Error(`${where}: rail "${bp.id}" is missing ${k}`);
    }
    const fanout = Array.isArray(bp.fanout)
      ? (bp.fanout as unknown[]).flatMap((t): BoundaryTarget[] => {
          const r = t as Record<string, unknown> | null;
          return r && typeof r.childId === "string" && typeof r.childPortId === "string" ? [{ childId: r.childId, childPortId: r.childPortId }] : [];
        })
      : [];
    return {
      id: bp.id,
      childId: bp.childId as string,
      childPortId: bp.childPortId as string,
      type: bp.type as string,
      label: bp.label as string,
      ...(bp.forced ? { forced: true } : {}),
      ...(fanout.length ? { fanout } : {}),
    };
  });
}

/**
 * One node from its saved form. Ports are REBUILT from the kind and id rather than trusted:
 * every handle id embeds its node id, and a hand-edited file that disagrees would produce a
 * node whose wires never attach.
 */
export function deserializeNode(raw: unknown, index = 0): GraphNode<DirectorData> {
  if (!raw || typeof raw !== "object") throw new Error(`node ${index}: not an object`);
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== "string" || !n.id) throw new Error(`node ${index}: id must be a non-empty string`);
  const id = n.id;
  const where = `node "${id}"`;
  const pos = n.position as Record<string, unknown> | undefined;
  if (!pos || typeof pos !== "object" || !isNum(pos.x) || !isNum(pos.y)) throw new Error(`${where}: position must be { x, y } numbers`);
  const d = n.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") throw new Error(`${where}: data must be an object`);
  if (!isKind(d.kind)) throw new Error(`${where}: data.kind must be one of ${KINDS.join(", ")}`);
  const kind = d.kind;
  if (n.parentId !== undefined && (typeof n.parentId !== "string" || !n.parentId)) throw new Error(`${where}: parentId must be a node id`);
  const label = typeof d.label === "string" ? d.label : typeof d.heading === "string" ? d.heading : id;

  let type: string;
  let data: DirectorData;
  if (kind === "beat") {
    if (n.type !== undefined && n.type !== GROUP_TYPE && n.type !== SUBGRAPH_TYPE) {
      throw new Error(`${where}: a Beat's type is "${GROUP_TYPE}" or "${SUBGRAPH_TYPE}", not ${JSON.stringify(n.type)}`);
    }
    type = n.type === SUBGRAPH_TYPE ? SUBGRAPH_TYPE : GROUP_TYPE;
    data = { ...d, kind: "beat", label, promotedIn: railsOf(d.promotedIn, id, "in"), promotedOut: railsOf(d.promotedOut, id, "out") } as BeatData;
  } else {
    if (n.type !== undefined && n.type !== kind) throw new Error(`${where}: type ${JSON.stringify(n.type)} does not match data.kind "${kind}"`);
    type = kind;
    if (kind === "scene") {
      data = { ...d, kind, label, heading: typeof d.heading === "string" ? d.heading : label, ports: reportedPorts("scene", id) } as SceneData;
    } else if (kind === "asset") {
      if (!isAssetKind(d.asset)) throw new Error(`${where}: data.asset must be one of ${ASSET_KINDS.join(", ")}`);
      data = { ...d, kind, label, ports: reportedPorts("asset", id) } as AssetData;
    } else if (kind === "reroute") {
      if (!isPortType(d.portType)) throw new Error(`${where}: data.portType must be one of ${Object.keys(PORT_COLOR).join(", ")}`);
      data = { ...d, kind, label, ports: reportedPorts("reroute", id, d.portType) } as RerouteData;
    } else {
      data = { ...d, kind: "note", label, text: typeof d.text === "string" ? d.text : "", ports: [] } as NoteData;
    }
  }
  return {
    id,
    type,
    position: { x: pos.x, y: pos.y },
    ...(n.parentId ? { parentId: n.parentId as string } : {}),
    ...(isNum(n.width) ? { width: n.width } : {}),
    ...(isNum(n.height) ? { height: n.height } : {}),
    data: cleanData(data),
  };
}

function deserializeEdge(raw: unknown, index: number, byId: Map<string, GraphNode<DirectorData>>): GraphEdge {
  if (!raw || typeof raw !== "object") throw new Error(`edge ${index}: not an object`);
  const e = raw as Record<string, unknown>;
  for (const k of ["source", "target", "sourceHandle", "targetHandle"] as const) {
    if (typeof e[k] !== "string" || !e[k]) throw new Error(`edge ${index}: ${k} must be a non-empty string`);
  }
  const source = e.source as string;
  const target = e.target as string;
  const sourceHandle = e.sourceHandle as string;
  const targetHandle = e.targetHandle as string;
  if (!byId.has(source)) throw new Error(`edge ${index}: source "${source}" is not a node in this graph`);
  if (!byId.has(target)) throw new Error(`edge ${index}: target "${target}" is not a node in this graph`);
  // A handle id starts with its node's id (`sc-01:in:PROMPT`, `beat-1::…`), so a wire that
  // names a handle on some OTHER node is a wire that would never attach.
  if (!sourceHandle.startsWith(`${source}:`)) throw new Error(`edge ${index}: handle "${sourceHandle}" is not on node "${source}"`);
  if (!targetHandle.startsWith(`${target}:`)) throw new Error(`edge ${index}: handle "${targetHandle}" is not on node "${target}"`);
  const id = typeof e.id === "string" && e.id ? e.id : `lg:${sourceHandle}->${targetHandle}`;
  return { id, source, target, sourceHandle, targetHandle };
}

/**
 * Parse and check a saved graph. Throws an Error whose message says WHICH node or edge is
 * wrong and why — the note line shows it, so a bad paste is a diagnosis, not a shrug.
 * Accepts the JSON text or the already-parsed object.
 */
export function deserializeGraph(input: unknown): Graph {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (err) {
      throw new Error(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("a saved graph is an object: { version: 1, nodes: [], edges: [] }");
  const g = raw as Record<string, unknown>;
  if (g.version !== 1) throw new Error(`unsupported save version ${JSON.stringify(g.version)} — this editor reads version 1`);
  if (!Array.isArray(g.nodes)) throw new Error("nodes must be an array");
  if (g.edges !== undefined && !Array.isArray(g.edges)) throw new Error("edges must be an array");

  const nodes = (g.nodes as unknown[]).map((n, i) => deserializeNode(n, i));
  const byId = new Map<string, GraphNode<DirectorData>>();
  for (const n of nodes) {
    if (byId.has(n.id)) throw new Error(`duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (n.parentId === n.id) throw new Error(`node "${n.id}": a Beat cannot contain itself`);
    const parent = byId.get(n.parentId);
    if (!parent) throw new Error(`node "${n.id}": parentId "${n.parentId}" does not resolve`);
    if (parent.data.kind !== "beat") throw new Error(`node "${n.id}": parent "${n.parentId}" is not a Beat`);
    const seen = new Set<string>([n.id]);
    let cur: GraphNode<DirectorData> | undefined = parent;
    while (cur) {
      if (seen.has(cur.id)) throw new Error(`node "${n.id}": its Beats nest in a cycle`);
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  const edges = ((g.edges ?? []) as unknown[]).map((e, i) => deserializeEdge(e, i, byId));
  const edgeIds = new Set<string>();
  for (const e of edges) {
    if (edgeIds.has(e.id)) throw new Error(`duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
  }
  return { nodes: sortParentsFirst(nodes), edges };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Storage: the working graph and the named saves
// ─────────────────────────────────────────────────────────────────────────────────────────

const storage = (): Storage | undefined => (globalThis as { localStorage?: Storage }).localStorage;

export type SavesRegistry = Record<string, SavedGraph>;

const saveListeners = new Set<() => void>();
let savesCache: SavesRegistry | null = null;
const notifySaves = () => {
  for (const l of saveListeners) l();
};

export function loadSaves(): SavesRegistry {
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(SAVES_KEY) || "null");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as SavesRegistry) : {};
  } catch {
    return {};
  }
}

export function writeSaves(all: SavesRegistry): void {
  try {
    storage()?.setItem(SAVES_KEY, JSON.stringify(all));
  } catch {
    /* quota or storage disabled — the in-memory copy still serves this session */
  }
  savesCache = all;
  notifySaves();
}

/** Stable snapshot for `useSyncExternalStore`; refreshed by `writeSaves` and by another tab. */
export function getSavesSnapshot(): SavesRegistry {
  return (savesCache ??= loadSaves());
}

export function subscribeSaves(cb: () => void): () => void {
  saveListeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== SAVES_KEY) return;
    savesCache = null;
    cb();
  };
  const w = (globalThis as { addEventListener?: typeof addEventListener }).addEventListener ? (globalThis as unknown as Window) : null;
  w?.addEventListener("storage", onStorage);
  return () => {
    saveListeners.delete(cb);
    w?.removeEventListener("storage", onStorage);
  };
}

/** The autosaved working graph, or null when there is none or it does not parse. */
export function loadAutosave(): Graph | null {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(GRAPH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return deserializeGraph(raw);
  } catch (err) {
    // A corrupt autosave costs the working graph, never the editor: fall through to the demo.
    console.warn(`[director] ignoring the autosaved graph: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function writeAutosave(json: string): void {
  try {
    storage()?.setItem(GRAPH_KEY, json);
  } catch {
    /* quota or storage disabled */
  }
}

export function clearAutosave(): void {
  try {
    storage()?.removeItem(GRAPH_KEY);
  } catch {
    /* ignore */
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Autosave controller
// ─────────────────────────────────────────────────────────────────────────────────────────

export const AUTOSAVE_DEBOUNCE_MS = 600;

export interface AutosaveController {
  /** The canvas changed. Coalesced; ignored while a Calliope project is loaded or before `arm()`. */
  changed(): void;
  /**
   * Where the canvas lives now (null = the local graph). Arriving anywhere disarms: the first
   * store change after a load IS the load, and writing it would clobber the working graph
   * with the demo the moment a Calliope project is closed.
   */
  setProject(projectId: number | null): void;
  arm(): void;
  /** Write now if anything is pending — on pagehide, tab switch, unmount. */
  flush(): void;
  dispose(): void;
}

export function createAutosaver(opts: {
  /** The current graph as JSON — goes through `export_graph` so the edges are canonical. */
  read: () => Promise<string>;
  write?: (json: string) => void;
  debounceMs?: number;
}): AutosaveController {
  const write = opts.write ?? writeAutosave;
  const wait = opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  let projectId: number | null = null;
  let armed = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    cancel();
    if (!dirty || projectId !== null) return;
    dirty = false;
    void opts
      .read()
      .then((json) => {
        // The project may have changed while the read was in flight.
        if (projectId === null) write(json);
      })
      .catch(() => undefined);
  };
  return {
    changed() {
      if (!armed || projectId !== null) return;
      dirty = true;
      cancel();
      timer = setTimeout(flush, wait);
    },
    setProject(id) {
      if (id !== projectId) {
        cancel();
        dirty = false;
      }
      projectId = id;
      armed = false;
    },
    arm() {
      armed = true;
    },
    flush,
    dispose() {
      cancel();
      dirty = false;
      armed = false;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Export / import
// ─────────────────────────────────────────────────────────────────────────────────────────

export const exportFileName = (now = new Date()): string => `benjidirector-graph-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;

const clipboard = () => (globalThis as { navigator?: Navigator }).navigator?.clipboard;

export async function exportToClipboard(json: string): Promise<void> {
  const c = clipboard();
  if (!c?.writeText) throw new Error("clipboard is not available here");
  await c.writeText(json);
}

/** Download the JSON as a timestamped file. Returns the file name. */
export function exportToFile(json: string, now = new Date()): string {
  const name = exportFileName(now);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/** The clipboard's text — validated by `import_graph`, so one place owns the error messages. */
export async function importFromClipboard(): Promise<string> {
  const c = clipboard();
  if (!c?.readText) throw new Error("clipboard is not available here");
  return c.readText();
}

export const importFromFile = (file: File): Promise<string> => file.text();

export const clearCanvas = (): Graph => ({ nodes: [], edges: [] });
export const resetToDemo = (): Graph => demoProject();

// ─────────────────────────────────────────────────────────────────────────────────────────
// Drive commands — docs/drive-commands.md, U4
// ─────────────────────────────────────────────────────────────────────────────────────────

const asRF = (ns: GraphNode<DirectorData>[]) => ns as unknown as RFNode[];
const asRFEdges = (es: GraphEdge[]) => es as unknown as Edge[];
const asCore = (ns: RFNode[]) => ns as unknown as GraphNode<DirectorData>[];
const asCoreEdges = (es: Edge[]) => es as unknown as GraphEdge[];
const counts = (g: { nodes: unknown[]; edges: unknown[] }) => ({ nodes: g.nodes.length, edges: g.edges.length });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Yield to a fresh macrotask, so what follows is not part of the caller's React batch. */
export const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Replace the canvas wholesale.
 *
 * `loadProject(null)` is the editor's own "start over locally": it detaches the canvas from
 * whatever Calliope project was showing and clears undo — wanted here for the reason it
 * clears there, the ids belong to another graph — and then the graph goes in through the one
 * funnel. `reparent: false` because a saved parentId is the truth; `sync: false` because
 * nothing here is a Calliope row.
 *
 * The task hop between the two is load-bearing, and was measured rather than guessed. The
 * mutation funnel (`withCurrent`) calls `setEdges` from INSIDE the `setNodes` updater, which
 * React treats as a render-phase update; queued behind `loadProject`'s own five updates in ONE
 * batch — which is exactly what a click handler gives you — the render loops and the tab locks
 * up as soon as the incoming graph is non-trivial. `load_named` down the agent's path (already
 * its own task) returned in milliseconds while the same call inside an `onClick` never returned
 * at all, and `clear` — which settles nothing — survived both. One task apart, they agree.
 */
export async function replaceGraph(kit: DriveKit, g: Graph): Promise<void> {
  await kit.loadProject(null);
  await nextTask();
  await kit.run(
    () => {
      kit.settle(asRF(sortParentsFirst(g.nodes)), asRFEdges(g.edges), { reparent: false, sync: false });
    },
    { history: false },
  );
}

const readCurrent = (kit: DriveKit) => kit.run((ns, es) => serializeGraph(asCore(ns), asCoreEdges(es)), { history: false });

registerDriveCommands({
  export_graph: async (args, kit) => {
    const g = await readCurrent(kit);
    return { json: args.pretty === false ? JSON.stringify(g) : JSON.stringify(g, null, 2), ...counts(g) };
  },
  import_graph: async (args, kit) => {
    if (args.json === undefined || args.json === null) throw new Error("json is required — the text export_graph returns");
    const g = deserializeGraph(args.json);
    await replaceGraph(kit, g);
    kit.setNote(`imported ${plural(g.nodes.length, "node")}, ${plural(g.edges.length, "wire")}`);
    return counts(g);
  },
  save_named: async (args, kit) => {
    const name = kit.str(args.name, "name").trim();
    if (!name) throw new Error("name must be a non-empty string");
    const g = await readCurrent(kit);
    const all = loadSaves();
    const replaced = name in all;
    writeSaves({ ...all, [name]: { ...g, savedAt: Date.now() } });
    kit.setNote(`${replaced ? "updated" : "saved"} “${name}” — ${plural(g.nodes.length, "node")}`);
    return { name, replaced, ...counts(g) };
  },
  load_named: async (args, kit) => {
    const name = kit.str(args.name, "name");
    const saved = loadSaves()[name];
    if (!saved) throw new Error(`no save "${name}" — list_saves names them`);
    const g = deserializeGraph(saved);
    await replaceGraph(kit, g);
    kit.setNote(`loaded “${name}” — ${plural(g.nodes.length, "node")}, ${plural(g.edges.length, "wire")}`);
    return { name, ...counts(g) };
  },
  list_saves: () =>
    Object.entries(loadSaves())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, g]) => ({
        name,
        nodes: Array.isArray(g.nodes) ? g.nodes.length : 0,
        edges: Array.isArray(g.edges) ? g.edges.length : 0,
        savedAt: typeof g.savedAt === "number" ? g.savedAt : null,
      })),
  delete_save: (args, kit) => {
    const name = kit.str(args.name, "name");
    const all = loadSaves();
    if (!(name in all)) throw new Error(`no save "${name}" — list_saves names them`);
    const { [name]: _gone, ...rest } = all;
    writeSaves(rest);
    kit.setNote(`deleted save “${name}”`);
    return { deleted: name };
  },
  clear: async (_args, kit) => {
    const g = clearCanvas();
    await replaceGraph(kit, g);
    // Written now rather than on the next autosave tick, so a reload in the next half second
    // does not bring the cleared graph back.
    writeAutosave(JSON.stringify(serializeGraph(g.nodes, g.edges)));
    kit.setNote("canvas cleared");
    return counts(g);
  },
  reset_demo: async (_args, kit) => {
    await kit.loadProject(null);
    const g = resetToDemo();
    writeAutosave(JSON.stringify(serializeGraph(g.nodes, g.edges)));
    return counts(g);
  },
});
