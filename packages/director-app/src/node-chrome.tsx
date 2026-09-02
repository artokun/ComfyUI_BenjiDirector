// Leaf-node chrome: the toolbar every Scene and Asset gets while selected, the header chevron
// that collapses a card to its title bar, the (i) tooltip, and the converged handles of a
// collapsed card.
//
// Ported from ifr-node-lab's `withDelete` HOC (src/flow/App.tsx): there every bench node is
// wrapped with the same overlays — a chevron at the left of the header, an info button at the
// right, and a floating NodeToolbar (TYPE | pin | delete) above the node while it is selected.
// Here the overlays are components the leaf renderers mount, because those renderers are ours
// to edit and a HOC would hide which node carries which chrome.
//
// Every mutation goes through `useActions()` — the editor's own `withCurrent → settle` path —
// never React Flow's setNodes. The drive commands live in node-chrome.drive.ts and register
// when this module is imported from index.tsx.

import { Handle, NodeToolbar, Position, useStoreApi, useUpdateNodeInternals, type Edge } from "@xyflow/react";
import { useEffect, useState, type MouseEvent } from "react";
import type { PortInfo } from "@benjidirector/graph-core";
import { useActions } from "./actions.js";
import type { RFNode } from "./drive-registry.js";
import { Icon } from "./icons.js";
import { useModal } from "./modal.jsx";
import { GROUP_PRESET_COLORS, type DirectorData } from "./model.js";
import { defaultTint, edgesTouching, headerHandleLayout, infoLinesOf, isLeaf, normalizeHex, typeLabelOf } from "./node-chrome.js";
import "./node-chrome.drive.js";
import "./styles/u2-node-chrome.css";

const stop = (e: MouseEvent) => e.stopPropagation();

/**
 * The floating toolbar above a selected leaf: TYPE · colour · pin (inside a subgraph only) ·
 * bypass · delete. The swatch popover lives INSIDE the toolbar for the reason the container
 * toolbar gives — the toolbar is portalled above the canvas, anything inside the card is not.
 */
