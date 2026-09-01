import { describe, expect, it } from "vitest";
import { GROUP_TYPE, type GraphNode } from "./types.js";
import { absolutePos, containmentFor, sortParentsFirst, wouldCreateCycle } from "./parenting.js";

type D = { label: string; width?: number; height?: number };
const node = (id: string, x: number, y: number, extra: Partial<GraphNode<D>> = {}): GraphNode<D> => ({
  id,
  position: { x, y },
  data: { label: id },
  ...extra,
});
const box = (id: string, x: number, y: number, w: number, h: number): GraphNode<D> =>
  node(id, x, y, { type: GROUP_TYPE, data: { label: id, width: w, height: h } });

describe("absolutePos", () => {
  it("adds each ancestor's offset", () => {
    const all = [box("g", 100, 100, 500, 500), node("a", 10, 20, { parentId: "g" })];
    expect(absolutePos(all[1]!, all)).toEqual({ x: 110, y: 120 });
  });

  it("terminates on a cyclic parent chain instead of hanging", () => {
    const all = [node("a", 1, 1, { parentId: "b" }), node("b", 2, 2, { parentId: "a" })];
    expect(() => absolutePos(all[0]!, all)).not.toThrow();
  });
});

describe("wouldCreateCycle", () => {
  const all = [box("outer", 0, 0, 900, 900), box("inner", 10, 10, 400, 400)];
  const nested = [all[0]!, { ...all[1]!, parentId: "outer" }];

  it("refuses to parent a node into itself", () => {
    expect(wouldCreateCycle("outer", "outer", nested)).toBe(true);
  });
  it("refuses to parent a container into its own descendant", () => {
    expect(wouldCreateCycle("outer", "inner", nested)).toBe(true);
  });
  it("allows an unrelated parent", () => {
    expect(wouldCreateCycle("inner", "outer", [all[0]!, all[1]!])).toBe(false);
  });
});

describe("containmentFor", () => {
  it("adopts a node whose centre lands inside a container, and rebases its position", () => {
    const g = box("g", 100, 100, 400, 400);
    const a = node("a", 200, 200, { measured: { width: 40, height: 40 } });
    const out = containmentFor(a, [g, a]);
    expect(out.parentId).toBe("g");
    expect(out.position).toEqual({ x: 100, y: 100 });
  });

  it("releases a node dragged out of its container, back to absolute coords", () => {
    const g = box("g", 100, 100, 400, 400);
    const a = node("a", 900, 900, { parentId: "g", measured: { width: 40, height: 40 } });
    const out = containmentFor(a, [g, a]);
    expect(out.parentId).toBeUndefined();
    expect(out.position).toEqual({ x: 1000, y: 1000 });
  });

  it("picks the INNERMOST container when two overlap", () => {
    const outer = box("outer", 0, 0, 900, 900);
    const inner = { ...box("inner", 100, 100, 300, 300), parentId: "outer" };
    const a = node("a", 200, 200, { measured: { width: 20, height: 20 } });
    expect(containmentFor(a, [outer, inner, a]).parentId).toBe("inner");
  });

  it("returns the SAME reference when nothing changes, so callers can skip a re-render", () => {
    const g = box("g", 100, 100, 400, 400);
    const a = node("a", 5000, 5000, { measured: { width: 20, height: 20 } });
    expect(containmentFor(a, [g, a])).toBe(a);
  });

  it("never adopts a node that is pinned", () => {
    const g = box("g", 100, 100, 400, 400);
    const a = node("a", 200, 200, { measured: { width: 40, height: 40 } });
    expect(containmentFor(a, [g, a], (id) => id === "a")).toBe(a);
  });
});

describe("sortParentsFirst", () => {
  it("emits every ancestor before its descendant, where a pairwise sort would not", () => {
    // [C(parent B), B(parent A), A] — the case a pairwise comparator gets wrong.
    const a = node("A", 0, 0);
    const b = node("B", 0, 0, { parentId: "A" });
    const c = node("C", 0, 0, { parentId: "B" });
    const ids = sortParentsFirst([c, b, a]).map((n) => n.id);
    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("B"));
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("C"));
  });

  it("keeps every node when the parent chain is cyclic", () => {
    const x = node("x", 0, 0, { parentId: "y" });
    const y = node("y", 0, 0, { parentId: "x" });
    expect(sortParentsFirst([x, y]).map((n) => n.id).sort()).toEqual(["x", "y"]);
  });
});
