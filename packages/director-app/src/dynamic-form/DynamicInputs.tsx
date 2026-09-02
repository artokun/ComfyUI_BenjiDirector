// The composer form: a workflow's `(Input:…)` nodes, laid out by what each one IS.
//
// One values map (nodeId → value) whatever the layout — the same object the Assets and
// Playground panels build, and the same one `generate-videos` carries as `input_values`. The
// layout is the part that changes: a prompt is a box you type a paragraph into, a character
// ref is a thumbnail you pick, a duration is a stepper, and the long tail of a workflow's
// knobs is one popover instead of forty rows nobody reads.
//
// Zones come from `classify.ts`; roles are folded through `roles.ts` first, so a workflow
// tagged `(Input:positive)` gets the prompt box rather than a raw text field.

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DirectorContext } from "../director-context.js";
import { Icon } from "../icons.jsx";
import { AssetPicker } from "./AssetPicker.jsx";
import { classifyAll, DURATION_RANGE, mediaKindOfInput, parseResolution, rangeFor, RESOLUTION_PRESETS, RESOLUTION_RANGE, resolutionLabel, SEED_RANGE, snapTo, stepValue, type ClassifiedInput, type NumericRange } from "./classify.js";
import { roleLabel } from "./roles.js";
import { baseName, isBlank, mediaKindOfOption, missingRequired, type AssetOption, type DynamicInput, type InputValues } from "./types.js";

export interface DynamicInputsProps {
  inputs: DynamicInput[];
  values: InputValues;
  onChange(next: InputValues): void;
  assetOptions?: AssetOption[];
  /** Offer "Upload…" in media pickers (needs `playground.upload`). */
  allowUpload?: boolean;
  /** Show required-field errors now (after a submit attempt). */
  showErrors?: boolean;
  /** Reports whether every required input has a value. */
  onValidity?(valid: boolean): void;
  /** Roles to hide (e.g. prompt roles when the panel has its own prompt box). */
  hideRoles?: string[];
  /** Ctrl/Cmd+Enter in the prompt box. */
  onSubmit?(): void;
  /** Rendered at the START of the control bar (the panel's workflow / source pills). */
  controlsStart?: ReactNode;
  /** Rendered inline at the end of the control bar (the panel's Generate button). */
  controlsEnd?: ReactNode;
  /** Placeholder for the prompt box. */
  promptPlaceholder?: string;
}

