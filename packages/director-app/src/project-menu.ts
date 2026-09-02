// Project menu logic — the pure half of ProjectMenu.tsx.
//
// Calliope's presets (genre, tone, target duration) are copied verbatim from its projects
// page so a project made here reads the same as one made there. `pick`/`resolve` are the
// preset-or-custom pair every select in the form uses: a value that is not a preset shows as
// "Custom…" plus a text field, and never gets silently replaced by the first preset.

import type { Schemas, StoryBundle } from "@benjidirector/calliope-client";

export type Project = Schemas["Project"];

/** The sentinel option value that opens the free-text field beside a preset select. */
export const CUSTOM = "__custom";

export const GENRES: readonly string[] = ["Adventure / Mystery", "Drama", "Sci-Fi", "Fantasy", "Horror", "Romance", "Thriller"];
export const TONES: readonly string[] = ["Cinematic, atmospheric", "Dark, tense", "Whimsical, warm", "Gritty, realistic", "Epic, sweeping"];
export const DURATIONS: readonly string[] = ["30 seconds", "1 minute", "2 minutes", "5 minutes", "10 minutes"];
/** Calliope's own defaults for a new project. */
export const DEFAULTS = { genre: "Adventure / Mystery", tone: "Cinematic, atmospheric", duration: "2 minutes" } as const;

export type StatusTone = "" | "info" | "ok";
export const STATUSES: readonly { id: string; label: string; tone: StatusTone; hint: string }[] = [
  { id: "draft", label: "Draft", tone: "", hint: "Story still being shaped" },
  { id: "in_progress", label: "In progress", tone: "info", hint: "Assets and clips rendering" },
  { id: "completed", label: "Ready", tone: "ok", hint: "Every scene has its clip" },
];

export function statusLabel(status: string | null | undefined): string {
  const s = status ?? "draft";
  return STATUSES.find((x) => x.id === s)?.label ?? s.replace(/_/g, " ");
}

export function statusTone(status: string | null | undefined): StatusTone {
  return STATUSES.find((x) => x.id === (status ?? "draft"))?.tone ?? "";
}

/** Which option a select shows for a stored value, and what the custom field holds. */
export function pick(value: string | null | undefined, presets: readonly string[], fallback: string): { sel: string; custom: string } {
  const v = (value ?? "").trim();
  if (!v) return { sel: fallback, custom: "" };
  return presets.includes(v) ? { sel: v, custom: "" } : { sel: CUSTOM, custom: v };
}

/** The string a preset-or-custom pair submits. */
export function resolve(sel: string, custom: string): string {
  return sel === CUSTOM ? custom.trim() : sel;
}

export const TITLE_MAX = 200;

/** `null` when the title is fine; otherwise the sentence to show. */
export function validateTitle(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "Give the project a title.";
  if (t.length > TITLE_MAX) return `Keep the title under ${TITLE_MAX} characters (this one is ${t.length}).`;
  return null;
}

/** Case-insensitive match on title, genre, tone and idea. An empty query keeps everything. */
export function filterProjects(list: readonly Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((p) => [p.title, p.genre, p.tone, p.idea].some((s) => (s ?? "").toLowerCase().includes(q)));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 scenes · 2 characters" — from the stats the list route attaches; zeros when absent. */
export function projectStats(p: Pick<Project, "stats">): string {
  const s = p.stats ?? { scene_count: 0, character_count: 0, asset_ready_count: 0, asset_total_count: 0 };
  return `${plural(s.scene_count ?? 0, "scene")} · ${plural(s.character_count ?? 0, "character")}`;
}

/**
 * Parse Calliope's timestamps. SQLite's CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with
 * no marker, which `Date.parse` would read as LOCAL time — so the marker is added here.
 */
export function parseStamp(stamp: string | null | undefined): number {
  if (!stamp) return NaN;
  const s = stamp.trim();
  const sqlite = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : s);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else the date. Empty for garbage. */
export function relativeTime(stamp: string | null | undefined, now: number = Date.now()): string {
  const t = parseStamp(stamp);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * The picture for a project row: its cover, else the first character sheet (or portrait) from
 * its story. A path, not a URL — the component turns it into one with `client.fileUrl`.
 */
export function coverPath(p: Pick<Project, "id" | "cover_path">, story: StoryBundle | null | undefined): string | null {
  if (p.cover_path) return p.cover_path;
  if (!story || story.project.id !== p.id) return null;
  for (const c of story.characters) {
    const path = c.sheet_path ?? c.portrait_path;
    if (path) return path;
  }
  return null;
}
