// Deleting a Beat — the UI part.
//
// Three entry points ask for a deletion (the container toolbar's trash, the Delete key, the
// pane toolbar's Delete) and one component answers: `DeleteContainerHost`, mounted through the
// canvas-overlay slot so it sits inside the modal, actions and React Flow providers. An empty
// Beat goes at once; a populated one gets ifr-node-lab's choice — everything, or only the
// shell with its scenes standing where they were — listed by name so nothing is deleted on a
// guess. The agent has the same two modes as `delete_container`.

import { useReactFlow, type Edge } from "@xyflow/react";
import { useCallback, useEffect, useRef } from "react";
import { SUBGRAPH_TYPE, isGroupLikeType, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { useActions } from "./actions.js";
import { cascadeDeletePlan, describeDescendants, requestDeleteContainer, setDeleteContainerHandler, shellDeletePlan } from "./container-delete.js";
import { useDirector } from "./director-context.jsx";
import { registerDriveCommands, type RFNode } from "./drive-registry.js";
import { Icon } from "./icons.jsx";
import { useModal } from "./modal.jsx";
import type { DirectorData } from "./model.js";
import { registerSlot } from "./slots.jsx";
import "./styles/u5-container-delete.css";

type CoreNode = GraphNode<DirectorData>;
const asCore = (ns: RFNode[]) => ns as unknown as CoreNode[];
const asCoreEdges = (es: Edge[]) => es as unknown as GraphEdge[];

/** The trash button on a container's toolbar. Asks; never cascades on its own. */
export function DeleteContainerButton({ id }: { id: string }) {
  const { setNote } = useDirector();
  return (
    <button
      type="button"
      className="bd-tbtn bd-cdel-btn"
      title="Delete this Beat"
      onClick={(e) => {
        e.stopPropagation();
        if (!requestDeleteContainer(id)) setNote("the delete confirm is not mounted — nothing was deleted");
      }}
    >
      <Icon name="trash" />
    </button>
  );
}

/** Owns the confirm flow. Renders nothing; installs itself as the answer to `requestDeleteContainer`. */
function DeleteContainerHost() {
  const modal = useModal();
  const actions = useActions();
  const { getNodes } = useReactFlow();
  /** The Beat whose modal is up, so a second Delete keypress does not queue a second modal. */
  const pending = useRef<string | null>(null);

  const request = useCallback(
    (id: string) => {
      if (pending.current === id) return;
      const ns = asCore(getNodes() as RFNode[]);
      const target = ns.find((n) => n.id === id);
      if (!target || !isGroupLikeType(target.type)) return;
      const rows = describeDescendants(ns, id);
      if (rows.length === 0) {
        actions?.deleteContainer(id, "all");
        return;
      }
      pending.current = id;
      const isSubgraph = target.type === SUBGRAPH_TYPE;
      const count = rows.length;
      void modal
        .choose({
          title: `Delete “${target.data.label}”?`,
          body: (
            <>
              <div className="bd-cdel-lede">
                This {isSubgraph ? "subgraph" : "group"} holds {count} node{count === 1 ? "" : "s"}. Delete {count === 1 ? "it" : "them"} too, or drop only the
                Beat and leave {count === 1 ? "it" : "them"} where {count === 1 ? "it stands" : "they stand"}.
              </div>
              <div className="bd-cdel-list">
                {rows.map((r) => (
                  <div key={r.id} className="bd-cdel-row" data-id={r.id} style={{ paddingLeft: 10 + (r.depth - 1) * 14 }}>
                    <span className="bd-cdel-label">{r.label}</span>
                    <span className="bd-cdel-kind">{r.kind}</span>
                  </div>
                ))}
              </div>
            </>
          ),
          options: [
            { id: "all", label: "Delete all", hint: `${count + 1} nodes`, danger: true },
            { id: "shell", label: "Delete only the Beat", hint: isSubgraph ? "rails become wires; nothing moves" : "nothing moves" },
          ],
        })
        .then((pick) => {
          pending.current = null;
          if (pick === "all" || pick === "shell") actions?.deleteContainer(id, pick);
        });
    },
    [actions, getNodes, modal],
  );

  useEffect(() => setDeleteContainerHandler(request), [request]);
  return null;
}

registerSlot("canvas-overlay", DeleteContainerHost, { id: "u5-container-delete", order: 0 });

// ── the agent's path: the same plans, through the same settle ──────────────────────────
registerDriveCommands({
  delete_container: (args, kit) =>
    kit.run((ns, es) => {
      const target = kit.find(ns, args.id);
      if (!kit.isContainer(target)) throw new Error(`"${target.id}" is not a Beat — remove_node deletes a leaf`);
      const mode = args.mode;
      if (mode !== "all" && mode !== "shell") throw new Error('mode must be "all" (the Beat and everything in it) or "shell" (only the Beat; its nodes stay where they are)');
      const plan = mode === "shell" ? shellDeletePlan(asCore(ns), asCoreEdges(es), target.id) : cascadeDeletePlan(asCore(ns), asCoreEdges(es), target.id);
      // reparent OFF: the shell plan placed each child where it stood; re-deriving by geometry
      // could hand one to a neighbouring Beat that merely overlaps it.
      kit.settle(plan.nodes as unknown as RFNode[], plan.edges as unknown as Edge[], { reparent: false });
      return { id: target.id, mode, removed: plan.removed, reparented: plan.reparented };
    }),
});
