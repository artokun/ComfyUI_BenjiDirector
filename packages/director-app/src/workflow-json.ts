// ComfyUI API-format workflow JSON: the client-side half of Calliope's workflow registration.
//
// Calliope (`comfyui/parser.py`, `comfyui/roles.py`, `comfyui/profiles.py`) is the authority —
// `POST /api/workflows/analyze` returns the inputs, outputs and suggested prompt profile that
// registration will store. What lives here is the part that has to happen BEFORE a network
// round trip: is this even an API-format graph, and what would the roles look like — so the
// register card can show a preview the instant JSON is pasted, and refuse a UI-format export
// with a reason instead of a 422. The role vocabulary and aliases mirror `roles.py` verbatim;
// if they diverge, the analysis from Calliope wins (the panel replaces the preview with it).

import type { WorkflowInput, WorkflowOutput } from "@benjidirector/calliope-client";

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
  [k: string]: unknown;
}
export type ApiWorkflow = Record<string, ApiNode>;

export type ShapeCheck = { ok: true; json: ApiWorkflow; nodeCount: number } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Is `source` an API-format workflow — an object of nodes, each with a string `class_type` and
 * an object `inputs`? Accepts the raw text or an already-parsed value. Names ONE thing wrong,
 * in the words a person needs to fix it: a UI-format export (the "Save" button, not
 * "Save (API Format)") is the mistake everyone makes once. Which bad node it names is the
 * first in `Object.keys` order — numeric for the integer-like ids ComfyUI writes — not
 * necessarily the first in the file.
 */
export function checkWorkflowShape(source: string | unknown): ShapeCheck {
  let value: unknown = source;
  if (typeof source === "string") {
    if (!source.trim()) return { ok: false, error: "Paste or drop a workflow JSON first." };
    try {
      value = JSON.parse(source);
    } catch (err) {
      return { ok: false, error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (!isRecord(value)) return { ok: false, error: "A workflow is a JSON object keyed by node id, not an array or a scalar." };
  if (Array.isArray(value.nodes) && (Array.isArray(value.links) || value.version !== undefined || value.last_node_id !== undefined)) {
    return { ok: false, error: "This is a UI-format workflow (nodes / links). Export it with Save (API Format) in ComfyUI, or ask the agent to register the canvas workflow." };
  }
  const ids = Object.keys(value);
  if (ids.length === 0) return { ok: false, error: "The workflow has no nodes." };
  for (const id of ids) {
    const node = value[id];
    if (!isRecord(node)) return { ok: false, error: `Node #${id} is not an object.` };
    if (typeof node.class_type !== "string" || !node.class_type) return { ok: false, error: `Node #${id} has no class_type — this is not API-format JSON.` };
    if (!isRecord(node.inputs)) return { ok: false, error: `Node #${id} (${node.class_type}) has no inputs object.` };
  }
  return { ok: true, json: value as ApiWorkflow, nodeCount: ids.length };
}

// ── title contract: `Display Name (Input:role)` / `(Output:role)` ──────────────────────────

/** Canonical input role → accepted aliases. Mirrors Calliope's `roles.py` INPUT_ROLE_ALIASES. */
export const INPUT_ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
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
export const OUTPUT_ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  image: ["image", "img"],
  video: ["video", "vid"],
};
export const INPUT_ROLES = Object.keys(INPUT_ROLE_ALIASES);
export const OUTPUT_ROLES = Object.keys(OUTPUT_ROLE_ALIASES);
/** The input roles a Scene's ports feed (the rest are literals the form supplies). */
export const SCENE_PORT_ROLES = ["prompt", "character", "location", "image", "video"] as const;

const TITLE_TAG = /\((Input|Output)(?::([a-zA-Z0-9_-]+))?\)/i;
const TITLE_TAG_ALL = /\((?:Input|Output)(?::[a-zA-Z0-9_-]+)?\)/gi;

export interface TitleTag {
  kind: "input" | "output" | null;
  /** Lowercased role as written (an alias is NOT normalised here), null for a bare `(Input)`. */
  role: string | null;
  /** The display name with the tag stripped; falls back to the role, then the kind. */
  label: string;
}

/** `"Positive Prompt (Input:prompt)"` → `{ kind: "input", role: "prompt", label: "Positive Prompt" }`. */
export function parseTitleTag(title: string | null | undefined): TitleTag {
  if (!title) return { kind: null, role: null, label: "" };
  const m = TITLE_TAG.exec(title);
  if (!m) return { kind: null, role: null, label: title.trim() };
  const kind = (m[1] as string).toLowerCase() as "input" | "output";
  const role = m[2] ? m[2].toLowerCase() : null;
  const stripped = title.replace(TITLE_TAG_ALL, "").trim();
  return { kind, role, label: stripped || role || kind };
}

function normalizeRole(role: string | null | undefined, table: Readonly<Record<string, readonly string[]>>): string | null {
  if (!role) return null;
  const r = role.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(table)) {
    if (r === canonical || aliases.includes(r)) return canonical;
  }
  return r;
}
/** An alias to its canonical input role; an unknown role passes through lowercased. */
export const normalizeInputRole = (role: string | null | undefined): string | null => normalizeRole(role, INPUT_ROLE_ALIASES);
export const normalizeOutputRole = (role: string | null | undefined): string | null => normalizeRole(role, OUTPUT_ROLE_ALIASES);

// ── class_type → kind, mirroring Calliope's `comfyui/registry.py` ───────────────────────────

const TEXT_AREA_CLASSES = new Set(["CLIPTextEncode", "Note", "ShowText", "ImpactWildcardProcessor", "PrimitiveStringMultiline", "PrimitiveString"]);
const NUMBER_CLASSES = new Set(["INT", "FLOAT", "PrimitiveInt", "PrimitiveFloat", "KSampler", "KSamplerAdvanced"]);
const IMAGE_CLASSES = new Set(["LoadImage", "ImageLoader", "ETN_LoadImageBase64"]);
const IMAGE_URL_CLASSES = new Set(["Load Image From Url (mtb)"]);
const AUDIO_CLASSES = new Set(["LoadAudio", "VHS_LoadAudio"]);
const VIDEO_CLASSES = new Set(["LoadVideo", "VHS_LoadVideo", "VHS_LoadVideoPath"]);
const VIDEO_OUTPUT_CLASSES = new Set(["VHS_VideoCombine", "SaveVideo", "VideoOutput", "AnimateDiffCombine"]);
const IMAGE_OUTPUT_CLASSES = new Set(["SaveImage", "PreviewImage", "SaveImageWebsocket", "ETN_SendImageWebSocket"]);

export type InputKind = "text" | "textarea" | "number" | "image" | "image_url" | "audio" | "video";
export type OutputKind = "image" | "video" | "other";

export function classToInputKind(classType: string): InputKind {
  if (IMAGE_CLASSES.has(classType)) return "image";
  if (IMAGE_URL_CLASSES.has(classType)) return "image_url";
  if (AUDIO_CLASSES.has(classType)) return "audio";
  if (VIDEO_CLASSES.has(classType)) return "video";
  if (NUMBER_CLASSES.has(classType)) return "number";
  if (TEXT_AREA_CLASSES.has(classType)) return "textarea";
  const lower = classType.toLowerCase();
  if (lower.includes("video")) return "video";
  if (lower.includes("audio")) return "audio";
  if (lower.includes("image") || lower.includes("load")) return "image";
  if (lower.includes("int") || lower.includes("float") || lower.includes("seed")) return "number";
  if (lower.includes("text") || lower.includes("clip") || lower.includes("prompt")) return "textarea";
  return "text";
}

export function classToOutputKind(classType: string): OutputKind {
  const lower = classType.toLowerCase();
  if (VIDEO_OUTPUT_CLASSES.has(classType) || lower.includes("video")) return "video";
  if (IMAGE_OUTPUT_CLASSES.has(classType) || lower.includes("image")) return "image";
  return "other";
}

function extractDefaultValue(node: ApiNode): string | number | undefined {
  const ct = node.class_type;
  if (IMAGE_CLASSES.has(ct) || AUDIO_CLASSES.has(ct) || VIDEO_CLASSES.has(ct)) return undefined;
  const inputs = node.inputs ?? {};
  if (typeof inputs.text === "string") return inputs.text;
  const value = inputs.value;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof inputs.int === "number") return inputs.int;
  if (typeof inputs.float === "number") return inputs.float;
  return undefined;
}

