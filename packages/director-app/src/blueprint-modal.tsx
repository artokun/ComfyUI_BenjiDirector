// Blueprint dialogs and the library menu — the UI half of blueprints.ts.
//
// Three pieces, none of which live in DirectorApp:
//  - Save-as-blueprint: a name, and when the Beat is linked to a blueprint that still exists,
//    "Update" (the next version) beside "Save as new". Rendered here rather than through the
//    generic modal because a name AND a choice in one step is neither a prompt nor a choose;
//    it wears the same classes so it looks like every other dialog.
//  - Delete-confirm: the generic modal's confirm, danger-styled.
//  - The Blueprints menu in the toolbar: place, update from the selected Beat, delete.
//    Built-ins are listed and placeable, never editable.
//
// The editor's action surface is built ABOVE the modal provider, so it cannot use the hook.
// The host below mounts inside the provider (footer slot) and registers its dialogs with
// `setBlueprintDialogs`; `actions.saveBlueprint` / `deleteBlueprint` ask through that seam.

import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useActions } from "./actions.js";
import {
  blueprintVersion,
  loadBlueprints,
  setBlueprintDialogs,
  type Blueprint,
  type BlueprintSaveRequest,
  type BlueprintSaveResult,
} from "./blueprints.js";
import { useDirector, useSelection } from "./director-context.jsx";
import { registerDriveCommands } from "./drive-registry.js";
import { Icon } from "./icons.jsx";
import { useModal } from "./modal.jsx";
import type { BeatData } from "./model.js";
import { registerSlot } from "./slots.jsx";
import "./styles/u7-blueprints.css";

// ── the dialog host ──────────────────────────────────────────────────────────────────────

type SavePending = { req: BlueprintSaveRequest; resolve: (r: BlueprintSaveResult) => void };

/** Invisible until asked; then the save dialog. Delete-confirm goes through the shared modal. */
export function BlueprintDialogHost() {
  const modal = useModal();
  const [pending, setPending] = useState<SavePending | null>(null);
  const live = useRef<SavePending | null>(null);
  useEffect(() => {
    setBlueprintDialogs({
      save: (req) =>
        new Promise<BlueprintSaveResult>((resolve) => {
          // A second request while one is open cancels the first: one dialog at a time.
          live.current?.resolve(null);
          live.current = { req, resolve };
          setPending(live.current);
        }),
      confirmDelete: (bp) =>
        modal.confirm({
          title: `Delete blueprint “${bp.label}”?`,
          body: "It leaves your library. Beats already placed from it stay on the canvas.",
          confirmLabel: "Delete",
          danger: true,
        }),
    });
    return () => {
      live.current?.resolve(null);
      live.current = null;
      setBlueprintDialogs(null);
    };
  }, [modal]);
  const finish = useCallback((r: BlueprintSaveResult) => {
    const p = live.current;
    live.current = null;
    setPending(null);
    p?.resolve(r);
  }, []);
  if (!pending) return null;
  return <SaveDialog req={pending.req} finish={finish} />;
}