export function DynamicInputs({ inputs, values, onChange, assetOptions = [], allowUpload = false, showErrors = false, onValidity, hideRoles = [], onSubmit, controlsStart, controlsEnd, promptPlaceholder }: DynamicInputsProps) {
  const ctx = useContext(DirectorContext);
  const visible = useMemo(() => inputs.filter((i) => !hideRoles.includes(i.role ?? "")), [hideRoles, inputs]);
  const zones = useMemo(() => classifyAll(visible), [visible]);
  const missing = useMemo(() => missingRequired(visible, values), [values, visible]);

  // Report validity only when it CHANGES: a parent that passes an inline callback would
  // otherwise be told the same thing on every render, and a parent that sets state on it
  // would loop.
  const lastValid = useRef<boolean | null>(null);
  const valid = missing.length === 0;
  useEffect(() => {
    if (lastValid.current === valid) return;
    lastValid.current = valid;
    onValidity?.(valid);
  }, [onValidity, valid]);

  const set = useCallback((nodeId: string, value: unknown) => onChange({ ...values, [nodeId]: value }), [onChange, values]);
  const setMany = useCallback((patch: InputValues) => onChange({ ...values, ...patch }), [onChange, values]);
  const isMissing = (i: DynamicInput) => showErrors && missing.includes(i);

  const [showNegative, setShowNegative] = useState(false);
  const negativeSet = !isBlank(values[zones.negative?.input.nodeId ?? ""]);

  if (!visible.length) return <div className="bd-hint">This workflow exposes no inputs.</div>;

  const prompt = zones.prompt?.input;
  const negative = zones.negative?.input;
  // [U22] There are two reasons this form shows no prompt box, and they mean opposite things.
  // The workflow may genuinely have no `(Input:prompt)` node — then the wording it renders with
  // is its own. Or the CALLER hid the role because it owns the prompt (the Assets panel writes
  // it from the card's template). Telling a user their workflow has no prompt node when it has
  // one sends them to check a workflow that is fine.
  const promptHidden = hideRoles.includes("prompt") && inputs.some((i) => i.role === "prompt");

  return (
    <div className="bd-dyn bd-rc-form">
      {zones.media.length ? (
        <div className="bd-rc-tray">
          {zones.media.map((m) => (
            <MediaTile
              key={m.input.nodeId}
              input={m.input}
              value={typeof values[m.input.nodeId] === "string" ? (values[m.input.nodeId] as string) : ""}
              assetOptions={assetOptions}
              allowUpload={allowUpload}
              invalid={isMissing(m.input)}
              fileUrl={(p) => ctx?.client.fileUrl(p) ?? p}
              upload={allowUpload && ctx ? (file) => ctx.client.playground.upload(file).then((r) => r.path) : undefined}
              onPick={(path) => set(m.input.nodeId, path)}
              onNote={(msg) => ctx?.setNote(msg)}
            />
          ))}
        </div>
      ) : null}

      {prompt ? (
        <textarea
          className={`bd-input bd-rc-prompt${isMissing(prompt) ? " is-bad" : ""}`}
          // Two rows, resizable: the dock is the SHORTEST thing on screen in a squat pane, and
          // a third row costs the negative-prompt toggle its place above the control bar.
          rows={2}
          aria-label="Prompt"
          placeholder={promptPlaceholder ?? "Describe the shot — camera, subject, motion, light…"}
          value={typeof values[prompt.nodeId] === "string" ? (values[prompt.nodeId] as string) : ""}
          onChange={(e) => set(prompt.nodeId, e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              onSubmit?.();
            }
          }}
        />
      ) : (
        <div className="bd-hint bd-rc-noprompt">
          {promptHidden
            ? "The prompt comes from the card above — this workflow's (Input:prompt) node receives it."
            : "This workflow has no (Input:prompt) node — the prompt is written by the workflow itself."}
        </div>
      )}

      {negative ? (
        <div className="bd-rc-negative">
          {showNegative ? (
            <textarea
              className="bd-input bd-rc-negative-area"
              rows={2}
              autoFocus
              aria-label="Negative prompt"
              placeholder="What to avoid…"
              value={typeof values[negative.nodeId] === "string" ? (values[negative.nodeId] as string) : ""}
              onChange={(e) => set(negative.nodeId, e.target.value)}
            />
          ) : null}
          <button type="button" className="bd-btn is-ghost bd-rc-negative-toggle" aria-expanded={showNegative} onClick={() => setShowNegative((v) => !v)}>
            <Icon name={showNegative ? "chevronUp" : "chevronDown"} /> Negative prompt
            {!showNegative && negativeSet ? <span className="bd-rc-dot" aria-hidden="true" /> : null}
          </button>
        </div>
      ) : null}

      <div className="bd-rc-controls">
        {controlsStart}
        {zones.resolutionPair ? (
          <ResolutionPill
            pair={zones.resolutionPair}
            values={values}
            onSet={(w, h) => setMany({ [zones.resolutionPair!.width.input.nodeId]: w, [zones.resolutionPair!.height.input.nodeId]: h })}
          />
        ) : null}

        {zones.control.map((c) => (
          <Stepper
            key={c.input.nodeId}
            label={c.widget === "duration" ? "Duration" : c.widget === "seed" ? "Seed" : c.input.label}
            suffix={c.widget === "duration" ? "s" : ""}
            value={values[c.input.nodeId] ?? c.input.defaultValue}
            range={rangeFor(c.widget) ?? RESOLUTION_RANGE}
            invalid={isMissing(c.input)}
            onRandom={c.widget === "seed" ? () => set(c.input.nodeId, Math.floor(Math.random() * (SEED_RANGE.max + 1))) : undefined}
            onChange={(v) => set(c.input.nodeId, v)}
          />
        ))}

        {zones.advanced.length ? (
          <Popover
            label="Advanced"
            icon="sliders"
            badge={zones.advanced.length}
            invalid={zones.advanced.some((a) => isMissing(a.input))}
            render={() => (
              <div className="bd-rc-adv">
                {zones.advanced.map((a) => (
                  <label key={a.input.nodeId} className={`bd-dyn-field${isMissing(a.input) ? " is-bad" : ""}`}>
                    <span className="bd-dyn-label">
                      {a.input.label}
                      {a.role ? <span className="bd-hint"> · {a.role}</span> : null}
                    </span>
                    {a.input.kind === "number" ? (
                      <input
                        className="bd-input"
                        type="number"
                        value={numberInputValue(values[a.input.nodeId] ?? a.input.defaultValue)}
                        onChange={(e) => set(a.input.nodeId, e.target.value === "" ? "" : Number(e.target.value))}
                      />
                    ) : (
                      <textarea
                        className="bd-input"
                        rows={a.input.kind === "textarea" ? 3 : 1}
                        value={textInputValue(values[a.input.nodeId] ?? a.input.defaultValue)}
                        onChange={(e) => set(a.input.nodeId, e.target.value)}
                      />
                    )}
                  </label>
                ))}
              </div>
            )}
          />
        ) : null}

        {showErrors && missing.length ? (
          <span className="bd-rc-missing" role="alert">
            <Icon name="alert" /> {missing.length} required field{missing.length === 1 ? "" : "s"} empty
          </span>
        ) : null}

        {controlsEnd ? <span className="bd-rc-controls-end">{controlsEnd}</span> : null}
      </div>
    </div>
  );
}

