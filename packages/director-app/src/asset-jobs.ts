// Assets: the pure half of the gallery — what to send Calliope and how to read what it says.
//
// Everything here is a plain function over rows, so the panel stays a thin view and the
// request shapes are pinned by tests rather than by reading the panel. The scoping rules
// mirror Calliope's `routers/assets.py` → `enqueue_asset_jobs`:
//
//   - locations are enqueued only when `location_ids` is given or `character_ids` is None;
//   - items only when `item_ids` is given, or both of the others are None;
//   - an entity whose prompt is empty is skipped, unless the workflow has no text input or
//     an `input_values` override is present.
//
// So "characters only" is `{character_ids: [...]}` with `location_ids` ABSENT, and
// "locations only" is `{character_ids: [], location_ids: [...]}` — the empty array is what
// keeps the character loop from firing. Calliope's own AssetsStage sends exactly these.

import type { CharacterRow, ItemRow, JobRow, LocationRow, Schemas, WorkflowInput, WorkflowRow } from "@benjidirector/calliope-client";
import type { AssetOption } from "./dynamic-form/index.js";
import { characterSheetTemplate, itemReferenceTemplate, locationReferenceTemplate } from "./prompt-templates.js";

export type EntityKind = "character" | "location" | "item";
export interface EntityRef {
  kind: EntityKind;
  id: number;
}
export type GenerateAssetsBody = Schemas["GenerateAssetsRequest"];
export type InputValues = Record<string, unknown>;

/** Items arrive with these columns on the wire (`SELECT ... reference_image_path, consistency_prompt`); the client types them loosely. */
export type AssetItemRow = ItemRow & { reference_image_path?: string | null; consistency_prompt?: string | null };
export type EntityRow = CharacterRow | LocationRow | AssetItemRow;
export interface EntityLists {
  characters: CharacterRow[];
  locations: LocationRow[];
  items: AssetItemRow[];
}

/** The job payload key Calliope stamps on an image job for each entity kind. */
export const JOB_PAYLOAD_KEY: Record<EntityKind, "character_id" | "location_id" | "item_id"> = {
  character: "character_id",
  location: "location_id",
  item: "item_id",
};

/** The column a finished image lands in — and the one an uploaded image is PATCHed into. */
export function uploadTarget(kind: EntityKind): "sheet_path" | "reference_image_path" {
  return kind === "character" ? "sheet_path" : "reference_image_path";
}

/** Stable key for drafts, busy flags and DOM hooks: `character:12`. */
export function entityKey(kind: EntityKind, id: number): string {
  return `${kind}:${id}`;
}

/** The entity's image path (sheet for a character, reference for the rest), or null. */
export function imagePathOf(kind: EntityKind, row: EntityRow): string | null {
  const v = (row as Record<string, unknown>)[uploadTarget(kind)];
  return typeof v === "string" && v ? v : null;
}

const NOUN: Record<EntityKind, { one: string; many: string; image: string; empty: string }> = {
  character: { one: "character", many: "Characters", image: "sheet", empty: "No sheet yet" },
  location: { one: "environment", many: "Environments", image: "reference", empty: "No reference yet" },
  item: { one: "item", many: "Items", image: "reference", empty: "No reference yet" },
};
export const nounOf = (kind: EntityKind) => NOUN[kind];

// ── jobs ──────────────────────────────────────────────────────────────────────

/** The newest image job that names this entity in its payload, or undefined. */
export function latestImageJobFor(jobs: readonly JobRow[], entity: EntityRef): JobRow | undefined {
  const key = JOB_PAYLOAD_KEY[entity.kind];
  let best: JobRow | undefined;
  for (const j of jobs) {
    if (j.kind !== "image") continue;
    const v = j.payload?.[key];
    if (v === undefined || v === null || Number(v) !== entity.id) continue;
    if (!best || j.id > best.id) best = j;
  }
  return best;
}

export type JobState = "generating" | "failed" | null;

