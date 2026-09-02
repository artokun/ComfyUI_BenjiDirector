// Compact controls for a collapsed Beat's face.
//
// ifr-node-lab renders each pinned control in a compact variant on the collapsed card — a
// throttle becomes a slim slider, a joystick a small pad — so the collapsed subgraph reads as
// a composed node you can still operate. Our controls are film-shaped: a scene's heading and
// its duration are the two things a director actually adjusts from the outside, so those are
// live here; the rest stays inside.

import { useContext, useState } from "react";
import { Icon } from "./icons.js";
import { ActionsContext } from "./actions.js";
import type { PromotedFace } from "./model.js";

export function FaceRow({ face }: { face: PromotedFace }) {
  const actions = useContext(ActionsContext);
  const [editing, setEditing] = useState<string | null>(null);

  if (face.kind === "asset") {
    const icon = <Icon name={face.assetKind === "character" ? "user" : face.assetKind === "location" ? "mapPin" : "box"} />;
    return (
      <div className="bd-face bd-face-asset">
        <span className="bd-face-icon">{icon}</span>
        <span className="bd-face-label">{face.label}</span>
      </div>
    );
  }

  const duration = face.durationSec ?? 5;
  const step = (delta: number) => {
    const next = Math.max(1, Math.min(60, Math.round((duration + delta) * 2) / 2));
    actions?.updateNode(face.id, { durationSec: next });
  };

  return (
    <div className="bd-face bd-face-scene">
      {editing !== null ? (
        <input
          className="bd-face-input nodrag"
          autoFocus
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => {
            const v = editing.trim();
            if (v) actions?.updateNode(face.id, { heading: v, label: v });
            setEditing(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") setEditing(null);
          }}
        />
      ) : (
        <span
          className="bd-face-label"
          title="Double-click to rename"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(face.label);
          }}
        >
          {face.label}
        </span>
      )}
      <span className="bd-face-stepper nodrag" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => step(-1)} title="Shorter">
          −
        </button>
        <span className="bd-face-value">{duration}s</span>
        <button type="button" onClick={() => step(1)} title="Longer">
          +
        </button>
      </span>
      {face.videoPath ? <span className="bd-face-detail">rendered</span> : null}
    </div>
  );
}
