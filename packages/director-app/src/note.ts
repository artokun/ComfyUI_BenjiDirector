// The note's pure half: what a sticky shows when the host has no markdown pipeline, and what
// its first line is when it is pinned to a collapsed Beat's face. No React, no DOM.

import type { NoteData } from "./model.js";

/** The smallest a note can be dragged to. Room for a heading and two bullets. */
export const NOTE_MIN_WIDTH = 160;
export const NOTE_MIN_HEIGHT = 96;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The fallback renderer: escaped text with the line breaks kept. It is what the dev harness
 * shows, and what the panel shows if marked or DOMPurify ever go missing — a note must never
 * become a script sink because the sanitizer was absent.
 */
export function renderPlainNote(text: string): string {
  return escapeHtml(text).replace(/\r\n?|\n/g, "<br>");
}

/**
 * Markdown through the host's pipeline when there is one, the plain fallback otherwise. A
 * renderer that throws, or hands back something that is not a string (marked in async mode
 * returns a Promise), falls back too rather than blanking the note.
 */
export function renderNoteHtml(text: string, renderMarkdown?: (md: string) => string): string {
  if (!text) return "";
  if (renderMarkdown) {
    try {
      const out = renderMarkdown(text);
      if (typeof out === "string") return out;
    } catch {
      // fall through to the plain renderer
    }
  }
  return renderPlainNote(text);
}

/**
 * The first line that says something, with markdown leaders (`#`, `-`, `1.`, `>`) stripped
 * and an ellipsis past `max`. This is the note's whole face when it is pinned.
 */
export function noteFirstLine(text: string, max = 48): string {
  // A leader may also END the line ("#", "-"): a marker with nothing after it is not content,
  // so it strips to empty and the search moves on. `\s+` alone would leave the bare "#" behind.
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.replace(/^\s*(?:#{1,6}(?:\s+|$)|[-*+](?:\s+|$)|\d+[.)](?:\s+|$)|>\s*)+/, "").trim();
    if (!line) continue;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  }
  return "";
}

export function isNoteData(d: unknown): d is NoteData {
  return !!d && typeof d === "object" && (d as { kind?: unknown }).kind === "note";
}
