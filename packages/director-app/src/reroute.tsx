// The reroute dot: a bend in a wire you can pick up.
//
// ifr-node-lab has no reroute, so this is a new design rather than a port. What it has to be
// is a NON-node: a 14px dot in the wire's own colour, no card, no title, no toolbar — because
// the moment it looks like a node, a graph with six bends in it reads as a graph with six more
// things in it. Everything else follows from that:
//
//  - ONE dot, TWO handles. The input sits on the dot's left edge and the output on its right,
//    both transparent and both small, so what you see is a point the wire passes through. They
//    are deliberately NOT stacked at the exact centre: a drop is hit-tested with
//    `elementFromPoint`, so two handles on one pixel means the lower one can never be reached.
//    React Flow's connectionRadius (20) makes edge-mounted handles just as easy to drop on.
//  - The middle of the dot stays free for DRAGGING, and an invisible ring around it widens the
//    grab area without widening what is drawn.
//  - Delete rejoins the wire. React Flow's own delete key would take the dot and both halves
//    and leave the graph cut in two, so the key is intercepted in the capture phase and routed
//    through `remove_node`, which is the same path the × takes — and the same one the agent
//    reaches. That interception is deliberately narrow: only when every selected node is a dot.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useEffect } from "react";
import type { Edge } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "@benjidirector/graph-core";
import { useDirector } from "./director-context.jsx";
import { registerDriveCommands, type RFNode } from "./drive-registry.js";
import { Icon } from "./icons.jsx";
import { PORT_COLOR, type DirectorData, type RerouteData } from "./model.js";
import { REROUTE_SIZE, isRefusal, spliceReroute } from "./reroute-ops.js";
import "./styles/u8b-reroute.css";

/**
 * Which nodes on the canvas are dots, as they mount.
 *
 * The keyboard guard has to answer "is the whole selection reroutes?" synchronously, before
 * deciding whether to swallow the key — and the selection reaches a node renderer as bare ids.
 * A mount-time registry answers it without asking the editor for the graph.
 */
const mounted = new Set<string>();

export function RerouteNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as RerouteData;
  const { drive, selectedNodeIds, setNote } = useDirector();
  const color = PORT_COLOR[d.portType] ?? "#9ca3af";
  const ports = d.ports ?? [];
  const inPort = ports.find((p) => p.isInput);
  const outPort = ports.find((p) => !p.isInput);

  useEffect(() => {
    mounted.add(id);
    return () => {
      mounted.delete(id);
    };
  }, [id]);

  // One handler for the whole selection, installed by the first SELECTED DOT — not by the
  // first selected node, because a dot mixed in with two scenes is exactly the case React
  // Flow would get wrong, and the one worth taking.
  //
  // Taking the key means taking ALL of it: any wires the user had selected go first (Delete
  // would otherwise half-work, silently), then every selected node in turn. In turn matters —
  // each command runs through withCurrent, so firing them together would have each read the
  // same pre-state and only the last write would survive.
  const owner = !!selected && selectedNodeIds.find((s) => mounted.has(s)) === id;
  useEffect(() => {
    if (!owner) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const edgeIds = [...document.querySelectorAll<HTMLElement>(".react-flow__edge.selected")]
        .map((n) => n.dataset.id)
        .filter((x): x is string => !!x);
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        try {
          for (const edgeId of edgeIds) await drive("disconnect", { edge_id: edgeId });
          for (const target of selectedNodeIds) await drive("remove_node", { id: target });
        } catch (err) {
          // A concurrent settle can take a node out from under the loop; say so rather than
          // leaving an unhandled rejection and half a deletion with no explanation.
          setNote(err instanceof Error ? err.message : String(err));
        }
      })();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drive, owner, selectedNodeIds, setNote]);

  return (
    <div
      className={`bd-reroute${selected ? " is-selected" : ""}`}
      // The bead's size is the same number the containment maths sizes the node with, so the
      // centre it is drawn around is the centre a drop is resolved against.
      style={{ ["--bd-reroute-color" as string]: color, ["--bd-reroute-size" as string]: `${REROUTE_SIZE}px` }}
      title={`reroute · ${d.portType} — ${d.label}\ndrag to move, Delete to remove and rejoin the wire`}
    >
      <span className="bd-reroute-dot" />
      <span className="bd-reroute-type">{d.portType}</span>
      {inPort ? <Handle type="target" position={Position.Left} id={inPort.id} className="bd-reroute-h" /> : null}
      {outPort ? <Handle type="source" position={Position.Right} id={outPort.id} className="bd-reroute-h" /> : null}
      <button
        type="button"
        className="bd-reroute-x nodrag nopan"
        title="Remove this reroute and rejoin the wire"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void drive("remove_node", { id });
        }}
      >
        <Icon name="x" size={8} strokeWidth={2.5} />
      </button>
    </div>
  );
}

// The agent's way in. Same splice the edge menu runs, same settle, same minted id — a dot the
// agent drops is indistinguishable from one the mouse dropped.
registerDriveCommands({
  reroute: (args, kit) => {
    // Validated BEFORE run, like add_node: withCurrent snapshots for undo on the way in, so a
    // command that was never going to run would otherwise cost the user an undo slot.
    const edgeId = kit.str(args.edge_id, "edge_id");
    const at = { x: kit.num(args.x, "x"), y: kit.num(args.y, "y") };
    return kit.run((ns, es) => {
      const out = spliceReroute(ns as unknown as GraphNode<DirectorData>[], es as unknown as GraphEdge[], edgeId, at, kit.handleTypes(ns));
      if (isRefusal(out)) throw new Error(out.error);
      // Reparent ON: a dot dropped inside a Beat joins it, exactly as a drag would.
      kit.settle(out.nodes as unknown as RFNode[], out.edges as unknown as Edge[]);
      kit.setNote(`reroute on the ${out.type} wire`);
      return { id: out.id, type: out.type };
    });
  },
});
