// Panel registry: a feature module adds a tab to the Director without touching DirectorApp.
//
//   registerPanel({ id: "assets", label: "Assets", icon: "user", order: 30, Component: AssetsPanel });
//
// Registration is a side effect of importing the module, so a module that is never imported
// is a tab that never appears — which is exactly how a build with a unit missing should look.

import { useSyncExternalStore, type ComponentType } from "react";
import type { IconName } from "./icons.js";

export interface PanelDef {
  id: string;
  label: string;
  icon?: IconName;
  /** Lower first. Canvas is 0. */
  order?: number;
  Component: ComponentType;
  /** Optional live badge (count, dot). */
  badge?: () => string | number | null;
  /** Where the panel shows: a tab replacing the canvas area, or a dock beside it. */
  placement?: "tab" | "dock";
}

const panels = new Map<string, PanelDef>();
const listeners = new Set<() => void>();
let version = 0;
let snapshot: PanelDef[] = [];

const rebuild = () => {
  snapshot = [...panels.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
  version += 1;
  for (const l of listeners) l();
};

export function registerPanel(def: PanelDef): () => void {
  panels.set(def.id, def);
  rebuild();
  return () => {
    panels.delete(def.id);
    rebuild();
  };
}

export function listPanels(): PanelDef[] {
  return snapshot;
}

export function usePanels(): PanelDef[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** For tests. */
export function _resetPanels(): void {
  panels.clear();
  rebuild();
}

export const panelsVersion = () => version;
