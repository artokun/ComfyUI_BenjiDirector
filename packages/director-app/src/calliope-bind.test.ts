import { describe, expect, it } from "vitest";
import type { SceneRow, StoryBundle } from "@benjidirector/calliope-client";
import { calId, calliopeRef, projectToGraph } from "./calliope-bind.js";

// Shapes copied from what Calliope 1.2.1 actually returned for the seeded project
// "The Approach" on 2026-09-01 — not from the spec, which types these as `object`.
const story: StoryBundle = {
  project: { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", status: "draft" },
  beats: [
    { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
    { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
  ],
  characters: [{ id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" }],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
  items: [],
};
const sceneRow = (id: number, order_index: number, beat_id: number | null, extra: Partial<SceneRow> = {}): SceneRow => ({
  id,
  project_id: 1,
  beat_id,
  order_index,
  heading: `SC-0${id}`,
  action: null,
  dialog: null,
  duration_sec: 5,
  workflow_id: null,
  env_image_path: null,
  location_id: 1,
  video_path: null,
  chain_from_prev: 0,
  character_ids: [1],
  video_settings: null,
  ...extra,
});

describe("projectToGraph", () => {
  const scenes = [sceneRow(1, 0, 1), sceneRow(2, 1, 1, { chain_from_prev: 1 }), sceneRow(3, 2, 2, { chain_from_prev: 1 })];
  const g = projectToGraph({ story, scenes });

  it("projects every row to a node with an id that names its Calliope row", () => {
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["cal-char-1", "cal-loc-1", "cal-beat-1", "cal-beat-2", "cal-sc-1", "cal-sc-2", "cal-sc-3"]));
    expect(calliopeRef("cal-sc-3")).toEqual({ kind: "scene", id: 3 });
    expect(calliopeRef("sc-mtj5v0c7")).toBeNull();
  });

  it("parents each scene under its Beat — beat_id is the native topology", () => {
    const sc = (id: number) => g.nodes.find((n) => n.id === calId.scene(id))!;
    expect(sc(1).parentId).toBe("cal-beat-1");
    expect(sc(2).parentId).toBe("cal-beat-1");
    expect(sc(3).parentId).toBe("cal-beat-2");
  });

  it("wires character and location refs into every scene", () => {
    const ids = g.edges.map((e) => e.id);
    expect(ids).toContain("lg:cal-char-1:out:REF->cal-sc-1:in:CHARACTER");
    expect(ids).toContain("lg:cal-loc-1:out:REF->cal-sc-1:in:LOCATION");
  });

  it("turns chain_from_prev into the continuity wire, and only where the flag is set", () => {
    const ids = g.edges.map((e) => e.id);
    expect(ids).toContain("lg:cal-sc-1:out:LAST FRAME->cal-sc-2:in:IN FRAME");
    expect(ids).toContain("lg:cal-sc-2:out:LAST FRAME->cal-sc-3:in:IN FRAME");
    // SC-01 has no predecessor and no flag: nothing feeds its IN FRAME.
    expect(ids.some((id) => id.endsWith("->cal-sc-1:in:IN FRAME"))).toBe(false);
  });

  it("a scene whose beat no longer exists lands at the top level instead of vanishing", () => {
    const g2 = projectToGraph({ story, scenes: [sceneRow(9, 0, 999)] });
    const n = g2.nodes.find((x) => x.id === "cal-sc-9")!;
    expect(n).toBeDefined();
    expect(n.parentId).toBeUndefined();
  });

  it("honours a saved position and pin from video_settings.director", () => {
    const g2 = projectToGraph({ story, scenes: [sceneRow(1, 0, 1, { video_settings: { director: { position: { x: 123, y: 456 }, promoted: true } } })] });
    const n = g2.nodes.find((x) => x.id === "cal-sc-1")!;
    expect(n.position).toEqual({ x: 123, y: 456 });
    expect((n.data as { promoted?: boolean }).promoted).toBe(true);
  });

  it("is deterministic — the same rows lay out the same way twice", () => {
    expect(projectToGraph({ story, scenes })).toEqual(projectToGraph({ story, scenes }));
  });
});
