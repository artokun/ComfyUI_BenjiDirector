// Calliope rows -> a Director graph.
//
// Calliope owns the content; the Director owns the topology. This module is the projection:
// a story bundle plus its scenes become asset nodes, Beat containers and Scene nodes, and the
// relationships Calliope already records become wires —
//
//   scene.character_ids[0]  -> CHARACTER input      (a Calliope character IS a ref)
//   scene.location_id       -> LOCATION input
//   scene.chain_from_prev   -> previous scene's LAST FRAME into this scene's IN FRAME
//
// That last one is the continuity wire, and it is not our invention: `chain_from_prev` is
// Calliope's own flag for "this shot continues from the one before", so a wire on the canvas
// and a flag in the database are the same fact seen from two sides.
//
// Positions come from `video_settings.director.position` when a scene has been laid out
// before, and from a deterministic layout when it has not, so a project loads the same way
// twice. Node ids embed the Calliope id (`cal-sc-12`) so a write-back can find its row.

import type { GraphEdge } from "@benjidirector/graph-core";
import type { SceneRow, StoryBundle } from "@benjidirector/calliope-client";
import { asset, beat, scene, type DirectorNode } from "./model.js";

export const CAL_PREFIX = { scene: "cal-sc-", beat: "cal-beat-", character: "cal-char-", location: "cal-loc-", item: "cal-item-" } as const;

export const calId = {
  scene: (id: number) => `${CAL_PREFIX.scene}${id}`,
  beat: (id: number) => `${CAL_PREFIX.beat}${id}`,
  character: (id: number) => `${CAL_PREFIX.character}${id}`,
  location: (id: number) => `${CAL_PREFIX.location}${id}`,
  item: (id: number) => `${CAL_PREFIX.item}${id}`,
};

/** Recover the Calliope row a node stands for, or null for a node the editor invented. */
export function calliopeRef(nodeId: string): { kind: keyof typeof CAL_PREFIX; id: number } | null {
  for (const [kind, prefix] of Object.entries(CAL_PREFIX) as Array<[keyof typeof CAL_PREFIX, string]>) {
    if (nodeId.startsWith(prefix)) {
      const n = Number(nodeId.slice(prefix.length));
      if (Number.isInteger(n)) return { kind, id: n };
    }
  }
  return null;
}

export interface CalliopeProjectData {
  story: StoryBundle;
  scenes: SceneRow[];
}

interface DirectorSceneSettings {
  position?: { x: number; y: number };
  promoted?: boolean;
}

function directorSettings(s: SceneRow): DirectorSceneSettings {
  const d = (s.video_settings as { director?: unknown } | null)?.director;
  return d && typeof d === "object" ? (d as DirectorSceneSettings) : {};
}

const ASSET_X = 40;
const ASSET_GAP = 130;
const BEAT_X0 = 340;
const BEAT_GAP = 560;
const BEAT_W = 460;
const SCENE_Y0 = 60;
const SCENE_GAP = 160;
const BEAT_PAD_BOTTOM = 60;
/** The smallest footprint a scene card can have — what "inside the box" is measured with. */
const SCENE_MIN_W = 120;
const SCENE_MIN_H = 60;
/** A relative y above this would put the card on the Beat's title bar. */
const SCENE_TOP_MIN = 30;

const link = (source: string, sourceHandle: string, target: string, targetHandle: string): GraphEdge => ({
  id: `lg:${sourceHandle}->${targetHandle}`,
  source,
  target,
  sourceHandle,
  targetHandle,
});

