// The left sidebar — the app mark, the io bars, the node library and the blueprints. [U4]
//
// Ported from ifr-node-lab's `.palette` column: a 180px rail of tracked micro-caps section
// labels and hairline-separated blocks, with every mutation going through a drive command so
// the sidebar and the agent reach the editor by exactly the same path.
//
// Two ways to place a node, both from one list: drag it onto the canvas (the drop lands where
// you let go — `CanvasBridge` below binds the listeners on `.bd-canvas` so no <ReactFlow> prop
// has to change), or click it and it drops at the viewport centre.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useAutosave } from "./autosave.js";
import { useActions } from "./actions.js";
import { useDirector } from "./director-context.js";
import { Icon, type IconName } from "./icons.js";
import { useModal } from "./modal.js";
import { PALETTE_KINDS, type NodeKind } from "./model.js";
import { exportToClipboard, exportToFile, getSavesSnapshot, importFromClipboard, importFromFile, nextTask, subscribeSaves, type SavesRegistry } from "./persistence.js";
import { registerSlot } from "./slots.js";
import "./styles/u4-persistence-sidebar.css";

/** The MIME the node list writes and the canvas reads. Same string as ifr-node-lab's. */
export const NODE_KIND_MIME = "application/node-kind";

const FLASH_MS = 1700;

/** Which accordion a palette kind belongs to. Order here is the order on screen. */
const SECTIONS: { id: string; label: string; kinds: NodeKind[] }[] = [
  { id: "scenes", label: "Scenes", kinds: ["scene"] },
  { id: "assets", label: "Assets", kinds: ["character", "location", "item"] },
  { id: "helpers", label: "Helpers", kinds: ["note"] },
];

interface Flash {
  ok: boolean;
  text: string;
}

function useFlash(): [Flash | null, (ok: boolean, text: string) => void] {
  const [flash, setFlash] = useState<Flash | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback((ok: boolean, text: string) => {
    setFlash({ ok, text });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }, []);
  return [flash, show];
}

/** The named saves, live: another tab's write repaints this one. */
function useSaves(): SavesRegistry {
  return useSyncExternalStore(subscribeSaves, getSavesSnapshot, getSavesSnapshot);
}

/** A button that asks once. Click to arm, click again to do it; it disarms after 3 s. */
function ArmedButton({ icon, label, armedLabel, danger, onConfirm }: { icon: IconName; label: string; armedLabel: string; danger?: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  const disarm = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  }, []);
  useEffect(() => () => disarm(), [disarm]);
  return (
    <button
      type="button"
      className={`bd-u4-wide${armed ? " is-armed" : ""}${danger ? " is-danger" : ""}`}
      aria-pressed={armed}
      onBlur={disarm}
      onClick={() => {
        if (armed) {
          disarm();
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = window.setTimeout(() => setArmed(false), 3000);
      }}
    >
      <Icon name={armed ? "alert" : icon} />
      <span>{armed ? armedLabel : label}</span>
    </button>
  );
}

