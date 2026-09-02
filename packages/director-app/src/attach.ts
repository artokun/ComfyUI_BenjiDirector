// Playground logic with no React in it: the attach payload per target, what a job's media
// is, the words a card shows, and the small pickers the composer needs. The panel is thin
// on purpose — everything a test can pin lives here.
//
// Attach semantics come from Calliope's `routers/playground.py`: a character sheet, a
// location reference and a scene clip each UPDATE one existing row (so they need its id);
// a misc. item always INSERTS a new row (so it takes a name and never an id). `item_id` is
// accepted by the schema and ignored by the server — this module never sends it.

import type { JobRow, Schemas, UploadRow, WorkflowInput, WorkflowRow } from "@benjidirector/calliope-client";
import type { AssetOption, DynamicInput, InputKind } from "./dynamic-form/index.js";

export type AttachPayload = Schemas["PlaygroundAttach"];
export type AttachTarget = AttachPayload["target"];
export type Mode = "video" | "image";
export type MediaKind = "image" | "video";

export interface AttachIds {
  project_id: number | null;
  character_id?: number | null;
  location_id?: number | null;
  scene_id?: number | null;
}

export type AttachResult = { ok: true; payload: AttachPayload } | { ok: false; error: string };

const fail = (error: string): AttachResult => ({ ok: false, error });

/**
 * The body for `POST /api/playground/attach`, or the reason it cannot be built yet.
 * Only the keys the target needs are present — the e2e pins the exact shape.
 */
export function attachPayload(target: AttachTarget, ids: AttachIds, path: string, name?: string): AttachResult {
  if (!path) return fail("Nothing to attach");
  if (ids.project_id == null) return fail("Pick a project");
  const base = { path, project_id: ids.project_id, target };
  switch (target) {
    case "character_sheet":
      if (ids.character_id == null) return fail("Pick a character");
      return { ok: true, payload: { ...base, character_id: ids.character_id } };
    case "location":
      if (ids.location_id == null) return fail("Pick a location");
      return { ok: true, payload: { ...base, location_id: ids.location_id } };
    case "item": {
      const trimmed = (name ?? "").trim();
      return { ok: true, payload: trimmed ? { ...base, name: trimmed } : base };
    }
    case "scene":
      if (ids.scene_id == null) return fail("Pick a scene");
      return { ok: true, payload: { ...base, scene_id: ids.scene_id } };
    default:
      return fail(`Unknown target ${String(target)}`);
  }
}

export interface TargetChoice {
  id: AttachTarget;
  label: string;
  hint: string;
}

/** What an artifact can become: a clip goes on a scene; an image on a sheet, a place or a thing. */
export function targetsFor(isVideo: boolean): TargetChoice[] {
  if (isVideo) return [{ id: "scene", label: "Scene", hint: "Becomes the scene's clip" }];
  return [
    { id: "character_sheet", label: "Character sheet", hint: "Replaces the character's sheet image" },
    { id: "location", label: "Location", hint: "Replaces the location's reference image" },
    { id: "item", label: "Misc. item", hint: "Adds a new item; existing items are left alone" },
  ];
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

export function isVideoPath(path: string, kind?: string | null): boolean {
  return kind === "video" || VIDEO_EXT.test(path);
}

export function mediaKindOf(path: string, kind?: string | null): MediaKind {
  return isVideoPath(path, kind) ? "video" : "image";
}

/** The file name without directories, for either slash. */
export function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? "";
}

/**
 * The name a misc. item gets when the user does not type one: the file stem with the
 * upload's 8-hex prefix stripped and separators turned into spaces. Mirrors Calliope's
 * `defaultMiscName`, so the same artifact gets the same name from either UI.
 */
export function defaultMiscName(path: string): string {
  const stem = fileName(path).replace(/\.[^.]+$/, "");
  const stripped = stem.replace(/^[0-9a-f]{8}-/i, "");
  const pretty = (stripped || stem).replace(/[_-]+/g, " ").trim();
  return pretty || "New item";
}

