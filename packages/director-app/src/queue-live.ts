// Where the Queue panel's rows come from — before and after the live unit lands.
//
// `useJobs()` (live.ts) is the contract: the live unit fills it from Calliope's SSE stream.
// Until it does, the stub reports `connection: "closed"` and no rows, so this module polls
// `GET /api/jobs` every 5 s itself — exactly what Calliope's own frontend does — and hands the
// rows to `setJobs` so the rest of the editor (scene badges, the tab count) sees them too.
// Once the live store is connected, its rows win and this poll goes quiet; only the
// "all projects" scope (which a project-scoped live store cannot supply) keeps polling.
//
// One poller, module-level, refcounted by demand: the toolbar Export button, the Queue panel
// and its Export card all subscribe, and Calliope sees one request per tick.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CalliopeClient, JobRow } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.js";
import { useJobs, type JobsState } from "./live.js";
import type { LogEventLike } from "./jobs-view.js";

export const POLL_MS = 5000;
const LIMIT = 200;

interface PollState {
  /** Rows of `projectId`, or null before the first successful read. */
  project: JobRow[] | null;
  projectId: number | null;
  /** Rows across every project, only while some consumer asks for them. */
  all: JobRow[] | null;
  paused: boolean;
  error: string | null;
}

interface Wiring {
  client: CalliopeClient;
  projectId: number | null;
  /** Calliope answered its health probe; nothing is fetched otherwise. */
  enabled: boolean;
  setJobs?: ((jobs: JobRow[]) => void) | undefined;
}

let state: PollState = { project: null, projectId: null, all: null, paused: false, error: null };
const listeners = new Set<() => void>();
const patch = (p: Partial<PollState>): void => {
  state = { ...state, ...p };
  for (const l of listeners) l();
};

const demand = { project: 0, all: 0 };
let wiring: Wiring | null = null;
/**
 * Bumped only when the SCOPE changes (another project, another client) — never merely because a
 * second consumer mounted and re-ran its effect with the same values. A fetch carries the epoch
 * it was issued under and drops its rows when that no longer matches; keyed on the wiring
 * OBJECT instead, opening the Export popover beside the panel would discard the panel's poll.
 */
let epoch = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let lastFingerprint = "";
/** The loaded project's rows from whichever source is live — read by the tab badge. */
let latestProjectJobs: JobRow[] = [];

const fingerprint = (rows: JobRow[]): string => rows.map((j) => `${j.id}:${j.status}:${j.completed_at ?? ""}:${j.error ?? ""}:${j.retry_count}`).join("|");

async function fetchOnce(w: Wiring, force: boolean, at: number): Promise<void> {
  const wantProject = w.projectId !== null && (force || demand.project > 0);
  const wantAll = demand.all > 0;
  const next: Partial<PollState> = {};
  try {
    const [proj, all, qs] = await Promise.all([
      wantProject ? w.client.jobs.list({ project_id: w.projectId as number, limit: LIMIT }) : Promise.resolve(undefined),
      wantAll ? w.client.jobs.list({ limit: LIMIT }) : Promise.resolve(undefined),
      w.client.jobs.queueStatus().catch(() => undefined),
    ]);
    // Re-scoped while in flight (the project switched): these rows describe the old one.
    if (at !== epoch) return;
    if (proj) {
      next.project = proj;
      next.projectId = w.projectId;
      const fp = fingerprint(proj);
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        w.setJobs?.(proj);
      }
    }
    if (all) next.all = all;
    if (qs && typeof qs.paused === "boolean") next.paused = qs.paused;
    next.error = null;
  } catch (err) {
    if (at !== epoch) return;
    next.error = err instanceof Error ? err.message : String(err);
  }
  patch(next);
}

/**
 * One poll now. `force` reads the loaded project even when nobody is subscribed to it, and
 * never settles for a request that was ALREADY in flight: a refresh issued right after a retry
 * / cancel / export must see the rows as they are after that write, not the ones a tick begun
 * beforehand happens to return.
 */
export function pollNow(force = false): Promise<void> {
  const w = wiring;
  if (!w || !w.enabled) return Promise.resolve();
  if (inflight && !force) return inflight;
  const run = (): Promise<void> => {
    const at = epoch;
    const p: Promise<void> = fetchOnce(w, force, at).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  };
  return inflight ? inflight.then(run, run) : run();
}