export function LeafToolbar({ id, data, visible }: { id: string; data: DirectorData; visible: boolean }) {
  const actions = useActions();
  const modal = useModal();
  const store = useStoreApi<RFNode, Edge>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    if (!visible) setPaletteOpen(false);
  }, [visible]);

  const leaf = isLeaf(data) ? data : null;
  const color = data.kind === "note" ? data.color : leaf?.color;
  const bypassed = !!leaf?.bypassed;
  const promoted = !!leaf?.promoted;
  // Outside a subgraph there is no collapsed face for a pin to put anything on, so offering
  // one would be a control that silently does nothing.
  const pinnable = !!leaf?.inSubgraph;
  const label = data.kind === "scene" ? data.heading : data.label;
  const swatch = color ?? defaultTint(data);

  const pickColor = (next: string | null) => {
    actions?.setNodeColor(id, next);
    setPaletteOpen(false);
  };

  const del = async (e: MouseEvent) => {
    e.stopPropagation();
    // Only a wired node asks first: deleting it also deletes what it is wired to, and that is
    // the part a slip of the hand cannot see. An unwired node just goes.
    const wires = edgesTouching(store.getState().edges, id).length;
    if (wires > 0) {
      const ok = await modal.confirm({
        title: `Delete ${label}?`,
        body: `${wires} wire${wires === 1 ? "" : "s"} go${wires === 1 ? "es" : ""} with it.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    actions?.deleteNode(id);
  };

  return (
    <NodeToolbar isVisible={visible} position={Position.Top} offset={6} className="bd-nodebar bd-leafbar" onPointerDown={(e) => e.stopPropagation()}>
      <span className="bd-nodebar-kind" data-bd="type">
        {typeLabelOf(data)}
      </span>
      <button
        type="button"
        className="bd-tbtn bd-tbtn-swatch"
        data-bd="color"
        title={color ? `Colour ${color} — click to change` : "Colour"}
        style={{ background: swatch }}
        onClick={(e) => {
          e.stopPropagation();
          setPaletteOpen((v) => !v);
        }}
      />
      {pinnable ? (
        <button
          type="button"
          className={`bd-pin${promoted ? " is-on" : ""}`}
          data-bd="pin"
          title={promoted ? "Promoted — shows on the collapsed Beat's face (click to unpromote)" : "Promote — show this on the collapsed Beat's face"}
          onClick={(e) => {
            e.stopPropagation();
            actions?.togglePin(id);
          }}
        >
          <Icon name="pin" />
        </button>
      ) : null}
      {leaf ? (
        <button
          type="button"
          className={`bd-tbtn bd-tbtn-icon${bypassed ? " is-on" : ""}`}
          data-bd="bypass"
          aria-pressed={bypassed}
          title={bypassed ? "Bypassed — skipped by render tools (click to include it again)" : "Bypass — keep the node, skip it in render tools"}
          onClick={(e) => {
            e.stopPropagation();
            actions?.setBypassed(id, !bypassed);
          }}
        >
          <Icon name="eyeOff" />
        </button>
      ) : null}
      <span className="bd-sep" />
      <button type="button" className="bd-tbtn bd-tbtn-icon bd-tbtn-danger" data-bd="delete" title="Delete node" onClick={(e) => void del(e)}>
        <Icon name="trash" />
      </button>
      {paletteOpen ? (
        <div className="bd-swatches nodrag" data-bd="swatches" onClick={stop} onPointerDown={(e) => e.stopPropagation()}>
          {GROUP_PRESET_COLORS.map((c) => (
            <button type="button" key={c} className={`bd-swatch${color === c ? " is-on" : ""}`} style={{ background: c }} title={c} onClick={() => pickColor(c)} />
          ))}
          <button type="button" className={`bd-swatch bd-swatch-none${!color ? " is-on" : ""}`} title="No tint" onClick={() => pickColor(null)} />
          <input
            className="bd-swatch-hex"
            type="text"
            placeholder="#hex"
            defaultValue={color ?? ""}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const hex = normalizeHex((e.target as HTMLInputElement).value);
              if (hex) pickColor(hex);
            }}
          />
        </div>
      ) : null}
    </NodeToolbar>
  );
}

/** The chevron at the left of a leaf's header: collapse to the header, expand again. */
export function LeafCaret({ id, collapsed }: { id: string; collapsed: boolean }) {
  const actions = useActions();
  return (
    <button
      type="button"
      className="bd-leaf-caret nodrag"
      data-bd="caret"
      title={collapsed ? "Expand" : "Collapse to the header"}
      aria-expanded={!collapsed}
      onClick={(e) => {
        e.stopPropagation();
        actions?.setNodeCollapsed(id, !collapsed);
      }}
    >
      <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} strokeWidth={2} />
    </button>
  );
}

/** The (i) at the right of the header. Hover shows the scene's action / dialog / duration, or the asset's kind. */
export function LeafInfo({ data }: { data: DirectorData }) {
  const lines = infoLinesOf(data);
  return (
    <span className="bd-leaf-info nodrag" data-bd="info" onDoubleClick={stop}>
      <Icon name="info" size={12} />
      <span className="bd-leaf-tip" role="tooltip">
        <span className="bd-leaf-tip-kind">{typeLabelOf(data)}</span>
        {lines.map((l) => (
          <span className="bd-leaf-tip-row" key={l.k}>
            <span>{l.k}</span>
            <span>{l.v}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A collapsed leaf's handles, stacked on one dot at the header's edge — every port keeps its
 * own handle id at the same spot (the way RailHub stacks a collapsed Beat's rails), so each
 * wire stays attached and finds its own row again when the card expands.
 */
export function LeafHub({ side, ports }: { side: "in" | "out"; ports: PortInfo[] }) {
  const layout = headerHandleLayout(ports);
  const list = side === "in" ? layout.ins : layout.outs;
  const title = side === "in" ? layout.inTitle : layout.outTitle;
  return (
    <>
      {list.map((p) => (
        <Handle key={p.id} id={p.id} type={side === "in" ? "target" : "source"} position={side === "in" ? Position.Left : Position.Right} className="bd-leaf-hub" title={title} />
      ))}
    </>
  );
}

/**
 * Re-measure a leaf's handles when it collapses or expands. Without this React Flow keeps
 * the OLD handle positions and every wire to the card renders to a point that is no longer
 * on it — the same class of wrongness as mispositioning the handle itself.
 */
export function useLeafInternals(id: string, collapsed: boolean): void {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateInternals(id);
  }, [id, collapsed, updateInternals]);
}
