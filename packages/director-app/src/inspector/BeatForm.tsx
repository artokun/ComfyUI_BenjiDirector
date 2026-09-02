// The Beat editor: title, description, order. A Beat is Calliope's `story_beats` row; its
// topology (subgraph, collapse, colour) is the canvas's business and lives in the sidecar.

import { useMemo } from "react";
import type { BeatRow } from "@benjidirector/calliope-client";
import { calId } from "../calliope-bind.js";
import { useDirector } from "../director-context.jsx";
import { Icon } from "../icons.jsx";
import { useModal } from "../modal.jsx";
import { Field, SaveIndicator, Section, useAutosave } from "./fields.jsx";
import { beatDiff, beatForm, echoMismatch, parseIndex, type BeatForm as BeatFormValues } from "./forms.js";
import { useHeldRefresh } from "./hold.js";

export function BeatForm({ row }: { row: BeatRow }) {
  const { client, projectId, scenes, refresh, setNote } = useDirector();
  const modal = useModal();
  const pid = projectId ?? 0;
  const refreshHolding = useHeldRefresh(calId.beat(row.id));
  const seed = useMemo(() => beatForm(row), [row]);
  const { form, set, save, state, dirty } = useAutosave<BeatFormValues>(seed, async (f, base) => {
    const body = beatDiff(base, f);
    if (!body) return null;
    const echoed = await client.story.beat.patch(pid, row.id, body);
    const miss = echoMismatch(body as Record<string, unknown>, echoed as unknown as Record<string, unknown>);
    if (miss) throw new Error(miss);
    await refreshHolding();
    return Object.keys(body) as (keyof BeatFormValues)[];
  });
  const inside = scenes.filter((s) => s.beat_id === row.id).length;
  const blur = () => void save();
  const titleBad = !form.title.trim();
  const indexBad = parseIndex(form.order_index) === null;

  const del = async () => {
    const ok = await modal.confirm({
      title: `Delete Beat “${row.title}”?`,
      body: inside ? `${inside} scene${inside === 1 ? "" : "s"} inside keep their rows and become orphans — they show at the top level until dropped into another Beat.` : "It holds no scenes.",
      confirmLabel: "Delete Beat",
      danger: true,
    });
    if (!ok) return;
    try {
      await client.story.beat.delete(pid, row.id);
      await refresh();
      setNote(`deleted Beat “${row.title}”`);
    } catch (err) {
      setNote(`could not delete Beat: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <>
      <header className="bd-insp-head">
        <span className="bd-insp-kind">
          <Icon name="layers" /> Beat · {row.order_index + 1}
        </span>
        <span className="bd-insp-title" title={row.title}>
          {row.title}
        </span>
        <SaveIndicator state={state} dirty={dirty} onRetry={blur} />
      </header>
      <div className="bd-insp-body">
        <Section title="Beat" aside={`${inside} scene${inside === 1 ? "" : "s"}`}>
          <Field label="Title" hint={titleBad ? "required" : undefined} bad={titleBad}>
            <input className="bd-input" name="title" value={form.title} onChange={(e) => set({ title: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Description">
            <textarea className="bd-input" name="description" rows={4} value={form.description} placeholder="What this stretch of the film is for" onChange={(e) => set({ description: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Order" hint={indexBad ? "a whole number" : "position in the story"} bad={indexBad}>
            <input className="bd-input" name="order_index" type="number" min={0} step={1} inputMode="numeric" value={form.order_index} onChange={(e) => set({ order_index: e.target.value })} onBlur={blur} />
          </Field>
        </Section>
        <Section title="Danger">
          <button type="button" className="bd-btn is-danger" onClick={() => void del()}>
            <Icon name="trash" /> Delete Beat
          </button>
          <div className="bd-insp-note">Scenes inside are kept; they become orphans.</div>
        </Section>
      </div>
    </>
  );
}
