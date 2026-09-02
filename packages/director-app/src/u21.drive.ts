// [U21] Drive commands for the card bodies and the dopesheet.
//
// The agent reaches the same three verbs the pointer does — open a card, re-time a scene,
// re-cut the film — through the editor's own actions, so a command cannot take a path the
// mouse cannot. `timeline` is the read: the sheet as data, which is how an agent asks "what
// does this film look like" without inferring it from node positions.

import { registerDriveCommands, type DriveHandler } from "./drive-registry.js";
import type { SceneData } from "./model.js";
import { buildTimeline, clock, cutOf, type TimelineNode } from "./timeline-model.js";

const bool = (v: unknown, what: string): boolean => {
  if (typeof v === "boolean") return v;
  throw new Error(`${what} must be true or false`);
};

const set_expanded: DriveHandler = async (args, kit) =>
  kit.run((ns) => {
    const node = kit.find(ns, args.id);
    const want = args.expanded === undefined ? !(node.data as SceneData).expanded : bool(args.expanded, "expanded");
    kit.actions.setNodeExpanded(node.id, want);
    return { id: node.id, expanded: want };
  });

/** Re-time one scene. The same write the clip's right edge makes. */
const set_duration: DriveHandler = async (args, kit) =>
  kit.run((ns) => {
    const node = kit.find(ns, args.id);
    if (node.data.kind !== "scene") throw new Error(`${node.data.label} is not a scene, so it has no duration`);
    const seconds = Math.max(1, Math.round(kit.num(args.seconds, "seconds")));
    kit.actions.updateNode(node.id, { durationSec: seconds });
    return { id: node.id, durationSec: seconds };
  });

/**
 * Move a scene in the CUT. `to` is a 0-based position in the film, counted without the scene
 * being moved — the same index the dopesheet computes from where a clip is dropped.
 */
const reorder_scene: DriveHandler = async (args, kit) =>
  kit.run((ns) => {
    const node = kit.find(ns, args.id);
    const to = Math.max(0, Math.round(kit.num(args.to, "to")));
    kit.actions.reorderScene(node.id, to);
    return { id: node.id, to };
  });

/** Move a scene into a Beat, or out of every Beat with `beat_id: null`. */
const move_to_beat: DriveHandler = async (args, kit) =>
  kit.run((ns) => {
    const node = kit.find(ns, args.id);
    const target = args.beat === null || args.beat === undefined ? null : kit.find(ns, args.beat).id;
    kit.actions.moveToBeat(node.id, target);
    return { id: node.id, beat: target };
  });

/** The dopesheet as data: the film's length, its rows, and every clip's place in the cut. */
const timeline: DriveHandler = async (_args, kit) =>
  kit.run((ns) => {
    const model = buildTimeline(ns as unknown as TimelineNode[]);
    return {
      duration: model.duration,
      durationClock: clock(model.duration),
      mutedSec: model.mutedSec,
      cut: cutOf(ns as unknown as TimelineNode[]),
      rows: model.rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, start: r.start, end: r.end, clips: r.clipIds })),
      clips: model.clips.map((c) => ({ id: c.id, row: c.rowId, cut: c.cut, start: c.start, end: c.end, seconds: c.durationSec, label: c.label, bypassed: c.bypassed, rendered: c.hasClip })),
    };
  }, { history: false });

registerDriveCommands({ set_expanded, set_duration, reorder_scene, move_to_beat, timeline });
