// Playground — generate freely against any enabled workflow, then keep what works by adding
// it to a project: a person (character sheet), a place (location), a thing (misc. item), or a
// clip on a scene. Uploads land beside the artifacts and feed media inputs.
//
// Ported from Calliope's playground route + AttachToProject. The artifacts are the jobs of
// the hidden scratch project; the grid polls at 5 s only while something is pending or
// running, and re-reads on every push the live unit delivers through `useJobs()`. The
// composer is `<DynamicInputs>` (the render-composer unit owns its insides); this panel
// owns the mode tabs, the workflow pick, validation and the request.

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { CharacterRow, JobRow, LocationRow, SceneRow, Schemas, UploadRow, WorkflowRow } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.js";
import { Icon } from "./icons.js";
import { progressFor, useJobs } from "./live.js";
import { useModal } from "./modal.js";
import { registerPanel } from "./panels.js";
import { compactInputValues, DynamicInputs, missingRequired, seedDefaults, type InputValues } from "./dynamic-form/index.js";
import {
  attachPayload,
  attachableProjects,
  defaultMiscName,
  defaultMode,
  deletePrompt,
  deleteSummary,
  fileName,
  formatBytes,
  isBusy,
  isVideoPath,
  mediaInputFor,
  mediaKindOf,
  pickWorkflow,
  readyCount,
  statusWord,
  targetsFor,
  toDynamicInputs,
  uploadOptions,
  workflowsFor,
  type AttachTarget,
  type Mode,
} from "./attach.js";
import "./styles/u18-playground.css";

type Project = Schemas["Project"];

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

const POLL_MS = 5000;

