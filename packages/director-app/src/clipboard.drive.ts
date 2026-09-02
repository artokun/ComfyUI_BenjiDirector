// Drive commands for the clipboard: copy / paste / duplicate / select.
//
// The hotkeys call these same commands (useEditorHotkeys → drive), so Ctrl+C and the agent's
// `copy` share one clipboard and one code path. The clip lives here, module-scoped: it must
// outlive any one render and be reachable from both the keyboard and the drive layer, and
// nothing outside this unit needs to see it.

import type { Edge } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "@benjidirector/graph-core";
import { copySelection, pasteClip, type Clip } from "./clipboard.js";
import { registerDriveCommands, type DriveKit, type RFNode } from "./drive-registry.js";
import type { DirectorData } from "./model.js";

let clip: Clip | null = null;

/** Is there something to paste? */
export const hasClip = (): boolean => !!clip?.nodes.length;

/** For tests. */
export const _setClip = (c: Clip | null): void => {
  clip = c;
};

const asCore = (ns: RFNode[]) => ns as unknown as GraphNode<DirectorData>[];
const asCoreEdges = (es: Edge[]) => es as unknown as GraphEdge[];
const asRF = (ns: GraphNode<DirectorData>[]) => ns as unknown as RFNode[];
const asRFEdges = (es: GraphEdge[]) => es as unknown as Edge[];

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** `ids[]` as a list of non-empty strings, every one of which must exist. */
function idList(ns: RFNode[], v: unknown, kit: DriveKit): string[] {
  if (!Array.isArray(v)) throw new Error("ids must be an array of node ids");
  const ids = (v as unknown[]).map((x) => kit.str(x, "ids[]"));
  for (const id of ids) kit.find(ns, id);
  return ids;
}

registerDriveCommands({
  copy: (args, kit) =>
    kit.run(
      (ns, es) => {
        const ids = idList(ns, args.ids, kit);
        if (!ids.length) throw new Error("ids must name at least one node");
        const c = copySelection(asCore(ns), asCoreEdges(es), ids);
        clip = c;
        kit.setNote(`copied ${plural(c.nodes.length, "node")}`);
        return { ids: c.nodes.map((n) => n.id) };
      },
      { history: false },
    ),

  paste: (args, kit) =>
    kit.run((ns, es) => {
      if (!clip?.nodes.length) throw new Error("the clipboard is empty — copy first");
      // Both coordinates, or neither: with neither, the copy lands 40px down-right of where
      // it was taken from, which is what a paste with no pointer to anchor on should do.
      const at = args.x === undefined && args.y === undefined ? null : { x: kit.num(args.x, "x"), y: kit.num(args.y, "y") };
      const out = pasteClip(clip, at, ns.map((n) => n.id));
      const pasted = asRF(out.nodes).map((n) => ({ ...n, selected: true }) as RFNode);
      // Reparent ON: a paste that lands inside a Beat joins it, exactly as a drag would.
      kit.settle(
        [...ns.map((n) => (n.selected ? ({ ...n, selected: false } as RFNode) : n)), ...pasted],
        [...es.map((e) => (e.selected ? { ...e, selected: false } : e)), ...asRFEdges(out.edges)],
      );
      kit.setNote(`pasted ${plural(out.ids.length, "node")}`);
      return { ids: out.ids };
    }),

  duplicate: (args, kit) =>
    kit.run(
      (ns) => {
        const ids = idList(ns, args.ids, kit);
        if (!ids.length) throw new Error("ids must name at least one node");
        // The editor action IS the implementation (it snapshots for undo itself).
        return { ids: kit.actions.duplicate(ids) };
      },
      { history: false },
    ),

  select: (args, kit) =>
    kit.run(
      (ns, es) => {
        const ids = idList(ns, args.ids, kit);
        const want = new Set(ids);
        // Selection is not an edit: no undo entry, no write-back, no re-parenting.
        kit.settle(
          ns.map((n) => (!!n.selected === want.has(n.id) ? n : ({ ...n, selected: want.has(n.id) } as RFNode))),
          es.map((e) => (e.selected ? { ...e, selected: false } : e)),
          { reparent: false, sync: false },
        );
        return { ids };
      },
      { history: false },
    ),
});
