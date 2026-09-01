// The editor's action surface, as a context.
//
// Node renderers, rail pills, collapsed-face controls and edge menus all reach the editor
// through this one object. It lives in its own module so `nodes.tsx` and `faces.tsx` can both
// import it without importing each other — the two-file cycle that otherwise forms is legal
// ESM but makes the load order a thing you have to think about, and nobody should have to.

import { createContext, useContext } from "react";
import type { AssetData, BeatData, SceneData } from "./model.js";

/**
 * A partial write to any node's data. `kind` is omitted from each member on purpose: the
 * plain intersection collapses `"scene" & "asset" & "beat"` to `never` and takes the whole
 * patch type down with it.
 */
export type NodePatch = Partial<Omit<SceneData, "kind"> & Omit<AssetData, "kind"> & Omit<BeatData, "kind">>;

export interface EditorActions {
  renameRail(containerId: string, side: "in" | "out", portId: string, label: string): void;
  reorderRail(containerId: string, side: "in" | "out", from: number, to: number): void;
  toggleCollapse(containerId: string): void;
  togglePin(nodeId: string): void;
  renameNode(nodeId: string, label: string): void;
  convertContainer(containerId: string, to: "group" | "subgraph"): void;
  setColor(containerId: string, color: string | undefined): void;
  /** Merge a partial payload into a node's data. Every compact control writes through here. */
  updateNode(nodeId: string, patch: NodePatch): void;
  saveBlueprint(containerId: string): void;
}

export const ActionsContext = createContext<EditorActions | null>(null);
export const useActions = () => useContext(ActionsContext);
