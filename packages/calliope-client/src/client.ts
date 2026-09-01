// Typed client for Calliope's HTTP API.
//
// The request/response types come from `openapi.d.ts`, generated from the `openapi.json`
// snapshot beside it (`npx openapi-typescript@7 openapi.json -o src/openapi.d.ts`). The
// snapshot is committed on purpose: a client generated from whatever server happens to be
// running is a client nobody can review, and a contract test checks every route below
// against the snapshot so a rename upstream is a red build here, not a 404 in the pane.
//
// Calliope is used HEADLESS and DRIVEN. Three things are deliberately absent:
//   - /api/agent/*            — our agent replaces Calliope's; two agents on one SQLite
//                               database with no shared lock is a corruption bug waiting
//                               for a race.
//   - generate-story/script   — LLM-backed inside Calliope. Our agent drafts and writes
//                               through the plain CRUD routes instead.
//   - the H3 prompt rewrite   — sidestepped by writing `video_settings.prompt_draft` with a
//                               fresh `prompt_draft_meta.based_on` hash; see `promptDraft()`.

import type { components } from "./openapi.js";
import type { CalliopeConfig } from "./index.js";

export type Schemas = components["schemas"];

/** Rows Calliope returns as `dict[str, Any]`. Shapes observed in `db.py`, not in the spec. */
export interface SceneRow {
  id: number;
  project_id: number;
  beat_id: number | null;
  order_index: number;
  heading: string;
  action: string | null;
  dialog: string | null;
  duration_sec: number | null;
  workflow_id: number | null;
  env_image_path: string | null;
  location_id: number | null;
  video_path: string | null;
  video_settings_json: string | null;
  character_ids?: number[];
}
export interface BeatRow { id: number; project_id: number; order_index: number; title: string; summary: string | null }
export interface CharacterRow { id: number; project_id: number; name: string; description: string | null; portrait_path: string | null; sheet_path: string | null; consistency_prompt: string | null }
export interface LocationRow { id: number; project_id: number; name: string; description: string | null; env_image_path?: string | null }
export interface ItemRow { id: number; project_id: number; name: string; description: string | null }
export interface StoryBundle { beats: BeatRow[]; characters: CharacterRow[]; locations: LocationRow[]; items: ItemRow[]; [k: string]: unknown }
export interface JobRow { id: number; kind: string; status: string; workflow_id: number | null; error: string | null; retry_count: number; [k: string]: unknown }
export interface WorkflowRow { id: number; name: string; kind: "image" | "video"; is_enabled: boolean; prompt_profile: string; [k: string]: unknown }

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Every route this client can call, as (method, path template). The contract test walks
 * this table against the snapshot, so adding a route that the spec does not carry fails
 * loudly here rather than at runtime in someone's pane.
 */
