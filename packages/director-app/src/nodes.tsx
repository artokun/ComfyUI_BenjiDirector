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
  NodeToolbar,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { emptySlotHandle, innerHandleId, type BoundaryPort } from "@benjidirector/graph-core";
import { PORT_COLOR, type AssetData, type BeatData, type DirectorPortType, type SceneData } from "./model.js";

export const PILL_H = 24;
export const PILL_GAP = 6;

export interface EditorActions {
  renameRail(containerId: string, side: "in" | "out", portId: string, label: string): void;
  reorderRail(containerId: string, side: "in" | "out", from: number, to: number): void;
  toggleCollapse(containerId: string): void;
  togglePin(nodeId: string): void;
}
export const ActionsContext = createContext<EditorActions | null>(null);
const useActions = () => useContext(ActionsContext);

const dot = (type: DirectorPortType) => ({
  background: PORT_COLOR[type] ?? "#9ca3af",
  width: 9,
  height: 9,
  border: "2px solid #14141a",
});

/**
 * The pin.
 *
 * ifr-node-lab's yellow pin, and it does one specific thing: it decides whether this node
 * shows up on its Beat's face when that Beat is collapsed. A collapsed container is meant to
 * read as a composed node — the few controls its author chose to surface — not as an opaque
 * box, and this is the only way to choose them.
 */
function PinToolbar({ id, promoted, visible }: { id: string; promoted: boolean; visible: boolean }) {
  const actions = useActions();
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} className="bd-nodebar">
      <button
        type="button"
        className={`bd-pin${promoted ? " is-on" : ""}`}
        title={
          promoted
            ? "Promoted — shows on the collapsed Beat's face (click to unpromote)"
            : "Promote — show this on the collapsed Beat's face"
        }
        onClick={(e) => {
          e.stopPropagation();
          actions?.togglePin(id);
        }}
      >
        📌
      </button>
    </NodeToolbar>
  );
}

export function SceneNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as SceneData;
  const ins = d.ports.filter((p) => p.isInput);
  const outs = d.ports.filter((p) => !p.isInput);
  return (
    <div className={`bd-node bd-scene${selected ? " is-selected" : ""}${d.promoted ? " is-promoted" : ""}`}>
      <PinToolbar id={id} promoted={!!d.promoted} visible={!!selected} />
      <div className="bd-node-title">{d.heading}</div>
      {d.videoPath ? <div className="bd-badge">rendered</div> : null}
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
    </div>
  );
}

export function AssetNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as AssetData;
  const out = d.ports[0];
  const icon = d.asset === "character" ? "🧍" : d.asset === "location" ? "🏙️" : "🎒";
  return (
    <div className={`bd-node bd-asset${selected ? " is-selected" : ""}${d.promoted ? " is-promoted" : ""}`}>
      <PinToolbar id={id} promoted={!!d.promoted} visible={!!selected} />
      <div className="bd-node-title">
        <span className="bd-icon">{icon}</span>
        {d.label}
      </div>
      {out ? (
        <div className="bd-ports">
          <div className="bd-port bd-port-out">
            <span>{out.label}</span>
            <Handle type="source" position={Position.Right} id={out.id} style={dot(out.type as DirectorPortType)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** An un-promoted Beat: a box you drag scenes into. No rails yet, by definition. */
export function GroupNode({ data, selected }: NodeProps) {
  const d = data as unknown as BeatData;
  return (
    <div className={`bd-group${selected ? " is-selected" : ""}`} style={{ width: d.width, height: d.height }}>
      <NodeResizer minWidth={280} minHeight={200} isVisible={!!selected} color="#c084fc" />
      <div className="bd-group-title">
        🎞️ {d.label}
        <span className="bd-hint">group — promote to expose its edges</span>
      </div>
    </div>
  );
}

function Rail({
  containerId,
  side,
  ports,
  collapsed,
}: {
  containerId: string;
  side: "in" | "out";
  ports: BoundaryPort[];
  collapsed: boolean;
}) {
  const actions = useActions();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFrom = useRef<number | null>(null);

  const outerPos = side === "in" ? Position.Left : Position.Right;
  const innerPos = side === "in" ? Position.Right : Position.Left;
  const outerType = side === "in" ? "target" : "source";
  const innerType = side === "in" ? "source" : "target";

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
          style={{ height: PILL_H }}
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
          style={{ height: PILL_H }}
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

/** A promoted Beat. Expanded it shows its rails; collapsed it is one card that still wires. */
export function SubgraphNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as BeatData;
  const collapsed = !!d.collapsed;
  const actions = useActions();
  const updateInternals = useUpdateNodeInternals();

  // Handle geometry changes whenever the rails change or the card collapses. Without this,
  // React Flow keeps the OLD handle positions and every edge to this container renders to a
  // stale point — the same class of wrongness as mispositioning the handle itself.
  useEffect(() => {
    updateInternals(id);
  }, [id, collapsed, d.promotedIn.length, d.promotedOut.length, updateInternals]);

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
    return (
      <div className={`bd-collapsed${selected ? " is-selected" : ""}`}>
        <div className="bd-collapsed-head">
          {caret}
          <span className="bd-collapsed-title">🎞️ {d.label}</span>
          <span className="bd-hint">
            {d.promotedIn.length} in · {d.promotedOut.length} out
          </span>
        </div>
        <div className="bd-collapsed-body">
          <Rail containerId={id} side="in" ports={d.promotedIn} collapsed />
          <div className="bd-faces">
            {(d.faces ?? []).length === 0 ? (
              <span className="bd-faces-empty">nothing pinned — 📌 a node inside to surface it here</span>
            ) : (
              (d.faces ?? []).map((f) => (
                <div className="bd-face" key={f.id}>
                  <span className="bd-face-label">{f.label}</span>
                  {f.detail ? <span className="bd-face-detail">{f.detail}</span> : null}
                </div>
              ))
            )}
          </div>
          <Rail containerId={id} side="out" ports={d.promotedOut} collapsed />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`bd-group bd-subgraph${selected ? " is-selected" : ""}`}
      style={{ width: d.width, height: d.height }}
    >
      <NodeResizer minWidth={320} minHeight={220} isVisible={!!selected} color="#c084fc" />
      <div className="bd-group-title">
        {caret}
        🎞️ {d.label}
        <span className="bd-hint">
          {d.promotedIn.length} in · {d.promotedOut.length} out
        </span>
      </div>
      <Rail containerId={id} side="in" ports={d.promotedIn} collapsed={false} />
      <Rail containerId={id} side="out" ports={d.promotedOut} collapsed={false} />
    </div>
  );
}

export const nodeTypes = {
  scene: SceneNode,
  asset: AssetNode,
  groupbox: GroupNode,
  subgraph: SubgraphNode,
};