function syncTimer(): void {
  const want = !!wiring?.enabled && demand.project + demand.all > 0;
  if (want && timer === null) timer = setInterval(() => void pollNow(), POLL_MS);
  if (!want && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function wire(next: Wiring): void {
  const prev = wiring;
  wiring = next;
  if (prev?.projectId !== next.projectId || prev?.client !== next.client) {
    epoch += 1;
    lastFingerprint = "";
    patch({ project: null, projectId: next.projectId, error: null });
  }
  syncTimer();
  if (next.enabled && (!prev || !prev.enabled || prev.projectId !== next.projectId || prev.client !== next.client)) void pollNow();
}

function acquire(scope: "project" | "all"): void {
  demand[scope] += 1;
  syncTimer();
  void pollNow();
}

function release(scope: "project" | "all"): void {
  demand[scope] = Math.max(0, demand[scope] - 1);
  if (scope === "all" && demand.all === 0) patch({ all: null });
  syncTimer();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const getSnapshot = (): PollState => state;

/** Jobs of the loaded project that are `running` right now — the Queue tab's badge. */
export function runningCount(): number {
  let n = 0;
  for (const j of latestProjectJobs) if (j.status === "running") n += 1;
  return n;
}

export interface QueueView {
  /** Rows in the requested scope: the loaded project, or every project. */
  jobs: JobRow[];
  /** Rows of the loaded project whatever the scope — the export card reads these. */
  projectJobs: JobRow[];
  paused: boolean;
  /** The live store, for `progressFor()`. */
  live: JobsState;
  /** The event log, when the live store exposes one; null otherwise. */
  log: LogEventLike[] | null;
  /** True while the rows shown come from this module's own poll. */
  polling: boolean;
  /** Last poll error, or null. */
  error: string | null;
  /** Re-read now (after a retry / cancel / export). */
  refresh(): Promise<void>;
}

/** Duck-typed: the live unit may add `log` or `events` to JobsState without this module knowing. */
function readLog(live: JobsState): LogEventLike[] | null {
  const bag = live as unknown as { log?: unknown; events?: unknown };
  const candidate = bag.log ?? bag.events;
  return Array.isArray(candidate) ? (candidate as LogEventLike[]) : null;
}

/**
 * The jobs a queue view should show. `all: true` widens the scope to every project (always
 * polled — the live store is per-project by contract).
 */
export function useQueueJobs(opts: { all?: boolean } = {}): QueueView {
  const ctx = useDirector();
  const live = useJobs();
  const liveOn = live.connection !== "closed";
  const enabled = ctx.status?.reachable === true;
  const wantAll = !!opts.all;
  const wantProject = !liveOn;
  const { client, projectId, setJobs } = ctx;

  useEffect(() => {
    wire({ client, projectId, enabled, setJobs });
  }, [client, projectId, enabled, setJobs]);

  useEffect(() => {
    if (!wantProject) return undefined;
    acquire("project");
    return () => release("project");
  }, [wantProject]);

  useEffect(() => {
    if (!wantAll) return undefined;
    acquire("all");
    return () => release("all");
  }, [wantAll]);

  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const polledProject = snap.projectId === projectId ? snap.project : null;
  const projectJobs = liveOn ? live.jobs : (polledProject ?? ctx.jobs);
  const jobs = wantAll ? (snap.all ?? []) : projectJobs;

  useEffect(() => {
    latestProjectJobs = projectJobs;
  }, [projectJobs]);

  const refresh = useCallback(() => pollNow(true), []);

  return {
    jobs,
    projectJobs,
    paused: liveOn ? live.paused || snap.paused : snap.paused,
    live,
    log: readLog(live),
    polling: wantProject || wantAll,
    error: snap.error,
    refresh,
  };
}

/** For tests. */
export function _resetQueueLive(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  wiring = null;
  inflight = null;
  epoch += 1;
  demand.project = 0;
  demand.all = 0;
  lastFingerprint = "";
  latestProjectJobs = [];
  state = { project: null, projectId: null, all: null, paused: false, error: null };
}
