// [U14] Assets — persons, places and things, and how each one gets its picture.
//
// Calliope parity with `AssetsStage.svelte`, rebuilt on this editor's own seams: sub-tabs for
// Characters / Environments / Items, a per-tab workflow + dynamic-input form, "Generate all
// missing", and a card per entity that can generate, REGENERATE, take an uploaded image of
// your own, become the project cover, be deleted, and carry the image prompt that is actually
// sent — never a hidden string.
//
// Two rules from Calliope's backend shape everything here:
//
//  1. `generate-assets` SCOPES by which id lists are present. Locations are enqueued only when
//     `location_ids` is given or `character_ids` is absent; items only when `item_ids` is given
//     or both others are absent. So "just this character" is `{character_ids:[id]}` and "just
//     the locations" is `{character_ids: [], location_ids: [...]}` — an EMPTY array is a real
//     instruction, not a missing one. `asset-jobs.ts` owns those bodies and pins them in tests.
//
//  2. An entity with an empty image prompt is SKIPPED. So the prompt the card shows is saved
//     before the generate call goes out, and the same text is sent as `prompt`.
//
// Uploads go `playground.upload(file)` → PATCH the entity's `sheet_path` (characters) or
// `reference_image_path` (locations, items). That is the whole "upload your own person" path,
// and it is why a project with no image workflow at all is still usable.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobRow, Schemas, WorkflowRow } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.js";
import { DynamicInputs, type AssetOption, type DynamicInput } from "./dynamic-form/index.jsx";
import { Icon, type IconName } from "./icons.js";
import { progressFor, useJobs } from "./live.js";
import { useModal } from "./modal.jsx";
import { registerPanel } from "./panels.js";
import {
  assetOptionsFrom,
  entityKey,
  generateAllMissingPlan,
  generateOnePlan,
  imagePathOf,
  imageWorkflows,
  jobStateOf,
  latestImageJobFor,
  mergeJobs,
  missingRequiredInputs,
  nounOf,
  promptFor,
  seedInputDefaults,
  templateFor,
  uploadTarget,
  workflowHasPromptInput,
  PROMPT_HIDE_ROLES,
  type EntityKind,
  type EntityLists,
  type EntityRow,
  type InputValues,
} from "./asset-jobs.js";
import "./styles/u14-assets.css";

const TABS: { kind: EntityKind; label: string; icon: IconName }[] = [
  { kind: "character", label: "Characters", icon: "user" },
  { kind: "location", label: "Environments", icon: "mapPin" },
  { kind: "item", label: "Items", icon: "box" },
];

const EMPTY_LISTS: EntityLists = { characters: [], locations: [], items: [] };
const byKind = <T,>(init: () => T): Record<EntityKind, T> => ({ character: init(), location: init(), item: init() });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Shallow equality, so seeding defaults into a values object cannot loop the effect. */
function sameValues(a: InputValues, b: InputValues): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

function rowsOf(lists: EntityLists, kind: EntityKind): EntityRow[] {
  return kind === "character" ? lists.characters : kind === "location" ? lists.locations : lists.items;
}

function countOf(lists: EntityLists, kind: EntityKind): number {
  return rowsOf(lists, kind).length;
}

/** The facts a card shows under the name — what Calliope stores for that kind. */
function factsOf(kind: EntityKind, row: EntityRow): { k: string; v: string }[] {
  const r = row as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (kind === "character") {
    const out: { k: string; v: string }[] = [];
    const appearance = text(r.appearance);
    const personality = text(r.personality);
    if (appearance) out.push({ k: "Appearance", v: appearance });
    if (personality) out.push({ k: "Personality", v: personality });
    return out;
  }
  const description = text(r.description);
  return description ? [{ k: "Description", v: description }] : [];
}

