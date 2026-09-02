// U11 — the project menu: which Calliope project the canvas shows, and that project's record.
//
// Replaces the toolbar's <select>. A glass popover with the project list (search, status chip,
// stats, cover), a "Demo project" entry, a New-project form carrying the beat/scene budget
// ported from Calliope, and — for the loaded project — rename / edit details / set status /
// delete. Every write goes through the Calliope client and is followed by `refresh()` (the
// canvas MERGES, so an edit here never costs the layout) or `loadProject()` when the film
// itself changes. Modals come from `useModal()`; there is no window.prompt anywhere here.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Schemas, StoryBundle } from "@benjidirector/calliope-client";
import { useDirector } from "./director-context.jsx";
import { budgetHint } from "./duration-budget.js";
import { Icon } from "./icons.jsx";
import { useModal } from "./modal.jsx";
import {
  CUSTOM,
  DEFAULTS,
  DURATIONS,
  GENRES,
  STATUSES,
  TONES,
  coverPath,
  filterProjects,
  pick,
  projectStats,
  relativeTime,
  resolve,
  statusLabel,
  statusTone,
  validateTitle,
  type Project,
} from "./project-menu.js";
import { registerSlot } from "./slots.jsx";
import "./styles/u11-project-settings.css";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The form's fields. Each preset select is a (sel, custom) pair — see `pick`/`resolve`. */
interface FormState {
  title: string;
  idea: string;
  genre: string;
  genreCustom: string;
  tone: string;
  toneCustom: string;
  duration: string;
  durationCustom: string;
}

const blankForm = (): FormState => ({
  title: "",
  idea: "",
  genre: DEFAULTS.genre,
  genreCustom: "",
  tone: DEFAULTS.tone,
  toneCustom: "",
  duration: DEFAULTS.duration,
  durationCustom: "",
});

const formFor = (p: Project): FormState => {
  const g = pick(p.genre, GENRES, DEFAULTS.genre);
  const t = pick(p.tone, TONES, DEFAULTS.tone);
  const d = pick(p.target_duration, DURATIONS, DEFAULTS.duration);
  return { title: p.title, idea: p.idea ?? "", genre: g.sel, genreCustom: g.custom, tone: t.sel, toneCustom: t.custom, duration: d.sel, durationCustom: d.custom };
};

type View = { kind: "list" } | { kind: "create" } | { kind: "edit"; project: Project };

/** A select over presets with a trailing "Custom…" that opens a free-text field. */
function PresetField({
  id,
  label,
  presets,
  sel,
  custom,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  presets: readonly string[];
  sel: string;
  custom: string;
  onChange: (sel: string, custom: string) => void;
  hint?: ReactNode;
}) {
  return (
    <div className="bd-u11-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="bd-input form" value={sel} onChange={(e) => onChange(e.target.value, custom)}>
        {presets.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {sel === CUSTOM ? (
        <input
          id={`${id}-custom`}
          className="bd-input form"
          autoFocus
          placeholder={`Your own ${label.toLowerCase()}`}
          value={custom}
          onChange={(e) => onChange(sel, e.target.value)}
        />
      ) : null}
      {hint ? <span className="bd-u11-hint">{hint}</span> : null}
    </div>
  );
}

/** The New-project and Edit-details form. `mode` only changes the copy and which fields show. */
function ProjectForm({
  mode,
  initial,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  initial: FormState;
  busy: boolean;
  error: string | null;
  onSubmit: (f: FormState) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<FormState>(initial);
  const [touched, setTouched] = useState(false);
  const titleError = touched ? validateTitle(f.title) : null;
  const duration = resolve(f.duration, f.durationCustom);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (validateTitle(f.title)) return;
    onSubmit(f);
  };
  return (
    <form className="bd-u11-form" onSubmit={submit} data-testid={`u11-project-form-${mode}`}>
      <div className="bd-u11-form-head">
        <div>
          <div className="bd-u11-eyebrow">{mode === "create" ? "New reel" : "Project details"}</div>
          <div className="bd-u11-form-title">{mode === "create" ? "New project" : initial.title}</div>
        </div>
        <button type="button" className="bd-btn is-ghost is-icon" onClick={onCancel} title="Back to the list" aria-label="Back to the list">
          <Icon name="x" />
        </button>
      </div>
      {mode === "create" ? (
        <div className={`bd-u11-field${titleError ? " is-bad" : ""}`}>
          <label htmlFor="u11-title">Title</label>
          <input
            id="u11-title"
            className="bd-input form"
            autoFocus
            maxLength={200}
            placeholder="Moonlit Harbor"
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
            onBlur={() => setTouched(true)}
          />
          {titleError ? <span className="bd-u11-error">{titleError}</span> : null}
        </div>
      ) : null}
      <div className="bd-u11-field">
        <label htmlFor="u11-idea">Story idea</label>
        <textarea
          id="u11-idea"
          className="bd-input form"
          rows={3}
          placeholder="A lighthouse keeper finds a glowing bottle that shows memories of sailors lost at sea…"
          value={f.idea}
          onChange={(e) => setF({ ...f, idea: e.target.value })}
        />
        <span className="bd-u11-hint">Optional — the agent drafts the story from it; you can refine it on the canvas.</span>
      </div>
      <div className="bd-u11-grid">
        <PresetField id="u11-genre" label="Genre" presets={GENRES} sel={f.genre} custom={f.genreCustom} onChange={(genre, genreCustom) => setF({ ...f, genre, genreCustom })} />
        <PresetField id="u11-tone" label="Tone" presets={TONES} sel={f.tone} custom={f.toneCustom} onChange={(tone, toneCustom) => setF({ ...f, tone, toneCustom })} />
      </div>
      <PresetField
        id="u11-duration"
        label="Target duration"
        presets={DURATIONS}
        sel={f.duration}
        custom={f.durationCustom}
        onChange={(d, durationCustom) => setF({ ...f, duration: d, durationCustom })}
        hint={
          <span data-testid="u11-budget">
            {budgetHint(duration)} — guides how many beats and scenes the agent drafts.
          </span>
        }
      />
      {error ? <div className="bd-u11-error">{error}</div> : null}
      <div className="bd-u11-form-actions">
        <button type="button" className="bd-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="bd-btn is-primary" disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create project" : "Save details"}
        </button>
      </div>
    </form>
  );
}

