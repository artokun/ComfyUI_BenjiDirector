import { describe, expect, it } from "vitest";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";
import { buildTimeline, clipSeconds, clock, cutIndexAt, cutOf, reorderCut, rulerStep, type TimelineNode } from "./timeline-model.js";
import type { SceneData } from "./model.js";

// Every case builds a small graph by hand and asserts the sheet a reader would see. The model
// is pure, so "what the canvas shows" and "what the sheet shows" can only disagree here.

const scene = (id: string, heading: string, durationSec: number | undefined, extra: Partial<SceneData & TimelineNode> = {}): TimelineNode => ({
  id,
  type: "scene",
  parentId: (extra as { parentId?: string }).parentId,
  position: { x: (extra as { position?: { x: number; y?: number } }).position?.x ?? 0, y: 0 },
  selected: (extra as { selected?: boolean }).selected,
  data: { kind: "scene", label: heading, heading, durationSec, ports: [], ...extra } as unknown,
});

const beat = (id: string, label: string, extra: Record<string, unknown> = {}): TimelineNode => ({
  id,
  type: GROUP_TYPE,
  data: { kind: "beat", label, promotedIn: [], promotedOut: [], ...extra } as unknown,
});

/** cal-sc-1 (6s) and cal-sc-2 (4s) in beat A; cal-sc-3 (8s) in beat B. */
function film(): TimelineNode[] {
  return [
    beat("cal-beat-1", "Beat 1 — The approach"),
    beat("cal-beat-2", "Beat 2 — The call"),
    scene("cal-sc-1", "SC-01", 6, { orderIndex: 0, parentId: "cal-beat-1" }),
    scene("cal-sc-2", "SC-02", 4, { orderIndex: 1, parentId: "cal-beat-1" }),
    scene("cal-sc-3", "SC-03", 8, { orderIndex: 2, parentId: "cal-beat-2" }),
  ];
}

describe("cutOf", () => {
  it("follows order_index, which is the film's real cut", () => {
    const nodes = [scene("c", "C", 1, { orderIndex: 2 }), scene("a", "A", 1, { orderIndex: 0 }), scene("b", "B", 1, { orderIndex: 1 })];
    expect(cutOf(nodes)).toEqual(["a", "b", "c"]);
  });

  it("puts a scene with NO order_index after the ones that have it, left to right", () => {
    const nodes = [scene("local-2", "L2", 1, { position: { x: 900, y: 0 } }), scene("cal-sc-1", "SC-01", 1, { orderIndex: 0 }), scene("local-1", "L1", 1, { position: { x: 100, y: 0 } })];
    expect(cutOf(nodes)).toEqual(["cal-sc-1", "local-1", "local-2"]);
  });

  it("compares ABSOLUTE x, so a card inside a Beat is not sorted against a naked one's ruler", () => {
    // The demo's shape: two scenes at x=40 inside a Beat at x=340, and a loose one at x=900.
    // Read raw, the pair would sort before anything; read absolutely they sit at 380.
    const nodes = [
      { ...beat("beat-1", "Beat"), position: { x: 340, y: 0 } },
      scene("in-beat", "In", 1, { parentId: "beat-1", position: { x: 40, y: 0 } }),
      scene("loose-early", "Early", 1, { position: { x: 100, y: 0 } }),
      scene("loose-late", "Late", 1, { position: { x: 900, y: 0 } }),
    ];
    expect(cutOf(nodes)).toEqual(["loose-early", "in-beat", "loose-late"]);
  });

  it("breaks a dead tie on id, never on array order", () => {
    const a = [scene("b", "B", 1), scene("a", "A", 1)];
    const b = [scene("a", "A", 1), scene("b", "B", 1)];
    expect(cutOf(a)).toEqual(cutOf(b));
  });

  it("ignores everything that is not a scene", () => {
    expect(cutOf([beat("beat-1", "Beat"), scene("sc-01", "SC", 1)])).toEqual(["sc-01"]);
  });
});

describe("clipSeconds", () => {
  it("gives a scene with no duration a default rather than a zero-width clip", () => {
    expect(clipSeconds({ durationSec: undefined } as SceneData)).toBe(4);
    expect(clipSeconds({ durationSec: 12 } as SceneData)).toBe(12);
  });
  it("clamps up, because a clip you cannot grab cannot be edited", () => {
    expect(clipSeconds({ durationSec: 0 } as SceneData)).toBe(1);
    expect(clipSeconds({ durationSec: -5 } as SceneData)).toBe(1);
  });
});

