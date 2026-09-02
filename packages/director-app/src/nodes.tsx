// Node renderers.
//
// Four types, matching graph-core's model: `scene`, `asset`, `groupbox` (an un-promoted
// Beat) and `subgraph` (a promoted one, which is the only type that draws rails).
//
// THE RAIL IS THE INTERESTING PART, and it is ported from ifr-node-lab rather than invented:
//
//  - A rail straddles the container's edge, vertically centred. Each pill carries TWO handles:
//    the OUTER one faces the world, the INNER one faces the children. That is the two-edge
//    model made visible — one pill, two handles — so it reads as an alias rather than a node.
//  - Every pill in a rail shares one width: the widest label, clamped, and while you rename
//    one the in-progress text drives it ("adjust as you type").
//  - Double-click a pill to RENAME it. The commit dedupes against the other labels in the same
//    rail via uniquifyLabel, so two rails can never show the same text.
//  - Drag a pill within its rail to REORDER it. Rail order is user state, and reconcile
//    restores it by id.
//  - Every rail ends in a `+` EMPTY SLOT whose whole body is a drop target. Wiring a child into
//    it authors a new boundary port — the only way to create a rail no crossing edge would have
//    produced, i.e. a pinned one.
//
// Handle `style` here carries appearance and rail-local placement ONLY. It must never carry a
// `top` that is meant to position against the NODE: React Flow anchors a handle to its nearest
// positioned ancestor, and getting that wrong walks the handle out of the card and takes the
// edge endpoint with it.

