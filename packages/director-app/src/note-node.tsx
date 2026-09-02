// The markdown sticky note.
//
// ifr-node-lab's Notes node, on our tokens: a warm paper card you double-click to write in,
// that renders markdown when you click away. The host owns the markdown pipeline — the panel
// passes marked + DOMPurify through `renderMarkdown` — and the editor falls back to escaped
// text with line breaks when it has none, so a note is never a script sink.
//
// Three React Flow facts shape the DOM here:
//   - `nodrag` on the body: a press into the text must place a cursor, not move the note.
//   - `nowheel` on the card, plus a NATIVE wheel listener: React Flow zooms the canvas on
//     wheel, and some of its listeners are attached above React's root, where a synthetic
//     stopPropagation never reaches. Scrolling a long note must scroll the note.
//   - `nopan` on the body: the canvas zooms on double-click, and double-click is how a note
//     opens for editing.
//
// Every keystroke writes through to the graph (`updateNode`, no history) so the agent's
// `outline` is always current, and the FIRST keystroke of an editing session goes through
// `setNoteText`, which snapshots for undo — one undo step per edit, not one per letter.

import { NodeResizeControl, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ActionsContext } from "./actions.js";
import { DirectorContext } from "./director-context.js";
import { registerDriveCommands, type RFNode } from "./drive-registry.js";
import { Icon } from "./icons.js";
import type { NoteData } from "./model.js";
import { NOTE_MIN_HEIGHT, NOTE_MIN_WIDTH, isNoteData, renderNoteHtml } from "./note.js";
import "./styles/u9-note-widgets.css";

const swallow = (e: { stopPropagation(): void }) => e.stopPropagation();

/**
 * The yellow pin, for a note inside a subgraph: pinned, its first line shows on the collapsed face.
 *
 * A near-copy of `PinToolbar` in nodes.tsx, and deliberately so for now: nodes.tsx imports THIS
 * module for the node type, so importing back would close a cycle, and lifting the shared pin
 * into its own module is a bigger edit to nodes.tsx than this unit owns. Extracting it is the
 * right follow-up once the parallel units have landed.
 */
function NotePin({ id, promoted, visible, inSubgraph }: { id: string; promoted: boolean; visible: boolean; inSubgraph: boolean }) {
  const actions = useContext(ActionsContext);
  if (!inSubgraph) return null;
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} className="bd-nodebar">
      <button
        type="button"
        className={`bd-pin${promoted ? " is-on" : ""}`}
        title={promoted ? "Promoted — its first line shows on the collapsed Beat's face (click to unpromote)" : "Promote — show this note's first line on the collapsed Beat's face"}
        onClick={(e) => {
          e.stopPropagation();
          actions?.togglePin(id);
        }}
      >
        <Icon name="pin" />
      </button>
    </NodeToolbar>
  );
}

/** The note's title, renamed in place by double-click. */
function NoteTitle({ id, label }: { id: string; label: string }) {
  const actions = useContext(ActionsContext);
  const [text, setText] = useState<string | null>(null);
  if (text === null) {
    return (
      <span
        className="bd-sticky-title nopan"
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setText(label);
        }}
      >
        {label}
      </span>
    );
  }
  const commit = () => {
    actions?.renameNode(id, text);
    setText(null);
  };
  return (
    <input
      className="bd-sticky-title-input nodrag nopan"
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPointerDown={swallow}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(null);
      }}
    />
  );
}

export function NoteNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as NoteData;
  const actions = useContext(ActionsContext);
  const director = useContext(DirectorContext);
  const renderMarkdown = director?.renderMarkdown;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.text);
  const dirty = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  // The native safety net described in the header: a wheel inside the card stays inside.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const html = useMemo(() => renderNoteHtml(d.text, renderMarkdown), [d.text, renderMarkdown]);

  const begin = () => {
    setDraft(d.text);
    dirty.current = false;
    setEditing(true);
  };
  const write = (text: string) => {
    setDraft(text);
    if (!actions) return;
    if (!dirty.current) {
      dirty.current = true;
      actions.setNoteText(id, text);
    } else actions.updateNode(id, { text }, { history: false });
  };
  const finish = () => {
    setEditing(false);
    dirty.current = false;
  };

  const style = d.color ? ({ "--bd-sticky-tint": d.color } as CSSProperties) : undefined;
  return (
    <div
      ref={cardRef}
      className={`bd-sticky nowheel${selected ? " is-selected" : ""}${editing ? " is-editing" : ""}${d.promoted ? " is-promoted" : ""}`}
      style={style}
    >
      <NotePin id={id} promoted={!!d.promoted} visible={!!selected} inSubgraph={!!d.inSubgraph} />
      <div className="bd-sticky-head">
        <Icon name="note" size={13} />
        <NoteTitle id={id} label={d.label} />
      </div>
      {editing ? (
        <textarea
          ref={taRef}
          className="bd-sticky-edit nodrag nowheel nopan"
          value={draft}
          placeholder="Markdown…"
          spellCheck={false}
          onChange={(e) => write(e.target.value)}
          onBlur={finish}
          onPointerDown={swallow}
          onClick={swallow}
          onDoubleClick={swallow}
          onWheel={swallow}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              e.preventDefault();
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
      ) : (
        <div
          className="bd-sticky-view nodrag nowheel nopan"
          title="Double-click to edit"
          onDoubleClick={(e) => {
            e.stopPropagation();
            begin();
          }}
          onWheel={swallow}
        >
          {d.text ? <div className="bd-sticky-md" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="bd-sticky-empty">Double-click to write</div>}
        </div>
      )}
      {/* One dog-ear grip, bottom-right — a sticky note, not a window with eight handles. */}
      <NodeResizeControl position="bottom-right" minWidth={NOTE_MIN_WIDTH} minHeight={NOTE_MIN_HEIGHT} className="bd-sticky-grip">
        <span className="bd-sticky-grip-icon" />
      </NodeResizeControl>
    </div>
  );
}

// ── drive: add_note {x, y, text?, label?} · set_note {id, text} ──────────────────────────
registerDriveCommands({
  add_note: (args, kit) => {
    const x = kit.num(args.x, "x");
    const y = kit.num(args.y, "y");
    if (args.text !== undefined && typeof args.text !== "string") throw new Error("text must be a string");
    const text = typeof args.text === "string" ? args.text : "";
    const label = typeof args.label === "string" && args.label ? args.label : undefined;
    return kit.run((ns, es) => {
      const node = kit.makeNode("note", { x, y }, label);
      if (isNoteData(node.data)) node.data.text = text;
      // Reparent ON, as add_node does: a note placed inside a Beat joins it.
      kit.settle([...ns, node as unknown as RFNode], es);
      return { id: node.id, label: node.data.label };
    });
  },
  set_note: (args, kit) => {
    // Refuse BEFORE `run`, the way add_node does: `run` snapshots for undo before it calls
    // back, so validating inside it makes every rejected command cost the user a Ctrl+Z.
    if (typeof args.text !== "string") throw new Error("text must be a string");
    const text = args.text;
    const found = kit.find(kit.nodesRef.current, args.id);
    if (!isNoteData(found.data)) throw new Error(`"${found.id}" is not a note`);
    return kit.run((ns, es) => {
      // Re-find against the arrays `run` hands over: the graph is the current one, not the
      // one the checks above read.
      const target = kit.find(ns, found.id);
      kit.settle(
        ns.map((n) => (n.id === target.id ? ({ ...n, data: { ...n.data, text } } as RFNode) : n)),
        es,
        { reparent: false },
      );
      return { id: target.id, text };
    });
  },
});
