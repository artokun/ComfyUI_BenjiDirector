// The inspector's shared pieces: the autosave hook and the field chrome every form uses.
//
// Autosave is blur-driven: a field edits local state as you type, and the blur (or a discrete
// change on a select / toggle / chip) diffs the form against its baseline and writes ONCE.
// The baseline is the row as the server has it — seeded from the row, advanced by every
// successful write, and merged when a refresh brings a new row in: fields the user has not
// touched take the new value, fields they have keep theirs. That merge is what lets the
// agent edit a scene while the user has the same scene open.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../icons.jsx";

export type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; error: string };

const eq = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
};

export function shallowEq<F extends object>(a: F, b: F): boolean {
  const ka = Object.keys(a) as (keyof F)[];
  const kb = Object.keys(b) as (keyof F)[];
  if (ka.length !== kb.length) return false;
  return ka.every((k) => eq(a[k], b[k]));
}

export interface Autosave<F extends object> {
  form: F;
  /** Edit fields locally (no write). */
  set(patch: Partial<F>): void;
  /** Diff against the baseline and write. With `next`, apply it first — for a select or a toggle. */
  save(next?: Partial<F>): Promise<void>;
  state: SaveState;
  /** Something is edited and not yet written. */
  dirty: boolean;
}

/**
 * @param seed  the row as a form snapshot; memoise it on the row so a refresh is a new object
 * @param commit  write the diff `form − base`; resolve with the keys written (null: nothing to write); throw on failure
 */
export function useAutosave<F extends object>(seed: F, commit: (form: F, base: F) => Promise<ReadonlyArray<keyof F> | null>): Autosave<F> {
  const [form, setFormState] = useState<F>(seed);
  const formRef = useRef<F>(seed);
  const baseline = useRef<F>(seed);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const chain = useRef<Promise<void>>(Promise.resolve());
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setForm = useCallback((next: F) => {
    formRef.current = next;
    setFormState(next);
  }, []);

  // A new snapshot of the same row (a refresh, or someone else's edit): three-way merge.
  useEffect(() => {
    const was = baseline.current;
    if (shallowEq(was, seed)) return;
    baseline.current = seed;
    const cur = formRef.current;
    const next = { ...seed };
    for (const k of Object.keys(seed) as (keyof F)[]) if (!eq(cur[k], was[k])) next[k] = cur[k];
    // Either way the component must re-render: `dirty` is computed during render against the
    // baseline this effect just moved, so bailing out here leaves a stale Saved/Unsaved chip
    // until something else happens to render.
    setForm(shallowEq(next, cur) ? { ...cur } : next);
  }, [seed, setForm]);

  const set = useCallback((patch: Partial<F>) => setForm({ ...formRef.current, ...patch }), [setForm]);

  const save = useCallback(
    (next?: Partial<F>) => {
      if (next) set(next);
      const run = async () => {
        const f = formRef.current;
        const base = baseline.current;
        if (shallowEq(f, base)) return;
        if (mounted.current) setState({ kind: "saving" });
        try {
          const written = await commitRef.current(f, base);
          if (written && written.length) {
            const nb = { ...baseline.current };
            for (const k of written) nb[k] = f[k];
            baseline.current = nb;
          }
          if (mounted.current) setState(written && written.length ? { kind: "saved" } : { kind: "idle" });
        } catch (err) {
          if (mounted.current) setState({ kind: "failed", error: err instanceof Error ? err.message : String(err) });
        }
      };
      chain.current = chain.current.then(run, run);
      return chain.current;
    },
    [set],
  );

  return { form, set, save, state, dirty: !shallowEq(form, baseline.current) };
}

// ── chrome ──────────────────────────────────────────────────────────────────────────────

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="bd-insp-section">
      <div className="bd-insp-section-title">
        <span>{title}</span>
        {aside ? <span className="bd-insp-section-aside">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, bad, block, children }: { label: string; hint?: ReactNode; bad?: boolean; block?: boolean; children: ReactNode }) {
  const cls = `bd-insp-field${bad ? " is-bad" : ""}`;
  const head = (
    <span className="bd-insp-label">
      <span>{label}</span>
      {hint ? <span className="bd-insp-label-hint">{hint}</span> : null}
    </span>
  );
  return block ? (
    <div className={cls}>
      {head}
      {children}
    </div>
  ) : (
    <label className={cls}>
      {head}
      {children}
    </label>
  );
}

export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="bd-insp-warn" role="status">
      <Icon name="alert" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Saving / Saved / Failed, and "Unsaved" for an edit that has not been blurred yet.
 *
 * The outcome STAYS until the next edit rather than fading on a timer: a chip that clears
 * itself is gone by the time anyone looks up from the field they were typing in, and the one
 * question this answers — did my last edit reach Calliope? — outlives a two-second window.
 */
export function SaveIndicator({ state, dirty, onRetry }: { state: SaveState; dirty: boolean; onRetry?: () => void }) {
  if (state.kind === "saving") {
    return (
      <span className="bd-insp-save is-saving" title="Writing to Calliope">
        <Icon name="refresh" /> Saving
      </span>
    );
  }
  if (state.kind === "failed") {
    return (
      <button type="button" className="bd-insp-save is-failed" title={state.error} onClick={onRetry}>
        <Icon name="alert" /> Failed{onRetry ? " · retry" : ""}
      </button>
    );
  }
  if (dirty) return <span className="bd-insp-save is-dirty">Unsaved</span>;
  if (state.kind === "saved") {
    return (
      <span className="bd-insp-save is-saved">
        <Icon name="check" /> Saved
      </span>
    );
  }
  return null;
}