import {
  Handle,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { emptySlotHandle, innerHandleId, type BoundaryPort } from "@benjidirector/graph-core";
import { useActions } from "./actions.js";
import { FaceRow } from "./faces.jsx";
import { ACCENT, ContainerToolbar } from "./container-toolbar.jsx";
import { Icon } from "./icons.js";
import { RenderBadge } from "./render-badge.jsx";
import { BYPASS_TITLE, headerHandleLayout, leafClassName, leafStyle } from "./node-chrome.js";
import { LeafCaret, LeafHub, LeafInfo, LeafToolbar, useLeafInternals } from "./node-chrome.jsx";
import {
  PORT_COLOR,
  type AssetData,
  type BeatData,
  type DirectorPortType,
  type SceneData,
} from "./model.js";

export const PILL_H = 24;
export const PILL_GAP = 6;
const PILL_MAX_CHARS = 22;
const PILL_MIN_CHARS = 3;


/** Opaque pill fill derived from the container's tint, so rails read as the same accent. */
const pillBg = (color: string) => `color-mix(in srgb, #000 55%, ${color})`;

/**
 * Width, in `ch`, shared by every pill in a rail: the widest label, clamped. A pill being
 * renamed contributes its in-progress text so the rail grows as you type instead of clipping.
 */
function railChars(ports: BoundaryPort[], editingId: string | null, editingText: string): number {
  let max = PILL_MIN_CHARS;
  for (const bp of ports) {
    const len = (editingId === bp.id ? editingText : bp.label).length;
    if (len > max) max = len;
  }
  return Math.min(Math.max(max, PILL_MIN_CHARS), PILL_MAX_CHARS);
}

const dot = (type: DirectorPortType) => ({
  background: PORT_COLOR[type] ?? "#9ca3af",
  width: 9,
  height: 9,
  border: "2px solid #14141a",
});

// ── leaves ─────────────────────────────────────────────────────────────────────────────────
//
// A leaf's chrome — the selected-node toolbar (TYPE · colour · pin · bypass · delete), the
// header chevron that collapses it to its title bar, the (i) tip — lives in node-chrome.tsx;
// the renderers below only decide what a Scene and an Asset show inside that chrome.
// Collapsed, the card is its header and every handle converges on the header's edges (each
// keeps its id, so the wires stay attached); the leaf hook re-measures on the flip.

export function SceneNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as SceneData;
  const { ins, outs } = headerHandleLayout(d.ports);
  const collapsed = !!d.collapsed;
  useLeafInternals(id, collapsed);
  return (
    <div
      className={leafClassName("bd-scene", { selected: !!selected, promoted: !!d.promoted, bypassed: !!d.bypassed, collapsed })}
      style={leafStyle(d)}
      title={d.bypassed ? BYPASS_TITLE : undefined}
    >
      <LeafToolbar id={id} data={d} visible={!!selected} />
      <div className="bd-node-title">
        {collapsed ? <LeafHub side="in" ports={ins} /> : null}
        <LeafCaret id={id} collapsed={collapsed} />
        <span className="bd-title-grow">
          <EditableTitle id={id} label={d.heading} />
        </span>
        {d.durationSec !== undefined ? <span className="bd-chip">{d.durationSec}s</span> : null}
        <LeafInfo data={d} />
        {collapsed ? <LeafHub side="out" ports={outs} /> : null}
      </div>
      {collapsed ? null : (
        <>
          <RenderBadge id={id} videoPath={d.videoPath} />
          <div className="bd-ports">
            {ins.map((p) => (
              <div className="bd-port" key={p.id}>
                <Handle type="target" position={Position.Left} id={p.id} style={dot(p.type as DirectorPortType)} />
                <span>{p.label}</span>
              </div>
            ))}
            {outs.map((p) => (
              <div className="bd-port bd-port-out" key={p.id}>
                <span>{p.label}</span>
                <Handle type="source" position={Position.Right} id={p.id} style={dot(p.type as DirectorPortType)} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function AssetNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as AssetData;
  const { outs } = headerHandleLayout(d.ports);
  const collapsed = !!d.collapsed;
  useLeafInternals(id, collapsed);
  const icon = <Icon name={d.asset === "character" ? "user" : d.asset === "location" ? "mapPin" : "box"} />;
  return (
    <div
      className={leafClassName("bd-asset", { selected: !!selected, promoted: !!d.promoted, bypassed: !!d.bypassed, collapsed })}
      style={leafStyle(d)}
      title={d.bypassed ? BYPASS_TITLE : undefined}
    >
      <LeafToolbar id={id} data={d} visible={!!selected} />
      <div className="bd-node-title">
        <LeafCaret id={id} collapsed={collapsed} />
        <span className="bd-icon">{icon}</span>
        <span className="bd-title-grow">
          <EditableTitle id={id} label={d.label} />
        </span>
        <LeafInfo data={d} />
        {collapsed ? <LeafHub side="out" ports={outs} /> : null}
      </div>
      {collapsed || !outs.length ? null : (
        <div className="bd-ports">
          {outs.map((p) => (
            <div className="bd-port bd-port-out" key={p.id}>
              <span>{p.label}</span>
              <Handle type="source" position={Position.Right} id={p.id} style={dot(p.type as DirectorPortType)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A container's title, editable in place.
 *
 * ifr-node-lab's EditableTitle. `nodrag` matters: without it React Flow starts panning the
 * moment you press into the input, and you can never place a cursor.
 */
function EditableTitle({ id, label }: { id: string; label: string }) {
  const actions = useActions();
  const [text, setText] = useState<string | null>(null);
  if (text === null) {
    return (
      <span
        className="bd-title-text"
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setText(label);
        }}
      >
        {label}
      </span>
    );
  }
  const commit = () => {
    actions?.renameNode(id, text);
    setText(null);
  };
  return (
    <input
      className="bd-title-input nodrag"
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setText(null);
      }}
    />
  );
}

/** An un-promoted Beat: a box you drag scenes into. No rails yet, by definition. */
export function GroupNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as BeatData;
  const tint = d.color ?? ACCENT;
  return (
    <div
      className={`bd-group${selected ? " is-selected" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        borderColor: `color-mix(in srgb, ${tint} 55%, #6d5a86)`,
        background: `color-mix(in srgb, ${tint} 7%, transparent)`,
      }}
    >
      <NodeResizer minWidth={280} minHeight={200} isVisible={!!selected} color={tint} />
      <ContainerToolbar id={id} isSubgraph={false} visible={!!selected} color={d.color} />
      <div className="bd-group-title">
        <Icon name="film" /> <EditableTitle id={id} label={d.label} />
        <span className="bd-hint">group — make it a subgraph to expose its edges</span>
      </div>
    </div>
  );
}

function Rail({
  containerId,
  side,
  ports,
  collapsed,
  tint,
}: {
  containerId: string;
  side: "in" | "out";
  ports: BoundaryPort[];
  collapsed: boolean;
  tint: string;
}) {
  const actions = useActions();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  const outerPos = side === "in" ? Position.Left : Position.Right;
  const innerPos = side === "in" ? Position.Right : Position.Left;
  const outerType = side === "in" ? "target" : "source";
  const innerType = side === "in" ? "source" : "target";

  const chars = railChars(ports, editing?.id ?? null, editing?.text ?? "");
  // A CONTENT width (the stylesheet sets content-box): uppercase tracked caps run wider than
  // `ch` (the width of "0"), so budget 1.18ch per character plus a little air. A clipped rail
  // label is a wrong label.
  const pillWidth = `calc(${(chars * 1.18).toFixed(2)}ch + 8px)`;

  const commit = (bp: BoundaryPort, raw: string) => {
    const next = raw.trim();
    setEditing(null);
    if (!next || next === bp.label) return;
    actions?.renameRail(containerId, side, bp.id, next);
  };

  // Rail-local handle placement. `top: 50%` centres the dot on ITS PILL — the pill is the
  // positioned ancestor here, which is exactly what we want, unlike on a scene card.
  const handleStyle = (bp: BoundaryPort, outer: boolean) => ({
    ...dot(bp.type as DirectorPortType),
    ...(outer ? {} : { opacity: 0.55 }),
    top: "50%",
  });

  return (
    <div className={`bd-rail bd-rail-${side}${collapsed ? " is-collapsed" : ""}`}>
      {ports.map((bp, i) => (
        <div
          key={bp.id}
          className={`bd-pill${bp.forced ? " is-pinned" : ""}${dragOver === i ? " is-drag-over" : ""}`}
          style={{ height: PILL_H, width: pillWidth, background: pillBg(tint), borderColor: tint }}
          title={`${bp.label} — double-click to rename, drag to reorder`}
          onPointerDown={(e) => {
            if (editing || e.button !== 0) return;
            dragFrom.current = i;
          }}
          onPointerEnter={() => {
            if (dragFrom.current !== null) setDragOver(i);
          }}
          onPointerUp={() => {
            const from = dragFrom.current;
            dragFrom.current = null;
            setDragOver(null);
            if (from !== null && from !== i) actions?.reorderRail(containerId, side, from, i);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing({ id: bp.id, text: bp.label });
          }}
        >
          <Handle id={bp.id} type={outerType} position={outerPos} style={handleStyle(bp, true)} />
          {editing?.id === bp.id ? (
            <input
              className="bd-pill-input nodrag"
              autoFocus
              value={editing.text}
              onChange={(e) => setEditing({ id: bp.id, text: e.target.value })}
              onBlur={() => commit(bp, editing.text)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit(bp, editing.text);
                else if (e.key === "Escape") setEditing(null);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="bd-pill-label">{bp.label}</span>
          )}
          <Handle id={innerHandleId(bp.id)} type={innerType} position={innerPos} style={handleStyle(bp, false)} />
        </div>
      ))}

      {/* Trailing empty slot. The inner handle fills the whole pill so a wire can be dropped
          anywhere on it; the outer keeps a small dashed dot for wiring in from outside. */}
      {collapsed ? null : (
        <div
          className="bd-pill bd-pill-empty"
          style={{ height: PILL_H, width: pillWidth }}
          title={side === "in" ? "Drop a wire here to add an input rail" : "Drop a wire here to add an output rail"}
        >
          <span className="bd-pill-label bd-pill-plus">+</span>
          <Handle
            id={emptySlotHandle(containerId, side, false)}
            type={outerType}
            position={outerPos}
            style={{
              width: 9,
              height: 9,
              background: "transparent",
              border: "2px dashed #9fb0c8",
              top: "50%",
              zIndex: 1,
            }}
          />
          <Handle
            id={emptySlotHandle(containerId, side, true)}
            type={innerType}
            position={innerPos}
            className="bd-empty-hit"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              borderRadius: 8,
              background: "transparent",
              border: "none",
              transform: "none",
              zIndex: 2,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A collapsed Beat's rails, stacked on one hub at the header's edge.
 *
 * One visible dot per side; behind it, every boundary port's outer handle at the same spot
 * (so each wire keeps its own handle id and re-attaches when the Beat expands) plus its inner
 * relay handle, zero-sized — the children are hidden, but React Flow still wants the handle a
 * hidden edge names to exist.
 */
function RailHub({ containerId, side, ports, tint }: { containerId: string; side: "in" | "out"; ports: BoundaryPort[]; tint: string }) {
  const outerType = side === "in" ? "target" : "source";
  const innerType = side === "in" ? "source" : "target";
  const outerPos = side === "in" ? Position.Left : Position.Right;
  const innerPos = side === "in" ? Position.Right : Position.Left;
  const title = ports.length ? `${side === "in" ? "in" : "out"}: ${ports.map((p) => p.label).join(", ")}` : side === "in" ? "no inputs" : "no outputs";
  return (
    <>
      {ports.map((bp) => (
        <Handle
          key={bp.id}
          id={bp.id}
          type={outerType}
          position={outerPos}
          className="bd-hub"
          title={title}
          style={{ background: tint, top: "50%" }}
        />
      ))}
      {ports.map((bp) => (
        <Handle key={innerHandleId(bp.id)} id={innerHandleId(bp.id)} type={innerType} position={innerPos} className="bd-hub-inner" style={{ top: "50%" }} />
      ))}
      {ports.length === 0 ? <span className={`bd-hub bd-hub-empty bd-hub-${side}`} title={title} /> : null}
    </>
  );
}

/** A promoted Beat. Expanded it shows its rails; collapsed it is one card that still wires. */
export function SubgraphNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as BeatData;
  const collapsed = !!d.collapsed;
  const actions = useActions();
  const updateInternals = useUpdateNodeInternals();
  const tint = d.color ?? ACCENT;

  // Handle geometry changes whenever the rails change or the card collapses. Without this,
  // React Flow keeps the OLD handle positions and every edge to this container renders to a
  // stale point — the same class of wrongness as mispositioning the handle itself.
  useEffect(() => {
    updateInternals(id);
  }, [id, collapsed, d.promotedIn.length, d.promotedOut.length, d.faces?.length, updateInternals]);

  const caret = (
    <button
      type="button"
      className="bd-caret nodrag"
      title={collapsed ? "Expand" : "Collapse"}
      onClick={(e) => {
        e.stopPropagation();
        actions?.toggleCollapse(id);
      }}
    >
      {collapsed ? "▶" : "▼"}
    </button>
  );

  if (collapsed) {
    // Collapsed, a Beat is a composed node, not a box with rails (ifr-node-lab's collapsed
    // subgraph): every input wire lands on ONE hub at the header's left edge, every output
    // leaves from one hub at its right, the body is the pinned widgets — and with nothing
    // pinned the whole thing is a pill. The rails still exist as handles (each keeps its id,
    // so the wires stay attached); they are just stacked on the hub instead of listed.
    const faces = d.faces ?? [];
    const pill = faces.length === 0;
    return (
      <div
        className={`bd-collapsed${pill ? " is-pill" : ""}${selected ? " is-selected" : ""}`}
        style={{ width: "100%", height: "auto", borderColor: tint, background: `color-mix(in srgb, ${tint} 10%, #1e1e26)` }}
      >
        {/* Width only: a collapsed card is content-height by definition. The width the user
            chooses here is remembered as the card's own, separate from the expanded box. */}
        <NodeResizer
          minWidth={200}
          minHeight={1}
          isVisible={!!selected}
          color={tint}
          shouldResize={(_e, p) => p.direction[1] === 0}
          onResizeEnd={(_e, p) => actions?.updateNode(id, { collapsedWidth: Math.round(p.width) })}
        />
        <ContainerToolbar id={id} isSubgraph collapsed visible={!!selected} color={d.color} />
        <div className="bd-collapsed-head">
          <RailHub containerId={id} side="in" ports={d.promotedIn} tint={tint} />
          {caret}
          <span className="bd-collapsed-title">
            <Icon name="film" /> <EditableTitle id={id} label={d.label} />
          </span>
          <span className="bd-hint">
            {d.promotedIn.length} in · {d.promotedOut.length} out
          </span>
          <RailHub containerId={id} side="out" ports={d.promotedOut} tint={tint} />
        </div>
        {pill ? null : (
          <div className="bd-collapsed-body">
            <div className="bd-faces">
              {faces.map((f) => (
                <FaceRow face={f} key={f.id} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`bd-group bd-subgraph${selected ? " is-selected" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        borderColor: tint,
        background: `color-mix(in srgb, ${tint} 10%, transparent)`,
      }}
    >
      <NodeResizer minWidth={320} minHeight={220} isVisible={!!selected} color={tint} />
      <ContainerToolbar id={id} isSubgraph collapsed={false} visible={!!selected} color={d.color} />
      <div className="bd-group-title">
        {caret}
        <Icon name="film" /> <EditableTitle id={id} label={d.label} />
        <span className="bd-hint">
          {d.promotedIn.length} in · {d.promotedOut.length} out
        </span>
      </div>
      <Rail containerId={id} side="in" ports={d.promotedIn} collapsed={false} tint={tint} />
      <Rail containerId={id} side="out" ports={d.promotedOut} collapsed={false} tint={tint} />
    </div>
  );
}

export const nodeTypes = {
  scene: SceneNode,
  asset: AssetNode,
  groupbox: GroupNode,
  subgraph: SubgraphNode,
};
