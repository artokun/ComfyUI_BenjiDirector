// A container's own toolbar — convert it, tint it, collapse it, save it as a blueprint —
// without hunting for the right button in the pane toolbar and hoping the right thing is
// selected. Its own module so the deletion, blueprint and design units edit distinct lines.

import { NodeToolbar, Position } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useActions } from "./actions.js";
import { Icon } from "./icons.js";
import { GROUP_PRESET_COLORS } from "./model.js";

export const ACCENT = "#a78bfa";

export function ContainerToolbar({
  id,
  isSubgraph,
  collapsed,
  visible,
  color,
}: {
  id: string;
  isSubgraph: boolean;
  collapsed?: boolean;
  visible: boolean;
  color?: string;
}) {
  const actions = useActions();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    if (!visible) setPaletteOpen(false);
  }, [visible]);
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} className="bd-nodebar">
      <span className="bd-nodebar-kind">{isSubgraph ? "SUBGRAPH" : "GROUP"}</span>
      <button
        type="button"
        className={`bd-tbtn${!isSubgraph ? " is-on" : ""}`}
        title="Plain group — a box you drag scenes into"
        onClick={(e) => {
          e.stopPropagation();
          actions?.convertContainer(id, "group");
        }}
      >
        Group
      </button>
      <button
        type="button"
        className={`bd-tbtn${isSubgraph ? " is-on" : ""}`}
        title="Subgraph — expose its crossings as rails"
        onClick={(e) => {
          e.stopPropagation();
          actions?.convertContainer(id, "subgraph");
        }}
      >
        Subgraph
      </button>
      <button
        type="button"
        className="bd-tbtn"
        title={collapsed ? "Expand" : "Collapse to one card"}
        onClick={(e) => {
          e.stopPropagation();
          actions?.toggleCollapse(id);
        }}
      >
        {collapsed ? "Expand" : "Collapse"}
      </button>
      <button
        type="button"
        className="bd-tbtn bd-tbtn-swatch"
        title="Colour"
        style={{ background: color ?? ACCENT }}
        onClick={(e) => {
          e.stopPropagation();
          setPaletteOpen((v) => !v);
        }}
      />
      {isSubgraph ? (
        <button
          type="button"
          className="bd-tbtn"
          title="Save this Beat as a reusable blueprint"
          onClick={(e) => {
            e.stopPropagation();
            actions?.saveBlueprint(id);
          }}
        >
          <Icon name="save" />
        </button>
      ) : null}
      {/* [U5] delete button lands here */}
      {/* The swatch popover lives INSIDE the toolbar: the toolbar is portalled above the canvas,
          whereas anything rendered inside the container card is trapped under its children. */}
      {paletteOpen ? (
        <div className="bd-swatches nodrag" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {GROUP_PRESET_COLORS.map((c) => (
            <button
              type="button"
              key={c}
              className={`bd-swatch${(color ?? ACCENT) === c ? " is-on" : ""}`}
              style={{ background: c }}
              title={c}
              onClick={() => {
                actions?.setColor(id, c);
                setPaletteOpen(false);
              }}
            />
          ))}
          <input
            className="bd-swatch-hex"
            type="text"
            placeholder="#hex"
            defaultValue={color ?? ""}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = (e.target as HTMLInputElement).value.trim();
              if (/^#?[0-9a-fA-F]{3,8}$/.test(v)) {
                actions?.setColor(id, v.startsWith("#") ? v : `#${v}`);
                setPaletteOpen(false);
              }
            }}
          />
        </div>
      ) : null}
    </NodeToolbar>
  );
}
