// Z-order: who paints over whom on the canvas. Ported from ifr-node-lab's convention.
//
// A container (a Beat, expanded or collapsed) is pinned at CONTAINER_Z, below the wires;
// every leaf sits at or above 0, and the most recently clicked / dragged / spawned leaf is
// bumped to the top with a monotonic counter. Two things fall out of that:
//
//  - A wire that crosses a Beat's body draws ABOVE the body and stays hoverable, so the body
//    can be a real pointer target (select or drag the Beat by its body) instead of being made
//    transparent to the pointer with CSS, which took the body's resize grips with it.
//  - Selection never reshuffles the stack. React Flow's `elevateNodesOnSelect` would lift a
//    selected Beat (+1000) above the leaves outside it and above every wire; the editor sets
//    it false and owns the order here instead.
//
// Pure: the editor calls `applyZOrder` from its own handlers and writes the result to state.

import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";

export const CONTAINER_Z = -1;

interface ZNode {
  id: string;
  type?: string;
  zIndex?: number;
}

let zSeq = 0;

/** The next leaf z. Monotonic for the session, so a newly minted node lands on top. */
export function nextZ(): number {
  zSeq += 1;
  return zSeq;
}

export const isContainerType = (type: string | undefined): boolean => type === GROUP_TYPE || type === SUBGRAPH_TYPE;

/**
 * Enforce the convention on a node list, optionally bumping one leaf to the top.
 *
 * Containers get CONTAINER_Z; leaves keep whatever they have. `bump` names a leaf to lift
 * above every other leaf — above the counter AND above any z the graph already carries, so
 * a graph loaded with large values (an imported JSON) still bumps correctly. A container
 * named in `bump` is left pinned. Returns the SAME array when nothing changes, so a caller
 * can hand it to a state setter without forcing a render.
 */
export function applyZOrder<N extends ZNode>(nodes: readonly N[], bump?: string): N[] {
  let top: number | undefined;
  if (bump !== undefined) {
    const target = nodes.find((n) => n.id === bump);
    if (target && !isContainerType(target.type)) {
      let max = zSeq;
      for (const n of nodes) if (!isContainerType(n.type) && typeof n.zIndex === "number" && n.zIndex > max) max = n.zIndex;
      zSeq = max + 1;
      top = zSeq;
    }
  }
  let changed = false;
  const out = nodes.map((n) => {
    if (isContainerType(n.type)) {
      if (n.zIndex === CONTAINER_Z) return n;
      changed = true;
      return { ...n, zIndex: CONTAINER_Z };
    }
    if (top !== undefined && n.id === bump && n.zIndex !== top) {
      changed = true;
      return { ...n, zIndex: top };
    }
    return n;
  });
  return changed ? out : (nodes as N[]);
}

/** Does any node break the convention? Cheaper than applyZOrder when the answer is usually no. */
export function needsZOrder(nodes: readonly ZNode[]): boolean {
  return nodes.some((n) => isContainerType(n.type) && n.zIndex !== CONTAINER_Z);
}

/** For tests: reset the counter so numbers are predictable. */
export function _resetZ(): void {
  zSeq = 0;
}
