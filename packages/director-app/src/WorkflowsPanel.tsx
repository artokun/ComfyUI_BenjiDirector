// U16 — the Workflows tab: Calliope's workflow library, in the Director.
//
// Two halves. REGISTER takes an API-format ComfyUI JSON (drop, browse, or paste), checks its
// shape locally, shows the roles it would detect from the node titles the instant it lands,
// then asks Calliope to analyze it for real and registers it with a name, kind, prompt format
// and description. LIBRARY lists what Calliope has, with edit / view I/O / enable / delete.
//
// Calliope is the source of truth for everything after the local shape check: the analysis
// table is replaced by the server's answer, and every mutation re-reads the list rather than
// trusting the echo. Workflow JSON is locked after registration (Calliope's PATCH has no
// `workflow_json` field), which the edit sheet says out loud.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkflowAnalysis, WorkflowInput, WorkflowOutput, WorkflowRow } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.jsx";
import { Icon } from "./icons.jsx";
import { useModal } from "./modal.jsx";
import { registerPanel } from "./panels.js";
import {
  checkWorkflowShape,
  fileStem,
  INPUT_ROLE_ALIASES,
  previewWorkflow,
  PROMPT_PROFILES,
  SCENE_PORT_ROLES,
  type PromptProfile,
} from "./workflow-json.js";
import "./styles/u16-workflows.css";

type Kind = WorkflowRow["kind"];

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const asProfile = (p: string | null | undefined): PromptProfile => (p === "minimax_h3_ref" ? "minimax_h3_ref" : "prose");
const isPortRole = (role: string | null): boolean => role !== null && (SCENE_PORT_ROLES as readonly string[]).includes(role);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── the tab ──────────────────────────────────────────────────────────────────────────────────

