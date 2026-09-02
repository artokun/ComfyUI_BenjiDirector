// Live Calliope state: jobs, progress, connection.
//
// One module-level store (`jobsStore`), read through `useJobs()` with useSyncExternalStore so
// every scene badge, the job strip and the queue panel see the same snapshot. It is fed two
// ways, both of which Calliope's own web UI uses:
//
//   1. the SSE stream at /api/events (`subscribeEvents`), for progress ticks and the terminal
//      transitions the moment they happen;
//   2. a 5 s poll of `jobs.list({project_id})` + `jobs.queueStatus()` — the fallback when the
//      stream is down, and the source of truth for the rows themselves. Any `job.*` /
//      `asset.ready` event also refetches at once, because an event carries the job id but
//      not the row (an image `job.created` does not even carry the project id).
//
// The progress rules are ported from Calliope's `calliope-web/src/lib/jobProgress.ts`:
// `job.progress` from the queue worker carries NO job id and NO percent (only the export
// runner sends `percent`), so a tick is attributed to the single running job, else the most
// recently started one, and a synthetic value approaches 95 asymptotically. Only
// `job.completed` reports 100. Terminal entries linger (done 6 s, failed 10 s) so the UI can
// flash the final state before the polled rows take over again.
//
// The shapes below are the contract every consumer codes against; the bodies are the unit.

import { useEffect, useRef, useSyncExternalStore } from "react";
import { subscribeEvents, type CalliopeEvent, type EventSubscription, type JobRow, type SceneRow, type StoryBundle } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.js";
import { parseTime } from "./time.js";

export type ConnectionState = "closed" | "connecting" | "open" | "reconnecting";

export interface JobProgress {
  /** 0–100; capped at 95 until completion when the backend sends no percentage. */
  pct: number;
  /** Last human message from the job (e.g. "Waiting on ComfyUI…"). */
  message?: string;
  /** Terminal error, kept briefly after `job.failed`. */
  error?: string;
}

export interface JobsState {
  jobs: JobRow[];
  byId: Map<number, JobRow>;
  progress: Map<number, JobProgress>;
  connection: ConnectionState;
  paused: boolean;
  /** Ids of jobs currently `running`. */
  running: number[];
  /** Ids of jobs currently `pending`. */
  queued: number[];
}

export const EMPTY_JOBS: JobsState = {
  jobs: [],
  byId: new Map(),
  progress: new Map(),
  connection: "closed",
  paused: false,
  running: [],
  queued: [],
};

/** Tunables. Exported so the tests pin the numbers rather than re-deriving them. */
export const LIVE = {
  /** Synthesized ticks never exceed this; only `job.completed` reports 100. */
  TICK_CAP: 95,
  /** How much of the remaining distance to the cap one synthetic tick covers. */
  TICK_STEP: 0.08,
  DONE_KEEP_MS: 6_000,
  FAILED_KEEP_MS: 10_000,
  POLL_MS: 5_000,
  REFRESH_DEBOUNCE_MS: 400,
  /** A progress entry with no row behind it is forgotten after this long. */
  STALE_ENTRY_MS: 30_000,
} as const;

/** Build a snapshot from rows. Pure — `projectToGraph` uses it to stamp `renderStatus` at load. */
export function jobsStateFrom(rows: JobRow[], extra: Partial<Pick<JobsState, "progress" | "connection" | "paused">> = {}): JobsState {
  const byId = new Map<number, JobRow>();
  const running: number[] = [];
  const queued: number[] = [];
  for (const j of rows) {
    byId.set(j.id, j);
    if (j.status === "running") running.push(j.id);
    else if (j.status === "pending") queued.push(j.id);
  }
  return { jobs: rows, byId, progress: extra.progress ?? new Map(), connection: extra.connection ?? "closed", paused: extra.paused ?? false, running, queued };
}

// ── payload readers (the SSE data is `dict[str, Any]`; be forgiving, never throw) ──
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
/** Numeric progress from a payload (`percent` | `progress` | `value`, 0–1 or 0–100), capped below 100. */
export function progressValue(d: Record<string, unknown>): number | null {
  const raw = num(d.percent ?? d.progress ?? d.value);
  if (raw === null) return null;
  const pct = raw <= 1 ? raw * 100 : raw;
  return Math.min(LIVE.TICK_CAP, Math.max(0, pct));
}
/** Asymptotic approach to the cap — feels live, never falsely completes. */
export function synthesize(prev: number): number {
  return prev + (LIVE.TICK_CAP - prev) * LIVE.TICK_STEP;
}