function SaveDialog({ req, finish }: { req: BlueprintSaveRequest; finish: (r: BlueprintSaveResult) => void }) {
  const [name, setName] = useState(req.defaultName);
  const linked = req.linked;
  const updatable = linked && !linked.builtin ? linked : undefined;
  const trimmed = name.trim();
  const cancel = useCallback(() => finish(null), [finish]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel]);
  const primary = () => {
    if (trimmed) finish({ name: trimmed, mode: updatable ? "update" : "new" });
  };
  return (
    <div className="bd-modal-backdrop" onPointerDown={cancel}>
      <div className="bd-modal bd-bp-dialog" role="dialog" aria-modal="true" aria-label="Save as blueprint" onPointerDown={(e) => e.stopPropagation()}>
        <div className="bd-modal-title">
          <Icon name="layers" /> {updatable ? "Update blueprint" : "Save as blueprint"}
        </div>
        <div className="bd-modal-body">
          {updatable ? (
            <>
              This Beat came from <b>“{updatable.label}”</b> <span className="bd-bp-version">v{updatable.version}</span>. Update it in place — every Beat placed from it later
              gets this version — or keep it and save what is here as a new blueprint.
            </>
          ) : linked ? (
            <>
              <b>“{linked.label}”</b> ships with the editor and does not change; this saves your version as a new blueprint.
            </>
          ) : (
            <>Saves this Beat — its scenes, wiring and rails — as a reusable blueprint in this browser.</>
          )}
        </div>
        <label className="bd-modal-field">
          <span>Name</span>
          <input
            className="bd-input"
            autoFocus
            value={name}
            placeholder="Blueprint name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") primary();
            }}
          />
        </label>
        <div className="bd-modal-actions">
          <button type="button" className="bd-btn" onClick={cancel}>
            Cancel
          </button>
          {updatable ? (
            <button type="button" className="bd-btn" disabled={!trimmed} onClick={() => finish({ name: trimmed, mode: "new" })}>
              Save as new
            </button>
          ) : null}
          <button type="button" className="bd-btn is-primary" disabled={!trimmed} onClick={primary}>
            {updatable ? "Update" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── the library menu ─────────────────────────────────────────────────────────────────────

export function BlueprintsMenu() {
  const { blueprints, drive, setNote } = useDirector();
  const actions = useActions();
  const { single } = useSelection();
  const rf = useReactFlow();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  // The user's, newest first; the built-ins after them.
  const list = useMemo(
    () => Object.values(blueprints).sort((a, b) => Number(!!a.builtin) - Number(!!b.builtin) || b.savedAt - a.savedAt || a.label.localeCompare(b.label)),
    [blueprints],
  );
  const place = (bp: Blueprint) => {
    // Middle of the visible canvas, nudged up-left so the whole box tends to land in view.
    const pane = rootRef.current?.closest(".bd-root")?.querySelector(".react-flow");
    const r = pane?.getBoundingClientRect();
    const at = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    setOpen(false);
    void drive("apply_blueprint", { blueprint_id: bp.id, x: Math.round(at.x - 220), y: Math.round(at.y - 160) }).catch((err) =>
      setNote(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <div className="bd-bpmenu" ref={rootRef}>
      <button type="button" className={`bd-bpmenu-btn${open ? " is-on" : ""}`} title="Blueprints — reusable Beats" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="layers" /> Blueprints
      </button>
      {open ? (
        <div className="bd-bpmenu-pop" role="menu" aria-label="Blueprints">
          <div className="bd-bpmenu-head">
            <span>Blueprints</span>
            <span className="bd-hint">{list.length}</span>
          </div>
          {list.map((bp) => (
            <div className="bd-bpmenu-row" key={bp.id} data-blueprint={bp.id}>
              <div className="bd-bpmenu-label">
                <span className="bd-bpmenu-name">{bp.label}</span>
                <span className="bd-hint">
                  {bp.builtin ? "built-in" : `v${blueprintVersion(bp)}`} · {Math.max(0, bp.nodes.length - 1)} inside
                </span>
              </div>
              {/* A fixed three-slot grid: a built-in's single control still lines up with the
                  others' rather than sliding into the delete column. */}
              <div className="bd-bpmenu-actions">
                <button type="button" className="bd-btn is-ghost is-icon" title="Place on the canvas" onClick={() => place(bp)}>
                  <Icon name="plus" />
                </button>
                {bp.builtin ? (
                  <span aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className="bd-btn is-ghost is-icon"
                    title={single ? "Update from the selected Beat" : "Update from the Beat linked to it"}
                    onClick={() => {
                      setOpen(false);
                      actions?.updateBlueprint(bp.id, single ?? undefined);
                    }}
                  >
                    <Icon name="refresh" />
                  </button>
                )}
                {bp.builtin ? (
                  <span aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className="bd-btn is-ghost is-icon bd-bpmenu-del"
                    title="Delete"
                    onClick={() => {
                      setOpen(false);
                      actions?.deleteBlueprint(bp.id);
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="bd-bpmenu-foot">Select a subgraph Beat and use its save button to add one.</div>
        </div>
      ) : null}
    </div>
  );
}

// ── registration ─────────────────────────────────────────────────────────────────────────

registerSlot("footer", BlueprintDialogHost, { id: "u7-blueprint-dialogs", order: 900 });
registerSlot("toolbar-left", BlueprintsMenu, { id: "u7-blueprints-menu", order: 70 });

registerDriveCommands({
  // update_blueprint {blueprint_id, id?} — re-save from a Beat; the linked one when `id` is omitted.
  update_blueprint: (args, kit) => {
    const bid = kit.str(args.blueprint_id, "blueprint_id");
    const bp = loadBlueprints()[bid];
    if (!bp) throw new Error(`no blueprint "${bid}" — list_blueprints names them`);
    if (bp.builtin) throw new Error(`"${bp.label}" ships with the editor — apply it and save the copy under a new name`);
    const ns = kit.nodesRef.current;
    const linked = ns.filter((n) => kit.isContainer(n) && (n.data as BeatData).blueprintId === bid);
    const target = args.id !== undefined ? kit.find(ns, kit.str(args.id, "id")) : linked.length === 1 ? linked[0] : undefined;
    if (!target) {
      throw new Error(linked.length ? `${linked.length} Beats are linked to "${bp.label}" — pass id` : `no Beat on the canvas is linked to "${bp.label}" — pass id`);
    }
    if (!kit.isContainer(target)) throw new Error(`"${target.id}" is not a Beat`);
    kit.actions.updateBlueprint(bid, target.id);
    const after = loadBlueprints()[bid];
    if (!after || blueprintVersion(after) === blueprintVersion(bp)) throw new Error(`could not update "${bp.label}"`);
    return { blueprint_id: bid, id: target.id, version: blueprintVersion(after) };
  },
  // delete_blueprint {blueprint_id} — the agent has decided; no confirm.
  delete_blueprint: (args, kit) => {
    const bid = kit.str(args.blueprint_id, "blueprint_id");
    const bp = loadBlueprints()[bid];
    if (!bp) throw new Error(`no blueprint "${bid}" — list_blueprints names them`);
    if (bp.builtin) throw new Error(`"${bp.label}" ships with the editor and cannot be deleted`);
    kit.actions.deleteBlueprint(bid, { confirm: false });
    if (loadBlueprints()[bid]) throw new Error(`could not delete "${bp.label}"`);
    return { deleted: bid, label: bp.label };
  },
});
