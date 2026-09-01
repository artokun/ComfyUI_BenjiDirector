// Public surface of the bundle the panel loads.
//
// Two exports, because the panel's content-provider contract is mount/teardown plus an
// agent-drive facade. Everything else stays inside the bundle.

import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { DirectorApp } from "./DirectorApp.jsx";

export interface MountOptions {
  /** Where Calliope lives. Falls back to the client's default. */
  calliopeBaseUrl?: string;
}

export interface DirectorHandle {
  teardown(): void;
}

export function mountDirector(el: HTMLElement, opts: MountOptions = {}): DirectorHandle {
  const root: Root = createRoot(el);
  root.render(createElement(DirectorApp, opts));
  return {
    teardown() {
      root.unmount();
    },
  };
}

export { DirectorApp };
