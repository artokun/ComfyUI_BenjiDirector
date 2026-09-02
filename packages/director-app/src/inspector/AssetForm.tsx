// The asset editor: Character / Location / Item — Calliope's consistency records.
//
// All three are flat text rows with one image path, so one component with a per-kind field
// table. The consistency prompt is what Calliope's image generation renders; "Reset to
// template" rebuilds it from the other fields with the same template Calliope used at create
// time (prompt-templates.ts), so a description edit can be pushed into the prompt in one click.

import { useMemo } from "react";
import type { CharacterRow, ItemRow, LocationRow } from "@benjidirector/calliope-client";
import { calId } from "../calliope-bind.js";
import { useDirector } from "../director-context.jsx";
import { Icon, type IconName } from "../icons.jsx";
import { useModal } from "../modal.jsx";
import { characterSheetTemplate, itemReferenceTemplate, locationReferenceTemplate } from "../prompt-templates.js";
import { Field, SaveIndicator, Section, useAutosave } from "./fields.jsx";
import { CHARACTER_KEYS, PLACE_KEYS, echoMismatch, textDiff, textForm } from "./forms.js";
import { useHeldRefresh } from "./hold.js";

export type AssetKind = "character" | "location" | "item";
type Row = CharacterRow | LocationRow | ItemRow;
type TextForm = Record<string, string>;

