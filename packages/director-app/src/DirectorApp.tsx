// The editor.
//
// Every structural change funnels through `settle()`, which is the only place that knows the
// correct order of operations: re-parent by geometry, order parents before children for React
// Flow, reconcile every promoted Beat's boundary, then apply collapse visibility and edge
// colour. Doing those in any other order produces rails that lag a frame behind the graph.
//
// The agent drives this through the SAME callbacks the mouse does — `drive` is a thin wrapper
// over these handlers, never a parallel implementation. That is ifr-node-lab's rule and it is
// why a tool call cannot bypass a validation the UI enforces.

import {
  Background,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type ConnectionLineComponentProps,
  type Edge,
  type FinalConnectionState,
  type Node,
} from "@xyflow/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  absolutePos,
  boundaryPortId,
  containmentFor,
  dissolveSubgraph,
  innerHandleId,
  parseEmptySlotHandle,
  promoteToSubgraph,
  reconcileBoundary,
  sortParentsFirst,
  uniquifyLabel,
  type BoundaryPort,
  type GraphEdge,
  type GraphNode, isRelayHandle } from "@benjidirector/graph-core";
import { CalliopeClient, probe, resolveConfig, type ReachabilityState, type Schemas } from "@benjidirector/calliope-client";
import { calId, calliopeRef, projectToGraph } from "./calliope-bind.js";
import { applyIntents, diffForCalliope } from "./calliope-sync.js";
import { applyTopology, captureTopology, loadTopology, saveTopology, type RailLabels } from "./topology.js";
import { ActionsContext, type EditorActions } from "./actions.js";
import {
  blueprintIdFromName,
  instantiateBlueprint,
  loadBlueprints,
  serializeSubtree,
  writeBlueprints,
  type Blueprint,
} from "./blueprints.js";
import { EdgeActionsContext, edgeTypes, type EdgeActions } from "./edges.jsx";
import {
  PORT_COLOR,
  beat,
  demoProject,
  directorHost,
  makeNode,
  type AssetData,
  type BeatData,
  type DirectorData,
  type DirectorPortType,
  type NodeKind,
  type PromotedFace,
  type SceneData,
} from "./model.js";
import { nodeTypes } from "./nodes.jsx";
import { Palette, type PaletteItem } from "./palette.jsx";

// React Flow types node data as an index signature; ours are interfaces. Identical at runtime,
// so the casts stay confined to these aliases.
type RFNode = Node & { data: DirectorData };
const asCore = (ns: RFNode[]) => ns as unknown as GraphNode<DirectorData>[];
const asRF = (ns: GraphNode<DirectorData>[]) => ns as unknown as RFNode[];
const asCoreEdges = (es: Edge[]) => es as unknown as GraphEdge[];
const asRFEdges = (es: GraphEdge[]) => es as unknown as Edge[];

const isContainer = (n: RFNode | undefined) => !!n && (n.type === GROUP_TYPE || n.type === SUBGRAPH_TYPE);
const rails = (n: RFNode) => n.data as unknown as BeatData;
const portsOf = (n: RFNode | undefined) => ((n?.data as SceneData | undefined)?.ports ?? []);

/** Every handle on the canvas -> its port type, so an edge can be coloured by what it carries. */
function handleTypes(nodes: RFNode[]): Map<string, DirectorPortType> {
  const m = new Map<string, DirectorPortType>();
  for (const n of nodes) {
    for (const p of portsOf(n)) m.set(p.id, p.type as DirectorPortType);
    if (!isContainer(n)) continue;
    for (const bp of [...rails(n).promotedIn, ...rails(n).promotedOut]) {
      m.set(bp.id, bp.type as DirectorPortType);
      m.set(innerHandleId(bp.id), bp.type as DirectorPortType);
    }
  }
  return m;
}

/**
 * Colour each edge by what it carries, hide anything inside a collapsed Beat, derive each
 * container's face and each node's "inside a subgraph" flag.
 *
 * A node is hidden when ANY ancestor is a collapsed subgraph — not just its direct parent, or
 * a Beat nested two deep would keep rendering its grandchildren on top of the collapsed card.
 * Edges follow their endpoints, which is what makes the inner relays disappear with the
 * children while the outer halves keep terminating on the collapsed card's rails.
 */
function decorate(nodes: RFNode[], edges: Edge[]): { nodes: RFNode[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const collapsed = new Set(nodes.filter((n) => n.type === SUBGRAPH_TYPE && rails(n).collapsed).map((n) => n.id));

  const ancestorMatches = (n: RFNode, pred: (ancestor: RFNode) => boolean): boolean => {
    let p = n.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const a = byId.get(p);
      if (a && pred(a)) return true;
      p = a?.parentId;
    }
    return false;
  };

  const outNodes0 = nodes.map((n) => {
    const hide = ancestorMatches(n, (a) => collapsed.has(a.id));
    return !!n.hidden === hide ? n : ({ ...n, hidden: hide } as RFNode);
  });

  // A collapsed Beat's face is DERIVED from which descendants are pinned — never stored by
  // hand. Descendants, not children: a pin two levels down still belongs to the outermost
  // collapsed card, because that is the only card the user can still see.
  const descendantsOf = (containerId: string) => outNodes0.filter((n) => ancestorMatches(n, (a) => a.id === containerId));

  const outNodes = outNodes0.map((n) => {
    if (!isContainer(n)) {
      // A pin only means something inside a SUBGRAPH: it decides what shows on that subgraph's
      // collapsed face. On a naked node, or one in a plain group, there is no face to show on.
      const within = ancestorMatches(n, (a) => a.type === SUBGRAPH_TYPE);
      return (n.data as SceneData).inSubgraph === within ? n : ({ ...n, data: { ...n.data, inSubgraph: within } } as RFNode);
    }
    const faces: PromotedFace[] = descendantsOf(n.id)
      .filter((c) => (c.data as SceneData).promoted)
      .map((c) => {
        const d = c.data as SceneData | AssetData;
        return d.kind === "scene"
          ? { id: c.id, kind: "scene", label: d.heading ?? d.label, durationSec: d.durationSec, videoPath: d.videoPath }
          : { id: c.id, kind: "asset", label: d.label, assetKind: d.asset };
      });
    const prev = rails(n).faces ?? [];
    const same =
      prev.length === faces.length &&
      prev.every((f, i) => {
        const g = faces[i];
        return !!g && f.id === g.id && f.label === g.label && f.durationSec === g.durationSec && f.videoPath === g.videoPath;
      });
    return same ? n : ({ ...n, data: { ...n.data, faces } } as RFNode);
  });

  const hidden = new Set(outNodes.filter((n) => n.hidden).map((n) => n.id));
  const types = handleTypes(outNodes);

  const outEdges = edges.map((e) => {
    const hide = hidden.has(e.source) || hidden.has(e.target);
    const t = types.get(e.sourceHandle ?? "") ?? types.get(e.targetHandle ?? "");
    const stroke = t ? PORT_COLOR[t] : "#9ca3af";
    const style = { stroke, strokeWidth: 2 };
    const same = !!e.hidden === hide && (e.style as { stroke?: string } | undefined)?.stroke === stroke && e.type === "director";
    return same ? e : { ...e, type: "director", hidden: hide, style };
  });

  return { nodes: outNodes, edges: outEdges };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Carrying a wire
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A wire picked up from its INPUT end.
 *
 * Grabbing a connected input handle detaches the wire and lets you carry its target end —
 * the LiteGraph / IFR feel — rather than starting a second connection. React Flow starts the
 * drag from the handle you pressed, so the connection line would normally draw from the
 * input; `CarryLine` draws it from the ORIGINAL source instead, so what you see is the wire
 * you picked up.
 */
interface Carry {
  sourceNode: string;
  sourceHandle: string;
  type: DirectorPortType;
  from: { x: number; y: number };
}
const CarryContext = createContext<{ current: Carry | null }>({ current: null });

function CarryLine(props: ConnectionLineComponentProps) {
  const carry = useContext(CarryContext).current;
  const fromX = carry ? carry.from.x : props.fromX;
  const fromY = carry ? carry.from.y : props.fromY;
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: carry ? Position.Right : props.fromPosition,
    targetX: props.toX,
    targetY: props.toY,
    targetPosition: props.toPosition,
  });
  const stroke = carry ? PORT_COLOR[carry.type] : "#9ca3af";
  return (
    <g>
      <path d={path} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray="6 4" className="bd-carry-line" />
      <circle cx={props.toX} cy={props.toY} r={4} fill={stroke} />
    </g>
  );
}

