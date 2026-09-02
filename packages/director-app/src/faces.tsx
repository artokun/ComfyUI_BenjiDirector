// Compact controls for a collapsed Beat's face.
//
// ifr-node-lab renders each pinned control in a compact variant on the collapsed card — a
// throttle becomes a slim slider, a joystick a small pad — so the collapsed subgraph reads as
// a composed node you can still operate. Our controls are film-shaped: a scene's heading and
// its duration are the two things a director actually adjusts from the outside, so those are
// live here (the heading edits in place, the duration is a RangeControl from the widget kit);
// the action line is shown read-only, an asset shows its label and kind, a note its first
// line. The rest stays inside.
//
// A face row is DERIVED by `decorate()` from the pinned node — id, label, duration — and the
// row reads the rest (the action, a note's text) straight from the live node via React Flow's
// store, so it re-renders when that node changes without the derivation having to carry every
// field. A face whose `kind` predates the note variant is told apart by the live node's kind.

import { useNodesData } from "@xyflow/react";
import { useContext, useMemo, useRef, useState } from "react";
import { ActionsContext } from "./actions.js";
import { Icon } from "./icons.js";
import type { AssetData, DirectorData, NoteData, PromotedFace, SceneData } from "./model.js";
import { noteFirstLine } from "./note.js";
import { RangeControl } from "./widgets.jsx";
import "./styles/u9-note-widgets.css";

/**
 * The duration a face can dial: 1 s to a minute. The pointer snaps to the half second; the
 * − / + buttons keep the whole second the face's old stepper moved by, so a click is still a
 * click's worth of change.
 */
export const FACE_DURATION = { min: 1, max: 60, step: 0.5, stepBy: 1 } as const;

const swallow = (e: { stopPropagation(): void }) => e.stopPropagation();

export function FaceRow({ face }: { face: PromotedFace }) {
  const live = useNodesData(face.id)?.data as DirectorData | undefined;
  if (face.kind === "note" || live?.kind === "note") return <NoteFace face={face} live={live?.kind === "note" ? live : undefined} />;
  if (face.kind === "asset" || live?.kind === "asset") return <AssetFace face={face} live={live?.kind === "asset" ? live : undefined} />;
  return <SceneFace face={face} live={live?.kind === "scene" ? live : undefined} />;
}

function SceneFace({ face, live }: { face: PromotedFace; live: SceneData | undefined }) {
  const actions = useContext(ActionsContext);
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * The value under the pointer, while a drag is in flight.
   *
   * A drag emits a value per pointer move, and every graph write settles the WHOLE graph and
   * diffs it against Calliope — so writing each frame would spend one PATCH per frame on one
   * gesture. The drag paints from here instead and the graph is written once, on commit: one
   * mutation, one undo entry, one PATCH. A step or a typed value has no in-between state and
   * writes straight through.
   */
  const [dragValue, setDragValue] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);

  const label = live?.heading ?? face.label;
  const stored = live?.durationSec ?? face.durationSec ?? 5;
  const duration = dragValue ?? stored;
  // Live first, exactly as label and duration do: the derived row is a snapshot, the node is
  // the truth, and `decorate` does not rebuild a face when only its text or action changed.
  const action = (live?.action ?? face.action ?? "").trim();
  const rendered = !!(live?.videoPath ?? face.videoPath);

  const commitHeading = () => {
    const v = (editing ?? "").trim();
    if (v && v !== label) actions?.updateNode(face.id, { heading: v, label: v });
    setEditing(null);
  };

  return (
    <div className="bd-face bd-face-scene bd-u9-face" data-face={face.id}>
      <div className="bd-u9-face-head">
        <Icon name="clapper" size={12} />
        {editing !== null ? (
          <input
            className="bd-face-input nodrag nopan"
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onPointerDown={swallow}
            onBlur={commitHeading}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitHeading();
              else if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <span
            className="bd-face-label nopan"
            title={`${label} — double-click to rename`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(label);
            }}
          >
            {label}
          </span>
        )}
        {rendered ? <span className="bd-face-detail">rendered</span> : null}
      </div>
      <RangeControl
        className="bd-u9-face-range"
        ariaLabel="duration"
        title="Duration — drag the track, click the value to type, or step"
        value={duration}
        min={FACE_DURATION.min}
        max={FACE_DURATION.max}
        step={FACE_DURATION.step}
        stepBy={FACE_DURATION.stepBy}
        suffix="s"
        onChange={(v, isLive) => {
          if (!isLive) return actions?.updateNode(face.id, { durationSec: v });
          dragRef.current = v;
          setDragValue(v);
        }}
        onCommit={() => {
          // Read the last dragged value from the ref, never from inside a state updater: an
          // updater is not the place for a graph mutation — React may run it twice.
          const v = dragRef.current;
          dragRef.current = null;
          setDragValue(null);
          if (v !== null && v !== stored) actions?.updateNode(face.id, { durationSec: v });
        }}
      />
      {action ? (
        <div className="bd-u9-face-action" title={action}>
          {action}
        </div>
      ) : null}
    </div>
  );
}

function AssetFace({ face, live }: { face: PromotedFace; live: AssetData | undefined }) {
  const kind = live?.asset ?? face.assetKind;
  const label = live?.label ?? face.label;
  return (
    <div className="bd-face bd-face-asset bd-u9-face" data-face={face.id}>
      <div className="bd-u9-face-head">
        <Icon name={kind === "character" ? "user" : kind === "location" ? "mapPin" : "box"} size={12} />
        <span className="bd-face-label" title={label}>
          {label}
        </span>
        {kind ? <span className="bd-u9-face-kind">{kind}</span> : null}
      </div>
    </div>
  );
}

function NoteFace({ face, live }: { face: PromotedFace; live: NoteData | undefined }) {
  // Live first: a note's face re-renders on every keystroke, and the derived row does not
  // carry the text at all today. Memoized because the scan walks the WHOLE note to read one line.
  const text = live?.text ?? face.text ?? "";
  const line = useMemo(() => noteFirstLine(text), [text]);
  return (
    <div className="bd-face bd-face-note bd-u9-face bd-u9-face-note" data-face={face.id}>
      <div className="bd-u9-face-head">
        <Icon name="note" size={12} />
        <span className={`bd-face-label${line ? "" : " is-empty"}`} title={text || "empty note"}>
          {line || "empty note"}
        </span>
      </div>
    </div>
  );
}