interface FieldSpec {
  key: string;
  label: string;
  rows?: number;
  placeholder?: string;
}
const FIELDS: Record<AssetKind, FieldSpec[]> = {
  character: [
    { key: "name", label: "Name", placeholder: "Name" },
    { key: "role", label: "Role", placeholder: "lead, antagonist, the neighbour…" },
    { key: "age", label: "Age", placeholder: "30s" },
    { key: "appearance", label: "Appearance", rows: 3, placeholder: "Face, hair, build, wardrobe — what must stay the same" },
    { key: "personality", label: "Personality", rows: 2, placeholder: "Visual cues only" },
  ],
  location: [
    { key: "name", label: "Name", placeholder: "Name" },
    { key: "description", label: "Description", rows: 3, placeholder: "The place, its light, its materials" },
  ],
  item: [
    { key: "name", label: "Name", placeholder: "Name" },
    { key: "description", label: "Description", rows: 3, placeholder: "What it is and what it looks like" },
  ],
};
const KIND: Record<AssetKind, { label: string; icon: IconName; keys: readonly string[] }> = {
  character: { label: "Character", icon: "user", keys: CHARACTER_KEYS },
  location: { label: "Location", icon: "mapPin", keys: PLACE_KEYS },
  item: { label: "Item", icon: "box", keys: PLACE_KEYS },
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function AssetForm({ kind, row }: { kind: AssetKind; row: Row }) {
  const { client, projectId, scenes, refresh, setNote } = useDirector();
  const modal = useModal();
  const pid = projectId ?? 0;
  const meta = KIND[kind];
  const raw = row as unknown as Record<string, unknown>;
  const refreshHolding = useHeldRefresh(calId[kind](row.id));
  const seed = useMemo(() => textForm(raw, meta.keys), [raw, meta.keys]);
  const { form, set, save, state, dirty } = useAutosave<TextForm>(seed, async (f, base) => {
    const body = textDiff(base, f, meta.keys);
    if (!body) return null;
    const echoed = kind === "character" ? await client.story.character.patch(pid, row.id, body) : kind === "location" ? await client.story.location.patch(pid, row.id, body) : await client.story.item.patch(pid, row.id, body);
    const miss = echoMismatch(body, echoed as unknown as Record<string, unknown>);
    if (miss) throw new Error(miss);
    await refreshHolding();
    return Object.keys(body);
  });
  const blur = () => void save();
  const nameBad = !form.name?.trim();

  const template = kind === "character" ? characterSheetTemplate(form) : kind === "location" ? locationReferenceTemplate(form) : itemReferenceTemplate(form);
  const templateLabel = kind === "character" ? "Reset to sheet template" : "Reset to reference template";

  const images: Array<{ label: string; path: string; portrait?: boolean }> = [];
  if (kind === "character") {
    const sheet = str(raw.sheet_path);
    const portrait = str(raw.portrait_path);
    if (sheet) images.push({ label: "Sheet", path: sheet });
    if (portrait) images.push({ label: "Portrait", path: portrait, portrait: true });
  } else {
    const ref = str(raw.reference_image_path);
    if (ref) images.push({ label: "Reference", path: ref });
  }
  const used = kind === "character" ? scenes.filter((s) => (s.character_ids ?? []).includes(row.id)).length : kind === "location" ? scenes.filter((s) => s.location_id === row.id).length : 0;

  const del = async () => {
    const ok = await modal.confirm({
      title: `Delete ${meta.label.toLowerCase()} “${row.name}”?`,
      body: used ? `${used} scene${used === 1 ? "" : "s"} reference it; they lose that wire.` : "No scene references it.",
      confirmLabel: `Delete ${meta.label.toLowerCase()}`,
      danger: true,
    });
    if (!ok) return;
    try {
      if (kind === "character") await client.story.character.delete(pid, row.id);
      else if (kind === "location") await client.story.location.delete(pid, row.id);
      else await client.story.item.delete(pid, row.id);
      await refresh();
      setNote(`deleted ${meta.label.toLowerCase()} “${row.name}”`);
    } catch (err) {
      setNote(`could not delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <header className="bd-insp-head">
        <span className="bd-insp-kind">
          <Icon name={meta.icon} /> {meta.label}
        </span>
        <span className="bd-insp-title" title={row.name}>
          {row.name}
        </span>
        <SaveIndicator state={state} dirty={dirty} onRetry={blur} />
      </header>
      <div className="bd-insp-body">
        <Section title={meta.label} aside={used ? `in ${used} scene${used === 1 ? "" : "s"}` : undefined}>
          {FIELDS[kind].map((f) => (
            <Field key={f.key} label={f.label} hint={f.key === "name" && nameBad ? "required" : undefined} bad={f.key === "name" && nameBad}>
              {f.rows ? (
                <textarea className="bd-input" name={f.key} rows={f.rows} value={form[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => set({ [f.key]: e.target.value })} onBlur={blur} />
              ) : (
                <input className="bd-input" name={f.key} value={form[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => set({ [f.key]: e.target.value })} onBlur={blur} />
              )}
            </Field>
          ))}
        </Section>

        <Section title="Consistency prompt">
          <textarea className="bd-input bd-insp-mono" name="consistency_prompt" rows={7} value={form.consistency_prompt ?? ""} placeholder="What every image of this must keep the same" onChange={(e) => set({ consistency_prompt: e.target.value })} onBlur={blur} />
          <div className="bd-insp-actions">
            <button type="button" className="bd-btn is-ghost" title="Rebuild the prompt from the fields above, with Calliope's own template" onClick={() => void save({ consistency_prompt: template })}>
              <Icon name="refresh" size={12} /> {templateLabel}
            </button>
          </div>
        </Section>

        <Section title={kind === "character" ? "Sheet" : "Reference image"}>
          {images.length ? (
            images.map((im) => (
              <figure className="bd-insp-figure" key={im.path}>
                <img className={`bd-insp-thumb${im.portrait ? " is-portrait" : ""}`} src={client.fileUrl(im.path)} alt={im.label} title={im.path} />
                <figcaption className="bd-insp-row">
                  <span className="bd-insp-note">{im.label}</span>
                  <a className="bd-btn is-ghost bd-insp-mini" href={client.fileUrl(im.path)} target="_blank" rel="noreferrer">
                    <Icon name="maximize" size={12} /> Open
                  </a>
                </figcaption>
              </figure>
            ))
          ) : (
            <div className="bd-insp-note">{kind === "character" ? "No sheet yet — generate one from the Assets tab." : "No reference image yet — generate one from the Assets tab."}</div>
          )}
        </Section>

        <Section title="Danger">
          <button type="button" className="bd-btn is-danger" onClick={() => void del()}>
            <Icon name="trash" /> Delete {meta.label.toLowerCase()}
          </button>
        </Section>
      </div>
    </>
  );
}
