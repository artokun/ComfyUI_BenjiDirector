// The Scene editor: everything Calliope stores on a `scenes` row, plus the prompt draft.
//
// Every write is a PATCH built by `sceneDiff` (forms.ts), checked against the row Calliope
// returns with the same `verifyEcho` the canvas write-back uses, then followed by `refresh()`
// so the canvas re-merges the rows — heading, duration, Beat, refs and the continuity wire all
// flow back onto the card through the same projection a load uses.

import { useCallback, useEffect, useMemo, useState } from "react";
import { scenePromptHash, type CalliopeClient, type SceneRow, type UploadRow, type WorkflowRow } from "@benjidirector/calliope-client";
import { calId } from "../calliope-bind.js";
import { verifyEcho } from "../calliope-sync.js";
import { useDirector } from "../director-context.jsx";
import { listDriveCommands } from "../drive-registry.js";
import { Icon } from "../icons.jsx";
import { useModal, type ChooseOption } from "../modal.jsx";
import { Field, SaveIndicator, Section, Warn, useAutosave } from "./fields.jsx";
import { useHeldRefresh } from "./hold.js";
import { basename, chainWarning, isFirstScene, parseDuration, promptDraftOf, remainingOrder, sceneDiff, sceneForm, sceneIntent, videoWorkflows, type SceneForm as SceneFormValues } from "./forms.js";

// One workflow list per session, refetched when it is more than half a minute old — a select
// should not cost a request per scene click, and a workflow toggled in the Workflows tab
// should show up the next time a scene is opened.
let wfCache: { client: CalliopeClient; at: number; rows: Promise<WorkflowRow[]> } | null = null;
function useVideoWorkflows(client: CalliopeClient): { workflows: WorkflowRow[]; error: string | null } {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!wfCache || wfCache.client !== client || Date.now() - wfCache.at > 30_000) {
      wfCache = { client, at: Date.now(), rows: client.workflows.list() };
      wfCache.rows.catch(() => {
        wfCache = null;
      });
    }
    wfCache.rows.then(
      (rows) => live && setWorkflows(videoWorkflows(rows)),
      (err) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return { workflows, error };
}

