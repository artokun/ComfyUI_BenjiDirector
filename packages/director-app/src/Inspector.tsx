// The Inspector: a right-dock editor for the SELECTED node.
//
// The node id says what it is. A `cal-*` id names a Calliope row (calliope-bind.ts), and the
// row — from `useDirector().scenes / story`, as last read — is what the form edits: every
// write is a PATCH, checked by echo, followed by `refresh()` so the canvas re-merges. A node
// the editor invented has no row yet; its form edits the node's own data through
// `updateNode` and says so.
//
// Registered as a slot (no JSX in DirectorApp) and as one drive command, `inspect {id}`,
// which selects the node the same way a click would — the inspector follows the selection,
// so an agent that wants a scene open just selects it.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useActions } from "./actions.js";
import { calliopeRef } from "./calliope-bind.js";
import { useDirector, useSelection } from "./director-context.jsx";
import { registerDriveCommands, type RFNode } from "./drive-registry.js";
import { Icon } from "./icons.jsx";
import { registerSlot } from "./slots.jsx";
import { AssetForm } from "./inspector/AssetForm.jsx";
import { BeatForm } from "./inspector/BeatForm.jsx";
import { SceneForm } from "./inspector/SceneForm.jsx";
import { Field, SaveIndicator, Section, useAutosave } from "./inspector/fields.jsx";
import { noteSelection, releaseHold, useHold } from "./inspector/hold.js";
import { parseDuration } from "./inspector/forms.js";
import "./styles/u12-inspector.css";

export function Inspector() {
  const { ids, single } = useSelection();
  const { projectId, story, scenes } = useDirector();
  // A write rebuilds the canvas and drops the selection (see inspector/hold.ts), so while a
  // write is in flight the held node is what the inspector shows. The hold lifts here, once
  // the selection has caught up — releasing it in the writer unmounts the form for a frame.
  const hold = useHold();
  const shown = single ?? (ids.length === 0 ? hold.id : null);
  useEffect(() => {
    if (!hold.id || !single) return;
    // Chose another node mid-write? That is what the hold should show, and what the write's
    // restore should re-select — the refresh is about to wipe it off the canvas.
    if (single !== hold.id) noteSelection(single);
    else if (hold.releasable) releaseHold();
  }, [hold, single]);
  let body: ReactNode;
  if (!shown) {
    body = <Empty count={ids.length} />;
  } else {
    const ref = projectId !== null && story ? calliopeRef(shown) : null;
    const scene = ref?.kind === "scene" ? scenes.find((s) => s.id === ref.id) : undefined;
    const beat = ref?.kind === "beat" ? story?.beats.find((b) => b.id === ref.id) : undefined;
    const character = ref?.kind === "character" ? story?.characters.find((c) => c.id === ref.id) : undefined;
    const location = ref?.kind === "location" ? story?.locations.find((l) => l.id === ref.id) : undefined;
    const item = ref?.kind === "item" ? story?.items.find((i) => i.id === ref.id) : undefined;
    if (scene) body = <SceneForm key={shown} row={scene} />;
    else if (beat) body = <BeatForm key={shown} row={beat} />;
    else if (character) body = <AssetForm key={shown} kind="character" row={character} />;
    else if (location) body = <AssetForm key={shown} kind="location" row={location} />;
    else if (item) body = <AssetForm key={shown} kind="item" row={item} />;
    else body = <LocalForm key={shown} id={shown} />;
  }
  return (
    <aside className="bd-inspector" aria-label="Inspector" data-node={shown ?? ""}>
      {body}
    </aside>
  );
}

function Empty({ count }: { count: number }) {
  return (
    <div className="bd-insp-empty">
      <Icon name="sliders" size={22} strokeWidth={1.5} />
      <div className="bd-insp-empty-title">{count > 1 ? `${count} nodes selected` : "Select a scene, Beat or asset"}</div>
      <div className="bd-insp-note">{count > 1 ? "Pick one to edit it here." : "Its script, structure and render setup are edited here. Every change writes to Calliope on blur."}</div>
    </div>
  );
}

// ── editor-local nodes: no Calliope row (yet) ────────────────────────────────────────────

interface NodeSummary {
  id: string;
  kind: string;
  label: string;
  heading?: string;
  action?: string | null;
  dialog?: string | null;
  durationSec?: number | null;
  asset?: string;
}

function LocalForm({ id }: { id: string }) {
  const { drive } = useDirector();
  const [node, setNode] = useState<NodeSummary | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    drive("read_node", { id })
      .then((n) => live && setNode(n as NodeSummary))
      .catch(() => live && setNode(null));
    return () => {
      live = false;
    };
  }, [drive, id]);
  if (node === undefined) return <div className="bd-insp-body bd-insp-note">Reading node…</div>;
  if (node === null) return <Empty count={0} />;
  return node.kind === "scene" ? <LocalSceneForm node={node} onWrite={setNode} /> : <LocalLabelForm node={node} onWrite={setNode} />;
}

function LocalBanner() {
  return (
    <div className="bd-insp-local" role="status">
      <Icon name="info" /> local — not in Calliope yet
    </div>
  );
}

interface LocalScene {
  heading: string;
  action: string;
  dialog: string;
  durationSec: string;
}