function Cover({ src, title }: { src: string | null; title: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span className="bd-u11-cover" aria-hidden>
      {src && !broken ? <img src={src} alt="" title={title} loading="lazy" onError={() => setBroken(true)} /> : <Icon name="film" size={16} />}
    </span>
  );
}

function StatusChip({ status }: { status: string | null | undefined }) {
  const tone = statusTone(status);
  return <span className={`bd-chip-state${tone ? ` ${tone}` : ""}`}>{statusLabel(status)}</span>;
}

export function ProjectMenu() {
  const { client, status, projectId, story, loadProject, refresh, setNote } = useDirector();
  const modal = useModal();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  /** Stories fetched for cover fallbacks, keyed by project id + updated_at so a change refetches. */
  const storyCache = useRef(new Map<string, StoryBundle | null>());
  const [, bump] = useState(0);

  const reachable = !!status?.reachable;
  const title = story?.project.title ?? "Demo project";
  const current = useMemo(() => (projectId !== null ? (projects ?? []).find((p) => p.id === projectId) : undefined), [projectId, projects]);

  const loadList = useCallback(async () => {
    if (!reachable) return;
    try {
      const list = await client.projects.list();
      setProjects(list);
      setListError(null);
      // Cover fallback: a project without a cover shows its first character sheet. Bounded so a
      // long list does not fan out into dozens of story reads, and cached by updated_at.
      const want = list.filter((p) => !p.cover_path).slice(0, 12);
      await Promise.all(
        want.map(async (p) => {
          const key = `${p.id}:${p.updated_at}`;
          if (storyCache.current.has(key)) return;
          try {
            storyCache.current.set(key, await client.story.get(p.id));
          } catch {
            storyCache.current.set(key, null);
          }
        }),
      );
      bump((n) => n + 1);
    } catch (err) {
      setListError(errText(err));
    }
  }, [client, reachable]);

  // Open: reset to the list and (re)read it. Close: forget the search.
  useEffect(() => {
    if (!open) return;
    setView({ kind: "list" });
    setFormError(null);
    void loadList();
  }, [loadList, open]);

  // Outside click / Escape closes. Capture phase so a click on the canvas closes the menu even
  // when React Flow stops propagation.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  const storyFor = (p: Project): StoryBundle | null => {
    if (story && story.project.id === p.id) return story;
    return storyCache.current.get(`${p.id}:${p.updated_at}`) ?? null;
  };

  const coverUrl = (p: Project): string | null => {
    const path = coverPath(p, storyFor(p));
    return path ? client.fileUrl(path) : null;
  };

  // ── mutations ──────────────────────────────────────────────────────────────────────

  const create = async (f: FormState) => {
    setBusy(true);
    setFormError(null);
    try {
      const body: Schemas["ProjectCreate"] = {
        title: f.title.trim(),
        idea: f.idea.trim() || null,
        genre: resolve(f.genre, f.genreCustom) || null,
        tone: resolve(f.tone, f.toneCustom) || null,
        target_duration: resolve(f.duration, f.durationCustom) || null,
      };
      const created = await client.projects.create(body);
      close();
      await loadProject(created.id);
    } catch (err) {
      setFormError(`Calliope did not create the project: ${errText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const editDetails = async (p: Project, f: FormState) => {
    setBusy(true);
    setFormError(null);
    try {
      const body: Schemas["ProjectUpdate"] = {
        idea: f.idea.trim() || null,
        genre: resolve(f.genre, f.genreCustom) || null,
        tone: resolve(f.tone, f.toneCustom) || null,
        target_duration: resolve(f.duration, f.durationCustom) || null,
      };
      await client.projects.patch(p.id, body);
      if (projectId === p.id) await refresh();
      setNote(`updated “${p.title}”`);
      setView({ kind: "list" });
      await loadList();
    } catch (err) {
      setFormError(`Calliope did not save the details: ${errText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (p: Project) => {
    close();
    const next = await modal.prompt({ title: "Rename project", label: "Title", defaultValue: p.title, confirmLabel: "Rename" });
    if (next === null) return;
    const problem = validateTitle(next);
    if (problem) return setNote(problem);
    const t = next.trim();
    if (t === p.title) return;
    try {
      await client.projects.patch(p.id, { title: t });
      if (projectId === p.id) await refresh();
      setNote(`renamed to “${t}”`);
    } catch (err) {
      setNote(`could not rename: ${errText(err)}`);
    }
    return undefined;
  };

  const setStatus = async (p: Project) => {
    close();
    const id = await modal.choose({
      title: `Status of “${p.title}”`,
      body: `Currently ${statusLabel(p.status)}.`,
      options: STATUSES.map((s) => ({ id: s.id, label: s.label, hint: s.hint })),
    });
    if (!id || id === p.status) return;
    try {
      await client.projects.patch(p.id, { status: id });
      if (projectId === p.id) await refresh();
      setNote(`“${p.title}” is now ${statusLabel(id)}`);
    } catch (err) {
      setNote(`could not set status: ${errText(err)}`);
    }
  };

  const remove = async (p: Project) => {
    close();
    const ok = await modal.confirm({
      title: `Delete “${p.title}”?`,
      body: "This deletes the project and its story data from Calliope. Generated asset files stay on disk. This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await client.projects.delete(p.id);
      setNote(`deleted “${p.title}” — its asset files are still on disk`);
      if (projectId === p.id) await loadProject(null);
    } catch (err) {
      setNote(`could not delete: ${errText(err)}`);
    }
  };

  const openProject = async (id: number | null) => {
    close();
    await loadProject(id);
  };

  // ── render ─────────────────────────────────────────────────────────────────────────

  const filtered = filterProjects(projects ?? [], query);
  const loaded = current ?? (story && projectId !== null ? ({ ...story.project, id: projectId, created_at: "", updated_at: "" } as Project) : undefined);

  return (
    <span className="bd-u11" ref={wrapRef}>
      <button
        type="button"
        className={`bd-u11-trigger${open ? " is-open" : ""}`}
        title="Which Calliope project the canvas shows"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="u11-project-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="film" />
        <span className="bd-u11-trigger-title">{title}</span>
        <Icon name="chevronDown" className="is-chev" />
      </button>
      {open ? (
        <div className="bd-u11-pop" role="menu" data-testid="u11-project-menu">
          {view.kind === "create" ? (
            <ProjectForm key="create" mode="create" initial={blankForm()} busy={busy} error={formError} onSubmit={(f) => void create(f)} onCancel={() => setView({ kind: "list" })} />
          ) : view.kind === "edit" ? (
            <ProjectForm key={`edit-${view.project.id}`} mode="edit" initial={formFor(view.project)} busy={busy} error={formError} onSubmit={(f) => void editDetails(view.project, f)} onCancel={() => setView({ kind: "list" })} />
          ) : (
            <>
              <div className="bd-u11-head">
                <label className="bd-u11-search">
                  <Icon name="search" />
                  <input
                    className="bd-input"
                    placeholder="Search projects"
                    value={query}
                    autoFocus
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Search projects"
                  />
                </label>
                <button type="button" className="bd-btn is-primary" onClick={() => setView({ kind: "create" })} disabled={!reachable} data-testid="u11-new-project">
                  <Icon name="plus" /> New
                </button>
              </div>

              {loaded ? (
                <div className="bd-u11-current" data-testid="u11-current">
                  <div className="bd-u11-row-title">
                    <span>{loaded.title}</span>
                    <StatusChip status={loaded.status} />
                  </div>
                  <div className="bd-u11-row-meta">
                    {current ? <span>{projectStats(current)}</span> : null}
                    {[loaded.genre, loaded.tone, loaded.target_duration].filter(Boolean).map((s) => (
                      <span key={s as string}>{s}</span>
                    ))}
                  </div>
                  <div className="bd-u11-tools">
                    <button type="button" className="bd-btn" onClick={() => void rename(loaded)} title="Rename this project">
                      <Icon name="text" /> Rename
                    </button>
                    <button type="button" className="bd-btn" onClick={() => setView({ kind: "edit", project: loaded })} title="Idea, genre, tone, duration">
                      <Icon name="sliders" /> Edit details
                    </button>
                    <button type="button" className="bd-btn" onClick={() => void setStatus(loaded)} title="Draft, in progress, or ready">
                      <Icon name="check" /> Status
                    </button>
                    <button type="button" className="bd-btn is-danger" onClick={() => void remove(loaded)} title="Delete from Calliope (asset files stay on disk)">
                      <Icon name="trash" /> Delete
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="bd-u11-list" role="list">
                <div className="bd-u11-list-head">Projects</div>
                <button
                  type="button"
                  role="listitem"
                  className={`bd-u11-row is-demo${projectId === null ? " is-current" : ""}`}
                  onClick={() => void openProject(null)}
                  data-project-id="demo"
                >
                  <span className="bd-u11-cover is-demo" aria-hidden>
                    <Icon name="clapper" size={16} />
                  </span>
                  <span className="bd-u11-row-main">
                    <span className="bd-u11-row-title">
                      <span>Demo project</span>
                    </span>
                    <span className="bd-u11-row-meta">
                      <span>Local sample graph — nothing is written to Calliope</span>
                    </span>
                  </span>
                  {projectId === null ? <Icon name="check" className="bd-u11-row-check" /> : <span />}
                </button>

                {!reachable ? (
                  <div className="bd-u11-empty">
                    {status === null ? "Checking Calliope…" : `Calliope is not answering at ${status.baseUrl} — ${status.reason}. Ask the agent to bring it up.`}
                  </div>
                ) : listError ? (
                  <div className="bd-u11-empty">
                    Could not list projects: {listError}{" "}
                    <button type="button" className="bd-btn is-ghost" onClick={() => void loadList()}>
                      <Icon name="refresh" /> Retry
                    </button>
                  </div>
                ) : projects === null ? (
                  <div className="bd-u11-empty">Loading projects…</div>
                ) : filtered.length === 0 ? (
                  <div className="bd-u11-empty">{projects.length === 0 ? "No projects yet — make one above." : `Nothing matches “${query}”.`}</div>
                ) : (
                  filtered.map((p) => (
                    <button
                      type="button"
                      role="listitem"
                      key={p.id}
                      className={`bd-u11-row is-project${p.id === projectId ? " is-current" : ""}`}
                      onClick={() => void openProject(p.id)}
                      data-project-id={p.id}
                      title={p.idea ?? undefined}
                    >
                      <Cover src={coverUrl(p)} title={p.title} />
                      <span className="bd-u11-row-main">
                        <span className="bd-u11-row-title">
                          <span>{p.title}</span>
                          <StatusChip status={p.status} />
                        </span>
                        <span className="bd-u11-row-meta">
                          <span>{projectStats(p)}</span>
                          {p.genre ? <span>{p.genre}</span> : null}
                        </span>
                      </span>
                      <span className="bd-u11-row-time" title={p.updated_at}>
                        {p.id === projectId ? <Icon name="check" className="bd-u11-row-check" /> : relativeTime(p.updated_at)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}

registerSlot("toolbar-right", ProjectMenu, { order: 10, id: "u11-project-menu" });
