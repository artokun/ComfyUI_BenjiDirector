// Settings form logic — the pure half of SettingsPanel.tsx.
//
// The draft holds only what the user TOUCHED, as the raw strings they typed, so an input can
// show "2." while it is being edited. Everything that turns a draft into a request lives here:
// the numeric limits (mirrors of Calliope's `Field(ge=…, le=…)`, so a save never trips a raw
// 422), clamping on blur, quote stripping for pasted Windows paths, and the diff that makes a
// save carry ONLY the keys that actually changed — Calliope applies `exclude_unset`, so a key
// we do not send is a key we cannot accidentally reset.

import type { CalliopeSettings, Schemas } from "@benjidirector/calliope-client";

export type NumericKey = "queue_concurrency" | "queue_poll_interval_sec" | "queue_poll_timeout_sec" | "queue_max_retries";
export type TextKey = "comfyui_base_url" | "data_dir" | "assets_dir";
export type BoolKey = "dry_run";
export type EditableKey = NumericKey | TextKey | BoolKey;

export const NUMERIC_KEYS: readonly NumericKey[] = ["queue_concurrency", "queue_poll_interval_sec", "queue_poll_timeout_sec", "queue_max_retries"];
export const TEXT_KEYS: readonly TextKey[] = ["comfyui_base_url", "data_dir", "assets_dir"];
/** Paths get their wrapping quotes stripped — Explorer's "Copy as path" wraps them. */
export const PATH_KEYS: readonly TextKey[] = ["data_dir", "assets_dir"];

export const NUMERIC_LIMITS: Record<NumericKey, { min: number; max: number; step: number; label: string }> = {
  queue_concurrency: { min: 1, max: 8, step: 1, label: "Concurrency" },
  queue_poll_interval_sec: { min: 0.5, max: 60, step: 0.5, label: "Poll interval" },
  queue_poll_timeout_sec: { min: 0, max: 86400, step: 1, label: "Poll timeout" },
  queue_max_retries: { min: 0, max: 10, label: "Max retries", step: 1 },
};

/** Raw form values: strings for inputs, a boolean for the checkbox. */
export type SettingsDraft = Partial<Record<TextKey | NumericKey, string> & Record<BoolKey, boolean>>;

export function isNumericKey(key: string): key is NumericKey {
  return (NUMERIC_KEYS as readonly string[]).includes(key);
}

/** `"C:\data"` → `C:\data`; also trims. */
export function stripQuotes(raw: string): string {
  const s = raw.trim();
  const m = s.match(/^(["'])(.*)\1$/s);
  return (m ? m[2] ?? "" : s).trim();
}

/**
 * The number a field will carry: parsed, snapped to its step, clamped to its limits.
 * `null` when the text is not a number at all — the caller reverts to the saved value.
 */
export function clampNumber(key: NumericKey, raw: string | number): number | null {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (String(raw).trim() === "" || !Number.isFinite(n)) return null;
  const { min, max, step } = NUMERIC_LIMITS[key];
  const snapped = Math.round(n / step) * step;
  const clamped = Math.min(max, Math.max(min, snapped));
  // 0.1 + 0.2 territory: a step of 0.5 never needs more than four decimals.
  return Number(clamped.toFixed(4));
}

/** What a text field will carry once normalized. */
export function normalizeText(key: TextKey, raw: string): string {
  return (PATH_KEYS as readonly string[]).includes(key) ? stripQuotes(raw) : raw.trim();
}

export type SettingsChanges = Partial<Pick<Schemas["SettingsUpdate"], EditableKey>>;

/**
 * Only the keys whose normalized draft value differs from what Calliope has. A touched field
 * typed back to its saved value is NOT a change; a non-numeric string in a numeric field is
 * ignored (the blur handler already reverted it, this is the belt to that brace).
 */
export function diffSettings(saved: CalliopeSettings, draft: SettingsDraft): SettingsChanges {
  const out: SettingsChanges = {};
  for (const key of TEXT_KEYS) {
    const raw = draft[key];
    if (raw === undefined) continue;
    const next = normalizeText(key, raw);
    // An EMPTIED field is not a request to blank the setting. Calliope's settings router
    // assigns comfyui_base_url straight through, so sending "" would point every render job
    // at an empty URL. Clearing a box reverts it to what Calliope has instead.
    if (!next) continue;
    if (next !== String(saved[key] ?? "")) out[key] = next;
  }
  for (const key of NUMERIC_KEYS) {
    const raw = draft[key];
    if (raw === undefined) continue;
    const next = clampNumber(key, raw);
    if (next !== null && next !== Number(saved[key])) out[key] = next;
  }
  if (draft.dry_run !== undefined && draft.dry_run !== !!saved.dry_run) out.dry_run = draft.dry_run;
  return out;
}

export function countChanges(changes: SettingsChanges): number {
  return Object.keys(changes).length;
}
