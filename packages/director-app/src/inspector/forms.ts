// The inspector's dirty-diff → PATCH body, as pure functions.
//
// Calliope's PATCH handlers do not agree on what a null means, so the fork is encoded here
// once instead of in every form:
//
//   scenes (routers/scenes.py)   `exclude_unset`, then every None is dropped UNLESS the column
//                                 is in CLEARABLE_SCENE_FIELDS — beat_id, location_id,
//                                 workflow_id, env_image_path, video_path, action, dialog. An
//                                 explicit null on one of those clears it; on anything else it
//                                 is silently dropped and the row comes back unchanged, 200.
//   beats / characters /          `model_dump()` then every None dropped. Nothing is clearable
//   locations / items             by null; "" is what empties a text column.
//
// So a builder sends null ONLY for the clearable scene columns, omits every unchanged key,
// and returns null for a no-op so a blur never becomes a PATCH. `character_ids` is a SET
// REPLACE on the server (delete-all then insert), so it is compared as a set and sent whole.

import type { BeatRow, SceneRow, Schemas, WorkflowRow } from "@benjidirector/calliope-client";
import type { SceneIntent } from "../calliope-sync.js";

/** Scene columns Calliope sets to NULL on an explicit null. Everything else: omit, never null. */
export const SCENE_CLEARABLE = ["beat_id", "location_id", "workflow_id", "env_image_path", "video_path", "action", "dialog"] as const;

// ── scenes ──────────────────────────────────────────────────────────────────────────────

export interface SceneForm {
  heading: string;
  action: string;
  dialog: string;
  /** Raw input text; validated (integer ≥ 1) when the patch is built. */
  duration_sec: string;
  beat_id: number | null;
  location_id: number | null;
  character_ids: number[];
  workflow_id: number | null;
  chain_from_prev: boolean;
  env_image_path: string | null;
}

export function sceneForm(row: SceneRow): SceneForm {
  return {
    heading: row.heading ?? "",
    action: row.action ?? "",
    dialog: row.dialog ?? "",
    duration_sec: row.duration_sec === null || row.duration_sec === undefined ? "" : String(row.duration_sec),
    beat_id: row.beat_id ?? null,
    location_id: row.location_id ?? null,
    character_ids: [...(row.character_ids ?? [])],
    workflow_id: row.workflow_id ?? null,
    chain_from_prev: !!row.chain_from_prev,
    env_image_path: row.env_image_path ?? null,
  };
}

