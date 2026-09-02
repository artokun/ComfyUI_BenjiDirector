// The DISPLAYED graph versus the canonical one. FOUNDATION IDENTITY HOOK — the group-collapse
// unit (U6) replaces the body: edges whose endpoint is hidden inside a collapsed plain group
// get re-routed to a proxy handle on the outermost collapsed ancestor, and edges wholly inside
// are hidden. State stays canonical; only what React Flow draws changes. Nothing else may
// write a displayed edge into state — the Calliope write-back diffs state.

import type { Edge, Node } from "@xyflow/react";

export function useDisplayedGraph<N extends Node, E extends Edge>(_nodes: N[], edges: E[]): E[] {
  return edges;
}
