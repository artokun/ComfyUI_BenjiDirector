// [U21] A card you can actually work in.
//
// A leaf had two states: collapsed to its title bar, or open showing its ports. Neither lets
// you write the scene — for that you had to select it and cross to the inspector, which is a
// long way to go to change one line of action. This is the third state: the card opens a body
// with the fields that make a scene a scene, and the same for an asset.
//
// Two rules the body obeys, both learned the hard way elsewhere in this editor:
//
//   • It writes on BLUR, never per keystroke. `updateNode` runs the settle funnel, and settle
//     diffs for Calliope — a per-keystroke write would PATCH the row on every letter.
//   • It is `nodrag`, and it stops pointerdown from reaching React Flow. Without that the
//     canvas starts panning the moment you press into a textarea and the caret never lands.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useActions } from "./actions.js";
import { Icon } from "./icons.js";
import type { AssetData, SceneData } from "./model.js";
import { RangeControl } from "./widgets.jsx";
import "./styles/u21-node-body.css";

/** The seconds a scene may be dialled to on the card. The inspector takes any number. */
export const BODY_DURATION = { min: 1, max: 60, step: 1, stepBy: 1 } as const;

const swallow = (e: { stopPropagation(): void }) => e.stopPropagation();

/**
 * A field that keeps its own text while it is being typed and hands it up on blur.
 *
 * `value` re-seeds it whenever the node's own value changes underneath — an agent edit, an
 * undo, a refresh — but NOT while the field has focus, or a re-render mid-sentence would
 * yank the cursor back.
 */
function BodyText({
  label,
  value,
  rows,
  mono,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  rows: number;
  mono?: boolean;
  placeholder?: string;
  onCommit(next: string): void;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return (
    <label className="bd-nb-field">
      <span className="bd-nb-label">{label}</span>
      <textarea
        className={`bd-input bd-nb-input nodrag nowheel${mono ? " bd-nb-mono" : ""}`}
        rows={rows}
        value={text}
        placeholder={placeholder}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setText(e.target.value)}
        onPointerDown={swallow}
        onKeyDown={(e) => {
          // Escape reverts; the canvas hotkeys must not see any of this.
          e.stopPropagation();
          if (e.key === "Escape") {
            setText(value);
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        onBlur={() => {
          focused.current = false;
          if (text !== value) onCommit(text);
        }}
      />
    </label>
  );
}

function Body({ children }: { children: ReactNode }) {
  return (
    <div className="bd-nb nodrag" onPointerDown={swallow} onDoubleClick={swallow}>
      {children}
    </div>
  );
}

export function SceneBody({ id, data }: { id: string; data: SceneData }) {
  const actions = useActions();
  // The value under the pointer while a drag is in flight, and the last one the drag saw. The
  // ref is what the commit reads: a state updater is not a place to fire an effect from.
  const [dragValue, setDragValue] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const duration = dragValue ?? data.durationSec ?? 4;
  return (
    <Body>
      <BodyText label="Action" value={data.action ?? ""} rows={2} placeholder="What happens on screen" onCommit={(action) => actions?.updateNode(id, { action })} />
      <BodyText label="Dialog" value={data.dialog ?? ""} rows={2} mono placeholder={"CHARACTER\nLine…"} onCommit={(dialog) => actions?.updateNode(id, { dialog })} />
      <div className="bd-nb-field bd-nb-row">
        <span className="bd-nb-label">Duration</span>
        <RangeControl
          value={duration}
          min={BODY_DURATION.min}
          max={BODY_DURATION.max}
          step={BODY_DURATION.step}
          stepBy={BODY_DURATION.stepBy}
          suffix="s"
          ariaLabel="Scene duration"
          title="Duration — drag the track, click the value to type, or step"
          className="bd-nb-range"
          // A drag passes through fifty values and each one would be a PATCH, so a live change
          // only moves the number on the card; the write happens once, when the drag ends.
          onChange={(v, isLive) => {
            if (!isLive) return actions?.updateNode(id, { durationSec: v });
            dragRef.current = v;
            setDragValue(v);
          }}
          onCommit={() => {
            const v = dragRef.current;
            dragRef.current = null;
            setDragValue(null);
            if (v !== null && v !== data.durationSec) actions?.updateNode(id, { durationSec: v });
          }}
        />
      </div>
    </Body>
  );
}

export function AssetBody({ id, data }: { id: string; data: AssetData }) {
  const actions = useActions();
  const what =
    data.asset === "character"
      ? "How they look in every shot — face, build, hair, wardrobe"
      : data.asset === "location"
        ? "How this place looks in every shot — light, weather, texture"
        : "How this object looks in every shot";
  return (
    <Body>
      {/* The consistency prompt is the one field the LOADER carries onto the node and the
          write-back verifies on the way back, so it is the one the card can safely edit.
          A node that never carried it (`undefined`) is left alone rather than blanking a row. */}
      <BodyText
        label="Consistency prompt"
        value={data.consistencyPrompt ?? ""}
        rows={4}
        placeholder={what}
        onCommit={(consistencyPrompt) => actions?.updateNode(id, { consistencyPrompt })}
      />
      <p className="bd-nb-hint">The wording every render of this reuses. The rest of its fields are in the inspector.</p>
    </Body>
  );
}

/**
 * The strip along the bottom of a card that opens and closes the body.
 *
 * Full width and its own row, because the header is already carrying the collapse chevron, the
 * title, the duration chip and the tip — a second caret up there is a coin toss for the pointer
 * and a puzzle for the eye.
 */
export function BodyToggle({ id, expanded, count }: { id: string; expanded: boolean; count?: number }) {
  const actions = useActions();
  return (
    <button
      type="button"
      className={`bd-nb-toggle nodrag${expanded ? " is-open" : ""}`}
      title={expanded ? "Close this card" : "Open this card to edit it"}
      data-expander={id}
      aria-expanded={expanded}
      onPointerDown={swallow}
      onClick={(e) => {
        e.stopPropagation();
        actions?.setNodeExpanded(id, !expanded);
      }}
    >
      <Icon name={expanded ? "chevronUp" : "chevronDown"} size={11} />
      <span>{expanded ? "Close" : "Edit"}</span>
      {!expanded && count ? <span className="bd-nb-count">{count}</span> : null}
    </button>
  );
}

/** How many of a scene's writing fields already have something in them. */
export const filledCount = (d: SceneData): number => [d.action, d.dialog].filter((v) => !!v && v.trim()).length;
