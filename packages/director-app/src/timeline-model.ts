// The film as a DOPESHEET: the same graph the canvas draws, projected onto a time axis.
//
// State stays CANONICAL. Nothing here is stored — every row and clip below is derived from the
// nodes on every render, the way `collapse-view` derives what React Flow draws. Two views of
// one graph cannot disagree if only one of them owns state.
//
// The layout, and why it is shaped this way:
//
//   • The X axis is SECONDS of the finished film, shared by every row. A scene's start is the
//     sum of the durations before it in the cut — never a stored field, because Calliope has
//     no such field: `order_index` IS the timeline and `duration_sec` is the length.
//   • Row 0 is FILM: every scene, end to end, the master track.
//   • Then one row per BEAT that holds scenes, placed at its own scenes' absolute positions.
//     That is the "shorter timeline" a Beat has — a segment of the film, not its own clock, so
//     a glance down the column says which Beat is playing at 0:42.
//   • A scene in no Beat gets the LOOSE row, so nothing is invisible here.
//
// One deliberate difference from the canvas. `calliope-sync` refuses to infer `order_index`
// from geometry, because tidying the canvas must never re-cut the film. A dopesheet drag is
// the opposite: moving a clip along the time axis is the user SAYING "this comes later". So
// the cut order is editable here and nowhere else, and `reorderCut` below is that edit —
// a pure list permutation the caller hands to Calliope's own reorder route.

import { isGroupLikeType } from "@benjidirector/graph-core";
import type { DirectorData, SceneData } from "./model.js";

/** A scene with no duration still has to occupy the axis, or the cut after it lies. */
export const DEFAULT_CLIP_SEC = 4;
/** Below this the clip is a tick: no room for a label, and dragging its edge is a coin toss. */
export const MIN_CLIP_SEC = 1;

/** The shape this module reads. React Flow's `Node` and graph-core's `GraphNode` both fit. */
export interface TimelineNode {
  id: string;
  type?: string;
  parentId?: string;
  data: unknown;
  position?: { x: number; y: number };
  selected?: boolean;
}

export interface TimelineClip {
  /** The NODE's id. A clip is a view of a scene, never a thing of its own. */
  id: string;
  rowId: string;
  /** Seconds from the top of the film. */
  start: number;
  end: number;
  durationSec: number;
  label: string;
  /** Position in the cut, 0-based and contiguous across the whole film. */
  cut: number;
  /** Calliope's scene id, or null for a scene that has no row yet. */
  sceneId: number | null;
  color?: string;
  bypassed: boolean;
  /** A render has landed, so the clip can show a frame. */
  hasClip: boolean;
  selected: boolean;
}

export type TimelineRowKind = "film" | "beat" | "loose";

export interface TimelineRow {
  /** "film", the Beat's node id, or "loose". */
  id: string;
  kind: TimelineRowKind;
  label: string;
  /** The row's own span — for a Beat, the shorter timeline it owns. */
  start: number;
  end: number;
  clipIds: string[];
  color?: string;
  /** The Beat is collapsed on the canvas; the row says so rather than hiding. */
  collapsed?: boolean;
  /** The container node this row stands for, so a click can select it. */
  nodeId?: string;
}

export interface TimelineModel {
  rows: TimelineRow[];
  clips: TimelineClip[];
  /** The whole film, in seconds. */
  duration: number;
  /** How much of `duration` is muted, so the header can say what a render would skip. */
  mutedSec: number;
}

const sceneOf = (n: TimelineNode): SceneData | null => {
  const d = n.data as DirectorData | undefined;
  return d && d.kind === "scene" ? (d as SceneData) : null;
};

const isContainer = (n: TimelineNode): boolean => isGroupLikeType(n.type);

/** `cal-sc-12` → 12. A scene the editor invented has no row and no id. */
function sceneIdOf(nodeId: string): number | null {
  const m = /^cal-sc-(\d+)$/.exec(nodeId);
  return m ? Number(m[1]) : null;
}

/**
 * The nearest container above a node, or undefined. Nearest, not outermost: a scene in a group
 * inside a Beat belongs to the group's row if the group holds scenes, which is the row the eye
 * expects next to it on the canvas.
 */
function ownerOf(nodeId: string, byId: ReadonlyMap<string, TimelineNode>): string | undefined {
  const p = byId.get(nodeId)?.parentId;
  if (!p) return undefined;
  return byId.has(p) ? p : undefined;
}

/**
 * The cut, as an ordered list of scene node ids.
 *
 * `orderIndex` is Calliope's `order_index` and wins wherever it exists — it is the film's real
 * cut and the only thing a reload agrees with. A scene without one (the demo graph, or a node
 * placed before its row was made) falls in after them, left to right, which is how a canvas
 * reads. Ties break on id so the order never depends on array order.
 */
