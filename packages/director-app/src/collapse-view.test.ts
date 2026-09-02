import { describe, expect, it } from "vitest";
import { GROUP_TYPE, SUBGRAPH_TYPE, boundaryPortId, innerHandleId } from "@benjidirector/graph-core";
import {
  canonicalEdgeChanges,
  canonicalEdgeId,
  collapsedAncestor,
  displayedEdgeId,
  displayedEdges,
  isDisplayedEdgeId,
  parseProxyHandle,
  proxyHandleId,
  proxyHandlesFor,
  type ViewEdge,
  type ViewNode,
} from "./collapse-view.js";
import { beat, scene, asset, type DirectorNode } from "./model.js";

// The projection is a pure function of (nodes, canonical edges). Every case below builds a
// small graph by hand and asserts what React Flow would be handed, and that the canonical
// edges it was given came back untouched.

const link = (a: string, ah: string, b: string, bh: string): ViewEdge => ({
  id: `lg:${a}:out:${ah}->${b}:in:${bh}`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:${ah}`,
  targetHandle: `${b}:in:${bh}`,
});

const collapse = (n: DirectorNode): DirectorNode => ({ ...n, data: { ...n.data, collapsed: true } } as DirectorNode);

/** Nadia → sc-01 (in beat-1), sc-01 → sc-02 (both in beat-1), sc-02 → sc-03 (outside). */
function demo(): { nodes: DirectorNode[]; edges: ViewEdge[] } {
  const nodes = [
    asset("char-nadia", "Nadia", "character", { x: 0, y: 0 }),
    beat("beat-1", "Beat 1", { x: 100, y: 0 }),
    scene("sc-01", "SC-01", { x: 10, y: 10 }, {}, "beat-1"),
    scene("sc-02", "SC-02", { x: 10, y: 120 }, {}, "beat-1"),
    scene("sc-03", "SC-03", { x: 900, y: 0 }),
  ];
  const edges = [link("char-nadia", "REF", "sc-01", "CHARACTER"), link("sc-01", "LAST FRAME", "sc-02", "IN FRAME"), link("sc-02", "LAST FRAME", "sc-03", "IN FRAME")];
  return { nodes, edges };
}

describe("ids", () => {
  it("derives a proxy handle id from the container and the child port, and parses it back", () => {
    const id = proxyHandleId("beat-1", "sc-01:in:CHARACTER");
    expect(id).toBe("beat-1::proxy:sc-01:in:CHARACTER");
    expect(parseProxyHandle(id)).toEqual({ containerId: "beat-1", childPortId: "sc-01:in:CHARACTER" });
    // A nested subgraph's boundary port carries `::` itself; the FIRST proxy mark wins.
    const nested = proxyHandleId("beat-1", boundaryPortId("beat-2", "sc-01:in:CHARACTER"));
    expect(parseProxyHandle(nested)).toEqual({ containerId: "beat-1", childPortId: "beat-2::sc-01:in:CHARACTER" });
    expect(parseProxyHandle("sc-01:in:CHARACTER")).toBeUndefined();
    expect(parseProxyHandle(null)).toBeUndefined();
  });

  it("maps a displayed edge id back to its canonical id and leaves a canonical id alone", () => {
    expect(displayedEdgeId("lg:a->b")).toBe("lg:a->b@display");
    expect(isDisplayedEdgeId("lg:a->b@display")).toBe(true);
    expect(canonicalEdgeId("lg:a->b@display")).toBe("lg:a->b");
    expect(canonicalEdgeId("lg:a->b")).toBe("lg:a->b");
  });
});

describe("collapsedAncestor", () => {
  it("is undefined when nothing above the node is collapsed", () => {
    const { nodes } = demo();
    expect(collapsedAncestor("sc-01", nodes)).toBeUndefined();
    expect(collapsedAncestor("sc-03", nodes)).toBeUndefined();
  });

  it("names the collapsed group above a node, group or subgraph alike", () => {
    const { nodes } = demo();
    const asGroup = nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n));
    expect(collapsedAncestor("sc-01", asGroup)).toBe("beat-1");
    const asSubgraph = asGroup.map((n) => (n.id === "beat-1" ? { ...n, type: SUBGRAPH_TYPE } : n));
    expect(collapsedAncestor("sc-01", asSubgraph)).toBe("beat-1");
  });

  it("picks the OUTERMOST collapsed container, past an expanded or collapsed one in between", () => {
    const outer = collapse(beat("outer", "Outer", { x: 0, y: 0 }));
    const inner = { ...beat("inner", "Inner", { x: 10, y: 10 }), parentId: "outer" } as DirectorNode;
    const leaf = scene("sc-01", "SC-01", { x: 0, y: 0 }, {}, "inner");
    expect(collapsedAncestor("sc-01", [outer, inner, leaf])).toBe("outer");
    expect(collapsedAncestor("sc-01", [outer, collapse(inner), leaf])).toBe("outer");
    // The inner one alone collapsed: it is the only collapsed ancestor, so it wins.
    expect(collapsedAncestor("sc-01", [{ ...outer, data: { ...outer.data, collapsed: false } } as DirectorNode, collapse(inner), leaf])).toBe("inner");
  });

  it("does not treat a collapsed LEAF as a container, and survives a parent cycle", () => {
    const leaf = { ...scene("sc-01", "SC-01", { x: 0, y: 0 }), data: { ...scene("sc-01", "SC-01", { x: 0, y: 0 }).data, collapsed: true } } as DirectorNode;
    const child = scene("sc-02", "SC-02", { x: 0, y: 0 }, {}, "sc-01");
    expect(collapsedAncestor("sc-02", [leaf, child])).toBeUndefined();
    const a: ViewNode = { id: "a", type: GROUP_TYPE, parentId: "b", data: { collapsed: true } };
    const b: ViewNode = { id: "b", type: GROUP_TYPE, parentId: "a", data: { collapsed: false } };
    expect(collapsedAncestor("b", [a, b])).toBe("a");
  });
});

describe("proxyHandlesFor", () => {
  it("lists one proxy per child port with an EXTERNAL wire, typed and sided from the port", () => {
    const { nodes, edges } = demo();
    const proxies = proxyHandlesFor("beat-1", nodes, edges);
    expect(proxies).toEqual([
      { id: "beat-1::proxy:sc-01:in:CHARACTER", childId: "sc-01", childPortId: "sc-01:in:CHARACTER", side: "in", type: "ref", label: "CHARACTER" },
      { id: "beat-1::proxy:sc-02:out:LAST FRAME", childId: "sc-02", childPortId: "sc-02:out:LAST FRAME", side: "out", type: "image", label: "LAST FRAME" },
    ]);
  });

  it("dedupes a port that feeds several externals, and ignores a wire the container itself carries", () => {
    const { nodes, edges } = demo();
    const more = [...edges, link("sc-02", "LAST FRAME", "sc-04", "IN FRAME"), { id: "relay", source: "beat-1", target: "sc-01", sourceHandle: innerHandleId(boundaryPortId("beat-1", "sc-01:in:CHARACTER")), targetHandle: "sc-01:in:CHARACTER" }];
    const all = [...nodes, scene("sc-04", "SC-04", { x: 0, y: 0 })];
    const outs = proxyHandlesFor("beat-1", all, more).filter((p) => p.side === "out");
    expect(outs.map((p) => p.id)).toEqual(["beat-1::proxy:sc-02:out:LAST FRAME"]);
    expect(proxyHandlesFor("beat-1", all, more).some((p) => p.childId === "beat-1")).toBe(false);
  });

  it("reaches descendants at any depth, through a nested subgraph's boundary port", () => {
    // outer (group) ⊃ inner (subgraph, with a promoted CHARACTER rail) ⊃ sc-01. The wire from
    // Nadia terminates on inner's RAIL; collapsing outer proxies that boundary port.
    const outer = beat("outer", "Outer", { x: 0, y: 0 });
    const railId = boundaryPortId("inner", "sc-01:in:CHARACTER");
    const inner = {
      ...beat("inner", "Inner", { x: 0, y: 0 }),
      parentId: "outer",
      type: SUBGRAPH_TYPE,
      data: { ...beat("inner", "Inner", { x: 0, y: 0 }).data, promotedIn: [{ id: railId, childId: "sc-01", childPortId: "sc-01:in:CHARACTER", type: "ref", label: "CHARACTER" }] },
    } as DirectorNode;
    const leaf = scene("sc-01", "SC-01", { x: 0, y: 0 }, {}, "inner");
    const nadia = asset("char-nadia", "Nadia", "character", { x: 0, y: 0 });
    const outerHalf: ViewEdge = { id: "outer-half", source: "char-nadia", target: "inner", sourceHandle: "char-nadia:out:REF", targetHandle: railId };
    const relay: ViewEdge = { id: "relay", source: "inner", target: "sc-01", sourceHandle: innerHandleId(railId), targetHandle: "sc-01:in:CHARACTER" };
    const proxies = proxyHandlesFor("outer", [nadia, outer, inner, leaf], [outerHalf, relay]);
    expect(proxies).toEqual([{ id: `outer::proxy:${railId}`, childId: "inner", childPortId: railId, side: "in", type: "ref", label: "CHARACTER" }]);
  });

  it("skips a wire whose handle is not a port the child has, or whose direction disagrees", () => {
    const { nodes, edges } = demo();
    const bad: ViewEdge[] = [
      { ...edges[0]!, targetHandle: "sc-01:in:NOPE" },
      // An "input" used as a source: malformed, not a proxy.
      { id: "wrong-way", source: "sc-01", target: "sc-03", sourceHandle: "sc-01:in:CHARACTER", targetHandle: "sc-03:in:IN FRAME" },
    ];
    expect(proxyHandlesFor("beat-1", nodes, bad)).toEqual([]);
  });
});

describe("displayedEdges", () => {
  it("returns the very same array when nothing is collapsed", () => {
    const { nodes, edges } = demo();
    expect(displayedEdges(nodes, edges)).toBe(edges);
  });

  it("re-routes a crossing wire's hidden end to the group's proxy handle and hides the internal one", () => {
    const { nodes, edges } = demo();
    const shown = displayedEdges(nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n)), edges);
    expect(shown).not.toBe(edges);
    expect(shown.map((e) => e.id)).toEqual(edges.map((e) => displayedEdgeId(e.id)));
    const [inbound, internal, outbound] = shown as [ViewEdge, ViewEdge, ViewEdge];
    expect(inbound).toMatchObject({ source: "char-nadia", sourceHandle: "char-nadia:out:REF", target: "beat-1", targetHandle: "beat-1::proxy:sc-01:in:CHARACTER", hidden: false });
    expect(internal.hidden).toBe(true);
    expect(outbound).toMatchObject({ source: "beat-1", sourceHandle: "beat-1::proxy:sc-02:out:LAST FRAME", target: "sc-03", targetHandle: "sc-03:in:IN FRAME", hidden: false });
    // Canonical input untouched.
    expect(edges[0]).toMatchObject({ target: "sc-01", targetHandle: "sc-01:in:CHARACTER" });
    expect(edges.every((e) => !isDisplayedEdgeId(e.id))).toBe(true);
  });

  it("un-hides a wire that state hid because its endpoint is hidden", () => {
    const { nodes, edges } = demo();
    const hiddenInState = edges.map((e) => ({ ...e, hidden: true }));
    const shown = displayedEdges(nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n)), hiddenInState);
    expect(shown[0]?.hidden).toBe(false);
    expect(shown[1]?.hidden).toBe(true);
  });

  it("nested groups: the OUTERMOST collapsed one takes the wire; wires between its descendants are hidden", () => {
    const outer = collapse(beat("outer", "Outer", { x: 0, y: 0 }));
    const inner = collapse({ ...beat("inner", "Inner", { x: 0, y: 0 }), parentId: "outer" } as DirectorNode);
    const deep = scene("sc-01", "SC-01", { x: 0, y: 0 }, {}, "inner");
    const shallow = scene("sc-02", "SC-02", { x: 0, y: 0 }, {}, "outer");
    const outside = scene("sc-03", "SC-03", { x: 0, y: 0 });
    const edges = [link("sc-01", "LAST FRAME", "sc-02", "IN FRAME"), link("sc-02", "LAST FRAME", "sc-03", "IN FRAME"), link("sc-01", "VIDEO", "sc-03", "IN FRAME")];
    const shown = displayedEdges([outer, inner, deep, shallow, outside], edges);
    expect(shown[0]?.hidden).toBe(true);
    expect(shown[1]).toMatchObject({ source: "outer", sourceHandle: "outer::proxy:sc-02:out:LAST FRAME", target: "sc-03" });
    expect(shown[2]).toMatchObject({ source: "outer", sourceHandle: "outer::proxy:sc-01:out:VIDEO", target: "sc-03" });
    // Only the inner one collapsed: the deep wire lands on `inner`, the shallow one is untouched.
    const innerOnly = displayedEdges([{ ...outer, data: { ...outer.data, collapsed: false } } as DirectorNode, inner, deep, shallow, outside], edges);
    expect(innerOnly[0]).toMatchObject({ source: "inner", sourceHandle: "inner::proxy:sc-01:out:LAST FRAME", target: "sc-02", targetHandle: "sc-02:in:IN FRAME" });
    expect(innerOnly[1]).toBe(edges[1]);
  });

  it("a collapsed SUBGRAPH keeps its rails: outer halves untouched, inner relays hidden", () => {
    const railIn = boundaryPortId("beat-1", "sc-01:in:CHARACTER");
    const railOut = boundaryPortId("beat-1", "sc-02:out:LAST FRAME");
    const sub = collapse({ ...beat("beat-1", "Beat 1", { x: 0, y: 0 }), type: SUBGRAPH_TYPE } as DirectorNode);
    const nodes = [asset("char-nadia", "Nadia", "character", { x: 0, y: 0 }), sub, scene("sc-01", "SC-01", { x: 0, y: 0 }, {}, "beat-1"), scene("sc-02", "SC-02", { x: 0, y: 0 }, {}, "beat-1"), scene("sc-03", "SC-03", { x: 0, y: 0 })];
    const edges: ViewEdge[] = [
      { id: "in-outer", source: "char-nadia", target: "beat-1", sourceHandle: "char-nadia:out:REF", targetHandle: railIn },
      { id: "in-relay", source: "beat-1", target: "sc-01", sourceHandle: innerHandleId(railIn), targetHandle: "sc-01:in:CHARACTER" },
      { id: "out-relay", source: "sc-02", target: "beat-1", sourceHandle: "sc-02:out:LAST FRAME", targetHandle: innerHandleId(railOut) },
      { id: "out-outer", source: "beat-1", target: "sc-03", sourceHandle: railOut, targetHandle: "sc-03:in:IN FRAME" },
      link("sc-01", "LAST FRAME", "sc-02", "IN FRAME"),
    ];
    const shown = displayedEdges(nodes, edges);
    expect(shown[0]).toBe(edges[0]);
    expect(shown[3]).toBe(edges[3]);
    expect(shown[1]?.hidden).toBe(true);
    expect(shown[2]?.hidden).toBe(true);
    expect(shown[4]?.hidden).toBe(true);
  });

  it("a subgraph inside a collapsed group: its outer halves re-route to the group's proxy of the rail", () => {
    const railIn = boundaryPortId("inner", "sc-01:in:CHARACTER");
    const outer = collapse(beat("outer", "Outer", { x: 0, y: 0 }));
    // The rail has to be a REAL boundary port on `inner`, the way reconcile leaves it: the
    // projection resolves the handle before proxying it, so a subgraph with an empty
    // `promotedIn` has no rail for the outer group to stand in for.
    const innerBase = beat("inner", "Inner", { x: 0, y: 0 });
    const inner = {
      ...innerBase,
      parentId: "outer",
      type: SUBGRAPH_TYPE,
      data: { ...innerBase.data, promotedIn: [{ id: railIn, childId: "sc-01", childPortId: "sc-01:in:CHARACTER", type: "CHARACTER", label: "Nadia" }] },
    } as DirectorNode;
    const nodes = [asset("char-nadia", "Nadia", "character", { x: 0, y: 0 }), outer, inner, scene("sc-01", "SC-01", { x: 0, y: 0 }, {}, "inner")];
    const edges: ViewEdge[] = [
      { id: "in-outer", source: "char-nadia", target: "inner", sourceHandle: "char-nadia:out:REF", targetHandle: railIn },
      { id: "in-relay", source: "inner", target: "sc-01", sourceHandle: innerHandleId(railIn), targetHandle: "sc-01:in:CHARACTER" },
    ];
    const shown = displayedEdges(nodes, edges);
    expect(shown[0]).toMatchObject({ id: "in-outer@display", source: "char-nadia", target: "outer", targetHandle: `outer::proxy:${railIn}`, hidden: false });
    expect(shown[1]?.hidden).toBe(true);
    // …and `outer` really derives that handle, so the re-route lands on a rendered port.
    expect(proxyHandlesFor("outer", nodes, edges).map((p) => p.id)).toEqual([`outer::proxy:${railIn}`]);
  });

  it("both ends under DIFFERENT collapsed groups: each end takes its own container's proxy", () => {
    const a = collapse(beat("beat-a", "A", { x: 0, y: 0 }));
    const b = collapse(beat("beat-b", "B", { x: 500, y: 0 }));
    const inA = scene("sc-01", "SC-01", { x: 0, y: 0 }, {}, "beat-a");
    const inB = scene("sc-02", "SC-02", { x: 0, y: 0 }, {}, "beat-b");
    const nodes = [a, b, inA, inB];
    const edges = [link("sc-01", "LAST FRAME", "sc-02", "IN FRAME")];
    const shown = displayedEdges(nodes, edges);
    expect(shown[0]).toMatchObject({
      source: "beat-a",
      sourceHandle: "beat-a::proxy:sc-01:out:LAST FRAME",
      target: "beat-b",
      targetHandle: "beat-b::proxy:sc-02:in:IN FRAME",
      hidden: false,
    });
    // …and each container derives exactly the proxy handle that edge was re-routed onto, which
    // is what stops React Flow dropping the wire for a handle the card does not render.
    expect(proxyHandlesFor("beat-a", nodes, edges).map((p) => p.id)).toEqual(["beat-a::proxy:sc-01:out:LAST FRAME"]);
    expect(proxyHandlesFor("beat-b", nodes, edges).map((p) => p.id)).toEqual(["beat-b::proxy:sc-02:in:IN FRAME"]);
  });

  it("every re-routed endpoint names a handle the container actually derives", () => {
    // The pairing that matters: displayedEdges and proxyHandlesFor must agree, or the wire is
    // drawn to a handle that does not exist. Assert it across the whole demo graph.
    const { nodes, edges } = demo();
    const collapsedNodes = nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n));
    const derived = new Set(proxyHandlesFor("beat-1", collapsedNodes, edges).map((p) => p.id));
    for (const e of displayedEdges(collapsedNodes, edges)) {
      if (e.hidden) continue;
      if (e.source === "beat-1") expect(derived, `${e.id} source`).toContain(e.sourceHandle);
      if (e.target === "beat-1") expect(derived, `${e.id} target`).toContain(e.targetHandle);
    }
  });

  it("ids are stable across calls and keep the untouched edge objects", () => {
    const { nodes, edges } = demo();
    const collapsedNodes = nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n));
    const a = displayedEdges(collapsedNodes, edges);
    const b = displayedEdges(collapsedNodes, edges);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    const extra = [...edges, link("sc-03", "LAST FRAME", "sc-04", "IN FRAME")];
    const c = displayedEdges([...collapsedNodes, scene("sc-04", "SC-04", { x: 0, y: 0 })], extra);
    expect(c[3]).toBe(extra[3]);
  });

  it("hides rather than proxies a crossing wire whose handle is not a port the child has", () => {
    // The direction the earlier case leaves open: the handle EXISTS as a string, so the "no
    // handle" guard passes, but `proxyHandlesFor` resolves no port for it and derives nothing.
    // Re-routing there names a handle React Flow cannot find and the wire vanishes.
    const { nodes, edges } = demo();
    const collapsedNodes = nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n));
    const stale: ViewEdge = { ...edges[0]!, id: "stale", targetHandle: "sc-01:in:GONE" };
    // The direction-disagreeing twin: a real port, wired as if it faced the other way.
    const flipped: ViewEdge = { ...edges[0]!, id: "flipped", targetHandle: "sc-01:out:LAST FRAME" };
    const shown = displayedEdges(collapsedNodes, [stale, flipped, edges[2]!]);
    expect(proxyHandlesFor("beat-1", collapsedNodes, [stale, flipped])).toEqual([]);
    expect(shown[0]).toMatchObject({ id: "stale@display", hidden: true });
    expect(shown[1]).toMatchObject({ id: "flipped@display", hidden: true });
    // The control: a well-formed crossing in the same call still proxies, so this is not
    // passing because everything hid.
    expect(shown[2]).toMatchObject({ hidden: false, source: "beat-1", sourceHandle: "beat-1::proxy:sc-02:out:LAST FRAME" });
  });

  it("hides rather than proxies a crossing wire with no handle to stand in for", () => {
    const { nodes, edges } = demo();
    const bare = [{ id: "bare", source: "char-nadia", target: "sc-01" }, ...edges.slice(1)];
    const shown = displayedEdges(nodes.map((n) => (n.id === "beat-1" ? collapse(n) : n)), bare);
    expect(shown[0]).toMatchObject({ id: "bare@display", hidden: true });
  });
});

describe("canonicalEdgeChanges", () => {
  it("maps select and remove changes back to the canonical id, keeps adds, drops a displayed replace", () => {
    const item = { id: "lg:x@display", source: "a", target: "b" };
    const out = canonicalEdgeChanges([
      { type: "select", id: "lg:x@display", selected: true },
      { type: "remove", id: "lg:y@display" },
      { type: "remove", id: "lg:z" },
      { type: "add", item: { id: "lg:new", source: "a", target: "b" } },
      { type: "replace", id: "lg:x@display", item },
      { type: "replace", id: "lg:w", item: { id: "lg:w", source: "a", target: "b" } },
    ]);
    expect(out).toEqual([
      { type: "select", id: "lg:x", selected: true },
      { type: "remove", id: "lg:y" },
      { type: "remove", id: "lg:z" },
      { type: "add", item: { id: "lg:new", source: "a", target: "b" } },
      { type: "replace", id: "lg:w", item: { id: "lg:w", source: "a", target: "b" } },
    ]);
  });
});
