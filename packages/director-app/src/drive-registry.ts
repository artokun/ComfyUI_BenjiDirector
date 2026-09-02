// The drive registry: how a feature module adds agent commands without editing the editor.
//
// `DirectorApp` keeps a small built-in `switch` for the core vocabulary and falls through to
// this registry for everything else. A module registers its commands at import time:
//
//   registerDriveCommands({
//     set_bypassed: (args, kit) => kit.run((ns, es) => { …; kit.settle(next, es, { reparent: false }); return {…}; }),
//   });
//
// The `kit` is the same toolbox the built-in commands use — `run` snapshots for undo and hands
// over the CURRENT graph, `settle` is the one mutation funnel, `find`/`num`/`str` refuse bad
// arguments with readable errors. A command must never keep a private copy of the graph.
//
// Names are editor-internal. A name only becomes reachable by the agent once comfyui-mcp's
// tool layer forwards it (see docs/drive-commands.md); keep both lists in step.

import type { Edge, Node } from "@xyflow/react";
import type { GraphNode } from "@benjidirector/graph-core";
import type { CalliopeClient } from "@benjidirector/calliope-client";
import type { EditorActions } from "./actions.js";
import type { DirectorData, DirectorPortType, NodeKind } from "./model.js";

export type RFNode = Node & { data: DirectorData };
export type DriveArgs = Record<string, unknown>;

export interface SettleOptions {
  reparent?: boolean;
  sync?: boolean;
  prev?: { nodes: RFNode[]; edges: Edge[] };
}

export interface DriveKit {
  /** Run against the CURRENT graph, snapshotting for undo first unless `history: false`. */
  run<T>(fn: (ns: RFNode[], es: Edge[]) => T, opts?: { history?: boolean }): Promise<T>;
  /** The one mutation funnel. Call it with the arrays you built from what `run` handed you. */
  settle(ns: RFNode[], es: Edge[], opts?: SettleOptions): void;
  find(ns: RFNode[], id: unknown): RFNode;
  num(v: unknown, what: string): number;
  str(v: unknown, what: string): string;
  isContainer(n: RFNode | undefined): boolean;
  handleTypes(ns: RFNode[]): Map<string, DirectorPortType>;
  makeNode(kind: NodeKind, at: { x: number; y: number }, label?: string): GraphNode<DirectorData>;
  actions: EditorActions;
  nodesRef: { current: RFNode[] };
  edgesRef: { current: Edge[] };
  setNote(msg: string): void;
  client: CalliopeClient;
  loadedProjectRef: { current: number | null };
  refreshProject(): Promise<void>;
  loadProject(projectId: number | null): Promise<void>;
  groupNodes(pick: (n: RFNode) => boolean, title?: string): string | undefined;
}

export type DriveHandler = (args: DriveArgs, kit: DriveKit) => unknown | Promise<unknown>;

const registry = new Map<string, DriveHandler>();

/** Register commands. A second registration of the same name replaces the first (HMR-safe). */
export function registerDriveCommands(commands: Record<string, DriveHandler>): void {
  for (const [name, fn] of Object.entries(commands)) registry.set(name, fn);
}

export function resolveDrive(name: string): DriveHandler | undefined {
  return registry.get(name);
}

export function listDriveCommands(): string[] {
  return [...registry.keys()].sort();
}
