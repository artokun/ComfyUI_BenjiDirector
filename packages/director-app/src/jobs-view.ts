// Pure view logic behind the Queue panel and the film Export card: labels, status chips,
// sort/filter, relative times, the export state machine and the event-log formatter.
//
// No React, no fetch — everything here is a function of rows, so it is unit-tested directly
// and the components stay thin. Ported from what Calliope's own ActivityPanel / JobRow /
// QueueStage (film view) do, so the pane reads the same way its frontend does.
//
// Timestamps: Calliope's rows carry SQLite `CURRENT_TIMESTAMP` strings ("2026-09-01 10:00:00"),
// which are UTC with NO zone marker. `Date.parse` reads such a string as LOCAL time and puts
// every "3m ago" off by the zone offset, so `parseTime` pins a zoneless stamp to UTC.

import type { JobRow, SceneRow, StoryBundle } from "@benjidirector/calliope-client";
import type { IconName } from "./icons.js";

// ── kinds ────────────────────────────────────────────────────────────────────

export function kindIcon(kind: string): IconName {
  switch (kind) {
    case "image":
      return "image";
    case "video":
      return "film";
    case "export":
      return "clapper";
    default:
      return "clock";
  }
}

export function kindLabel(kind: string): string {
  if (kind === "export") return "Export film";
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Job";
}

const asId = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * What a row is FOR, in the user's words: the scene it renders, the entity it draws, or
 * "Export film". Falls back to "Kind #id" for a row whose subject is not in the loaded project
 * (the "all projects" view) or that carries no subject at all.
 */
export function labelFor(job: JobRow, story: StoryBundle | null, scenes: SceneRow[]): string {
  if (job.kind === "export") return "Export film";
  // The "all projects" scope shows rows this project's story cannot explain. Scene and entity
  // ids restart per project, so resolving a foreign row against these rows would not fail — it
  // would confidently name the WRONG scene. Refuse rather than guess.
  if (story && job.project_id != null && job.project_id !== story.project.id) return `${kindLabel(job.kind)} #${job.id}`;
  if (job.scene_id != null) {
    const sc = scenes.find((s) => s.id === job.scene_id);
    if (sc) return sc.heading?.trim() || `Scene ${sc.order_index + 1}`;
  }
  const p = (job.payload ?? {}) as Record<string, unknown>;
  const cid = asId(p.character_id);
  if (cid != null) {
    const c = story?.characters.find((x) => x.id === cid);
    if (c?.name) return c.name;
  }
  const lid = asId(p.location_id);
  if (lid != null) {
    const l = story?.locations.find((x) => x.id === lid);
    if (l?.name) return l.name;
  }
  const iid = asId(p.item_id);
  if (iid != null) {
    const it = story?.items.find((x) => x.id === iid);
    if (it?.name) return it.name;
  }
  return `${kindLabel(job.kind)} #${job.id}`;
}

// ── time ─────────────────────────────────────────────────────────────────────

const ZONELESS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** ms since epoch, or null. A zoneless "YYYY-MM-DD HH:MM:SS" is SQLite's UTC, not local time. */
export function parseTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = ZONELESS.exec(s.trim());
  const t = m ? Date.parse(`${m[1]}T${m[2]}Z`) : Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Calliope's compact style: "just now", "3m ago", "2h ago", "4d ago", "2mo ago", "1y ago". */