export type PromptProfile = "prose" | "minimax_h3_ref";

/** Calliope's rule (`profiles.py`): any `MiniMaxH3*` class_type means the H3 six-section prompt. */
export function suggestProfile(json: ApiWorkflow): PromptProfile {
  for (const node of Object.values(json)) {
    if (isRecord(node) && typeof node.class_type === "string" && node.class_type.startsWith("MiniMaxH3")) return "minimax_h3_ref";
  }
  return "prose";
}

export interface WorkflowPreview {
  inputs: WorkflowInput[];
  outputs: WorkflowOutput[];
  suggestedProfile: PromptProfile;
}

/**
 * What Calliope's analyzer will say, computed locally from the node titles: same walk, same
 * shape as `WorkflowAnalysis`, so the table that renders this preview renders the server's
 * real answer unchanged.
 *
 * ROW ORDER is the one thing that can differ. JS iterates integer-like keys in ascending
 * numeric order, while Calliope's Python dict keeps the file's insertion order — so a graph
 * written {"10": …, "2": …} previews as 2,10 and comes back from `/analyze` as 10,2. The rows
 * are the same rows; only their order settles when the analysis lands.
 */
export function previewWorkflow(json: ApiWorkflow): WorkflowPreview {
  const inputs: WorkflowInput[] = [];
  const outputs: WorkflowOutput[] = [];
  for (const [nodeId, node] of Object.entries(json)) {
    if (!isRecord(node)) continue;
    const tag = parseTitleTag(typeof node._meta?.title === "string" ? node._meta.title : "");
    if (tag.kind === "input") {
      const dv = extractDefaultValue(node);
      inputs.push({
        nodeId,
        label: tag.label || node.class_type || nodeId,
        role: normalizeInputRole(tag.role),
        kind: classToInputKind(node.class_type ?? ""),
        ...(dv !== undefined ? { defaultValue: dv } : {}),
        required: true,
      });
    } else if (tag.kind === "output") {
      const role = normalizeOutputRole(tag.role);
      let kind: OutputKind = classToOutputKind(node.class_type ?? "");
      if (role === "video") kind = "video";
      else if (role === "image") kind = "image";
      outputs.push({ nodeId, label: tag.label || node.class_type || nodeId, role, kind });
    }
  }
  return { inputs, outputs, suggestedProfile: suggestProfile(json) };
}

/** `"C:\\wf\\LTX Ref-to-Video.json"` → `"LTX Ref-to-Video"`: the default library name for a file. */
export function fileStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.json$/i, "").trim();
}

/** Prompt-format choices as the register and edit forms list them. */
export const PROMPT_PROFILES: ReadonlyArray<{ id: PromptProfile; label: string }> = [
  { id: "prose", label: "Plain prose (default)" },
  { id: "minimax_h3_ref", label: "MiniMax H3 reference (6-section)" },
];