function LocalSceneForm({ node, onWrite }: { node: NodeSummary; onWrite: (n: NodeSummary) => void }) {
  const actions = useActions();
  const seed = useMemo<LocalScene>(
    () => ({ heading: node.heading ?? node.label ?? "", action: node.action ?? "", dialog: node.dialog ?? "", durationSec: node.durationSec == null ? "" : String(node.durationSec) }),
    [node],
  );
  const { form, set, save, state, dirty } = useAutosave<LocalScene>(seed, async (f, base) => {
    if (!actions) throw new Error("editor actions unavailable");
    const patch: Record<string, unknown> = {};
    const written: (keyof LocalScene)[] = [];
    if (f.heading !== base.heading && f.heading.trim()) {
      patch.heading = f.heading;
      patch.label = f.heading;
      written.push("heading");
    }
    if (f.action !== base.action) {
      patch.action = f.action || undefined;
      written.push("action");
    }
    if (f.dialog !== base.dialog) {
      patch.dialog = f.dialog || undefined;
      written.push("dialog");
    }
    const d = parseDuration(f.durationSec);
    if (d !== null && d !== parseDuration(base.durationSec)) {
      patch.durationSec = d;
      written.push("durationSec");
    }
    if (!written.length) return null;
    actions.updateNode(node.id, patch, { history: false });
    onWrite({ ...node, ...(patch as Partial<NodeSummary>) });
    return written;
  });
  const blur = () => void save();
  const durationBad = parseDuration(form.durationSec) === null;
  return (
    <>
      <header className="bd-insp-head">
        <span className="bd-insp-kind">
          <Icon name="clapper" /> Scene
        </span>
        <span className="bd-insp-title" title={node.heading ?? node.label}>
          {node.heading ?? node.label}
        </span>
        <SaveIndicator state={state} dirty={dirty} onRetry={blur} />
      </header>
      <div className="bd-insp-body">
        <LocalBanner />
        <Section title="Script">
          <Field label="Heading">
            <input className="bd-input" name="heading" value={form.heading} onChange={(e) => set({ heading: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Action">
            <textarea className="bd-input" name="action" rows={4} value={form.action} placeholder="What happens on screen" onChange={(e) => set({ action: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Dialog">
            <textarea className="bd-input bd-insp-mono" name="dialog" rows={3} value={form.dialog} placeholder={"CHARACTER\nLine…"} onChange={(e) => set({ dialog: e.target.value })} onBlur={blur} />
          </Field>
          <Field label="Duration" hint={durationBad ? "whole seconds, at least 1" : "seconds"} bad={durationBad}>
            <input className="bd-input" name="duration_sec" type="number" min={1} step={1} inputMode="numeric" value={form.durationSec} onChange={(e) => set({ durationSec: e.target.value })} onBlur={blur} />
          </Field>
        </Section>
        <div className="bd-insp-note">Load a Calliope project and create the scene there to give it a row; the beat, refs, workflow and prompt draft live on the row.</div>
      </div>
    </>
  );
}

function LocalLabelForm({ node, onWrite }: { node: NodeSummary; onWrite: (n: NodeSummary) => void }) {
  const actions = useActions();
  const seed = useMemo(() => ({ label: node.label ?? "" }), [node]);
  const { form, set, save, state, dirty } = useAutosave<{ label: string }>(seed, async (f, base) => {
    if (!actions) throw new Error("editor actions unavailable");
    if (f.label === base.label || !f.label.trim()) return null;
    actions.updateNode(node.id, { label: f.label }, { history: false });
    onWrite({ ...node, label: f.label });
    return ["label"];
  });
  const blur = () => void save();
  const kind = node.kind === "asset" ? (node.asset ?? "asset") : node.kind;
  const icon = kind === "beat" ? "layers" : kind === "character" ? "user" : kind === "location" ? "mapPin" : kind === "item" ? "box" : kind === "note" ? "note" : "reroute";
  return (
    <>
      <header className="bd-insp-head">
        <span className="bd-insp-kind">
          <Icon name={icon} /> {kind}
        </span>
        <span className="bd-insp-title" title={node.label}>
          {node.label}
        </span>
        <SaveIndicator state={state} dirty={dirty} onRetry={blur} />
      </header>
      <div className="bd-insp-body">
        <LocalBanner />
        <Section title={kind}>
          <Field label="Label" hint={!form.label.trim() ? "required" : undefined} bad={!form.label.trim()}>
            <input className="bd-input" name="label" value={form.label} onChange={(e) => set({ label: e.target.value })} onBlur={blur} />
          </Field>
        </Section>
      </div>
    </>
  );
}

// ── registration ────────────────────────────────────────────────────────────────────────

registerSlot("right-dock", Inspector, { id: "u12-inspector", order: 10 });

registerDriveCommands({
  /**
   * Select one node so the inspector opens on it — the same selection a click makes.
   *
   * `if_unselected` is the hold's restore (inspector/hold.ts), not part of the agent's
   * vocabulary: it re-selects only while nothing ELSE is selected, so a write finishing after
   * the user has clicked another node does not drag them back. The test and the settle happen
   * inside ONE `run`, against one graph, so either order ends on the user's pick.
   */
  inspect: (args, kit) =>
    kit.run(
      (ns, es) => {
        const target = kit.find(ns, args.id);
        if (args.if_unselected === true && ns.some((n) => n.selected && n.id !== target.id)) return { id: target.id, skipped: true };
        // Told AT COMMAND TIME, not from the rendered selection: React coalesces a selection
        // that a refresh wipes in the same tick, so a hold that waited to observe it would
        // restore the wrong node.
        if (args.if_unselected !== true) noteSelection(target.id);
        kit.settle(
          ns.map((n) => {
            const on = n.id === target.id;
            return !!n.selected === on ? n : ({ ...n, selected: on } as RFNode);
          }),
          es,
          { reparent: false },
        );
        return { id: target.id, kind: target.data.kind, calliope: calliopeRef(target.id) };
      },
      { history: false },
    ),
});