export function relativeTime(s: string | null | undefined, now: number = Date.now()): string {
  const then = parseTime(s);
  if (then == null) return "";
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** "m:ss" */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

// ── status ───────────────────────────────────────────────────────────────────

export type ChipTone = "" | "ok" | "warn" | "err" | "info";
export interface StatusChip {
  tone: ChipTone;
  label: string;
}

export const isActive = (job: Pick<JobRow, "status">): boolean => job.status === "pending" || job.status === "running";

/**
 * A failed row is not always a failure: the queue manager writes `cancelled` when the user
 * stops a job and `superseded by new export` when a re-export replaces a pending one. Those
 * are the user's own doing and read as warnings, not errors.
 */
export function statusChip(job: Pick<JobRow, "status" | "error">): StatusChip {
  switch (job.status) {
    case "pending":
      return { tone: "", label: "pending" };
    case "running":
      return { tone: "info", label: "running" };
    case "done":
      return { tone: "ok", label: "done" };
    case "failed": {
      const err = (job.error ?? "").trim().toLowerCase();
      if (err === "cancelled") return { tone: "warn", label: "cancelled" };
      if (err.startsWith("superseded")) return { tone: "warn", label: "superseded" };
      return { tone: "err", label: "failed" };
    }
    default:
      return { tone: "", label: job.status || "unknown" };
  }
}

export interface QueueStats {
  running: number;
  queued: number;
  done: number;
  failed: number;
}

export function queueStats(jobs: JobRow[]): QueueStats {
  const s: QueueStats = { running: 0, queued: 0, done: 0, failed: 0 };
  for (const j of jobs) {
    if (j.status === "running") s.running += 1;
    else if (j.status === "pending") s.queued += 1;
    else if (j.status === "done") s.done += 1;
    else if (j.status === "failed") s.failed += 1;
  }
  return s;
}

export type JobFilter = "all" | "pending" | "running" | "done" | "failed";
export const JOB_FILTERS: readonly JobFilter[] = ["all", "pending", "running", "done", "failed"];

export function filterJobs(jobs: JobRow[], filter: JobFilter): JobRow[] {
  return filter === "all" ? jobs : jobs.filter((j) => j.status === filter);
}

const activeWeight = (j: JobRow): number => (j.status === "running" ? 0 : j.status === "pending" ? 1 : 2);

/** Running first, then queued, then everything else newest-first — Calliope's ActivityPanel order. */
export function sortJobs(jobs: JobRow[]): JobRow[] {
  return [...jobs].sort((a, b) => activeWeight(a) - activeWeight(b) || b.id - a.id);
}

// ── export ───────────────────────────────────────────────────────────────────

export interface ClipsSummary {
  /** Scenes with a clip on disk. */
  ready: number;
  /** Scenes without one — the export skips them. */
  missing: number;
  /** Seconds of the scenes that HAVE a clip: what the exported film will run. */
  clipSec: number;
  /** Seconds of every scene, clip or not. */
  totalSec: number;
}

const sceneSec = (s: SceneRow): number => Math.max(s.duration_sec || 5, 1);

export function clipsSummary(scenes: SceneRow[]): ClipsSummary {
  let ready = 0;
  let clipSec = 0;
  let totalSec = 0;
  for (const s of scenes) {
    const sec = sceneSec(s);
    totalSec += sec;
    if (s.video_path) {
      ready += 1;
      clipSec += sec;
    }
  }
  return { ready, missing: scenes.length - ready, clipSec, totalSec };
}

/** Newest export job, or null. */
export function latestExportJob(jobs: JobRow[]): JobRow | null {
  let best: JobRow | null = null;
  for (const j of jobs) if (j.kind === "export" && (!best || j.id > best.id)) best = j;
  return best;
}

/** A clip finished AFTER the export completed: the film no longer matches the timeline. */
export function isStale(exportJob: JobRow | null | undefined, videoJobs: JobRow[]): boolean {
  if (!exportJob || exportJob.status !== "done") return false;
  const exportedAt = parseTime(exportJob.completed_at);
  if (exportedAt == null) return false;
  return videoJobs.some((j) => {
    if (j.kind !== "video" || j.status !== "done") return false;
    const at = parseTime(j.completed_at);
    return at != null && at > exportedAt;
  });
}

export type ExportStateKind = "idle" | "active" | "ready" | "failed";

export interface ExportView {
  state: ExportStateKind;
  job: JobRow | null;
  /** The mp4 Calliope wrote, when `state` is "ready". */
  path: string | null;
  stale: boolean;
  /** The error text when `state` is "failed". */
  error: string | null;
  clips: ClipsSummary;
  /** ms epoch of the export's completion, when known. */
  exportedAt: number | null;
}

/**
 * The film's state, from the newest export job (as QueueStage's film view derives it):
 * none → idle; pending/running → active; done → ready (stale when a clip landed later);
 * failed (including cancelled / superseded) → failed.
 */
export function exportState(jobs: JobRow[], scenes: SceneRow[]): ExportView {
  const job = latestExportJob(jobs);
  const clips = clipsSummary(scenes);
  let state: ExportStateKind = "idle";
  if (job) {
    if (isActive(job)) state = "active";
    else if (job.status === "done") state = "ready";
    else if (job.status === "failed") state = "failed";
  }
  const outputs = job?.output_paths ?? [];
  const path = state === "ready" ? (outputs.find((p) => /\.mp4$/i.test(p)) ?? outputs[0] ?? null) : null;
  const stale = state === "ready" && isStale(job, jobs);
  const error = state === "failed" ? job?.error?.trim() || "Export failed" : null;
  return { state, job, path, stale, error, clips, exportedAt: parseTime(job?.completed_at) };
}

/** The filename a Download link offers: the project's title, or the export's own name. */
export function downloadName(story: StoryBundle | null, path: string | null): string {
  const title = story?.project.title?.trim();
  if (title) return `${title.replace(/[\\/:*?"<>|]+/g, "-")}.mp4`;
  const base = path?.split(/[\\/]/).pop();
  return base && /\.mp4$/i.test(base) ? base : "film.mp4";
}

// ── event log ────────────────────────────────────────────────────────────────

export type LogTone = "info" | "ok" | "warn" | "err" | "work";

export interface LogEntry {
  key: string;
  ts: string;
  title: string;
  detail: string;
  tone: LogTone;
  kind: string;
}

/** A Calliope event as either the client's `{kind, data, at, ts?}` or the wire's `{type, data, ts}`. */
export interface LogEventLike {
  kind?: string;
  type?: string;
  data?: Record<string, unknown> | null;
  ts?: string;
  at?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

const clock = (ev: LogEventLike): string => {
  if (ev.ts) return ev.ts.includes("T") ? ev.ts.slice(11, 19) : ev.ts.slice(0, 8);
  if (typeof ev.at === "number") {
    const d = new Date(ev.at);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  }
  return "";
};

/** One log line from one event; null for a progress tick (those drive bars, not the log). */
export function formatEvent(ev: LogEventLike, index: number): LogEntry | null {
  const kind = ev.kind ?? ev.type ?? "";
  if (!kind || kind === "job.progress") return null;
  const d = ev.data ?? {};
  const msg = str(d.message).trim();
  const jobKind = str(d.kind);
  const jobId = d.job_id != null ? `#${str(d.job_id)}` : "";
  const err = str(d.error).trim();
  const paths = Array.isArray(d.paths) ? d.paths.length : 0;
  const outputs = Array.isArray(d.outputs) ? d.outputs.length : 0;

  let title = kind;
  let detail = msg;
  let tone: LogTone = "info";
  switch (kind) {
    case "agent.thinking":
      title = "Agent";
      detail = msg || "Working…";
      tone = "work";
      break;
    case "story.ready":
      title = "Story ready";
      detail = msg || "Storyline drafted";
      tone = "ok";
      break;
    case "job.created":
      title = "Queued";
      detail = msg || [jobKind, jobId].filter(Boolean).join(" ");
      break;
    case "job.started":
      title = "Running";
      detail = msg || [jobKind, jobId].filter(Boolean).join(" ");
      tone = "work";
      break;
    case "job.completed":
      title = "Finished";
      detail = msg || [jobKind, jobId, outputs ? `${outputs} file(s)` : ""].filter(Boolean).join(" · ");
      tone = "ok";
      break;
    case "job.failed":
      title = "Failed";
      detail = err || msg || [jobKind, jobId].filter(Boolean).join(" ");
      tone = "err";
      break;
    case "asset.ready":
      title = "Asset ready";
      detail = msg || (paths ? `${paths} file(s) saved` : "Output saved");
      tone = "ok";
      break;
    case "job.deleted":
      title = "Removed";
      detail = msg || jobId || "Job deleted";
      tone = "warn";
      break;
    default:
      title = kind.replace(/\./g, " · ");
      detail = msg || err || jobKind;
  }
  return { key: `${ev.ts ?? ev.at ?? ""}-${kind}-${index}`, ts: clock(ev), title, detail, tone, kind };
}

/** The last 60 non-progress events, consecutive duplicates collapsed, newest first. */
export function logEntries(events: LogEventLike[]): LogEntry[] {
  const raw: LogEntry[] = [];
  const tail = events.slice(-120);
  for (let i = 0; i < tail.length; i += 1) {
    const e = formatEvent(tail[i]!, i);
    if (e) raw.push(e);
  }
  const out: LogEntry[] = [];
  for (const e of raw) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === e.kind && prev.detail === e.detail) continue;
    out.push(e);
  }
  return out.slice(-60).reverse();
}