export const ROUTES = {
  health: ["GET", "/api/health"],
  settingsGet: ["GET", "/api/settings"],
  settingsSet: ["POST", "/api/settings"],
  projectsList: ["GET", "/api/projects"],
  projectsCreate: ["POST", "/api/projects"],
  projectGet: ["GET", "/api/projects/{project_id}"],
  projectPatch: ["PATCH", "/api/projects/{project_id}"],
  projectDelete: ["DELETE", "/api/projects/{project_id}"],
  storyGet: ["GET", "/api/projects/{project_id}/story"],
  beatCreate: ["POST", "/api/projects/{project_id}/beats"],
  beatPatch: ["PATCH", "/api/projects/{project_id}/beats/{beat_id}"],
  beatDelete: ["DELETE", "/api/projects/{project_id}/beats/{beat_id}"],
  characterCreate: ["POST", "/api/projects/{project_id}/characters"],
  characterPatch: ["PATCH", "/api/projects/{project_id}/characters/{character_id}"],
  characterDelete: ["DELETE", "/api/projects/{project_id}/characters/{character_id}"],
  locationCreate: ["POST", "/api/projects/{project_id}/locations"],
  locationPatch: ["PATCH", "/api/projects/{project_id}/locations/{location_id}"],
  locationDelete: ["DELETE", "/api/projects/{project_id}/locations/{location_id}"],
  itemCreate: ["POST", "/api/projects/{project_id}/items"],
  itemPatch: ["PATCH", "/api/projects/{project_id}/items/{item_id}"],
  itemDelete: ["DELETE", "/api/projects/{project_id}/items/{item_id}"],
  scenesList: ["GET", "/api/projects/{project_id}/scenes"],
  sceneCreate: ["POST", "/api/projects/{project_id}/scenes"],
  scenePatch: ["PATCH", "/api/projects/{project_id}/scenes/{scene_id}"],
  sceneDelete: ["DELETE", "/api/projects/{project_id}/scenes/{scene_id}"],
  scenesReorder: ["POST", "/api/projects/{project_id}/scenes/reorder"],
  assetsList: ["GET", "/api/projects/{project_id}/assets"],
  assetsGenerate: ["POST", "/api/projects/{project_id}/generate-assets"],
  workflowsList: ["GET", "/api/workflows"],
  workflowCreate: ["POST", "/api/workflows"],
  workflowGet: ["GET", "/api/workflows/{workflow_id}"],
  workflowPatch: ["PATCH", "/api/workflows/{workflow_id}"],
  workflowDelete: ["DELETE", "/api/workflows/{workflow_id}"],
  workflowAnalyze: ["POST", "/api/workflows/analyze"],
  jobsList: ["GET", "/api/jobs"],
  jobCreate: ["POST", "/api/jobs"],
  jobGet: ["GET", "/api/jobs/{job_id}"],
  jobRetry: ["POST", "/api/jobs/{job_id}/retry"],
  jobCancel: ["POST", "/api/jobs/{job_id}/cancel"],
  queueStatus: ["GET", "/api/jobs/queue-status"],
  queuePause: ["POST", "/api/jobs/pause"],
  queueResume: ["POST", "/api/jobs/resume"],
  videosGenerate: ["POST", "/api/jobs/projects/{project_id}/generate-videos"],
  previewPrompt: ["POST", "/api/jobs/projects/{project_id}/preview-prompt"],
  exportFilm: ["POST", "/api/jobs/projects/{project_id}/export"],
  playgroundGenerate: ["POST", "/api/playground/generate"],
  playgroundAttach: ["POST", "/api/playground/attach"],
  playgroundUploads: ["GET", "/api/playground/uploads"],
  file: ["GET", "/api/file"],
  events: ["GET", "/api/events"],
} as const satisfies Record<string, readonly [Method, string]>;

export type RouteKey = keyof typeof ROUTES;

export class CalliopeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly route: RouteKey,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "CalliopeError";
  }
}

/** Fill `{param}` slots. Throws on a slot left unfilled — a literal `{scene_id}` in a URL is a 404 that looks like a real one. */
export function fillRoute(template: string, params: Record<string, string | number> = {}): string {
  const out = template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`route ${template}: missing {${k}}`);
    return encodeURIComponent(String(v));
  });
  return out;
}

/**
 * The stale-detection fingerprint `video_agent._scene_prompt_hash` computes:
 * sha256("heading|action|dialog|duration_sec|location_id" + "|" + sorted character ids),
 * first 16 hex chars. A draft whose `based_on` does not equal this is treated as stale and
 * Calliope calls its own LLM anyway — so a writer that forgets this has not taken over.
 * Async because it goes through WebCrypto (available in browsers and Node 20+).
 */