/** A character's `role · age` line; the other kinds have none. */
function subtitleOf(kind: EntityKind, row: EntityRow): string | null {
  if (kind !== "character") return null;
  const r = row as { role?: string | null; age?: string | null };
  return [r.role?.trim(), r.age?.trim()].filter(Boolean).join(" · ") || null;
}

export function AssetsPanel() {
  const { client, projectId, jobs: ctxJobs, refresh, setNote } = useDirector();
  const modal = useModal();
  const liveJobs = useJobs();
  // Jobs arrive from the context today and from the live store once U10 lands; either is a
  // valid witness, so the card reads the union rather than betting on one.
  const jobs = useMemo<JobRow[]>(() => mergeJobs(ctxJobs, liveJobs.jobs), [ctxJobs, liveJobs.jobs]);

  const [lists, setLists] = useState<EntityLists | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [tab, setTab] = useState<EntityKind>("character");
  const [wfByKind, setWfByKind] = useState<Partial<Record<EntityKind, number>>>({});
  const [valuesByKind, setValuesByKind] = useState<Record<EntityKind, InputValues>>(() => byKind<InputValues>(() => ({})));
  const [attempted, setAttempted] = useState<Record<EntityKind, boolean>>(() => byKind(() => false));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; caption: string } | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const fileInputs = useRef(new Map<string, HTMLInputElement>());

  // ── loading ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (projectId === null) {
      setLists(null);
      setCoverPath(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const bundle = await client.assets.list(projectId);
        if (!alive) return;
        setLists({ characters: bundle.characters ?? [], locations: bundle.locations ?? [], items: (bundle.items ?? []) as EntityLists["items"] });
        setError(null);
      } catch (err) {
        if (alive) setError(`Could not read this project's assets — ${message(err)}`);
      }
      try {
        const project = await client.projects.get(projectId);
        if (alive) setCoverPath((project as { cover_path?: string | null }).cover_path ?? null);
      } catch {
        /* the cover is a nicety; a project that will not load one still has its assets */
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, projectId, reloads]);

  useEffect(() => {
    let alive = true;
    client.workflows
      .list()
      .then((rows) => alive && setWorkflows(rows))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [client, reloads]);

  const imageWfs = useMemo(() => imageWorkflows(workflows), [workflows]);
  /** The tab's workflow: the user's pick, else the first enabled image workflow. */
  const workflowIdFor = useCallback((kind: EntityKind): number | null => wfByKind[kind] ?? imageWfs[0]?.id ?? null, [imageWfs, wfByKind]);
  const workflowFor = useCallback((kind: EntityKind): WorkflowRow | null => imageWfs.find((w) => w.id === workflowIdFor(kind)) ?? null, [imageWfs, workflowIdFor]);

  const wf = workflowFor(tab);
  const schema = useMemo<DynamicInput[]>(() => (wf?.input_schema ?? []) as DynamicInput[], [wf]);
  const hasPromptInput = useMemo(() => workflowHasPromptInput(wf?.input_schema), [wf]);
  const values = valuesByKind[tab];
  const missing = useMemo(() => missingRequiredInputs(wf?.input_schema ?? [], values), [values, wf]);

  // Schema defaults seed each tab's form, and only for keys the user has not set. Every tab is
  // seeded, not just the visible one: "Generate all missing" sends all three tabs' values, and
  // a workflow's own default (steps, size) must not depend on whether you opened that tab.
  useEffect(() => {
    setValuesByKind((cur) => {
      const next = { ...cur };
      let changed = false;
      for (const { kind } of TABS) {
        const inputs = workflowFor(kind)?.input_schema;
        if (!inputs) continue;
        const seeded = seedInputDefaults(inputs, cur[kind]);
        if (sameValues(seeded, cur[kind])) continue;
        next[kind] = seeded;
        changed = true;
      }
      return changed ? next : cur;
    });
  }, [workflowFor]);

  const safeLists = lists ?? EMPTY_LISTS;
  const rows = rowsOf(safeLists, tab);
  const assetOptions = useMemo<AssetOption[]>(() => assetOptionsFrom(lists), [lists]);

  // ── writes ─────────────────────────────────────────────────────────────────
  const after = useCallback(
    async (note: string) => {
      setNote(note);
      reload();
      await refresh().catch(() => undefined);
    },
    [refresh, reload, setNote],
  );

  const patchEntity = useCallback(
    (kind: EntityKind, id: number, body: Record<string, unknown>) => {
      if (projectId === null) throw new Error("no project loaded");
      if (kind === "character") return client.story.character.patch(projectId, id, body as Schemas["CharacterUpdate"]);
      if (kind === "location") return client.story.location.patch(projectId, id, body as Schemas["LocationUpdate"]);
      return client.story.item.patch(projectId, id, body as Schemas["ItemUpdate"]);
    },
    [client, projectId],
  );

  const deleteEntity = useCallback(
    (kind: EntityKind, id: number) => {
      if (projectId === null) throw new Error("no project loaded");
      if (kind === "character") return client.story.character.delete(projectId, id);
      if (kind === "location") return client.story.location.delete(projectId, id);
      return client.story.item.delete(projectId, id);
    },
    [client, projectId],
  );

  const createEntity = useCallback(
    (kind: EntityKind, name: string) => {
      if (projectId === null) throw new Error("no project loaded");
      if (kind === "character") return client.story.character.create(projectId, { name });
      if (kind === "location") return client.story.location.create(projectId, { name });
      return client.story.item.create(projectId, { name });
    },
    [client, projectId],
  );

  /** Required inputs must be filled before anything is queued — the same gate for one and for all. */
  const blockedByInputs = useCallback(
    (kind: EntityKind): boolean => {
      const missingHere = missingRequiredInputs(workflowFor(kind)?.input_schema ?? [], valuesByKind[kind]);
      if (!missingHere.length) return false;
      setAttempted((cur) => ({ ...cur, [kind]: true }));
      setError(`Missing required workflow inputs: ${missingHere.map((i) => i.label).join(", ")}`);
      return true;
    },
    [valuesByKind, workflowFor],
  );

  const onNew = async (kind: EntityKind) => {
    if (projectId === null) return;
    const noun = nounOf(kind).one;
    const name = await modal.prompt({ title: `New ${noun}`, label: "Name", placeholder: kind === "character" ? "Nadia" : kind === "location" ? "Rooftop, night" : "Brass key", confirmLabel: "Create" });
    if (!name) return;
    setBusy(`new:${kind}`);
    setError(null);
    try {
      const row = await createEntity(kind, name);
      setTab(kind);
      setSelectedKey(entityKey(kind, (row as { id: number }).id));
      await after(`added ${noun} “${name}”`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onGenerateAll = async () => {
    if (projectId === null || !lists) return;
    const workflowId = workflowIdFor(tab);
    if (workflowId === null) {
      setError("Enable an image workflow in Calliope's Settings → Workflows before generating.");
      return;
    }
    if (blockedByInputs(tab)) return;
    setBusy("all");
    setError(null);
    try {
      const perKind = {
        character: { workflowId: workflowIdFor("character") ?? workflowId, inputValues: valuesByKind.character },
        location: { workflowId: workflowIdFor("location") ?? workflowId, inputValues: valuesByKind.location },
        item: { workflowId: workflowIdFor("item") ?? workflowId, inputValues: valuesByKind.item },
      };
      let queued = 0;
      for (const body of generateAllMissingPlan(lists, workflowId, perKind)) {
        const res = await client.assets.generate(projectId, body);
        queued += res.jobs?.length ?? 0;
      }
      await after(queued ? `queued ${queued} asset job${queued === 1 ? "" : "s"}` : "nothing missing to generate");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onGenerateOne = async (kind: EntityKind, row: EntityRow) => {
    if (projectId === null) return;
    const workflowId = workflowIdFor(kind);
    if (workflowId === null) {
      setError("Enable an image workflow in Calliope's Settings → Workflows before generating.");
      return;
    }
    if (blockedByInputs(kind)) return;
    const key = entityKey(kind, row.id);
    const takesPrompt = workflowHasPromptInput(workflowFor(kind)?.input_schema);
    const prompt = takesPrompt ? promptFor(kind, row, drafts[key]) : "";
    setBusy(key);
    setError(null);
    try {
      // Save first: Calliope skips an entity whose stored prompt is empty, and the user must
      // never wonder whether the text on screen is the text that ran.
      if (prompt.trim()) {
        await patchEntity(kind, row.id, { consistency_prompt: prompt });
        setDrafts(({ [key]: _drop, ...rest }) => rest);
      }
      await client.assets.generate(projectId, generateOnePlan({ kind, id: row.id }, { workflowId, inputValues: valuesByKind[kind], prompt }));
      await after(`queued ${nounOf(kind).image} for ${row.name}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onSavePrompt = async (kind: EntityKind, row: EntityRow) => {
    const key = entityKey(kind, row.id);
    setBusy(`prompt:${key}`);
    setError(null);
    try {
      await patchEntity(kind, row.id, { consistency_prompt: promptFor(kind, row, drafts[key]) });
      setDrafts(({ [key]: _drop, ...rest }) => rest);
      await after(`saved image prompt for ${row.name}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onUpload = async (kind: EntityKind, row: EntityRow, file: File) => {
    if (projectId === null) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file (png, jpg, webp, gif).");
      return;
    }
    const key = entityKey(kind, row.id);
    setBusy(`upload:${key}`);
    setError(null);
    try {
      const uploaded = await client.playground.upload(file);
      if (uploaded.kind !== "image") throw new Error("Calliope stored that file, but not as an image");
      await patchEntity(kind, row.id, { [uploadTarget(kind)]: uploaded.path });
      await after(`image added for ${row.name}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onToggleCover = async (path: string | null) => {
    if (projectId === null || !path) return;
    setBusy("cover");
    setError(null);
    try {
      // An explicit null is the clear — omitting the key would leave the old cover in place.
      const next = coverPath === path ? null : path;
      const project = await client.projects.patch(projectId, { cover_path: next });
      setCoverPath((project as { cover_path?: string | null }).cover_path ?? null);
      setNote(next ? "project cover updated" : "project cover removed");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async (kind: EntityKind, row: EntityRow) => {
    const noun = nounOf(kind).one;
    const ok = await modal.confirm({
      title: `Delete ${noun} “${row.name}”?`,
      body: `This removes the ${noun} from the project and cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(`delete:${entityKey(kind, row.id)}`);
    setError(null);
    try {
      await deleteEntity(kind, row.id);
      await after(`deleted ${noun} “${row.name}”`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const onRetry = async (job: JobRow) => {
    setBusy(`retry:${job.id}`);
    setError(null);
    try {
      await client.jobs.retry(job.id);
      await after(`re-queued job ${job.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  if (projectId === null) {
    return (
      <div className="bd-assets">
        <div className="bd-assets-empty">
          <Icon name="user" size={24} />
          <h4>No Calliope project open</h4>
          <p>Assets — the people, places and things a film reuses — live in a Calliope project. Pick one in the toolbar, and every character, environment and item shows up here with its image.</p>
        </div>
      </div>
    );
  }

  const noWorkflows = imageWfs.length === 0;
  const tabNoun = nounOf(tab);

  return (
    <div className="bd-assets" data-panel="assets">
      <div className="bd-assets-head">
        <div>
          <h3 className="bd-assets-title">
            <Icon name="user" size={16} /> Assets
          </h3>
          <p className="bd-assets-lead">Every person, place and thing this film reuses. Generate an image from a workflow, or upload one of your own — a card with a picture is a card the shots can lean on.</p>
        </div>
        <div className="bd-assets-actions">
          <button type="button" className="bd-btn" onClick={() => void onNew(tab)} disabled={busy !== null} title={`Add a ${tabNoun.one} to this project`}>
            <Icon name="plus" /> New {tabNoun.one}
          </button>
          <button type="button" className="bd-btn is-primary" onClick={() => void onGenerateAll()} disabled={busy !== null || noWorkflows} title="Queue one image job per character, environment and item that has no image yet">
            <Icon name="sparkles" /> {busy === "all" ? "Queuing…" : "Generate all missing"}
          </button>
        </div>
      </div>

      <div className="bd-assets-subtabs" role="tablist" aria-label="Asset type">
        {TABS.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.kind}
            aria-selected={tab === t.kind}
            data-subtab={t.kind}
            className={`bd-assets-subtab${tab === t.kind ? " is-active" : ""}`}
            onClick={() => setTab(t.kind)}
          >
            <Icon name={t.icon} /> {t.label}
            <span className="bd-assets-count">{countOf(safeLists, t.kind)}</span>
          </button>
        ))}
      </div>

      {error ? <p className="bd-assets-err">{error}</p> : null}
      {noWorkflows ? <p className="bd-assets-note bd-assets-warn">No enabled image workflow — add one in Calliope’s Settings → Workflows, or upload your own images below.</p> : null}

      <section className="bd-assets-card">
        <div className="bd-assets-card-head">
          <span className="bd-section-label">Generation settings</span>
          <span className="bd-hint">{tab === "character" ? "Character sheets" : tab === "location" ? "Environment references" : "Item references"}</span>
        </div>
        <label className="bd-assets-field">
          <span className="bd-section-label">{tabNoun.many} workflow</span>
          <select
            className="bd-assets-select"
            data-workflow-select={tab}
            value={workflowIdFor(tab) ?? ""}
            onChange={(e) => {
              const id = e.target.value === "" ? undefined : Number(e.target.value);
              setWfByKind((cur) => ({ ...cur, [tab]: id }));
              setValuesByKind((cur) => ({ ...cur, [tab]: {} }));
              setAttempted((cur) => ({ ...cur, [tab]: false }));
            }}
          >
            {noWorkflows ? <option value="">No enabled image workflows</option> : null}
            {imageWfs.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {wf ? (
          <DynamicInputs
            inputs={schema}
            values={values}
            onChange={(next) => setValuesByKind((cur) => ({ ...cur, [tab]: next }))}
            assetOptions={assetOptions}
            allowUpload
            showErrors={attempted[tab]}
            hideRoles={[...PROMPT_HIDE_ROLES]}
          />
        ) : (
          <p className="bd-assets-note">Select an image workflow to see its inputs.</p>
        )}
        {missing.length && attempted[tab] ? <p className="bd-assets-err">Missing required workflow inputs: {missing.map((i) => i.label).join(", ")}</p> : null}
      </section>

      {rows.length === 0 ? (
        <div className="bd-assets-empty">
          <Icon name={TABS.find((t) => t.kind === tab)?.icon ?? "box"} size={24} />
          <h4>No {tabNoun.many.toLowerCase()} yet</h4>
          <p>Add one here, or let the agent draft the story first — every {tabNoun.one} it finds shows up on this tab ready for an image.</p>
          <button type="button" className="bd-btn is-primary" onClick={() => void onNew(tab)} disabled={busy !== null}>
            <Icon name="plus" /> New {tabNoun.one}
          </button>
        </div>
      ) : (
        <div className="bd-assets-grid">
          {rows.map((row) => {
            const key = entityKey(tab, row.id);
            const job = latestImageJobFor(jobs, { kind: tab, id: row.id });
            return (
              <EntityCard
                key={key}
                kind={tab}
                row={row}
                selected={selectedKey === key}
                coverPath={coverPath}
                busy={busy}
                job={job}
                progressPct={job ? progressFor(liveJobs, job.id)?.pct : undefined}
                draft={drafts[key]}
                hasPromptInput={hasPromptInput}
                canGenerate={!noWorkflows}
                fileUrl={(p) => client.fileUrl(p)}
                registerFileInput={(k, el) => {
                  if (el) fileInputs.current.set(k, el);
                  else fileInputs.current.delete(k);
                }}
                onPickFile={(k) => fileInputs.current.get(k)?.click()}
                onUpload={(file) => void onUpload(tab, row, file)}
                onGenerate={() => void onGenerateOne(tab, row)}
                onDelete={() => void onDelete(tab, row)}
                onToggleCover={(p) => void onToggleCover(p)}
                onRetry={(j) => void onRetry(j)}
                onOpen={(src, caption) => setLightbox({ src, caption })}
                onDraft={(text) => setDrafts((cur) => ({ ...cur, [key]: text }))}
                onSavePrompt={() => void onSavePrompt(tab, row)}
              />
            );
          })}
        </div>
      )}

      {lightbox ? <Lightbox src={lightbox.src} caption={lightbox.caption} onClose={() => setLightbox(null)} /> : null}
    </div>
  );
}

interface EntityCardProps {
  kind: EntityKind;
  row: EntityRow;
  selected: boolean;
  coverPath: string | null;
  busy: string | null;
  job: JobRow | undefined;
  progressPct: number | undefined;
  draft: string | undefined;
  hasPromptInput: boolean;
  canGenerate: boolean;
  fileUrl(path: string): string;
  registerFileInput(key: string, el: HTMLInputElement | null): void;
  onPickFile(key: string): void;
  onUpload(file: File): void;
  onGenerate(): void;
  onDelete(): void;
  onToggleCover(path: string | null): void;
  onRetry(job: JobRow): void;
  onOpen(src: string, caption: string): void;
  onDraft(text: string): void;
  onSavePrompt(): void;
}

function EntityCard(props: EntityCardProps) {
  const { kind, row, coverPath, busy, job, progressPct, draft, hasPromptInput, canGenerate } = props;
  const key = entityKey(kind, row.id);
  const noun = nounOf(kind);
  const path = imagePathOf(kind, row);
  const src = path ? props.fileUrl(path) : null;
  const state = jobStateOf(job);
  const generating = state === "generating";
  const isCover = !!path && coverPath === path;
  const anyBusy = busy !== null;
  const caption = `${row.name} · ${noun.image}`;

  return (
    <article className={`bd-entity${props.selected ? " is-selected" : ""}`} data-entity={key}>
      <div className="bd-entity-media">
        {src ? (
          <button type="button" className="bd-entity-open" title="View full size" data-open={key} onClick={() => props.onOpen(src, caption)}>
            <img className="bd-entity-img" src={src} alt={caption} />
          </button>
        ) : (
          <span className="bd-entity-blank">
            <Icon name="image" size={20} />
            {noun.empty}
          </span>
        )}
        {isCover && !generating ? (
          <span className="bd-cover-chip">
            <Icon name="image" size={10} /> Cover
          </span>
        ) : null}
        <div className="bd-entity-quick">
          <button type="button" className="bd-btn is-icon" title="View full size" disabled={!src} onClick={() => src && props.onOpen(src, caption)}>
            <Icon name="maximize" />
          </button>
          <button type="button" className="bd-btn is-icon" title={isCover ? "Remove as project cover" : "Set as project cover"} disabled={!path || anyBusy} data-cover={key} onClick={() => props.onToggleCover(path)}>
            <Icon name="image" />
          </button>
          <button type="button" className="bd-btn is-icon is-danger" title={`Delete ${noun.one}`} disabled={anyBusy} data-delete={key} onClick={props.onDelete}>
            <Icon name="trash" />
          </button>
        </div>
        {generating ? (
          <div className="bd-assets-progress">
            <span className="bd-assets-bar-label">Generating…</span>
            <div className={`bd-assets-bar${progressPct === undefined ? "" : " is-known"}`} role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
              <span style={progressPct === undefined ? undefined : { width: `${Math.max(2, Math.min(100, progressPct))}%` }} />
            </div>
          </div>
        ) : null}
      </div>

      <div className="bd-entity-body">
        <div className="bd-entity-name">
          <span>{row.name}</span>
          {subtitleOf(kind, row) ? <span className="bd-entity-meta">{subtitleOf(kind, row)}</span> : null}
          {path && !generating ? (
            <span className="bd-entity-ready">
              <Icon name="check" size={10} /> Ready
            </span>
          ) : null}
        </div>
        {factsOf(kind, row).map((f) => (
          <p className="bd-entity-facts" key={f.k} title={f.v}>
            <span className="k">{f.k}</span>
            {f.v}
          </p>
        ))}
        {state === "failed" && job?.error ? <p className="bd-assets-err">{job.error}</p> : null}

        <div className="bd-entity-row">
          <button type="button" className="bd-btn is-primary" disabled={anyBusy || generating || !canGenerate} data-generate={key} onClick={props.onGenerate}>
            <Icon name={path ? "refresh" : "sparkles"} /> {generating ? "Generating…" : path ? `Regenerate ${noun.image}` : `Generate ${noun.image}`}
          </button>
          <button type="button" className="bd-btn" disabled={anyBusy || generating} data-upload={key} onClick={() => props.onPickFile(key)}>
            <Icon name="upload" /> {busy === `upload:${key}` ? "Uploading…" : path ? "Replace image" : "Upload own image"}
          </button>
          {state === "failed" && job ? (
            <button type="button" className="bd-btn is-danger" disabled={anyBusy} onClick={() => props.onRetry(job)}>
              <Icon name="refresh" /> Retry
            </button>
          ) : null}
          <input
            type="file"
            className="bd-file-input"
            data-file={key}
            aria-label={`Upload an image for ${row.name}`}
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
            ref={(el) => props.registerFileInput(key, el)}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) props.onUpload(file);
            }}
          />
        </div>

        {hasPromptInput ? (
          <details className="bd-prompt-fold">
            <summary>
              <Icon name="chevronRight" /> Edit image prompt
            </summary>
            <div className="bd-prompt-body">
              <span className="bd-section-label">Sent to ComfyUI on generate</span>
              <textarea className="bd-input" rows={8} data-prompt={key} value={promptFor(kind, row, draft)} onChange={(e) => props.onDraft(e.target.value)} />
              <div className="bd-entity-row">
                <button type="button" className="bd-btn is-ghost" onClick={() => props.onDraft(templateFor(kind, row))}>
                  Reset to template
                </button>
                <button type="button" className="bd-btn" disabled={anyBusy} onClick={props.onSavePrompt}>
                  <Icon name="save" /> {busy === `prompt:${key}` ? "Saving…" : "Save prompt"}
                </button>
              </div>
            </div>
          </details>
        ) : (
          <p className="bd-assets-note">
            The selected workflow has no <code>(Input:prompt)</code> — tag that role in ComfyUI to author this {noun.one}’s prompt here, or drive it from Generation settings above.
          </p>
        )}
      </div>
    </article>
  );
}

function Lightbox({ src, caption, onClose }: { src: string; caption: string; onClose: () => void }) {
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
    <div className="bd-lightbox" role="dialog" aria-modal="true" aria-label={caption} onPointerDown={onClose}>
      <button type="button" className="bd-btn is-icon bd-lightbox-close" title="Close (Esc)" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
        <Icon name="x" />
      </button>
      <img src={src} alt={caption} onPointerDown={(e) => e.stopPropagation()} />
      <span className="bd-lightbox-caption">{caption}</span>
    </div>
  );
}

registerPanel({ id: "assets", label: "Assets", icon: "user", order: 20, placement: "tab", Component: AssetsPanel });