/** What a card shows for its latest job: queued/running are both "generating". */
export function jobStateOf(job: JobRow | undefined): JobState {
  if (!job) return null;
  if (job.status === "pending" || job.status === "running") return "generating";
  if (job.status === "failed") return "failed";
  return null;
}

/** Union two job lists by id; `incoming` wins on a conflict (it is the fresher read). */
export function mergeJobs(base: readonly JobRow[], incoming: readonly JobRow[]): JobRow[] {
  const byId = new Map<number, JobRow>();
  for (const j of base) byId.set(j.id, j);
  for (const j of incoming) byId.set(j.id, j);
  return [...byId.values()];
}

// ── workflow inputs ───────────────────────────────────────────────────────────

/** Calliope's `INPUT_ROLE_ALIASES` (lib/comfy/parser.ts). */
const INPUT_ROLE_ALIASES: Record<string, string[]> = {
  prompt: ["prompt", "positive"],
  negative: ["negative", "neg"],
  width: ["width", "w"],
  height: ["height", "h"],
  character: ["character", "char", "portrait", "sheet", "face", "ref"],
  location: ["location", "loc", "environment", "env", "background", "scene"],
  image: ["image", "img"],
  video: ["video", "vid"],
  audio: ["audio", "sound", "sfx"],
  seed: ["seed"],
  duration: ["duration", "dur", "length", "seconds"],
};

export function normalizeInputRole(role: string | null | undefined): string | null {
  if (!role) return null;
  const r = role.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(INPUT_ROLE_ALIASES)) {
    if (r === canonical || aliases.includes(r)) return canonical;
  }
  return r;
}

/** Roles the per-tab form hides: the card's own prompt box owns the positive prompt, and a negative is not an asset setting. */
export const PROMPT_HIDE_ROLES: readonly string[] = ["prompt", "positive", "negative"];

/** Positive prompt input — prefers `(Input:prompt)`, with Calliope's legacy label fallback. */
export function isPromptLikeInput(inp: WorkflowInput): boolean {
  const role = normalizeInputRole(inp.role);
  if (role === "prompt") return true;
  if (role) return false;
  if (inp.kind !== "text" && inp.kind !== "textarea") return false;
  const label = (inp.label || "").toLowerCase();
  if (label.includes("negative")) return false;
  return label.includes("prompt") || label.includes("positive") || label.includes("text") || inp.kind === "textarea";
}

/** True if this workflow can take our prompt at all; without it the card's prompt is never sent. */
export function workflowHasPromptInput(inputs: readonly WorkflowInput[] | null | undefined): boolean {
  return !!inputs?.some(isPromptLikeInput);
}

