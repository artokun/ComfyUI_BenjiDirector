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
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
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
  type GraphNode,
} from "@benjidirector/graph-core";
import { probe, resolveConfig, type ReachabilityState } from "@benjidirector/calliope-client";
import {
  PORT_COLOR,
  demoProject,
  directorHost,
  type BeatData,
  type DirectorData,
  type DirectorPortType,
  type SceneData,
} from "./model.js";
import { ActionsContext, nodeTypes, type EditorActions } from "./nodes.jsx";

// React Flow types node data as an index signature; ours are interfaces. Identical at runtime,
// so the casts stay confined to these aliases.
type RFNode = Node & { data: DirectorData };
const asCore = (ns: RFNode[]) => ns as unknown as GraphNode<DirectorData>[];
const asRF = (ns: GraphNode<DirectorData>[]) => ns as unknown as RFNode[];
const asCoreEdges = (es: Edge[]) => es as unknown as GraphEdge[];
const asRFEdges = (es: GraphEdge[]) => es as unknown as Edge[];

const isContainer = (n: RFNode | undefined) => !!n && (n.type === GROUP_TYPE || n.type === SUBGRAPH_TYPE);
const rails = (n: RFNode) => n.data as unknown as BeatData;

/** Every handle on the canvas -> its port type, so an edge can be coloured by what it carries. */
function handleTypes(nodes: RFNode[]): Map<string, DirectorPortType> {
  const m = new Map<string, DirectorPortType>();
  for (const n of nodes) {
    const d = n.data as SceneData;
    for (const p of d.ports ?? []) m.set(p.id, p.type as DirectorPortType);
    if (!isContainer(n)) continue;
    for (const bp of [...rails(n).promotedIn, ...rails(n).promotedOut]) {
      m.set(bp.id, bp.type as DirectorPortType);
      m.set(innerHandleId(bp.id), bp.type as DirectorPortType);
    }
  }
  return m;
}

/**
 * Colour each edge by what it carries, and hide anything inside a collapsed Beat.
 *
 * A node is hidden when ANY ancestor is a collapsed subgraph — not just its direct parent, or
 * a Beat nested two deep would keep rendering its grandchildren on top of the collapsed card.
 * Edges follow their endpoints, which is what makes the inner relays disappear with the
 * children while the outer halves keep terminating on the collapsed card's rails.
 */
function decorate(nodes: RFNode[], edges: Edge[]): { nodes: RFNode[]; edges: Edge[] } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const collapsed = new Set(
    nodes.filter((n) => n.type === SUBGRAPH_TYPE && rails(n).collapsed).map((n) => n.id),
  );

  const hiddenNode = (n: RFNode): boolean => {
    let p = n.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      if (collapsed.has(p)) return true;
      p = byId.get(p)?.parentId;
    }
    return false;
  };

  const outNodes = nodes.map((n) => {
    const hide = hiddenNode(n);
    return !!n.hidden === hide ? n : ({ ...n, hidden: hide } as RFNode);
  });
  const hidden = new Set(outNodes.filter((n) => n.hidden).map((n) => n.id));
  const types = handleTypes(outNodes);

  const outEdges = edges.map((e) => {
    const hide = hidden.has(e.source) || hidden.has(e.target);
    const t = types.get(e.sourceHandle ?? "") ?? types.get(e.targetHandle ?? "");
    const stroke = t ? PORT_COLOR[t] : "#9ca3af";
    const style = { stroke, strokeWidth: 2 };
    const same = !!e.hidden === hide && (e.style as { stroke?: string } | undefined)?.stroke === stroke;
    return same ? e : { ...e, hidden: hide, style };
  });

  return { nodes: outNodes, edges: outEdges };
}

export interface DirectorAppProps {
  calliopeBaseUrl?: string;
}

