import { describe, expect, it } from "vitest";
import { escapeHtml, isNoteData, noteFirstLine, renderNoteHtml, renderPlainNote } from "./note.js";

describe("renderPlainNote — the fallback when the host has no markdown pipeline", () => {
  it("escapes markup so a note can never inject", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe("&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;");
    expect(renderPlainNote("<b>x</b>")).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
  it("keeps line breaks, whatever the newline flavour", () => {
    expect(renderPlainNote("# Plan\n- shot list")).toBe("# Plan<br>- shot list");
    expect(renderPlainNote("a\r\nb\rc")).toBe("a<br>b<br>c");
  });
});

describe("renderNoteHtml — the host's renderer, guarded", () => {
  it("uses the host renderer when it behaves", () => {
    expect(renderNoteHtml("# Plan", (md) => `<h1>${md.slice(2)}</h1>`)).toBe("<h1>Plan</h1>");
  });
  it("falls back when the renderer throws or returns a non-string", () => {
    expect(renderNoteHtml("a<b", () => { throw new Error("boom"); })).toBe("a&lt;b");
    expect(renderNoteHtml("a\nb", (() => Promise.resolve("<p>x</p>")) as unknown as (md: string) => string)).toBe("a<br>b");
  });
  it("renders nothing for an empty note, so the placeholder shows", () => {
    expect(renderNoteHtml("", (md) => `<p>${md}</p>`)).toBe("");
  });
});

describe("noteFirstLine — a pinned note's face", () => {
  it("skips blank lines and strips markdown leaders", () => {
    expect(noteFirstLine("\n\n## Shot list\n- crane in")).toBe("Shot list");
    expect(noteFirstLine("- [ ] pick lens")).toBe("[ ] pick lens");
    expect(noteFirstLine("> 1. quoted item")).toBe("quoted item");
    expect(noteFirstLine("3) third")).toBe("third");
  });
  it("truncates with an ellipsis past the budget", () => {
    const long = "x".repeat(80);
    const out = noteFirstLine(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });
  it("is empty for an empty or leader-only note", () => {
    expect(noteFirstLine("")).toBe("");
    expect(noteFirstLine("#\n- \n")).toBe("");
  });
});

describe("isNoteData", () => {
  it("is a kind check, nothing more", () => {
    expect(isNoteData({ kind: "note", text: "", label: "Note", ports: [] })).toBe(true);
    expect(isNoteData({ kind: "scene" })).toBe(false);
    expect(isNoteData(null)).toBe(false);
  });
});