/** An integer ≥ 1, or null when the text is not one. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}

/** An integer ≥ 0, or null. */
export function parseIndex(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

export function sameSet(a: readonly number[], b: readonly number[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

const uniq = (ids: readonly number[]): number[] => [...new Set(ids)];

/**
 * What changed between two form snapshots, as the body Calliope needs. `base` is the form as
 * seeded from the row (or as last written), so the diff is against what the server has.
 */
export function sceneDiff(base: SceneForm, form: SceneForm): Schemas["SceneUpdate"] | null {
  const body: Schemas["SceneUpdate"] = {};
  if (form.heading !== base.heading) body.heading = form.heading;
  if (form.action !== base.action) body.action = form.action === "" ? null : form.action;
  if (form.dialog !== base.dialog) body.dialog = form.dialog === "" ? null : form.dialog;
  const d = parseDuration(form.duration_sec);
  if (d !== null && d !== parseDuration(base.duration_sec)) body.duration_sec = d;
  if (form.beat_id !== base.beat_id) body.beat_id = form.beat_id;
  if (form.location_id !== base.location_id) body.location_id = form.location_id;
  if (form.workflow_id !== base.workflow_id) body.workflow_id = form.workflow_id;
  if (form.env_image_path !== base.env_image_path) body.env_image_path = form.env_image_path;
  if (!sameSet(form.character_ids, base.character_ids)) body.character_ids = uniq(form.character_ids);
  if (form.chain_from_prev !== base.chain_from_prev) body.chain_from_prev = form.chain_from_prev;
  return Object.keys(body).length ? body : null;
}

/** The PATCH body that takes `row` to `form`, or null when nothing changed. */
export function scenePatch(row: SceneRow, form: SceneForm): Schemas["SceneUpdate"] | null {
  return sceneDiff(sceneForm(row), form);
}

/** The write as calliope-sync's `verifyEcho` wants it, so the returned row is checked the same way the canvas write-back checks its own. */
export function sceneIntent(sceneId: number, body: Schemas["SceneUpdate"]): SceneIntent {
  const it: SceneIntent = { sceneId };
  if (typeof body.heading === "string") it.heading = body.heading;
  if (typeof body.duration_sec === "number") it.duration_sec = body.duration_sec;
  if (body.beat_id !== undefined) it.beat_id = body.beat_id;
  if (typeof body.chain_from_prev === "boolean") it.chain_from_prev = body.chain_from_prev;
  if (body.action !== undefined) it.action = body.action;
  if (body.dialog !== undefined) it.dialog = body.dialog;
  if (body.location_id !== undefined) it.location_id = body.location_id;
  if (body.workflow_id !== undefined) it.workflow_id = body.workflow_id;
  if (body.env_image_path !== undefined) it.env_image_path = body.env_image_path;
  if (body.character_ids) it.character_ids = body.character_ids;
  return it;
}

/** Is this the first scene in the cut? It has nothing before it to chain from. */
export function isFirstScene(row: Pick<SceneRow, "id" | "order_index">, scenes: ReadonlyArray<Pick<SceneRow, "id" | "order_index">>): boolean {
  const first = [...scenes].sort((a, b) => a.order_index - b.order_index)[0];
  return !first || first.id === row.id;
}

/** The cut order to write after deleting one scene: everyone else, in order, gap closed. */
export function remainingOrder(scenes: ReadonlyArray<Pick<SceneRow, "id" | "order_index">>, deletedId: number): number[] {
  return [...scenes]
    .filter((s) => s.id !== deletedId)
    .sort((a, b) => a.order_index - b.order_index)
    .map((s) => s.id);
}

/**
 * Chaining feeds the previous scene's last frame into this one's workflow. A workflow with
 * no `video`-role input has nowhere to put it, so the flag would be silently ignored.
 */
export function chainWarning(form: Pick<SceneForm, "chain_from_prev" | "workflow_id">, workflows: ReadonlyArray<Pick<WorkflowRow, "id" | "name" | "input_schema">>): string | null {
  if (!form.chain_from_prev || form.workflow_id === null) return null;
  const wf = workflows.find((w) => w.id === form.workflow_id);
  if (!wf) return null;
  if ((wf.input_schema ?? []).some((i) => i.role === "video")) return null;
  return `“${wf.name}” has no video input — the previous scene's last frame will not be fed in.`;
}

/** Video workflows a scene can choose from: enabled, kind video. */
export function videoWorkflows(rows: ReadonlyArray<WorkflowRow>): WorkflowRow[] {
  return rows.filter((w) => w.kind === "video" && w.is_enabled);
}

// ── prompt draft (video_settings.prompt_draft + prompt_draft_meta) ───────────────────────

export interface PromptDraft {
  text: string;
  basedOn: string | null;
  authoredBy: string | null;
  savedAt: string | null;
}

export function promptDraftOf(row: Pick<SceneRow, "video_settings">): PromptDraft {
  const vs = (row.video_settings ?? {}) as Record<string, unknown>;
  const meta = vs.prompt_draft_meta && typeof vs.prompt_draft_meta === "object" ? (vs.prompt_draft_meta as Record<string, unknown>) : {};
  return {
    text: typeof vs.prompt_draft === "string" ? vs.prompt_draft : "",
    basedOn: typeof meta.based_on === "string" ? meta.based_on : null,
    authoredBy: typeof meta.authored_by === "string" ? meta.authored_by : null,
    savedAt: typeof meta.saved_at === "string" ? meta.saved_at : null,
  };
}

// ── beats ───────────────────────────────────────────────────────────────────────────────

export interface BeatForm {
  title: string;
  description: string;
  order_index: string;
}

export function beatForm(row: BeatRow): BeatForm {
  return { title: row.title ?? "", description: row.description ?? "", order_index: String(row.order_index ?? 0) };
}

export function beatDiff(base: BeatForm, form: BeatForm): Schemas["BeatUpdate"] | null {
  const body: Schemas["BeatUpdate"] = {};
  // A blank title is not a rename Calliope should see (BeatCreate requires one); the field is
  // flagged instead and the old title stays until something is typed.
  if (form.title !== base.title && form.title.trim()) body.title = form.title;
  if (form.description !== base.description) body.description = form.description;
  const oi = parseIndex(form.order_index);
  if (oi !== null && oi !== parseIndex(base.order_index)) body.order_index = oi;
  return Object.keys(body).length ? body : null;
}

export function beatPatch(row: BeatRow, form: BeatForm): Schemas["BeatUpdate"] | null {
  return beatDiff(beatForm(row), form);
}

// ── characters / locations / items: flat text rows ───────────────────────────────────────

export const CHARACTER_KEYS = ["name", "role", "age", "appearance", "personality", "consistency_prompt"] as const;
export const PLACE_KEYS = ["name", "description", "consistency_prompt"] as const;
export type CharacterForm = Record<(typeof CHARACTER_KEYS)[number], string>;
export type PlaceForm = Record<(typeof PLACE_KEYS)[number], string>;

/** Seed a text form from a row: every listed key as a string, null/absent as "". */
export function textForm<K extends string>(row: Record<string, unknown>, keys: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of keys) {
    const v = row[k];
    out[k] = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  }
  return out;
}

/**
 * Changed keys only. These rows are never cleared by null (the server drops it), so "" is
 * sent as "" — except for `required` keys, where a blank is flagged rather than written.
 */
export function textDiff<K extends string>(base: Record<K, string>, form: Record<K, string>, keys: readonly K[], required: readonly K[] = ["name"] as unknown as K[]): Partial<Record<K, string>> | null {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    if (form[k] === base[k]) continue;
    if (required.includes(k) && !form[k].trim()) continue;
    out[k] = form[k];
  }
  return Object.keys(out).length ? out : null;
}

/** The first field the returned row disagrees with, or null. For the flat rows (scenes use `verifyEcho`). */
export function echoMismatch(body: Record<string, unknown>, row: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(body)) {
    const got = row[k] ?? null;
    if (v !== got) return `Calliope accepted the PATCH but did not apply ${k}=${JSON.stringify(v)} (row still has ${JSON.stringify(got)})`;
  }
  return null;
}

/** The last path segment, for a label. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
