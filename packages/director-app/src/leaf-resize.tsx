// [U1] The corner grip on a leaf node.
//
// React Flow's `NodeResizeControl` writes `node.width` / `node.height` through the same
// `dimensions` change the Beat resizer uses, so a resized Scene survives a settle, a save
// and an undo exactly like a resized Beat does. One control, bottom-right, always present but
// faint until the card is hovered or selected — a card you can resize should look like one.

import { NodeResizeControl } from "@xyflow/react";
import { Icon } from "./icons.js";
import "./styles/u1-stability.css";

export const LEAF_MIN_WIDTH = 180;
export const LEAF_MIN_HEIGHT = 80;

export function LeafResizeGrip() {
  return (
    <NodeResizeControl position="bottom-right" minWidth={LEAF_MIN_WIDTH} minHeight={LEAF_MIN_HEIGHT} className="bd-grip">
      <Icon name="grip" size={10} strokeWidth={2} />
    </NodeResizeControl>
  );
}