describe("buildTimeline", () => {
  it("lays the cut end to end, so a start is the sum of what plays before it", () => {
    const { clips, duration } = buildTimeline(film());
    expect(clips.map((c) => [c.id, c.start, c.end])).toEqual([
      ["cal-sc-1", 0, 6],
      ["cal-sc-2", 6, 10],
      ["cal-sc-3", 10, 18],
    ]);
    expect(duration).toBe(18);
  });

  it("gives each Beat its own SHORTER span, at the film's absolute positions", () => {
    const { rows } = buildTimeline(film());
    expect(rows.map((r) => [r.id, r.kind, r.start, r.end])).toEqual([
      ["film", "film", 0, 18],
      ["cal-beat-1", "beat", 0, 10],
      ["cal-beat-2", "beat", 10, 18],
    ]);
    expect(rows[1]?.label).toBe("Beat 1 — The approach");
    expect(rows[0]?.clipIds).toEqual(["cal-sc-1", "cal-sc-2", "cal-sc-3"]);
    expect(rows[1]?.clipIds).toEqual(["cal-sc-1", "cal-sc-2"]);
  });

  it("orders Beat rows by when they PLAY, not by where they sit in the array", () => {
    const nodes = [
      beat("late", "Late"),
      beat("early", "Early"),
      scene("sc-b", "B", 5, { orderIndex: 1, parentId: "late" }),
      scene("sc-a", "A", 5, { orderIndex: 0, parentId: "early" }),
    ];
    expect(buildTimeline(nodes).rows.map((r) => r.id)).toEqual(["film", "early", "late"]);
  });

  it("a scene in no Beat gets the loose row, so nothing on the canvas is missing here", () => {
    const nodes = [...film(), scene("cal-sc-4", "SC-04", 3, { orderIndex: 3 })];
    const { rows } = buildTimeline(nodes);
    const loose = rows.find((r) => r.id === "loose");
    expect(loose).toMatchObject({ kind: "loose", label: "No Beat", start: 18, end: 21 });
    expect(loose?.clipIds).toEqual(["cal-sc-4"]);
    // …and there is no loose row when every scene has a Beat.
    expect(buildTimeline(film()).rows.some((r) => r.id === "loose")).toBe(false);
  });

  it("a subgraph Beat is a row like any other — promoting one does not empty the sheet", () => {
    const nodes = film().map((n) => (n.id === "cal-beat-1" ? { ...n, type: SUBGRAPH_TYPE } : n));
    expect(buildTimeline(nodes).rows.map((r) => r.id)).toEqual(["film", "cal-beat-1", "cal-beat-2"]);
  });

  it("a MUTED scene keeps its slot and is counted separately, so the cut after it does not shift", () => {
    const nodes = film().map((n) => (n.id === "cal-sc-2" ? { ...n, data: { ...(n.data as object), bypassed: true } } : n));
    const { clips, duration, mutedSec } = buildTimeline(nodes);
    expect(clips.find((c) => c.id === "cal-sc-3")).toMatchObject({ start: 10, end: 18 });
    expect(duration).toBe(18);
    expect(mutedSec).toBe(4);
    expect(clips.find((c) => c.id === "cal-sc-2")?.bypassed).toBe(true);
  });

  it("carries the scene's id, tint, clip and selection through to the clip", () => {
    const nodes = film().map((n) => (n.id === "cal-sc-1" ? { ...n, selected: true, data: { ...(n.data as object), color: "#f00", videoPath: "out/a.mp4" } } : n));
    expect(buildTimeline(nodes).clips[0]).toMatchObject({ sceneId: 1, color: "#f00", hasClip: true, selected: true, cut: 0 });
    // A scene the editor invented has no row yet, and says so rather than guessing an id.
    expect(buildTimeline([scene("sc-01", "SC", 2)]).clips[0]?.sceneId).toBeNull();
  });

  it("is empty, not broken, with no scenes at all", () => {
    expect(buildTimeline([beat("beat-1", "Beat")])).toEqual({ rows: [{ id: "film", kind: "film", label: "Film", start: 0, end: 0, clipIds: [] }], clips: [], duration: 0, mutedSec: 0 });
  });
});

describe("reorderCut", () => {
  it("moves one id and returns the FULL list, which is what the reorder route takes", () => {
    expect(reorderCut(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorderCut(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
  });
  it("counts `to` in the list WITHOUT the moved id, so the last place is reachable", () => {
    expect(reorderCut(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(reorderCut(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
  });
  it("leaves the cut alone for an id that is not in it", () => {
    expect(reorderCut(["a", "b"], "z", 0)).toEqual(["a", "b"]);
  });
});

describe("cutIndexAt", () => {
  const { clips } = buildTimeline(film()); // 0-6, 6-10, 10-18

  it("reads a drop past a clip's MIDPOINT as after it", () => {
    // sc-1 dropped before sc-2's midpoint (8s) stays first; past it, it goes second.
    expect(cutIndexAt(clips, "cal-sc-1", 7)).toBe(0);
    expect(cutIndexAt(clips, "cal-sc-1", 9)).toBe(1);
  });
  it("reaches the last position, which measuring against starts alone cannot", () => {
    expect(cutIndexAt(clips, "cal-sc-1", 100)).toBe(2);
  });
  it("clamps a drop before the film to the front", () => {
    expect(cutIndexAt(clips, "cal-sc-3", -20)).toBe(0);
  });
});

describe("clock and rulerStep", () => {
  it("speaks in minutes and seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(4)).toBe("0:04");
    expect(clock(83)).toBe("1:23");
    expect(clock(-5)).toBe("0:00");
  });
  it("picks a tick that stays readable as the zoom changes", () => {
    expect(rulerStep(60, 60)).toBe(1);
    expect(rulerStep(60, 8)).toBe(10);
    expect(rulerStep(600, 1)).toBe(60);
    // …and never a step so fine the labels collide.
    expect(rulerStep(60, 0.01)).toBeGreaterThanOrEqual(8);
  });
});