/** What a palette opened by a dropped wire knows: the fixed end, and which side it needs. */
interface WireIntent {
  node: string;
  handle: string;
  type: DirectorPortType;
  lookingFor: "input" | "output";
}

interface PaletteState {
  x: number;
  y: number;
  flow: { x: number; y: number };
  wire: WireIntent | null;
}

/** One editor command by name, as the agent drives it. Rejects with a readable Error. */
export type DriveFn = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface DirectorAppProps {
  calliopeBaseUrl?: string;
  /** Filled by the editor on mount; the bundle's `drive()` calls through it. */
  apiRef?: { current: DriveFn | null };
}

function Editor({ calliopeBaseUrl, apiRef }: DirectorAppProps) {
  // Decorate ONCE at state init rather than in a mount effect. An effect that reaches for the
  // `nodes` state of its own first render to rebuild `edges` is a footgun: it ran, produced an
  // empty edge set, and the canvas came up with six nodes and no wires at all.
  const initial = useMemo(() => {
    const p = demoProject();
    return decorate(asRF(p.nodes as GraphNode<DirectorData>[]), asRFEdges(p.edges));
  }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [status, setStatus] = useState<ReachabilityState | null>(null);
  const [note, setNote] = useState("");
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [blueprints, setBlueprints] = useState<Record<string, Blueprint>>(() => loadBlueprints());
  const [projects, setProjects] = useState<Schemas["Project"][]>([]);
  const [loadedProject, setLoadedProject] = useState<number | null>(null);
  const loadedProjectRef = useRef<number | null>(null);
  loadedProjectRef.current = loadedProject;
  /** Each loaded scene's current video_settings, so a director write merges rather than clobbers. */
  const settingsCache = useRef(new Map<number, Record<string, unknown>>());
  const [syncState, setSyncState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  /**
   * Undo.
   *
   * Non-negotiable here in a way it is not in an ordinary editor: the AGENT edits this graph
   * too, so the user needs a way back from a change they did not make and may not have been
   * watching.
   */
  const history = useRef<{ nodes: RFNode[]; edges: Edge[] }[]>([]);
  const future = useRef<{ nodes: RFNode[]; edges: Edge[] }[]>([]);
  const restoring = useRef(false);
  const HISTORY_MAX = 60;
  const { screenToFlowPosition, getInternalNode } = useReactFlow();

  /**
   * Force React Flow to measure.
   *
   * The pane mounts inside the side panel's overlay while it is sliding in, and React Flow's
   * own ResizeObserver pass does not land in that window: nodes keep `visibility: hidden`
   * (its marker for "not measured"), and because an edge only renders once BOTH endpoints are
   * measured, the canvas comes up with nodes you cannot see and no wires at all.
   * `updateNodeInternals` re-reads dimensions and handle bounds straight from the DOM.
   */
  const updateNodeInternals = useUpdateNodeInternals();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodeIds = useMemo(() => (nodes as RFNode[]).map((n) => n.id).join(","), [nodes]);
  useEffect(() => {
    const ids = nodeIds ? nodeIds.split(",") : [];
    if (!ids.length) return undefined;
    const kick = () => updateNodeInternals(ids);
    // A hidden tab suspends ResizeObserver entirely, so the fixed timers below can all fire
    // into a tab nothing will measure. Keep nudging on a slow interval until every node
    // reports a size, and again the moment the tab becomes visible — bounded, so a node that
    // genuinely cannot measure does not keep a timer alive forever.
    const allMeasured = () => ids.every((id) => !!getInternalNode(id)?.measured?.width);
    let tries = 0;
    const iv = setInterval(() => {
      if (allMeasured() || tries++ > 120) {
        clearInterval(iv);
        return;
      }
      kick();
    }, 500);
    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisible);
    const raf = requestAnimationFrame(kick);
    const timers = [setTimeout(kick, 120), setTimeout(kick, 400), setTimeout(kick, 900)];
    const el = canvasRef.current;
    const ro = el ? new ResizeObserver(() => kick()) : null;
    if (el && ro) ro.observe(el);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      ro?.disconnect();
    };
  }, [getInternalNode, nodeIds, updateNodeInternals]);

  const config = useMemo(() => resolveConfig(calliopeBaseUrl ? { baseUrl: calliopeBaseUrl } : {}), [calliopeBaseUrl]);
  const client = useMemo(() => new CalliopeClient(config), [config]);
  useEffect(() => {
    let live = true;
    probe(config).then((s) => {
      if (!live) return;
      setStatus(s);
      if (s.reachable) client.projects.list().then((ps) => live && setProjects(ps)).catch(() => undefined);
    });
    return () => {
      live = false;
    };
  }, [client, config]);

  /** Bring the graph back to a consistent state. Order is not interchangeable. */
  const settle = useCallback(
    (ns: RFNode[], es: Edge[], opts: { reparent?: boolean; sync?: boolean; prev?: { nodes: RFNode[]; edges: Edge[] }; railLabels?: RailLabels } = {}) => {
      // settle receives the arrays a caller has ALREADY mutated, so it is the wrong place to
      // snapshot for undo — that recorded the post-change state and made every undo a no-op.
      let core = asCore(ns);
      if (opts.reparent !== false) core = core.map((n) => containmentFor(n, core));
      core = sortParentsFirst(core);
      let coreEdges = asCoreEdges(es);
      for (const n of core) {
        if (n.type !== SUBGRAPH_TYPE) continue;
        const out = reconcileBoundary(n.id, core, coreEdges, directorHost);
        core = out.nodes;
        coreEdges = out.edges;
      }
      // Rail labels from the topology sidecar: applied once the rails exist. A rail that is
      // not in the map keeps the label reconcile gave it.
      if (opts.railLabels) {
        const labels = opts.railLabels;
        core = core.map((n) => {
          const saved = labels[n.id];
          if (!saved || n.type !== SUBGRAPH_TYPE) return n;
          const d = n.data as BeatData;
          const relabel = (ports: BeatData["promotedIn"]) => ports.map((p) => (saved[p.id] ? { ...p, label: saved[p.id] } : p));
          return { ...n, data: { ...d, promotedIn: relabel(d.promotedIn), promotedOut: relabel(d.promotedOut) } } as GraphNode<DirectorData>;
        });
      }
      const done = decorate(asRF(core), asRFEdges(coreEdges));
      // Write-back: what this settle changed about Calliope-backed scenes. Diffed against the
      // graph as it stood BEFORE (the refs), so a change is written once, not on every render.
      const pid = loadedProjectRef.current;
      if (pid !== null && opts.sync !== false) {
        const prev = opts.prev ?? { nodes: nodesRef.current as RFNode[], edges: edgesRef.current };
        const intents = diffForCalliope(
          { nodes: asCore(prev.nodes), edges: asCoreEdges(prev.edges) },
          { nodes: asCore(done.nodes), edges: asCoreEdges(done.edges) },
        );
        if (intents.length) {
          setSyncState("saving");
          void applyIntents(client, pid, intents, settingsCache.current).then((r) => {
            if (!r.failed.length) {
              setSyncState("saved");
              return;
            }
            setSyncState("error");
            setNote(`Calliope did not keep ${r.failed.length} change(s): ${r.failed[0]?.error ?? ""}`);
            // A Beat move Calliope would not keep is snapped back where it was, so the canvas
            // never shows a topology the film does not have — a reload would have reverted it
            // silently, which is the worse surprise.
            const snapBack = new Set(r.failed.filter((f) => f.field === "beat_id").map((f) => calId.scene(f.sceneId)));
            if (!snapBack.size) return;
            const prevById = new Map(prev.nodes.map((n) => [n.id, n] as const));
            settleRef.current(
              (nodesRef.current as RFNode[]).map((n) => {
                const was = snapBack.has(n.id) ? prevById.get(n.id) : undefined;
                return was ? ({ ...n, parentId: was.parentId, position: was.position } as RFNode) : n;
              }),
              edgesRef.current,
              // Synced on purpose: the same PATCH carried a position Calliope DID keep, so the
              // snap-back writes the restored position (and the Beat it never left) back too.
              { reparent: false },
            );
          });
        }
      }
      setNodes(done.nodes);
      setEdges(done.edges);
    },
    [client, setEdges, setNodes],
  );

  const pushHistory = useCallback((ns: RFNode[], es: Edge[]) => {
    if (restoring.current) return;
    history.current.push({ nodes: ns, edges: es });
    if (history.current.length > HISTORY_MAX) history.current.shift();
    future.current = [];
  }, []);

  /** Run `fn` against the CURRENT state, snapshotting it for undo first unless told not to. */
  const withCurrent = useCallback(
    (fn: (ns: RFNode[], es: Edge[]) => void, opts: { history?: boolean } = {}) => {
      setNodes((ns) => {
        setEdges((es) => {
          queueMicrotask(() => {
            if (opts.history !== false) pushHistory(ns as RFNode[], es);
            fn(ns as RFNode[], es);
          });
          return es;
        });
        return ns;
      });
    },
    [pushHistory, setEdges, setNodes],
  );

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return setNote("nothing to undo");
    restoring.current = true;
    withCurrent(
      (ns, es) => {
        future.current.push({ nodes: ns, edges: es });
        const done = decorate(prev.nodes, prev.edges);
        setNodes(done.nodes);
        setEdges(done.edges);
        restoring.current = false;
        setNote("undo");
      },
      { history: false },
    );
    return undefined;
  }, [setEdges, setNodes, withCurrent]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return setNote("nothing to redo");
    restoring.current = true;
    withCurrent(
      (ns, es) => {
        history.current.push({ nodes: ns, edges: es });
        const done = decorate(next.nodes, next.edges);
        setNodes(done.nodes);
        setEdges(done.edges);
        restoring.current = false;
        setNote("redo");
      },
      { history: false },
    );
    return undefined;
  }, [setEdges, setNodes, withCurrent]);

  // Ctrl/Cmd+Z and Ctrl+Shift+Z, scoped to the pane so they never steal ComfyUI's own undo
  // while the user is working on the canvas behind us.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const root = canvasRef.current?.closest(".bd-root");
      if (!root || (!root.contains(document.activeElement) && !root.matches(":hover"))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [redo, undo]);

  /** Repair: treat the EDGES as the source of truth and re-derive every boundary from them. */
  const repair = useCallback(() => {
    withCurrent((ns, es) => {
      settle(ns, es, { reparent: true });
      setNote("repaired — boundaries re-derived from the wires");
    });
  }, [settle, withCurrent]);

  // A drag already landed in state before we see it, so recording it would undo to the same
  // place. Undo covers structural edits, not raw node moves.
  // Topology sidecar: remember the loaded project's Beat-level state whenever it changes.
  // Debounced so a drag writes once, and keyed by project so two films never share a layout.
  useEffect(() => {
    if (loadedProject === null) return;
    const t = setTimeout(() => saveTopology(loadedProject, captureTopology(asCore(nodes as RFNode[]))), 300);
    return () => clearTimeout(t);
  }, [nodes, loadedProject]);

  /** The graph as it stood when a drag began — the write-back baseline, see settle(). */
  const dragBaseline = useRef<{ nodes: RFNode[]; edges: Edge[] } | null>(null);
  const onNodeDragStart = useCallback(() => {
    dragBaseline.current = { nodes: nodesRef.current as RFNode[], edges: edgesRef.current };
  }, []);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const onNodeDragStop = useCallback(() => {
    const prev = dragBaseline.current ?? undefined;
    dragBaseline.current = null;
    withCurrent((ns, es) => settle(ns, es, { prev }), { history: false });
  }, [settle, withCurrent]);

  /**
   * Load a Calliope project onto the canvas.
   *
   * Replaces the graph wholesale — a project is a different film, not an edit to this one —
   * and clears undo, because undoing across a load would restore a graph whose ids belong to
   * another project's rows. Beats are loaded as plain groups; promoting is the user's (or the
   * agent's) call, and reconcile derives the rails from the wires Calliope already knows.
   */
  const loadProject = useCallback(
    async (projectId: number | null) => {
      if (projectId === null) {
        const p = demoProject();
        const done = decorate(asRF(p.nodes as GraphNode<DirectorData>[]), asRFEdges(p.edges));
        history.current = [];
        future.current = [];
        setNodes(done.nodes);
        setEdges(done.edges);
        setLoadedProject(null);
        setNote("demo project");
        return;
      }
      try {
        const [story, scenesRes] = await Promise.all([client.story.get(projectId), client.scenes.list(projectId)]);
        settingsCache.current = new Map(scenesRes.scenes.map((sc) => [sc.id, sc.video_settings ?? {}]));
        setSyncState("idle");
        const g = projectToGraph({ story, scenes: scenesRes.scenes });
        // Beat-level topology (subgraph-ness, collapse, colour, box, rail labels) lives in the
        // local sidecar; a missing one costs a colour scheme, never a wire.
        const laid = applyTopology(g.nodes as GraphNode<DirectorData>[], g.edges, loadTopology(projectId), directorHost);
        history.current = [];
        future.current = [];
        loadedProjectRef.current = projectId;
        settle(asRF(sortParentsFirst(laid.nodes)), asRFEdges(laid.edges), { sync: false, railLabels: laid.railLabels });
        setLoadedProject(projectId);
        setNote(`loaded “${story.project.title}” — ${story.beats.length} beats, ${scenesRes.scenes.length} scenes, ~${scenesRes.estimated_duration_sec}s`);
      } catch (err) {
        setNote(`could not load project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [client, setEdges, setNodes],
  );

  /**
   * Re-read the loaded project and MERGE it into the canvas.
   *
   * Unlike loadProject this keeps everything Calliope cannot store — a Beat's subgraph-ness,
   * collapse, colour and size, the rails, and the positions dragged since — because an agent
   * that adds one scene must not cost the user their layout. Calliope stays authoritative for
   * what it does own: which Beat a scene is in, the ref and continuity wires, the rows
   * themselves. Rows that vanished leave the canvas; rows that appeared are laid out fresh.
   * Not an edit, so it neither writes back nor lands in undo.
   */
  const refreshProject = useCallback(async () => {
    const pid = loadedProjectRef.current;
    if (pid === null) return;
    const [story, scenesRes] = await Promise.all([client.story.get(pid), client.scenes.list(pid)]);
    settingsCache.current = new Map(scenesRes.scenes.map((sc) => [sc.id, sc.video_settings ?? {}]));
    const fresh = projectToGraph({ story, scenes: scenesRes.scenes });
    const current = asCore(nodesRef.current as RFNode[]);
    const cur = new Map(current.map((n) => [n.id, n] as const));
    const KEEP = ["color", "collapsed", "expandedWidth", "expandedHeight", "collapsedWidth", "collapsedHeight", "promoted"] as const;
    const merged: GraphNode<DirectorData>[] = fresh.nodes.map((fn) => {
      const c = cur.get(fn.id);
      if (!c) return fn as GraphNode<DirectorData>;
      const keep: Record<string, unknown> = {};
      for (const k of KEEP) if (k in c.data) keep[k] = (c.data as unknown as Record<string, unknown>)[k];
      // A scene's Beat is Calliope's call; if it changed, the fresh layout inside the new Beat
      // is the only sensible position. Otherwise the canvas position wins.
      const isScene = fn.data.kind === "scene";
      const moved = isScene && (c.parentId ?? undefined) !== (fn.parentId ?? undefined);
      return {
        ...fn,
        type: c.type ?? fn.type,
        parentId: isScene ? fn.parentId : c.parentId,
        position: moved ? fn.position : c.position,
        width: c.width ?? fn.width,
        height: c.height ?? fn.height,
        data: { ...fn.data, ...keep },
      } as GraphNode<DirectorData>;
    });
    const freshIds = new Set(merged.map((n) => n.id));
    // Nodes the editor invented have no row to vanish from; they stay.
    for (const c of current) if (!calliopeRef(c.id) && !freshIds.has(c.id)) merged.push(c);
    const keptIds = new Set(merged.map((n) => n.id));
    const localEdges = asCoreEdges(edgesRef.current).filter(
      (e) => keptIds.has(e.source) && keptIds.has(e.target) && (!calliopeRef(e.source) || !calliopeRef(e.target)) && !isRelayHandle(e.sourceHandle) && !isRelayHandle(e.targetHandle),
    );
    const edgeIds = new Set(fresh.edges.map((e) => e.id));
    const edges = [...fresh.edges, ...localEdges.filter((e) => !edgeIds.has(e.id))];
    settle(asRF(sortParentsFirst(merged)), asRFEdges(edges), { sync: false });
    setNote(`refreshed “${story.project.title}” — ${story.beats.length} beats, ${scenesRes.scenes.length} scenes, ~${scenesRes.estimated_duration_sec}s`);
  }, [client, settle]);

  /** Canvas-relative menu coordinates. `fixed` would resolve against the panel's transform. */
  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
  }, []);

  const openPalette = useCallback(
    (clientX: number, clientY: number, wire: WireIntent | null) => {
      setPalette({ ...canvasPoint(clientX, clientY), flow: screenToFlowPosition({ x: clientX, y: clientY }), wire });
    },
    [canvasPoint, screenToFlowPosition],
  );

  // ── wiring ───────────────────────────────────────────────────────────────────────────

  const carryRef = useRef<{ current: Carry | null }>({ current: null });
  const connectStartRef = useRef<{ node: string; handle: string; handleType: "source" | "target" } | null>(null);

  /** Add a wire, replacing whatever was on the target socket — an input takes one cable. */
  const addWire = useCallback(
    (source: string, sourceHandle: string, target: string, targetHandle: string) => {
      const edge: Edge = { id: `lg:${sourceHandle}->${targetHandle}`, source, target, sourceHandle, targetHandle };
      withCurrent((ns, es) => {
        const kept = es.filter((e) => !(e.target === target && e.targetHandle === targetHandle));
        settle(ns, [...kept, edge], { reparent: false });
      });
    },
    [settle, withCurrent],
  );

  const onConnectStart = useCallback(
    (_e: unknown, params: { nodeId: string | null; handleId: string | null; handleType: "source" | "target" | null }) => {
      if (!params.nodeId || !params.handleId || !params.handleType) return;
      connectStartRef.current = { node: params.nodeId, handle: params.handleId, handleType: params.handleType };
      carryRef.current.current = null;
      if (params.handleType !== "target") return;

      // Pressing a CONNECTED input picks its wire up instead of starting a second one.
      const existing = edgesRef.current.find((e) => e.target === params.nodeId && e.targetHandle === params.handleId);
      if (!existing || !existing.sourceHandle) return;
      const src = getInternalNode(existing.source);
      const hb = src?.internals.handleBounds?.source?.find((h) => h.id === existing.sourceHandle);
      const type = handleTypes(nodesRef.current as RFNode[]).get(existing.sourceHandle) ?? "image";
      const from = src && hb
        ? { x: src.internals.positionAbsolute.x + hb.x + hb.width / 2, y: src.internals.positionAbsolute.y + hb.y + hb.height / 2 }
        : { x: 0, y: 0 };
      carryRef.current.current = { sourceNode: existing.source, sourceHandle: existing.sourceHandle, type, from };
      withCurrent((ns, es) => settle(ns, es.filter((e) => e.id !== existing.id), { reparent: false }));
    },
    [getInternalNode, settle, withCurrent],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      const carry = carryRef.current.current;
      carryRef.current.current = null;
      const start = connectStartRef.current;
      connectStartRef.current = null;
      if (state.isValid) return; // onConnect took it

      // A carried wire dropped on ANOTHER input: re-route it there.
      if (carry && state.toHandle?.type === "target" && state.toNode && state.toHandle.id) {
        addWire(carry.sourceNode, carry.sourceHandle, state.toNode.id, state.toHandle.id);
        return;
      }

      // Dropped into space (the pane, or a Beat's empty body): offer a node to wire to.
      const el = event.target as Element | null;
      const onPane = !!el && (el.classList.contains("react-flow__pane") || el.classList.contains("react-flow__background"));
      const inGroupBody =
        !!el?.closest(".bd-group") &&
        !el.closest(".bd-group-title") &&
        !el.closest("button") &&
        !el.closest(".react-flow__handle") &&
        !el.closest(".bd-rail");
      if (!onPane && !inGroupBody) return;

      const clientX = "clientX" in event ? event.clientX : (event.touches?.[0]?.clientX ?? 0);
      const clientY = "clientY" in event ? event.clientY : (event.touches?.[0]?.clientY ?? 0);
      const types = handleTypes(nodesRef.current as RFNode[]);
      let wire: WireIntent | null = null;
      if (carry) wire = { node: carry.sourceNode, handle: carry.sourceHandle, type: carry.type, lookingFor: "input" };
      else if (start) {
        const t = types.get(start.handle);
        if (t) wire = { node: start.node, handle: start.handle, type: t, lookingFor: start.handleType === "source" ? "input" : "output" };
      }
      openPalette(clientX, clientY, wire);
    },
    [addWire, openPalette],
  );

  /**
   * Connect.
   *
   * The one special case is the trailing `+` slot on a rail: wiring a CHILD into it authors a
   * new pinned boundary port. Only the slot's INNER handle can do that, because a boundary port
   * has to know which child port it aliases.
   */
  const onConnect = useCallback(
    (c: Connection) => {
      const slotFrom = parseEmptySlotHandle(c.sourceHandle);
      const slotTo = parseEmptySlotHandle(c.targetHandle);
      const slot = slotFrom ?? slotTo;

      if (slot) {
        if (!slot.inner) {
          setNote("drop the wire on a child's side of the + slot — an outer wire names no child to expose");
          return;
        }
        const childId = slotFrom ? c.target : c.source;
        const childPortId = (slotFrom ? c.targetHandle : c.sourceHandle) ?? "";
        withCurrent((ns, es) => {
          const container = ns.find((n) => n.id === slot.containerId);
          const child = ns.find((n) => n.id === childId);
          if (!container || !child) return;
          const port = portsOf(child).find((p) => p.id === childPortId);
          if (!port) {
            setNote("that port is not one this node exposes");
            return;
          }
          const list = slot.side === "in" ? rails(container).promotedIn : rails(container).promotedOut;
          const id = boundaryPortId(slot.containerId, childPortId);
          if (list.some((p) => p.id === id)) {
            setNote(`${port.label} is already on the rail`);
            return;
          }
          const bp: BoundaryPort = {
            id,
            childId,
            childPortId,
            type: port.type,
            label: uniquifyLabel(port.label, new Set(list.map((p) => p.label))),
            forced: true,
          };
          const nextNodes = ns.map((n) =>
            n.id !== slot.containerId
              ? n
              : ({
                  ...n,
                  data: {
                    ...n.data,
                    promotedIn: slot.side === "in" ? [...rails(n).promotedIn, bp] : rails(n).promotedIn,
                    promotedOut: slot.side === "out" ? [...rails(n).promotedOut, bp] : rails(n).promotedOut,
                  },
                } as RFNode),
          );
          setNote(`added ${bp.label} to the ${slot.side} rail — pinned, so it stays without a wire`);
          settle(nextNodes, es, { reparent: false });
        });
        return;
      }

      if (!c.source || !c.target || !c.sourceHandle || !c.targetHandle) return;
      addWire(c.source, c.sourceHandle, c.target, c.targetHandle);
    },
    [addWire, settle, withCurrent],
  );

  // ── nodes ────────────────────────────────────────────────────────────────────────────

  /** Place a node from the palette and, if a wire was being dragged, connect it. */
  const placeNode = useCallback(
    (kind: NodeKind, at: { x: number; y: number }, wire: WireIntent | null) => {
      const node = makeNode(kind, at);
      setPalette(null);
      withCurrent((ns, es) => {
        let nextEdges = es;
        if (wire) {
          const ports = portsOf(node as unknown as RFNode);
          const match = ports.find((p) => p.type === wire.type && (wire.lookingFor === "input" ? p.isInput : !p.isInput));
          if (match) {
            const [source, sh, target, th] =
              wire.lookingFor === "input" ? [wire.node, wire.handle, node.id, match.id] : [node.id, match.id, wire.node, wire.handle];
            nextEdges = [
              ...es.filter((e) => !(e.target === target && e.targetHandle === th)),
              { id: `lg:${sh}->${th}`, source, target, sourceHandle: sh, targetHandle: th },
            ];
          } else setNote(`${node.data.label} has no ${wire.type} ${wire.lookingFor} to wire to — placed unwired`);
        }
        // Reparent ON: dropping inside a Beat should join it, exactly as a drag would.
        settle([...ns, node as unknown as RFNode], nextEdges);
        setNote((s) => s || `added ${node.data.label}`);
      });
    },
    [settle, withCurrent],
  );

  /** Stamp a blueprint at a position and, if it was saved as a subgraph, promote it again. */
  const placeBlueprint = useCallback(
    (bp: Blueprint, at: { x: number; y: number }) => {
      setPalette(null);
      withCurrent((ns, es) => {
        const inst = instantiateBlueprint(bp, at);
        const merged = [...ns, ...asRF(inst.nodes)];
        const mergedEdges = [...es, ...asRFEdges(inst.edges)];
        if (inst.promote) {
          const out = promoteToSubgraph(inst.rootId, asCore(merged), asCoreEdges(mergedEdges), directorHost);
          settle(asRF(out.nodes), asRFEdges(out.edges), { reparent: false });
        } else settle(merged, mergedEdges, { reparent: false });
        setNote(`placed blueprint “${bp.label}”`);
      });
    },
    [settle, withCurrent],
  );

  /** Delete the selection, and every edge that touched it, then reconcile. */
  const deleteSelection = useCallback(() => {
    withCurrent((ns, es) => {
      const doomed = new Set(ns.filter((n) => n.selected).map((n) => n.id));
      if (!doomed.size) {
        setNote("nothing selected");
        return;
      }
      // Children of a deleted container go with it — an orphan holding a parentId that no
      // longer resolves renders at the wrong place and confuses containment forever after.
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of ns) {
          if (!doomed.has(n.id) && n.parentId && doomed.has(n.parentId)) {
            doomed.add(n.id);
            grew = true;
          }
        }
      }
      setNote(`deleted ${doomed.size} node${doomed.size === 1 ? "" : "s"}`);
      settle(
        ns.filter((n) => !doomed.has(n.id)),
        es.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
        { reparent: false },
      );
    });
  }, [settle, withCurrent]);

  /** Wrap the chosen nodes in a new Beat, sized from their own bounds. Returns the Beat id. */
  const groupNodes = useCallback((pick: (n: RFNode) => boolean, title?: string): string | undefined => {
    const all = nodesRef.current as RFNode[];
    const chosen = all.filter((n) => pick(n) && !isContainer(n));
    if (chosen.length === 0) {
      setNote("select the scenes you want to group first");
      return undefined;
    }
    const core = asCore(all);
    const PAD = 46;
    const HEAD = 34;
    const boxes = chosen.map((n) => {
      const a = absolutePos(n as unknown as GraphNode<DirectorData>, core);
      return { x: a.x, y: a.y, w: n.measured?.width ?? 200, h: n.measured?.height ?? 90 };
    });
    const minX = Math.min(...boxes.map((b) => b.x)) - PAD;
    const minY = Math.min(...boxes.map((b) => b.y)) - PAD - HEAD;
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + PAD;
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + PAD;
    const id = `beat-${Date.now().toString(36)}`;
    const container = beat(id, title ?? `Beat ${all.filter(isContainer).length + 1}`, { x: minX, y: minY }, { width: maxX - minX, height: maxY - minY });
    const chosenIds = new Set(chosen.map((n) => n.id));
    withCurrent((ns, es) => {
      const next = [
        ...ns.map((n) => {
          if (!chosenIds.has(n.id)) return n;
          const a = absolutePos(n as unknown as GraphNode<DirectorData>, core);
          return { ...n, parentId: id, position: { x: a.x - minX, y: a.y - minY }, selected: false } as RFNode;
        }),
        container as unknown as RFNode,
      ];
      setNote(`grouped ${chosen.length} node${chosen.length === 1 ? "" : "s"} into ${container.data.label}`);
      settle(next, es, { reparent: false });
    });
    return id;
  }, [settle, withCurrent]);

  const groupSelection = useCallback(() => groupNodes((n) => !!n.selected), [groupNodes]);

  const convert = useCallback(
    (containerId: string, to: "group" | "subgraph") => {
      withCurrent((ns, es) => {
        const target = ns.find((n) => n.id === containerId);
        if (!target) return;
        if (to === "subgraph" && target.type === SUBGRAPH_TYPE) return setNote(`${target.data.label} is already a subgraph`);
        if (to === "group" && target.type !== SUBGRAPH_TYPE) return setNote(`${target.data.label} is already a group`);
        const out =
          to === "subgraph"
            ? promoteToSubgraph(containerId, asCore(ns), asCoreEdges(es), directorHost)
            : dissolveSubgraph(containerId, asCore(ns), asCoreEdges(es));
        settle(asRF(out.nodes), asRFEdges(out.edges), { reparent: false });
        const r = out.nodes.find((n) => n.id === containerId)?.data as BeatData;
        setNote(
          to === "subgraph"
            ? `${target.data.label} is now a subgraph — ${r.promotedIn.length} in, ${r.promotedOut.length} out`
            : `${target.data.label} is now a group — rails merged back to direct wires`,
        );
        return undefined;
      });
    },
    [settle, withCurrent],
  );

  const actions: EditorActions = useMemo(
    () => ({
      renameRail(containerId, side, portId, label) {
        withCurrent((ns, es) => {
          const next = ns.map((n) => {
            if (n.id !== containerId) return n;
            const key = side === "in" ? "promotedIn" : "promotedOut";
            const list = rails(n)[key];
            const taken = new Set(list.filter((p) => p.id !== portId).map((p) => p.label));
            return { ...n, data: { ...n.data, [key]: list.map((p) => (p.id === portId ? { ...p, label: uniquifyLabel(label, taken) } : p)) } } as RFNode;
          });
          settle(next, es, { reparent: false });
        });
      },
      reorderRail(containerId, side, from, to) {
        withCurrent((ns, es) => {
          const next = ns.map((n) => {
            if (n.id !== containerId) return n;
            const key = side === "in" ? "promotedIn" : "promotedOut";
            const list = [...rails(n)[key]];
            if (from < 0 || to < 0 || from >= list.length || to >= list.length) return n;
            const [moved] = list.splice(from, 1);
            if (moved) list.splice(to, 0, moved);
            return { ...n, data: { ...n.data, [key]: list } } as RFNode;
          });
          settle(next, es, { reparent: false });
        });
      },
      renameNode(nodeId, label) {
        const next = label.trim();
        if (!next) return;
        withCurrent((ns, es) => {
          settle(
            ns.map((n) => {
              if (n.id !== nodeId) return n;
              const data = n.data.kind === "scene" ? { ...n.data, label: next, heading: next } : { ...n.data, label: next };
              return { ...n, data } as RFNode;
            }),
            es,
            { reparent: false },
          );
        });
      },
      convertContainer: convert,
      setColor(containerId, color) {
        withCurrent((ns, es) => {
          settle(
            ns.map((n) => (n.id === containerId ? ({ ...n, data: { ...n.data, color } } as RFNode) : n)),
            es,
            { reparent: false },
          );
        });
      },
      updateNode(nodeId, patch) {
        withCurrent((ns, es) => {
          settle(
            ns.map((n) => (n.id === nodeId ? ({ ...n, data: { ...n.data, ...patch } } as RFNode) : n)),
            es,
            { reparent: false },
          );
        });
      },
      togglePin(nodeId) {
        withCurrent((ns, es) => {
          settle(
            ns.map((n) => (n.id === nodeId ? ({ ...n, data: { ...n.data, promoted: !(n.data as SceneData).promoted } } as RFNode) : n)),
            es,
            { reparent: false },
          );
        });
      },
      toggleCollapse(containerId) {
        withCurrent((ns, es) => {
          const next = ns.map((n) => {
            if (n.id !== containerId || n.type !== SUBGRAPH_TYPE) return n;
            const d = rails(n);
            const collapsing = !d.collapsed;
            // The expanded box and the collapsed card are two different sizes. React Flow's
            // resizer writes to node.width/height whichever is showing, so swap the remembered
            // one in and stash the other, or expanding lands you on a card-sized Beat.
            const out = { ...n, data: { ...d, collapsed: collapsing } } as RFNode;
            if (collapsing) {
              (out.data as BeatData).expandedWidth = n.width;
              (out.data as BeatData).expandedHeight = n.height;
              if (d.collapsedWidth) out.width = d.collapsedWidth;
              else delete out.width;
              if (d.collapsedHeight) out.height = d.collapsedHeight;
              else delete out.height;
            } else {
              (out.data as BeatData).collapsedWidth = n.width;
              (out.data as BeatData).collapsedHeight = n.height;
              out.width = d.expandedWidth ?? d.width ?? 460;
              out.height = d.expandedHeight ?? d.height ?? 380;
            }
            return out;
          });
          settle(next, es, { reparent: false });
        });
      },
      saveBlueprint(containerId, presetName) {
        const all = nodesRef.current as RFNode[];
        const target = all.find((n) => n.id === containerId);
        if (!target || !isContainer(target)) return;
        const name = (presetName ?? window.prompt("Blueprint name", target.data.label) ?? "").trim();
        if (!name) return;
        // Store the LOGICAL wiring: rails are derived, so a saved subgraph is dissolved first
        // and re-promoted on placement through the same algebra that built it.
        const wasSubgraph = target.type === SUBGRAPH_TYPE;
        const logical = wasSubgraph
          ? dissolveSubgraph(containerId, asCore(all), asCoreEdges(edgesRef.current))
          : { nodes: asCore(all), edges: asCoreEdges(edgesRef.current) };
        const existing = loadBlueprints();
        const linked = rails(target).blueprintId && existing[rails(target).blueprintId!] ? rails(target).blueprintId! : undefined;
        const id = linked ?? blueprintIdFromName(name, existing);
        const bp: Blueprint = { id, label: name, savedAt: Date.now(), ...serializeSubtree(containerId, logical.nodes, logical.edges, wasSubgraph) };
        const next = { ...existing, [id]: bp };
        writeBlueprints(next);
        setBlueprints(next);
        withCurrent(
          (ns, es) =>
            settle(
              ns.map((n) =>
                n.id === containerId
                  ? ({ ...n, data: { ...n.data, blueprintId: id, blueprintVersion: (rails(n).blueprintVersion ?? 0) + 1 } } as RFNode)
                  : n,
              ),
              es,
              { reparent: false },
            ),
          { history: false },
        );
        setNote(linked ? `updated blueprint “${name}”` : `saved blueprint “${name}”`);
      },
    }),
    [convert, settle, withCurrent],
  );

  const edgeActions: EdgeActions = useMemo(
    () => ({
      deleteEdge(edgeId) {
        withCurrent((ns, es) => {
          settle(ns, es.filter((e) => e.id !== edgeId), { reparent: false });
          setNote("wire removed");
        });
      },
      insertOnEdge(edgeId, at) {
        withCurrent((ns, es) => {
          const e = es.find((x) => x.id === edgeId);
          if (!e || !e.sourceHandle || !e.targetHandle) return;
          const type = handleTypes(ns).get(e.sourceHandle) ?? handleTypes(ns).get(e.targetHandle);
          const node = makeNode("scene", { x: at.x - 100, y: at.y - 60 });
          const ports = portsOf(node as unknown as RFNode);
          const input = ports.find((p) => p.isInput && p.type === type);
          const output = ports.find((p) => !p.isInput && p.type === type);
          if (!input || !output) {
            setNote(`a scene cannot sit on a ${type ?? "?"} wire — it has no ${type} passthrough`);
            return;
          }
          const a: Edge = { id: `lg:${e.sourceHandle}->${input.id}`, source: e.source, target: node.id, sourceHandle: e.sourceHandle, targetHandle: input.id };
          const b: Edge = { id: `lg:${output.id}->${e.targetHandle}`, source: node.id, target: e.target, sourceHandle: output.id, targetHandle: e.targetHandle };
          settle([...ns, node as unknown as RFNode], [...es.filter((x) => x.id !== edgeId), a, b]);
          setNote(`inserted ${node.data.label} on the wire`);
        });
      },
    }),
    [settle, withCurrent],
  );

  const selectedContainer = useCallback(() => (nodesRef.current as RFNode[]).find((n) => n.selected && isContainer(n)), []);

  /**
   * The editor's own validation. A wire carries one type end to end; the `+` slot is exempt
   * because it AUTHORS a port of whatever type is dropped on it. This is the check a tool call
   * goes through too — `connect` routes through the same addWire the mouse uses.
   */
  const isValidConnection = useCallback((c: Connection | Edge): boolean => {
    if (parseEmptySlotHandle(c.sourceHandle) || parseEmptySlotHandle(c.targetHandle)) return true;
    const types = handleTypes(nodesRef.current as RFNode[]);
    const a = types.get(c.sourceHandle ?? "");
    const b = types.get(c.targetHandle ?? "");
    return !!a && a === b;
  }, []);

  // ── the agent's entry point ────────────────────────────────────────────────────────
  //
  // Every command below is the mouse's own path with the mouse removed: add_node uses
  // makeNode and settle, connect uses addWire behind the same isValidConnection, promote uses
  // the same algebra. The editor mints ids; the agent gets them back from `outline`.
  useEffect(() => {
    if (!apiRef) return undefined;
    const run = <T,>(fn: (ns: RFNode[], es: Edge[]) => T, opts: { history?: boolean } = {}) =>
      new Promise<T>((resolve, reject) => {
        withCurrent((ns, es) => {
          try {
            resolve(fn(ns, es));
          } catch (err) {
            reject(err);
          }
        }, opts);
      });
    const find = (ns: RFNode[], id: unknown): RFNode => {
      const n = ns.find((x) => x.id === id);
      if (!n) throw new Error(`no node "${String(id)}" — read the outline for ids`);
      return n;
    };
    const num = (v: unknown, what: string): number => {
      if (typeof v !== "number" || Number.isNaN(v)) throw new Error(`${what} must be a number`);
      return v;
    };
    const str = (v: unknown, what: string): string => {
      if (typeof v !== "string" || !v) throw new Error(`${what} must be a non-empty string`);
      return v;
    };
    const nodeIdOfHandle = (ns: RFNode[], handle: string): string => {
      if (handle.includes("::")) {
        const cid = handle.slice(0, handle.indexOf("::"));
        if (ns.some((n) => n.id === cid)) return cid;
        throw new Error(`no Beat owns rail "${handle}"`);
      }
      const i = handle.indexOf(":");
      return i > 0 ? handle.slice(0, i) : handle;
    };
    const summarize = (n: RFNode) => {
      const base = { id: n.id, type: n.type, label: n.data.label, parentId: n.parentId ?? null, position: n.position, hidden: !!n.hidden };
      if (isContainer(n)) {
        const d = rails(n);
        return { ...base, collapsed: !!d.collapsed, color: d.color ?? null, promotedIn: d.promotedIn, promotedOut: d.promotedOut, faces: d.faces ?? [], blueprintId: d.blueprintId ?? null };
      }
      const d = n.data as SceneData | AssetData;
      return {
        ...base,
        kind: d.kind,
        ...(d.kind === "scene" ? { heading: d.heading, durationSec: d.durationSec ?? null, videoPath: d.videoPath ?? null } : { asset: d.asset }),
        promoted: !!d.promoted,
        inSubgraph: !!d.inSubgraph,
        ports: d.ports.map((p) => ({ id: p.id, type: p.type, isInput: p.isInput, label: p.label })),
      };
    };
    const summarizeEdge = (e: Edge) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle, relay: e.id.endsWith("__inneredge") });

    apiRef.current = async (name, args) => {
      switch (name) {
        case "outline":
          return run((ns, es) => ({ nodes: ns.map(summarize), edges: es.map(summarizeEdge), blueprints: Object.values(loadBlueprints()).map((b) => ({ id: b.id, label: b.label, nodes: b.nodes.length })) }), { history: false });
        case "read_node":
          return run((ns) => summarize(find(ns, args.id)), { history: false });
        case "add_node": {
          const kind = str(args.kind, "kind") as NodeKind;
          const node = makeNode(kind, { x: num(args.x, "x"), y: num(args.y, "y") });
          if (typeof args.label === "string" && args.label) {
            node.data = node.data.kind === "scene" ? { ...node.data, label: args.label, heading: args.label } : { ...node.data, label: args.label };
          }
          return run((ns, es) => {
            settle([...ns, node as unknown as RFNode], es);
            return { id: node.id, label: node.data.label };
          });
        }
        case "remove_node":
          return run((ns, es) => {
            const target = find(ns, args.id);
            const doomed = new Set<string>([target.id]);
            let grew = true;
            while (grew) {
              grew = false;
              for (const n of ns) if (!doomed.has(n.id) && n.parentId && doomed.has(n.parentId)) { doomed.add(n.id); grew = true; }
            }
            settle(ns.filter((n) => !doomed.has(n.id)), es.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)), { reparent: false });
            return { removed: [...doomed] };
          });
        case "calliope": {
          // Passthrough to the Calliope client: { ns, op, args }. The client is the one place
          // that knows the routes, so the tool layer names (ns, op) and the lookup happens
          // here — a name that is not a client method is refused, never guessed. After a
          // mutation the canvas is re-read and merged, so the agent sees what it did.
          const ns = str(args.ns, "ns");
          const op = str(args.op, "op");
          if (!/^(projects|settings|story|scenes|workflows|jobs|assets|playground)$/.test(ns)) throw new Error(`no Calliope namespace "${ns}"`);
          // `op` may be dotted — the story namespace nests: story.beat.create.
          let self: unknown = client;
          let fn: unknown = (client as unknown as Record<string, unknown>)[ns];
          for (const part of op.split(".")) {
            self = fn;
            fn = fn && typeof fn === "object" ? (fn as Record<string, unknown>)[part] : undefined;
          }
          if (typeof fn !== "function") throw new Error(`no Calliope call "${ns}.${op}"`);
          const list = Array.isArray(args.args) ? (args.args as unknown[]) : [];
          return (fn as (...a: unknown[]) => Promise<unknown>).apply(self, list).then(async (result) => {
            const leaf = op.split(".").pop() ?? op;
            const reads = /^(list|get|queueStatus|uploads|previewPrompt|analyze)$/.test(leaf);
            if (!reads && /^(story|scenes|assets|playground|projects)$/.test(ns) && loadedProjectRef.current !== null) await refreshProject();
            return result;
          });
        }
        case "scene_set_prompt": {
          // Calliope honours a stored draft only while prompt_draft_meta.based_on matches the
          // scene's current text hash, so the draft is written against the row as it is NOW;
          // promptDraft() computes that hash from the fetched row.
          const pid = num(args.project_id, "project_id");
          const sid = num(args.scene_id, "scene_id");
          const prompt = str(args.prompt, "prompt");
          return client.scenes.list(pid).then(async (res) => {
            const row = res.scenes.find((sc) => sc.id === sid);
            if (!row) throw new Error(`scene ${sid} is not in project ${pid}`);
            const out = await client.promptDraft(pid, row, prompt);
            if (loadedProjectRef.current === pid) await refreshProject();
            return out;
          });
        }
        case "project_open":
          return loadProject(args.project_id === null || args.project_id === undefined ? null : num(args.project_id, "project_id")).then(() => ({
            project_id: loadedProjectRef.current,
          }));
        case "project_current":
          return { project_id: loadedProjectRef.current, calliope: status };
        case "project_refresh":
          return refreshProject().then(() => ({ project_id: loadedProjectRef.current }));
        case "move_node":
          return run((ns, es) => {
            const target = find(ns, args.id);
            const abs = { x: num(args.x, "x"), y: num(args.y, "y") };
            const parent = target.parentId ? ns.find((n) => n.id === target.parentId) : undefined;
            const base = parent ? absolutePos(parent as unknown as GraphNode<DirectorData>, asCore(ns)) : { x: 0, y: 0 };
            settle(ns.map((n) => (n.id === target.id ? ({ ...n, position: { x: abs.x - base.x, y: abs.y - base.y } } as RFNode) : n)), es);
            return { id: target.id, position: abs };
          });
        case "set_title":
          return run((ns, es) => {
            const target = find(ns, args.id);
            const label = str(args.label, "label");
            settle(ns.map((n) => (n.id === target.id ? ({ ...n, data: n.data.kind === "scene" ? { ...n.data, label, heading: label } : { ...n.data, label } } as RFNode) : n)), es, { reparent: false });
            return { id: target.id, label };
          });
        case "set_color":
          return run((ns, es) => {
            const target = find(ns, args.id);
            if (!isContainer(target)) throw new Error("only a Beat takes a colour");
            const color = str(args.color, "color");
            settle(ns.map((n) => (n.id === target.id ? ({ ...n, data: { ...n.data, color } } as RFNode) : n)), es, { reparent: false });
            return { id: target.id, color };
          });
        case "set_collapsed":
          return run((ns, es) => {
            const target = find(ns, args.id);
            if (target.type !== SUBGRAPH_TYPE) throw new Error("only a subgraph collapses — promote the Beat first");
            const want = !!args.collapsed;
            if (!!rails(target).collapsed !== want) queueMicrotask(() => actions.toggleCollapse(target.id));
            return { id: target.id, collapsed: want };
          }, { history: false });
        case "set_parent":
          return run((ns, es) => {
            const target = find(ns, args.id);
            const parentId = args.parent_id === null ? undefined : str(args.parent_id, "parent_id");
            if (parentId) {
              const parent = find(ns, parentId);
              if (!isContainer(parent)) throw new Error(`"${parentId}" is not a Beat`);
              if (parentId === target.id) throw new Error("a Beat cannot contain itself");
            }
            const core = asCore(ns);
            const abs = absolutePos(target as unknown as GraphNode<DirectorData>, core);
            const base = parentId ? absolutePos(find(ns, parentId) as unknown as GraphNode<DirectorData>, core) : { x: 0, y: 0 };
            const next = ns.map((n) => {
              if (n.id !== target.id) return n;
              const moved = { ...n, position: { x: abs.x - base.x, y: abs.y - base.y } } as RFNode;
              if (parentId) moved.parentId = parentId;
              else delete moved.parentId;
              return moved;
            });
            settle(next, es, { reparent: false });
            return { id: target.id, parentId: parentId ?? null };
          });
        case "set_pin":
          return run((ns, es) => {
            const target = find(ns, args.id);
            if (isContainer(target)) throw new Error("pin a Scene or an asset, not a Beat");
            if (!(target.data as SceneData).inSubgraph) throw new Error("a pin only means something inside a subgraph");
            const promoted = !!args.promoted;
            settle(ns.map((n) => (n.id === target.id ? ({ ...n, data: { ...n.data, promoted } } as RFNode) : n)), es, { reparent: false });
            return { id: target.id, promoted };
          });
        case "connect":
          return run((ns, es) => {
            const sh = str(args.source_handle, "source_handle");
            const th = str(args.target_handle, "target_handle");
            const source = nodeIdOfHandle(ns, sh);
            const target = nodeIdOfHandle(ns, th);
            find(ns, source);
            find(ns, target);
            const types = handleTypes(ns);
            const a = types.get(sh);
            const b = types.get(th);
            if (!a) throw new Error(`no such handle "${sh}"`);
            if (!b) throw new Error(`no such handle "${th}"`);
            if (a !== b) throw new Error(`type mismatch: ${sh} is ${a}, ${th} is ${b}`);
            const edge: Edge = { id: `lg:${sh}->${th}`, source, target, sourceHandle: sh, targetHandle: th };
            settle(ns, [...es.filter((e) => !(e.target === target && e.targetHandle === th)), edge], { reparent: false });
            return { id: edge.id, type: a };
          });
        case "disconnect":
          return run((ns, es) => {
            const before = es.length;
            const kept = typeof args.edge_id === "string"
              ? es.filter((e) => e.id !== args.edge_id)
              : es.filter((e) => e.targetHandle !== args.target_handle);
            if (kept.length === before) throw new Error("no wire matched");
            settle(ns, kept, { reparent: false });
            return { removed: before - kept.length };
          });
        case "repair":
          return run((ns, es) => {
            settle(ns, es, { reparent: true });
            return { ok: true };
          });
        case "promote":
        case "dissolve":
          return run((ns, es) => {
            const target = find(ns, args.id);
            if (!isContainer(target)) throw new Error(`"${target.id}" is not a Beat`);
            const toSub = name === "promote";
            if (toSub && target.type === SUBGRAPH_TYPE) return { id: target.id, subgraph: true, note: "already a subgraph" };
            if (!toSub && target.type !== SUBGRAPH_TYPE) return { id: target.id, subgraph: false, note: "already a group" };
            const out = toSub
              ? promoteToSubgraph(target.id, asCore(ns), asCoreEdges(es), directorHost)
              : dissolveSubgraph(target.id, asCore(ns), asCoreEdges(es));
            settle(asRF(out.nodes), asRFEdges(out.edges), { reparent: false });
            const r = out.nodes.find((n) => n.id === target.id)?.data as BeatData;
            return { id: target.id, subgraph: toSub, promotedIn: r.promotedIn, promotedOut: r.promotedOut };
          });
        case "reconcile":
          return run((ns, es) => {
            find(ns, args.id);
            settle(ns, es, { reparent: false });
            return { ok: true };
          });
        case "set_rail_label":
          return run((ns) => {
            const target = find(ns, args.id);
            const d = rails(target);
            const pid = str(args.port_id, "port_id");
            const side = d.promotedIn.some((p) => p.id === pid) ? "in" : d.promotedOut.some((p) => p.id === pid) ? "out" : null;
            if (!side) throw new Error(`"${pid}" is not a rail on ${target.id}`);
            queueMicrotask(() => actions.renameRail(target.id, side, pid, str(args.label, "label")));
            return { id: target.id, port_id: pid };
          }, { history: false });
        case "reorder_rail":
          return run((ns) => {
            const target = find(ns, args.id);
            const side = args.side === "out" ? "out" : "in";
            queueMicrotask(() => actions.reorderRail(target.id, side, num(args.from, "from"), num(args.to, "to")));
            return { id: target.id, side };
          }, { history: false });
        case "group": {
          const ids = Array.isArray(args.node_ids) ? (args.node_ids as unknown[]).map((v) => str(v, "node_ids[]")) : [];
          if (!ids.length) throw new Error("node_ids must name at least one node");
          const set = new Set(ids);
          const beatId = groupNodes((n) => set.has(n.id), typeof args.label === "string" ? args.label : undefined);
          if (!beatId) throw new Error("nothing groupable among those ids (Beats cannot be grouped)");
          return { id: beatId };
        }
        case "save_blueprint":
          return run((ns) => {
            const target = find(ns, args.id);
            if (target.type !== SUBGRAPH_TYPE) throw new Error("save a SUBGRAPH as a blueprint — promote the Beat first");
            queueMicrotask(() => actions.saveBlueprint(target.id, str(args.name, "name")));
            return { id: target.id, name: args.name };
          }, { history: false });
        case "list_blueprints":
          return Object.values(loadBlueprints()).map((b) => ({ id: b.id, label: b.label, nodes: b.nodes.length, savedAt: b.savedAt }));
        case "apply_blueprint": {
          const bp = loadBlueprints()[str(args.blueprint_id, "blueprint_id")];
          if (!bp) throw new Error(`no blueprint "${String(args.blueprint_id)}" — list_blueprints names them`);
          const at = { x: num(args.x, "x"), y: num(args.y, "y") };
          return run((ns, es) => {
            const inst = instantiateBlueprint(bp, at);
            const merged = [...ns, ...asRF(inst.nodes)];
            const mergedEdges = [...es, ...asRFEdges(inst.edges)];
            if (inst.promote) {
              const out = promoteToSubgraph(inst.rootId, asCore(merged), asCoreEdges(mergedEdges), directorHost);
              settle(asRF(out.nodes), asRFEdges(out.edges), { reparent: false });
            } else settle(merged, mergedEdges, { reparent: false });
            return { id: inst.rootId, blueprint: bp.id };
          });
        }
        default:
          throw new Error(`unknown director command "${name}"`);
      }
    };
    return () => {
      apiRef.current = null;
    };
  }, [actions, apiRef, groupNodes, settle, withCurrent]);

  // ── palette items ────────────────────────────────────────────────────────────────────

  const paletteItems = useMemo((): PaletteItem[] => {
    const wire = palette?.wire ?? null;
    const accepts = (kind: NodeKind): boolean => {
      if (!wire) return true;
      const probeNode = makeNode(kind, { x: 0, y: 0 }, "probe");
      return portsOf(probeNode as unknown as RFNode).some((p) => p.type === wire.type && (wire.lookingFor === "input" ? p.isInput : !p.isInput));
    };
    const kinds: { kind: NodeKind; label: string; icon: string }[] = [
      { kind: "scene", label: "Scene", icon: "🎬" },
      { kind: "character", label: "Character", icon: "🧍" },
      { kind: "location", label: "Location", icon: "🏙️" },
      { kind: "item", label: "Item", icon: "🎒" },
    ];
    const items: PaletteItem[] = kinds.map((k) => ({
      id: `kind:${k.kind}`,
      label: k.label,
      icon: k.icon,
      group: "Nodes",
      disabled: !accepts(k.kind),
      hint: wire && !accepts(k.kind) ? `no ${wire.type} ${wire.lookingFor}` : undefined,
    }));
    for (const bp of Object.values(blueprints).sort((a, b) => b.savedAt - a.savedAt)) {
      items.push({ id: `bp:${bp.id}`, label: bp.label, icon: "🎞️", group: "Blueprints", hint: `${bp.nodes.length - 1} inside`, disabled: !!wire });
    }
    return items;
  }, [blueprints, palette?.wire]);

  const beats = (nodes as RFNode[]).filter(isContainer);
  const promoted = beats.filter((b) => b.type === SUBGRAPH_TYPE).length;

  return (
    <ActionsContext.Provider value={actions}>
      <EdgeActionsContext.Provider value={edgeActions}>
        <CarryContext.Provider value={carryRef.current}>
          <div className="bd-root">
            <div className="bd-toolbar">
              <strong className="bd-brand">🎬 Director</strong>
              <button type="button" onClick={groupSelection} title="Wrap the selection in a new Beat">Group</button>
              <button
                type="button"
                title="Turn the selected Beat into a subgraph — its crossings become rails"
                onClick={() => {
                  const t = selectedContainer();
                  if (!t) return setNote("select a Beat first");
                  convert(t.id, "subgraph");
                  return undefined;
                }}
              >
                Subgraph
              </button>
              <button
                type="button"
                title="Turn the selected subgraph back into a plain group"
                onClick={() => {
                  const t = selectedContainer();
                  if (!t) return setNote("select a Beat first");
                  convert(t.id, "group");
                  return undefined;
                }}
              >
                Dissolve
              </button>
              <button type="button" onClick={deleteSelection}>Delete</button>
              <span className="bd-sep" />
              <button type="button" onClick={undo} title="Ctrl+Z">Undo</button>
              <button type="button" onClick={redo} title="Ctrl+Shift+Z">Redo</button>
              <button type="button" onClick={repair} title="Re-derive every boundary from the wires">Repair</button>
              <span className="bd-sep" />
              <span className="bd-stat">
                {beats.length} beat{beats.length === 1 ? "" : "s"} · {promoted} promoted
              </span>
              <span className="bd-spacer" />
              {status?.reachable ? (
                <select
                  className="bd-project"
                  value={loadedProject ?? ""}
                  title="Which Calliope project the canvas shows"
                  onChange={(e) => void loadProject(e.target.value === "" ? null : Number(e.target.value))}
                >
                  <option value="">demo project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              ) : null}
              {loadedProject !== null ? (
                <span className={`bd-sync is-${syncState}`} title="Write-back to Calliope">
                  {syncState === "saving" ? "saving…" : syncState === "saved" ? "saved" : syncState === "error" ? "save failed" : "synced"}
                </span>
              ) : null}
              <span className={`bd-status ${status?.reachable ? "is-up" : "is-down"}`}>
                {status === null ? "checking Calliope…" : status.reachable ? `Calliope ${status.health.version ?? "ok"}` : `Calliope unreachable — ${status.reason}`}
              </span>
            </div>
            {note ? <div className="bd-note">{note}</div> : null}
            <div className="bd-canvas" ref={canvasRef}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeDragStart={onNodeDragStart}
                onNodeDragStop={onNodeDragStop}
                onConnect={onConnect}
                onConnectStart={onConnectStart}
                onConnectEnd={onConnectEnd}
                isValidConnection={isValidConnection}
                connectionLineComponent={CarryLine}
                onPaneClick={() => setPalette(null)}
                onPaneContextMenu={(e) => {
                  e.preventDefault();
                  const ev = e as unknown as MouseEvent;
                  openPalette(ev.clientX, ev.clientY, null);
                }}
                onNodesDelete={() => queueMicrotask(() => withCurrent((ns, es) => settle(ns, es, { reparent: false })))}
                deleteKeyCode={["Delete", "Backspace"]}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={18} size={1} color="#2a2a35" />
                <Controls showInteractive={false} />
              </ReactFlow>
              {palette ? (
                <Palette
                  x={palette.x}
                  y={palette.y}
                  title={palette.wire ? `Wire ${palette.wire.type} → new` : "Add here"}
                  items={paletteItems}
                  onClose={() => setPalette(null)}
                  onPick={(it) => {
                    if (it.id.startsWith("kind:")) placeNode(it.id.slice(5) as NodeKind, palette.flow, palette.wire);
                    else if (it.id.startsWith("bp:")) {
                      const bp = blueprints[it.id.slice(3)];
                      if (bp) placeBlueprint(bp, palette.flow);
                    }
                  }}
                />
              ) : null}
            </div>
          </div>
        </CarryContext.Provider>
      </EdgeActionsContext.Provider>
    </ActionsContext.Provider>
  );
}

export function DirectorApp(props: DirectorAppProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
