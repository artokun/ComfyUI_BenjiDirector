// U11 — the Settings tab: Calliope's own settings, minus everything about its LLM.
//
// Three sections mirror Calliope's settings page (ComfyUI, Queue, Storage). No LLM or agent
// keys are rendered on purpose: the agent in the panel is the only model in the loop, so a
// field for Calliope's model would be a field that changes nothing. The draft holds only what
// was touched; Save sends only what differs (see `settings-form.ts`); switching tabs keeps the
// draft and says so in the note.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CalliopeSettings, Schemas } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.jsx";
import { Icon } from "./icons.jsx";
import { registerPanel } from "./panels.js";
import { NUMERIC_LIMITS, clampNumber, countChanges, diffSettings, normalizeText, type NumericKey, type SettingsDraft, type TextKey } from "./settings-form.js";
import "./styles/u11-project-settings.css";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Survives a tab switch: the leave-guard is a note, not a prompt, so the draft must not vanish. */
const kept: { draft: SettingsDraft } = { draft: {} };

function Field({ label, htmlFor, hint, dirty, children }: { label: string; htmlFor: string; hint?: ReactNode; dirty?: boolean; children: ReactNode }) {
  return (
    <div className={`bd-u11-field${dirty ? " is-dirty" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="bd-u11-hint">{hint}</span> : null}
    </div>
  );
}

export function SettingsPanel() {
  const { client, status, setNote } = useDirector();
  const [saved, setSaved] = useState<CalliopeSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraftState] = useState<SettingsDraft>(() => kept.draft);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reachable = !!status?.reachable;

  const setDraft = useCallback((fn: (d: SettingsDraft) => SettingsDraft) => {
    setDraftState((d) => {
      const next = fn(d);
      kept.draft = next;
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      setSaved(await client.settings.get());
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, [client]);

  useEffect(() => {
    if (reachable) void load();
  }, [load, reachable]);

  const changes = saved ? diffSettings(saved, draft) : {};
  const dirtyCount = countChanges(changes);
  const dirty = dirtyCount > 0;

  // Leave-guard: the tab strip is outside this panel, so the guard is what the unmount sees.
  // Coming back, a kept draft says so, so the "open Settings" note is not left standing.
  const dirtyRef = useRef(0);
  dirtyRef.current = dirtyCount;
  useEffect(() => {
    if (Object.keys(kept.draft).length) setNote("Settings: your unsaved changes are back — save or discard them below");
    return () => {
      if (dirtyRef.current > 0) setNote(`Settings: ${dirtyRef.current} unsaved change${dirtyRef.current === 1 ? "" : "s"} kept — open Settings to save or discard`);
    };
  }, [setNote]);

  const text = (key: TextKey) => draft[key] ?? String(saved?.[key] ?? "");
  const num = (key: NumericKey) => draft[key] ?? String(saved?.[key] ?? "");
  const isDirty = (key: keyof typeof changes) => key in changes;

  const setText = (key: TextKey, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const blurText = (key: TextKey) =>
    setDraft((d) => {
      const raw = d[key];
      if (raw === undefined) return d;
      const next = normalizeText(key, raw);
      // Empty reverts, like an empty numeric field: diffSettings refuses to send a blank
      // setting, so the box must not keep showing one it will not save.
      if (!next || next === String(saved?.[key] ?? "")) {
        const { [key]: _drop, ...rest } = d;
        return rest;
      }
      return { ...d, [key]: next };
    });
  const setNum = (key: NumericKey, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  /** Clamp on blur — the input shows what will be sent, and an empty field goes back to the saved value. */
  const blurNum = (key: NumericKey) =>
    setDraft((d) => {
      const raw = d[key];
      if (raw === undefined) return d;
      const next = clampNumber(key, raw);
      if (next === null || next === Number(saved?.[key])) {
        const { [key]: _drop, ...rest } = d;
        return rest;
      }
      return { ...d, [key]: String(next) };
    });

  const discard = () => {
    setDraft(() => ({}));
    setSaveError(null);
  };

  const save = async () => {
    if (!saved || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await client.settings.set(changes as Schemas["SettingsUpdate"]);
      setSaved(next);
      setDraft(() => ({}));
      setNote(`settings saved — ${dirtyCount} change${dirtyCount === 1 ? "" : "s"}`);
    } catch (err) {
      setSaveError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const numberField = (key: NumericKey, id: string, label: string, hint?: ReactNode) => {
    const lim = NUMERIC_LIMITS[key];
    return (
      <Field label={label} htmlFor={id} dirty={isDirty(key)} hint={hint}>
        <input
          id={id}
          className="bd-input form"
          type="number"
          min={lim.min}
          max={lim.max}
          step={lim.step}
          value={num(key)}
          disabled={!saved}
          onChange={(e) => setNum(key, e.target.value)}
          onBlur={() => blurNum(key)}
        />
      </Field>
    );
  };

  return (
    <div className="bd-u11-settings" data-testid="u11-settings">
      <div className="bd-u11-settings-head">
        <div>
          <div className="bd-u11-eyebrow">Calliope</div>
          <h2 className="bd-u11-h1">Settings</h2>
          <p className="bd-u11-lead">Where Calliope renders, how hard it pushes the queue, and where it keeps what it makes.</p>
        </div>
        <button type="button" className="bd-btn" onClick={() => void load()} disabled={!reachable} title="Re-read settings from Calliope">
          <Icon name="refresh" /> Reload
        </button>
      </div>

      <section className="bd-u11-card">
        <h3>
          <Icon name="zap" /> Calliope
        </h3>
        <div className="bd-u11-status" data-testid="u11-calliope-status">
          {status === null ? (
            <span className="bd-chip-state">checking…</span>
          ) : status.reachable ? (
            <span className="bd-chip-state ok">reachable</span>
          ) : (
            <span className="bd-chip-state err">unreachable</span>
          )}
          <span className="bd-u11-kv">
            <span>Version</span>
            <b>{status?.reachable ? (status.health.version ?? "unknown") : "—"}</b>
          </span>
          <span className="bd-u11-kv">
            <span>Base URL</span>
            <b>
              <code>{status?.baseUrl ?? client.baseUrl}</code>
            </b>
          </span>
          {status?.reachable && status.health.dry_run !== undefined ? (
            <span className="bd-u11-kv">
              <span>Mode</span>
              <b>{status.health.dry_run ? "dry run" : "live"}</b>
            </span>
          ) : null}
          {status && !status.reachable ? <span className="bd-u11-hint">{status.reason} — ask the agent to bring it up, or run “npm run calliope:up”.</span> : null}
        </div>
      </section>

      {loadError ? (
        <div className="bd-u11-callout is-bad">
          <Icon name="alert" size={16} />
          <span>Could not read settings: {loadError}</span>
        </div>
      ) : null}

      <section className="bd-u11-card">
        <h3>
          <Icon name="image" /> ComfyUI
        </h3>
        <p className="bd-u11-lead">The render farm Calliope sends image and video jobs to.</p>
        <Field
          label="Base URL"
          htmlFor="u11-comfy-url"
          dirty={isDirty("comfyui_base_url")}
          hint="Calliope talks to Comfy over HTTP only. Comfy's own input/output folders stay in ComfyUI — set them there, not here."
        >
          <input id="u11-comfy-url" className="bd-input form" value={text("comfyui_base_url")} disabled={!saved} placeholder="http://127.0.0.1:8188" onChange={(e) => setText("comfyui_base_url", e.target.value)} onBlur={() => blurText("comfyui_base_url")} />
        </Field>
        <label className={`bd-u11-check${isDirty("dry_run") ? " is-dirty" : ""}`}>
          <input type="checkbox" checked={draft.dry_run ?? !!saved?.dry_run} disabled={!saved} onChange={(e) => setDraft((d) => ({ ...d, dry_run: e.target.checked }))} />
          <span>
            <b>Dry-run mode</b> — skip ComfyUI and write placeholder assets. For testing the pipeline only; off by default.
          </span>
        </label>
      </section>

      <section className="bd-u11-card">
        <h3>
          <Icon name="layers" /> Queue
        </h3>
        <p className="bd-u11-lead">Worker concurrency and retry behaviour for long GPU jobs.</p>
        <div className="bd-u11-grid is-2">
          {numberField("queue_concurrency", "u11-concurrency", "Concurrency", "1–8 jobs at once. More than your GPUs can hold just queues inside Comfy.")}
          {numberField("queue_max_retries", "u11-retries", "Max retries", "0–10 attempts after a failed job.")}
          {numberField("queue_poll_interval_sec", "u11-poll-interval", "Poll interval (seconds)", "0.5–60 s between checks on a running job.")}
          {numberField(
            "queue_poll_timeout_sec",
            "u11-poll-timeout",
            "Poll timeout (seconds, 0 = no limit)",
            "How long the worker waits on ComfyUI before failing a job. Long video generations can exceed 10 minutes — raise this, or set 0 to wait indefinitely.",
          )}
        </div>
      </section>

      <section className="bd-u11-card">
        <h3>
          <Icon name="folder" /> Storage
        </h3>
        <p className="bd-u11-lead">Where Calliope keeps SQLite and generated assets on disk.</p>
        <div className="bd-u11-callout">
          <Icon name="alert" size={16} />
          <span>
            <b>Changing storage paths moves where Calliope writes data.</b> Do not point these at temporary folders — they are wiped. Wrapping quotes from “Copy as path” are stripped for you.
          </span>
        </div>
        <div className="bd-u11-grid is-2">
          <Field
            label="Data directory"
            htmlFor="u11-data-dir"
            dirty={isDirty("data_dir")}
            hint={
              <>
                Current: <code>{saved?.data_dir ?? "—"}</code>
              </>
            }
          >
            <input id="u11-data-dir" className="bd-input form" value={text("data_dir")} disabled={!saved} onChange={(e) => setText("data_dir", e.target.value)} onBlur={() => blurText("data_dir")} spellCheck={false} />
          </Field>
          <Field
            label="Assets directory"
            htmlFor="u11-assets-dir"
            dirty={isDirty("assets_dir")}
            hint={
              <>
                Current: <code>{saved?.assets_dir ?? "—"}</code>
              </>
            }
          >
            <input id="u11-assets-dir" className="bd-input form" value={text("assets_dir")} disabled={!saved} onChange={(e) => setText("assets_dir", e.target.value)} onBlur={() => blurText("assets_dir")} spellCheck={false} />
          </Field>
        </div>
      </section>

      <div className="bd-u11-note">
        <Icon name="info" size={14} />
        <span>LLM settings are unused here — the agent in the panel is the only model in the loop.</span>
      </div>

      <div className={`bd-u11-actions${dirty ? " is-dirty" : ""}`} data-testid="u11-settings-actions">
        <span className="bd-u11-actions-text">
          {!reachable ? "Settings load once Calliope answers." : !saved ? (loadError ? "Settings could not be read." : "Reading settings…") : dirty ? `${dirtyCount} unsaved change${dirtyCount === 1 ? "" : "s"}` : "Everything is saved."}
          {saveError ? <span className="bd-u11-error"> Save failed: {saveError}</span> : null}
        </span>
        <button type="button" className="bd-btn" onClick={discard} disabled={!dirty || saving}>
          Discard
        </button>
        <button type="button" className="bd-btn is-primary" onClick={() => void save()} disabled={!dirty || saving} data-testid="u11-settings-save">
          <Icon name="save" /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

registerPanel({ id: "settings", label: "Settings", icon: "settings", order: 90, placement: "tab", Component: SettingsPanel });
