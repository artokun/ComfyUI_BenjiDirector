// Director graph -> Calliope rows: the write-back direction.
//
// `projectToGraph` (calliope-bind.ts) says what a row looks like on the canvas. This module
// is the same mapping run in reverse, as a DIFF: given the graph before and after a settle,
// what does Calliope need to be told? The answer is a list of intents — one PATCH per touched
// scene — computed by a pure function so it can be tested without a server, and applied by
// a separate step that owns the network.
//
// What writes back, and where it lands (see the plan's "Calliope owns content, we own
// topology" correction — there is no free-form field on the project row):
//
//   heading / durationSec        -> scene.heading / scene.duration_sec        (content)
//   parentId (Beat)              -> scene.beat_id                              (native topology)
//   IN FRAME wire from a scene   -> scene.chain_from_prev                      (Calliope's own continuity flag)
//   position / pin               -> scene.video_settings.director.{position,promoted}
//
// Nothing here touches Beat-level topology (subgraph, collapsed, colour, rails) — Calliope has
// nowhere to put it; that is the local sidecar, later. And nothing here reorders scenes:
// order_index is the timeline, and inferring it from y-coordinates would move a film's cut
// order because someone tidied the canvas.

import type { GraphEdge, GraphNode } from "@benjidirector/graph-core";
import type { CalliopeClient, SceneRow } from "@benjidirector/calliope-client";
import { calId, calliopeRef } from "./calliope-bind.js";
import type { DirectorData, SceneData } from "./model.js";

export interface SceneIntent {
  sceneId: number;
  heading?: string;
  duration_sec?: number;
  beat_id?: number | null;
  chain_from_prev?: boolean;
  director?: { position?: { x: number; y: number }; promoted?: boolean };
}

export interface IntentFailure {
  sceneId: number;
  /** Which field Calliope did not apply, or "network" when the request itself failed. */
  field: "beat_id" | "chain_from_prev" | "heading" | "duration_sec" | "network";
  error: string;
}

interface Snapshot {
  nodes: readonly GraphNode<DirectorData>[];
  edges: readonly GraphEdge[];
}

const sceneOf = (n: GraphNode<DirectorData>) => (n.data.kind === "scene" ? (n.data as SceneData) : null);
const beatIdOf = (parentId: string | undefined): number | null => {
  if (!parentId) return null;
  const ref = calliopeRef(parentId);
  return ref?.kind === "beat" ? ref.id : null;
};
/** Is this scene's IN FRAME fed by another Calliope scene's LAST FRAME (directly, or through a rail)? */
function chainedFrom(sceneNodeId: string, edges: readonly GraphEdge[]): boolean {
  const target = `${sceneNodeId}:in:IN FRAME`;
  // Through a rail the target handle is still the child's own port on the INNER relay edge,
  // and its source is the container — either way, an edge terminating on this port means
  // "fed", and that is the fact chain_from_prev records.
  return edges.some((e) => e.targetHandle === target || e.targetHandle === `${target}`);
}

/**
 * Diff two settled graphs into Calliope intents. Only `cal-sc-*` nodes are considered;
 * anything the editor invented has no row to write to until it is created explicitly.
 */