function SavesPopover({ onFlash, close }: { onFlash: (ok: boolean, text: string) => void; close: () => void }) {
  const { drive } = useDirector();
  const modal = useModal();
  const saves = useSaves();
  const [name, setName] = useState("");
  const names = useMemo(() => Object.keys(saves).sort((a, b) => a.localeCompare(b)), [saves]);

  const save = () => {
    const clean = name.trim();
    if (!clean) return;
    void drive("save_named", { name: clean })
      .then(() => {
        setName("");
        onFlash(true, `Saved “${clean}”`);
      })
      .catch((err: unknown) => onFlash(false, err instanceof Error ? err.message : "Save failed"));
  };

  return (
    <div className="bd-u4-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="bd-u4-pop-new">
        <input
          className="bd-input nodrag"
          placeholder="Save current as…"
          aria-label="Save current as"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") close();
          }}
        />
        <button type="button" className="bd-u4-io" title="Save the canvas under this name" disabled={!name.trim()} onClick={save}>
          <Icon name="save" />
        </button>
      </div>
      <div className="bd-u4-pop-list">
        {names.length === 0 ? <div className="bd-u4-empty">No saved graphs yet.</div> : null}
        {names.map((n) => (
          <div className="bd-u4-save-row" key={n}>
            <button
              type="button"
              className="bd-u4-save-load nodrag"
              title={`Load “${n}”`}
              onClick={() => {
                void drive("load_named", { name: n })
                  .then(() => {
                    close();
                    onFlash(true, `Loaded “${n}”`);
                  })
                  .catch((err: unknown) => onFlash(false, err instanceof Error ? err.message : "Load failed"));
              }}
            >
              {n}
            </button>
            <button
              type="button"
              className="bd-u4-save-del nodrag"
              title={`Delete “${n}”`}
              aria-label={`Delete save ${n}`}
              onClick={() => {
                void modal
                  .confirm({ title: `Delete the save “${n}”?`, body: "The graph on the canvas is not touched.", confirmLabel: "Delete", danger: true })
                  .then((ok) => {
                    if (!ok) return undefined;
                    return drive("delete_save", { name: n }).then(() => onFlash(true, `Deleted “${n}”`));
                  })
                  .catch((err: unknown) => onFlash(false, err instanceof Error ? err.message : "Delete failed"));
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Sidebar() {
  const { drive, blueprints } = useDirector();
  const actions = useActions();
  const [flash, showFlash] = useFlash();
  const [savesOpen, setSavesOpen] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const fileRef = useRef<HTMLInputElement | null>(null);
  const savesRef = useRef<HTMLDivElement | null>(null);
  const store = useStoreApi();

  const fail = (err: unknown, fallback: string) => showFlash(false, err instanceof Error ? err.message : fallback);

  /** The middle of what the user is looking at, in canvas coordinates. */
  const viewportCentre = useCallback(() => {
    const { width, height, transform } = store.getState();
    const [tx, ty, zoom] = transform;
    const z = zoom || 1;
    return { x: (width / 2 - tx) / z, y: (height / 2 - ty) / z };
  }, [store]);

  /**
   * Run a graph mutation from a click, one task later.
   *
   * The editor settles by calling `setEdges` from inside the `setNodes` updater; started from
   * inside a click handler's own React batch that becomes a render-phase update and the tab
   * locks up (see `replaceGraph`). The agent's path is already its own task — this puts the
   * mouse on the same footing.
   */
  const mutate = (name: string, args: Record<string, unknown>, whenItFails: string) => {
    void nextTask()
      .then(() => drive(name, args))
      .catch((err: unknown) => fail(err, whenItFails));
  };

  const addAtCentre = (kind: NodeKind) => {
    const at = viewportCentre();
    mutate("add_node", { kind, x: Math.round(at.x - 110), y: Math.round(at.y - 40) }, "Could not add that node");
  };

  const exportClipboard = () => {
    void drive("export_graph")
      .then((r) => exportToClipboard((r as { json: string }).json))
      .then(() => showFlash(true, "Copied"))
      .catch(() => showFlash(false, "Clipboard blocked"));
  };

  const exportDownload = () => {
    void drive("export_graph")
      .then((r) => {
        exportToFile((r as { json: string }).json);
        showFlash(true, "Saved file");
      })
      .catch((err: unknown) => fail(err, "Export failed"));
  };

  const importText = (text: string) =>
    drive("import_graph", { json: text }).then(
      () => showFlash(true, "Imported"),
      // Every shape complaint deserializeGraph raises reads as "bad JSON" from here; the note
      // line under the toolbar carries the specific reason.
      (err: unknown) => showFlash(false, err instanceof Error && /clipboard/i.test(err.message) ? err.message : "Bad JSON"),
    );

  const importClipboard = () => {
    void importFromClipboard()
      .then(importText)
      .catch(() => showFlash(false, "Clipboard blocked"));
  };

  // Close the saves popover on a click anywhere outside the popover AND its own toggle — the
  // rest of the sidebar counts as outside, or arming Clear would leave the popover hanging
  // over the list it is about to empty.
  useEffect(() => {
    if (!savesOpen) return undefined;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      // A modal the popover itself opened (delete-with-confirm) renders at the root, outside
      // this subtree — treat it as inside, or confirming a delete would close the list you are
      // deleting from before it could repaint.
      if (el?.closest?.(".bd-modal-backdrop")) return;
      if (!savesRef.current?.contains(e.target as Node)) setSavesOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [savesOpen]);

  const bpList = useMemo(() => Object.values(blueprints).sort((a, b) => a.label.localeCompare(b.label)), [blueprints]);

  return (
    <div className="bd-u4-side">
      <div className="bd-u4-mark">
        <Icon name="clapper" size={15} />
        <span>Director</span>
      </div>

      <div className={`bd-u4-flash${flash ? " is-on" : ""}${flash && !flash.ok ? " is-bad" : ""}`} role="status">
        {flash ? (
          <>
            <Icon name={flash.ok ? "check" : "x"} size={11} />
            <span>{flash.text}</span>
          </>
        ) : null}
      </div>

      <div className="bd-u4-io-bar">
        <span className="bd-u4-io-label">Export</span>
        <button type="button" className="bd-u4-io" title="Copy the graph JSON to the clipboard" onClick={exportClipboard}>
          <Icon name="copy" />
        </button>
        <button type="button" className="bd-u4-io" title="Download the graph as a .json file" onClick={exportDownload}>
          <Icon name="download" />
        </button>
      </div>

      <div className="bd-u4-io-bar">
        <span className="bd-u4-io-label">Import</span>
        <button type="button" className="bd-u4-io" title="Replace the canvas with graph JSON from the clipboard" onClick={importClipboard}>
          <Icon name="text" />
        </button>
        <button type="button" className="bd-u4-io" title="Replace the canvas from a graph .json file" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" />
        </button>
      </div>

      <div className="bd-u4-saves" ref={savesRef}>
        <div className="bd-u4-io-bar">
          <span className="bd-u4-io-label">Saves</span>
          <button
            type="button"
            className={`bd-u4-io${savesOpen ? " is-on" : ""}`}
            title="Save and load named graphs (kept in this browser)"
            aria-expanded={savesOpen}
            onClick={() => setSavesOpen((v) => !v)}
          >
            <Icon name="folder" />
          </button>
        </div>
        {savesOpen ? <SavesPopover onFlash={showFlash} close={() => setSavesOpen(false)} /> : null}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="bd-u4-file"
        aria-label="Graph JSON file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFromFile(f).then(importText, () => showFlash(false, "Could not read that file"));
        }}
      />

      <div className="bd-u4-rule">Nodes</div>
      {SECTIONS.map((sec) => {
        const items = PALETTE_KINDS.filter((k) => sec.kinds.includes(k.kind));
        if (!items.length) return null;
        const open = !closed.has(sec.id);
        return (
          <div className="bd-u4-acc" key={sec.id}>
            <button
              type="button"
              className="bd-u4-acc-head"
              aria-expanded={open}
              onClick={() =>
                setClosed((cur) => {
                  const next = new Set(cur);
                  if (!next.delete(sec.id)) next.add(sec.id);
                  return next;
                })
              }
            >
              <Icon name={open ? "chevronDown" : "chevronRight"} size={11} />
              <span className="bd-u4-acc-name">{sec.label}</span>
              <span className="bd-u4-acc-count">{items.length}</span>
            </button>
            {open ? (
              <div className="bd-u4-acc-body">
                {items.map((k) => (
                  <button
                    type="button"
                    key={k.kind}
                    className="bd-u4-node"
                    data-kind={k.kind}
                    draggable
                    title={`Drag onto the canvas, or click to drop a ${k.label} in the middle`}
                    onDragStart={(e: DragEvent<HTMLButtonElement>) => {
                      e.dataTransfer.setData(NODE_KIND_MIME, k.kind);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => addAtCentre(k.kind)}
                  >
                    <Icon name={k.icon} size={13} />
                    <span className="bd-u4-node-label">{k.label}</span>
                    {k.hint ? <span className="bd-u4-node-hint">{k.hint}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="bd-u4-rule">Blueprints</div>
      <div className="bd-u4-acc-body">
        {bpList.length === 0 ? <div className="bd-u4-empty">Save a subgraph as a blueprint to stamp it here.</div> : null}
        {bpList.map((bp) => (
          <div className="bd-u4-save-row" key={bp.id}>
            <button
              type="button"
              className="bd-u4-node bd-u4-grow"
              title={`Stamp a copy of “${bp.label}” in the middle of the canvas`}
              onClick={() => {
                const at = viewportCentre();
                mutate("apply_blueprint", { blueprint_id: bp.id, x: Math.round(at.x - 230), y: Math.round(at.y - 190) }, "Could not place that blueprint");
              }}
            >
              <Icon name="film" size={13} />
              <span className="bd-u4-node-label">{bp.label}</span>
            </button>
            <button
              type="button"
              className="bd-u4-save-del"
              title={`Delete the blueprint “${bp.label}”`}
              aria-label={`Delete blueprint ${bp.label}`}
              onClick={() => actions?.deleteBlueprint(bp.id)}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="bd-u4-rule">Canvas</div>
      <div className="bd-u4-acc-body">
        <ArmedButton
          icon="trash"
          label="Clear canvas"
          armedLabel="Clear — sure?"
          danger
          onConfirm={() => {
            void drive("clear")
              .then(() => showFlash(true, "Cleared"))
              .catch((err: unknown) => fail(err, "Clear failed"));
          }}
        />
        <ArmedButton
          icon="refresh"
          label="Reset to demo"
          armedLabel="Reset — sure?"
          onConfirm={() => {
            void drive("reset_demo")
              .then(() => showFlash(true, "Demo restored"))
              .catch((err: unknown) => fail(err, "Reset failed"));
          }}
        />
      </div>

      <p className="bd-u4-hint">Drag a node onto the canvas, or click to drop it in the middle.</p>
    </div>
  );
}

/**
 * The canvas half of the sidebar: accepts a dragged node kind, and keeps the working graph
 * autosaved.
 *
 * It listens on its PARENT (`.bd-canvas`) rather than on a box of its own, so the whole pane
 * is a drop target without a `<ReactFlow>` prop changing or an overlay eating a click.
 */
export function CanvasBridge() {
  const { drive } = useDirector();
  const { screenToFlowPosition } = useReactFlow();
  const anchor = useRef<HTMLDivElement | null>(null);
  useAutosave();

  useEffect(() => {
    const host = anchor.current?.parentElement;
    if (!host) return undefined;
    const onDragOver = (e: globalThis.DragEvent) => {
      if (!e.dataTransfer?.types.includes(NODE_KIND_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    };
    const onDrop = (e: globalThis.DragEvent) => {
      const kind = e.dataTransfer?.getData(NODE_KIND_MIME);
      if (!kind) return;
      e.preventDefault();
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // One task later, for the reason `replaceGraph` explains: settling inside the event's own
      // React batch is what locks the tab up.
      void nextTask().then(() => drive("add_node", { kind, x: Math.round(at.x - 110), y: Math.round(at.y - 20) }));
    };
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);
    return () => {
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
    };
  }, [drive, screenToFlowPosition]);

  return <div ref={anchor} className="bd-u4-anchor" aria-hidden="true" />;
}

registerSlot("left-dock", Sidebar, { id: "u4-sidebar", order: 10 });
registerSlot("canvas-overlay", CanvasBridge, { id: "u4-canvas-bridge", order: 1 });
