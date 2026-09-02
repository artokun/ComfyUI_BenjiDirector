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
  director?: { position?: { x: number; y: number }; promoted?: boolean; bypassed?: boolean; color?: string | null; collapsed?: boolean };
  // ── [U0] fields the inspector / write-back units send; verified by echo like the rest ──
  action?: string | null;
  dialog?: string | null;
  location_id?: number | null;
  character_ids?: number[];
  workflow_id?: number | null;
  env_image_path?: string | null;
}

export interface IntentFailure {
  sceneId: number;
  /** Which field Calliope did not apply, or "network" when the request itself failed. */
  field: "beat_id" | "chain_from_prev" | "heading" | "duration_sec" | "action" | "dialog" | "location_id" | "character_ids" | "workflow_id" | "env_image_path" | "network";
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
/**
 * Is this scene's IN FRAME fed by the scene BEFORE it in the cut? That is what
 * chain_from_prev means to Calliope, so a wire from any other scene does not count — the
 * editor refuses such wires between Calliope scenes; if one is present anyway (order
 * unknown, or a rail relay whose true source is the container) it is taken at face value.
 */
function chainedFrom(sceneNodeId: string, edges: readonly GraphEdge[], order: ReadonlyMap<string, number>): boolean {
  const target = `${sceneNodeId}:in:IN FRAME`;
  const feed = edges.find((e) => e.targetHandle === target);
  if (!feed) return false;
  const mine = order.get(sceneNodeId);
  const theirs = order.get(feed.source);
  if (mine === undefined || theirs === undefined) return true;
  return theirs === mine - 1;
}

/**
 * [U8b] The same edges with every reroute dot walked THROUGH.
 *
 * A dot is a bend in a wire, not a thing the film contains: SC-01 → dot → SC-02 is still
 * SC-01 feeding SC-02, and `chain_from_prev` has to say so. Each edge leaving a dot is
 * rewritten to the source at the far end of the chain of dots, however many there are; an edge
 * whose chain reaches nothing — a dangling dot, or dots wired in a ring — resolves to no
 * source at all and is dropped, because it feeds nothing either.
 */
export function resolveThroughReroutes(
  edges: readonly GraphEdge[],
  nodes: readonly GraphNode<DirectorData>[],
): readonly GraphEdge[] {
  const dots = new Set(nodes.filter((n) => n.data.kind === "reroute").map((n) => n.id));
  if (!dots.size) return edges;
  const feedOf = new Map<string, GraphEdge>();
  for (const e of edges) if (dots.has(e.target)) feedOf.set(e.target, e);
  const resolved: GraphEdge[] = [];
  for (const e of edges) {
    let up: GraphEdge | undefined = e;
    const seen = new Set<string>();
    while (up && dots.has(up.source)) {
      if (seen.has(up.source)) {
        up = undefined;
        break;
      }
      seen.add(up.source);
      up = feedOf.get(up.source);
    }
    if (!up) continue;
    resolved.push(up === e ? e : { ...e, source: up.source, sourceHandle: up.sourceHandle });
  }
  return resolved;
}

const cutOrder = (nodes: readonly GraphNode<DirectorData>[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const n of nodes) {
    const oi = n.data.kind === "scene" ? (n.data as SceneData).orderIndex : undefined;
    if (typeof oi === "number") m.set(n.id, oi);
  }
  return m;
};

/**
 * Diff two settled graphs into Calliope intents. Only `cal-sc-*` nodes are considered;
 * anything the editor invented has no row to write to until it is created explicitly.
 */
export function diffForCalliope(prev: Snapshot, next: Snapshot): SceneIntent[] {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n] as const));
  const out: SceneIntent[] = [];
  const orderNow = cutOrder(next.nodes);
  const orderWas = cutOrder(prev.nodes);
  // [U8b] Continuity is read through any reroute dots the wire bends around.
  const edgesNow = resolveThroughReroutes(next.edges, next.nodes);
  const edgesWas = resolveThroughReroutes(prev.edges, prev.nodes);

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
    const chainNow = chainedFrom(n.id, edgesNow, orderNow);
    const chainWas = before ? chainedFrom(n.id, edgesWas, orderWas) : chainNow;
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
    for (const k of ["action", "dialog", "location_id", "character_ids", "workflow_id", "env_image_path"] as const) if (it[k] !== undefined) body[k] = it[k];
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
  if (it.action !== undefined && (row.action ?? null) !== it.action) return say("action", it.action, row.action ?? null);
  if (it.dialog !== undefined && (row.dialog ?? null) !== it.dialog) return say("dialog", it.dialog, row.dialog ?? null);
  if (it.location_id !== undefined && (row.location_id ?? null) !== it.location_id) return say("location_id", it.location_id, row.location_id ?? null);
  if (it.workflow_id !== undefined && (row.workflow_id ?? null) !== it.workflow_id) return say("workflow_id", it.workflow_id, row.workflow_id ?? null);
  if (it.env_image_path !== undefined && (row.env_image_path ?? null) !== it.env_image_path) return say("env_image_path", it.env_image_path, row.env_image_path ?? null);
  if (it.character_ids !== undefined) {
    const a = [...it.character_ids].sort((x, y) => x - y).join(",");
    const b = [...(row.character_ids ?? [])].sort((x, y) => x - y).join(",");
    if (a !== b) return say("character_ids", it.character_ids, row.character_ids ?? []);
  }
  return null;
}

/** Node id for a Calliope scene id — exported so the hook can seed the settings cache. */
export const sceneNodeId = calId.scene;