/** ms since epoch, or null. One reading, shared with the queue panel and the render drawer. */
export { parseTime };

/** What the store needs from a client. Structural, so a test can hand it two functions. */
export interface JobsSource {
  baseUrl?: string;
  jobs: {
    list(query?: { project_id?: number; status?: string; limit?: number }): Promise<JobRow[]>;
    queueStatus(): Promise<Record<string, unknown>>;
  };
}

interface Entry extends JobProgress {
  final: boolean;
  updatedAt: number;
}

interface Session {
  client: JobsSource;
  projectId: number;
  gen: number;
  sub: EventSubscription | null;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  dirty: boolean;
}

/** The fields a poll is allowed to differ on before the rows count as changed. */
function rowKey(j: JobRow): string {
  return `${j.id}|${j.status}|${j.error ?? ""}|${j.started_at ?? ""}|${j.completed_at ?? ""}|${j.retry_count}|${(j.output_paths ?? []).join(",")}|${j.scene_id ?? ""}`;
}
function rowsEqual(a: JobRow[], b: JobRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || rowKey(x) !== rowKey(y)) return false;
  }
  return true;
}

export class JobsStore {
  private rows: JobRow[] = [];
  private entries = new Map<number, Entry>();
  /** Jobs seen running (via `job.started` or a polled row) and not yet terminal — tick attribution. */
  private running = new Set<number>();
  private lastStarted: number | null = null;
  private cleanup = new Map<number, ReturnType<typeof setTimeout>>();
  private connection: ConnectionState = "closed";
  private paused = false;
  private snap: JobsState = EMPTY_JOBS;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: CalliopeEvent) => void>();
  private session: Session | null = null;
  private gen = 0;

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  readonly getSnapshot = (): JobsState => this.snap;

  /** Every event the stream delivers, after the store has applied it. */
  onEvent(cb: (e: CalliopeEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  get active(): boolean {
    return this.session !== null;
  }

  /**
   * Follow one project: poll now and every 5 s, and open the event stream when the client
   * names a base URL. Calling again for the same client + project is a no-op; for another
   * project it stops the old session first (its rows are another film's).
   */
  start(opts: { client: JobsSource; projectId: number; events?: boolean }): void {
    const cur = this.session;
    if (cur && cur.client === opts.client && cur.projectId === opts.projectId) return;
    this.stop();
    const s: Session = { client: opts.client, projectId: opts.projectId, gen: ++this.gen, sub: null, timer: null, inFlight: false, dirty: false };
    this.session = s;
    void this.pollNow();
    s.timer = setInterval(() => void this.pollNow(), LIVE.POLL_MS);
    const baseUrl = opts.client.baseUrl;
    if ((opts.events ?? true) && baseUrl) {
      this.setConnection("connecting");
      s.sub = subscribeEvents(
        baseUrl,
        (e) => {
          if (this.session === s) this.handleEvent(e);
        },
        (state) => {
          if (this.session === s) this.setConnection(state);
        },
      );
    } else {
      this.setConnection("closed");
    }
  }

  /** Stop following. Clears everything — a project switch must not show the previous film's queue. */
  stop(): void {
    const s = this.session;
    if (s) {
      this.session = null;
      if (s.timer) clearInterval(s.timer);
      s.sub?.close();
    }
    for (const t of this.cleanup.values()) clearTimeout(t);
    this.cleanup.clear();
    const dirty = s !== null || this.rows.length > 0 || this.entries.size > 0 || this.connection !== "closed" || this.paused;
    this.rows = [];
    this.entries.clear();
    this.running.clear();
    this.lastStarted = null;
    this.connection = "closed";
    this.paused = false;
    if (dirty) this.emit();
  }

  /** Refetch the rows now. One request in flight at a time; a second ask re-polls after it lands. */
  async pollNow(): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (s.inFlight) {
      s.dirty = true;
      return;
    }
    s.inFlight = true;
    try {
      const [rows, qs] = await Promise.all([s.client.jobs.list({ project_id: s.projectId }), s.client.jobs.queueStatus().catch(() => null)]);
      // The session can have been swapped while this was in flight — those rows are another
      // film's, and applying them would show the previous project's queue under the new one.
      if (this.session !== s) return;
      this.applyRows(Array.isArray(rows) ? rows : [], qs && typeof qs === "object" ? !!(qs as { paused?: unknown }).paused : undefined);
    } catch {
      /* keep the last known rows; the next tick retries */
    } finally {
      if (this.session === s) {
        s.inFlight = false;
        if (s.dirty) {
          s.dirty = false;
          void this.pollNow();
        }
      }
    }
  }

  setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit();
  }

  /** The polled rows are the truth for status; the running set follows them for attribution. */
  applyRows(rows: JobRow[], paused?: boolean): void {
    let changed = false;
    if (!rowsEqual(this.rows, rows)) {
      this.rows = rows;
      changed = true;
    }
    if (paused !== undefined && paused !== this.paused) {
      this.paused = paused;
      changed = true;
    }
    const byId = new Map(rows.map((j) => [j.id, j] as const));
    for (const j of rows) if (j.status === "running") this.running.add(j.id);
    for (const id of [...this.running]) {
      const row = byId.get(id);
      if (row && row.status !== "running") this.running.delete(id);
    }
    if (this.lastStarted !== null && !this.running.has(this.lastStarted)) this.lastStarted = null;
    const now = Date.now();
    for (const [id, e] of this.entries) {
      if (!byId.has(id) && !this.cleanup.has(id) && now - e.updatedAt > LIVE.STALE_ENTRY_MS) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Apply one stream event. Safe for every kind; a kind the store does not model only refetches. */
  handleEvent(e: CalliopeEvent): void {
    const d = e.data ?? {};
    const now = Date.now();
    let changed = false;
    switch (e.kind) {
      case "job.created": {
        const id = num(d.job_id);
        if (id === null) break;
        this.cancelCleanup(id);
        this.entries.set(id, { pct: 0, message: str(d.message) || "Queued", final: false, updatedAt: now });
        changed = true;
        break;
      }
      case "job.started": {
        const id = num(d.job_id);
        if (id === null) break;
        this.cancelCleanup(id);
        this.running.add(id);
        this.lastStarted = id;
        const prev = this.entries.get(id);
        this.entries.set(id, { pct: prev?.pct ?? 0, message: str(d.message) || "Running", final: false, updatedAt: now });
        this.patchRow(id, (j) => (j.status === "running" ? j : { ...j, status: "running", started_at: j.started_at ?? new Date(now).toISOString() }));
        changed = true;
        break;
      }
      case "job.progress": {
        const id = this.resolveJobId(d);
        if (id === null) break;
        const prev = this.entries.get(id);
        const pct = progressValue(d) ?? synthesize(prev?.pct ?? 0);
        const message = str(d.message) || prev?.message;
        this.entries.set(id, { pct, ...(message ? { message } : {}), final: false, updatedAt: now });
        changed = true;
        break;
      }
      case "job.completed": {
        const id = num(d.job_id);
        if (id === null) break;
        this.running.delete(id);
        if (this.lastStarted === id) this.lastStarted = null;
        const prev = this.entries.get(id);
        const message = str(d.message) || prev?.message;
        this.entries.set(id, { pct: 100, ...(message ? { message } : {}), final: true, updatedAt: now });
        this.scheduleCleanup(id, LIVE.DONE_KEEP_MS);
        const outputs = Array.isArray(d.outputs) ? d.outputs.filter((p): p is string => typeof p === "string") : null;
        this.patchRow(id, (j) => ({ ...j, status: "done", error: null, completed_at: j.completed_at ?? new Date(now).toISOString(), output_paths: outputs ?? j.output_paths }));
        changed = true;
        break;
      }
      case "job.failed": {
        const id = num(d.job_id);
        if (id === null) break;
        this.running.delete(id);
        if (this.lastStarted === id) this.lastStarted = null;
        const prev = this.entries.get(id);
        const error = str(d.error) || str(d.message) || "failed";
        const message = str(d.message) || prev?.message;
        this.entries.set(id, { pct: prev?.pct ?? 0, ...(message ? { message } : {}), error, final: true, updatedAt: now });
        this.scheduleCleanup(id, LIVE.FAILED_KEEP_MS);
        this.patchRow(id, (j) => ({ ...j, status: "failed", error: str(d.error) || j.error, completed_at: j.completed_at ?? new Date(now).toISOString() }));
        changed = true;
        break;
      }
      case "job.deleted": {
        const id = num(d.job_id);
        if (id === null) break;
        this.running.delete(id);
        if (this.lastStarted === id) this.lastStarted = null;
        this.cancelCleanup(id);
        // Only a real removal is a change: emitting for an id this store never held would
        // hand every scene badge a fresh snapshot to re-render for nothing.
        const had = this.entries.delete(id);
        const rest = this.rows.filter((j) => j.id !== id);
        if (rest.length !== this.rows.length) {
          this.rows = rest;
          changed = true;
        }
        if (had) changed = true;
        break;
      }
      default:
        break;
    }
    if (changed) this.emit();
    // The row is the truth and the event is only a hint that it moved: refetch at once.
    if (e.kind.startsWith("job.") || e.kind === "asset.ready") void this.pollNow();
    for (const cb of this.eventListeners) cb(e);
  }

  /**
   * Today's `job.progress` payload is {prompt_id, message} with no job id. Attribute the tick
   * to the only running job, else the most recently started one. Explicit `job_id` wins.
   */
  private resolveJobId(d: Record<string, unknown>): number | null {
    const explicit = num(d.job_id);
    if (explicit !== null) return explicit;
    if (this.running.size === 1) return [...this.running][0] ?? null;
    if (this.lastStarted !== null && this.running.has(this.lastStarted)) return this.lastStarted;
    return null;
  }

  private patchRow(id: number, fn: (j: JobRow) => JobRow): void {
    const i = this.rows.findIndex((j) => j.id === id);
    const cur = i < 0 ? undefined : this.rows[i];
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    const rows = [...this.rows];
    rows[i] = next;
    this.rows = rows;
  }

  private scheduleCleanup(id: number, delayMs: number): void {
    this.cancelCleanup(id);
    this.cleanup.set(
      id,
      setTimeout(() => {
        this.cleanup.delete(id);
        if (this.entries.delete(id)) this.emit();
      }, delayMs),
    );
  }
  private cancelCleanup(id: number): void {
    const t = this.cleanup.get(id);
    if (t) {
      clearTimeout(t);
      this.cleanup.delete(id);
    }
  }

  private emit(): void {
    const progress = new Map<number, JobProgress>();
    for (const [id, e] of this.entries) progress.set(id, { pct: e.pct, ...(e.message ? { message: e.message } : {}), ...(e.error ? { error: e.error } : {}) });
    this.snap = jobsStateFrom(this.rows, { progress, connection: this.connection, paused: this.paused });
    for (const l of this.listeners) l();
  }
}

/** The one store the pane runs on. */
export const jobsStore = new JobsStore();

const serverSnapshot = () => EMPTY_JOBS;

/** The jobs of the loaded project, live. */
export function useJobs(): JobsState {
  return useSyncExternalStore(jobsStore.subscribe, jobsStore.getSnapshot, serverSnapshot);
}

/**
 * Drive the store from the editor: follow the loaded project while Calliope is reachable, push
 * its rows into the context (`setJobs`) so every panel sees one list, and re-read the project
 * (debounced) when a job lands so a scene's `video_path` and asset images reach the canvas.
 * Mounted once, by `LiveBridge`.
 */
export function useLiveJobs(): JobsState {
  const { client, status, projectId, setJobs, refresh } = useDirector();
  const reachable = !!status?.reachable;
  const refs = useRef({ setJobs, refresh });
  refs.current = { setJobs, refresh };

  useEffect(() => {
    if (!reachable || projectId === null) {
      jobsStore.stop();
      return undefined;
    }
    jobsStore.start({ client, projectId });
    return () => jobsStore.stop();
  }, [client, projectId, reachable]);

  useEffect(() => {
    let last: JobRow[] | null = null;
    const push = () => {
      const s = jobsStore.getSnapshot();
      if (s.jobs === last) return;
      last = s.jobs;
      refs.current.setJobs?.(s.jobs);
    };
    push();
    const unsubscribe = jobsStore.subscribe(push);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = jobsStore.onEvent((e) => {
      if (e.kind !== "job.completed" && e.kind !== "job.failed" && e.kind !== "asset.ready") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refs.current.refresh().catch(() => undefined);
      }, LIVE.REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return useJobs();
}

/** Renders nothing; exists so `useLiveJobs` has a mount point in a slot. */
export function LiveBridge(): null {
  useLiveJobs();
  return null;
}

/** Progress for one job, if any is known. */
export function progressFor(state: JobsState, jobId: number): JobProgress | undefined {
  return state.progress.get(jobId);
}

/** Latest job of a kind for a scene (video) or an entity (image), newest first. */
export function latestJob(state: JobsState, pick: (j: JobRow) => boolean): JobRow | undefined {
  let best: JobRow | undefined;
  for (const j of state.jobs) if (pick(j) && (!best || j.id > best.id)) best = j;
  return best;
}

export type RenderStatus = "queued" | "rendering" | "failed" | "rendered" | null;

/**
 * Scene render status from its latest video job (and whether a clip exists). A finished job
 * that produced a file counts as rendered even before the re-read lands `video_path`.
 */
export function renderStatusOf(state: JobsState, sceneId: number, hasClip: boolean): RenderStatus {
  const j = latestJob(state, (x) => x.kind === "video" && x.scene_id === sceneId);
  if (j?.status === "pending") return "queued";
  if (j?.status === "running") return "rendering";
  if (j?.status === "failed") return "failed";
  if (hasClip) return "rendered";
  if (j?.status === "done" && (j.output_paths?.length ?? 0) > 0) return "rendered";
  return null;
}

/** The job the strip should show: the running one (the most recently started when several). */
export function currentJobOf(state: JobsState): JobRow | undefined {
  let best: JobRow | undefined;
  let bestAt: number | null = null;
  for (const id of state.running) {
    const j = state.byId.get(id);
    if (!j) continue;
    const at = parseTime(j.started_at);
    if (!best) {
      best = j;
      bestAt = at;
      continue;
    }
    // A usable start time beats an unusable one; two of them compare as INSTANTS, never as
    // text; with neither (or a tie) the id decides, being monotonic in creation order.
    const newer = at !== null && bestAt !== null ? (at === bestAt ? j.id > best.id : at > bestAt) : at !== null ? true : bestAt !== null ? false : j.id > best.id;
    if (newer) {
      best = j;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The failure worth showing: the newest failed job that has not been superseded by a newer job
 * for the same target (a retry mints a new row; an old failure must not outlive its fix).
 */
export function lastFailureOf(state: JobsState): { job: JobRow; error: string } | undefined {
  let best: JobRow | undefined;
  for (const j of state.jobs) if (j.status === "failed" && (!best || j.id > best.id)) best = j;
  if (!best) return undefined;
  const failed = best;
  const target = jobTarget(failed);
  if (target && state.jobs.some((j) => j.id > failed.id && jobTarget(j) === target)) return undefined;
  const live = state.progress.get(failed.id)?.error;
  return { job: failed, error: live || failed.error || "failed" };
}

/** The most recently finished job while its entry is still pinned at 100. */
export function recentlyDoneOf(state: JobsState): JobRow | undefined {
  let best: JobRow | undefined;
  for (const [id, p] of state.progress) {
    if (p.pct !== 100 || p.error) continue;
    const j = state.byId.get(id);
    if (j && (!best || j.id > best.id)) best = j;
  }
  return best;
}

function jobTarget(j: JobRow): string | null {
  if (j.scene_id !== null && j.scene_id !== undefined) return `scene:${j.scene_id}`;
  const p = j.payload ?? {};
  for (const k of ["character_id", "location_id", "item_id"] as const) {
    const v = num(p[k]);
    if (v !== null) return `${k}:${v}`;
  }
  if (j.kind === "export") return `export:${j.project_id ?? ""}`;
  return null;
}

/** What Calliope's worker calls the job (`_job_label`), rebuilt from the rows we already hold. */
export function jobLabel(j: JobRow, ctx: { scenes?: SceneRow[]; story?: StoryBundle | null } = {}): string {
  if (j.kind === "export") return "Export film";
  const p = j.payload ?? {};
  const name = (rows: Array<{ id: number; name: string }> | undefined, id: number) => rows?.find((r) => r.id === id)?.name ?? `#${id}`;
  const cid = num(p.character_id);
  if (cid !== null) return `${name(ctx.story?.characters, cid)} · ${str(p.asset_target) || "sheet"}`;
  const lid = num(p.location_id);
  if (lid !== null) return `${name(ctx.story?.locations, lid)} · environment`;
  const iid = num(p.item_id);
  if (iid !== null) return `${name(ctx.story?.items, iid)} · item`;
  if (j.scene_id !== null && j.scene_id !== undefined) {
    const sc = ctx.scenes?.find((s) => s.id === j.scene_id);
    if (sc) return `Scene · ${(sc.heading || `Scene ${sc.order_index + 1}`).trim()}`;
    return `Scene #${j.scene_id}`;
  }
  return `${j.kind} #${j.id}`;
}
