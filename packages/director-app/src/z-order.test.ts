import { beforeEach, describe, expect, it } from "vitest";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";
import { CONTAINER_Z, _resetZ, applyZOrder, needsZOrder, nextZ } from "./z-order.js";
import { unmeasuredIds, visibleIdKey } from "./stability.js";

const g = (id: string, zIndex?: number) => ({ id, type: GROUP_TYPE, ...(zIndex !== undefined ? { zIndex } : {}) });
const s = (id: string, zIndex?: number) => ({ id, type: SUBGRAPH_TYPE, ...(zIndex !== undefined ? { zIndex } : {}) });
const leaf = (id: string, zIndex?: number) => ({ id, type: "scene", ...(zIndex !== undefined ? { zIndex } : {}) });

describe("applyZOrder", () => {
  beforeEach(() => _resetZ());

  it("pins every container at CONTAINER_Z and leaves leaves alone", () => {
    const out = applyZOrder([g("b1"), s("b2", 5), leaf("a"), leaf("c", 7)]);
    expect(out.map((n) => n.zIndex)).toEqual([CONTAINER_Z, CONTAINER_Z, undefined, 7]);
  });

  it("returns the SAME array when nothing needs to change", () => {
    const nodes = [g("b1", CONTAINER_Z), leaf("a", 2)];
    expect(applyZOrder(nodes)).toBe(nodes);
    expect(needsZOrder(nodes)).toBe(false);
    expect(needsZOrder([g("b1")])).toBe(true);
  });

  it("keeps node identity for the ones it does not touch", () => {
    const a = leaf("a", 1);
    const out = applyZOrder([g("b1"), a]);
    expect(out[1]).toBe(a);
    expect(out[0]).not.toBe(a);
  });

  it("bumps a leaf above the counter", () => {
    nextZ();
    nextZ(); // counter at 2
    const out = applyZOrder([leaf("a", 1), leaf("b", 2)], "a");
    expect(out[0]?.zIndex).toBe(3);
    expect(out[1]?.zIndex).toBe(2);
    // and the counter moved with it, so the next mint is above the bump
    expect(nextZ()).toBe(4);
  });

  it("bumps above a z the graph already carries, even when the counter is behind", () => {
    const out = applyZOrder([leaf("a", 1), leaf("imported", 900)], "a");
    expect(out[0]?.zIndex).toBe(901);
  });

  it("never bumps a container — it stays pinned", () => {
    const out = applyZOrder([g("b1", CONTAINER_Z), leaf("a", 1)], "b1");
    expect(out[0]?.zIndex).toBe(CONTAINER_Z);
    expect(out).toEqual([g("b1", CONTAINER_Z), leaf("a", 1)]);
  });

  it("ignores an unknown bump id", () => {
    const nodes = [g("b1", CONTAINER_Z), leaf("a", 1)];
    expect(applyZOrder(nodes, "nope")).toBe(nodes);
  });

  it("bumping twice is monotonic", () => {
    let nodes = applyZOrder([leaf("a"), leaf("b")], "a");
    const za = nodes[0]?.zIndex ?? 0;
    nodes = applyZOrder(nodes, "b");
    expect(nodes[1]?.zIndex).toBeGreaterThan(za);
    nodes = applyZOrder(nodes, "a");
    expect(nodes[0]?.zIndex).toBeGreaterThan(nodes[1]?.zIndex ?? 0);
  });
});

describe("measurement helpers", () => {
  it("visibleIdKey is the sorted set of visible ids — order and hidden nodes do not change it", () => {
    const a = visibleIdKey([{ id: "b" }, { id: "a" }, { id: "h", hidden: true }]);
    const b = visibleIdKey([{ id: "a" }, { id: "h", hidden: true }, { id: "b" }]);
    expect(a).toBe("a,b");
    expect(b).toBe(a);
    // un-hiding a node IS a change: it now needs measuring
    expect(visibleIdKey([{ id: "a" }, { id: "h" }, { id: "b" }])).toBe("a,b,h");
    expect(visibleIdKey([])).toBe("");
  });

  it("unmeasuredIds narrows the kick to the nodes that still have no size", () => {
    const measured = new Set(["a"]);
    expect(unmeasuredIds(["a", "b", "c"], (id) => measured.has(id))).toEqual(["b", "c"]);
    expect(unmeasuredIds(["a"], (id) => measured.has(id))).toEqual([]);
  });
});
