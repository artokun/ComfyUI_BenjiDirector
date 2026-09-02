// Render composer state rules — pure, tested, no React.
//
// Everything the Render panel decides that is not a click: which clip a scene shows, what its
// status is, what the filmstrip thumb is, how the composer's form is hydrated from a scene row,
// how an autosave MERGES into `video_settings` (the object also carries the canvas position
// under `director` and the prompt draft the agent wrote — an autosave that replaced it would
// cost the user their layout and the agent its prompt), and when a saved draft is stale.
// Ported from Calliope's `QueueStage.svelte` so both UIs read one scene the same way.

import type { JobRow, SceneRow, WorkflowRow } from "@benjidirector/calliope-client";
import { compactInputValues, isBlank, seedDefaults, type DynamicInput, type InputValues } from "./dynamic-form/types.js";
import { hasRole } from "./dynamic-form/roles.js";
import { parseTimeMs as parseTime } from "./time.js";

export type SceneStatus = "pending" | "running" | "done" | "failed" | "idle";

const CLIP_EXT = /\.(mp4|webm)$/i;

/** The newest video job of a scene. Newest = highest id; Calliope's ids are monotonic. */
export function latestVideoJob(jobs: readonly JobRow[], sceneId: number): JobRow | undefined {
  let best: JobRow | undefined;
  for (const j of jobs) if (j.kind === "video" && j.scene_id === sceneId && (!best || j.id > best.id)) best = j;
  return best;
}

