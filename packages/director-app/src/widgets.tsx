// The widget kit: compact controls shared by a collapsed Beat's face and the note.
//
// Ported from ifr-node-lab's RangeControl and CompactControl and restyled to the tokens —
// graphite surfaces, hairline borders, cyan focus. Every control is `nodrag` and swallows its
// own pointer-down, so React Flow never mistakes a slider drag for a node drag and never
// starts a selection box from a stepper click.

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "./icons.js";
import "./styles/u9-note-widgets.css";

/**
 * Snap `v` to the step grid anchored at `min`, trim the float noise a step like 0.1 leaves
 * behind, then clamp. NaN and Infinity land on `min` rather than poisoning a node's data.
 */
export function clampStep(v: number, min: number, max: number, step = 1): number {
  if (!Number.isFinite(v)) return min;
  const s = step > 0 && Number.isFinite(step) ? step : 1;
  const decimals = Math.min(10, (String(s).split(".")[1] ?? "").length);
  // Round the QUOTIENT's float noise away before rounding to a grid index. Raw, (0.35 - 0) /
  // 0.1 is 3.4999999999999996, so a value sitting exactly on a grid midpoint snaps DOWN while
  // its neighbours snap up — a slider that refuses to land on some of its own steps.
  const steps = Math.round(Number(((v - min) / s).toFixed(9)));
  const snapped = Number((min + steps * s).toFixed(decimals));
  return Math.max(min, Math.min(max, snapped));
}

const swallow = (e: { stopPropagation(): void }) => e.stopPropagation();

export interface RangeControlProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /**
   * What the − / + buttons move by. Defaults to `step`, but a control whose DRAG wants a fine
   * grain usually wants a coarse one per click: a duration snaps to the half second under the
   * pointer while a button click still moves a whole second.
   */
  stepBy?: number;
  /** Appended to the shown value ("s", "%"). */
  suffix?: string;
  /** How the value reads; defaults to the number as-is. */
  format?: (v: number) => string;
  /**
   * Every change. `live` is true while a drag is in progress — more values are coming, so a
   * caller keeping an undo stack can snapshot once — and false for a step or a typed value.
   */
  onChange(v: number, live: boolean): void;
  /** A drag ended; fires after its last `onChange`. */
  onCommit?(): void;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A pill slider: filled track, drag anywhere on it, click the value to type one, − / +
 * steppers at the ends. The typed input blurs on wheel so a scroll over it cannot nudge the
 * number, and every keystroke stays inside — Backspace in here must not delete the node.
 */
export function RangeControl({ value, min, max, step = 1, stepBy, suffix = "", format, onChange, onCommit, title, ariaLabel, disabled, className }: RangeControlProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const cancelled = useRef(false);
  const clamp = (v: number) => clampStep(v, min, max, step);
  const shown = clamp(value);
  const pct = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  const nudge = stepBy && stepBy > 0 ? stepBy : step;

  /**
   * Open the typing input.
   *
   * `cancelled` is reset HERE, not only in `commitText`: Escape unmounts the input, and React
   * fires no blur for an unmounted element, so a flag cleared only on commit survives the
   * cancel and silently swallows the NEXT value the user types.
   */
  const beginEdit = () => {
    cancelled.current = false;
    setText(String(shown));
    setEditing(true);
  };

  const fromX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return shown;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return shown;
    return clamp(min + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * (max - min));
  };
  const emit = (v: number, live = false) => {
    if (v !== value) onChange(v, live);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit?.();
  };
  const release = (e: ReactPointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // never captured (jsdom, or a pointer that went away)
    }
  };
  const commitText = () => {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const t = text.trim();
    const n = Number(t);
    if (t !== "" && Number.isFinite(n)) emit(clamp(n));
  };

  return (
    <div
      className={`bd-range nodrag${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
      title={title}
      onPointerDown={swallow}
      onClick={swallow}
      onDoubleClick={swallow}
    >
      <button type="button" className="bd-range-step" aria-label="decrease" disabled={disabled} onClick={() => emit(clamp(shown - nudge))}>
        −
      </button>
      <div
        ref={trackRef}
        className="bd-range-track"
        role="slider"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        onPointerDown={(e) => {
          if (disabled || editing || e.button !== 0) return;
          dragging.current = true;
          try {
            e.currentTarget.setPointerCapture?.(e.pointerId);
          } catch {
            // jsdom has no pointer capture; the drag still works while the pointer stays over the track
          }
          emit(fromX(e.clientX), true);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          if (!(e.buttons & 1)) {
            endDrag();
            return;
          }
          emit(fromX(e.clientX), true);
        }}
        onPointerUp={(e) => {
          release(e);
          endDrag();
        }}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="bd-range-fill" style={{ width: `${pct}%` }} />
        {editing ? (
          <input
            className="bd-range-edit nodrag"
            autoFocus
            type="number"
            inputMode="decimal"
            step={step}
            min={min}
            max={max}
            value={text}
            aria-label={ariaLabel}
            onPointerDown={swallow}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onWheel={(e) => (e.target as HTMLInputElement).blur()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitText();
              else if (e.key === "Escape") {
                cancelled.current = true;
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            className="bd-range-val"
            title="Click to type a value"
            onPointerDown={swallow}
            onClick={(e) => {
              e.stopPropagation();
              if (disabled) return;
              beginEdit();
            }}
          >
            {(format ?? String)(shown)}
            {suffix}
          </span>
        )}
      </div>
      <button type="button" className="bd-range-step" aria-label="increase" disabled={disabled} onClick={() => emit(clamp(shown + nudge))}>
        +
      </button>
    </div>
  );
}

/** An on/off switch. `role="switch"` so a screen reader says which. */
export function Toggle({ value, onChange, label, disabled, title }: { value: boolean; onChange(v: boolean): void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`bd-toggle nodrag${value ? " is-on" : ""}`}
      disabled={disabled}
      title={title}
      onPointerDown={swallow}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
    >
      <span className="bd-toggle-track">
        <span className="bd-toggle-knob" />
      </span>
      {label ? <span className="bd-toggle-label">{label}</span> : null}
    </button>
  );
}

/** − value + with the same clamp as the slider; the buttons grey out at the bounds. */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  suffix = "",
  format,
  onChange,
  disabled,
  title,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  format?: (v: number) => string;
  onChange(v: number): void;
  disabled?: boolean;
  title?: string;
}) {
  const shown = clampStep(value, min, max, step);
  const emit = (v: number) => {
    if (v !== value) onChange(v);
  };
  return (
    <span className="bd-stepper nodrag" title={title} onPointerDown={swallow} onClick={swallow}>
      <button type="button" aria-label="decrease" disabled={disabled || shown <= min} onClick={() => emit(clampStep(shown - step, min, max, step))}>
        −
      </button>
      <span className="bd-stepper-val">
        {(format ?? String)(shown)}
        {suffix}
      </span>
      <button type="button" aria-label="increase" disabled={disabled || shown >= max} onClick={() => emit(clampStep(shown + step, min, max, step))}>
        +
      </button>
    </span>
  );
}

/** A native select in the kit's clothes: the browser's picker, our chevron and borders. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  title,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(v: T): void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <span className="bd-select nodrag" title={title} onPointerDown={swallow} onClick={swallow}>
      <select value={value} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value as T)} onKeyDown={swallow}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={12} className="bd-select-caret" />
    </span>
  );
}
