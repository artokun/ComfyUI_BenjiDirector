import { describe, expect, it } from "vitest";
import { isEditingField, keyAction } from "./useEditorHotkeys.js";

const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe("keyAction", () => {
  it("maps the chords, on Ctrl and on Cmd, case-insensitively", () => {
    expect(keyAction(ev("z", { ctrlKey: true }))).toBe("undo");
    expect(keyAction(ev("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(keyAction(ev("y", { ctrlKey: true }))).toBe("redo");
    expect(keyAction(ev("c", { metaKey: true }))).toBe("copy");
    expect(keyAction(ev("x", { ctrlKey: true }))).toBe("cut");
    expect(keyAction(ev("v", { ctrlKey: true }))).toBe("paste");
    expect(keyAction(ev("d", { ctrlKey: true }))).toBe("duplicate");
    expect(keyAction(ev("a", { ctrlKey: true }))).toBe("selectAll");
    expect(keyAction(ev("g", { ctrlKey: true }))).toBe("group");
  });
  it("maps the bare keys", () => {
    expect(keyAction(ev("Escape"))).toBe("escape");
    expect(keyAction(ev("Delete"))).toBe("delete");
    expect(keyAction(ev("Backspace"))).toBe("delete");
    expect(keyAction(ev("?", { shiftKey: true }))).toBe("help");
  });
  it("ignores what it does not own", () => {
    expect(keyAction(ev("c"))).toBeNull();
    expect(keyAction(ev("s", { ctrlKey: true }))).toBeNull();
    expect(keyAction(ev("Delete", { ctrlKey: true }))).toBeNull();
    expect(keyAction(ev("c", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(keyAction(ev("ArrowLeft"))).toBeNull();
  });
});

describe("isEditingField", () => {
  it("names inputs, textareas, selects and contenteditable; nothing else", () => {
    expect(isEditingField({ tagName: "INPUT" })).toBe(true);
    expect(isEditingField({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditingField({ tagName: "SELECT" })).toBe(true);
    expect(isEditingField({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditingField({ tagName: "DIV", isContentEditable: false })).toBe(false);
    expect(isEditingField({ tagName: "BUTTON" })).toBe(false);
    expect(isEditingField(null)).toBe(false);
    expect(isEditingField(undefined)).toBe(false);
  });
});