function numberInputValue(v: unknown): string {
  return typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
}
function textInputValue(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

// ── media tile ────────────────────────────────────────────────────────────────

function MediaTile({
  input,
  value,
  assetOptions,
  allowUpload,
  invalid,
  fileUrl,
  upload,
  onPick,
  onNote,
}: {
  input: DynamicInput;
  value: string;
  assetOptions: AssetOption[];
  allowUpload: boolean;
  invalid: boolean;
  fileUrl(path: string): string;
  upload?: (file: File) => Promise<string>;
  onPick(path: string): void;
  onNote(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const kind = mediaKindOfInput(input);
  const label = roleLabel(input.role) || input.label;
  const matching = assetOptions.filter((a) => mediaKindOfOption(a) === kind);

  const doUpload = (file: File) => {
    if (!upload) return;
    setUploadingName(file.name);
    void upload(file)
      .then((path) => {
        onPick(path);
        setOpen(false);
      })
      .catch((err: unknown) => onNote(`upload failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setUploadingName(null));
  };

  return (
    <div className="bd-rc-tile-wrap">
      <button
        type="button"
        className={`bd-rc-tile${value ? " is-filled" : ""}${invalid ? " is-bad" : ""}`}
        title={value || label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file && allowUpload) doUpload(file);
        }}
      >
        {uploadingName ? (
          <span className="bd-rc-tile-busy">
            <span className="bd-rc-spinner" aria-hidden="true" /> {baseName(uploadingName)}
          </span>
        ) : value ? (
          kind === "video" ? (
            <video className="bd-rc-tile-media" src={`${fileUrl(value)}#t=0.1`} muted playsInline preload="metadata" />
          ) : kind === "audio" ? (
            <span className="bd-rc-tile-audio">
              <Icon name="zap" size={18} />
            </span>
          ) : (
            <img className="bd-rc-tile-media" src={fileUrl(value)} alt="" />
          )
        ) : (
          <span className="bd-rc-tile-empty">
            <Icon name={kind === "video" ? "film" : kind === "audio" ? "zap" : "image"} size={16} />
          </span>
        )}
      </button>
      <span className="bd-rc-tile-label" title={value ? baseName(value) : label}>
        {value ? baseName(value) : label}
      </span>
      {value ? (
        <button type="button" className="bd-rc-tile-clear" aria-label={`Clear ${label}`} title={`Clear ${label}`} onClick={() => onPick("")}>
          <Icon name="x" size={10} />
        </button>
      ) : null}
      <AssetPicker
        open={open}
        title={`Choose ${label.toLowerCase()}`}
        assets={matching}
        value={value}
        mediaKind={kind}
        allowUpload={allowUpload && !!upload}
        uploadingName={uploadingName}
        fileUrl={fileUrl}
        onSelect={(path) => {
          onPick(path);
          setOpen(false);
        }}
        onClear={() => {
          onPick("");
          setOpen(false);
        }}
        onUpload={upload ? doUpload : undefined}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

// ── control pills ─────────────────────────────────────────────────────────────

function Stepper({
  label,
  suffix = "",
  value,
  range,
  invalid,
  onChange,
  onRandom,
}: {
  label: string;
  suffix?: string;
  value: unknown;
  range: NumericRange;
  invalid?: boolean;
  onChange(v: number): void;
  onRandom?(): void;
}) {
  const n = typeof value === "number" ? value : Number(value);
  const shown = Number.isFinite(n) && String(value ?? "") !== "" ? n : null;
  return (
    <span className={`bd-rc-stepper${invalid ? " is-bad" : ""}`} title={label}>
      <span className="bd-rc-stepper-label">{label}</span>
      <button type="button" className="bd-rc-step" aria-label={`Decrease ${label}`} onClick={() => onChange(stepValue(value, -1, range))}>
        <Icon name="chevronDown" size={11} />
      </button>
      <input
        className="bd-rc-stepper-value"
        aria-label={label}
        value={shown === null ? "" : `${shown}`}
        inputMode="numeric"
        onChange={(e) => {
          // Typed digits go through as they are. Clamping here made a width field untypable —
          // "1" on the way to "1280" was rewritten to the 256 floor before the next keystroke.
          const raw = e.target.value.replace(/[^\d-]/g, "");
          const next = Number(raw);
          if (raw !== "" && Number.isFinite(next)) onChange(next);
        }}
        onBlur={(e) => {
          const raw = e.target.value.replace(/[^\d-]/g, "");
          const next = Number(raw);
          onChange(snapTo(raw !== "" && Number.isFinite(next) ? next : range.min, range));
        }}
      />
      {suffix ? <span className="bd-rc-stepper-suffix">{suffix}</span> : null}
      <button type="button" className="bd-rc-step" aria-label={`Increase ${label}`} onClick={() => onChange(stepValue(value, 1, range))}>
        <Icon name="chevronUp" size={11} />
      </button>
      {onRandom ? (
        <button type="button" className="bd-rc-step" aria-label={`Randomise ${label}`} title="Random seed" onClick={onRandom}>
          <Icon name="sparkles" size={11} />
        </button>
      ) : null}
    </span>
  );
}

function ResolutionPill({ pair, values, onSet }: { pair: { width: ClassifiedInput; height: ClassifiedInput }; values: InputValues; onSet(w: number, h: number): void }) {
  const w = values[pair.width.input.nodeId] ?? pair.width.input.defaultValue;
  const h = values[pair.height.input.nodeId] ?? pair.height.input.defaultValue;
  const label = resolutionLabel(w, h) ?? "Resolution";
  return (
    <Popover
      label={label}
      icon="image"
      render={(close) => (
        <div className="bd-rc-res">
          <div className="bd-rc-res-presets">
            {RESOLUTION_PRESETS.map((p) => (
              <button
                type="button"
                key={p.label}
                className={`bd-btn${Number(w) === p.width && Number(h) === p.height ? " is-primary" : ""}`}
                onClick={() => {
                  onSet(p.width, p.height);
                  close();
                }}
              >
                {p.label} <span className="bd-hint">{p.width}×{p.height}</span>
              </button>
            ))}
          </div>
          <div className="bd-rc-res-custom">
            <Stepper label="Width" value={w} range={RESOLUTION_RANGE} onChange={(v) => onSet(v, Number(h) || RESOLUTION_RANGE.min)} />
            <Stepper label="Height" value={h} range={RESOLUTION_RANGE} onChange={(v) => onSet(Number(w) || RESOLUTION_RANGE.min, v)} />
          </div>
          <label className="bd-rc-res-raw">
            <span className="bd-dyn-label">Custom</span>
            <input
              className="bd-input"
              placeholder="1280x720"
              defaultValue={Number(w) && Number(h) ? `${Number(w)}x${Number(h)}` : ""}
              onChange={(e) => {
                const parsed = parseResolution(e.target.value);
                if (parsed) onSet(snapTo(parsed.width, RESOLUTION_RANGE), snapTo(parsed.height, RESOLUTION_RANGE));
              }}
            />
          </label>
        </div>
      )}
    />
  );
}

/** A pill that opens a small panel under itself. Closes on Escape or a click outside. */
function Popover({ label, icon, badge, invalid, render }: { label: string; icon: Parameters<typeof Icon>[0]["name"]; badge?: number; invalid?: boolean; render(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <span className="bd-rc-pop-wrap" ref={ref}>
      <button type="button" className={`bd-rc-pill${open ? " is-open" : ""}${invalid ? " is-bad" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <Icon name={icon} size={12} /> {label}
        {badge ? <span className="bd-rc-pill-badge">{badge}</span> : null}
      </button>
      {open ? (
        <div className="bd-rc-pop" role="dialog" aria-label={label}>
          {render(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}