export function cutOf(nodes: readonly TimelineNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  // ABSOLUTE x, not the stored one: a scene inside a Beat is positioned relative to it, so
  // comparing raw values would sort a card at x=40 inside a Beat far to the right against a
  // naked card at x=900 as if they were on the same ruler.
  const absX = (n: TimelineNode): number => {
    let x = n.position?.x ?? 0;
    let p = n.parentId;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const a = byId.get(p);
      if (!a) break;
      x += a.position?.x ?? 0;
      p = a.parentId;
    }
    return x;
  };
  const scenes = nodes.filter((n) => sceneOf(n));
  return scenes
    .map((n) => ({ n, oi: sceneOf(n)?.orderIndex, x: absX(n) }))
    .sort((a, b) => {
      const ao = typeof a.oi === "number" ? a.oi : Number.POSITIVE_INFINITY;
      const bo = typeof b.oi === "number" ? b.oi : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      if (a.x !== b.x) return a.x - b.x;
      return a.n.id < b.n.id ? -1 : a.n.id > b.n.id ? 1 : 0;
    })
    .map((e) => e.n.id);
}

/** The seconds a scene occupies. Clamped, because a zero-length clip cannot be grabbed. */
export const clipSeconds = (d: SceneData): number => Math.max(MIN_CLIP_SEC, d.durationSec ?? DEFAULT_CLIP_SEC);

/**
 * Project the graph onto the axis. Pure: same nodes in, same model out, no state touched.
 */
export function buildTimeline(nodes: readonly TimelineNode[]): TimelineModel {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const order = cutOf(nodes);

  const clips: TimelineClip[] = [];
  let running = 0;
  let mutedSec = 0;
  order.forEach((id, cut) => {
    const n = byId.get(id);
    const d = n ? sceneOf(n) : null;
    if (!n || !d) return;
    const durationSec = clipSeconds(d);
    const owner = ownerOf(id, byId);
    // A muted scene keeps its slot: the dopesheet shows the cut as AUTHORED, and hiding a
    // bypassed scene would silently shift every clip after it.
    if (d.bypassed) mutedSec += durationSec;
    clips.push({
      id,
      rowId: owner && isContainer(byId.get(owner) as TimelineNode) ? owner : "loose",
      start: running,
      end: running + durationSec,
      durationSec,
      label: d.heading || d.label,
      cut,
      sceneId: sceneIdOf(id),
      color: d.color,
      bypassed: !!d.bypassed,
      hasClip: !!d.videoPath,
      selected: !!n.selected,
    });
    running += durationSec;
  });

  const duration = running;
  const byRow = new Map<string, TimelineClip[]>();
  for (const c of clips) {
    const list = byRow.get(c.rowId);
    if (list) list.push(c);
    else byRow.set(c.rowId, [c]);
  }

  const rows: TimelineRow[] = [
    { id: "film", kind: "film", label: "Film", start: 0, end: duration, clipIds: clips.map((c) => c.id) },
  ];
  // Beats in the order their scenes play, not the order they sit in the nodes array — a row
  // whose clips are later must be lower, or the sheet reads as noise.
  const beatRows = [...byRow.entries()]
    .filter(([rowId]) => rowId !== "loose")
    .map(([rowId, list]) => {
      const node = byId.get(rowId);
      const d = node?.data as { label?: string; color?: string; collapsed?: boolean } | undefined;
      return {
        id: rowId,
        kind: "beat" as const,
        label: d?.label ?? rowId,
        start: Math.min(...list.map((c) => c.start)),
        end: Math.max(...list.map((c) => c.end)),
        clipIds: list.map((c) => c.id),
        color: d?.color,
        collapsed: !!d?.collapsed,
        nodeId: rowId,
      };
    })
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  rows.push(...beatRows);

  const loose = byRow.get("loose");
  if (loose?.length) {
    rows.push({
      id: "loose",
      kind: "loose",
      label: "No Beat",
      start: Math.min(...loose.map((c) => c.start)),
      end: Math.max(...loose.map((c) => c.end)),
      clipIds: loose.map((c) => c.id),
    });
  }

  return { rows, clips, duration, mutedSec };
}

/**
 * Move one scene to a new place in the cut, returning the FULL id list in its new order.
 *
 * Full, not a pair, because that is what Calliope's reorder route takes and what keeps
 * `order_index` contiguous — the same dance its own script stage does after a create.
 * `to` is the index the clip should END UP at, counted in the list WITHOUT the moved id, so
 * dropping a clip on the far right lands it last rather than one short of it.
 */
export function reorderCut(cut: readonly string[], id: string, to: number): string[] {
  const from = cut.indexOf(id);
  if (from < 0) return [...cut];
  const rest = cut.filter((x) => x !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * Where a clip dropped at `seconds` belongs in the cut, counted in the list WITHOUT it.
 *
 * The boundary is a clip's MIDPOINT: past half of a neighbour, the drop reads as "after it".
 * Measuring against starts alone makes the last position unreachable.
 */
export function cutIndexAt(clips: readonly TimelineClip[], movingId: string, seconds: number): number {
  const others = clips.filter((c) => c.id !== movingId).sort((a, b) => a.cut - b.cut);
  let i = 0;
  for (const c of others) {
    if (seconds < c.start + c.durationSec / 2) break;
    i += 1;
  }
  return i;
}

/** "0:04", "1:23", "12:05". Seconds are the unit the whole sheet speaks. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Ruler ticks: a step that keeps them readable at any zoom, and never fewer than two.
 * Steps climb 1 / 2 / 5 / 10 / 15 / 30 / 60 …, the intervals a cut is actually spoken in.
 */
export function rulerStep(durationSec: number, pxPerSec: number): number {
  const MIN_PX = 56;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s * pxPerSec >= MIN_PX) return s;
  return Math.max(1, Math.ceil(durationSec / 8));
}