export function projectToGraph(data: CalliopeProjectData): { nodes: DirectorNode[]; edges: GraphEdge[] } {
  const nodes: DirectorNode[] = [];
  const edges: GraphEdge[] = [];
  const { story } = data;

  // ── assets down the left ──
  let ay = 60;
  for (const c of story.characters) {
    nodes.push(asset(calId.character(c.id), c.name, "character", { x: ASSET_X, y: ay }));
    ay += ASSET_GAP;
  }
  for (const l of story.locations) {
    nodes.push(asset(calId.location(l.id), l.name, "location", { x: ASSET_X, y: ay }));
    ay += ASSET_GAP;
  }
  for (const it of story.items) {
    nodes.push(asset(calId.item(it.id), it.name, "item", { x: ASSET_X, y: ay }));
    ay += ASSET_GAP;
  }

  // ── beats left to right, scenes stacked inside ──
  const scenes = [...data.scenes].sort((a, b) => a.order_index - b.order_index);
  const beats = [...story.beats].sort((a, b) => a.order_index - b.order_index);
  const byBeat = new Map<number, SceneRow[]>();
  const orphans: SceneRow[] = [];
  for (const s of scenes) {
    if (s.beat_id !== null && beats.some((b) => b.id === s.beat_id)) byBeat.set(s.beat_id, [...(byBeat.get(s.beat_id) ?? []), s]);
    else orphans.push(s);
  }

  // A stored position is only as good as the row it was written against. Relative to a Beat
  // it must land inside that Beat's box; absolute at the top level it must not sit on top of
  // a Beat it does not belong to (that is how a scene ends up re-parented by geometry on the
  // next settle and the canvas quietly disagrees with the row). Anything else takes the slot.
  const beatBox = new Map<string, { x: number; y: number; w: number; h: number }>();
  const placeScene = (s: SceneRow, fallback: { x: number; y: number }, parentId?: string) => {
    const ds = directorSettings(s);
    let position = fallback;
    if (ds.position) {
      const p = ds.position;
      if (parentId) {
        const box = beatBox.get(parentId);
        if (box && p.x >= 0 && p.y >= SCENE_TOP_MIN && p.x <= box.w - SCENE_MIN_W && p.y <= box.h - SCENE_MIN_H) position = p;
      } else {
        const overlaps = [...beatBox.values()].some((b) => p.x + SCENE_MIN_W > b.x && p.x < b.x + b.w && p.y + SCENE_MIN_H > b.y && p.y < b.y + b.h);
        if (!overlaps) position = p;
      }
    }
    nodes.push(
      scene(
        calId.scene(s.id),
        s.heading || `Scene ${s.order_index + 1}`,
        position,
        {
          orderIndex: s.order_index,
          action: s.action ?? undefined,
          durationSec: s.duration_sec ?? undefined,
          videoPath: s.video_path ?? undefined,
          promoted: ds.promoted,
        },
        parentId,
      ),
    );
  };

  beats.forEach((b, i) => {
    const inside = byBeat.get(b.id) ?? [];
    const height = SCENE_Y0 + Math.max(inside.length, 1) * SCENE_GAP + BEAT_PAD_BOTTOM;
    const id = calId.beat(b.id);
    const pos = { x: BEAT_X0 + i * BEAT_GAP, y: 40 };
    beatBox.set(id, { ...pos, w: BEAT_W, h: height });
    nodes.push(beat(id, b.title, pos, { width: BEAT_W, height }));
  });
  // Scenes after every Beat box is known, so an orphan can be checked against all of them.
  beats.forEach((b) => {
    const id = calId.beat(b.id);
    (byBeat.get(b.id) ?? []).forEach((s, j) => placeScene(s, { x: 40, y: SCENE_Y0 + j * SCENE_GAP }, id));
  });
  orphans.forEach((s, j) => placeScene(s, { x: BEAT_X0 + beats.length * BEAT_GAP, y: 60 + j * SCENE_GAP }));

  // ── wires Calliope already knows about ──
  let prev: SceneRow | null = null;
  for (const s of scenes) {
    const sid = calId.scene(s.id);
    const firstChar = s.character_ids?.[0];
    if (firstChar !== undefined && story.characters.some((c) => c.id === firstChar)) {
      edges.push(link(calId.character(firstChar), `${calId.character(firstChar)}:out:REF`, sid, `${sid}:in:CHARACTER`));
    }
    if (s.location_id !== null && story.locations.some((l) => l.id === s.location_id)) {
      edges.push(link(calId.location(s.location_id), `${calId.location(s.location_id)}:out:REF`, sid, `${sid}:in:LOCATION`));
    }
    if (prev && s.chain_from_prev) {
      const pid = calId.scene(prev.id);
      edges.push(link(pid, `${pid}:out:LAST FRAME`, sid, `${sid}:in:IN FRAME`));
    }
    prev = s;
  }

  return { nodes, edges };
}