export function statusWord(status: string): string {
  switch (status) {
    case "done":
      return "Ready";
    case "running":
      return "Running";
    case "pending":
      return "Queued";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

/** Pending or running: the grid polls while this is true. */
export function isBusy(jobs: readonly JobRow[]): boolean {
  return jobs.some((j) => j.status === "pending" || j.status === "running");
}

export function readyCount(jobs: readonly JobRow[]): number {
  return jobs.filter((j) => j.status === "done").length;
}

/** The sentence after a delete, from what the server says it removed and what was already gone. */
export function deleteSummary(jobId: number, r: { deleted_files?: string[]; missing_files?: string[] }): string {
  const gone = r.deleted_files?.length ?? 0;
  const miss = r.missing_files?.length ?? 0;
  if (gone && miss) return `Deleted #${jobId} (${gone} file${gone === 1 ? "" : "s"}; ${miss} already missing)`;
  if (gone) return `Deleted #${jobId} and ${gone} file${gone === 1 ? "" : "s"}`;
  if (miss) return `Deleted #${jobId} (${miss} file${miss === 1 ? "" : "s"} already missing)`;
  return `Deleted #${jobId}`;
}

/** The confirm copy before a delete, so the user knows files go with the row. */
export function deletePrompt(job: Pick<JobRow, "id" | "output_paths">): string {
  const n = job.output_paths?.length ?? 0;
  return n > 0 ? `This removes the record and ${n} file${n === 1 ? "" : "s"} on disk.` : "This removes the record.";
}

/** Uploads as things a media input can point at. */
export function uploadOptions(uploads: readonly UploadRow[]): AssetOption[] {
  return uploads.map((u) => ({
    id: `upload:${u.path}`,
    label: u.name,
    path: u.path,
    kind: "upload",
    ...(u.kind === "image" ? { thumbPath: u.path } : {}),
  }));
}

const INPUT_KINDS: ReadonlySet<string> = new Set<InputKind>(["text", "textarea", "number", "image", "image_url", "audio", "video"]);

/** Calliope reports `kind` as a free string; the form only knows these. Anything else is text. */
export function toDynamicInputs(schema: readonly WorkflowInput[] | undefined): DynamicInput[] {
  return (schema ?? []).map((i) => ({
    nodeId: i.nodeId,
    label: i.label,
    role: i.role ?? null,
    kind: (INPUT_KINDS.has(i.kind) ? i.kind : "text") as InputKind,
    ...(i.defaultValue !== undefined ? { defaultValue: i.defaultValue } : {}),
    ...(i.required !== undefined ? { required: i.required } : {}),
  }));
}

/** The enabled workflows of one kind, in Calliope's order. */
export function workflowsFor(workflows: readonly WorkflowRow[], mode: Mode): WorkflowRow[] {
  return workflows.filter((w) => w.is_enabled && w.kind === mode);
}

/** Video first, like Calliope; image when nothing renders video. */
export function defaultMode(workflows: readonly WorkflowRow[]): Mode {
  return workflowsFor(workflows, "video").length ? "video" : "image";
}

/** Keep the current pick while the list still has it; otherwise the first one; null when empty. */
export function pickWorkflow(list: readonly WorkflowRow[], currentId: number | null): number | null {
  if (currentId !== null && list.some((w) => w.id === currentId)) return currentId;
  return list[0]?.id ?? null;
}

const MEDIA_KINDS: Record<string, readonly InputKind[]> = {
  image: ["image", "image_url"],
  video: ["video"],
  audio: ["audio"],
};

/** The first input an upload of this kind can fill, if the workflow has one. */
export function mediaInputFor(inputs: readonly DynamicInput[], uploadKind: string): DynamicInput | undefined {
  const kinds = MEDIA_KINDS[uploadKind] ?? [];
  return inputs.find((i) => kinds.includes(i.kind));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Projects a user can attach to: the hidden scratch project is `status: "system"`. */
export function attachableProjects<T extends { status: string }>(projects: readonly T[]): T[] {
  return projects.filter((p) => p.status !== "system");
}
