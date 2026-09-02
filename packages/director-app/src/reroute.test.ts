import { describe, expect, it } from "vitest";
import { promoteToSubgraph, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { resolveThroughReroutes } from "./calliope-sync.js";
import { asset, beat, directorHost, scene, type DirectorData, type DirectorPortType, type RerouteData } from "./model.js";
import { REROUTE_SIZE, isRefusal, rejoinReroute, spliceReroute, type SpliceResult } from "./reroute-ops.js";

type N = GraphNode<DirectorData>;

// The editor's own `handleTypes`, small enough to restate: every port on the canvas -> what it
// carries. Restating it is the point — a test that imported DirectorApp would drag React Flow
// into a node runner for no gain.
const typesOf = (nodes: readonly N[]): Map<string, DirectorPortType> => {
  const m = new Map<string, DirectorPortType>();
  for (const n of nodes) if ("ports" in n.data) for (const p of n.data.ports) m.set(p.id, p.type as DirectorPortType);
  return m;
};

const wire = (a: string, ah: string, b: string, bh: string): GraphEdge => ({
  id: `lg:${a}:out:${ah}->${b}:in:${bh}`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:${ah}`,
  targetHandle: `${b}:in:${bh}`,
});

const ok = (r: SpliceResult | { error: string }): SpliceResult => {
  if (isRefusal(r)) throw new Error(`expected a splice, got a refusal: ${r.error}`);
  return r;
};

const s1 = scene("sc-01", "SC-01", { x: 0, y: 0 }, { orderIndex: 0 });
const s2 = scene("sc-02", "SC-02", { x: 400, y: 0 }, { orderIndex: 1 });
const nadia = asset("char-nadia", "Nadia", "character", { x: -300, y: 0 });
const chain = wire("sc-01", "LAST FRAME", "sc-02", "IN FRAME");
const ref = wire("char-nadia", "REF", "sc-01", "CHARACTER");

describe("spliceReroute — a dot ON the wire", () => {
  it("replaces one edge with two, both carrying the wire's own type", () => {
    const out = ok(spliceReroute([nadia, s1, s2], [chain], chain.id, { x: 200, y: 40 }, typesOf([nadia, s1, s2])));
    expect(out.type).toBe("image");
    expect(out.edges).toHaveLength(2);
    expect(out.edges.some((e) => e.id === chain.id)).toBe(false);

    const dot = out.nodes.find((n) => n.id === out.id) as N;
    expect(dot.type).toBe("reroute");
    const d = dot.data as RerouteData;
    expect(d.portType).toBe("image");
    expect(d.ports.map((p) => p.type)).toEqual(["image", "image"]);

    const head = out.edges.find((e) => e.target === out.id);
    const tail = out.edges.find((e) => e.source === out.id);
    expect(head?.source).toBe("sc-01");
    expect(head?.sourceHandle).toBe("sc-01:out:LAST FRAME");
    expect(tail?.target).toBe("sc-02");
    expect(tail?.targetHandle).toBe("sc-02:in:IN FRAME");
    // Ids stay DERIVED, so the same splice always produces the same ids.
    expect(head?.id).toBe(`lg:sc-01:out:LAST FRAME->${out.id}:in:IN`);
    expect(tail?.id).toBe(`lg:${out.id}:out:OUT->sc-02:in:IN FRAME`);
  });

  it("centres the dot on the point it was dropped at", () => {
    const out = ok(spliceReroute([s1, s2], [chain], chain.id, { x: 200, y: 40 }, typesOf([s1, s2])));
    const dot = out.nodes.find((n) => n.id === out.id) as N;
    expect(dot.position).toEqual({ x: 200 - REROUTE_SIZE / 2, y: 40 - REROUTE_SIZE / 2 });
    expect(dot.width).toBe(REROUTE_SIZE);
    expect(dot.height).toBe(REROUTE_SIZE);
  });

  it("names both its ports after the port the wire was heading for, so a rail says what it carries", () => {
    const out = ok(spliceReroute([nadia, s1], [ref], ref.id, { x: -100, y: 20 }, typesOf([nadia, s1])));
    const d = (out.nodes.find((n) => n.id === out.id) as N).data as RerouteData;
    expect(d.ports.map((p) => p.label)).toEqual(["CHARACTER", "CHARACTER"]);
    expect(d.label).toBe("CHARACTER");
    // The ids stay canonical whatever the label says — they are what the edges name.
    expect(d.ports.map((p) => p.id)).toEqual([`${out.id}:in:IN`, `${out.id}:out:OUT`]);
  });

  it("refuses a wire it cannot find, and one whose type nothing reports", () => {
    expect(isRefusal(spliceReroute([s1, s2], [chain], "lg:nope", { x: 0, y: 0 }, typesOf([s1, s2])))).toBe(true);
    expect(isRefusal(spliceReroute([s1, s2], [chain], chain.id, { x: 0, y: 0 }, new Map()))).toBe(true);
  });

  it("joins the Beat it is dropped inside, and its rail is labelled by the wire", () => {
    // SC-02 sits INSIDE the Beat, fed from outside — the crossing the Beat would promote.
    const b = beat("beat-1", "Beat 1", { x: 100, y: -100 }, { width: 400, height: 400 });
    const inside = { ...s2, parentId: "beat-1", position: { x: 40, y: 60 } } as N;
    const nodes = [s1, b, inside];
    const out = ok(spliceReroute(nodes, [chain], chain.id, { x: 200, y: 40 }, typesOf(nodes)));
    const dot = out.nodes.find((n) => n.id === out.id) as N;
    expect(dot.parentId, "the dot lands inside the Beat it was dropped in").toBe("beat-1");

    // Promoting now must produce a rail for the DOT's input, named after the wire rather than
    // the useless "IN" the port would otherwise carry.
    const promoted = promoteToSubgraph("beat-1", out.nodes, out.edges, directorHost);
    const rails = promoted.nodes.find((n) => n.id === "beat-1")?.data as { promotedIn: { label: string; childId: string }[] };
    expect(rails.promotedIn).toHaveLength(1);
    expect(rails.promotedIn[0]?.childId).toBe(out.id);
    expect(rails.promotedIn[0]?.label).toBe("IN FRAME");
  });

  it("refuses to drop into a COLLAPSED Beat, where the dot and its wire would be invisible", () => {
    const b = beat("beat-1", "Beat 1", { x: 100, y: -100 }, { width: 400, height: 400 });
    const shut = { ...b, type: "subgraph", data: { ...b.data, collapsed: true } } as unknown as N;
    const inside = { ...s2, parentId: "beat-1", position: { x: 40, y: 60 } } as N;
    const nodes = [s1, shut, inside];
    const refused = spliceReroute(nodes, [chain], chain.id, { x: 200, y: 40 }, typesOf(nodes));
    expect(isRefusal(refused)).toBe(true);
    if (isRefusal(refused)) expect(refused.error).toMatch(/expand Beat 1 first/);
    // Expanded, the very same drop is fine.
    const open = { ...shut, data: { ...(shut.data as object), collapsed: false } } as N;
    expect(isRefusal(spliceReroute([s1, open, inside], [chain], chain.id, { x: 200, y: 40 }, typesOf(nodes)))).toBe(false);
  });

  it("uniquifies that label against the rails already on the Beat it lands in", () => {
    const b = beat("beat-1", "Beat 1", { x: 100, y: -100 }, { width: 400, height: 400 });
    const withRail = {
      ...b,
      type: "subgraph",
      data: {
        ...b.data,
        promotedIn: [{ id: "beat-1::sc-02:in:IN FRAME", childId: "sc-02", childPortId: "sc-02:in:IN FRAME", type: "image", label: "IN FRAME" }],
        promotedOut: [],
      },
    } as unknown as N;
    const inside = { ...s2, parentId: "beat-1", position: { x: 40, y: 60 } } as N;
    const nodes = [s1, withRail, inside];
    const out = ok(spliceReroute(nodes, [chain], chain.id, { x: 200, y: 40 }, typesOf(nodes)));
    const d = (out.nodes.find((n) => n.id === out.id) as N).data as RerouteData;
    expect(d.label).toBe("IN FRAME.0");
  });

  it("uniquifies against BOTH rails, so an outbound dot cannot collide on the out rail", () => {
    const b = beat("beat-1", "Beat 1", { x: 100, y: -100 }, { width: 400, height: 400 });
    const withOutRail = {
      ...b,
      type: "subgraph",
      data: {
        ...b.data,
        promotedIn: [],
        promotedOut: [{ id: "beat-1::sc-01:out:LAST FRAME", childId: "sc-01", childPortId: "sc-01:out:LAST FRAME", type: "image", label: "IN FRAME" }],
      },
    } as unknown as N;
    const inside = { ...s2, parentId: "beat-1", position: { x: 40, y: 60 } } as N;
    const nodes = [s1, withOutRail, inside];
    const out = ok(spliceReroute(nodes, [chain], chain.id, { x: 200, y: 40 }, typesOf(nodes)));
    expect((out.nodes.find((n) => n.id === out.id)?.data as RerouteData).label).toBe("IN FRAME.0");
  });
});

describe("rejoinReroute — removing a dot restores the direct wire", () => {
  it("splice then remove is the graph you started with", () => {
    const out = ok(spliceReroute([s1, s2], [chain], chain.id, { x: 200, y: 40 }, typesOf([s1, s2])));
    const back = rejoinReroute(out.nodes, out.edges, out.id);
    expect(back).toHaveLength(1);
    expect(back[0]?.id).toBe(chain.id);
    expect(back[0]?.source).toBe("sc-01");
    expect(back[0]?.sourceHandle).toBe("sc-01:out:LAST FRAME");
    expect(back[0]?.target).toBe("sc-02");
    expect(back[0]?.targetHandle).toBe("sc-02:in:IN FRAME");
  });

  it("leaves every other wire alone", () => {
    const nodes = [nadia, s1, s2];
    const out = ok(spliceReroute(nodes, [ref, chain], chain.id, { x: 200, y: 40 }, typesOf(nodes)));
    const back = rejoinReroute(out.nodes, out.edges, out.id);
    expect(back.map((e) => e.id).sort()).toEqual([chain.id, ref.id].sort());
  });

  it("rebuilds ONE direct wire per drain when the dot fanned out", () => {
    const s3 = scene("sc-03", "SC-03", { x: 800, y: 0 }, { orderIndex: 2 });
    const nodes = [s1, s2, s3];
    const out = ok(spliceReroute(nodes, [chain], chain.id, { x: 200, y: 40 }, typesOf(nodes)));
    const alsoS3: GraphEdge = {
      id: `lg:${out.id}:out:OUT->sc-03:in:IN FRAME`,
      source: out.id,
      target: "sc-03",
      sourceHandle: `${out.id}:out:OUT`,
      targetHandle: "sc-03:in:IN FRAME",
    };
    const back = rejoinReroute(out.nodes, [...out.edges, alsoS3], out.id);
    expect(back).toHaveLength(2);
    expect(back.every((e) => e.source === "sc-01" && e.sourceHandle === "sc-01:out:LAST FRAME")).toBe(true);
    expect(back.map((e) => e.target).sort()).toEqual(["sc-02", "sc-03"]);
  });

  it("a dot with nothing feeding it has no wire to rebuild", () => {
    const out = ok(spliceReroute([s1, s2], [chain], chain.id, { x: 200, y: 40 }, typesOf([s1, s2])));
    const orphaned = out.edges.filter((e) => e.target !== out.id);
    expect(rejoinReroute(out.nodes, orphaned, out.id)).toEqual([]);
  });

  it("refuses to rewrite anything when the id is not a dot", () => {
    expect(rejoinReroute([s1, s2], [chain], "sc-01").map((e) => e.id)).toEqual([chain.id]);
    expect(rejoinReroute([s1, s2], [chain], "nope").map((e) => e.id)).toEqual([chain.id]);
  });
});

describe("resolveThroughReroutes — continuity survives the bends", () => {
  const splice = (nodes: N[], edges: GraphEdge[], id: string, at: { x: number; y: number }) =>
    ok(spliceReroute(nodes, edges, id, at, typesOf(nodes)));

  it("sees SC-01 through TWO dots", () => {
    const one = splice([s1, s2], [chain], chain.id, { x: 150, y: 40 });
    const tailId = one.edges.find((e) => e.target === "sc-02")?.id as string;
    const two = splice(one.nodes, one.edges, tailId, { x: 260, y: 40 });

    const resolved = resolveThroughReroutes(two.edges, two.nodes);
    const feed = resolved.find((e) => e.targetHandle === "sc-02:in:IN FRAME");
    expect(feed?.source, "the far end of the chain of dots").toBe("sc-01");
    expect(feed?.sourceHandle).toBe("sc-01:out:LAST FRAME");
    // Three wires in, three out: only their SOURCES are walked, nothing is collapsed away.
    expect(two.edges).toHaveLength(3);
    expect(resolved).toHaveLength(3);
  });

  it("is the identity when there are no dots at all", () => {
    const edges = [ref, chain];
    expect(resolveThroughReroutes(edges, [nadia, s1, s2])).toBe(edges);
  });

  it("drops a wire whose chain of dots reaches nothing", () => {
    const one = splice([s1, s2], [chain], chain.id, { x: 150, y: 40 });
    const dangling = one.edges.filter((e) => e.target !== one.id);
    expect(resolveThroughReroutes(dangling, one.nodes)).toEqual([]);
  });

  it("terminates on dots wired in a ring instead of walking forever", () => {
    const dot = (id: string): N => ({ id, type: "reroute", position: { x: 0, y: 0 }, data: { kind: "reroute", label: "IN", portType: "image", ports: [] } });
    const a = dot("reroute-a");
    const b = dot("reroute-b");
    const loop: GraphEdge[] = [
      { id: "e1", source: "reroute-a", target: "reroute-b", sourceHandle: "reroute-a:out:OUT", targetHandle: "reroute-b:in:IN" },
      { id: "e2", source: "reroute-b", target: "reroute-a", sourceHandle: "reroute-b:out:OUT", targetHandle: "reroute-a:in:IN" },
      { id: "e3", source: "reroute-b", target: "sc-02", sourceHandle: "reroute-b:out:OUT", targetHandle: "sc-02:in:IN FRAME" },
    ];
    expect(resolveThroughReroutes(loop, [a, b, s2])).toEqual([]);
  });
});
