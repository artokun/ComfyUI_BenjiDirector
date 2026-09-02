// What every panel, form and node renderer may know about the editor without importing it.
//
// Filled by `DirectorApp`; read with `useDirector()`. Deliberately a flat bag of the things
// modules actually reach for — the Calliope client, the loaded project's rows, the selection,
// the drive function — rather than the editor's internals. A module that needs more than this
// is a module that wants to be in DirectorApp.tsx, and there is a registry for that instead
// (`drive-registry.ts`, `panels.ts`, `slots.tsx`).

import { createContext, useContext } from "react";
import type { CalliopeClient, JobRow, ReachabilityState, SceneRow, StoryBundle } from "@benjidirector/calliope-client";
import type { Blueprint } from "./blueprints.js";

export interface DirectorCtx {
  client: CalliopeClient;
  /** Calliope reachability, null while the first probe is in flight. */
  status: ReachabilityState | null;
  /** The loaded Calliope project id, or null for the local demo graph. */
  projectId: number | null;
  /** The loaded project's rows, as last read. Null for the demo graph. */
  story: StoryBundle | null;
  scenes: SceneRow[];
  /** Jobs for the loaded project, as last polled/pushed. Filled by the live unit. */
  jobs: JobRow[];
  /** Re-read the project and MERGE it into the canvas (keeps layout). */
  refresh(): Promise<void>;
  /** Replace the canvas with a project (or the demo with null). */
  loadProject(projectId: number | null): Promise<void>;
  note: string;
  setNote(message: string): void;
  /** Ids of the selected nodes, in canvas order. */
  selectedNodeIds: string[];
  /** Each loaded scene's current `video_settings`, so a partial write merges rather than clobbers. */
  settingsCache: Map<number, Record<string, unknown>>;
  blueprints: Record<string, Blueprint>;
  /** Run an editor command by name — the same path the agent uses. */
  drive(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /**
   * [U13] Delete the Calliope rows behind these nodes; the confirm is included. `gone` is what
   * may now leave the canvas — a row Calliope refused to delete keeps its node. On the demo
   * project (no rows) it confirms nothing and returns every id.
   */
  deleteRows(nodeIds: string[]): Promise<{ confirmed: boolean; gone: string[]; rows: SceneRow[] | null }>;
  /** Registered by feature modules; `undefined` until the live unit lands. */
  setJobs?(jobs: JobRow[]): void;
  /** Markdown → safe HTML, injected by the host (the panel passes marked + DOMPurify). */
  renderMarkdown?(md: string): string;
}

export const DirectorContext = createContext<DirectorCtx | null>(null);

export function useDirector(): DirectorCtx {
  const ctx = useContext(DirectorContext);
  if (!ctx) throw new Error("useDirector() must be used inside <DirectorApp>");
  return ctx;
}

/** The selection, and the one selected node when exactly one is. */
export function useSelection(): { ids: string[]; single: string | null } {
  const { selectedNodeIds } = useDirector();
  return { ids: selectedNodeIds, single: selectedNodeIds.length === 1 ? (selectedNodeIds[0] ?? null) : null };
}