export async function scenePromptHash(scene: Pick<SceneRow, "heading" | "action" | "dialog" | "duration_sec" | "location_id" | "character_ids">): Promise<string> {
  const basis = ["heading", "action", "dialog", "duration_sec", "location_id"]
    .map((k) => String((scene as Record<string, unknown>)[k] ?? ""))
    .join("|");
  const chars = [...(scene.character_ids ?? [])].sort((a, b) => a - b).join(",");
  const bytes = new TextEncoder().encode(`${basis}|${chars}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export class CalliopeClient {
  constructor(private readonly config: CalliopeConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** A URL the pane can put in an <img>/<video> for a file Calliope produced. */
  fileUrl(path: string): string {
    return `${this.config.baseUrl}${ROUTES.file[1]}?path=${encodeURIComponent(path)}`;
  }

  async request<T = unknown>(
    key: RouteKey,
    opts: { params?: Record<string, string | number>; query?: Record<string, string | number | boolean | undefined>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const [method, template] = ROUTES[key];
    let url = `${this.config.baseUrl}${fillRoute(template, opts.params)}`;
    if (opts.query) {
      const qs = Object.entries(opts.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      if (qs) url += `?${qs}`;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? this.config.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: abort.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body: keep the text */
      }
      if (!res.ok) {
        const detail = (parsed as { detail?: unknown } | null)?.detail;
        throw new CalliopeError(`Calliope ${method} ${template} → ${res.status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`, res.status, key, parsed);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── projects & settings ──────────────────────────────────────────────────────
  readonly projects = {
    list: () => this.request<Schemas["Project"][]>("projectsList"),
    create: (body: Schemas["ProjectCreate"]) => this.request<Schemas["Project"]>("projectsCreate", { body }),
    get: (project_id: number) => this.request<Schemas["Project"] & Record<string, unknown>>("projectGet", { params: { project_id } }),
    patch: (project_id: number, body: Schemas["ProjectUpdate"]) => this.request<Schemas["Project"]>("projectPatch", { params: { project_id }, body }),
    delete: (project_id: number) => this.request<unknown>("projectDelete", { params: { project_id } }),
  };
  readonly settings = {
    get: () => this.request<Record<string, unknown>>("settingsGet"),
    set: (body: Schemas["SettingsUpdate"]) => this.request<Record<string, unknown>>("settingsSet", { body }),
  };

  // ── story: beats / characters / locations / items ────────────────────────────
  readonly story = {
    get: (project_id: number) => this.request<StoryBundle>("storyGet", { params: { project_id } }),
    beat: {
      create: (project_id: number, body: Schemas["BeatCreate"]) => this.request<BeatRow>("beatCreate", { params: { project_id }, body }),
      patch: (project_id: number, beat_id: number, body: Schemas["BeatUpdate"]) => this.request<BeatRow>("beatPatch", { params: { project_id, beat_id }, body }),
      delete: (project_id: number, beat_id: number) => this.request<unknown>("beatDelete", { params: { project_id, beat_id } }),
    },
    character: {
      create: (project_id: number, body: Schemas["CharacterCreate"]) => this.request<CharacterRow>("characterCreate", { params: { project_id }, body }),
      patch: (project_id: number, character_id: number, body: Schemas["CharacterUpdate"]) => this.request<CharacterRow>("characterPatch", { params: { project_id, character_id }, body }),
      delete: (project_id: number, character_id: number) => this.request<unknown>("characterDelete", { params: { project_id, character_id } }),
    },
    location: {
      create: (project_id: number, body: Schemas["LocationCreate"]) => this.request<LocationRow>("locationCreate", { params: { project_id }, body }),
      patch: (project_id: number, location_id: number, body: Schemas["LocationUpdate"]) => this.request<LocationRow>("locationPatch", { params: { project_id, location_id }, body }),
      delete: (project_id: number, location_id: number) => this.request<unknown>("locationDelete", { params: { project_id, location_id } }),
    },
    item: {
      create: (project_id: number, body: Schemas["ItemCreate"]) => this.request<ItemRow>("itemCreate", { params: { project_id }, body }),
      patch: (project_id: number, item_id: number, body: Schemas["ItemUpdate"]) => this.request<ItemRow>("itemPatch", { params: { project_id, item_id }, body }),
      delete: (project_id: number, item_id: number) => this.request<unknown>("itemDelete", { params: { project_id, item_id } }),
    },
  };

  // ── scenes ───────────────────────────────────────────────────────────────────
  readonly scenes = {
    list: (project_id: number) => this.request<SceneRow[]>("scenesList", { params: { project_id } }),
    create: (project_id: number, body: Schemas["SceneCreate"]) => this.request<SceneRow>("sceneCreate", { params: { project_id }, body }),
    patch: (project_id: number, scene_id: number, body: Schemas["SceneUpdate"]) => this.request<SceneRow>("scenePatch", { params: { project_id, scene_id }, body }),
    delete: (project_id: number, scene_id: number) => this.request<unknown>("sceneDelete", { params: { project_id, scene_id } }),
    reorder: (project_id: number, body: Schemas["SceneReorder"]) => this.request<unknown>("scenesReorder", { params: { project_id }, body }),
  };

  // ── workflows ────────────────────────────────────────────────────────────────
  readonly workflows = {
    list: () => this.request<WorkflowRow[]>("workflowsList"),
    get: (workflow_id: number) => this.request<WorkflowRow & Record<string, unknown>>("workflowGet", { params: { workflow_id } }),
    create: (body: Schemas["WorkflowCreate"]) => this.request<WorkflowRow>("workflowCreate", { body }),
    patch: (workflow_id: number, body: Schemas["WorkflowUpdate"]) => this.request<WorkflowRow>("workflowPatch", { params: { workflow_id }, body }),
    delete: (workflow_id: number) => this.request<unknown>("workflowDelete", { params: { workflow_id } }),
    analyze: (body: Schemas["WorkflowAnalyze"]) => this.request<Record<string, unknown>>("workflowAnalyze", { body }),
  };

  // ── render: jobs, queue, export ──────────────────────────────────────────────
  readonly jobs = {
    list: (query?: { project_id?: number; status?: string; limit?: number }) => this.request<JobRow[]>("jobsList", { query }),
    get: (job_id: number) => this.request<JobRow>("jobGet", { params: { job_id } }),
    create: (body: Schemas["JobCreate"]) => this.request<JobRow>("jobCreate", { body }),
    retry: (job_id: number) => this.request<JobRow>("jobRetry", { params: { job_id } }),
    cancel: (job_id: number) => this.request<JobRow>("jobCancel", { params: { job_id } }),
    queueStatus: () => this.request<Record<string, unknown>>("queueStatus"),
    pause: () => this.request<Record<string, unknown>>("queuePause"),
    resume: () => this.request<Record<string, unknown>>("queueResume"),
    generateVideos: (project_id: number, body: Schemas["GenerateVideosRequest"]) => this.request<Record<string, unknown>>("videosGenerate", { params: { project_id }, body }),
    previewPrompt: (project_id: number, body: Schemas["PreviewPromptRequest"]) => this.request<Record<string, unknown>>("previewPrompt", { params: { project_id }, body }),
    exportFilm: (project_id: number) => this.request<Record<string, unknown>>("exportFilm", { params: { project_id } }),
  };
  readonly assets = {
    list: (project_id: number) => this.request<Record<string, unknown>>("assetsList", { params: { project_id } }),
    generate: (project_id: number, body: Schemas["GenerateAssetsRequest"]) => this.request<Record<string, unknown>>("assetsGenerate", { params: { project_id }, body }),
  };
  readonly playground = {
    generate: (body: Schemas["PlaygroundGenerate"]) => this.request<Record<string, unknown>>("playgroundGenerate", { body }),
    attach: (body: Schemas["PlaygroundAttach"]) => this.request<Record<string, unknown>>("playgroundAttach", { body }),
    uploads: () => this.request<unknown[]>("playgroundUploads"),
  };

  /**
   * Write OUR prompt for a scene so Calliope's own model never runs for it.
   *
   * Calliope's precedence is explicit request → saved (fresh) draft → LLM. This stores the
   * draft together with the freshness hash it will be checked against. Any later edit to the
   * scene's text, duration, location or characters invalidates it — re-author or clear it.
   */
  async promptDraft(project_id: number, scene: SceneRow, prompt: string): Promise<SceneRow> {
    const based_on = await scenePromptHash(scene);
    let settings: Record<string, unknown> = {};
    try {
      settings = scene.video_settings_json ? (JSON.parse(scene.video_settings_json) as Record<string, unknown>) : {};
    } catch {
      settings = {};
    }
    const video_settings = { ...settings, prompt_draft: prompt, prompt_draft_meta: { based_on, authored_by: "benjidirector" } };
    return this.scenes.patch(project_id, scene.id, { video_settings } as unknown as Schemas["SceneUpdate"]);
  }
}
