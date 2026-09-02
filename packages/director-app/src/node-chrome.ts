// Leaf-node chrome: the pure rules behind the toolbar, the bypass look and the collapsed-to-
// header handle layout. No React here, so vitest runs it in node and the renderers stay thin.
//
// A leaf is a Scene or an Asset (a Note gets the tint and the toolbar's TYPE label, nothing
// else). Containers have their own chrome in container-toolbar.tsx.

import type { Edge } from "@xyflow/react";
import type { CSSProperties } from "react";
import type { PortInfo } from "@benjidirector/graph-core";
import type { RFNode } from "./drive-registry.js";
import type { AssetData, DirectorData, NoteData, SceneData } from "./model.js";

export type LeafData = SceneData | AssetData;
/** Everything `set_node_color` may tint: leaves and notes. */
export type TintableData = SceneData | AssetData | NoteData;

/** The `title` a bypassed card wears, so hovering it says why it is faded. */
export const BYPASS_TITLE = "bypassed — skipped by render tools";
/** ComfyUI's convention: a bypassed node is still there, just clearly not in the run. */
export const BYPASS_OPACITY = 0.35;

/** The header tint each kind starts with — mirrors `.bd-scene` / `.bd-asset` in styles.css. */
export const KIND_TINT = { scene: "#3b82f6", asset: "#f59e0b", note: "#a3a3a3" } as const;

export function isLeaf(data: DirectorData): data is LeafData {
  return data.kind === "scene" || data.kind === "asset";
}

export function isTintable(data: DirectorData): data is TintableData {
  return isLeaf(data) || data.kind === "note";
}

/** What the toolbar prints as the node's TYPE — the one thing renaming never changes. */
export function typeLabelOf(data: DirectorData): string {
  switch (data.kind) {
    case "scene":
      return "SCENE";
    case "asset":
      return data.asset.toUpperCase();
    case "note":
      return "NOTE";
    case "reroute":
      return "REROUTE";
    default:
      return "BEAT";
  }
}

/** The swatch a node shows before anyone picks a colour. */
export function defaultTint(data: DirectorData): string {
  return data.kind === "asset" ? KIND_TINT.asset : data.kind === "note" ? KIND_TINT.note : KIND_TINT.scene;
}

export interface LeafFlags {
  selected?: boolean;
  promoted?: boolean;
  bypassed?: boolean;
  collapsed?: boolean;
}

/** The class list of a leaf card. `base` is the kind class (`bd-scene`, `bd-asset`, …). */
export function leafClassName(base: string, flags: LeafFlags): string {
  const parts = ["bd-node", base];
  if (flags.selected) parts.push("is-selected");
  if (flags.promoted) parts.push("is-promoted");
  if (flags.bypassed) parts.push("is-bypassed");
  if (flags.collapsed) parts.push("is-collapsed");
  return parts.join(" ");
}

/**
 * The inline override for the header strip. The strip reads `--bd-kind`; a colour retints
 * it, and bypass wins over colour — a magenta stripe is the signal that the node is out of
 * the run, and a chosen tint must not be able to hide that.
 */
export function leafStyle(data: { bypassed?: boolean; color?: string }): CSSProperties | undefined {
  if (data.bypassed) return { "--bd-kind": "var(--bd-bypass)", opacity: BYPASS_OPACITY } as CSSProperties;
  if (data.color) return { "--bd-kind": data.color } as CSSProperties;
  return undefined;
}

export interface HeaderHandleLayout {
  /** Every input, in port order — collapsed, all of them sit at the header's mid-left. */
  ins: PortInfo[];
  /** Every output — collapsed, all at the header's mid-right. */
  outs: PortInfo[];
  inTitle: string;
  outTitle: string;
}

/**
 * Where a leaf's handles go. Expanded, each has its port row; collapsed to the header they
 * converge — inputs on the left edge, outputs on the right — and EVERY handle keeps its id,
 * so the wires stay attached and re-spread when the card expands. ifr-node-lab's collapsed
 * bench node, and RailHub's stacking, are the same idea.
 */
export function headerHandleLayout(ports: PortInfo[]): HeaderHandleLayout {
  const ins = ports.filter((p) => p.isInput);
  const outs = ports.filter((p) => !p.isInput);
  return {
    ins,
    outs,
    inTitle: ins.length ? `in: ${ins.map((p) => p.label).join(", ")}` : "no inputs",
    outTitle: outs.length ? `out: ${outs.map((p) => p.label).join(", ")}` : "no outputs",
  };
}

export interface InfoLine {
  k: string;
  v: string;
}

/** The (i) tooltip's rows: what a director wants to know without opening the inspector. */
export function infoLinesOf(data: DirectorData): InfoLine[] {
  const lines: InfoLine[] = [];
  switch (data.kind) {
    case "scene":
      if (data.action) lines.push({ k: "action", v: data.action });
      if (data.dialog) lines.push({ k: "dialog", v: data.dialog });
      if (data.durationSec !== undefined) lines.push({ k: "duration", v: `${data.durationSec}s` });
      if (data.renderStatus) lines.push({ k: "render", v: data.renderStatus });
      if (!lines.length) lines.push({ k: "action", v: "— no action yet" });
      break;
    case "asset":
      lines.push({
        k: "kind",
        v: data.asset === "character" ? "Character — a reusable consistency record" : data.asset === "location" ? "Location — where scenes happen" : "Item — a prop that recurs",
      });
      if (data.imagePath) lines.push({ k: "sheet", v: data.imagePath });
      break;
    case "note":
      lines.push({ k: "note", v: data.text.trim() ? data.text.trim().slice(0, 140) : "— empty" });
      break;
    default:
      break;
  }
  if (isLeaf(data) && data.bypassed) lines.push({ k: "state", v: BYPASS_TITLE });
  return lines;
}

/** `#abc`, `abc`, `#60A5FA` → `#60a5fa`. Anything that is not 3/4/6/8 hex digits → null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^#?([0-9a-fA-F]{3,8})$/.exec(v.trim());
  if (!m || !m[1]) return null;
  const hex = m[1];
  if (![3, 4, 6, 8].includes(hex.length)) return null;
  return `#${hex.toLowerCase()}`;
}

/**
 * Write a partial payload into one node's data. Keys whose value is `undefined` are REMOVED
 * (that is how `color: null` clears a tint); other nodes come back by reference so React Flow
 * re-renders only the one that changed.
 */
export function patchLeaf<N extends RFNode>(ns: N[], id: string, patch: Partial<TintableData>): N[] {
  return ns.map((n) => {
    if (n.id !== id) return n;
    const data = { ...n.data } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete data[k];
      else data[k] = v;
    }
    return { ...n, data } as N;
  });
}

/** The wires touching a node, either end. What the delete confirm counts. */
export function edgesTouching(es: Edge[], id: string): Edge[] {
  return es.filter((e) => e.source === id || e.target === id);
}

/** Refuse anything that is not literally a boolean — "true" the string is a bug, not a yes. */
export function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${what} must be true or false`);
  return v;
}
