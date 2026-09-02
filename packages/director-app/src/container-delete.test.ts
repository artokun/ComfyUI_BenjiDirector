import { describe, expect, it } from "vitest";
import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  absolutePos,
  dissolveSubgraph,
  isRelayHandle,
  promoteToSubgraph,
  reconcileBoundary,
  type GraphEdge,
  type GraphNode,
} from "@benjidirector/graph-core";
import {
  cascadeDeletePlan,
  descendantsOf,
  describeDescendants,
  isContainerBodyTarget,
  requestDeleteContainer,
  setDeleteContainerHandler,
  shellDeletePlan,
} from "./container-delete.js";
import { asset, beat, demoProject, directorHost, scene, type BeatData, type DirectorData } from "./model.js";

type N = GraphNode<DirectorData>;

const chain = (a: string, b: string): GraphEdge => ({
  id: `lg:${a}:out:LAST FRAME->${b}:in:IN FRAME`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:LAST FRAME`,
  targetHandle: `${b}:in:IN FRAME`,
});

const byId = (ns: readonly N[], id: string): N => {
  const n = ns.find((x) => x.id === id);
  if (!n) throw new Error(`missing ${id}`);
  return n;
};

/** outer(300,40) ⊃ inner(40,40) ⊃ sa(20,60); sb(30,250) directly in outer; sx outside. */
function nested(): { nodes: N[]; edges: GraphEdge[] } {
  const outer = beat("outer", "Outer", { x: 300, y: 40 }, { width: 700, height: 500 });
  const inner: N = { ...beat("inner", "Inner", { x: 40, y: 40 }, { width: 300, height: 220 }), parentId: "outer" };
  const sa = scene("sa", "SA", { x: 20, y: 60 }, {}, "inner");
  const sb = scene("sb", "SB", { x: 30, y: 250 }, {}, "outer");
  const sx = scene("sx", "SX", { x: 1200, y: 300 });
  const who: N = { ...asset("who", "Who", "character", { x: 10, y: 10 }), parentId: "inner" };
  return { nodes: [outer, inner, sa, sb, sx, who], edges: [chain("sa", "sb"), chain("sb", "sx")] };
}

describe("descendantsOf / describeDescendants", () => {
  it("walks pre-order: each direct child, then its own descendants", () => {
    const { nodes } = nested();
    expect(descendantsOf(nodes, "outer").map((n) => n.id)).toEqual(["inner", "sa", "who", "sb"]);
    expect(descendantsOf(nodes, "inner").map((n) => n.id)).toEqual(["sa", "who"]);
    expect(descendantsOf(nodes, "sx")).toEqual([]);
  });

  it("terminates on a cyclic parent chain", () => {
    const a: N = { ...scene("a", "A", { x: 0, y: 0 }), parentId: "b" };
    const b: N = { ...scene("b", "B", { x: 0, y: 0 }), parentId: "a" };
    expect(descendantsOf([a, b], "a").map((n) => n.id)).toEqual(["b"]);
  });

  it("labels each row with the palette's word for it and its depth", () => {
    const { nodes, edges } = nested();
    const promoted = promoteToSubgraph("inner", nodes, edges, directorHost);
    expect(describeDescendants(promoted.nodes, "outer")).toEqual([
      { id: "inner", label: "Inner", kind: "subgraph", depth: 1 },
      { id: "sa", label: "SA", kind: "scene", depth: 2 },
      { id: "who", label: "Who", kind: "character", depth: 2 },
      { id: "sb", label: "SB", kind: "scene", depth: 1 },
    ]);
    expect(describeDescendants(nodes, "outer")[0]).toMatchObject({ kind: "group" });
  });
});

describe("cascadeDeletePlan", () => {
  it("removes the Beat, every descendant (nested included) and every wire touching them", () => {
    const { nodes, edges } = nested();
    const plan = cascadeDeletePlan(nodes, edges, "outer");
    expect(plan.removed).toEqual(["outer", "inner", "sa", "who", "sb"]);
    expect(plan.nodes.map((n) => n.id)).toEqual(["sx"]);
    expect(plan.edges).toEqual([]);
    expect(plan.reparented).toEqual([]);
  });

  it("on a leaf is a plain delete", () => {
    const { nodes, edges } = nested();
    const plan = cascadeDeletePlan(nodes, edges, "sx");
    expect(plan.removed).toEqual(["sx"]);
    expect(plan.edges.map((e) => e.id)).toEqual([chain("sa", "sb").id]);
  });

  it("refuses an unknown id", () => {
    expect(() => cascadeDeletePlan([], [], "nope")).toThrow(/no node "nope"/);
  });
});

describe("shellDeletePlan", () => {
  it("lifts the demo Beat's scenes onto the canvas at the same absolute position, wires intact", () => {
    const { nodes, edges } = demoProject();
    const before = Object.fromEntries(["sc-01", "sc-02"].map((id) => [id, absolutePos(byId(nodes, id), nodes)]));
    const plan = shellDeletePlan(nodes, edges, "beat-1");

    expect(plan.removed).toEqual(["beat-1"]);
    expect(plan.reparented.sort()).toEqual(["sc-01", "sc-02"]);
    expect(plan.nodes.some((n) => n.id === "beat-1")).toBe(false);
    for (const id of ["sc-01", "sc-02"]) {
      const n = byId(plan.nodes, id);
      expect(n.parentId, `${id} has no parent any more`).toBeUndefined();
      expect("parentId" in n, `${id} carries no parentId key at all`).toBe(false);
      expect(n.position).toEqual(before[id]);
      expect(absolutePos(n, plan.nodes)).toEqual(before[id]);
    }
    // Every wire the demo had is still there, byte for byte.
    expect(plan.edges).toEqual(edges);
    // Untouched nodes are the same references.
    expect(byId(plan.nodes, "sc-03")).toBe(byId(nodes, "sc-03"));
  });

  it("dissolves a SUBGRAPH first so its crossing comes back as a direct wire", () => {
    const { nodes, edges } = demoProject();
    const sub = promoteToSubgraph("beat-1", nodes, edges, directorHost);
    expect(byId(sub.nodes, "beat-1").type).toBe(SUBGRAPH_TYPE);
    expect(sub.edges.some((e) => e.source === "beat-1" || e.target === "beat-1"), "promote made rail edges").toBe(true);

    const plan = shellDeletePlan(sub.nodes, sub.edges, "beat-1");
    expect(plan.edges.some((e) => e.source === "beat-1" || e.target === "beat-1")).toBe(false);
    expect(plan.edges.some((e) => isRelayHandle(e.sourceHandle) || isRelayHandle(e.targetHandle))).toBe(false);
    expect(plan.edges.map((e) => e.id).sort()).toEqual(edges.map((e) => e.id).sort());
    expect(byId(plan.nodes, "sc-02").parentId).toBeUndefined();
  });

  it("re-parents a nested Beat's children to the GRANDPARENT with corrected positions", () => {
    const { nodes, edges } = nested();
    const saAbs = absolutePos(byId(nodes, "sa"), nodes);
    const whoAbs = absolutePos(byId(nodes, "who"), nodes);
    expect(saAbs).toEqual({ x: 360, y: 140 });

    const plan = shellDeletePlan(nodes, edges, "inner");
    expect(plan.removed).toEqual(["inner"]);
    expect(plan.reparented).toEqual(["sa", "who"]);
    const sa = byId(plan.nodes, "sa");
    expect(sa.parentId).toBe("outer");
    expect(sa.position).toEqual({ x: 60, y: 100 });
    expect(absolutePos(sa, plan.nodes)).toEqual(saAbs);
    expect(absolutePos(byId(plan.nodes, "who"), plan.nodes)).toEqual(whoAbs);
    // sb was never inside inner: same reference, same parent.
    expect(byId(plan.nodes, "sb")).toBe(byId(nodes, "sb"));
    expect(plan.edges).toEqual(edges);
    // Parents still precede children for React Flow.
    const order = plan.nodes.map((n) => n.id);
    expect(order.indexOf("outer")).toBeLessThan(order.indexOf("sa"));
  });

  it("deleting the OUTER shell lifts the inner Beat out whole — its own children do not move", () => {
    const { nodes, edges } = nested();
    const before = Object.fromEntries(["inner", "sa", "sb", "who"].map((id) => [id, absolutePos(byId(nodes, id), nodes)]));
    const plan = shellDeletePlan(nodes, edges, "outer");
    expect(plan.reparented.sort()).toEqual(["inner", "sb"]);
    expect(byId(plan.nodes, "inner").parentId).toBeUndefined();
    expect(byId(plan.nodes, "inner").position).toEqual({ x: 340, y: 80 });
    // sa keeps its parent AND its relative position: only the frame above it changed.
    expect(byId(plan.nodes, "sa")).toBe(byId(nodes, "sa"));
    for (const id of ["inner", "sa", "sb", "who"]) expect(absolutePos(byId(plan.nodes, id), plan.nodes), id).toEqual(before[id]);
    expect(byId(plan.nodes, "inner").type).toBe(GROUP_TYPE);
  });

  it("nested SUBGRAPHS: deleting the inner shell leaves the outer's rail re-derivable to a direct wire", () => {
    const { nodes, edges } = nested();
    // Inner first, then outer — the outer's rail then aliases the inner's rail.
    const a = promoteToSubgraph("inner", nodes, edges, directorHost);
    const b = promoteToSubgraph("outer", a.nodes, a.edges, directorHost);
    const outerRails = byId(b.nodes, "outer").data as BeatData;
    expect(outerRails.promotedOut.map((p) => p.childId)).toEqual(["sb"]);

    const plan = shellDeletePlan(b.nodes, b.edges, "inner");
    expect(plan.nodes.some((n) => n.id === "inner")).toBe(false);
    expect(byId(plan.nodes, "sa").parentId).toBe("outer");
    // What settle() does next: reconcile the outer, then read its logical wiring back.
    const rec = reconcileBoundary("outer", plan.nodes, plan.edges, directorHost);
    const logical = dissolveSubgraph("outer", rec.nodes, rec.edges);
    expect(logical.edges.map((e) => e.id).sort()).toEqual([chain("sa", "sb").id, chain("sb", "sx").id]);
    expect((byId(rec.nodes, "outer").data as BeatData).promotedOut.map((p) => p.childId)).toEqual(["sb"]);
  });

  it("refuses a leaf and an unknown id", () => {
    const { nodes, edges } = nested();
    expect(() => shellDeletePlan(nodes, edges, "sx")).toThrow(/not a Beat/);
    expect(() => shellDeletePlan(nodes, edges, "nope")).toThrow(/no node "nope"/);
  });
});

describe("isContainerBodyTarget", () => {
  const at = (...hits: string[]) => ({ closest: (sel: string) => (hits.includes(sel) ? {} : null) });
  it("is the body when nothing in the chrome list is an ancestor", () => {
    expect(isContainerBodyTarget(at())).toBe(true);
    expect(isContainerBodyTarget(at(".bd-group"))).toBe(true);
  });
  it.each([".bd-group-title", ".bd-collapsed", ".bd-nodebar", ".bd-rail", ".react-flow__handle", ".react-flow__resize-control", "button", "input"])(
    "is NOT the body on %s",
    (sel) => {
      expect(isContainerBodyTarget(at(sel))).toBe(false);
    },
  );
  it("is not the body with no element at all", () => {
    expect(isContainerBodyTarget(null)).toBe(false);
  });
});

describe("requestDeleteContainer", () => {
  it("is unhandled until a confirm flow is installed, and again once it is removed", () => {
    expect(requestDeleteContainer("beat-1")).toBe(false);
    const seen: string[] = [];
    const off = setDeleteContainerHandler((id) => seen.push(id));
    expect(requestDeleteContainer("beat-1")).toBe(true);
    expect(seen).toEqual(["beat-1"]);
    off();
    expect(requestDeleteContainer("beat-1")).toBe(false);
    expect(seen).toEqual(["beat-1"]);
  });

  it("a stale uninstall does not remove a newer handler", () => {
    const off1 = setDeleteContainerHandler(() => undefined);
    const seen: string[] = [];
    const off2 = setDeleteContainerHandler((id) => seen.push(id));
    off1();
    expect(requestDeleteContainer("x")).toBe(true);
    expect(seen).toEqual(["x"]);
    off2();
  });
});