export function PlaygroundPanel() {
  const { client, status, projectId: loadedProjectId, refresh, setNote } = useDirector();
  const modal = useModal();
  const live = useJobs();
  const reachable = status?.reachable === true;

  // ── data ──
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [workflowsError, setWorkflowsError] = useState("");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsError, setJobsError] = useState("");
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const loadJobs = useCallback(async () => {
    try {
      const rows = await client.playground.jobs();
      setJobs(rows);
      setJobsError("");
    } catch (e) {
      setJobsError(errorText(e, "Could not read playground jobs"));
    } finally {
      setJobsLoaded(true);
    }
  }, [client]);

  const loadUploads = useCallback(async () => {
    try {
      setUploads(await client.playground.uploads());
    } catch {
      /* the strip just stays empty */
    }
  }, [client]);

  useEffect(() => {
    if (!reachable) return;
    let alive = true;
    client.workflows
      .list()
      .then((ws) => {
        if (!alive) return;
        setWorkflows(ws);
        setWorkflowsError("");
      })
      .catch((e: unknown) => alive && setWorkflowsError(errorText(e, "Could not read workflows")));
    client.projects
      .list()
      .then((ps) => alive && setProjects(ps))
      .catch(() => undefined);
    void loadUploads();
    return () => {
      alive = false;
    };
  }, [client, reachable, loadUploads]);

  // First read, and one more every time the live unit pushes a change. Keyed on a CONTENT
  // signature, not on `live.jobs` itself: the live unit owns that array's identity, and a
  // `useJobs()` that rebuilds it on every render would otherwise refetch in a loop.
  const liveSignature = live.jobs.map((j) => `${j.id}:${j.status}:${j.output_paths?.length ?? 0}`).join(",");
  useEffect(() => {
    if (reachable) void loadJobs();
  }, [reachable, loadJobs, liveSignature]);

  // Calliope's own cadence: poll only while something can still change.
  const busy = isBusy(jobs);
  useEffect(() => {
    if (!reachable || !busy) return;
    const t = setInterval(() => void loadJobs(), POLL_MS);
    return () => clearInterval(t);
  }, [reachable, busy, loadJobs]);

  // ── composer ──
  const [modeChoice, setModeChoice] = useState<Mode | null>(null);
  const mode: Mode = modeChoice ?? defaultMode(workflows);
  const modeWorkflows = useMemo(() => workflowsFor(workflows, mode), [workflows, mode]);
  const [workflowChoice, setWorkflowChoice] = useState<number | null>(null);
  const selectedId = pickWorkflow(modeWorkflows, workflowChoice);
  const selected = modeWorkflows.find((w) => w.id === selectedId) ?? null;
  const inputs = useMemo(() => toDynamicInputs(selected?.input_schema), [selected]);
  // One draft per workflow, seeded from the schema; Reset drops the draft (back to defaults).
  const [drafts, setDrafts] = useState<Record<number, InputValues>>({});
  const values = useMemo(() => (selected ? (drafts[selected.id] ?? seedDefaults(inputs, {})) : {}), [drafts, selected, inputs]);
  const setValues = useCallback(
    (next: InputValues) => {
      if (selected) setDrafts((d) => ({ ...d, [selected.id]: next }));
    },
    [selected],
  );
  const [attempted, setAttempted] = useState(false);
  const [valid, setValid] = useState(true);
  const onValidity = useCallback((v: boolean) => setValid(v), []);
  const [formError, setFormError] = useState("");
  const [generating, setGenerating] = useState(false);
  const assetOptions = useMemo(() => uploadOptions(uploads), [uploads]);

  const reset = () => {
    setDrafts((d) => {
      if (!selected) return d;
      const { [selected.id]: _gone, ...rest } = d;
      return rest;
    });
    setAttempted(false);
    setFormError("");
  };

  const generate = async () => {
    if (generating) return;
    if (!selected) {
      setFormError("Select a workflow first");
      return;
    }
    const missing = missingRequired(inputs, values);
    if (missing.length) {
      setAttempted(true);
      setFormError(`Missing required inputs: ${missing.map((m) => m.label).join(", ")}`);
      return;
    }
    setGenerating(true);
    try {
      await client.playground.generate({ workflow_id: selected.id, input_values: compactInputValues(seedDefaults(inputs, values)) });
      setFormError("");
      setAttempted(false);
      setNote("Generation queued");
      await loadJobs();
    } catch (e) {
      setFormError(errorText(e, "Generate failed"));
    } finally {
      setGenerating(false);
    }
  };

  // ── uploads ──
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const r = await client.playground.upload(file);
      setNote(`Uploaded ${r.name}`);
      await loadUploads();
    } catch (err) {
      setNote(errorText(err, "Upload failed"));
    } finally {
      setUploading(false);
    }
  };
  /** Click an upload → it fills the first input of the selected workflow that takes that kind of media. */
  const useUpload = (u: UploadRow) => {
    const target = mediaInputFor(inputs, u.kind);
    if (!target) {
      setNote(selected ? `${selected.name} has no ${u.kind} input` : "Select a workflow first");
      return;
    }
    setValues({ ...values, [target.nodeId]: u.path });
    setNote(`${u.name} → ${target.label}`);
  };

  // ── artifacts ──
  const [lightbox, setLightbox] = useState<{ src: string; kind: "image" | "video"; alt: string } | null>(null);
  const [attachFor, setAttachFor] = useState<number | null>(null);
  const [attached, setAttached] = useState<Record<number, string>>({});
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  const onAttached = async (jobId: number, projectId: number) => {
    const title = projects.find((p) => p.id === projectId)?.title ?? `Project #${projectId}`;
    setAttached((a) => ({ ...a, [jobId]: title }));
    setAttachFor(null);
    setNote(`Added to ${title}`);
    if (loadedProjectId === projectId) await refresh();
  };

  const retry = async (job: JobRow) => {
    setRetryingId(job.id);
    try {
      await client.jobs.retry(job.id);
      setNote(`Retrying #${job.id}`);
      await loadJobs();
    } catch (e) {
      setNote(errorText(e, "Retry failed"));
    } finally {
      setRetryingId(null);
    }
  };

  const remove = async (job: JobRow) => {
    const ok = await modal.confirm({ title: `Delete artifact #${job.id}?`, body: deletePrompt(job), confirmLabel: "Delete", danger: true });
    if (!ok) return;
    setDeletingId(job.id);
    try {
      const r = await client.playground.deleteJob(job.id);
      setNote(deleteSummary(job.id, r));
      if (attachFor === job.id) setAttachFor(null);
      await loadJobs();
    } catch (e) {
      setNote(errorText(e, "Delete failed"));
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [lightbox]);

  const attachable = useMemo(() => attachableProjects(projects), [projects]);

  if (!reachable) {
    return (
      <div className="bd-pg bd-pg-offline">
        <div className="bd-pg-empty">
          <Icon name="sparkles" size={22} />
          <p className="bd-pg-empty-title">{status === null ? "Checking Calliope…" : "Calliope is not reachable"}</p>
          <p className="bd-hint">{status && !status.reachable ? `${status.reason} at ${status.baseUrl}. Ask the agent to bring it up.` : "The playground renders through Calliope."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bd-pg">
      <div className="bd-pg-head">
        <div className="bd-pg-modes" role="tablist" aria-label="Generation mode">
          <button type="button" role="tab" aria-selected={mode === "video"} className={`bd-pg-mode${mode === "video" ? " is-active" : ""}`} onClick={() => setModeChoice("video")}>
            <Icon name="film" /> Video
          </button>
          <button type="button" role="tab" aria-selected={mode === "image"} className={`bd-pg-mode${mode === "image" ? " is-active" : ""}`} onClick={() => setModeChoice("image")}>
            <Icon name="image" /> Image
          </button>
        </div>
        <span className="bd-pg-count">
          <strong>{jobs.length}</strong> artifact{jobs.length === 1 ? "" : "s"} · {readyCount(jobs)} ready
          {busy ? <span className="bd-pg-live" title="Polling every 5 s">live</span> : null}
        </span>
        <span className="bd-spacer" />
        <button type="button" className="bd-btn is-ghost" onClick={() => void loadJobs()} title="Re-read the artifacts">
          <Icon name="refresh" /> Refresh
        </button>
        <button type="button" className="bd-btn is-ghost" onClick={reset} title="Clear every input of the selected workflow">
          <Icon name="x" /> Reset
        </button>
      </div>

      <div className="bd-pg-body">
        <section className="bd-pg-artifacts" aria-label="Artifacts">
          {jobsError ? <div className="bd-chip-state err">{jobsError}</div> : null}
          {!jobsLoaded ? (
            <ul className="bd-pg-grid" aria-busy="true">
              <li className="bd-pg-skeleton" />
              <li className="bd-pg-skeleton" />
              <li className="bd-pg-skeleton" />
            </ul>
          ) : jobs.length === 0 ? (
            <div className="bd-pg-empty">
              <Icon name="sparkles" size={22} />
              <p className="bd-pg-empty-title">Nothing generated yet</p>
              <p className="bd-hint">Generations land here — queued first, then the media. Add the ones you like to a project.</p>
            </div>
          ) : (
            <ul className="bd-pg-grid">
              {jobs.map((job) => (
                <ArtifactCard
                  key={job.id}
                  job={job}
                  progress={progressFor(live, job.id)}
                  fileUrl={(p) => client.fileUrl(p)}
                  attachOpen={attachFor === job.id}
                  attachedTo={attached[job.id]}
                  projects={attachable}
                  deleting={deletingId === job.id}
                  retrying={retryingId === job.id}
                  onOpen={(src, kind) => setLightbox({ src, kind, alt: `Artifact #${job.id}` })}
                  onAttach={() => setAttachFor(attachFor === job.id ? null : job.id)}
                  onAttachCancel={() => setAttachFor(null)}
                  onAttached={(pid) => void onAttached(job.id, pid)}
                  onDismissAttached={() =>
                    setAttached((a) => {
                      const { [job.id]: _gone, ...rest } = a;
                      return rest;
                    })
                  }
                  onRetry={() => void retry(job)}
                  onDelete={() => void remove(job)}
                />
              ))}
            </ul>
          )}
        </section>

        <aside className="bd-pg-uploads" aria-label="Uploads">
          <div className="bd-pg-uploads-head">
            <span className="bd-pg-section">Uploads</span>
            <button type="button" className="bd-btn" disabled={uploading} onClick={() => fileRef.current?.click()} title="Upload an image, clip or audio file (≤ 500 MB)">
              <Icon name="upload" /> {uploading ? "Uploading…" : "Upload"}
            </button>
            <input ref={fileRef} type="file" hidden accept="image/*,video/*,audio/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.mp4,.webm,.mov,.mkv,.mp3,.wav,.flac,.ogg,.m4a" onChange={(e) => void onPickFile(e)} />
          </div>
          {uploads.length === 0 ? (
            <p className="bd-hint bd-pg-uploads-empty">Persons, places and things you already have. Drop them here and point a media input at them.</p>
          ) : (
            <ul className="bd-pg-upload-list">
              {uploads.map((u) => (
                <li key={u.path}>
                  <button type="button" className="bd-pg-upload" onClick={() => useUpload(u)} title={`Use ${u.name} as a ${u.kind} input`}>
                    <span className="bd-pg-upload-thumb">{u.kind === "image" ? <img src={client.fileUrl(u.path)} alt="" loading="lazy" /> : <Icon name={u.kind === "video" ? "film" : "zap"} size={16} />}</span>
                    <span className="bd-pg-upload-meta">
                      <span className="bd-pg-upload-name">{u.name}</span>
                      <span className="bd-hint">
                        {u.kind} · {formatBytes(u.size)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <div className="bd-pg-dock">
        {workflowsError ? <div className="bd-chip-state err">{workflowsError}</div> : null}
        {modeWorkflows.length === 0 ? (
          <div className="bd-pg-empty is-inline">
            <p className="bd-pg-empty-title">No enabled {mode} workflows</p>
            <p className="bd-hint">Enable one in the Workflows tab, then it shows up here.</p>
          </div>
        ) : (
          <>
            <div className="bd-pg-dock-row">
              <label className="bd-pg-wf">
                <span className="bd-dyn-label">Workflow</span>
                <select className="bd-input" aria-label="Workflow" value={selectedId ?? ""} onChange={(e) => setWorkflowChoice(Number(e.target.value))}>
                  {modeWorkflows.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              {selected?.description ? <span className="bd-hint bd-pg-wf-desc">{selected.description}</span> : null}
              <span className="bd-chip">{selected?.prompt_profile ?? mode}</span>
            </div>
            <DynamicInputs inputs={inputs} values={values} onChange={setValues} assetOptions={assetOptions} allowUpload showErrors={attempted} onValidity={onValidity} />
            <div className="bd-pg-dock-foot">
              {formError ? (
                <span className="bd-pg-form-error" role="alert">
                  <Icon name="alert" /> {formError}
                </span>
              ) : (
                <span className="bd-hint">{attempted && !valid ? "Fill the required inputs." : "Runs on the scratch project — nothing touches a film until you add it."}</span>
              )}
              <button type="button" className="bd-btn is-primary bd-pg-generate" disabled={generating || !selected} onClick={() => void generate()}>
                <Icon name="sparkles" /> {generating ? "Queuing…" : "Generate"}
              </button>
            </div>
          </>
        )}
      </div>

      {lightbox ? (
        <div className="bd-pg-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.alt} onClick={() => setLightbox(null)}>
          <button type="button" className="bd-btn is-icon bd-pg-lightbox-close" title="Close" onClick={() => setLightbox(null)}>
            <Icon name="x" />
          </button>
          {lightbox.kind === "video" ? (
            <video src={lightbox.src} controls autoPlay onClick={(e) => e.stopPropagation()} />
          ) : (
            <img src={lightbox.src} alt={lightbox.alt} onClick={(e) => e.stopPropagation()} />
          )}
          <span className="bd-pg-lightbox-caption">{lightbox.alt}</span>
        </div>
      ) : null}
    </div>
  );
}

// ── one artifact tile ─────────────────────────────────────────────────────────────────────

interface CardProps {
  job: JobRow;
  progress: { pct: number; message?: string } | undefined;
  fileUrl: (path: string) => string;
  attachOpen: boolean;
  attachedTo: string | undefined;
  projects: Project[];
  deleting: boolean;
  retrying: boolean;
  onOpen: (src: string, kind: "image" | "video") => void;
  onAttach: () => void;
  onAttachCancel: () => void;
  onAttached: (projectId: number) => void;
  onDismissAttached: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

function ArtifactCard({ job, progress, fileUrl, attachOpen, attachedTo, projects, deleting, retrying, onOpen, onAttach, onAttachCancel, onAttached, onDismissAttached, onRetry, onDelete }: CardProps) {
  const primary = job.output_paths?.[0] ?? null;
  const kind = primary ? mediaKindOf(primary, job.kind) : job.kind === "video" ? "video" : "image";
  const src = primary ? fileUrl(primary) : null;
  const waiting = job.status === "pending" || job.status === "running";
  return (
    <li className={`bd-pg-card is-${job.status}`} data-job-id={job.id}>
      <div className="bd-pg-media">
        {src && primary ? (
          <button type="button" className="bd-pg-media-hit" aria-label={`${kind === "video" ? "Play video" : "View image"}, artifact ${job.id}`} onClick={() => onOpen(src, kind)}>
            {kind === "video" ? (
              <>
                <video src={src} muted playsInline preload="metadata" />
                <span className="bd-pg-play" aria-hidden="true">
                  <Icon name="play" size={20} />
                </span>
              </>
            ) : (
              <img src={src} alt={`Artifact ${job.id}`} loading="lazy" />
            )}
          </button>
        ) : waiting ? (
          <div className="bd-pg-waiting" aria-busy="true">
            <span className="bd-pg-pulse" />
            <span className="bd-pg-waiting-text">{job.status === "running" ? (progress?.message ?? "Generating…") : "Queued"}</span>
            {job.status === "running" ? (
              <span className={`bd-pg-progress${progress ? "" : " is-indeterminate"}`} role="progressbar" aria-valuenow={progress?.pct} aria-valuemin={0} aria-valuemax={100}>
                <span style={progress ? { width: `${Math.max(0, Math.min(100, progress.pct))}%` } : undefined} />
              </span>
            ) : null}
          </div>
        ) : job.status === "failed" ? (
          <div className="bd-pg-missing is-failed">
            <Icon name="alert" size={18} />
            <span>Failed</span>
          </div>
        ) : (
          <div className="bd-pg-missing">
            <Icon name="eyeOff" size={18} />
            <span>File missing on disk</span>
            {primary ? <span className="bd-pg-path">{fileName(primary)}</span> : null}
          </div>
        )}
        <div className="bd-pg-card-meta">
          <span className="bd-pg-id">#{job.id}</span>
          <span className={`bd-pg-badge is-${job.status}`}>{statusWord(job.status)}</span>
          <span className="bd-pg-kind">{job.kind}</span>
        </div>
      </div>
      {job.error ? (
        <p className="bd-pg-err" title={job.error}>
          {job.error}
        </p>
      ) : null}
      <div className="bd-pg-card-actions">
        {primary && !attachedTo ? (
          <button type="button" className={`bd-btn${attachOpen ? "" : " is-primary"}`} onClick={onAttach}>
            <Icon name="plus" /> Add to project
          </button>
        ) : null}
        {job.status === "failed" ? (
          <button type="button" className="bd-btn" disabled={retrying} onClick={onRetry}>
            <Icon name="refresh" /> {retrying ? "Retrying…" : "Retry"}
          </button>
        ) : null}
        <span className="bd-spacer" />
        <button type="button" className="bd-btn is-ghost bd-pg-delete" disabled={deleting} onClick={onDelete} title="Delete the record and its files">
          <Icon name="trash" /> {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
      {attachedTo ? (
        <div className="bd-pg-attached" role="status">
          <span className="bd-pg-attached-check">
            <Icon name="check" size={12} />
          </span>
          <span className="bd-pg-attached-text">
            Added to <strong>{attachedTo}</strong>
          </span>
          <button type="button" className="bd-btn is-ghost is-icon" title="Dismiss" onClick={onDismissAttached}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : null}
      {attachOpen && primary ? <AttachForm path={primary} isVideo={isVideoPath(primary, job.kind)} projects={projects} onCancel={onAttachCancel} onDone={onAttached} /> : null}
    </li>
  );
}

// ── Add to project ────────────────────────────────────────────────────────────────────────

interface AttachFormProps {
  path: string;
  isVideo: boolean;
  projects: Project[];
  onCancel: () => void;
  onDone: (projectId: number) => void;
}

function AttachForm({ path, isVideo, projects, onCancel, onDone }: AttachFormProps) {
  const { client } = useDirector();
  const targets = targetsFor(isVideo);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [target, setTarget] = useState<AttachTarget>(targets[0]?.id ?? "character_sheet");
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [sceneId, setSceneId] = useState<number | null>(null);
  const [name, setName] = useState(() => defaultMiscName(path));
  const [characters, setCharacters] = useState<CharacterRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The dependent lists follow the project: cleared on change, filled when the read lands.
  useEffect(() => {
    setCharacterId(null);
    setLocationId(null);
    setSceneId(null);
    setCharacters([]);
    setLocations([]);
    setScenes([]);
    setError("");
    if (projectId === null) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        if (isVideo) {
          const r = await client.scenes.list(projectId);
          if (alive) setScenes(r.scenes);
        } else {
          const a = await client.assets.list(projectId);
          if (!alive) return;
          setCharacters(a.characters);
          setLocations(a.locations);
        }
      } catch (e) {
        if (alive) setError(errorText(e, "Could not read the project"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, projectId, isVideo]);

  const submit = async () => {
    const r = attachPayload(target, { project_id: projectId, character_id: characterId, location_id: locationId, scene_id: sceneId }, path, name);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setBusy(true);
    try {
      await client.playground.attach(r.payload);
      onDone(r.payload.project_id);
    } catch (e) {
      setError(errorText(e, "Attach failed"));
    } finally {
      setBusy(false);
    }
  };

  const num = (v: string) => (v === "" ? null : Number(v));
  const picked = projectId !== null;
  return (
    <div className="bd-pg-attach" role="group" aria-label="Add artifact to project">
      <label className="bd-pg-field">
        <span className="bd-dyn-label">Project</span>
        <select className="bd-input" aria-label="Project" value={projectId ?? ""} onChange={(e) => setProjectId(num(e.target.value))}>
          <option value="">Select project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
      {!isVideo ? (
        <label className="bd-pg-field">
          <span className="bd-dyn-label">Add as</span>
          <select className="bd-input" aria-label="Add as" value={target} onChange={(e) => setTarget(e.target.value as AttachTarget)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {target === "character_sheet" ? (
        <label className="bd-pg-field">
          <span className="bd-dyn-label">Character</span>
          <select className="bd-input" aria-label="Character" value={characterId ?? ""} disabled={!picked || loading} onChange={(e) => setCharacterId(num(e.target.value))}>
            <option value="">Select character…</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {picked && !loading && characters.length === 0 ? <span className="bd-hint">No characters in this project yet.</span> : null}
        </label>
      ) : target === "location" ? (
        <label className="bd-pg-field">
          <span className="bd-dyn-label">Location</span>
          <select className="bd-input" aria-label="Location" value={locationId ?? ""} disabled={!picked || loading} onChange={(e) => setLocationId(num(e.target.value))}>
            <option value="">Select location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {picked && !loading && locations.length === 0 ? <span className="bd-hint">No locations in this project yet.</span> : null}
        </label>
      ) : target === "item" ? (
        <label className="bd-pg-field">
          <span className="bd-dyn-label">Name</span>
          <input className="bd-input" aria-label="Item name" value={name} placeholder="New misc. item" onChange={(e) => setName(e.target.value)} />
          <span className="bd-hint">Adds a new misc. item. Existing items are left unchanged.</span>
        </label>
      ) : (
        <label className="bd-pg-field">
          <span className="bd-dyn-label">Scene</span>
          <select className="bd-input" aria-label="Scene" value={sceneId ?? ""} disabled={!picked || loading} onChange={(e) => setSceneId(num(e.target.value))}>
            <option value="">Select scene…</option>
            {scenes.map((s) => (
              <option key={s.id} value={s.id}>
                #{s.order_index + 1} {s.heading || "Scene"}
              </option>
            ))}
          </select>
          {picked && !loading && scenes.length === 0 ? <span className="bd-hint">No scenes yet — write the script first.</span> : null}
        </label>
      )}
      <div className="bd-pg-attach-actions">
        <button type="button" className="bd-btn is-primary" disabled={!picked || busy || loading} onClick={() => void submit()}>
          <Icon name="check" /> {busy ? "Adding…" : "Add"}
        </button>
        <button type="button" className="bd-btn is-ghost" onClick={onCancel}>
          Cancel
        </button>
        {loading ? <span className="bd-hint">Reading project…</span> : null}
      </div>
      {error ? (
        <p className="bd-pg-form-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      ) : null}
    </div>
  );
}

registerPanel({ id: "playground", label: "Playground", icon: "sparkles", order: 60, placement: "tab", Component: PlaygroundPanel });
