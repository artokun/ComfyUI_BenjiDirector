// Autosave — the working graph survives a reload. [U4]
//
// Writes `benjidirector/graph` 600 ms after the canvas last changed, and on every way the page
// can go away (pagehide, tab hidden, beforeunload, unmount) — ONLY while no Calliope project
// is loaded: a project round-trips through its rows and the topology sidecar, and the local
// slot must not be overwritten with a film that lives elsewhere.
//
// The change signal is React Flow's own store (the nodes it draws ARE the canonical nodes),
// but what gets written comes from `export_graph`, because the store's edges are the DISPLAYED
// ones and the collapse view rewrites those for drawing only.

import { useEffect, useMemo, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import { useDirector } from "./director-context.js";
import { createAutosaver } from "./persistence.js";

export function useAutosave(): void {
  const { projectId, drive } = useDirector();
  const store = useStoreApi();
  const driveRef = useRef(drive);
  driveRef.current = drive;

  const ctl = useMemo(
    () =>
      createAutosaver({
        read: () => driveRef.current("export_graph", { pretty: false }).then((r) => (r as { json: string }).json),
      }),
    [],
  );

  // Arriving on a graph (mount, a project opened or closed) disarms until the next task: the
  // store changes that land in the same commit are the load itself, not an edit.
  useEffect(() => {
    ctl.setProject(projectId);
    const t = window.setTimeout(() => ctl.arm(), 0);
    return () => window.clearTimeout(t);
  }, [ctl, projectId]);

  useEffect(() => {
    const unsub = store.subscribe((s, prev) => {
      if (s.nodes === prev.nodes && s.edges === prev.edges) return;
      ctl.changed();
    });
    const flush = () => ctl.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsub();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      ctl.flush();
    };
  }, [ctl, store]);

  useEffect(() => () => ctl.dispose(), [ctl]);
}