export function SceneForm({ row }: { row: SceneRow }) {
  const { client, projectId, story, scenes, refresh, drive, setNote, settingsCache } = useDirector();
  const modal = useModal();
  const pid = projectId ?? row.project_id;
  const refreshHolding = useHeldRefresh(calId.scene(row.id));
  const seed = useMemo(() => sceneForm(row), [row]);
  const { form, set, save, state, dirty } = useAutosave<SceneFormValues>(seed, async (f, base) => {
    const body = sceneDiff(base, f);
    if (!body) return null;
    const echoed = await client.scenes.patch(pid, row.id, body);
    const miss = verifyEcho(sceneIntent(row.id, body), echoed);
    if (miss) throw new Error(miss.error);
    await refreshHolding();
    return Object.keys(body) as (keyof SceneFormValues)[];
  });
  const { workflows, error: wfError } = useVideoWorkflows(client);

  const beats = useMemo(() => [...(story?.beats ?? [])].sort((a, b) => a.order_index - b.order_index), [story]);
  const locations = story?.locations ?? [];
  const characters = story?.characters ?? [];
  const first = isFirstScene(row, scenes);
  const warn = chainWarning(form, workflows);
  const durationBad = parseDuration(form.duration_sec) === null;
  const blur = () => void save();

  // ── environment image ──
  const pickEnvImage = useCallback(async () => {
    const options: ChooseOption[] = [];
    for (const l of locations) if (l.reference_image_path) options.push({ id: `loc:${l.id}`, label: l.name, hint: "location reference" });
    let uploads: UploadRow[] = [];
    try {
      uploads = (await client.playground.uploads()).filter((u) => u.kind === "image");
    } catch {
      /* uploads are optional — an older Calliope has none */
    }
    for (const u of uploads) options.push({ id: `up:${u.path}`, label: u.name, hint: "upload" });
    if (form.env_image_path) options.push({ id: "clear", label: "No environment image", hint: "clear", danger: true });
    if (!options.length) {
      setNote("Nothing to pick from yet — generate a location reference in Assets, or upload an image in Playground.");
      return;
    }
    const picked = await modal.choose({ title: "Environment image", body: "The still that establishes this scene's setting. Fed to the workflow's image input.", options });
    if (!picked) return;
    const path = picked === "clear" ? null : picked.startsWith("loc:") ? (locations.find((l) => `loc:${l.id}` === picked)?.reference_image_path ?? null) : picked.slice(3);
    await save({ env_image_path: path });
  }, [client, form.env_image_path, locations, modal, save, setNote]);

  // ── prompt draft ──
  const draft = useMemo(() => promptDraftOf(row), [row]);
  const [draftText, setDraftText] = useState(draft.text);
  useEffect(() => setDraftText(draft.text), [draft.text]);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    scenePromptHash(row).then((h) => live && setHash(h)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [row]);
  const stale = draft.basedOn !== null && hash !== null && draft.basedOn !== hash;
  const [draftState, setDraftState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const saveDraft = async () => {
    setDraftState("saving");
    try {
      // The draft shares `video_settings` with the canvas's own `director.{position,promoted}`
      // writes, and those go through `settingsCache` WITHOUT re-reading the rows — so a scene
      // dragged since the last refresh has a newer settings object than `row` carries. Merging
      // onto the row would quietly put the old position back.
      const current = settingsCache.get(row.id) ?? row.video_settings;
      const out = await client.promptDraft(pid, { ...row, video_settings: current }, draftText);
      if (out?.video_settings) settingsCache.set(row.id, out.video_settings);
      await refreshHolding();
      setDraftState("saved");
    } catch (err) {
      setDraftState("failed");
      setNote(`prompt draft not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ── delete / render ──
  const del = async () => {
    const title = row.heading || `Scene ${row.order_index + 1}`;
    const ok = await modal.confirm({
      title: `Delete “${title}”?`,
      body: "The scene row leaves Calliope; the scenes after it close the gap in the cut order. A rendered clip file stays on disk.",
      confirmLabel: "Delete scene",
      danger: true,
    });
    if (!ok) return;
    try {
      await client.scenes.delete(pid, row.id);
      const rest = remainingOrder(scenes, row.id);
      if (rest.length) await client.scenes.reorder(pid, { scene_ids: rest });
      await refresh();
      setNote(`deleted “${title}”`);
    } catch (err) {
      setNote(`could not delete scene: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const canRender = listDriveCommands().includes("render_scene");
  const render = () => {
    if (!canRender) {
      setNote("The render composer is not in this build yet — the Render unit registers `render_scene`.");
      return;
    }
    drive("render_scene", { scene_id: row.id }).catch((err) => setNote(`render_scene: ${err instanceof Error ? err.message : String(err)}`));
  };

  const wf = workflows.find((w) => w.id === form.workflow_id);
  return (
    <>
      <header className="bd-insp-head">
        <span className="bd-insp-kind">
          <Icon name="clapper" /> Scene · {row.order_index + 1}
        </span>
        <span className="bd-insp-title" title={row.heading}>
          {row.heading || `Scene ${row.order_index + 1}`}
        </span>
        <SaveIndicator state={state} dirty={dirty} onRetry={blur} />
      </header>
      <div className="bd-insp-body">
        <Section title="Script">
          <Field label="Heading">
            <input className="bd-input" name="heading" value={form.heading} placeholder="INT. LOCATION - TIME" onChange={(e) => set({ heading: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Action">
            <textarea className="bd-input" name="action" rows={4} value={form.action} placeholder="What happens on screen" onChange={(e) => set({ action: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Dialog">
            <textarea className="bd-input bd-insp-mono" name="dialog" rows={4} value={form.dialog} placeholder={"CHARACTER\nLine…"} onChange={(e) => set({ dialog: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Duration" hint={durationBad ? "whole seconds, at least 1" : "seconds"} bad={durationBad}>
            <input className="bd-input" name="duration_sec" type="number" min={1} step={1} inputMode="numeric" value={form.duration_sec} onChange={(e) => set({ duration_sec: e.target.value })} onBlur={blur} />
          </Field>
        </Section>

        <Section title="Structure">
          <Field label="Beat">
            <select className="bd-input" name="beat_id" value={form.beat_id ?? ""} onChange={(e) => void save({ beat_id: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">none</option>
              {beats.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Location">
            <select className="bd-input" name="location_id" value={form.location_id ?? ""} onChange={(e) => void save({ location_id: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">none</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Characters" hint={characters.length ? `${form.character_ids.length} in scene` : undefined} block>
            {characters.length ? (
              <div className="bd-insp-chips" role="group" aria-label="Characters">
                {characters.map((c) => {
                  const on = form.character_ids.includes(c.id);
                  return (
                    <button
                      type="button"
                      key={c.id}
                      className={`bd-insp-chip${on ? " is-on" : ""}`}
                      aria-pressed={on}
                      data-character={c.id}
                      onClick={() => void save({ character_ids: on ? form.character_ids.filter((x) => x !== c.id) : [...form.character_ids, c.id] })}
                    >
                      <Icon name={on ? "check" : "user"} size={12} /> {c.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="bd-insp-note">No characters in this project yet.</div>
            )}
          </Field>
        </Section>

        <Section title="Render setup">
          <Field label="Workflow" hint={wfError ? "could not list workflows" : undefined} bad={!!wfError}>
            <select className="bd-input" name="workflow_id" value={form.workflow_id ?? ""} onChange={(e) => void save({ workflow_id: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">default</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
              {form.workflow_id !== null && !wf ? <option value={form.workflow_id}>workflow #{form.workflow_id} (not enabled)</option> : null}
            </select>
          </Field>
          <label className={`bd-insp-toggle${first ? " is-disabled" : ""}`} title={first ? "The first scene has nothing before it" : "Feed the previous scene's last frame into this one"}>
            <input type="checkbox" name="chain_from_prev" checked={form.chain_from_prev} disabled={first} onChange={(e) => void save({ chain_from_prev: e.target.checked })} />
            <span>Chain from previous scene</span>
          </label>
          {first ? <div className="bd-insp-note">First in the cut — nothing to chain from.</div> : null}
          {warn ? <Warn>{warn}</Warn> : null}
          <Field label="Environment image" block>
            {form.env_image_path ? (
              <img className="bd-insp-thumb" src={client.fileUrl(form.env_image_path)} alt="Environment" title={form.env_image_path} />
            ) : (
              <div className="bd-insp-note">None — the workflow's image input stays empty.</div>
            )}
            <div className="bd-insp-actions">
              <button type="button" className="bd-btn" onClick={() => void pickEnvImage()}>
                <Icon name="image" /> {form.env_image_path ? "Change" : "Pick"}
              </button>
              {form.env_image_path ? (
                <button type="button" className="bd-btn is-ghost" onClick={() => void save({ env_image_path: null })}>
                  <Icon name="x" /> Clear
                </button>
              ) : null}
            </div>
          </Field>
        </Section>

        <Section title="Clip">
          {row.video_path ? (
            <>
              <video className="bd-insp-thumb" src={client.fileUrl(row.video_path)} controls muted preload="metadata" />
              <div className="bd-insp-row">
                <code className="bd-insp-path" title={row.video_path}>
                  {basename(row.video_path)}
                </code>
                <a className="bd-btn" href={client.fileUrl(row.video_path)} download={basename(row.video_path)} target="_blank" rel="noreferrer">
                  <Icon name="download" /> Download
                </a>
              </div>
            </>
          ) : (
            <div className="bd-insp-note">No clip rendered yet.</div>
          )}
          <div className="bd-insp-actions">
            <button type="button" className="bd-btn is-primary" onClick={render} title={canRender ? "Open the composer on this scene" : "The render composer is not in this build yet"}>
              <Icon name="play" /> Render this scene
            </button>
          </div>
          {!canRender ? <div className="bd-insp-note">Rendering opens the composer once the Render unit is in the build.</div> : null}
        </Section>

        <Section
          title="Prompt draft"
          aside={
            draft.basedOn ? (
              stale ? (
                <span className="bd-chip-state warn">stale</span>
              ) : (
                <span className="bd-chip-state ok">fresh</span>
              )
            ) : null
          }
        >
          {stale ? <Warn>The draft was written against an older version of this scene — Calliope will ignore it and run its own model. Save it again to make it current.</Warn> : null}
          <textarea className="bd-input" name="prompt_draft" rows={5} value={draftText} placeholder="The exact prompt Calliope should render with — leave empty to let it draft one." onChange={(e) => setDraftText(e.target.value)} />
          <div className="bd-insp-row">
            <button type="button" className="bd-btn" disabled={!draftText.trim() || dirty || draftState === "saving"} title={dirty ? "Save the scene edits first — the draft is stamped against the saved text" : undefined} onClick={() => void saveDraft()}>
              <Icon name="save" /> {draftState === "saving" ? "Saving…" : "Save draft"}
            </button>
            {draftState === "saved" ? (
              <span className="bd-insp-save is-saved">
                <Icon name="check" /> Draft saved
              </span>
            ) : draftState === "failed" ? (
              <span className="bd-insp-save is-failed">Failed</span>
            ) : draft.authoredBy ? (
              <span className="bd-insp-note">by {draft.authoredBy}</span>
            ) : null}
          </div>
        </Section>

        <Section title="Danger">
          <button type="button" className="bd-btn is-danger" onClick={() => void del()}>
            <Icon name="trash" /> Delete scene
          </button>
        </Section>
      </div>
    </>
  );
}
