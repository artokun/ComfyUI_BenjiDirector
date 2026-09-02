// Dynamic workflow inputs — the form Calliope derives from a workflow's `(Input:role)` nodes.
//
// FOUNDATION PLACEHOLDER. The props below are the contract the Assets, Render and Playground
// panels code against; the render-composer unit replaces `DynamicInputs` with the real thing
// (zones: composer / media / control / advanced, the asset picker, resolution presets, seed
// and duration steppers, required-field validation) without changing this interface.

import { useEffect } from "react";

export type InputKind = "text" | "textarea" | "number" | "image" | "image_url" | "audio" | "video";

/** One entry of a workflow's `input_schema` as Calliope reports it. */
export interface DynamicInput {
  nodeId: string;
  label: string;
  /** Canonical role (`prompt`, `negative`, `width`, `height`, `character`, `location`, `image`, `video`, `audio`, `seed`, `duration`) or null. */
  role: string | null;
  kind: InputKind;
  defaultValue?: unknown;
  required?: boolean;
}

/** Something a media input can point at: an existing asset image, a clip, an upload. */
export interface AssetOption {
  id: string;
  label: string;
  path: string;
  kind: "character" | "location" | "item" | "clip" | "upload";
  thumbPath?: string;
}

export type InputValues = Record<string, unknown>;

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
}

/** Drop the empty strings/undefined so a request carries only what the user set. */
export function compactInputValues(values: InputValues): InputValues {
  const out: InputValues = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

/** Seed a values object from schema defaults (only for keys the caller has not set). */
export function seedDefaults(inputs: DynamicInput[], values: InputValues): InputValues {
  const out = { ...values };
  for (const i of inputs) if (out[i.nodeId] === undefined && i.defaultValue !== undefined) out[i.nodeId] = i.defaultValue;
  return out;
}

export function missingRequired(inputs: DynamicInput[], values: InputValues, hideRoles: string[] = []): DynamicInput[] {
  return inputs.filter((i) => i.required && !hideRoles.includes(i.role ?? "") && (values[i.nodeId] === undefined || values[i.nodeId] === "" || values[i.nodeId] === null));
}

export function DynamicInputs({ inputs, values, onChange, showErrors, onValidity, hideRoles = [] }: DynamicInputsProps) {
  const missing = missingRequired(inputs, values, hideRoles);
  useEffect(() => {
    onValidity?.(missing.length === 0);
  }, [missing.length, onValidity]);
  const visible = inputs.filter((i) => !hideRoles.includes(i.role ?? ""));
  if (!visible.length) return <div className="bd-hint">This workflow exposes no inputs.</div>;
  return (
    <div className="bd-dyn">
      {visible.map((i) => {
        const v = values[i.nodeId];
        const bad = showErrors && missing.includes(i);
        const set = (val: unknown) => onChange({ ...values, [i.nodeId]: val });
        return (
          <label key={i.nodeId} className={`bd-dyn-field${bad ? " is-bad" : ""}`}>
            <span className="bd-dyn-label">
              {i.label}
              {i.role ? <span className="bd-hint"> · {i.role}</span> : null}
            </span>
            {i.kind === "textarea" ? (
              <textarea className="bd-input" rows={3} value={typeof v === "string" ? v : ""} onChange={(e) => set(e.target.value)} />
            ) : i.kind === "number" ? (
              <input className="bd-input" type="number" value={typeof v === "number" ? v : v === undefined ? "" : String(v)} onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))} />
            ) : (
              <input className="bd-input" type="text" value={typeof v === "string" ? v : v === undefined ? "" : String(v)} onChange={(e) => set(e.target.value)} placeholder={i.kind === "text" ? undefined : `${i.kind} path`} />
            )}
          </label>
        );
      })}
    </div>
  );
}
