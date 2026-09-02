// The edge, and what you can do to it from the middle.
//
// Hover a wire and a control appears at its midpoint; click it for insert / delete / reroute.
// The midpoint lives INSIDE the edge's own SVG group, not in the label portal, so the parent
// `.react-flow__edge:hover` rule can reveal it — the label renderer portals its children into
// a separate HTML layer where the hover state of the path is invisible. The menu, which does
// need real buttons, goes through the portal once it is open.

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { canonicalEdgeId } from "./collapse-view.js";
import { Icon } from "./icons.jsx"; // [U8b] the Reroute item

/** Every action takes the CANONICAL edge id — the one in state and in `outline`. */
export interface EdgeActions {
  deleteEdge(edgeId: string): void;
  /** Insert a scene on this wire at the given flow position, splicing it in if the types allow. */
  insertOnEdge(edgeId: string, at: { x: number; y: number }): void;
  /** [U8b] Drop a reroute dot on this wire at the given flow position, bending it in two. */
  rerouteEdge(edgeId: string, at: { x: number; y: number }): void;
}
export const EdgeActionsContext = createContext<EdgeActions | null>(null);

export function DirectorEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd } = props;
  const actions = useContext(EdgeActionsContext);
  // A wire drawn to a collapsed group's proxy handle is a DISPLAYED edge (`…@display`); the
  // menu acts on the canonical one it stands for.
  const edgeId = canonicalEdgeId(id);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Close on any click that is not inside the menu. Registered only while open, so the
  // document does not carry one listener per edge on the canvas.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [open]);

  const stroke = (style as { stroke?: string } | undefined)?.stroke ?? "#9ca3af";

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={18} />
      <g
        className={`bd-edge-mid${open ? " is-open" : ""}`}
        transform={`translate(${labelX}, ${labelY})`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <circle r={9} fill="#171717" stroke={stroke} strokeWidth={1.5} />
        <circle cx={-3.5} cy={0} r={1.1} fill={stroke} />
        <circle cx={0} cy={0} r={1.1} fill={stroke} />
        <circle cx={3.5} cy={0} r={1.1} fill={stroke} />
      </g>
      {open ? (
        <EdgeLabelRenderer>
          <div
            ref={menuRef}
            className="bd-edge-menu nodrag nopan"
            style={{ transform: `translate(-50%, 12px) translate(${labelX}px, ${labelY}px)` }}
          >
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                actions?.insertOnEdge(edgeId, { x: labelX, y: labelY });
              }}
            >
              <Icon name="plus" /> Insert node
            </button>
            <button
              type="button"
              className="is-danger"
              onClick={() => {
                setOpen(false);
                actions?.deleteEdge(edgeId);
              }}
            >
              <Icon name="trash" /> Delete
            </button>
            <button
              type="button"
              title="Put a reroute dot here — the wire bends through it"
              onClick={() => {
                setOpen(false);
                actions?.rerouteEdge(id, { x: labelX, y: labelY });
              }}
            >
              <Icon name="reroute" /> Reroute
            </button>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const edgeTypes = { director: DirectorEdge };