function Editor({ calliopeBaseUrl }: DirectorAppProps) {
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

  /**
   * Force React Flow to measure.
   *
   * The pane mounts inside the side panel's overlay while it is sliding in, and React Flow's
   * own ResizeObserver pass does not land in that window: nodes keep `visibility: hidden`
   * (its marker for "not measured"), and because an edge only renders once BOTH endpoints are
   * measured, the canvas comes up with nodes you cannot see and no wires at all. Mounting RF
   * inside a drawer or modal is the classic way to hit this.
   *
   * `updateNodeInternals` re-reads dimensions and handle bounds straight from the DOM, which
   * is the documented escape hatch. We kick it on the next frame, again shortly after (the
   * slide-in is 240ms), and on every container resize, so a pane that is docked, undocked or
   * re-opened re-measures instead of staying blank.
   */
  const updateNodeInternals = useUpdateNodeInternals();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const nodeIds = useMemo(() => (nodes as RFNode[]).map((n) => n.id).join(","), [nodes]);
  useEffect(() => {
    const ids = nodeIds ? nodeIds.split(",") : [];
    if (!ids.length) return undefined;
    const kick = () => updateNodeInternals(ids);
    const raf = requestAnimationFrame(kick);
    const timers = [setTimeout(kick, 120), setTimeout(kick, 400), setTimeout(kick, 900)];
    const el = canvasRef.current;
    const ro = el ? new ResizeObserver(() => kick()) : null;
    if (el && ro) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      ro?.disconnect();
    };
  }, [nodeIds, updateNodeInternals]);

  const config = useMemo(
    () => resolveConfig(calliopeBaseUrl ? { baseUrl: calliopeBaseUrl } : {}),
    [calliopeBaseUrl],
  );
  useEffect(() => {
    let live = true;
    probe(config).then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [config]);

  /** Bring the graph back to a consistent state. Order is not interchangeable. */
  const settle = useCallback(
    (ns: RFNode[], es: Edge[], opts: { reparent?: boolean } = {}) => {
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
      const done = decorate(asRF(core), asRFEdges(coreEdges));
      setNodes(done.nodes);
      setEdges(done.edges);
    },
    [setEdges, setNodes],
  );

  const withCurrent = useCallback(
    (fn: (ns: RFNode[], es: Edge[]) => void) => {
      setNodes((ns) => {
        setEdges((es) => {
          queueMicrotask(() => fn(ns as RFNode[], es));
          return es;
        });
        return ns;
      });
    },
    [setEdges, setNodes],
  );

  const onNodeDragStop = useCallback(() => withCurrent((ns, es) => settle(ns, es)), [settle, withCurrent]);

  /**
   * Connect.
   *
   * The one special case is the trailing `+` slot on a rail: wiring a CHILD into it authors a
   * new pinned boundary port. Only the slot's INNER handle can do that, because a boundary port
   * has to know which child port it aliases — an external wire dropped on the outer dot names
   * no child, so there is nothing to alias and we refuse rather than invent one.
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
          const port = ((child.data as SceneData).ports ?? []).find((p) => p.id === childPortId);
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
      const edge: Edge = {
        id: `lg:${c.sourceHandle}->${c.targetHandle}`,
        source: c.source,
        target: c.target,
        sourceHandle: c.sourceHandle,
        targetHandle: c.targetHandle,
      };
      withCurrent((ns, es) => {
        // An input socket takes one cable: replace whatever was on this target handle.
        const kept = es.filter((e) => !(e.target === edge.target && e.targetHandle === edge.targetHandle));
        settle(ns, [...kept, edge], { reparent: false });
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
            return {
              ...n,
              data: {
                ...n.data,
                [key]: list.map((p) => (p.id === portId ? { ...p, label: uniquifyLabel(label, taken) } : p)),
              },
            } as RFNode;
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
      toggleCollapse(containerId) {
        withCurrent((ns, es) => {
          const next = ns.map((n) =>
            n.id === containerId ? ({ ...n, data: { ...n.data, collapsed: !rails(n).collapsed } } as RFNode) : n,
          );
          settle(next, es, { reparent: false });
        });
      },
    }),
    [settle, withCurrent],
  );

  const selectedContainer = useCallback(
    () => (nodes as RFNode[]).find((n) => n.selected && isContainer(n)),
    [nodes],
  );

  const promote = useCallback(() => {
    const target = selectedContainer();
    if (!target) return setNote("select a Beat first");
    if (target.type === SUBGRAPH_TYPE) return setNote(`${target.data.label} is already promoted`);
    const out = promoteToSubgraph(target.id, asCore(nodes as RFNode[]), asCoreEdges(edges), directorHost);
    const done = decorate(asRF(sortParentsFirst(out.nodes)), asRFEdges(out.edges));
    setNodes(done.nodes);
    setEdges(done.edges);
    const r = out.nodes.find((n) => n.id === target.id)?.data as BeatData;
    setNote(`promoted ${target.data.label} — ${r.promotedIn.length} in, ${r.promotedOut.length} out`);
    return undefined;
  }, [edges, nodes, selectedContainer, setEdges, setNodes]);

  const dissolve = useCallback(() => {
    const target = selectedContainer();
    if (!target) return setNote("select a Beat first");
    if (target.type !== SUBGRAPH_TYPE) return setNote(`${target.data.label} is not promoted`);
    const out = dissolveSubgraph(target.id, asCore(nodes as RFNode[]), asCoreEdges(edges));
    const done = decorate(asRF(sortParentsFirst(out.nodes)), asRFEdges(out.edges));
    setNodes(done.nodes);
    setEdges(done.edges);
    setNote(`dissolved ${target.data.label} — rails merged back to direct wires`);
    return undefined;
  }, [edges, nodes, selectedContainer, setEdges, setNodes]);

  const beats = (nodes as RFNode[]).filter(isContainer);
  const promoted = beats.filter((b) => b.type === SUBGRAPH_TYPE).length;

  return (
    <ActionsContext.Provider value={actions}>
      <div className="bd-root">
        <div className="bd-toolbar">
          <strong className="bd-brand">🎬 Director</strong>
          <button type="button" onClick={promote}>Promote Beat</button>
          <button type="button" onClick={dissolve}>Dissolve</button>
          <button
            type="button"
            onClick={() => {
              const t = selectedContainer();
              if (!t || t.type !== SUBGRAPH_TYPE) return setNote("collapse works on a promoted Beat");
              actions.toggleCollapse(t.id);
              return undefined;
            }}
          >
            Collapse
          </button>
          <span className="bd-sep" />
          <span className="bd-stat">
            {beats.length} beat{beats.length === 1 ? "" : "s"} · {promoted} promoted
          </span>
          <span className="bd-spacer" />
          <span className={`bd-status ${status?.reachable ? "is-up" : "is-down"}`}>
            {status === null
              ? "checking Calliope…"
              : status.reachable
                ? `Calliope ${status.health.version ?? "ok"}`
                : `Calliope unreachable — ${status.reason}`}
          </span>
        </div>
        {note ? <div className="bd-note">{note}</div> : null}
        <div className="bd-canvas" ref={canvasRef}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} color="#2a2a35" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
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
