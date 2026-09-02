// The Render tab: a monitor, a filmstrip, and the composer that queues a clip.
//
// This is Calliope's Video stage (`QueueStage.svelte` + `video/*`) rebuilt on the Director's
// own chrome, against the same API. What it does that a form does not: it shows you the SHOT.
// The clip you last rendered is on screen at 16:9 while you rewrite the prompt under it, the
// rest of the cut is a filmstrip you can arrow through, and the scene's script is one click
// away — so "does this shot match the one before it" is a question you can answer without
// leaving the panel.
//
// Three things here are load-bearing and easy to get wrong:
//
//   * The autosave MERGES into `video_settings`. That object also holds `director` (the canvas
//     position and pin) and `prompt_draft` + `prompt_draft_meta` (the prompt the agent wrote,
//     and the hash Calliope checks it against). Calliope's PATCH replaces the whole object, so
//     a write that is not a merge silently costs the user their layout or the agent its prompt.
//   * Batch generate is one POST PER SCENE, in cut order. The H3 prompt rewrite runs
//     synchronously inside each request; one POST for twenty scenes is a request that takes
//     minutes and times out halfway through.
//   * A scene marked continue-from-previous needs a workflow with an `(Input:video)` node.
//     Calliope 400s otherwise, so the composer says so and disables Generate rather than
//     letting the user find out from an error toast.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { CalliopeClient, JobRow, SceneRow, UploadRow, WorkflowRow } from "@benjidirector/calliope-client";
import { calId } from "./calliope-bind.js";
import { useDirector } from "./director-context.js";
import { registerDriveCommands } from "./drive-registry.js";
import { DynamicInputs } from "./dynamic-form/DynamicInputs.jsx";
import { videoInputOf } from "./dynamic-form/roles.js";
import { baseName, compactInputValues, type AssetOption, type DynamicInput, type InputKind, type InputValues } from "./dynamic-form/types.js";
import { Icon } from "./icons.jsx";
import { progressFor, useJobs } from "./live.js";
import { useModal } from "./modal.jsx";
import { registerPanel } from "./panels.js";
import {
  batchTargets,
  clipSourceOptions,
  copyableValues,
  doneCount,
  draftOf,
  enabledVideoWorkflows,
  formatClock,
  formatTime,
  hydrateValues,
  isDraftStale,
  isLongError,
  jobHistory,
  latestVideoJob,
  mergeVideoSettings,
  payloadPrompt,
  payloadRows,
  previewPath,
  proseFallback,
  resolveClipSource,
  settingsHash,
  statusOf,
  storedClipSource,
  thumbFor,
  totalSeconds,
  workflowFor,
  type SceneStatus,
} from "./render-state.js";
import "./styles/u15-render-composer.css";

// ── the drive command's hand-off ──────────────────────────────────────────────
//
// `render_scene` runs while the Canvas tab may still be showing, and a module cannot switch
// tabs (the editor owns that state). So the command parks the request here and the panel picks
// it up when it mounts or when it is already open; the command's note tells the user to open
// the Render tab if it is not the active one.

let requestedScene: { sceneId: number; at: number } | null = null;
const requestListeners = new Set<() => void>();

export function requestRenderScene(sceneId: number): void {
  requestedScene = { sceneId, at: Date.now() };
  for (const l of requestListeners) l();
}

