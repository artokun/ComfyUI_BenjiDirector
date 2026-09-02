// The film: one card that is the whole export story — idle / exporting / ready / failed —
// plus the compact toolbar button that opens it as a popover.
//
// State comes from the newest `kind === "export"` job (jobs-view's `exportState`), never from
// a flag of our own: Calliope's queue is the truth about whether a film exists, and a card
// that remembered "I clicked export" would lie the moment the agent exported from a tool.

import { useCallback, useEffect, useRef, useState } from "react";
import { useDirector } from "./director-context.js";
import { Icon } from "./icons.jsx";
import { progressFor } from "./live.js";
import { useModal } from "./modal.jsx";
import { downloadName, exportState, formatClock, relativeTime, type ChipTone, type ExportView } from "./jobs-view.js";
import { useQueueJobs } from "./queue-live.js";

function chipFor(view: ExportView): { tone: ChipTone; label: string } {
  switch (view.state) {
    case "active":
      return { tone: "info", label: "Exporting" };
    case "ready":
      return view.stale ? { tone: "warn", label: "Clips changed" } : { tone: "ok", label: "Ready" };
    case "failed":
      return { tone: "err", label: "Export failed" };
    default:
      return { tone: "", label: "Not exported" };
  }
}

export function ExportCard({ compact = false }: { compact?: boolean }) {
  const { client, projectId, story, scenes, setNote } = useDirector();
  const modal = useModal();
  const q = useQueueJobs();
  const view = exportState(q.projectJobs, scenes);
  const [busy, setBusy] = useState(false);
  const chip = chipFor(view);
  const progress = view.job ? progressFor(q.live, view.job.id) : undefined;
  const { ready, missing, clipSec } = view.clips;

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await q.refresh();
        setNote(label);
      } catch (err) {
        setNote(`${label.replace(/\.$/, "")} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [q, setNote],
  );

  const exportFilm = () => {
    if (projectId === null) return;
    void run("Export queued", () => client.jobs.exportFilm(projectId));
  };
  const cancelExport = async () => {
    const job = view.job;
    if (!job) return;
    const ok = await modal.confirm({
      title: `Cancel export #${job.id}?`,
      body: "Stops the ffmpeg run and marks the job cancelled. ComfyUI is not touched — a film export never runs there.",
      confirmLabel: "Cancel export",
      cancelLabel: "Keep going",
      danger: true,
    });
    if (!ok) return;
    void run(`Cancelled export #${job.id}`, () => client.jobs.cancel(job.id));
  };

  const noProject = projectId === null;
  const title = story?.project.title ?? "Film";

  return (
    <section className={`bd-export${compact ? " is-compact" : ""} is-${view.state}`} aria-label="Film export" data-state={view.state}>
      <header className="bd-export-head">
        <span className="bd-export-icon">
          <Icon name="film" size={16} />
        </span>
        <div className="bd-export-titles">
          <div className="bd-export-eyebrow">Film</div>
          <div className="bd-export-title" title={title}>
            {title}
          </div>
        </div>
        <span className={`bd-chip-state ${chip.tone}`}>{chip.label}</span>
      </header>

      {noProject ? (
        <p className="bd-export-sub">Load a Calliope project to export its film.</p>
      ) : view.state === "active" ? (
        <div className="bd-export-body">
          <div className="bd-export-line">Exporting your film…</div>
          <div className={`bd-progress${progress ? "" : " is-indeterminate"}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.pct}>
            <div className="bd-progress-fill" style={progress ? { width: `${Math.max(2, Math.min(100, progress.pct))}%` } : undefined} />
          </div>
          <div className="bd-export-sub">
            {progress ? `${Math.round(progress.pct)}%` : "starting"}
            {progress?.message ? ` · ${progress.message}` : ""}
          </div>
          <div className="bd-export-sub">You can keep editing — the export runs in the background.</div>
          <div className="bd-export-actions">
            <button type="button" className="bd-btn is-ghost" disabled={busy} onClick={() => void cancelExport()}>
              <Icon name="x" /> Cancel
            </button>
          </div>
        </div>
      ) : view.state === "failed" ? (
        <div className="bd-export-body">
          <div className="bd-export-line is-err">
            <Icon name="alert" /> Export failed
          </div>
          <p className="bd-export-err" title={view.error ?? undefined}>
            {view.error}
          </p>
          <div className="bd-export-actions">
            <button type="button" className="bd-btn is-primary" disabled={busy || ready === 0} onClick={exportFilm}>
              <Icon name="refresh" /> Retry export
            </button>
          </div>
        </div>
      ) : view.state === "ready" ? (
        <div className="bd-export-body">
          {view.stale ? (
            <div className="bd-export-stale" role="status">
              <Icon name="alert" />
              <span>Clips changed since this export — re-export to update.</span>
            </div>
          ) : null}
          <div className="bd-export-sub">
            {ready} clip{ready === 1 ? "" : "s"} · {formatClock(clipSec)}
            {view.exportedAt != null ? ` · Exported ${relativeTime(view.job?.completed_at)}` : ""}
          </div>
          <div className="bd-export-actions">
            {/* Calliope is a different ORIGIN from the panel, and a cross-origin `download` is
                ignored by the browser — so without a target this link would navigate ComfyUI's
                own tab to the mp4 and take the editor with it. */}
            {view.path ? (
              <a className="bd-btn is-primary" href={client.fileUrl(view.path)} download={downloadName(story, view.path)} target="_blank" rel="noopener noreferrer" title={view.path}>
                <Icon name="download" /> Download film
              </a>
            ) : null}
            <button type="button" className={`bd-btn${view.stale ? " is-primary" : " is-ghost"}`} disabled={busy || ready === 0} onClick={exportFilm}>
              <Icon name="refresh" /> Re-export
            </button>
          </div>
        </div>
      ) : (
        <div className="bd-export-body">
          <div className="bd-export-sub">
            {ready} clip{ready === 1 ? "" : "s"} · {formatClock(clipSec)} · 0.5s crossfades
          </div>
          {missing > 0 ? (
            <div className="bd-export-warn" role="status">
              <Icon name="alert" />
              <span>
                {missing} scene{missing === 1 ? "" : "s"} without a clip will be skipped
              </span>
            </div>
          ) : null}
          <div className="bd-export-actions">
            <button
              type="button"
              className="bd-btn is-primary"
              disabled={busy || ready === 0}
              title={ready === 0 ? "Finish at least one clip to export a film" : "Stitch every clip into one mp4"}
              onClick={exportFilm}
            >
              <Icon name="film" /> Export film
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The toolbar's compact Export: a button with the film's state dot, opening the card as a popover. */
export function ExportButton() {
  const { projectId, scenes } = useDirector();
  const q = useQueueJobs();
  const view = exportState(q.projectJobs, scenes);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const disabled = projectId === null;
  const dot = view.state === "idle" ? "" : view.state === "ready" ? (view.stale ? "warn" : "ok") : view.state === "failed" ? "err" : "info";
  return (
    <span className="bd-export-anchor" ref={anchor}>
      <button
        type="button"
        className={`bd-export-btn${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={disabled ? "Load a Calliope project to export a film" : "Export the film"}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="film" /> Export
        {dot ? <span className={`bd-export-dot ${dot}`} aria-hidden /> : null}
      </button>
      {open ? (
        <div className="bd-export-pop" role="dialog" aria-label="Export film">
          <ExportCard compact />
        </div>
      ) : null}
    </span>
  );
}
