// The editor's action surface, as a context.
//
// Node renderers, rail pills, collapsed-face controls and edge menus all reach the editor
// through this one object. It lives in its own module so `nodes.tsx` and `faces.tsx` can both
// import it without importing each other — the two-file cycle that otherwise forms is legal
// ESM but makes the load order a thing you have to think about, and nobody should have to.

import { createContext, useContext } from "react";
import type { AssetData, BeatData, NoteData, RerouteData, SceneData } from "./model.js";

/**
 * A partial write to any node's data. `kind` is omitted from each member on purpose: the
 * plain intersection collapses `"scene" & "asset" & "beat"` to `never` and takes the whole
 * patch type down with it.
 */
export type NodePatch = Partial<Omit<SceneData, "kind"> & Omit<AssetData, "kind"> & Omit<BeatData, "kind"> & Omit<NoteData, "kind"> & Omit<RerouteData, "kind">>;

export interface EditorActions {
  renameRail(containerId: string, side: "in" | "out", portId: string, label: string): void;
  reorderRail(containerId: string, side: "in" | "out", from: number, to: number): void;
  toggleCollapse(containerId: string): void;
  togglePin(nodeId: string): void;
  renameNode(nodeId: string, label: string): void;
  convertContainer(containerId: string, to: "group" | "subgraph"): void;
  setColor(containerId: string, color: string | undefined): void;
  /**
   * Merge a partial payload into a node's data. Every compact control writes through here.
   * `history: false` for per-keystroke edits — a form should not spend the undo stack.
   */
  updateNode(nodeId: string, patch: NodePatch, opts?: { history?: boolean }): void;
  saveBlueprint(containerId: string, name?: string): void;
  // ── [U0] the full surface; bodies filled by the units named. Unfilled ones set a note. ──
  /** [U2] Mute a leaf: low opacity, skipped by render tools. */
  setBypassed(nodeId: string, bypassed: boolean): void;
  /** [U2] Tint a leaf's header. null clears. */
  setNodeColor(nodeId: string, color: string | null): void;
  /** [U2] Collapse a leaf to its header (handles converge). */
  setNodeCollapsed(nodeId: string, collapsed: boolean): void;
  /** [U2] Delete one leaf node (containers go through deleteContainer). */
  deleteNode(nodeId: string): void;
  /** [U3] Duplicate nodes (subtrees), returns the new ids. */
  duplicate(nodeIds: string[]): string[];
  /** [U5] Delete a container: everything inside, or only the shell (children re-parent up). */
  deleteContainer(containerId: string, mode: "all" | "shell"): void;
  /** [U7] Re-save an existing blueprint from a container (the one linked to it when omitted). */
  updateBlueprint(blueprintId: string, containerId?: string): void;
  /** [U7] Remove a blueprint from the library. Asks first unless `confirm: false`. */
  deleteBlueprint(blueprintId: string, opts?: { confirm?: boolean }): void;
  /** [U9] Edit a note's markdown. */
  setNoteText(nodeId: string, text: string): void;
  /** [U21] Open a leaf's editable body — the third state, between collapsed and header-only. */
  setNodeExpanded(nodeId: string, expanded: boolean): void;
  /**
   * [U21] Move a scene into a Beat, or out of every Beat with `null`.
   *
   * The same write dragging a card into a Beat makes (`beat_id`), reached from the dopesheet
   * where the Beat is a ROW rather than a box. Absolute position is preserved, so the card does
   * not jump on the canvas when the sheet moves it.
   */
  moveToBeat(nodeId: string, containerId: string | null): void;
  /**
   * [U21] Move a scene to `toIndex` in the CUT — `order_index`, the film's real timeline.
   *
   * The one edit the canvas refuses to infer: `calliope-sync` will not read a cut out of
   * geometry, because tidying a canvas must never re-cut a film. A drag along a time axis is
   * not geometry, it is the statement "this plays later", so it lands here.
   */
  reorderScene(nodeId: string, toIndex: number): void;
}

export const ActionsContext = createContext<EditorActions | null>(null);
export const useActions = () => useContext(ActionsContext);
