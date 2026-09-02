// Classify a workflow's inputs into the composer's zones.
//
// Presentation only — the values map (nodeId → value) a form produces is the same whatever
// zone an input renders in; this decides WHERE it renders. Ported from Calliope's
// `lib/comfy/classifyInput.ts` with one deliberate difference: an input whose KIND is media
// (a LoadImage tagged plain `(Input)`) goes to the media tray too, rather than to Advanced as
// a raw path field — it is a file whichever way its title was written.
//
//   composer  → the prompt box and the collapsible negative
//   media     → thumbnail tiles (pick an asset / a clip / upload)
//   control   → pills: resolution, duration, seed
//   advanced  → everything else, behind one popover so nothing is lost

import { isPromptLike, MEDIA_ROLES, roleOf } from "./roles.js";
import type { DynamicInput, MediaKind } from "./types.js";

export type InputZone = "composer" | "media" | "control" | "advanced";
export type InputWidget = "prompt" | "negative" | "mediaTile" | "resolution" | "duration" | "seed" | "number" | "text";

export interface ClassifiedInput {
  input: DynamicInput;
  /** Canonical role (aliases folded), or null. */
  role: string | null;
  zone: InputZone;
  widget: InputWidget;
}

const MEDIA_KINDS = new Set<string>(["image", "image_url", "audio", "video"]);

/** Every input lands in exactly one zone; unknown roles fall to `advanced`, never dropped. */
export function classifyInput(input: DynamicInput): ClassifiedInput {
  const role = roleOf(input);
  if (isPromptLike(input)) return { input, role: role ?? "prompt", zone: "composer", widget: "prompt" };
  if (role === "negative") return { input, role, zone: "composer", widget: "negative" };
  if ((role && MEDIA_ROLES.includes(role)) || MEDIA_KINDS.has(input.kind)) return { input, role, zone: "media", widget: "mediaTile" };
  if (role === "width" || role === "height") return { input, role, zone: "control", widget: "resolution" };
  if (role === "duration") return { input, role, zone: "control", widget: "duration" };
  if (role === "seed") return { input, role, zone: "control", widget: "seed" };
  if (input.kind === "number") return { input, role, zone: "advanced", widget: "number" };
  return { input, role, zone: "advanced", widget: "text" };
}

export interface Classified {
  prompt: ClassifiedInput | null;
  negative: ClassifiedInput | null;
  media: ClassifiedInput[];
  /** Duration / seed / a lone width or height, in schema order. */
  control: ClassifiedInput[];
  advanced: ClassifiedInput[];
  /** Both width AND height present → one Resolution pill writes both node ids. */
  resolutionPair: { width: ClassifiedInput; height: ClassifiedInput } | null;
}

/**
 * Batch-classify a schema. Only the FIRST prompt and negative are the composer's boxes; a
 * second prompt-like input is still shown, under Advanced, so a two-prompt workflow does
 * not hide one of them.
 */
export function classifyAll(inputs: readonly DynamicInput[] | undefined | null): Classified {
  const classified = (inputs ?? []).map(classifyInput);
  const prompt = classified.find((c) => c.widget === "prompt") ?? null;
  const negative = classified.find((c) => c.widget === "negative") ?? null;
  const media = classified.filter((c) => c.zone === "media");
  const extras = classified.filter((c) => (c.widget === "prompt" && c !== prompt) || (c.widget === "negative" && c !== negative)).map((c) => ({ ...c, zone: "advanced" as const, widget: "text" as const }));
  const advanced = [...classified.filter((c) => c.zone === "advanced"), ...extras];

  const res = classified.filter((c) => c.widget === "resolution");
  const width = res.find((c) => c.role === "width");
  const height = res.find((c) => c.role === "height");
  const resolutionPair = width && height ? { width, height } : null;
  const control = classified.filter((c) => c.zone === "control" && (c.widget !== "resolution" || !resolutionPair));

  return { prompt, negative, media, control, advanced, resolutionPair };
}

/** The file type a media input wants: the role decides, then the kind, and refs are images. */
export function mediaKindOfInput(input: DynamicInput): MediaKind {
  const role = roleOf(input);
  if (role === "video" || input.kind === "video") return "video";
  if (role === "audio" || input.kind === "audio") return "audio";
  return "image";
}

// ── numeric controls ──────────────────────────────────────────────────────────

export interface NumericRange {
  min: number;
  max: number;
  step: number;
}

export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

export const RESOLUTION_PRESETS: readonly ResolutionPreset[] = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
];

/** A lone width or height steps by 64 — what every video model's latent grid wants. */
export const RESOLUTION_RANGE: NumericRange = { min: 256, max: 4096, step: 64 };
export const DURATION_RANGE: NumericRange = { min: 1, max: 30, step: 1 };
export const SEED_RANGE: NumericRange = { min: 0, max: 999_999_999, step: 1 };

export function rangeFor(widget: InputWidget): NumericRange | null {
  if (widget === "resolution") return RESOLUTION_RANGE;
  if (widget === "duration") return DURATION_RANGE;
  if (widget === "seed") return SEED_RANGE;
  return null;
}

export function clampTo(n: number, range: NumericRange): number {
  if (!Number.isFinite(n)) return range.min;
  return Math.min(range.max, Math.max(range.min, n));
}

/** Snap onto the range's grid (multiples of `step` from `min`), then clamp. */
export function snapTo(n: number, range: NumericRange): number {
  const c = clampTo(n, range);
  return clampTo(range.min + Math.round((c - range.min) / range.step) * range.step, range);
}

/** One step up or down from the current value, snapped and clamped. Unset starts at `min`. */
export function stepValue(current: unknown, dir: -1 | 1, range: NumericRange): number {
  const n = typeof current === "number" ? current : Number(current);
  const base = Number.isFinite(n) && String(current) !== "" ? n : range.min - (dir > 0 ? range.step : 0);
  return snapTo(base + dir * range.step, range);
}

/** The preset label for a width/height pair, `W×H` for a custom pair, null when either is unset. */
export function resolutionLabel(width: unknown, height: unknown): string | null {
  const w = Number(width);
  const h = Number(height);
  if (!w || !h) return null;
  const preset = RESOLUTION_PRESETS.find((p) => p.width === w && p.height === h);
  return preset?.label ?? `${w}×${h}`;
}

/** `"1280x720"` → `{width, height}`, or null when either half is missing. */
export function parseResolution(value: unknown): { width: number; height: number } | null {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(String(value ?? ""));
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width && height ? { width, height } : null;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * (SEED_RANGE.max + 1));
}
