// Selection ergonomics, the pure half (U8a).
//
// What the minimap paints a node, what the floating pill says, which Beats a marquee should
// let go of, and the snap-to-grid switch. Nothing here touches the DOM or React Flow, so it
// runs under plain vitest; `selection-toolbar.tsx` is the half that wires it in.

import { useSyncExternalStore } from "react";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";

/** The least a node needs to be classified: React Flow's `type` and our `data.kind`. */
export interface KindLike {
  type?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

/**
 * The minimap class for a node. The stylesheet maps each to a token — scene blue, asset
 * amber, beat violet — so the swatches follow the theme rather than a colour baked in here.
 */
export function minimapNodeClass(n: KindLike): string {
  if (n.type === GROUP_TYPE || n.type === SUBGRAPH_TYPE) return "bd-mm-beat";
  const kind = n.data?.kind;
  switch (kind) {
    case "scene":
      return "bd-mm-scene";
    case "asset":
      return "bd-mm-asset";
    case "note":
      return "bd-mm-note";
    case "reroute":
      return "bd-mm-reroute";
    default:
      return "bd-mm-node";
  }
}

/** What the pill says. */
export function describeSelection(count: number): string {
  return `${count} selected`;
}

/**
 * Add-to-selection keys. Both, because one bundle ships to macOS and to Windows — and as ONE
 * stable array, so React Flow does not re-bind its key listeners on every render.
 */
export const MULTI_SELECT_KEYS: string[] = ["Meta", "Control"];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MarqueeCandidate {
  id: string;
  selected: boolean;
  /** Must be FULLY inside the marquee to count — an expanded Beat, not a leaf. */
  strict: boolean;
  box: Box;
}

export const encloses = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/**
 * Ids a marquee caught that it should let go: strict nodes it only brushed.
 *
 * React Flow's partial selection picks every node the box touches, and a box drawn over the
 * scenes inside a Beat always touches the Beat. So leaves select on a brush, and a Beat only
 * when the box swallows it whole — otherwise "group these two" would mean "group the Beat".
 */
export function marqueeOvercatch(box: Box, nodes: MarqueeCandidate[]): string[] {
  return nodes.filter((n) => n.selected && n.strict && !encloses(box, n.box)).map((n) => n.id);
}

/** A marquee in pane pixels → canvas coordinates: the inverse of React Flow's `[tx, ty, zoom]`. */
export function paneRectToFlow(rect: Box, [tx, ty, zoom]: readonly [number, number, number]): Box {
  const z = zoom || 1;
  return { x: (rect.x - tx) / z, y: (rect.y - ty) / z, width: rect.width / z, height: rect.height / z };
}

// ── snap-to-grid: one boolean, shared between the toolbar toggle and DirectorApp's RF prop ──

const SNAP_KEY = "bd:snap";
const listeners = new Set<() => void>();

function readSnap(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SNAP_KEY) === "1";
  } catch {
    return false;
  }
}

let snap = readSnap();

export function isSnapOn(): boolean {
  return snap;
}

export function setSnap(on: boolean): void {
  if (snap === on) return;
  snap = on;
  try {
    localStorage.setItem(SNAP_KEY, on ? "1" : "0");
  } catch {
    // no storage (tests, a locked-down page): the switch still works for the session
  }
  for (const l of listeners) l();
}

export function toggleSnap(): void {
  setSnap(!snap);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const read = () => snap;

/** Live view of the switch; re-renders the caller when it flips. */
export function useSnapToGrid(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}
