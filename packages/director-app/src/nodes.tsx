// Node renderers.
//
// Four types, matching graph-core's model: `scene`, `asset`, `groupbox` (an un-promoted
// Beat) and `subgraph` (a promoted one, which is the only type that draws rails).
//
// The rail layout is the part worth reading. A promoted input's OUTER handle faces the world
// on the container's left edge, and its INNER handle faces the children on the right of the
// same pill — so a wire visibly enters the boundary and continues to the child. Promoted
// outputs mirror it. That is the two-edge model made visible: one pill, two handles, and the
// user can see that the boundary is an alias rather than a new node.

import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { innerHandleId, type BoundaryPort } from "@benjidirector/graph-core";
import { PORT_COLOR, type AssetData, type BeatData, type DirectorPortType, type SceneData } from "./model.js";

// Handle styling ONLY — never position. React Flow positions a handle against its nearest
// positioned ancestor, so a hand-written `top` here anchors to the port ROW rather than the
// node and marches straight out of the card, taking the edge endpoint with it. Each row is
// full-bleed and `position: relative`, which lets React Flow's own left/right rules land the
// handle on the node edge, vertically centred on its label, at any row count.
const dot = (type: DirectorPortType) => ({
  background: PORT_COLOR[type] ?? "#9ca3af",
  width: 9,
  height: 9,
  border: "2px solid #14141a",
});

export function SceneNode({ data, selected }: NodeProps) {
  const d = data as unknown as SceneData;
  const ins = d.ports.filter((p) => p.isInput);
  const outs = d.ports.filter((p) => !p.isInput);
  return (
    <div className={`bd-node bd-scene${selected ? " is-selected" : ""}`}>
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

export function AssetNode({ data, selected }: NodeProps) {
  const d = data as unknown as AssetData;
  const out = d.ports[0];
  const icon = d.asset === "character" ? "🧍" : d.asset === "location" ? "🏙️" : "🎒";
  return (
    <div className={`bd-node bd-asset${selected ? " is-selected" : ""}`}>
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

function Rail({ side, ports }: { side: "in" | "out"; ports: BoundaryPort[] }) {
  return (
    <div className={`bd-rail bd-rail-${side}`}>
      {ports.map((bp) => (
        <div className={`bd-pill${bp.forced ? " is-pinned" : ""}`} key={bp.id} title={bp.id}>
          {side === "in" ? (
            <>
              <Handle type="target" position={Position.Left} id={bp.id} style={dot(bp.type as DirectorPortType)} />
              <span>{bp.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={innerHandleId(bp.id)}
                style={{ ...dot(bp.type as DirectorPortType), opacity: 0.55 }}
              />
            </>
          ) : (
            <>
              <Handle
                type="target"
                position={Position.Left}
                id={innerHandleId(bp.id)}
                style={{ ...dot(bp.type as DirectorPortType), opacity: 0.55 }}
              />
              <span>{bp.label}</span>
              <Handle type="source" position={Position.Right} id={bp.id} style={dot(bp.type as DirectorPortType)} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** A promoted Beat. Expanded it shows its rails; collapsed it is one card that still wires. */
export function SubgraphNode({ data, selected }: NodeProps) {
  const d = data as unknown as BeatData;
  const collapsed = !!d.collapsed;

  if (collapsed) {
    return (
      <div className={`bd-collapsed${selected ? " is-selected" : ""}`}>
        <div className="bd-group-title">🎞️ {d.label}</div>
        <div className="bd-collapsed-body">
          <Rail side="in" ports={d.promotedIn} />
          <Rail side="out" ports={d.promotedOut} />
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
        🎞️ {d.label}
        <span className="bd-hint">
          {d.promotedIn.length} in · {d.promotedOut.length} out
        </span>
      </div>
      <Rail side="in" ports={d.promotedIn} />
      <Rail side="out" ports={d.promotedOut} />
    </div>
  );
}

export const nodeTypes = {
  scene: SceneNode,
  asset: AssetNode,
  groupbox: GroupNode,
  subgraph: SubgraphNode,
};
