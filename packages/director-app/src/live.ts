// Live Calliope state: jobs, progress, connection. THIS IS THE FOUNDATION STUB.
//
// The shapes below are the contract every consumer (asset cards, render composer, queue panel,
// playground, scene badges) codes against. The live unit replaces the bodies — SSE subscription
// with the 5 s poll fallback, and the progress-store attribution rules ported from Calliope's
// `lib/jobProgress.ts` — without changing the exports.

import type { JobRow } from "@benjidirector/calliope-client";

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

/** The jobs of the loaded project, live. Stub: empty until the live unit lands. */
export function useJobs(): JobsState {
  return EMPTY_JOBS;
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

/** Scene render status from its latest video job (and whether a clip exists). */
export function renderStatusOf(state: JobsState, sceneId: number, hasClip: boolean): RenderStatus {
  const j = latestJob(state, (x) => x.kind === "video" && x.scene_id === sceneId);
  if (j?.status === "pending") return "queued";
  if (j?.status === "running") return "rendering";
  if (j?.status === "failed") return "failed";
  return hasClip ? "rendered" : null;
}
