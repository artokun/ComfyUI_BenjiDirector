// Keeping the inspector open across a write.
//
// Every form write ends in `refresh()`, and a refresh REBUILDS the canvas from the rows it
// just read — new node objects, none of them selected (measured: after `project_refresh` the
// canvas reports 0 selected nodes). The inspector follows the selection, so without this it
// would close itself on every save, taking the focused field and the form's own state with
// it — including the "Saved" it was about to show.
//
// So a write HOLDS the node it is editing. Two details the first attempt got wrong:
//
//   - the hold is released by the OBSERVER, not the writer. `drive("inspect")` resolves as
//     soon as the settle is queued, well before React has committed the restored selection,
//     so releasing at the end of the write still flashed the empty state for a frame and
//     unmounted the form. The inspector releases it once the selection has caught up.
//   - a selection made DURING the write wins. The guard `if_unselected` is not enough on its
//     own, because the refresh wipes that selection before the restore can see it — so the
//     inspector reports every selection it observes while a hold is up, and the restore puts
//     back the node most recently chosen rather than the one the write started on.
//
// Nothing is held unless a write is in flight, which is what keeps an ordinary click on the
// empty pane clearing the inspector the way it should.

import { useCallback, useSyncExternalStore } from "react";
import { useDirector } from "../director-context.jsx";

export interface HoldState {
  /** The node a write is keeping on screen, or null. */
  id: string | null;
  /** The write is done; the hold lifts as soon as the canvas selection catches up. */
  releasable: boolean;
}

const NONE: HoldState = { id: null, releasable: false };
let snapshot: HoldState = NONE;
let depth = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};
const publish = (next: HoldState) => {
  snapshot = next;
  emit();
};
const stopTimer = () => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
};

export const holdState = (): HoldState => snapshot;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useHold(): HoldState {
  return useSyncExternalStore(subscribe, holdState, holdState);
}

/**
 * The inspector reports a selection made while a hold is up. It becomes what the hold shows
 * and what the restore re-selects: the refresh is about to wipe it from the canvas, and
 * putting back the node the write started on would drag the user off their own pick.
 */
export function noteSelection(id: string): void {
  if (snapshot.id === null || snapshot.id === id) return;
  publish({ id, releasable: snapshot.releasable });
}

/** The inspector calls this once the selection agrees again. A hold still in flight stays up. */
export function releaseHold(): void {
  if (depth > 0 || snapshot.id === null) return;
  stopTimer();
  publish(NONE);
}

/**
 * `refresh()` for a form: re-read the project, keep `nodeId` on screen throughout, and put
 * the canvas selection back on it. Overlapping writes nest; the hold lifts when the last one
 * is done AND the selection has caught up (or after a moment, if it never does).
 */
export function useHeldRefresh(nodeId: string): () => Promise<void> {
  const { refresh, drive } = useDirector();
  return useCallback(async () => {
    depth += 1;
    stopTimer();
    publish({ id: nodeId, releasable: false });
    try {
      await refresh();
      // The node the user is on NOW — theirs if they moved while this write was in flight.
      await drive("inspect", { id: snapshot.id ?? nodeId, if_unselected: true }).catch(() => undefined);
    } finally {
      depth -= 1;
      if (depth === 0) {
        publish({ id: snapshot.id ?? nodeId, releasable: true });
        // Backstop: if the selection never comes back (the row vanished under us), do not
        // hold a node on screen forever.
        timer = setTimeout(() => {
          timer = null;
          releaseHold();
        }, 2000);
      }
    }
  }, [drive, nodeId, refresh]);
}

/** For tests. */
export function _resetHold(): void {
  depth = 0;
  stopTimer();
  publish(NONE);
}
