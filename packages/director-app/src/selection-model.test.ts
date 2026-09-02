import { afterEach, describe, expect, it } from "vitest";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";
import {
  describeSelection,
  encloses,
  isSnapOn,
  marqueeOvercatch,
  minimapNodeClass,
  paneRectToFlow,
  setSnap,
  toggleSnap,
  type MarqueeCandidate,
} from "./selection-model.js";

describe("minimapNodeClass", () => {
  it("colours a Beat by its container type, whether group or subgraph", () => {
    expect(minimapNodeClass({ type: GROUP_TYPE, data: { kind: "beat" } })).toBe("bd-mm-beat");
    expect(minimapNodeClass({ type: SUBGRAPH_TYPE, data: { kind: "beat" } })).toBe("bd-mm-beat");
  });

  it("colours leaves by their kind", () => {
    expect(minimapNodeClass({ type: "scene", data: { kind: "scene" } })).toBe("bd-mm-scene");
    expect(minimapNodeClass({ type: "asset", data: { kind: "asset", asset: "character" } })).toBe("bd-mm-asset");
    expect(minimapNodeClass({ type: "note", data: { kind: "note" } })).toBe("bd-mm-note");
    expect(minimapNodeClass({ type: "reroute", data: { kind: "reroute" } })).toBe("bd-mm-reroute");
  });

  it("falls back rather than throwing on a node kind it has never heard of", () => {
    expect(minimapNodeClass({ type: "whatever", data: { kind: "whatever" } })).toBe("bd-mm-node");
    expect(minimapNodeClass({})).toBe("bd-mm-node");
  });

  // The type is what graph-core sets on a container; a Beat whose data says "beat" but whose
  // type is a leaf's must NOT read as a Beat, or promoting one would recolour the minimap.
  it("reads the type first, not the data", () => {
    expect(minimapNodeClass({ type: "scene", data: { kind: "beat" } })).toBe("bd-mm-node");
  });
});

describe("describeSelection", () => {
  it("labels the pill", () => {
    expect(describeSelection(1)).toBe("1 selected");
    expect(describeSelection(2)).toBe("2 selected");
  });
});

describe("encloses", () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };
  it("is true only when the inner box is wholly inside", () => {
    expect(encloses(outer, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
    expect(encloses(outer, { x: 0, y: 0, width: 100, height: 100 })).toBe(true);
    expect(encloses(outer, { x: -1, y: 10, width: 20, height: 20 })).toBe(false);
    expect(encloses(outer, { x: 90, y: 10, width: 20, height: 20 })).toBe(false);
    expect(encloses(outer, { x: 10, y: 90, width: 20, height: 20 })).toBe(false);
  });
});

describe("marqueeOvercatch", () => {
  // The demo's shape: a box drawn around the two scenes INSIDE beat-1 also brushes beat-1,
  // because React Flow's partial mode selects anything the box touches.
  const beat: MarqueeCandidate = { id: "beat-1", selected: true, strict: true, box: { x: 340, y: 40, width: 460, height: 380 } };
  const sc01: MarqueeCandidate = { id: "sc-01", selected: true, strict: false, box: { x: 380, y: 100, width: 200, height: 90 } };
  const sc02: MarqueeCandidate = { id: "sc-02", selected: true, strict: false, box: { x: 380, y: 260, width: 200, height: 90 } };

  it("lets go of a Beat the box only brushed, and keeps the leaves", () => {
    const box = { x: 360, y: 80, width: 260, height: 300 };
    expect(marqueeOvercatch(box, [beat, sc01, sc02])).toEqual(["beat-1"]);
  });

  it("keeps a Beat the box swallowed whole", () => {
    const box = { x: 300, y: 0, width: 600, height: 500 };
    expect(marqueeOvercatch(box, [beat, sc01, sc02])).toEqual([]);
  });

  it("ignores nodes that are not selected at all", () => {
    const box = { x: 360, y: 80, width: 260, height: 300 };
    expect(marqueeOvercatch(box, [{ ...beat, selected: false }])).toEqual([]);
  });
});

describe("paneRectToFlow", () => {
  it("undoes the viewport transform", () => {
    expect(paneRectToFlow({ x: 120, y: 60, width: 200, height: 100 }, [20, 10, 2])).toEqual({ x: 50, y: 25, width: 100, height: 50 });
  });

  it("survives a zero zoom rather than dividing by it", () => {
    expect(paneRectToFlow({ x: 10, y: 10, width: 10, height: 10 }, [0, 0, 0])).toEqual({ x: 10, y: 10, width: 10, height: 10 });
  });
});

describe("the snap switch", () => {
  afterEach(() => setSnap(false));

  it("is off until it is turned on, and toggles", () => {
    expect(isSnapOn()).toBe(false);
    toggleSnap();
    expect(isSnapOn()).toBe(true);
    toggleSnap();
    expect(isSnapOn()).toBe(false);
  });

  it("does not throw where there is no storage", () => {
    expect(() => setSnap(true)).not.toThrow();
    expect(isSnapOn()).toBe(true);
  });
});
