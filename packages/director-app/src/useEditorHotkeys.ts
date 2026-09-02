// The editor's keyboard, in one hook.
//
// Mounted once by DirectorApp. Every chord runs the same code the mouse or the agent runs —
// undo/redo/delete/group are the editor's own callbacks, copy/paste/duplicate/select-all are
// drive commands — so a hotkey can never do something a tool call cannot.
//
// Scoping (ported from the Ctrl+Z effect this replaces, and kept strict): the editor lives
// inside ComfyUI's side panel, so a chord is only ours while the pane has focus or the mouse
// is over it, never while the user is typing in a field, and never while a modal is open.
// Delete is handled HERE rather than by React Flow's `deleteKeyCode` because React Flow
// removes the nodes before the editor sees them — the undo snapshot would record the graph
// with the nodes already gone, and Ctrl+Z would bring nothing back.

import { useEffect, useRef, type RefObject } from "react";

export type HotkeyAction = "undo" | "redo" | "copy" | "cut" | "paste" | "duplicate" | "selectAll" | "group" | "escape" | "delete" | "help";

/** Pure: which editor action a key event asks for, or null. */
export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey?: boolean }): HotkeyAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (e.altKey) return null;
    switch (key) {
      case "z":
        return e.shiftKey ? "redo" : "undo";
      case "y":
        return "redo";
      case "c":
        return "copy";
      case "x":
        return "cut";
      case "v":
        return "paste";
      case "d":
        return "duplicate";
      case "a":
        return "selectAll";
      case "g":
        return "group";
      default:
        return null;
    }
  }
  if (key === "Escape") return "escape";
  if (key === "Delete" || key === "Backspace") return "delete";
  if (e.key === "?") return "help";
  return null;
}

/** True when the element takes typed text — a chord there belongs to the field. */
export function isEditingField(el: unknown): boolean {
  if (!el || typeof el !== "object" || !("tagName" in el)) return false;
  const node = el as HTMLElement;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!node.isContentEditable;
}

export interface EditorHotkeyHandlers {
  /** The `.bd-canvas` element; its `.bd-root` ancestor is the hotkey scope. */
  canvasRef: RefObject<HTMLDivElement | null>;
  undo(): void;
  redo(): void;
  deleteSelection(): void;
  groupSelection(): void;
  /** Close the palette if it is open; true when it was. */
  closePalette(): boolean;
  selectedIds(): string[];
  allIds(): string[];
  /** Any node or wire selected? */
  hasSelection(): boolean;
  drive(name: string, args?: Record<string, unknown>): Promise<unknown>;
  screenToFlowPosition(p: { x: number; y: number }): { x: number; y: number };
  setNote(message: string): void;
  openHelp(): void;
}

export function useEditorHotkeys(handlers: EditorHotkeyHandlers): void {
  // Latest handlers in a ref: one listener for the life of the editor, never stale.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    /** Last pointer position over the canvas — where Ctrl+V lands. */
    let pointer: { x: number; y: number } | null = null;
    const canvas = ref.current.canvasRef.current;
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
    };
    canvas?.addEventListener("pointermove", onMove);

    const onKey = (e: KeyboardEvent) => {
      const h = ref.current;
      const root = h.canvasRef.current?.closest(".bd-root");
      if (!root) return;
      if (isEditingField(e.target) || isEditingField(document.activeElement)) return;
      // A modal owns the keyboard while it is up (it closes itself on Escape).
      if (document.querySelector(".bd-modal-backdrop")) return;
      if (!root.contains(document.activeElement) && !root.matches(":hover")) return;
      const action = keyAction(e);
      if (!action) return;

      const swallow = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const fail = (err: unknown) => h.setNote(err instanceof Error ? err.message : String(err));

      switch (action) {
        case "undo":
          swallow();
          h.undo();
          return;
        case "redo":
          swallow();
          h.redo();
          return;
        case "copy": {
          const ids = h.selectedIds();
          if (!ids.length) return; // let the browser copy whatever text is selected
          swallow();
          h.drive("copy", { ids }).catch(fail);
          return;
        }
        case "cut": {
          const ids = h.selectedIds();
          if (!ids.length) return;
          swallow();
          h.drive("copy", { ids })
            .then(() => h.deleteSelection())
            .catch(fail);
          return;
        }
        case "paste": {
          swallow();
          const at = pointer ? h.screenToFlowPosition(pointer) : null;
          h.drive("paste", at ? { x: at.x, y: at.y } : {}).catch(fail);
          return;
        }
        case "duplicate": {
          const ids = h.selectedIds();
          if (!ids.length) return;
          swallow();
          h.drive("duplicate", { ids }).catch(fail);
          return;
        }
        case "selectAll":
          swallow();
          h.drive("select", { ids: h.allIds() }).catch(fail);
          return;
        case "group":
          if (!h.selectedIds().length) return;
          swallow();
          h.groupSelection();
          return;
        case "escape":
          if (h.closePalette()) {
            swallow();
            return;
          }
          if (h.hasSelection()) {
            swallow();
            h.drive("select", { ids: [] }).catch(fail);
          }
          return;
        case "delete":
          if (!h.hasSelection()) return;
          swallow();
          h.deleteSelection();
          return;
        case "help":
          swallow();
          h.openHelp();
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      canvas?.removeEventListener("pointermove", onMove);
    };
  }, []);
}
