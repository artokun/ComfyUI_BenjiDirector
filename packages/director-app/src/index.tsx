// Public surface of the bundle the panel loads.
//
// Two things, because the panel's content-provider contract is mount/teardown plus an
// agent-drive facade. Everything else stays inside the bundle.
//
// `drive(name, args)` is how the agent reaches the editor: the orchestrator forwards a
// `director_<name>` command over the bridge, the panel's content-provider calls this, and the
// editor runs the SAME handler the mouse would. The editor mints every id and validates every
// connection, so a tool call cannot do anything a hand cannot.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { DirectorApp, type DriveFn } from "./DirectorApp.jsx";

export interface MountOptions {
  /** Where Calliope lives. Falls back to the client's default. */
  calliopeBaseUrl?: string;
}

export interface DirectorHandle {
  teardown(): void;
  /** Run one editor command by name. Throws an Error with a human-readable reason. */
  drive(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Is the editor mounted and accepting commands? */
  ready(): boolean;
}

export function mountDirector(el: HTMLElement, opts: MountOptions = {}): DirectorHandle {
  const apiRef: { current: DriveFn | null } = { current: null };
  const root: Root = createRoot(el);
  root.render(createElement(DirectorApp, { ...opts, apiRef }));
  return {
    teardown() {
      apiRef.current = null;
      root.unmount();
    },
    async drive(name, args = {}) {
      if (!apiRef.current) throw new Error("director editor is not ready yet");
      return apiRef.current(name, args);
    },
    ready: () => !!apiRef.current,
  };
}

export { DirectorApp };
export type { DriveFn };
