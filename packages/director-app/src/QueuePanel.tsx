// The Queue tab: every job of the loaded project (or of every project), what it is for, how far
// along it is, and the two things you can do to one — retry it, or stop it. The film's Export
// card sits beside the rows, and the event log under it when the live store carries one.
//
// Registers itself on import (a panel tab + the toolbar Export button). Nothing in DirectorApp
// knows this file exists.

import { useState } from "react";
import "./styles/u17-queue-export.css";
import type { JobRow } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.js";
import { ExportButton, ExportCard } from "./ExportCard.jsx";
import { Icon } from "./icons.jsx";
import { progressFor } from "./live.js";
import { useModal } from "./modal.jsx";
import { registerPanel } from "./panels.js";
import { registerSlot } from "./slots.jsx";
import { JOB_FILTERS, filterJobs, isActive, kindIcon, kindLabel, labelFor, logEntries, queueStats, relativeTime, sortJobs, statusChip, type JobFilter } from "./jobs-view.js";
import { runningCount, useQueueJobs, type QueueView } from "./queue-live.js";

function JobRowView({ job, q, foreign }: { job: JobRow; q: QueueView; foreign: boolean }) {
  const { client, story, scenes, setNote } = useDirector();
  const modal = useModal();
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const label = labelFor(job, story, scenes);
  const chip = statusChip(job);
  const active = isActive(job);
  const progress = active ? progressFor(q.live, job.id) : undefined;
  const failed = job.status === "failed";

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await q.refresh();
      setNote(`${what} #${job.id}`);
    } catch (err) {
      setNote(`${what} #${job.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const comfy = job.kind !== "export";
    const ok = await modal.confirm({
      title: `Cancel ${label} (#${job.id})?`,
      body: comfy
        ? "This marks the job failed and sends ComfyUI an interrupt — which stops whatever ComfyUI is running right now, for everyone sharing it, even when that is a different job."
        : "Stops the ffmpeg run and marks the job cancelled. ComfyUI is not touched.",
      confirmLabel: "Cancel job",
      cancelLabel: "Keep going",
      danger: true,
    });
    if (!ok) return;
    await act("Cancelled", () => client.jobs.cancel(job.id));
  };
  const retry = () => act("Re-queued", () => client.jobs.retry(job.id));

  const when: string[] = [];
  const created = relativeTime(job.created_at);
  if (created) when.push(`created ${created}`);
  if (job.status === "running" && job.started_at) when.push(`started ${relativeTime(job.started_at)}`);
  if (job.completed_at && !active) when.push(`${chip.label === "done" ? "done" : "ended"} ${relativeTime(job.completed_at)}`);
  if (job.retry_count > 0) when.push(`${job.retry_count} ${job.retry_count === 1 ? "retry" : "retries"}`);

  return (
    <li className={`bd-job is-${job.status}`} data-job-id={job.id} data-kind={job.kind}>
      <span className="bd-job-kind" title={kindLabel(job.kind)}>
        <Icon name={kindIcon(job.kind)} />
      </span>
      <div className="bd-job-main">
        <div className="bd-job-top">
          <span className="bd-job-label" title={label}>
            {label}
          </span>
          <span className="bd-job-id">#{job.id}</span>
          {foreign && job.project_id != null ? <span className="bd-chip">project {job.project_id}</span> : null}
          <span className={`bd-chip-state ${chip.tone}`}>{chip.label}</span>
        </div>
        {active ? (
          <div className="bd-job-progress">
            <div className={`bd-progress${job.status === "running" && !progress ? " is-indeterminate" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.pct ?? (job.status === "pending" ? 0 : undefined)}>
              <div className="bd-progress-fill" style={progress ? { width: `${Math.max(2, Math.min(100, progress.pct))}%` } : job.status === "pending" ? { width: 0 } : undefined} />
            </div>
            <span className="bd-job-progress-text">{progress ? `${Math.round(progress.pct)}%${progress.message ? ` · ${progress.message}` : ""}` : job.status === "running" ? "working…" : "waiting for a worker"}</span>
          </div>
        ) : null}
        {failed && job.error && chip.tone === "err" ? (
          <div className="bd-job-error">
            <p className={`bd-job-error-text${details ? " is-open" : ""}`} title={details ? undefined : job.error}>
              {job.error}
            </p>
            {job.error.length > 90 || job.error.includes("\n") ? (
              <button type="button" className="bd-job-error-toggle" onClick={() => setDetails((d) => !d)}>
                {details ? "Hide details" : "Show details"}
              </button>
            ) : null}
          </div>
        ) : null}
        {when.length ? <div className="bd-job-meta">{when.join(" · ")}</div> : null}
      </div>
      <div className="bd-job-actions">
        {active ? (
          <button type="button" className="bd-btn is-ghost is-icon" disabled={busy} title="Cancel job" aria-label="Cancel job" onClick={() => void cancel()}>
            <Icon name="x" />
          </button>
        ) : failed ? (
          <button type="button" className="bd-btn is-ghost" disabled={busy} title="Retry job" onClick={() => void retry()}>
            <Icon name="refresh" /> Retry
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function QueuePanel() {
  const { client, projectId, status, setNote } = useDirector();
  const [filter, setFilter] = useState<JobFilter>("all");
  const [all, setAll] = useState(false);
  const q = useQueueJobs({ all });
  const rows = sortJobs(filterJobs(q.jobs, filter));
  const stats = queueStats(q.jobs);
  const log = q.log ? logEntries(q.log) : null;
  const [pausing, setPausing] = useState(false);
  const reachable = status?.reachable === true;

  const togglePause = async () => {
    setPausing(true);
    try {
      if (q.paused) await client.jobs.resume();
      else await client.jobs.pause();
      await q.refresh();
      setNote(q.paused ? "Queue resumed" : "Queue paused — running jobs finish, nothing new starts");
    } catch (err) {
      setNote(`could not ${q.paused ? "resume" : "pause"} the queue: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPausing(false);
    }
  };

  const empty = !reachable
    ? "Calliope is not reachable — the queue lives there."
    : !all && projectId === null
      ? "Load a Calliope project to see its queue, or switch to all projects."
      : rows.length === 0 && q.jobs.length > 0
        ? `No ${filter} jobs.`
        : "Queue idle — renders and generations land here.";

  return (
    <div className="bd-queue" data-scope={all ? "all" : "project"}>
      <div className="bd-queue-main">
        <header className="bd-queue-head">
          <div className="bd-queue-titles">
            <h2 className="bd-queue-title">
              <Icon name="clock" size={16} /> Queue
            </h2>
            <span className="bd-queue-sub">{all ? "every project" : projectId === null ? "no project loaded" : `project ${projectId}`}</span>
          </div>
          <div className="bd-queue-stats" aria-label="Queue stats">
            <span className="is-running">
              <b>{stats.running}</b> running
            </span>
            <span className="is-queued">
              <b>{stats.queued}</b> queued
            </span>
            <span className="is-done">
              <b>{stats.done}</b> done
            </span>
            <span className="is-failed">
              <b>{stats.failed}</b> failed
            </span>
          </div>
          <div className="bd-queue-tools">
            <button type="button" className={`bd-btn${q.paused ? " is-primary" : ""}`} disabled={!reachable || pausing} title={q.paused ? "Let the queue start jobs again" : "Finish what is running, start nothing new"} onClick={() => void togglePause()}>
              <Icon name={q.paused ? "play" : "pause"} /> {q.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="bd-btn is-ghost is-icon" title="Refresh now" aria-label="Refresh now" disabled={!reachable} onClick={() => void q.refresh()}>
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {q.paused ? (
          <div className="bd-queue-banner is-paused" role="status">
            <Icon name="pause" />
            <span>
              <b>Queue paused.</b> Running jobs finish; nothing new starts until you resume.
            </span>
            <button type="button" className="bd-btn" disabled={pausing} onClick={() => void togglePause()}>
              Resume
            </button>
          </div>
        ) : null}
        {q.error ? (
          <div className="bd-queue-banner is-error" role="alert">
            <Icon name="alert" />
            <span>Could not read the queue: {q.error}</span>
          </div>
        ) : null}

        <div className="bd-queue-filters" role="toolbar" aria-label="Filter jobs">
          {JOB_FILTERS.map((f) => (
            <button type="button" key={f} className={`bd-queue-chip${filter === f ? " is-on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f}
              {f !== "all" ? <span className="bd-queue-chip-n">{f === "pending" ? stats.queued : f === "running" ? stats.running : f === "done" ? stats.done : stats.failed}</span> : null}
            </button>
          ))}
          <span className="bd-spacer" />
          <label className="bd-queue-toggle" title="Show jobs from every Calliope project, not only the loaded one">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>all projects</span>
          </label>
        </div>

        {rows.length ? (
          <ul className="bd-job-list">
            {rows.map((j) => (
              <JobRowView key={j.id} job={j} q={q} foreign={all && j.project_id !== projectId} />
            ))}
          </ul>
        ) : (
          <div className="bd-queue-empty">{empty}</div>
        )}
      </div>

      <aside className="bd-queue-side">
        <ExportCard />
        {log ? (
          <section className="bd-queue-log" aria-label="Event log">
            <div className="bd-export-eyebrow">Activity</div>
            {log.length === 0 ? (
              <div className="bd-queue-empty">Quiet for now.</div>
            ) : (
              <ul className="bd-log">
                {log.map((e) => (
                  <li key={e.key} className={`bd-log-entry tone-${e.tone}`}>
                    <span className="bd-log-dot" aria-hidden />
                    <div className="bd-log-meta">
                      <div className="bd-log-row">
                        <span className="bd-log-title">{e.title}</span>
                        {e.ts ? <span className="bd-log-ts">{e.ts}</span> : null}
                      </div>
                      {e.detail ? <div className="bd-log-detail">{e.detail}</div> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </aside>
    </div>
  );
}

registerPanel({
  id: "queue",
  label: "Queue",
  icon: "clock",
  order: 50,
  placement: "tab",
  Component: QueuePanel,
  badge: () => {
    const n = runningCount();
    return n > 0 ? n : null;
  },
});
registerSlot("toolbar-right", ExportButton, { order: 30, id: "u17-export" });
