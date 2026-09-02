// Director graph -> Calliope rows: the write-back direction.
//
// `projectToGraph` (calliope-bind.ts) says what a row looks like on the canvas. This module
// is the same mapping run in reverse, as a DIFF: given the graph before and after a settle,
// what does Calliope need to be told? The answer is a list of intents — one PATCH per touched
// row — computed by pure functions so they can be tested without a server, and applied by
// separate steps that own the network. Beside the diff sit the typed helpers for the writes
// a diff cannot express: creating a row for a node the canvas invented, and deleting the row
// behind a node that left it.
//
// What writes back, and where it lands (see the plan's "Calliope owns content, we own
// topology" correction — there is no free-form field on the project row):
//
//   heading / durationSec        -> scene.heading / scene.duration_sec        (content)
//   parentId (Beat)              -> scene.beat_id                              (native topology)
//   IN FRAME wire from a scene   -> scene.chain_from_prev                      (Calliope's own continuity flag)
//   CHARACTER wire               -> scene.character_ids                        (see below)
//   LOCATION wire                -> scene.location_id / null
//   position / pin               -> scene.video_settings.director.{position,promoted}
//   Beat title                   -> beat.title
//   asset label                  -> character/location/item.name
//
// The CHARACTER wire and `character_ids`. A scene has ONE character socket on the canvas
// but a LIST of characters in Calliope, and the canvas draws `character_ids[0]`
// (calliope-bind). So a wire edit EDITS the list rather than replacing it: wiring character
// N puts N FIRST (so a reload draws the wire you just made) and drops the character the old
// wire stood for; cutting the wire removes that character only. Any further characters
// stay on the row, invisible to the canvas — and after a cut, the next of them becomes the
// drawn one on reload. That is the row's truth, not a bug: the canvas shows the first
// character, never the only one.
//
// Nothing here touches Beat-level topology (subgraph, collapsed, colour, rails) — Calliope has
// nowhere to put it; that is the local sidecar. And nothing here reorders scenes from
// geometry: order_index is the timeline, and inferring it from y-coordinates would move a
// film's cut order because someone tidied the canvas. The only reorders are the ones
// Calliope's own script stage does — after a create and after a delete, with the FULL id
// list, so order_index stays contiguous.

