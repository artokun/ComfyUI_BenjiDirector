// The job strip: one line under the toolbar that says what Calliope's queue is doing.
//
//   ● 1 running · 2 queued   [paused · Resume]   Scene · SC-03  ▰▰▰▱▱ 42%  Waiting on ComfyUI…   ⚠ Scene · SC-02  CUDA out of memory  [Retry] [x]
//
// Reads the live store; hidden until a project is loaded (the demo graph has no queue). The
// `LiveBridge` registered beside it is what starts the store — it renders nothing, so the
// strip stays a pure view and can be unmounted without stopping the feed.

import { useState } from "react";
import { useDirector } from "./director-context.jsx";
import { Icon } from "./icons.jsx";
import { LiveBridge, currentJobOf, jobLabel, jobsStore, lastFailureOf, progressFor, recentlyDoneOf, useJobs, type ConnectionState } from "./live.js";
import { registerSlot } from "./slots.jsx";
import "./styles/u10-live-jobs.css";

const PIP_TITLE: Record<ConnectionState, string> = {
  open: "Live — Calliope's event stream is connected",
  connecting: "Connecting to Calliope's event stream…",
  reconnecting: "Event stream dropped — reconnecting; polling every 5 s meanwhile",
  closed: "No event stream — polling every 5 s",
};

export function JobStrip() {
  const { client, projectId, scenes, story, setNote } = useDirector();
  const jobs = useJobs();
  const [busy, setBusy] = useState<"resume" | "retry" | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (projectId === null) return null;

  const labelCtx = { scenes, story };
  const current = currentJobOf(jobs);
  const prog = current ? progressFor(jobs, current.id) : undefined;
  const pct = prog?.pct ?? 0;
  const determinate = pct > 0;
  const done = current ? undefined : recentlyDoneOf(jobs);
  const failure = lastFailureOf(jobs);
  const shown = failure && failure.job.id !== dismissed ? failure : undefined;

  const run = async (what: "resume" | "retry", fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      await jobsStore.pollNow();
    } catch (err) {
      setNote(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bd-jobstrip" data-testid="u10-jobstrip" data-connection={jobs.connection}>
      <span className={`bd-jobstrip-pip is-${jobs.connection}`} title={PIP_TITLE[jobs.connection]} data-testid="u10-pip" />
      <span className="bd-jobstrip-counts" data-testid="u10-counts">
        {jobs.running.length} running · {jobs.queued.length} queued
      </span>
      {jobs.paused ? (
        <span className="bd-jobstrip-paused" data-testid="u10-paused">
          <Icon name="pause" size={12} />
          paused
          <button type="button" disabled={busy !== null} onClick={() => void run("resume", () => client.jobs.resume())} title="Resume Calliope's queue">
            <Icon name="play" size={11} /> Resume
          </button>
        </span>
      ) : null}
      {current ? (
        <span className="bd-jobstrip-current" data-testid="u10-current">
          <span className="bd-jobstrip-label" title={`${current.kind} job #${current.id}`}>
            {jobLabel(current, labelCtx)}
          </span>
          <span className={`bd-jobstrip-bar${determinate ? "" : " is-indeterminate"}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate ? Math.round(pct) : undefined}>
            <span className="bd-jobstrip-fill" style={determinate ? { width: `${pct}%` } : undefined} />
          </span>
          {determinate ? (
            <span className="bd-jobstrip-pct" data-testid="u10-pct">
              {Math.round(pct)}%
            </span>
          ) : null}
          {prog?.message ? (
            <span className="bd-jobstrip-msg" title={prog.message}>
              {prog.message}
            </span>
          ) : null}
        </span>
      ) : done ? (
        <span className="bd-jobstrip-done" data-testid="u10-done">
          <Icon name="check" size={12} />
          {jobLabel(done, labelCtx)} · done
        </span>
      ) : null}
      {shown ? (
        <span className="bd-jobstrip-error" data-testid="u10-error">
          <Icon name="alert" size={12} />
          <span className="bd-jobstrip-errlabel">{jobLabel(shown.job, labelCtx)}</span>
          <span className="bd-jobstrip-errtext" title={shown.error}>
            {shown.error}
          </span>
          <button type="button" disabled={busy !== null} onClick={() => void run("retry", () => client.jobs.retry(shown.job.id))} title={`Retry job #${shown.job.id}`}>
            <Icon name="refresh" size={11} /> Retry
          </button>
          <button type="button" className="bd-jobstrip-x" title="Dismiss" aria-label="Dismiss" onClick={() => setDismissed(shown.job.id)}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ) : null}
    </div>
  );
}

registerSlot("under-toolbar", LiveBridge, { order: 0, id: "u10-live-bridge" });
registerSlot("under-toolbar", JobStrip, { order: 20, id: "u10-job-strip" });
