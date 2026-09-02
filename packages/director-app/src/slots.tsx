// Slots: named places in the editor's chrome that feature modules fill without editing JSX.
//
//   registerSlot("toolbar-right", ProjectMenu, { order: 10 });
//
// DirectorApp renders `<Slot name="toolbar-right" />` once; everything registered there shows
// up in `order`. Slots are the reason twenty parallel units can each add a button, a dock or a
// strip and never fight over the same line of DirectorApp.tsx.

import { useSyncExternalStore, type ComponentType } from "react";

export type SlotName =
  | "toolbar-left" // after Group/Subgraph/…, before the spacer
  | "toolbar-right" // right end of the toolbar, before the status pill
  | "under-toolbar" // full-width strip between toolbar and canvas (job strip, note)
  | "left-dock" // column left of the canvas (sidebar)
  | "right-dock" // column right of the canvas (inspector)
  | "canvas-overlay" // absolutely positioned over the canvas (selection toolbar, minimap)
  | "footer"; // full-width strip under the canvas

interface Entry {
  id: string;
  Component: ComponentType;
  order: number;
}

const slots = new Map<SlotName, Entry[]>();
const listeners = new Set<() => void>();
let snapshot = new Map<SlotName, Entry[]>();

const rebuild = () => {
  snapshot = new Map([...slots.entries()].map(([k, v]) => [k, [...v].sort((a, b) => a.order - b.order)]));
  for (const l of listeners) l();
};

let auto = 0;
export function registerSlot(slot: SlotName, Component: ComponentType, opts: { order?: number; id?: string } = {}): () => void {
  const id = opts.id ?? `${slot}#${++auto}`;
  const list = slots.get(slot) ?? [];
  slots.set(slot, [...list.filter((e) => e.id !== id), { id, Component, order: opts.order ?? 100 }]);
  rebuild();
  return () => {
    slots.set(slot, (slots.get(slot) ?? []).filter((e) => e.id !== id));
    rebuild();
  };
}

function useSlot(slot: SlotName): Entry[] {
  const all = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
    () => snapshot,
  );
  return all.get(slot) ?? [];
}

const EMPTY: Entry[] = [];
export function useSlotCount(slot: SlotName): number {
  return (useSlot(slot) ?? EMPTY).length;
}

export function Slot({ name }: { name: SlotName }) {
  const entries = useSlot(name);
  if (!entries.length) return null;
  return (
    <>
      {entries.map((e) => (
        <e.Component key={e.id} />
      ))}
    </>
  );
}

/** For tests. */
export function _resetSlots(): void {
  slots.clear();
  rebuild();
}