export function diffForCalliope(prev: Snapshot, next: Snapshot): SceneIntent[] {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n] as const));
  const out: SceneIntent[] = [];

  for (const n of next.nodes) {
    const ref = calliopeRef(n.id);
    if (!ref || ref.kind !== "scene") continue;
    const now = sceneOf(n);
    if (!now) continue;
    const before = prevById.get(n.id);
    const was = before ? sceneOf(before) : null;
    const intent: SceneIntent = { sceneId: ref.id };
    let touched = false;

    if (was && now.heading !== was.heading) {
      intent.heading = now.heading;
      touched = true;
    }
    if (was && now.durationSec !== was.durationSec && now.durationSec !== undefined) {
      intent.duration_sec = now.durationSec;
      touched = true;
    }
    const beatNow = beatIdOf(n.parentId);
    const beatWas = before ? beatIdOf(before.parentId) : beatNow;
    if (before && beatNow !== beatWas) {
      intent.beat_id = beatNow;
      touched = true;
    }
    const chainNow = chainedFrom(n.id, next.edges);
    const chainWas = before ? chainedFrom(n.id, prev.edges) : chainNow;
    if (before && chainNow !== chainWas) {
      intent.chain_from_prev = chainNow;
      touched = true;
    }
    const posMoved = before && (before.position.x !== n.position.x || before.position.y !== n.position.y);
    const pinChanged = before && !!was?.promoted !== !!now.promoted;
    if (posMoved || pinChanged) {
      intent.director = {
        ...(posMoved ? { position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } } : {}),
        ...(pinChanged ? { promoted: !!now.promoted } : {}),
      };
      touched = true;
    }
    if (touched) out.push(intent);
  }
  return out;
}

/**
 * Apply intents. `settingsCache` holds each scene's current `video_settings` (seeded at load,
 * updated here) so a director sub-object can be merged without clobbering Calliope's own keys
 * — `prompt_draft` and its freshness hash live in the same object.
 */
export async function applyIntents(
  client: CalliopeClient,
  projectId: number,
  intents: SceneIntent[],
  settingsCache: Map<number, Record<string, unknown>>,
): Promise<{ applied: number; failed: IntentFailure[] }> {
  let applied = 0;
  const failed: IntentFailure[] = [];
  for (const it of intents) {
    const body: Record<string, unknown> = {};
    if (it.heading !== undefined) body.heading = it.heading;
    if (it.duration_sec !== undefined) body.duration_sec = it.duration_sec;
    if (it.beat_id !== undefined) body.beat_id = it.beat_id;
    if (it.chain_from_prev !== undefined) body.chain_from_prev = it.chain_from_prev;
    if (it.director) {
      const current = settingsCache.get(it.sceneId) ?? {};
      const director = { ...((current.director as Record<string, unknown> | undefined) ?? {}), ...it.director };
      const merged = { ...current, director };
      body.video_settings = merged;
      settingsCache.set(it.sceneId, merged);
    }
    let row: SceneRow;
    try {
      row = (await client.scenes.patch(projectId, it.sceneId, body as never)) as SceneRow;
    } catch (err) {
      failed.push({ sceneId: it.sceneId, field: "network", error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (row && row.video_settings && typeof row.video_settings === "object") settingsCache.set(it.sceneId, row.video_settings);
    // A 200 is not evidence the write landed: Calliope 1.2.1's update_scene drops every
    // explicit null before building its UPDATE, so `beat_id: null` returns the row unchanged.
    // The response IS the row — compare it with what we asked for, field by field.
    const miss = verifyEcho(it, row);
    if (miss) failed.push(miss);
    else applied += 1;
  }
  return { applied, failed };
}

/** The first field the returned row disagrees with, or null when every requested field landed. */
export function verifyEcho(it: SceneIntent, row: SceneRow): IntentFailure | null {
  const say = (field: IntentFailure["field"], asked: unknown, got: unknown): IntentFailure => ({
    sceneId: it.sceneId,
    field,
    error: `Calliope accepted the PATCH but did not apply ${field}=${JSON.stringify(asked)} (row still has ${JSON.stringify(got)})`,
  });
  if (it.beat_id !== undefined && (row.beat_id ?? null) !== it.beat_id) return say("beat_id", it.beat_id, row.beat_id ?? null);
  if (it.chain_from_prev !== undefined && !!row.chain_from_prev !== it.chain_from_prev) return say("chain_from_prev", it.chain_from_prev, !!row.chain_from_prev);
  if (it.heading !== undefined && row.heading !== it.heading) return say("heading", it.heading, row.heading);
  if (it.duration_sec !== undefined && row.duration_sec !== it.duration_sec) return say("duration_sec", it.duration_sec, row.duration_sec);
  return null;
}

/** Node id for a Calliope scene id — exported so the hook can seed the settings cache. */
export const sceneNodeId = calId.scene;