/** The scene's video jobs, newest first, capped — the history drawer's list. */
export function jobHistory(jobs: readonly JobRow[], sceneId: number, limit = 20): JobRow[] {
  return jobs
    .filter((j) => j.kind === "video" && j.scene_id === sceneId && j.payload != null)
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

/** Latest job's status; a clip with no job on record is `done`; nothing at all is `idle`. */
export function statusOf(scene: Pick<SceneRow, "id" | "video_path">, jobs: readonly JobRow[]): SceneStatus {
  const job = latestVideoJob(jobs, scene.id);
  if (job) {
    if (job.status === "pending" || job.status === "running" || job.status === "done" || job.status === "failed") return job.status;
    return "idle";
  }
  return scene.video_path ? "done" : "idle";
}

/**
 * Which clip the monitor shows. A queued or running job hides the previous clip (the monitor
 * says "generating", not "here is the old one"); a finished job's own mp4/webm wins over the
 * row's `video_path`; anything that is not a browser-playable container shows nothing.
 */
export function previewPath(scene: Pick<SceneRow, "id" | "video_path">, jobs: readonly JobRow[]): string | null {
  const job = latestVideoJob(jobs, scene.id);
  if (job && (job.status === "pending" || job.status === "running")) return null;
  if (job?.status === "done") {
    const fromJob = (job.output_paths ?? []).find((p) => CLIP_EXT.test(p));
    if (fromJob) return fromJob;
  }
  if (scene.video_path && CLIP_EXT.test(scene.video_path)) return scene.video_path;
  return null;
}

export type Thumb = { kind: "image" | "video"; path: string } | null;

/** Filmstrip tile: the environment still first, else the clip, else a slate (null). */
export function thumbFor(scene: Pick<SceneRow, "id" | "video_path" | "env_image_path">, jobs: readonly JobRow[]): Thumb {
  if (scene.env_image_path) return { kind: "image", path: scene.env_image_path };
  const clip = previewPath(scene, jobs);
  if (clip) return { kind: "video", path: clip };
  return null;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** A scene with no duration counts as 5 s, like Calliope's estimate does. */
export function sceneSeconds(scene: Pick<SceneRow, "duration_sec">): number {
  return Math.max(scene.duration_sec || 5, 1);
}

export function totalSeconds(scenes: readonly Pick<SceneRow, "duration_sec">[]): number {
  return scenes.reduce((sum, s) => sum + sceneSeconds(s), 0);
}

export function doneCount(scenes: readonly Pick<SceneRow, "id" | "video_path">[], jobs: readonly JobRow[]): number {
  return scenes.filter((s) => statusOf(s, jobs) === "done").length;
}

/** ms since epoch, NaN for nothing. One reading, shared with the job strip and queue panel. */
export { parseTime };

/** A local-time rendering of a Calliope timestamp, or "" when there is none to show. */
export function formatTime(value: string | null | undefined): string {
  const t = parseTime(value);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleString();
}

/** Error text long enough to hide behind "Show details". */
export function isLongError(error: string | null | undefined): boolean {
  if (!error) return false;
  return error.length > 140 || error.split("\n").length > 3;
}

// ── video_settings: the object the composer autosaves into ────────────────────

/** The keys this composer owns inside `video_settings`. */
export interface ComposerSettings {
  input_values: InputValues;
  /** The workflow picked in the form (a session pick, persisted so batch Generate honours it). */
  form_workflow_id?: number | null;
  /** `"auto"` | `"upload"` | a scene id as a string. Auto is the default and is not stored. */
  clip_source?: string | null;
}

/**
 * Merge the composer's keys into a scene's current `video_settings`.
 *
 * MERGE, never replace: Calliope's scene PATCH swaps the whole JSON object, and it also holds
 * `director` (canvas position / pin, written by the sync unit) and `prompt_draft` +
 * `prompt_draft_meta` (the agent's prompt and its freshness hash). Dropping either is a
 * silent loss the user only notices later. Auto clip source and a null workflow REMOVE their
 * key rather than storing a sentinel.
 */
export function mergeVideoSettings(existing: Record<string, unknown> | null | undefined, composer: ComposerSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  out.input_values = compactInputValues(composer.input_values);
  if (composer.form_workflow_id !== undefined) {
    if (composer.form_workflow_id === null) delete out.form_workflow_id;
    else out.form_workflow_id = composer.form_workflow_id;
  }
  if (composer.clip_source !== undefined) {
    if (!composer.clip_source || composer.clip_source === "auto") delete out.clip_source;
    else out.clip_source = composer.clip_source;
  }
  return out;
}

/** Order-independent fingerprint, so two objects with the same content hash the same. */
export function settingsHash(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** The stored `input_values`, dropped when malformed. */
export function storedInputValues(settings: Record<string, unknown> | null | undefined): InputValues {
  const v = settings?.input_values;
  return v && typeof v === "object" && !Array.isArray(v) ? compactInputValues(v as InputValues) : {};
}

export function storedClipSource(settings: Record<string, unknown> | null | undefined): string | null {
  const v = settings?.clip_source;
  return typeof v === "string" && v ? v : null;
}

export function storedWorkflowId(settings: Record<string, unknown> | null | undefined): number | null {
  const v = settings?.form_workflow_id;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/** The saved prompt draft and the text hash it was written against, if any. */
export function draftOf(settings: Record<string, unknown> | null | undefined): { prompt: string; based_on: string | null } | null {
  const draft = settings?.prompt_draft;
  if (typeof draft !== "string" || !draft.trim()) return null;
  const meta = settings?.prompt_draft_meta;
  const based_on = meta && typeof meta === "object" ? (meta as { based_on?: unknown }).based_on : undefined;
  return { prompt: draft, based_on: typeof based_on === "string" ? based_on : null };
}

// ── hydrating the form ────────────────────────────────────────────────────────

/** Context-aware seeds: a duration-role input starts at the scene's own `duration_sec`. */
export function seedSceneValues(scene: Pick<SceneRow, "duration_sec">, inputs: readonly DynamicInput[]): InputValues {
  const seed: InputValues = {};
  if (scene.duration_sec == null) return seed;
  for (const inp of inputs) if (hasRole(inp, "duration")) seed[inp.nodeId] = scene.duration_sec;
  return seed;
}

/**
 * The form on first open of a scene: the scene's stored `input_values` over the duration seed
 * over the workflow's static defaults. The stored values win — they are what the user set; the
 * seed wins over a default because the scene's own length beats the workflow's example.
 */
export function hydrateValues(scene: Pick<SceneRow, "duration_sec">, inputs: readonly DynamicInput[], settings: Record<string, unknown> | null | undefined): InputValues {
  const seeded = seedDefaults([...inputs], seedSceneValues(scene, inputs));
  return { ...seeded, ...storedInputValues(settings) };
}

/**
 * Pick a scene's workflow: the session pick, else the one the form last saved, else the row's
 * `workflow_id`, else the first enabled video workflow. A stored id that is no longer enabled
 * falls through rather than enqueueing a job doomed to "No workflow found".
 */
export function workflowFor(
  scene: Pick<SceneRow, "id" | "workflow_id">,
  enabled: readonly WorkflowRow[],
  sessionPick: number | null | undefined,
  settings: Record<string, unknown> | null | undefined,
): WorkflowRow | undefined {
  const candidates = [sessionPick ?? null, storedWorkflowId(settings), scene.workflow_id ?? null];
  for (const id of candidates) {
    if (id === null) continue;
    const wf = enabled.find((w) => w.id === id);
    if (wf) return wf;
  }
  return enabled[0];
}

/** Enabled video workflows; when there are none, any enabled workflow (Calliope's own fallback). */
export function enabledVideoWorkflows(all: readonly WorkflowRow[]): WorkflowRow[] {
  const video = all.filter((w) => w.is_enabled && w.kind === "video");
  return video.length ? video : all.filter((w) => w.is_enabled);
}

// ── continue-from-previous ────────────────────────────────────────────────────

/** Other scenes with a clip, in cut order — the "another scene's clip" choices. */
export function clipSourceOptions(scene: Pick<SceneRow, "id">, scenes: readonly SceneRow[]): SceneRow[] {
  return scenes.filter((s) => s.id !== scene.id && !!s.video_path).sort((a, b) => a.order_index - b.order_index);
}

/** A stored source that names a clip that no longer exists falls back to auto. */
export function resolveClipSource(stored: string | null | undefined, options: readonly Pick<SceneRow, "id">[]): string {
  if (!stored || stored === "auto") return "auto";
  if (stored === "upload") return "upload";
  return options.some((s) => String(s.id) === stored) ? stored : "auto";
}

// ── prompts ───────────────────────────────────────────────────────────────────

/**
 * A saved draft is stale when Calliope resolved it (`from_draft`) but the hash it was written
 * against is not the hash the preview reports for the scene as it is now — the text, duration,
 * location or cast changed underneath it. Calliope would call its own model in that case, so
 * the modal says so and offers Regenerate.
 */
export function isDraftStale(fromDraft: boolean, draftBasedOn: string | null | undefined, previewBasedOn: string | null | undefined): boolean {
  if (!fromDraft || !previewBasedOn) return false;
  return draftBasedOn != null && draftBasedOn !== previewBasedOn;
}

/** Raw scene text as a prompt when the preview route is down — never a dead end. */
export function proseFallback(scene: Pick<SceneRow, "heading" | "action" | "dialog">): string {
  return [scene.heading, scene.action, scene.dialog]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

// ── batch generate ────────────────────────────────────────────────────────────

/**
 * "Generate all missing" targets scenes without a clip and not already in the queue; when
 * every scene has one, the button becomes "Regenerate all" over everything not in flight.
 */
// The mode is `redo-all`, not the obvious word for it: the panel's tool-vocabulary gate scans
// the VENDORED bundle, and that word is a tool name mcp retired in 0.50.0. A local
// discriminator is not worth teaching the gate to ignore a name it exists to catch.
export function batchTargets(scenes: readonly SceneRow[], jobs: readonly JobRow[]): { targets: SceneRow[]; mode: "missing" | "redo-all" } {
  const inFlight = (s: SceneRow) => {
    const st = statusOf(s, jobs);
    return st === "pending" || st === "running";
  };
  const missing = scenes.filter((s) => !inFlight(s) && statusOf(s, jobs) !== "done");
  const byOrder = (a: SceneRow, b: SceneRow) => a.order_index - b.order_index;
  if (missing.length) return { targets: [...missing].sort(byOrder), mode: "missing" };
  return { targets: scenes.filter((s) => !inFlight(s)).sort(byOrder), mode: "redo-all" };
}

// ── job payloads (history drawer) ─────────────────────────────────────────────

export interface PayloadRow {
  nodeId: string;
  label: string;
  role: string | null;
  value: string;
}

/** A job's `payload.input_values` labelled by the workflow's schema, empties dropped. */
export function payloadRows(job: Pick<JobRow, "payload"> | null | undefined, inputs: readonly DynamicInput[]): PayloadRow[] {
  const raw = job?.payload?.input_values;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => !isBlank(v))
    .map(([nodeId, v]) => {
      const inp = inputs.find((i) => i.nodeId === nodeId);
      return { nodeId, label: inp?.label ?? nodeId, role: inp?.role ?? null, value: String(v) };
    });
}

/** The values of a job worth copying back into the form (strings and numbers only). */
export function copyableValues(job: Pick<JobRow, "payload"> | null | undefined): InputValues {
  const raw = job?.payload?.input_values;
  const out: InputValues = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  return out;
}

export function payloadPrompt(job: Pick<JobRow, "payload"> | null | undefined): string | null {
  const p = job?.payload?.prompt;
  return typeof p === "string" && p.trim() ? p : null;
}
