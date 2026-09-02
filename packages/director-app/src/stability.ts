// Pure helpers behind the editor's measurement kick. See DirectorApp's measurement effect.
//
// React Flow does not measure a hidden node (the children of a collapsed Beat), so a kick
// that waits for EVERY node to report a size waits forever the moment one is hidden — and
// the old kick re-armed a 60 s, 500 ms interval that force-remeasured every node and every
// handle on the canvas, on each node-list change. With a project's worth of nodes that is
// hundreds of forced layouts a second, which is what "dragging locks the tab up" looks like.

interface MeasurableNode {
  id: string;
  hidden?: boolean;
}

/**
 * The SET of visible ids as one string, sorted — the key the measurement effect re-arms on.
 * Sorted so a settle that only re-orders nodes (parents before children) does not re-arm it;
 * visible-only because those are the only nodes React Flow can measure.
 */
export function visibleIdKey(nodes: readonly MeasurableNode[]): string {
  const ids: string[] = [];
  for (const n of nodes) if (!n.hidden) ids.push(n.id);
  return ids.sort().join(",");
}

/** The ids in `ids` that `isMeasured` says have no size yet. Empty when the kick can stop. */
export function unmeasuredIds(ids: readonly string[], isMeasured: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const id of ids) if (!isMeasured(id)) out.push(id);
  return out;
}

/** How long the kick keeps trying before giving up on a node that cannot measure. */
export const KICK_INTERVAL_MS = 500;
export const KICK_MAX_TICKS = 120;
