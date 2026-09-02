// The `?` button and the Shortcuts sheet it opens.
//
// Ported from ifr-node-lab's help pill + `help-panel`, rendered through the editor's own
// modal (`useModal().choose` with no choices is a titled sheet with one Close button) so it
// stacks, scrolls and dismisses like every other dialog here. Lists every chord the hotkey
// hook understands and every mouse gesture the canvas answers to — if a gesture is not on
// this list, nobody will find it.

import { useCallback, useEffect, useRef } from "react";
import { Icon } from "./icons.js";
import { useModal } from "./modal.js";
import { registerSlot } from "./slots.js";
import "./styles/u3-clipboard-hotkeys.css";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const MOD = IS_MAC ? "⌘" : "Ctrl";

interface KeyRow {
  /** Alternatives, each a chord. */
  keys: string[][];
  what: string;
}

export const SHORTCUTS: KeyRow[] = [
  { keys: [[MOD, "Z"]], what: "Undo — including what the agent just did" },
  { keys: [[MOD, "Shift", "Z"], [MOD, "Y"]], what: "Redo" },
  { keys: [[MOD, "C"]], what: "Copy the selection; a Beat brings its scenes and rails" },
  { keys: [[MOD, "X"]], what: "Cut" },
  { keys: [[MOD, "V"]], what: "Paste where the pointer is" },
  { keys: [[MOD, "D"]], what: "Duplicate in place, a little down and to the right" },
  { keys: [[MOD, "A"]], what: "Select every node" },
  { keys: [[MOD, "G"]], what: "Group the selection into a new Beat" },
  { keys: [["Delete"], ["Backspace"]], what: "Delete the selection (and its wires); undoable" },
  { keys: [["Esc"]], what: "Close the palette, or clear the selection" },
  { keys: [["Shift", "drag"]], what: "Box-select" },
  { keys: [[MOD, "click"]], what: "Add to, or remove from, the selection" },
  { keys: [["?"]], what: "This sheet" },
];

export const GESTURES: { how: string; what: string }[] = [
  { how: "Right-click the canvas", what: "Open the palette — type to search, Enter to place" },
  { how: "Drag a Beat's title bar or body", what: "Move it, and everything inside" },
  { how: "Drag a Beat's corner", what: "Resize it; a scene dragged in joins it, dragged out leaves" },
  { how: "Drag from a port", what: "Start a wire; drop it on empty canvas to place a node already wired" },
  { how: "Drag a connected input", what: "Pick the wire up and carry it to another input" },
  { how: "Drop a child's wire on a rail's +", what: "Pin a new port on that rail — it stays without a wire" },
  { how: "Hover a wire, click its midpoint", what: "Insert a scene, delete the wire, or reroute it" },
  { how: "Double-click a title", what: "Rename a Beat, rail or node in place" },
  { how: "Drag empty canvas / wheel", what: "Pan / zoom" },
];

function Keys({ chords }: { chords: string[][] }) {
  return (
    <span className="bd-help-keys">
      {chords.map((chord, i) => (
        <span key={i} className="bd-help-chord">
          {i > 0 ? <span className="bd-help-or">or</span> : null}
          {chord.map((k, j) => (
            <kbd key={j} className="bd-kbd">
              {k}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

export function HelpBody() {
  return (
    <div className="bd-help">
      <section className="bd-help-section">
        <div className="bd-help-head">Keyboard</div>
        {SHORTCUTS.map((row) => (
          <div className="bd-help-row" key={row.what}>
            <Keys chords={row.keys} />
            <span className="bd-help-what">{row.what}</span>
          </div>
        ))}
      </section>
      <section className="bd-help-section">
        <div className="bd-help-head">Mouse</div>
        {GESTURES.map((row) => (
          <div className="bd-help-row" key={row.how}>
            <span className="bd-help-how">{row.how}</span>
            <span className="bd-help-what">{row.what}</span>
          </div>
        ))}
      </section>
      <div className="bd-help-foot">
        Chords work while the pointer is over the editor or something in it has focus, and never while you are typing in a field.
      </div>
    </div>
  );
}

let opener: (() => void) | null = null;

/** Open the shortcuts sheet (the `?` hotkey). A no-op until the button has mounted. */
export function openHelp(): void {
  opener?.();
}

function HelpButton() {
  const modal = useModal();
  const showing = useRef(false);
  const open = useCallback(() => {
    if (showing.current) return;
    showing.current = true;
    void modal.choose({ title: "Shortcuts", body: <HelpBody />, options: [], cancelLabel: "Close" }).finally(() => {
      showing.current = false;
    });
  }, [modal]);
  useEffect(() => {
    opener = open;
    return () => {
      if (opener === open) opener = null;
    };
  }, [open]);
  return (
    <button type="button" className="bd-help-btn" title="Keyboard shortcuts and mouse gestures (?)" aria-label="Shortcuts" onClick={open}>
      <Icon name="helpCircle" size={15} />
    </button>
  );
}

registerSlot("toolbar-right", HelpButton, { order: 50, id: "u3-help" });