function useRequestedScene(): { sceneId: number; at: number } | null {
  return useSyncExternalStore(
    (cb) => {
      requestListeners.add(cb);
      return () => requestListeners.delete(cb);
    },
    () => requestedScene,
    () => requestedScene,
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

const KINDS = new Set<InputKind>(["text", "textarea", "number", "image", "image_url", "audio", "video"]);

/** A workflow's `input_schema` as the form's own type; an unknown kind degrades to text. */
function schemaOf(workflow: WorkflowRow | undefined): DynamicInput[] {
  return (workflow?.input_schema ?? []).map((i) => ({
    nodeId: String(i.nodeId),
    label: i.label || String(i.nodeId),
    role: i.role ?? null,
    kind: KINDS.has(i.kind as InputKind) ? (i.kind as InputKind) : "text",
    defaultValue: i.defaultValue,
    required: i.required ?? false,
  }));
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function RenderPanel() {
  const ctx = useDirector();
  const { client, projectId, scenes: rawScenes, story, settingsCache, refresh, setNote } = ctx;
  const modal = useModal();
  const live = useJobs();
  const requested = useRequestedScene();

  const scenes = useMemo(() => [...rawScenes].sort((a, b) => a.order_index - b.order_index), [rawScenes]);

  // Jobs: the live store when the live unit has one, the context's rows when something else
  // filled them, and our own poll otherwise — the panel is unusable without job status.
  const [polled, setPolled] = useState<JobRow[]>([]);
  const jobs = live.jobs.length ? live.jobs : ctx.jobs.length ? ctx.jobs : polled;
  const reloadJobs = useCallback(() => {
    if (projectId === null) return Promise.resolve();
    return client.jobs
      .list({ project_id: projectId })
      .then((rows) => setPolled(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
  }, [client, projectId]);
  useEffect(() => {
    if (projectId === null || live.connection === "open") return;
    void reloadJobs();
    const t = setInterval(() => void reloadJobs(), 5000);
    return () => clearInterval(t);
  }, [live.connection, projectId, reloadJobs]);

  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [paused, setPaused] = useState<boolean | null>(null);
  useEffect(() => {
    let live2 = true;
    void client.workflows
      .list()
      .then((rows) => live2 && setWorkflows(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
    void client.playground
      .uploads()
      .then((rows) => live2 && setUploads(Array.isArray(rows) ? rows : []))
      .catch(() => undefined);
    void client.jobs
      .queueStatus()
      .then((s) => live2 && setPaused(!!(s as { paused?: unknown }).paused))
      .catch(() => undefined);
    return () => {
      live2 = false;
    };
  }, [client]);

  const enabled = useMemo(() => enabledVideoWorkflows(workflows), [workflows]);

  // ── selection ──
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = useMemo(() => scenes.find((s) => s.id === selectedId) ?? null, [scenes, selectedId]);
  useEffect(() => {
    if (!scenes.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !scenes.some((s) => s.id === selectedId)) setSelectedId(scenes[0]!.id);
  }, [scenes, selectedId]);
  const lastRequest = useRef(0);
  useEffect(() => {
    if (!requested || requested.at === lastRequest.current) return;
    lastRequest.current = requested.at;
    if (scenes.some((s) => s.id === requested.sceneId)) setSelectedId(requested.sceneId);
  }, [requested, scenes]);

  // ── per-scene composer state ──
  const [sessionWorkflow, setSessionWorkflow] = useState<Record<number, number>>({});
  const [clipSource, setClipSource] = useState<Record<number, string>>({});
  const [values, setValues] = useState<InputValues>({});
  const [showErrors, setShowErrors] = useState(false);
  const formCache = useRef(new Map<number, InputValues>());
  const formScene = useRef<number | null>(null);
  const formWorkflow = useRef<number | null>(null);
  const savedHash = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settingsOf = useCallback(
    (scene: SceneRow): Record<string, unknown> => settingsCache.get(scene.id) ?? scene.video_settings ?? {},
    [settingsCache],
  );

  const selectedSettings = useMemo<Record<string, unknown>>(() => (selected ? settingsOf(selected) : {}), [selected, settingsOf]);

  const workflow = useMemo(() => (selected ? workflowFor(selected, enabled, sessionWorkflow[selected.id], settingsOf(selected)) : undefined), [enabled, selected, sessionWorkflow, settingsOf]);
  const inputs = useMemo(() => schemaOf(workflow), [workflow]);
  const videoInput = useMemo(() => videoInputOf(inputs), [inputs]);
  const chained = !!selected?.chain_from_prev;
  const blocked = chained && !videoInput;

  // Hydrate the form when the scene changes — and again when its workflow does, because the
  // workflow list arrives AFTER the first render: a hydration keyed on the scene alone would
  // seed from an empty schema and the duration seed and defaults would never land. Session
  // edits overlay the fresh base, so switching workflow (or back to a scene) keeps what was
  // typed.
  useEffect(() => {
    if (!selected) {
      formScene.current = null;
      formWorkflow.current = null;
      setValues({});
      return;
    }
    const sceneId = selected.id;
    const wfId = workflow?.id ?? null;
    if (formScene.current === sceneId && formWorkflow.current === wfId) return;
    const prev = formScene.current;
    if (prev !== null && prev !== sceneId) formCache.current.set(prev, values);
    const cached = prev === sceneId ? values : formCache.current.get(sceneId);
    formScene.current = sceneId;
    formWorkflow.current = wfId;
    const next = { ...hydrateValues(selected, inputs, settingsOf(selected)), ...(cached ?? {}) };
    setValues(next);
    if (prev !== sceneId) setShowErrors(false);
    // Seed the autosave fingerprint with what the row ALREADY says, so opening a scene (or
    // waiting for its workflow) is never itself a write.
    savedHash.current = settingsHash(mergeVideoSettings(settingsOf(selected), { input_values: next }));
  }, [inputs, selected, settingsOf, values, workflow]);

  // Autosave: debounce, hash-compare, MERGE. `director` and `prompt_draft*` ride through
  // untouched — see mergeVideoSettings.
  useEffect(() => {
    if (!selected || projectId === null || formScene.current !== selected.id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const sceneId = selected.id;
    const pick = sessionWorkflow[sceneId];
    const source = clipSource[sceneId];
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const current = settingsCache.get(sceneId) ?? selected.video_settings ?? {};
      const next = mergeVideoSettings(current, {
        input_values: values,
        ...(pick === undefined ? {} : { form_workflow_id: pick }),
        ...(source === undefined ? {} : { clip_source: source }),
      });
      const hash = settingsHash(next);
      if (hash === savedHash.current) return;
      savedHash.current = hash;
      settingsCache.set(sceneId, next);
      void client.scenes
        .patch(projectId, sceneId, { video_settings: next })
        .then((row) => {
          const echoed = (row as SceneRow | undefined)?.video_settings;
          if (echoed && typeof echoed === "object") settingsCache.set(sceneId, echoed);
        })
        .catch(() => {
          // Transient: the next edit retries. Re-arm by forgetting what we thought we saved.
          savedHash.current = "";
        });
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [clipSource, client, projectId, selected, sessionWorkflow, settingsCache, values]);

  // ── asset options for the media pickers ──
  const assetOptions = useMemo<AssetOption[]>(() => {
    const out: AssetOption[] = [];
    for (const c of story?.characters ?? []) {
      const path = str(c.sheet_path) ?? str(c.portrait_path);
      if (path) out.push({ id: `char-${c.id}`, label: `${c.name} · sheet`, path, kind: "character", media: "image" });
    }
    for (const l of story?.locations ?? []) {
      const path = str(l.reference_image_path);
      if (path) out.push({ id: `loc-${l.id}`, label: `${l.name} · environment`, path, kind: "location", media: "image" });
    }
    for (const it of story?.items ?? []) {
      const path = str((it as { reference_image_path?: unknown }).reference_image_path);
      if (path) out.push({ id: `item-${it.id}`, label: `${it.name} · item`, path, kind: "item", media: "image" });
    }
    for (const s of scenes) {
      if (s.video_path) out.push({ id: `clip-${s.id}`, label: `Clip #${s.order_index} · ${s.heading || "scene"}`, path: s.video_path, kind: "clip", media: "video" });
    }
    for (const u of uploads) {
      out.push({ id: `up-${u.path}`, label: `${u.name} · upload`, path: u.path, kind: "upload", media: u.kind === "video" || u.kind === "audio" ? u.kind : "image" });
    }
    return out;
  }, [scenes, story, uploads]);

  // ── generate ──
  const [busy, setBusy] = useState<null | "one" | "batch">(null);
  const [batchNote, setBatchNote] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);

  const beginGenerate = () => {
    if (!selected || !workflow || blocked) return;
    const missing = inputs.filter((i) => i.required && (values[i.nodeId] === undefined || values[i.nodeId] === "" || values[i.nodeId] === null));
    if (missing.length) {
      setShowErrors(true);
      setNote(`fill in ${missing.map((m) => m.label).join(", ")} before generating`);
      return;
    }
    setPreviewOpen(true);
  };

  const generateOne = async (prompt: string) => {
    if (!selected || projectId === null) return;
    setBusy("one");
    try {
      await client.jobs.generateVideos(projectId, {
        scene_ids: [selected.id],
        workflow_id: workflow?.id ?? null,
        input_values: compactInputValues(values),
        prompts: { [String(selected.id)]: prompt },
      });
      setNote(`clip queued for #${selected.order_index} ${selected.heading}`);
      await reloadJobs();
      await refresh();
    } catch (err) {
      setNote(`could not queue: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const batch = useMemo(() => batchTargets(scenes, jobs), [jobs, scenes]);
  const generateAll = async () => {
    if (projectId === null || !batch.targets.length || busy) return;
    if (batch.mode === "regenerate") {
      const ok = await modal.confirm({
        title: `Regenerate ${batch.targets.length} clip${batch.targets.length === 1 ? "" : "s"}?`,
        body: "Every scene's existing clip is cleared as its job is queued, and the queue renders them one at a time.",
        confirmLabel: "Regenerate all",
      });
      if (!ok) return;
    }
    setBusy("batch");
    let queued = 0;
    for (const [i, scene] of batch.targets.entries()) {
      setBatchNote(`Queueing ${i + 1}/${batch.targets.length}…`);
      const settings = settingsCache.get(scene.id) ?? scene.video_settings ?? {};
      const draft = draftOf(settings);
      try {
        await client.jobs.generateVideos(projectId, {
          scene_ids: [scene.id],
          workflow_id: workflowFor(scene, enabled, sessionWorkflow[scene.id], settings)?.id ?? null,
          ...(draft ? { prompts: { [String(scene.id)]: draft.prompt } } : {}),
        });
        queued += 1;
      } catch (err) {
        setNote(`scene #${scene.order_index}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setBatchNote("");
    setBusy(null);
    setNote(`${queued} clip${queued === 1 ? "" : "s"} queued — the queue renders them in cut order`);
    await reloadJobs();
    await refresh();
  };

  const togglePause = async () => {
    try {
      const res = paused ? await client.jobs.resume() : await client.jobs.pause();
      setPaused(!!(res as { paused?: unknown }).paused);
    } catch (err) {
      setNote(`queue: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ── render ──
  if (projectId === null) {
    return (
      <div className="bd-rc bd-rc-empty-state">
        <p className="bd-rc-empty-title">No project loaded</p>
        <p className="bd-hint">Pick a Calliope project in the toolbar; the Render tab shows its cut.</p>
      </div>
    );
  }
  if (!scenes.length) {
    return (
      <div className="bd-rc bd-rc-empty-state">
        <p className="bd-rc-empty-title">No scenes yet</p>
        <p className="bd-hint">Add scenes on the canvas, then come back to render clips.</p>
      </div>
    );
  }

  const done = doneCount(scenes, jobs);
  const status: SceneStatus = selected ? statusOf(selected, jobs) : "idle";
  const preview = selected ? previewPath(selected, jobs) : null;
  const job = selected ? latestVideoJob(jobs, selected.id) : undefined;
  const prog = job ? progressFor(live, job.id) : undefined;
  const history = selected ? jobHistory(jobs, selected.id) : [];
  const sourceOptions = selected ? clipSourceOptions(selected, scenes) : [];
  const source = selected ? resolveClipSource(clipSource[selected.id] ?? storedClipSource(selectedSettings), sourceOptions) : "auto";
  const batchLabel = busy === "batch" ? batchNote || "Queueing…" : batch.mode === "missing" ? `Generate all (${batch.targets.length})` : "Regenerate all";

  return (
    <div className="bd-rc">
      <header className="bd-rc-head">
        <div className="bd-rc-head-text">
          <h2 className="bd-rc-title">
            <Icon name="film" /> Render
          </h2>
          <p className="bd-hint bd-rc-count">
            {done}/{scenes.length} clips done · {formatClock(totalSeconds(scenes))} total
          </p>
        </div>
        <div className="bd-rc-head-actions">
          <button type="button" className="bd-btn is-primary" disabled={!!busy || !batch.targets.length} onClick={() => void generateAll()} title="Queue every scene's clip in cut order — one request per scene">
            <Icon name="film" /> {batchLabel}
          </button>
          <button type="button" className="bd-btn" onClick={() => void togglePause()}>
            <Icon name={paused ? "play" : "pause"} /> {paused ? "Resume queue" : "Pause queue"}
          </button>
        </div>
      </header>

      {paused ? (
        <div className="bd-rc-banner" role="status">
          <Icon name="alert" /> Queue paused — renders are held until you resume.
        </div>
      ) : null}

      {selected ? (
        <>
          <ClipMonitor scene={selected} status={status} previewPath={preview} error={job?.error ?? ""} progress={prog} fileUrl={(p) => client.fileUrl(p)} />

          <Filmstrip scenes={scenes} selectedId={selected.id} jobs={jobs} fileUrl={(p) => client.fileUrl(p)} onSelect={setSelectedId} />

          <ScriptDrawer
            scene={selected}
            status={status}
            story={story}
            actions={
              preview ? (
                <button type="button" className="bd-btn is-ghost" onClick={() => void downloadClip(client.fileUrl(preview), baseName(preview))}>
                  <Icon name="download" /> Download clip
                </button>
              ) : null
            }
          />

          <div className="bd-rc-dock">
            {!workflow ? (
              <div className="bd-rc-warn" role="alert">
                <Icon name="alert" />
                <span>
                  <strong>No video workflow enabled.</strong> Enable one in Calliope's Settings → Workflows, then reopen this tab.
                </span>
              </div>
            ) : (
              <>
                {blocked ? (
                  <div className="bd-rc-warn" role="alert">
                    <Icon name="alert" />
                    <span>
                      <strong>This workflow has no video input.</strong> Scene #{selected.order_index} continues from the previous clip, which needs a workflow with a{" "}
                      <code>(Input:video)</code> node — pick another below.
                    </span>
                  </div>
                ) : null}

                <DynamicInputs
                  inputs={inputs}
                  values={values}
                  onChange={setValues}
                  assetOptions={assetOptions}
                  allowUpload
                  showErrors={showErrors}
                  onSubmit={beginGenerate}
                  controlsStart={
                    <>
                      {/* The workflow, the video source and the render history are pills in the
                          same bar as the knobs: three stacked rows pushed the prompt out of a
                          short pane, and this is the row that never scrolls away. */}
                      <span className="bd-rc-pill bd-rc-pill-select" title="Which workflow renders this scene">
                        <Icon name="sparkles" size={12} />
                        <select value={workflow.id} aria-label="Workflow" onChange={(e) => setSessionWorkflow((m) => ({ ...m, [selected.id]: Number(e.target.value) }))}>
                          {enabled.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </span>
                      {chained && videoInput ? (
                        <button type="button" className="bd-rc-pill" aria-haspopup="dialog" title="Where this scene's continue-from video comes from" onClick={() => setSourceOpen(true)}>
                          <Icon name="film" size={12} />
                          {source === "auto" ? "Auto (previous clip)" : source === "upload" ? "Uploaded file" : `#${sourceOptions.find((s) => String(s.id) === source)?.order_index ?? "?"} ${sourceOptions.find((s) => String(s.id) === source)?.heading ?? "clip"}`}
                          <Icon name="chevronDown" size={11} />
                        </button>
                      ) : null}
                      {history.length ? (
                        <button type="button" className="bd-rc-pill" onClick={() => setHistoryOpen(true)}>
                          <Icon name="info" size={12} /> View prompt &amp; inputs
                        </button>
                      ) : null}
                    </>
                  }
                  controlsEnd={
                    <button type="button" className="bd-btn is-primary bd-rc-generate" disabled={blocked || busy === "one"} title={blocked ? "Pick a workflow with a video input" : "Review the prompt, then queue this clip"} onClick={beginGenerate}>
                      <Icon name="sparkles" /> {busy === "one" ? "Queueing…" : "Generate clip"}
                    </button>
                  }
                />
              </>
            )}
          </div>

          {previewOpen ? (
            <PromptPreviewModal
              client={client}
              projectId={projectId}
              scene={selected}
              settings={selectedSettings}
              workflow={workflow}
              onSaved={(row) => {
                if (row.video_settings) settingsCache.set(selected.id, row.video_settings);
                setNote("prompt draft saved — Generate will use it");
              }}
              onError={setNote}
              onClose={() => setPreviewOpen(false)}
              onGenerate={(prompt) => {
                setPreviewOpen(false);
                void generateOne(prompt);
              }}
            />
          ) : null}

          {historyOpen ? (
            <HistoryModal
              jobs={history}
              inputs={inputs}
              onCopy={(vals) => {
                setValues((cur) => ({ ...cur, ...vals }));
                setHistoryOpen(false);
                setNote("settings copied into the form");
              }}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}

          {sourceOpen && videoInput ? (
            <ClipSourceModal
              value={source}
              options={sourceOptions}
              fileUrl={(p) => client.fileUrl(p)}
              onPick={(next) => {
                setSourceOpen(false);
                setClipSource((m) => ({ ...m, [selected.id]: next }));
                if (next === "auto") setValues((cur) => ({ ...cur, [videoInput.nodeId]: "" }));
                else {
                  const clip = sourceOptions.find((s) => String(s.id) === next);
                  if (clip?.video_path) setValues((cur) => ({ ...cur, [videoInput.nodeId]: clip.video_path as string }));
                }
              }}
              onUpload={(file) => {
                setSourceOpen(false);
                setClipSource((m) => ({ ...m, [selected.id]: "upload" }));
                void client.playground
                  .upload(file)
                  .then((r) => setValues((cur) => ({ ...cur, [videoInput.nodeId]: r.path })))
                  .catch((err: unknown) => setNote(`upload failed: ${err instanceof Error ? err.message : String(err)}`));
              }}
              onClose={() => setSourceOpen(false)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * Save a clip.
 *
 * `<a download>` is IGNORED cross-origin — Calliope answers on its own port, so the attribute
 * is dropped and the click NAVIGATES the ComfyUI tab to the video, taking the editor with it.
 * Fetching the bytes and saving a blob URL keeps the download a download; if the fetch is
 * refused, a new tab is at least not the tab the user is working in.
 */
async function downloadClip(url: string, name: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = href;
    a.download = name || "clip.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

// ── the monitor ───────────────────────────────────────────────────────────────

function ClipMonitor({
  scene,
  status,
  previewPath: path,
  error,
  progress,
  fileUrl,
}: {
  scene: SceneRow;
  status: SceneStatus;
  previewPath: string | null;
  error: string;
  progress?: { pct: number; message?: string };
  fileUrl(p: string): string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => setShowDetails(false), [path, error, scene.id]);
  // `#t=0.1`: with preload="metadata" a browser paints NOTHING until playback, so every clip
  // preview sits black. The fragment makes it seek and paint a first frame.
  const url = path ? `${fileUrl(path)}#t=0.1` : null;
  const long = isLongError(error);
  return (
    <div className="bd-rc-monitor">
      <div className="bd-rc-stage">
        <div className="bd-rc-frame">
        {url ? (
          <video className="bd-rc-video" src={url} controls playsInline preload="metadata" />
        ) : (
          <div className="bd-rc-slate">
            <span className="bd-rc-slate-num">#{scene.order_index}</span>
            <span className="bd-rc-slate-id">scene_id {scene.id}</span>
            <span className="bd-rc-slate-head">{scene.heading || "Untitled"}</span>
            {status === "pending" ? (
              <span className="bd-rc-busy">
                <span className="bd-rc-spinner" aria-hidden="true" /> Queued — waiting for a worker
              </span>
            ) : status === "running" ? (
              <span className="bd-rc-busy">
                <span className="bd-rc-spinner" aria-hidden="true" /> {progress?.message ?? "Generating…"}
                <span className="bd-rc-bar">
                  <span className="bd-rc-bar-fill" style={{ width: `${Math.max(2, Math.min(100, progress?.pct ?? 0))}%` }} />
                </span>
              </span>
            ) : status === "failed" ? (
              <span className="bd-rc-fail" role="alert">
                <span className={`bd-rc-err${showDetails ? " is-open" : ""}`}>{error || "Generation failed"}</span>
                {long ? (
                  <button type="button" className="bd-btn is-ghost" onClick={() => setShowDetails((v) => !v)}>
                    {showDetails ? "Hide details" : "Show details"}
                  </button>
                ) : null}
              </span>
            ) : (
              <span className="bd-hint">No render yet — describe the shot below and generate.</span>
            )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── the filmstrip ─────────────────────────────────────────────────────────────

function Filmstrip({ scenes, selectedId, jobs, fileUrl, onSelect }: { scenes: SceneRow[]; selectedId: number; jobs: readonly JobRow[]; fileUrl(p: string): string; onSelect(id: number): void }) {
  const index = scenes.findIndex((s) => s.id === selectedId);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!scenes.length) return;
    let next: number | undefined;
    if (e.key === "ArrowRight") next = scenes[Math.min((index < 0 ? 0 : index) + 1, scenes.length - 1)]?.id;
    else if (e.key === "ArrowLeft") next = scenes[Math.max((index < 0 ? 0 : index) - 1, 0)]?.id;
    else if (e.key === "Home") next = scenes[0]?.id;
    else if (e.key === "End") next = scenes[scenes.length - 1]?.id;
    if (next === undefined || next === selectedId) return;
    e.preventDefault();
    onSelect(next);
  };
  return (
    <section className="bd-rc-strip" aria-label="Scene filmstrip">
      <div className="bd-rc-track" role="listbox" aria-label="Scene clips" aria-activedescendant={`bd-rc-clip-${selectedId}`} tabIndex={0} onKeyDown={onKeyDown}>
        {scenes.map((s) => {
          const st = statusOf(s, jobs);
          const thumb = thumbFor(s, jobs);
          return (
            <button
              type="button"
              key={s.id}
              id={`bd-rc-clip-${s.id}`}
              role="option"
              aria-selected={s.id === selectedId}
              className={`bd-rc-clip is-${st}${s.id === selectedId ? " is-current" : ""}${s.chain_from_prev ? " is-chained" : ""}`}
              title={`#${s.order_index} · id ${s.id} · ${s.heading || "Scene"} · ${formatClock(s.duration_sec || 5)}${s.chain_from_prev ? " · continues from the previous clip" : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <span className="bd-rc-clip-bar" aria-hidden="true" />
              <span className="bd-rc-clip-thumb">
                {thumb?.kind === "image" ? (
                  <img className="bd-rc-clip-media" src={fileUrl(thumb.path)} alt="" loading="lazy" />
                ) : thumb?.kind === "video" ? (
                  <video className="bd-rc-clip-media" src={`${fileUrl(thumb.path)}#t=0.1`} muted playsInline preload="metadata" />
                ) : (
                  <span className="bd-rc-clip-slate">#{s.order_index}</span>
                )}
                {s.chain_from_prev ? (
                  <span className="bd-rc-clip-chain" title="Continues from the previous clip">
                    <Icon name="link" size={10} />
                  </span>
                ) : null}
              </span>
              <span className="bd-rc-clip-meta">
                <span className="bd-rc-clip-num">#{s.order_index}</span>
                <span className="bd-rc-clip-dur">{formatClock(s.duration_sec || 5)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="bd-rc-transport">
        <button type="button" className="bd-btn is-ghost" disabled={index <= 0} onClick={() => onSelect(scenes[index - 1]!.id)}>
          <Icon name="chevronLeft" /> Prev
        </button>
        <span className="bd-hint">
          {index >= 0 ? `#${scenes[index]!.order_index} of ${scenes.length} · id ${scenes[index]!.id}` : "—"}
        </span>
        <button type="button" className="bd-btn is-ghost" disabled={index < 0 || index >= scenes.length - 1} onClick={() => onSelect(scenes[index + 1]!.id)}>
          Next <Icon name="chevronRight" />
        </button>
      </div>
    </section>
  );
}

// ── the script drawer ─────────────────────────────────────────────────────────

function ScriptDrawer({ scene, status, story, actions }: { scene: SceneRow; status: SceneStatus; story: ReturnType<typeof useDirector>["story"]; actions?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const cast = scene.characters?.length ? scene.characters.map((c) => c.name) : (story?.characters ?? []).filter((c) => (scene.character_ids ?? []).includes(c.id)).map((c) => c.name);
  return (
    <div className="bd-rc-script">
      <div className="bd-rc-script-row">
        <span className="bd-rc-script-num">#{scene.order_index}</span>
        <span className="bd-rc-script-head" title={scene.heading || "Untitled scene"}>
          {scene.heading || "Untitled scene"}
        </span>
        <span className={`bd-badge is-${status}`}>{status}</span>
        <span className="bd-rc-script-dur">{formatClock(scene.duration_sec || 5)}</span>
        <span className="bd-rc-script-id">id {scene.id}</span>
        <span className="bd-spacer" />
        {actions}
        <button type="button" className="bd-btn is-ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? "chevronUp" : "chevronDown"} /> Script
        </button>
      </div>
      {open ? (
        <div className="bd-rc-script-body" role="region" aria-label="Scene script">
          <div className="bd-rc-block">
            <span className="bd-dyn-label">Heading</span>
            <p>{scene.heading || "Untitled scene"}</p>
          </div>
          <div className="bd-rc-block">
            <span className="bd-dyn-label">Action</span>
            {scene.action?.trim() ? <p>{scene.action}</p> : <p className="bd-hint">No action text for this scene.</p>}
          </div>
          <div className="bd-rc-block">
            <span className="bd-dyn-label">Dialog</span>
            {scene.dialog?.trim() ? <pre className="bd-rc-dialog">{scene.dialog}</pre> : <p className="bd-hint">No dialog for this scene.</p>}
          </div>
          {cast.length ? (
            <div className="bd-rc-block">
              <span className="bd-dyn-label">Characters</span>
              <div className="bd-rc-chips">
                {cast.map((n) => (
                  <span className="bd-chip" key={n}>
                    {n}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── the prompt review gate ────────────────────────────────────────────────────

function PromptPreviewModal({
  client,
  projectId,
  scene,
  settings,
  workflow,
  onGenerate,
  onSaved,
  onError,
  onClose,
}: {
  client: CalliopeClient;
  projectId: number;
  scene: SceneRow;
  settings: Record<string, unknown>;
  workflow: WorkflowRow | undefined;
  onGenerate(prompt: string): void;
  onSaved(row: SceneRow): void;
  onError(message: string): void;
  onClose(): void;
}) {
  const [text, setText] = useState("");
  const [basedOn, setBasedOn] = useState("");
  const [fromDraft, setFromDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  // The scene row and its settings are re-created by every project refresh; keying the
  // resolver on their IDENTITY would re-POST the preview on a timer. Ids and a ref instead.
  const sceneId = scene.id;
  const workflowId = workflow?.id;
  const latest = useRef({ scene, settings });
  latest.current = { scene, settings };

  const resolve = useCallback(() => {
    setLoading(true);
    client.jobs
      .previewPrompt(projectId, { scene_id: sceneId, workflow_id: workflowId ?? null })
      .then((p) => {
        setText(p.prompt ?? "");
        setBasedOn(p.based_on ?? "");
        setFromDraft(!!p.from_draft);
        setFailed(false);
      })
      .catch(() => {
        // Never a dead end: the raw scene text is editable and Generate sends it verbatim.
        setText(draftOf(latest.current.settings)?.prompt ?? proseFallback(latest.current.scene));
        setBasedOn("");
        setFromDraft(false);
        setFailed(true);
      })
      .finally(() => setLoading(false));
  }, [client, projectId, sceneId, workflowId]);

  useEffect(resolve, [resolve]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const stale = isDraftStale(fromDraft, draftOf(settings)?.based_on ?? null, basedOn);
  const saveDraft = () => {
    if (!text.trim()) return;
    setSaving(true);
    // The draft is stamped against the row as it is NOW — promptDraft computes the hash
    // Calliope checks, and it merges into the settings we already hold so `director` survives.
    void client
      .promptDraft(projectId, { ...scene, video_settings: settings }, text)
      .then(onSaved)
      .catch((err: unknown) => onError(`could not save the draft: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setSaving(false));
  };

  return (
    <div className="bd-modal-backdrop" onPointerDown={onClose}>
      <div className="bd-modal bd-rc-preview" role="dialog" aria-modal="true" aria-label="Review prompt before generating" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">Review prompt before generating</div>
        <div className="bd-rc-preview-head">
          <span className="bd-hint">
            Scene #{scene.order_index} · {scene.heading || "Untitled"}
          </span>
          <span className="bd-hint">{workflow?.name ?? "Default workflow"}</span>
        </div>
        {loading ? (
          <p className="bd-rc-busy">
            <span className="bd-rc-spinner" aria-hidden="true" /> Resolving prompt{workflow?.prompt_profile === "minimax_h3_ref" ? " (H3 rewrite)" : ""}…
          </p>
        ) : (
          <>
            {stale ? (
              <p className="bd-rc-warn" role="status">
                <Icon name="alert" /> The saved draft was written against older scene text — Regenerate to refresh it.
              </p>
            ) : null}
            {failed ? (
              <p className="bd-rc-warn" role="status">
                <Icon name="alert" /> Calliope could not resolve a prompt — this is the scene's own text. Edit it and Generate, or Regenerate to retry.
              </p>
            ) : null}
            <textarea className="bd-input bd-rc-preview-text" rows={14} spellCheck={false} aria-label="Prompt text sent to the workflow" value={text} onChange={(e) => setText(e.target.value)} />
            <p className="bd-hint">
              {fromDraft ? "Loaded from the saved draft — Regenerate re-runs Calliope's own rewrite." : workflow?.prompt_profile === "minimax_h3_ref" ? "MiniMax H3 six-section rewrite. This exact text goes to the (Input:prompt) node." : "Scene prompt (prose profile). Edit freely before generating."}
            </p>
          </>
        )}
        <div className="bd-modal-actions">
          <button type="button" className="bd-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="bd-btn" disabled={loading || saving || !text.trim()} onClick={saveDraft}>
            <Icon name="save" /> {saving ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className="bd-btn" disabled={loading} onClick={resolve}>
            <Icon name="refresh" /> Regenerate
          </button>
          <button type="button" className="bd-btn is-primary" disabled={loading || !text.trim()} onClick={() => onGenerate(text.trim())}>
            <Icon name="play" /> Generate
          </button>
        </div>
      </div>
    </div>
  );
}

// ── what a past render sent ───────────────────────────────────────────────────

function HistoryModal({ jobs, inputs, onCopy, onClose }: { jobs: JobRow[]; inputs: DynamicInput[]; onCopy(values: InputValues): void; onClose(): void }) {
  const [activeId, setActiveId] = useState<number | null>(jobs[0]?.id ?? null);
  const active = jobs.find((j) => j.id === activeId) ?? jobs[0] ?? null;
  const rows = payloadRows(active, inputs);
  const refs = rows.filter((r) => ["character", "location", "image", "video", "audio"].includes(r.role ?? ""));
  const others = rows.filter((r) => !["character", "location", "image", "video", "audio"].includes(r.role ?? ""));
  const prompt = payloadPrompt(active);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="bd-modal-backdrop" onPointerDown={onClose}>
      <div className="bd-modal bd-rc-history" role="dialog" aria-modal="true" aria-label="Scene render history" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">Scene render history</div>
        {!active ? (
          <p className="bd-hint">No render jobs recorded for this scene yet.</p>
        ) : (
          <>
            {jobs.length > 1 ? (
              <div className="bd-rc-history-strip" role="tablist" aria-label="Render history">
                {jobs.map((j) => (
                  <button type="button" key={j.id} role="tab" aria-selected={j.id === active.id} className={`bd-rc-tab${j.id === active.id ? " is-active" : ""} is-${j.status}`} onClick={() => setActiveId(j.id)}>
                    #{j.id}
                    <span className="bd-rc-tab-count">{j.status}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="bd-rc-history-head">
              <span className="bd-hint">
                Job #{active.id} · {active.status}
                {formatTime(active.completed_at) ? ` · ${formatTime(active.completed_at)}` : ""}
              </span>
              <span className="bd-spacer" />
              <button type="button" className="bd-btn" disabled={!rows.length} onClick={() => onCopy(copyableValues(active))}>
                <Icon name="copy" /> Copy settings to form
              </button>
            </div>
            {prompt ? (
              <div className="bd-rc-block">
                <span className="bd-dyn-label">Prompt</span>
                <pre className="bd-rc-dialog">{prompt}</pre>
              </div>
            ) : (
              <p className="bd-hint">No prompt recorded on this job.</p>
            )}
            {refs.length ? (
              <div className="bd-rc-block">
                <span className="bd-dyn-label">References</span>
                <ul className="bd-rc-kv">
                  {refs.map((r) => (
                    <li key={r.nodeId}>
                      <span className="bd-chip">{r.role}</span> <span title={r.value}>{r.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {others.length ? (
              <div className="bd-rc-block">
                <span className="bd-dyn-label">Inputs</span>
                <ul className="bd-rc-kv">
                  {others.map((r) => (
                    <li key={r.nodeId}>
                      <span className="bd-chip">{r.label}</span> <span title={r.value}>{r.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
        <div className="bd-modal-actions">
          <button type="button" className="bd-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── where a continue scene's video comes from ─────────────────────────────────

function ClipSourceModal({
  value,
  options,
  fileUrl,
  onPick,
  onUpload,
  onClose,
}: {
  value: string;
  options: SceneRow[];
  fileUrl(p: string): string;
  onPick(value: string): void;
  onUpload(file: File): void;
  onClose(): void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <div className="bd-modal-backdrop" onPointerDown={onClose}>
      <div className="bd-modal bd-rc-picker" role="dialog" aria-modal="true" aria-label="Video source" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">Video source</div>
        <div className="bd-rc-sources">
          <button type="button" className={`bd-btn${value === "auto" ? " is-primary" : ""}`} onClick={() => onPick("auto")}>
            <Icon name="sparkles" /> Auto (previous clip)
          </button>
          <input
            ref={fileRef}
            type="file"
            className="bd-rc-file"
            accept="video/*,.mp4,.webm,.mov,.mkv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onUpload(file);
            }}
          />
          <button type="button" className={`bd-btn${value === "upload" ? " is-primary" : ""}`} onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> Upload file
          </button>
        </div>
        {options.length ? (
          <>
            <p className="bd-dyn-label">Clips in this film</p>
            <div className="bd-rc-grid">
              {options.map((s) => (
                <button type="button" key={s.id} className={`bd-rc-asset${String(s.id) === value ? " is-on" : ""}`} onClick={() => onPick(String(s.id))}>
                  <span className="bd-rc-asset-thumb">
                    <video className="bd-rc-asset-media" src={`${fileUrl(s.video_path as string)}#t=0.1`} muted playsInline preload="metadata" />
                  </span>
                  <span className="bd-rc-asset-name">
                    #{s.order_index} {s.heading || "Scene"}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="bd-hint">No other scene has a clip yet — Auto waits for the previous one.</p>
        )}
        <div className="bd-modal-actions">
          <button type="button" className="bd-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── registration ──────────────────────────────────────────────────────────────

registerPanel({ id: "render", label: "Render", icon: "play", order: 30, placement: "tab", Component: RenderPanel });

registerDriveCommands({
  /**
   * Open the composer on a scene. The editor owns which tab is showing, so this parks the
   * request and says so — the panel picks it up the moment it is on screen.
   */
  render_scene: (args, kit) => {
    const sceneId = kit.num(args.scene_id, "scene_id");
    const nodeId = calId.scene(sceneId);
    if (!kit.nodesRef.current.some((n) => n.id === nodeId)) throw new Error(`no scene ${sceneId} in the loaded project`);
    requestRenderScene(sceneId);
    const heading = kit.nodesRef.current.find((n) => n.id === nodeId)?.data.label ?? `scene ${sceneId}`;
    kit.setNote(`Render: ${heading} selected — open the Render tab to see it.`);
    return { scene_id: sceneId, panel: "render" };
  },
});

export { RenderPanel };
