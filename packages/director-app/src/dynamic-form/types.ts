// The dynamic-form contract: what a workflow input looks like and what a form hands back.
//
// These are the shapes the Assets, Render and Playground panels code against; `index.tsx`
// re-exports them so a consumer imports one path. Pure helpers live here too so the classify
// and render-state modules can use them without pulling React in.

export type InputKind = "text" | "textarea" | "number" | "image" | "image_url" | "audio" | "video";

/** One entry of a workflow's `input_schema` as Calliope reports it. */
export interface DynamicInput {
  nodeId: string;
  label: string;
  /** Canonical role (`prompt`, `negative`, `width`, `height`, `character`, `location`, `image`, `video`, `audio`, `seed`, `duration`) or null. */
  role: string | null;
  kind: InputKind;
  defaultValue?: unknown;
  required?: boolean;
}

/** What kind of file a media option or media input carries. */
export type MediaKind = "image" | "video" | "audio";

/** Something a media input can point at: an existing asset image, a clip, an upload. */
export interface AssetOption {
  id: string;
  label: string;
  path: string;
  kind: "character" | "location" | "item" | "clip" | "upload";
  thumbPath?: string;
  /** The file type; inferred from `kind` / the path's extension when absent. */
  media?: MediaKind;
}

export type InputValues = Record<string, unknown>;

/** Drop the empty strings/undefined so a request carries only what the user set. */
export function compactInputValues(values: InputValues | undefined | null): InputValues {
  const out: InputValues = {};
  if (!values) return out;
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    out[k] = v;
  }
  return out;
}

/** Seed a values object from schema defaults (only for keys the caller has not set). */
export function seedDefaults(inputs: DynamicInput[], values: InputValues): InputValues {
  const out = { ...values };
  for (const i of inputs) if (out[i.nodeId] === undefined && i.defaultValue !== undefined && i.defaultValue !== "") out[i.nodeId] = i.defaultValue;
  return out;
}

export function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && !v.trim());
}

export function missingRequired(inputs: DynamicInput[], values: InputValues, hideRoles: string[] = []): DynamicInput[] {
  return inputs.filter((i) => i.required && !hideRoles.includes(i.role ?? "") && isBlank(values[i.nodeId]));
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;

/** File type from a path's extension; images are the default because refs are images. */
export function mediaKindOfPath(path: string): MediaKind {
  if (VIDEO_EXT.test(path)) return "video";
  if (AUDIO_EXT.test(path)) return "audio";
  return "image";
}

/** The file type an option carries: explicit, else by group (clips are video), else by extension. */
export function mediaKindOfOption(opt: AssetOption): MediaKind {
  if (opt.media) return opt.media;
  if (opt.kind === "clip") return "video";
  if (opt.kind === "upload") return mediaKindOfPath(opt.path);
  return "image";
}

/** Just the file name, for a tile caption. */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}