import { isRelayHandle, outerHandleId, type BoundaryPort, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { CalliopeError, type CalliopeClient, type SceneRow } from "@benjidirector/calliope-client";
import { calId, calliopeRef } from "./calliope-bind.js";
import { reportedPorts, type BeatData, type DirectorData, type SceneData } from "./model.js";

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

/** A rename of a row that is not a scene: a Beat's title, or an asset's name. */
export type StoryIntent =
  | { kind: "beat"; id: number; title: string }
  | { kind: "character" | "location" | "item"; id: number; name: string };

export interface StoryFailure {
  kind: StoryIntent["kind"];
  id: number;
  field: "title" | "name" | "network";
  error: string;
}

export interface Snapshot {
  nodes: readonly GraphNode<DirectorData>[];
  edges: readonly GraphEdge[];
}

export interface DiffContext {
  /**
   * Each Calliope scene's row as last read or echoed. Needed for `character_ids`, which is
   * EDITED (see the header) — without it the diff can only see the character the old wire
   * stood for, and treats the row as if that were the whole list.
   */
  rows?: ReadonlyMap<number, SceneRow>;
}

const sceneOf = (n: GraphNode<DirectorData>) => (n.data.kind === "scene" ? (n.data as SceneData) : null);
const beatIdOf = (parentId: string | undefined): number | null => {
  if (!parentId) return null;
  const ref = calliopeRef(parentId);
  return ref?.kind === "beat" ? ref.id : null;
};

/**
 * The wire that really feeds an input, seen through any rail relays in between. A scene
 * inside a promoted Beat is fed by the Beat's inner relay handle; the wire that matters is
 * the OUTER one on the same boundary port, and a Beat inside a Beat adds a hop. Bounded, so
 * a malformed relay cannot loop.
 */
export function feedOf(targetHandle: string, edges: readonly GraphEdge[]): GraphEdge | null {
  let handle = targetHandle;
  for (let hop = 0; hop < 8; hop += 1) {
    const e = edges.find((x) => x.targetHandle === handle);
    if (!e) return null;
    if (!isRelayHandle(e.sourceHandle)) return e;
    handle = outerHandleId(e.sourceHandle ?? "");
  }
  return null;
}

/** Every edge on the relay chain into an input — what a snap-back has to restore as one unit. */
export function feedChain(targetHandle: string, edges: readonly GraphEdge[]): GraphEdge[] {
  const out: GraphEdge[] = [];
  let handle = targetHandle;
  for (let hop = 0; hop < 8; hop += 1) {
    const e = edges.find((x) => x.targetHandle === handle);
    if (!e) break;
    out.push(e);
    if (!isRelayHandle(e.sourceHandle)) break;
    handle = outerHandleId(e.sourceHandle ?? "");
  }
  return out;
}

/** The Calliope row wired into a scene's CHARACTER / LOCATION socket, or null for none / a local asset. */
function refAtInput(sceneNodeId: string, port: "CHARACTER" | "LOCATION", edges: readonly GraphEdge[]): number | null {
  const feed = feedOf(`${sceneNodeId}:in:${port}`, edges);
  if (!feed) return null;
  const ref = calliopeRef(feed.source);
  const want = port === "CHARACTER" ? "character" : "location";
  return ref && ref.kind === want ? ref.id : null;
}

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
 * anything the editor invented has no row to write to until it is created explicitly
 * (`createSceneRow`), and a node that is in `next` but not in `prev` is one that was just
 * placed — its row already carries what the create asked for.
 */
export function diffForCalliope(prev: Snapshot, next: Snapshot, ctx: DiffContext = {}): SceneIntent[] {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n] as const));
  const out: SceneIntent[] = [];
  const orderNow = cutOrder(next.nodes);
  const orderWas = cutOrder(prev.nodes);

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
    const chainNow = chainedFrom(n.id, next.edges, orderNow);
    const chainWas = before ? chainedFrom(n.id, prev.edges, orderWas) : chainNow;
    if (before && chainNow !== chainWas) {
      intent.chain_from_prev = chainNow;
      touched = true;
    }
    // CHARACTER wire: edit the list — the wired character goes first, the one the old wire
    // stood for goes, the rest stay (header). Without rows, the old wire IS the known list.
    const charNow = refAtInput(n.id, "CHARACTER", next.edges);
    const charWas = before ? refAtInput(n.id, "CHARACTER", prev.edges) : charNow;
    if (before && charNow !== charWas) {
      const known = ctx.rows?.get(ref.id)?.character_ids ?? (charWas !== null ? [charWas] : []);
      const rest = known.filter((id) => id !== charWas && id !== charNow);
      intent.character_ids = charNow !== null ? [charNow, ...rest] : rest;
      touched = true;
    }
    const locNow = refAtInput(n.id, "LOCATION", next.edges);
    const locWas = before ? refAtInput(n.id, "LOCATION", prev.edges) : locNow;
    if (before && locNow !== locWas) {
      intent.location_id = locNow;
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
 * Renames of the rows that are not scenes: a `cal-beat-*` label is the Beat's title, a
 * `cal-char-*` / `cal-loc-*` / `cal-item-*` label is the asset's name. A blank label is not
 * a rename Calliope would take (its create refuses an empty title), so it is not sent.
 */
export function diffStoryForCalliope(prev: Snapshot, next: Snapshot): StoryIntent[] {
  const prevById = new Map(prev.nodes.map((n) => [n.id, n] as const));
  const out: StoryIntent[] = [];
  for (const n of next.nodes) {
    const ref = calliopeRef(n.id);
    if (!ref || ref.kind === "scene") continue;
    const before = prevById.get(n.id);
    if (!before) continue;
    const label = n.data.label;
    if (label === before.data.label || !label.trim()) continue;
    if (ref.kind === "beat") out.push({ kind: "beat", id: ref.id, title: label });
    else out.push({ kind: ref.kind, id: ref.id, name: label });
  }
  return out;
}

/**
 * Apply intents. `settingsCache` holds each scene's current `video_settings` (seeded at load,
 * updated here) so a director sub-object can be merged without clobbering Calliope's own keys
 * — `prompt_draft` and its freshness hash live in the same object. `rows`, when given, takes
 * every echoed row, so the next diff edits `character_ids` against what Calliope has NOW.
 */
export async function applyIntents(
  client: CalliopeClient,
  projectId: number,
  intents: SceneIntent[],
  settingsCache: Map<number, Record<string, unknown>>,
  rows?: Map<number, SceneRow>,
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
    if (row && rows) rows.set(it.sceneId, row);
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

/** Apply renames, echo-checked: the row Calliope returns must carry the title / name it was sent. */
export async function applyStoryIntents(client: CalliopeClient, projectId: number, intents: StoryIntent[]): Promise<{ applied: number; failed: StoryFailure[] }> {
  let applied = 0;
  const failed: StoryFailure[] = [];
  for (const it of intents) {
    const field = it.kind === "beat" ? "title" : "name";
    const asked = it.kind === "beat" ? it.title : it.name;
    let got: unknown;
    try {
      if (it.kind === "beat") got = (await client.story.beat.patch(projectId, it.id, { title: it.title })).title;
      else got = (await client.story[it.kind].patch(projectId, it.id, { name: it.name })).name;
    } catch (err) {
      failed.push({ kind: it.kind, id: it.id, field: "network", error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (got !== asked) failed.push({ kind: it.kind, id: it.id, field, error: `Calliope accepted the PATCH but did not apply ${field}=${JSON.stringify(asked)} (row still has ${JSON.stringify(got)})` });
    else applied += 1;
  }
  return { applied, failed };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Rows for nodes the canvas invents, and the reverse
// ─────────────────────────────────────────────────────────────────────────────────────────

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const byOrder = (rows: readonly SceneRow[]) => [...rows].sort((a, b) => a.order_index - b.order_index);

export interface SceneCreateSpec {
  heading: string;
  beat_id: number | null;
  duration_sec: number;
  /** A ref wired in with the drop goes in the create body — one round trip, one row. */
  character_ids?: number[];
  location_id?: number | null;
  /** Calliope's create ignores this column; it is PATCHed after the row exists. */
  chain_from_prev?: boolean;
}

/**
 * Create a scene row the way Calliope's own script stage does: POST with `order_index`
 * n+1, then reorder the FULL id list so `order_index` stays contiguous (Calliope numbers a
 * reorder from 1). The reorder echoes every row, so the caller gets the whole cut back and
 * can restamp `orderIndex` on the canvas (`withOrderIndexes`). Each field the create was
 * asked for is echo-checked on the returned row; a field Calliope did not keep is reported,
 * and the row — which exists regardless — is returned as Calliope has it.
 */
export async function createSceneRow(
  client: CalliopeClient,
  projectId: number,
  spec: SceneCreateSpec,
  existing: readonly SceneRow[],
  settingsCache?: Map<number, Record<string, unknown>>,
): Promise<{ row: SceneRow; rows: SceneRow[]; failed: IntentFailure[] }> {
  const ordered = byOrder(existing).map((s) => s.id);
  const body = {
    order_index: ordered.length + 1,
    heading: spec.heading,
    beat_id: spec.beat_id,
    duration_sec: spec.duration_sec,
    character_ids: spec.character_ids ?? [],
    location_id: spec.location_id ?? null,
  };
  const created = await client.scenes.create(projectId, body);
  const failed: IntentFailure[] = [];
  const miss = verifyEcho(
    {
      sceneId: created.id,
      heading: spec.heading,
      beat_id: spec.beat_id,
      duration_sec: spec.duration_sec,
      ...(spec.character_ids ? { character_ids: spec.character_ids } : {}),
      ...(spec.location_id !== undefined ? { location_id: spec.location_id } : {}),
    },
    created,
  );
  if (miss) failed.push({ ...miss, error: miss.error.replace("the PATCH", "the create") });
  let rows: SceneRow[] = [...existing, created];
  try {
    const re = (await client.scenes.reorder(projectId, { scene_ids: [...ordered, created.id] })) as { scenes?: SceneRow[] } | null;
    if (re && Array.isArray(re.scenes) && re.scenes.length) rows = re.scenes;
  } catch (err) {
    failed.push({ sceneId: created.id, field: "network", error: `row created, but the reorder after it failed: ${errorText(err)}` });
  }
  if (spec.chain_from_prev) {
    const r = await applyIntents(client, projectId, [{ sceneId: created.id, chain_from_prev: true }], settingsCache ?? new Map(), undefined);
    failed.push(...r.failed);
    if (!r.failed.length) rows = rows.map((s) => (s.id === created.id ? { ...s, chain_from_prev: 1 } : s));
  }
  const row = rows.find((s) => s.id === created.id) ?? created;
  return { row, rows, failed };
}

/** Create a character / location / item row. Echo-checked on the name. */
export async function createAssetRow(
  client: CalliopeClient,
  projectId: number,
  kind: "character" | "location" | "item",
  name: string,
): Promise<{ id: number; name: string; failed: string | null }> {
  const row = await client.story[kind].create(projectId, { name });
  const failed = row.name !== name ? `Calliope accepted the create but the ${kind} came back named ${JSON.stringify(row.name)}, not ${JSON.stringify(name)}` : null;
  return { id: row.id, name: row.name, failed };
}

/** Create a Beat row. Echo-checked on the title. */
export async function createBeatRow(client: CalliopeClient, projectId: number, title: string, order_index: number): Promise<{ id: number; title: string; failed: string | null }> {
  const row = await client.story.beat.create(projectId, { title, order_index });
  const failed = row.title !== title ? `Calliope accepted the create but the Beat came back titled ${JSON.stringify(row.title)}, not ${JSON.stringify(title)}` : null;
  return { id: row.id, title: row.title, failed };
}

export interface DeleteReport {
  /** Node ids whose rows are gone — deleted now, or already absent (a 404 is "gone" too). */
  deleted: string[];
  failed: { nodeId: string; error: string }[];
  /** The cut after the reorder that follows a scene delete; null when nothing was reordered. */
  rows: SceneRow[] | null;
  /** The scenes were deleted but the reorder after them was not — the cut has a gap until the next one. */
  reorderError: string | null;
}

/**
 * Delete the rows behind a set of nodes. Scenes go first, then Beats, then assets, and one
 * reorder of the surviving scenes closes the gap — the dance Calliope's own script stage
 * does on delete. A Beat's scenes that are NOT among the ids survive as orphans
 * (`scenes.beat_id` is FK SET NULL) and the canvas shows them at the top level.
 * A row Calliope refuses to delete keeps its node: the failure names it.
 */
export async function deleteRows(client: CalliopeClient, projectId: number, nodeIds: readonly string[], allScenes: readonly SceneRow[]): Promise<DeleteReport> {
  const rank = { scene: 0, beat: 1, character: 2, location: 2, item: 2 } as const;
  const refs = nodeIds
    .map((nodeId) => ({ nodeId, ref: calliopeRef(nodeId) }))
    .filter((x): x is { nodeId: string; ref: NonNullable<ReturnType<typeof calliopeRef>> } => !!x.ref)
    .sort((a, b) => rank[a.ref.kind] - rank[b.ref.kind]);
  const deleted: string[] = [];
  const failed: DeleteReport["failed"] = [];
  const goneScenes = new Set<number>();
  for (const { nodeId, ref } of refs) {
    try {
      if (ref.kind === "scene") await client.scenes.delete(projectId, ref.id);
      else if (ref.kind === "beat") await client.story.beat.delete(projectId, ref.id);
      else await client.story[ref.kind].delete(projectId, ref.id);
    } catch (err) {
      // Already gone is gone: the node has no row either way.
      if (!(err instanceof CalliopeError && err.status === 404)) {
        failed.push({ nodeId, error: errorText(err) });
        continue;
      }
    }
    deleted.push(nodeId);
    if (ref.kind === "scene") goneScenes.add(ref.id);
  }
  let rows: SceneRow[] | null = null;
  let reorderError: string | null = null;
  if (goneScenes.size) {
    const remaining = byOrder(allScenes).filter((s) => !goneScenes.has(s.id));
    rows = remaining;
    if (remaining.length) {
      try {
        const re = (await client.scenes.reorder(projectId, { scene_ids: remaining.map((s) => s.id) })) as { scenes?: SceneRow[] } | null;
        if (re && Array.isArray(re.scenes)) rows = re.scenes;
      } catch (err) {
        reorderError = errorText(err);
      }
    }
  }
  return { deleted, failed, rows, reorderError };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Graph-side helpers for the row round trip
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Give a node a new id everywhere it is referenced: its own ports (rebuilt, since port ids
 * embed the node id), its children's `parentId`, every edge end and handle, and the boundary
 * ports of any container that aliases one of its ports (`container::nodeId:in:X`) — the id
 * derivation graph-core documents, applied in reverse. Nothing else about the node changes.
 */
export function reidNode(nodes: readonly GraphNode<DirectorData>[], edges: readonly GraphEdge[], from: string, to: string): { nodes: GraphNode<DirectorData>[]; edges: GraphEdge[] } {
  const mapId = (id: string) => (id === from ? to : id);
  const mapHandle = (h: string | null | undefined): string | undefined => {
    if (!h) return undefined;
    // `${nodeId}:${side}:${NAME}`, `${containerId}::${childPortId}`, and their `__inner` twins.
    const parts = h.split("::");
    const mapped = parts.map((p) => {
      const i = p.indexOf(":");
      const head = i < 0 ? p : p.slice(0, i);
      return `${mapId(head)}${i < 0 ? "" : p.slice(i)}`;
    });
    return mapped.join("::");
  };
  const mapPort = (p: BoundaryPort): BoundaryPort => ({ ...p, id: mapHandle(p.id) ?? p.id, childId: mapId(p.childId), childPortId: mapHandle(p.childPortId) ?? p.childPortId });
  /**
   * In an edge id a node id is always followed by its handle separator, so replacing
   * `${from}:` is exact where replacing `${from}` alone would also rewrite `cal-sc-12` when
   * re-iding `cal-sc-1`. The id is rewritten rather than rebuilt from the handles: relay
   * halves carry derived suffixes (`__outer`), and rebuilding would collide one with the other.
   */
  const mapEdgeId = (id: string) => id.split(`${from}:`).join(`${to}:`);
  const outNodes = nodes.map((n) => {
    let next = n;
    if (n.id === from) {
      const data = { ...n.data } as DirectorData;
      if (data.kind !== "beat") (data as { ports: unknown }).ports = reportedPorts(data.kind, to, data.kind === "reroute" ? data.portType : undefined);
      next = { ...n, id: to, data };
    }
    if (next.parentId === from) next = { ...next, parentId: to };
    if (next.data.kind === "beat") {
      const d = next.data as BeatData;
      const touches = (ps: BoundaryPort[]) => ps.some((p) => p.childId === from || p.id.includes(from));
      if (touches(d.promotedIn ?? []) || touches(d.promotedOut ?? []) || next.id === to) {
        next = { ...next, data: { ...d, promotedIn: (d.promotedIn ?? []).map(mapPort), promotedOut: (d.promotedOut ?? []).map(mapPort) } };
      }
    }
    return next;
  });
  const outEdges = edges.map((e) => {
    const sh = mapHandle(e.sourceHandle);
    const th = mapHandle(e.targetHandle);
    const source = mapId(e.source);
    const target = mapId(e.target);
    if (sh === e.sourceHandle && th === e.targetHandle && source === e.source && target === e.target) return e;
    return { ...e, id: mapEdgeId(e.id), source, target, sourceHandle: sh, targetHandle: th };
  });
  return { nodes: outNodes, edges: outEdges };
}

/**
 * Restamp `orderIndex` on every Calliope scene from the rows a reorder echoed. Calliope
 * numbers a reorder from 1 while a seeded project starts at 0; continuity only cares about
 * consecutiveness, but a node left with the old numbering next to one with the new would
 * look non-consecutive when it is not.
 */
export function withOrderIndexes(nodes: readonly GraphNode<DirectorData>[], rows: readonly SceneRow[]): GraphNode<DirectorData>[] {
  const order = new Map(rows.map((r) => [calId.scene(r.id), r.order_index] as const));
  return nodes.map((n) => {
    if (n.data.kind !== "scene") return n;
    const oi = order.get(n.id);
    if (oi === undefined || (n.data as SceneData).orderIndex === oi) return n;
    return { ...n, data: { ...n.data, orderIndex: oi } } as GraphNode<DirectorData>;
  });
}

/**
 * Strip nodes whose rows were deleted this session from a history snapshot. Undo brings a
 * canvas back, not a film: a row that is gone stays gone, and the node that stood for it
 * cannot come back to point at nothing. The caller says so in its note.
 */
export function withoutDeadRows(snap: { nodes: GraphNode<DirectorData>[]; edges: GraphEdge[] }, dead: ReadonlySet<string>): { nodes: GraphNode<DirectorData>[]; edges: GraphEdge[]; stripped: string[] } {
  if (!dead.size) return { ...snap, stripped: [] };
  const stripped = snap.nodes.filter((n) => dead.has(n.id)).map((n) => n.id);
  if (!stripped.length) return { ...snap, stripped };
  // Children of a stripped container go with it, exactly as they did when it was deleted.
  const gone = new Set(stripped);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of snap.nodes) {
      if (!gone.has(n.id) && n.parentId && gone.has(n.parentId)) {
        gone.add(n.id);
        grew = true;
      }
    }
  }
  return {
    nodes: snap.nodes.filter((n) => !gone.has(n.id)),
    edges: snap.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target)),
    stripped: [...gone],
  };
}

/** Node id for a Calliope scene id — exported so the hook can seed the settings cache. */
export const sceneNodeId = calId.scene;
