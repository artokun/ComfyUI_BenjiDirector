// The editor.
//
// Every structural change funnels through `settle()`, which is the only place that knows the
// correct order of operations: re-parent by geometry, order parents before children for React
// Flow, then reconcile every promoted Beat's boundary. Doing those in any other order produces
// rails that lag a frame behind the graph, which is exactly the class of bug the derived-id
// design is meant to make impossible.
//
// The agent drives this through the SAME callbacks the mouse does — `drive` below is a thin
// wrapper over the handlers, never a parallel implementation. That is ifr-node-lab's rule and
// it is why a tool call cannot bypass a validation the UI enforces.

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  containmentFor,
  dissolveSubgraph,
  promoteToSubgraph,
  reconcileBoundary,
  sortParentsFirst,
  type GraphEdge,
  type GraphNode,
} from "@benjidirector/graph-core";
import { probe, resolveConfig, type ReachabilityState } from "@benjidirector/calliope-client";
import { demoProject, directorHost, type BeatData, type DirectorData } from "./model.js";
import { nodeTypes } from "./nodes.jsx";

// React Flow types its node data as an index signature; ours are interfaces. The shapes are
// identical at runtime, so the cast is confined to these two aliases rather than sprayed
// through the component.
type RFNode = Node & { data: DirectorData };
const asCore = (ns: RFNode[]) => ns as unknown as GraphNode<DirectorData>[];
const asRF = (ns: GraphNode<DirectorData>[]) => ns as unknown as RFNode[];
const asCoreEdges = (es: Edge[]) => es as unknown as GraphEdge[];
const asRFEdges = (es: GraphEdge[]) => es as unknown as Edge[];

const isContainer = (n: RFNode | undefined) => !!n && (n.type === GROUP_TYPE || n.type === SUBGRAPH_TYPE);

export interface DirectorAppProps {
  calliopeBaseUrl?: string;
}

function Editor({ calliopeBaseUrl }: DirectorAppProps) {
  const initial = useMemo(() => demoProject(), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(asRF(initial.nodes as GraphNode<DirectorData>[]));
  const [edges, setEdges, onEdgesChange] = useEdgesState(asRFEdges(initial.edges));
  const [status, setStatus] = useState<ReachabilityState | null>(null);
  const [note, setNote] = useState<string>("");

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

  /**
   * Apply a structural change and bring the graph back to a consistent state.
   *
   * Order matters and is not interchangeable:
   *   1. containment — geometry decides who is inside what
   *   2. parents-first — React Flow v12 clips children that precede their parent
   *   3. reconcile — rails are re-derived from the membership step 1 just settled
   */
  const settle = useCallback((ns: RFNode[], es: Edge[], opts: { reparent?: boolean } = {}) => {
    let core = asCore(ns);
    if (opts.reparent !== false) {
      core = core.map((n) => containmentFor(n, core));
    }
    core = sortParentsFirst(core);
    let coreEdges = asCoreEdges(es);
    for (const n of core) {
      if (n.type !== SUBGRAPH_TYPE) continue;
      const out = reconcileBoundary(n.id, core, coreEdges, directorHost);
      core = out.nodes;
      coreEdges = out.edges;
    }
    setNodes(asRF(core));
    setEdges(asRFEdges(coreEdges));
  }, [setEdges, setNodes]);

  const onNodeDragStop = useCallback(() => {
    setNodes((cur) => {
      setEdges((curEdges) => {
        queueMicrotask(() => settle(cur as RFNode[], curEdges));
        return curEdges;
      });
      return cur;
    });
  }, [setEdges, setNodes, settle]);

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) => {
        const next = addEdge({ ...c, id: `lg:${c.sourceHandle}->${c.targetHandle}` }, eds);
        setNodes((ns) => {
          queueMicrotask(() => settle(ns as RFNode[], next, { reparent: false }));
          return ns;
        });
        return next;
      });
    },
    [setEdges, setNodes, settle],
  );

  const selectedContainer = useCallback(
    (): RFNode | undefined => (nodes as RFNode[]).find((n) => n.selected && isContainer(n)),
    [nodes],
  );

  const promote = useCallback(
    (id?: string) => {
      const target = id ? (nodes as RFNode[]).find((n) => n.id === id) : selectedContainer();
      if (!target) return setNote("select a Beat first");
      if (target.type === SUBGRAPH_TYPE) return setNote(`${target.data.label} is already promoted`);
      const out = promoteToSubgraph(target.id, asCore(nodes as RFNode[]), asCoreEdges(edges), directorHost);
      setNodes(asRF(sortParentsFirst(out.nodes)));
      setEdges(asRFEdges(out.edges));
      const rails = out.nodes.find((n) => n.id === target.id)?.data as BeatData;
      setNote(`promoted ${target.data.label} — ${rails.promotedIn.length} in, ${rails.promotedOut.length} out`);
      return undefined;
    },
    [edges, nodes, selectedContainer, setEdges, setNodes],
  );

  const dissolve = useCallback(
    (id?: string) => {
      const target = id ? (nodes as RFNode[]).find((n) => n.id === id) : selectedContainer();
      if (!target) return setNote("select a Beat first");
      if (target.type !== SUBGRAPH_TYPE) return setNote(`${target.data.label} is not promoted`);
      const out = dissolveSubgraph(target.id, asCore(nodes as RFNode[]), asCoreEdges(edges));
      setNodes(asRF(sortParentsFirst(out.nodes)));
      setEdges(asRFEdges(out.edges));
      setNote(`dissolved ${target.data.label} — rails merged back to direct wires`);
      return undefined;
    },
    [edges, nodes, selectedContainer, setEdges, setNodes],
  );

  const toggleCollapse = useCallback(
    (id?: string) => {
      const target = id ? (nodes as RFNode[]).find((n) => n.id === id) : selectedContainer();
      if (!target || target.type !== SUBGRAPH_TYPE) return setNote("collapse works on a promoted Beat");
      setNodes((ns) =>
        (ns as RFNode[]).map((n) =>
          n.id === target.id
            ? ({ ...n, data: { ...n.data, collapsed: !(n.data as BeatData).collapsed } } as RFNode)
            : n,
        ),
      );
      return undefined;
    },
    [nodes, selectedContainer, setNodes],
  );

  const beats = (nodes as RFNode[]).filter(isContainer);
  const promotedCount = beats.filter((b) => b.type === SUBGRAPH_TYPE).length;

  return (
    <div className="bd-root">
      <div className="bd-toolbar">
        <strong className="bd-brand">🎬 Director</strong>
        <button type="button" onClick={() => promote()}>Promote Beat</button>
        <button type="button" onClick={() => dissolve()}>Dissolve</button>
        <button type="button" onClick={() => toggleCollapse()}>Collapse</button>
        <span className="bd-sep" />
        <span className="bd-stat">
          {beats.length} beat{beats.length === 1 ? "" : "s"} · {promotedCount} promoted
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
      <div className="bd-canvas">
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
  );
}

/** Exposes the same actions the toolbar uses, for the agent-drive facade. */
export interface EditorApi {
  promote(id?: string): void;
  dissolve(id?: string): void;
  toggleCollapse(id?: string): void;
  outline(): unknown;
}

export function DirectorApp(props: DirectorAppProps & { apiRef?: { current: EditorApi | null } }) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}