/** Strip null/undefined/blank strings so an empty field cannot wipe Calliope's smart-fill. */
export function compactInputValues(values: InputValues | null | undefined): InputValues {
  const out: InputValues = {};
  if (!values) return out;
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

/** Seed schema defaults into the values a form starts from (Calliope skips empty-string defaults). */
export function seedInputDefaults(inputs: readonly WorkflowInput[], values: InputValues = {}): InputValues {
  const next = { ...values };
  for (const inp of inputs) {
    if (next[inp.nodeId] === undefined && inp.defaultValue !== undefined && inp.defaultValue !== "") next[inp.nodeId] = inp.defaultValue;
  }
  return next;
}

/** Required inputs (outside the hidden roles) that have no value yet. */
export function missingRequiredInputs(inputs: readonly WorkflowInput[], values: InputValues, hideRoles: readonly string[] = PROMPT_HIDE_ROLES): WorkflowInput[] {
  return inputs.filter((i) => {
    if (!i.required) return false;
    if (hideRoles.includes(normalizeInputRole(i.role) ?? "")) return false;
    const v = values[i.nodeId];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
}

/** Workflows the asset tabs may pick from: enabled, image kind, in Calliope's order. */
export function imageWorkflows(rows: readonly WorkflowRow[] | null | undefined): WorkflowRow[] {
  return (rows ?? []).filter((w) => w.is_enabled && w.kind === "image");
}

/** Every entity that already has an image, as a picker option for image-role inputs. */
export function assetOptionsFrom(lists: EntityLists | null | undefined): AssetOption[] {
  if (!lists) return [];
  const out: AssetOption[] = [];
  for (const c of lists.characters) {
    if (c.sheet_path) out.push({ id: entityKey("character", c.id), label: `${c.name} · sheet`, path: c.sheet_path, kind: "character" });
  }
  for (const l of lists.locations) {
    if (l.reference_image_path) out.push({ id: entityKey("location", l.id), label: `${l.name} · environment`, path: l.reference_image_path, kind: "location" });
  }
  for (const it of lists.items) {
    if (it.reference_image_path) out.push({ id: entityKey("item", it.id), label: `${it.name} · item`, path: it.reference_image_path, kind: "item" });
  }
  return out;
}

// ── prompts ───────────────────────────────────────────────────────────────────

/** The built-in template for an entity — what "Reset to template" restores. */
export function templateFor(kind: EntityKind, row: EntityRow): string {
  if (kind === "character") return characterSheetTemplate(row as CharacterRow);
  if (kind === "location") return locationReferenceTemplate(row as LocationRow);
  return itemReferenceTemplate(row as AssetItemRow);
}

/** What the card's prompt box shows: the unsaved draft, else the saved prompt, else the template. */
export function promptFor(kind: EntityKind, row: EntityRow, draft?: string): string {
  if (draft !== undefined) return draft;
  const saved = (row as { consistency_prompt?: string | null }).consistency_prompt?.trim();
  return saved || templateFor(kind, row);
}

// ── request bodies ────────────────────────────────────────────────────────────

export interface KindGeneration {
  workflowId?: number;
  inputValues?: InputValues;
}

/**
 * "Generate all missing": the three scoped calls Calliope's AssetsStage makes, in order —
 * every character (sheet), every location, every item — each `missing_only`. An empty id
 * list is a no-op on the backend, so the plan is always three bodies and the caller may send
 * them all. `workflowId` is the default; `perKind` overrides the workflow and inputs per tab.
 */
export function generateAllMissingPlan(lists: EntityLists, workflowId: number, perKind: Partial<Record<EntityKind, KindGeneration>> = {}): GenerateAssetsBody[] {
  const wf = (kind: EntityKind) => perKind[kind]?.workflowId ?? workflowId;
  const values = (kind: EntityKind) => compactInputValues(perKind[kind]?.inputValues);
  return [
    { missing_only: true, asset_target: "sheet", workflow_id: wf("character"), character_ids: lists.characters.map((c) => c.id), input_values: values("character") },
    { missing_only: true, asset_target: "sheet", workflow_id: wf("location"), character_ids: [], location_ids: lists.locations.map((l) => l.id), input_values: values("location") },
    { missing_only: true, asset_target: "sheet", workflow_id: wf("item"), character_ids: [], location_ids: [], item_ids: lists.items.map((it) => it.id), input_values: values("item") },
  ];
}

/** Generate / regenerate ONE entity's image, with the prompt the card shows. */
export function generateOnePlan(entity: EntityRef, opts: { workflowId: number; inputValues?: InputValues; prompt?: string | null }): GenerateAssetsBody {
  const body: GenerateAssetsBody = {
    missing_only: false,
    asset_target: "sheet",
    workflow_id: opts.workflowId,
    input_values: compactInputValues(opts.inputValues),
  };
  if (entity.kind === "character") {
    body.character_ids = [entity.id];
    body.location_ids = [];
  } else if (entity.kind === "location") {
    body.character_ids = [];
    body.location_ids = [entity.id];
  } else {
    body.character_ids = [];
    body.location_ids = [];
    body.item_ids = [entity.id];
  }
  const prompt = opts.prompt?.trim();
  if (prompt) body.prompt = prompt;
  return body;
}
