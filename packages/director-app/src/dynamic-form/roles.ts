// Input roles — the vocabulary a workflow's `(Input:role)` node titles speak.
//
// Mirrors Calliope's `comfyui/roles.py` / `lib/comfy/parser.ts` exactly: the canonical set and
// every alias each one accepts. Calliope normalises roles on ITS side when it reports an
// `input_schema`, so most rows arrive canonical already — but an analysed-but-unsaved workflow,
// an older row, or a hand-written schema can still carry `positive` or `env`, and a form that
// does not fold those onto `prompt` / `location` would show a raw text field where the prompt
// box should be. Keep this table in step with the backend; a role added on one side only is
// an input that lands in "Advanced".

export const INPUT_ROLE_ALIASES: Record<string, readonly string[]> = {
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

export const CANONICAL_ROLES = Object.keys(INPUT_ROLE_ALIASES);

/** Roles whose value is a media path (a picked asset, a clip, an upload). */
export const MEDIA_ROLES: readonly string[] = ["character", "location", "image", "video", "audio"];

/**
 * Fold an alias onto its canonical role. An unknown role comes back lower-cased and trimmed
 * rather than null — the backend does the same, and a role nobody recognises still names
 * the input better than nothing does.
 */
export function normalizeInputRole(role: string | null | undefined): string | null {
  if (!role) return null;
  const r = role.toLowerCase().trim();
  if (!r) return null;
  for (const [canonical, aliases] of Object.entries(INPUT_ROLE_ALIASES)) {
    if (r === canonical || aliases.includes(r)) return canonical;
  }
  return r;
}

/** The canonical role of a schema entry, or null for a plain `(Input)`. */
export function roleOf(input: { role?: string | null }): string | null {
  return normalizeInputRole(input.role ?? null);
}

/** Does this input carry one of the given canonical roles (aliases included)? */
export function hasRole(input: { role?: string | null }, ...roles: string[]): boolean {
  const r = roleOf(input);
  if (!r) return false;
  return roles.some((x) => normalizeInputRole(x) === r);
}

/** The first input of a role, if the workflow has one. */
export function inputWithRole<T extends { role?: string | null }>(inputs: readonly T[] | undefined | null, role: string): T | undefined {
  if (!inputs?.length) return undefined;
  return inputs.find((i) => hasRole(i, role));
}

/** The `(Input:video)` node a continue-from-previous scene needs — Calliope 400s without one. */
export function videoInputOf<T extends { role?: string | null }>(inputs: readonly T[] | undefined | null): T | undefined {
  return inputWithRole(inputs, "video");
}

/**
 * Is this the positive prompt? Prefers the role; a legacy schema without roles falls back to
 * the label (ported from Calliope's `promptInput.ts`, so both UIs agree on which box is
 * "the prompt").
 */
export function isPromptLike(input: { role?: string | null; kind?: string; label?: string }): boolean {
  const role = roleOf(input);
  if (role === "prompt") return true;
  if (role) return false;
  if (input.kind !== "text" && input.kind !== "textarea") return false;
  const label = (input.label ?? "").toLowerCase();
  if (label.includes("negative")) return false;
  return label.includes("prompt") || label.includes("positive") || label.includes("text") || input.kind === "textarea";
}

/** Human label for a role, for the history drawer and the media tiles. */
export function roleLabel(role: string | null | undefined): string {
  switch (normalizeInputRole(role)) {
    case "character":
      return "Character ref";
    case "location":
      return "Location ref";
    case "image":
      return "Ref image";
    case "video":
      return "Video input";
    case "audio":
      return "Audio input";
    case "prompt":
      return "Prompt";
    case "negative":
      return "Negative prompt";
    case "width":
      return "Width";
    case "height":
      return "Height";
    case "seed":
      return "Seed";
    case "duration":
      return "Duration";
    default:
      return role ?? "";
  }
}