export function WorkflowsPanel() {
  const { client, status, setNote } = useDirector();
  const modal = useModal();
  const [rows, setRows] = useState<WorkflowRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A SET, not one id: two cards can be in flight at once, and a single slot lets the second
  // mutation's `finally` clear the first one's spinner while its request is still open.
  const [busyIds, setBusyIds] = useState<ReadonlySet<number>>(() => new Set());
  const [editing, setEditing] = useState<WorkflowRow | null>(null);
  const [viewing, setViewing] = useState<WorkflowRow | null>(null);
  // Sheets portal into `.bd-root`. The shared modal renders as a SIBLING of it (ModalProvider
  // wraps the root div), which lands in the same place only because `.bd-root` is not
  // positioned — portalling into the root is the version that stays true if that changes.
  const hostRef = useRef<HTMLDivElement>(null);
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setRootEl((hostRef.current?.closest(".bd-root") as HTMLElement | null) ?? null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await client.workflows.list();
      setRows(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
      setRows((cur) => cur ?? []);
    }
  }, [client]);
  // `status?.reachable` is in the deps on purpose: the first read fails while Calliope is down,
  // and without this the panel would keep showing "No workflows yet" over a full library once
  // the agent brings it up.
  useEffect(() => {
    void reload();
  }, [reload, status?.reachable]);

  const mutate = useCallback(
    // Two verbs, because the success line wants the past tense ("deleted") and the failure line
    // wants the infinitive ("Could not delete") — one string cannot be both.
    async (row: WorkflowRow, verbs: { did: string; do: string }, fn: () => Promise<unknown>) => {
      setBusyIds((cur) => new Set(cur).add(row.id));
      try {
        await fn();
        setNote(`Workflow “${row.name}” ${verbs.did}`);
        await reload();
        return true;
      } catch (err) {
        setNote(`Could not ${verbs.do} workflow “${row.name}”: ${errText(err)}`);
        return false;
      } finally {
        setBusyIds((cur) => {
          const next = new Set(cur);
          next.delete(row.id);
          return next;
        });
      }
    },
    [reload, setNote],
  );

  const toggle = (row: WorkflowRow) =>
    mutate(row, row.is_enabled ? { did: "disabled", do: "disable" } : { did: "enabled", do: "enable" }, () => client.workflows.patch(row.id, { is_enabled: !row.is_enabled }));
  const remove = async (row: WorkflowRow) => {
    const ok = await modal.confirm({
      title: "Delete workflow?",
      body: (
        <>
          This removes <strong>“{row.name}”</strong> from the library. Scenes that point at it will need another workflow before they render. This cannot be undone.
        </>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (viewing?.id === row.id) setViewing(null);
    await mutate(row, { did: "deleted", do: "delete" }, () => client.workflows.delete(row.id));
  };
  const saveEdit = async (row: WorkflowRow, patch: { name: string; description: string; prompt_profile: PromptProfile }) => {
    const ok = await mutate(row, { did: "updated", do: "update" }, () => client.workflows.patch(row.id, patch));
    if (ok) setEditing(null);
  };

  const list = rows ?? [];
  const imageCount = list.filter((w) => w.kind === "image").length;
  const videoCount = list.filter((w) => w.kind === "video").length;
  const down = status !== null && !status.reachable;

  return (
    <div className="u16" ref={hostRef} data-u16="panel">
      <header className="u16-head">
        <div>
          <div className="u16-title">
            <Icon name="sliders" size={18} /> Workflows
          </div>
          <p className="u16-sub">
            Register API-format ComfyUI workflows as a reusable library. Scenes pick one to render a keyframe (image) or a clip (video); the roles come from
            node titles such as <code>Positive Prompt (Input:prompt)</code> and <code>Final (Output:video)</code>.
          </p>
        </div>
        <div className="u16-stats" data-u16="stats">
          <span className="u16-stat">{list.length} saved</span>
          <span className="u16-stat is-image">{imageCount} image</span>
          <span className="u16-stat is-video">{videoCount} video</span>
        </div>
      </header>

      <div className="u16-grid">
        <div className="u16-col">
          <RegisterCard onSaved={reload} />
          <HintCard />
        </div>
        <div className="u16-col">
          <section className="u16-card" aria-label="Saved workflows">
            <div className="u16-card-title">
              <Icon name="layers" /> Saved workflows
              <span className="u16-spacer" />
              <button type="button" className="bd-btn is-ghost is-icon" title="Reload the library" onClick={() => void reload()}>
                <Icon name="refresh" />
              </button>
            </div>
            {down ? (
              <div className="u16-check is-bad">
                <Icon name="alert" /> Calliope is not answering at {status.baseUrl} ({status.reason}). The library lives there — ask the agent to bring it up.
              </div>
            ) : null}
            {loadError && !down ? (
              <div className="u16-check is-bad">
                <Icon name="alert" /> Could not read the library: {loadError}
              </div>
            ) : null}
            {rows === null && !down ? (
              <div className="u16-cards" aria-busy="true" aria-label="Loading workflows">
                <div className="u16-skel" />
                <div className="u16-skel" />
              </div>
            ) : list.length === 0 ? (
              <div className="u16-libempty">
                <strong>No workflows yet</strong>
                Register at least one image and one video workflow to run the pipeline.
              </div>
            ) : (
              <div className="u16-cards" data-u16="library">
                {list.map((wf) => (
                  <LibraryCard key={wf.id} row={wf} busy={busyIds.has(wf.id)} onEdit={() => setEditing(wf)} onView={() => setViewing(wf)} onToggle={() => void toggle(wf)} onDelete={() => void remove(wf)} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      {editing ? (
        <Sheet rootEl={rootEl} kind="edit" title={<><Icon name="text" /> Edit “{editing.name}”</>} onClose={() => setEditing(null)}>
          <EditForm row={editing} busy={busyIds.has(editing.id)} onCancel={() => setEditing(null)} onSave={(patch) => void saveEdit(editing, patch)} />
        </Sheet>
      ) : null}
      {viewing ? (
        <Sheet rootEl={rootEl} kind="view" title={<><Icon name="layers" /> {viewing.name} — inputs and outputs</>} onClose={() => setViewing(null)}>
          <IoTables inputs={viewing.input_schema ?? []} outputs={viewing.output_schema ?? []} emptyInputs="No inputs cached." emptyOutputs="No outputs cached." />
          <div className="bd-modal-actions">
            <button type="button" className="bd-btn" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

// ── register card ────────────────────────────────────────────────────────────────────────────

function RegisterCard({ onSaved }: { onSaved: () => Promise<void> }) {
  const { client, setNote } = useDirector();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [analysis, setAnalysis] = useState<{ forText: string; result: WorkflowAnalysis } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  /** null = follow the detected outputs; set once the user picks. */
  const [kind, setKind] = useState<Kind | null>(null);
  /** null = follow the suggestion (local, then Calliope's); set once the user picks. */
  const [profile, setProfile] = useState<PromptProfile | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // A real "Save (API Format)" export runs to hundreds of KB, and re-parsing it on the
  // keystroke's own render path makes the textarea drop frames. The PREVIEW follows the
  // deferred text; anything that leaves the browser re-checks `text` itself (below), so a
  // lagging preview can never be what gets analyzed or registered.
  const deferredText = useDeferredValue(text);
  const shape = useMemo(() => checkWorkflowShape(deferredText), [deferredText]);
  const preview = useMemo(() => (shape.ok ? previewWorkflow(shape.json) : null), [shape]);
  const analyzed = analysis && analysis.forText === text ? analysis.result : null;
  const effectiveProfile: PromptProfile = profile ?? (analyzed ? asProfile(analyzed.suggested_profile) : (preview?.suggestedProfile ?? "prose"));
  const shown = analyzed ? { inputs: analyzed.inputs, outputs: analyzed.outputs } : preview;
  // A graph whose only output is a clip is a video workflow. Calliope stores `kind` as given,
  // and a video graph filed as "image" is offered for keyframes it can never render — so the
  // detected outputs pick the default and the user overrides it, not the other way round.
  const detectedKind: Kind | null = shown ? (shown.outputs.some((o) => o.kind === "video" || o.role === "video") ? "video" : shown.outputs.length ? "image" : null) : null;
  const effectiveKind: Kind = kind ?? detectedKind ?? "image";

  const replaceText = (next: string) => {
    setText(next);
    setProfile(null);
    setKind(null);
    setError(null);
  };
  const loadFile = async (file: File) => {
    try {
      const body = await file.text();
      setFileName(file.name);
      replaceText(body);
      setName((cur) => cur.trim() || fileStem(file.name));
    } catch (err) {
      // The name chip must never outlive a read that failed — it would claim a file we never got.
      setFileName(null);
      setError(`Could not read ${file.name}: ${errText(err)}`);
    }
  };
  // A file dropped ANYWHERE else in the document is a browser navigation to file:///… —
  // which unmounts the editor and takes the unsaved canvas with it. This is the app's only
  // drop target, so the guard lives with it and dies with it.
  useEffect(() => {
    const swallow = (e: globalThis.DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void loadFile(file);
      return;
    }
    const dropped = e.dataTransfer?.getData("text/plain");
    if (dropped) {
      setFileName(null);
      replaceText(dropped);
    }
  };

  const analyze = async () => {
    // `text`, not the deferred copy: what leaves the browser is what is on screen right now.
    const current = checkWorkflowShape(text);
    if (!current.ok) {
      setError(current.error);
      return;
    }
    const forText = text;
    setAnalyzing(true);
    setError(null);
    try {
      const result = await client.workflows.analyze({ workflow_json: current.json });
      setAnalysis({ forText, result });
    } catch (err) {
      setError(`Analyze failed: ${errText(err)}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const reset = () => {
    setText("");
    setFileName(null);
    setAnalysis(null);
    setError(null);
    setName("");
    setKind(null);
    setProfile(null);
    setDescription("");
    if (fileInput.current) fileInput.current.value = "";
  };

  const register = async () => {
    const current = checkWorkflowShape(text);
    if (!current.ok || !analyzed) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the workflow a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const row = await client.workflows.create({
        name: trimmed,
        kind: effectiveKind,
        workflow_json: current.json,
        description: description.trim() || undefined,
        prompt_profile: effectiveProfile,
      });
      reset();
      setNote(`Workflow “${row.name}” saved to library`);
      await onSaved();
    } catch (err) {
      setError(`Could not save: ${errText(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const canRegister = shape.ok && !!analyzed && !!name.trim() && !saving;

  return (
    <section className="u16-card" aria-label="Register a workflow" data-u16="register-card">
      <div className="u16-card-title">
        <Icon name="upload" /> Analyze &amp; register
      </div>
      <div
        className={`u16-drop${dragging ? " is-dragging" : ""}`}
        role="button"
        tabIndex={0}
        data-u16="drop"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInput.current?.click();
          }
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          data-u16="file"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            // Clearing the input is what lets the same file be picked twice in a row: with the
            // value still set, re-selecting it fires no change event and the click does nothing.
            e.currentTarget.value = "";
            if (f) void loadFile(f);
          }}
        />
        <div className="u16-drop-icon">
          <Icon name="upload" size={20} />
        </div>
        <div>
          <strong>Drop a ComfyUI API JSON here</strong>
          <p>or click to browse · Save (API Format) from ComfyUI · or paste below</p>
        </div>
      </div>
      {fileName ? (
        <div className="u16-file">
          <Icon name="folder" /> {fileName}
        </div>
      ) : null}
      <label className="u16-field">
        <span className="u16-label">API-format JSON</span>
        <textarea
          className="bd-input u16-json"
          data-u16="json"
          rows={6}
          spellCheck={false}
          placeholder='{ "6": { "class_type": "CLIPTextEncode", "inputs": { … }, "_meta": { "title": "Positive Prompt (Input:prompt)" } }, … }'
          value={text}
          onChange={(e) => {
            setFileName(null);
            replaceText(e.target.value);
          }}
        />
      </label>

      {text.trim() ? (
        shape.ok && preview ? (
          <div className={`u16-check ${analyzed ? "is-ok" : "is-info"}`} data-u16="shape">
            <Icon name={analyzed ? "check" : "info"} />
            <span>
              {analyzed ? "Analyzed by Calliope" : "Looks like API format"} · {plural(shape.nodeCount, "node")} · {plural((shown ?? preview).inputs.length, "input")} ·{" "}
              {plural((shown ?? preview).outputs.length, "output")}
              {analyzed ? "" : " · detected locally — Analyze to confirm"}
            </span>
          </div>
        ) : (
          <div className="u16-check is-bad" data-u16="shape">
            <Icon name="alert" /> <span>{shape.ok ? null : shape.error}</span>
          </div>
        )
      ) : null}

      {shown ? (
        <IoTables
          inputs={shown.inputs}
          outputs={shown.outputs}
          showNode
          emptyInputs={
            <>
              None — title the nodes a Scene should fill with <code>(Input:prompt)</code>, <code>(Input:character)</code>, <code>(Input:location)</code>…
            </>
          }
          emptyOutputs={
            <>
              None — add <code>(Output:image)</code> or <code>(Output:video)</code> to the node that saves the result.
            </>
          }
        />
      ) : null}

      {shape.ok ? (
        <div className="u16-form">
          <label className="u16-field">
            <span className="u16-label">
              Name<span className="u16-req">*</span>
            </span>
            <input
              className="bd-input"
              data-u16="name"
              value={name}
              placeholder="LTX Ref-to-Video"
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="u16-field">
            <span className="u16-label">Kind</span>
            <select className="bd-input" data-u16="kind" value={effectiveKind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="image">Image (keyframe)</option>
              <option value="video">Video</option>
            </select>
          </label>
          <label className="u16-field">
            <span className="u16-label">Prompt format</span>
            <select className="bd-input" data-u16="profile" value={effectiveProfile} onChange={(e) => setProfile(asProfile(e.target.value))}>
              {PROMPT_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="u16-field">
            <span className="u16-label">Description</span>
            <input className="bd-input" data-u16="description" value={description} placeholder="When to use this workflow…" onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
      ) : null}

      {error ? (
        <div className="u16-check is-bad" data-u16="error">
          <Icon name="alert" /> <span>{error}</span>
        </div>
      ) : null}

      <div className="u16-actions">
        <button type="button" className="bd-btn" data-u16="analyze" disabled={!shape.ok || analyzing} onClick={() => void analyze()}>
          <Icon name="search" /> {analyzing ? "Analyzing…" : analyzed ? "Re-analyze" : "Analyze"}
        </button>
        <button
          type="button"
          className="bd-btn is-primary"
          data-u16="register"
          disabled={!canRegister}
          title={!shape.ok ? "Paste or drop an API-format workflow first" : !analyzed ? "Analyze first" : !name.trim() ? "Name is required" : undefined}
          onClick={() => void register()}
        >
          <Icon name="save" /> {saving ? "Registering…" : "Register"}
        </button>
        <span className="u16-spacer" />
        {text ? (
          <button type="button" className="bd-btn is-ghost" data-u16="clear" onClick={reset}>
            <Icon name="x" /> Clear
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ── detected I/O ─────────────────────────────────────────────────────────────────────────────

function IoTables({ inputs, outputs, showNode, emptyInputs, emptyOutputs }: { inputs: WorkflowInput[]; outputs: WorkflowOutput[]; showNode?: boolean; emptyInputs: ReactNode; emptyOutputs: ReactNode }) {
  return (
    <div className="u16-io" data-u16="io">
      <div>
        <div className="u16-io-head">
          <span>Detected inputs</span>
          <span className="u16-count">{inputs.length}</span>
        </div>
        {inputs.length === 0 ? (
          <p className="u16-empty">{emptyInputs}</p>
        ) : (
          <table className="u16-table" data-u16="inputs">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Role</th>
                <th>Label</th>
                <th>{showNode ? "Node" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {inputs.map((inp) => (
                <tr key={inp.nodeId} data-u16-role={inp.role ?? ""}>
                  <td>
                    <span className="u16-kind">{inp.kind}</span>
                  </td>
                  <td>{inp.role ? <span className={`u16-role${isPortRole(inp.role) ? " is-port" : ""}`}>{inp.role}</span> : <span className="u16-role is-none">any</span>}</td>
                  <td>
                    {inp.label}
                    {inp.defaultValue !== undefined && inp.defaultValue !== null && inp.defaultValue !== "" ? <span className="u16-default" title={String(inp.defaultValue)}>default: {String(inp.defaultValue)}</span> : null}
                  </td>
                  <td>{showNode ? <span className="u16-node">#{inp.nodeId}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <div className="u16-io-head">
          <span>Detected outputs</span>
          <span className="u16-count">{outputs.length}</span>
        </div>
        {outputs.length === 0 ? (
          <p className="u16-empty">{emptyOutputs}</p>
        ) : (
          <table className="u16-table" data-u16="outputs">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Role</th>
                <th>Label</th>
                <th>{showNode ? "Node" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {outputs.map((out) => (
                <tr key={out.nodeId} data-u16-role={out.role ?? ""}>
                  <td>
                    <span className="u16-kind is-out">{out.kind}</span>
                  </td>
                  <td>{out.role ? <span className="u16-role">{out.role}</span> : <span className="u16-role is-none">any</span>}</td>
                  <td>{out.label}</td>
                  <td>{showNode ? <span className="u16-node">#{out.nodeId}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── library card ─────────────────────────────────────────────────────────────────────────────

function LibraryCard({ row, busy, onEdit, onView, onToggle, onDelete }: { row: WorkflowRow; busy: boolean; onEdit: () => void; onView: () => void; onToggle: () => void; onDelete: () => void }) {
  const video = row.kind === "video";
  const inputs = row.input_schema?.length ?? 0;
  const outputs = row.output_schema?.length ?? 0;
  return (
    <article className={`u16-wf${row.is_enabled ? "" : " is-disabled"}${busy ? " is-busy" : ""}`} data-u16-card={row.id} aria-busy={busy || undefined}>
      <div className="u16-wf-top">
        <div className={`u16-tile${video ? " is-video" : ""}`} aria-hidden="true">
          {video ? "VID" : "IMG"}
        </div>
        <div className="u16-wf-meta">
          <div className="u16-wf-name" title={row.name}>
            {row.name}
          </div>
          <div className="u16-tags">
            <span className={`u16-badge${video ? " is-video" : ""}`}>{row.kind}</span>
            {row.prompt_profile === "minimax_h3_ref" ? <span className="u16-badge is-h3">H3-ref</span> : null}
            <span className="u16-count">
              {plural(inputs, "input")} / {plural(outputs, "output")}
            </span>
            {row.is_enabled ? null : (
              <span className="u16-chip-off" data-u16="disabled">
                Disabled
              </span>
            )}
          </div>
          {row.description ? <p className="u16-desc">{row.description}</p> : null}
        </div>
      </div>
      <div className="u16-wf-actions">
        <button type="button" className="bd-btn is-ghost" data-u16-action="edit" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="bd-btn is-ghost" data-u16-action="view" onClick={onView}>
          <Icon name="layers" /> View I/O
        </button>
        <button type="button" className="bd-btn is-ghost" data-u16-action="toggle" disabled={busy} onClick={onToggle}>
          <Icon name={row.is_enabled ? "eyeOff" : "eye"} /> {row.is_enabled ? "Disable" : "Enable"}
        </button>
        <span className="u16-spacer" />
        <button type="button" className="bd-btn is-danger" data-u16-action="delete" disabled={busy} onClick={onDelete}>
          <Icon name="trash" /> Delete
        </button>
      </div>
    </article>
  );
}

// ── edit sheet ───────────────────────────────────────────────────────────────────────────────

function EditForm({ row, busy, onCancel, onSave }: { row: WorkflowRow; busy: boolean; onCancel: () => void; onSave: (patch: { name: string; description: string; prompt_profile: PromptProfile }) => void }) {
  const [name, setName] = useState(row.name);
  const [description, setDescription] = useState(row.description ?? "");
  const [profile, setProfile] = useState<PromptProfile>(asProfile(row.prompt_profile));
  const valid = !!name.trim();
  return (
    <>
      <div className="u16-form">
        <label className="u16-field is-wide">
          <span className="u16-label">
            Name<span className="u16-req">*</span>
          </span>
          <input className="bd-input" data-u16="edit-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="u16-field is-wide">
          <span className="u16-label">Description</span>
          <textarea className="bd-input" data-u16="edit-description" rows={2} value={description} placeholder="When to use this workflow…" onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="u16-field is-wide">
          <span className="u16-label">Prompt format</span>
          <select className="bd-input" data-u16="edit-profile" value={profile} onChange={(e) => setProfile(asProfile(e.target.value))}>
            {PROMPT_PROFILES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="u16-lock">
        <Icon name="pin" /> Workflow JSON is locked after registration — register a new workflow to change the graph.
      </div>
      <div className="bd-modal-actions">
        <button type="button" className="bd-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="bd-btn is-primary" data-u16="edit-save" disabled={!valid || busy} onClick={() => onSave({ name: name.trim(), description: description.trim(), prompt_profile: profile })}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </>
  );
}

// ── sheet: the modal chrome, portalled where the shared modal lives ─────────────────────────

function Sheet({ rootEl, kind, title, onClose, children }: { rootEl: HTMLElement | null; kind: string; title: ReactNode; onClose: () => void; children: ReactNode }) {
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
  const el = (
    <div className="bd-modal-backdrop" onPointerDown={onClose}>
      <div className="bd-modal u16-sheet" role="dialog" aria-modal="true" data-u16="sheet" data-u16-sheet={kind} onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">
          {title}
          <span className="u16-spacer" />
          <button type="button" className="bd-btn is-ghost is-icon" title="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  return rootEl ? createPortal(el, rootEl) : el;
}

// ── the title contract ───────────────────────────────────────────────────────────────────────

const ROLE_HINTS: Record<string, string> = {
  prompt: "the scene's prompt text",
  negative: "negative prompt",
  character: "character sheet / portrait",
  location: "location reference image",
  image: "a start / reference image",
  video: "a reference clip",
  audio: "an audio track",
  seed: "sampler seed",
  width: "output width",
  height: "output height",
  duration: "clip length in seconds",
};

function HintCard() {
  return (
    <section className="u16-card u16-hint" aria-label="How roles are detected">
      <div className="u16-card-title">
        <Icon name="info" /> The title contract
      </div>
      <p>
        In ComfyUI, title the node a Scene should fill as <code>Display Name (Input:role)</code>, and the node that saves the result as <code>(Output:image)</code> or{" "}
        <code>(Output:video)</code>. The display name becomes the field label; the role decides what the Director wires in. A bare <code>(Input)</code> is a free-form field.
      </p>
      <div className="u16-roles">
        {Object.entries(INPUT_ROLE_ALIASES).map(([role, all]) => {
          const aliases = all.filter((a) => a !== role);
          return (
            <div key={role} className={`u16-role-row${isPortRole(role) ? " is-port" : ""}`}>
              <b>
                {role}
                {isPortRole(role) ? <span className="u16-port">port</span> : null}
              </b>
              <span title={`${ROLE_HINTS[role] ?? ""} · aliases: ${aliases.join(", ") || "none"}`}>{aliases.length ? `aka ${aliases.join(", ")}` : ROLE_HINTS[role]}</span>
            </div>
          );
        })}
      </div>
      <p>
        A Scene's ports map onto the <code>prompt</code>, <code>character</code>, <code>location</code>, <code>image</code> and <code>video</code> roles; seed, width, height, duration and
        negative come from the render form.
      </p>
      <div className="u16-agent">
        <Icon name="sparkles" />
        <p>
          {/* The hint DESCRIBES the capability rather than naming the tool. The panel's
              vocabulary gate scans this bundle, and it only knows the names of a PUBLISHED mcp
              release — a name added in an unreleased seam reads to it as a tool that does not
              exist, and a printed name that has since moved would misdirect the model anyway. */}
          Already on the canvas? Ask the agent to <strong>register the canvas workflow</strong> — it can read the graph straight from ComfyUI, titles and all, without
          exporting anything.
        </p>
      </div>
    </section>
  );
}

registerPanel({ id: "workflows", label: "Workflows", icon: "sliders", order: 40, placement: "tab", Component: WorkflowsPanel });
