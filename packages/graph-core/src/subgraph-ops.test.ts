import { describe, expect, it } from "vitest";
import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  innerHandleId,
  isRelayHandle,
  type BaseNodeData,
  type BoundaryPort,
  type ContainerNodeData,
  type GraphEdge,
  type GraphNode,
  type GraphOpsHost,
  type PortInfo,
} from "./types.js";
import {
  dissolveSubgraph,
  findPort,
  promoteToSubgraph,
  reconcileBoundary,
  uniquifyLabel,
} from "./subgraph-ops.js";

// ── fixtures ────────────────────────────────────────────────────────────────────────────
//
// Port ids follow the convention the derived boundary id depends on: single colons inside a
// port id, so `::` is unambiguous as the boundary separator.

type TD = BaseNodeData & { ports?: PortInfo[] } & Partial<ContainerNodeData>;
type N = GraphNode<TD>;

const pin = (nodeId: string, name: string, type = "any"): PortInfo => ({
  id: `${nodeId}:in:${name}`,
  type,
  isInput: true,
  label: name,
});
const pout = (nodeId: string, name: string, type = "any"): PortInfo => ({
  id: `${nodeId}:out:${name}`,
  type,
  isInput: false,
  label: name,
});

const node = (id: string, ports: PortInfo[], parentId?: string): N => ({
  id,
  type: "scene",
  position: { x: 0, y: 0 },
  data: { label: id, ports },
  ...(parentId ? { parentId } : {}),
});

const group = (id: string, parentId?: string): N => ({
  id,
  type: GROUP_TYPE,
  position: { x: 0, y: 0 },
  data: { label: id, promotedIn: [], promotedOut: [] },
  ...(parentId ? { parentId } : {}),
});

const edge = (
  id: string,
  source: string,
  target: string,
  sourceHandle: string,
  targetHandle: string,
): GraphEdge => ({ id, source, target, sourceHandle, targetHandle });

const host: GraphOpsHost = {
  portsOf: (n, side) =>
    ((n as unknown as N).data.ports ?? []).filter((p) => (side === "in" ? p.isInput : !p.isInput)),
};

const railsOf = (nodes: readonly N[], id: string): ContainerNodeData => {
  const n = nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}`);
  return n.data as ContainerNodeData;
};

/** external ──> child-inside-group */
function oneCrossingIn() {
  const nodes: N[] = [
    group("g"),
    node("inner", [pin("inner", "A")], "g"),
    node("ext", [pout("ext", "OUT")]),
  ];
  const edges = [edge("e1", "ext", "inner", "ext:out:OUT", "inner:in:A")];
  return { nodes, edges };
}

/** child-inside-group ──> external */
function oneCrossingOut() {
  const nodes: N[] = [
    group("g"),
    node("inner", [pout("inner", "OUT")], "g"),
    node("ext", [pin("ext", "A")]),
  ];
  const edges = [edge("e1", "inner", "ext", "inner:out:OUT", "ext:in:A")];
  return { nodes, edges };
}

// ── promote ─────────────────────────────────────────────────────────────────────────────

describe("promoteToSubgraph", () => {
  it("promotes a group with one inbound crossing, and splits the edge in two", () => {
    const { nodes, edges } = oneCrossingIn();
    const out = promoteToSubgraph("g", nodes, edges, host);

    expect(out.nodes.find((n) => n.id === "g")?.type).toBe(SUBGRAPH_TYPE);
    const rails = railsOf(out.nodes, "g");
    expect(rails.promotedIn).toHaveLength(1);
    expect(rails.promotedOut).toHaveLength(0);

    const bp = rails.promotedIn[0] as BoundaryPort;
    expect(bp.childId).toBe("inner");
    expect(bp.childPortId).toBe("inner:in:A");
    expect(bp.id).toBe("g::inner:in:A");
    expect(bp.label).toBe("A");

    const outer = out.edges.find((e) => e.id === "e1__outer");
    expect(outer).toMatchObject({ source: "ext", target: "g", targetHandle: bp.id });

    const inner = out.edges.find((e) => e.id === `${bp.id}__inneredge`);
    expect(inner).toMatchObject({
      source: "g",
      target: "inner",
      sourceHandle: innerHandleId(bp.id),
      targetHandle: "inner:in:A",
    });
  });

  it("collapses N externals sharing one child port into ONE boundary port with N outer edges", () => {
    const nodes: N[] = [
      group("g"),
      node("inner", [pout("inner", "OUT")], "g"),
      node("a", [pin("a", "A")]),
      node("b", [pin("b", "A")]),
      node("c", [pin("c", "A")]),
    ];
    const edges = [
      edge("e1", "inner", "a", "inner:out:OUT", "a:in:A"),
      edge("e2", "inner", "b", "inner:out:OUT", "b:in:A"),
      edge("e3", "inner", "c", "inner:out:OUT", "c:in:A"),
    ];
    const out = promoteToSubgraph("g", nodes, edges, host);

    const rails = railsOf(out.nodes, "g");
    expect(rails.promotedOut).toHaveLength(1);
    // A source handle broadcasts, so the outer side fans out — but only ONE inner relay,
    // because an input socket takes a single cable.
    expect(out.edges.filter((e) => e.id.endsWith("__outer"))).toHaveLength(3);
    expect(out.edges.filter((e) => e.id.endsWith("__inneredge"))).toHaveLength(1);
  });

  it("passes through edges that do not cross the boundary, preserving order", () => {
    const nodes: N[] = [
      group("g"),
      node("i1", [pout("i1", "O"), pin("i1", "A")], "g"),
      node("i2", [pin("i2", "A")], "g"),
      node("x", [pout("x", "O")]),
      node("y", [pin("y", "A")]),
    ];
    const edges = [
      edge("inside", "i1", "i2", "i1:out:O", "i2:in:A"),
      edge("outside", "x", "y", "x:out:O", "y:in:A"),
    ];
    const out = promoteToSubgraph("g", nodes, edges, host);
    expect(out.edges.map((e) => e.id)).toEqual(["inside", "outside"]);
    expect(railsOf(out.nodes, "g").promotedIn).toHaveLength(0);
  });

  it("numbers duplicate rail labels and leaves a unique one bare", () => {
    const nodes: N[] = [
      group("g"),
      node("p", [pin("p", "REF")], "g"),
      node("q", [pin("q", "REF")], "g"),
      node("r", [pin("r", "SOLO")], "g"),
      node("ext", [pout("ext", "O")]),
    ];
    const edges = [
      edge("e1", "ext", "p", "ext:out:O", "p:in:REF"),
      edge("e2", "ext", "q", "ext:out:O", "q:in:REF"),
      edge("e3", "ext", "r", "ext:out:O", "r:in:SOLO"),
    ];
    const rails = railsOf(promoteToSubgraph("g", nodes, edges, host).nodes, "g");
    expect(rails.promotedIn.map((p) => p.label).sort()).toEqual(["REF.0", "REF.1", "SOLO"]);
  });

  it("skips malformed crossings instead of aborting the conversion", () => {
    const nodes: N[] = [
      group("g"),
      node("inner", [pin("inner", "A")], "g"),
      node("ext", [pout("ext", "O")]),
    ];
    const edges: GraphEdge[] = [
      { id: "nohandles", source: "ext", target: "inner" },
      edge("unknownport", "ext", "inner", "ext:out:O", "inner:in:NOPE"),
      edge("good", "ext", "inner", "ext:out:O", "inner:in:A"),
    ];
    const out = promoteToSubgraph("g", nodes, edges, host);
    expect(railsOf(out.nodes, "g").promotedIn).toHaveLength(1);
    // The two unroutable edges survive untouched rather than vanishing.
    expect(out.edges.map((e) => e.id)).toContain("nohandles");
    expect(out.edges.map((e) => e.id)).toContain("unknownport");
  });

  it("does not mutate the arrays or the node objects it was given", () => {
    const { nodes, edges } = oneCrossingIn();
    const nodesCopy = JSON.parse(JSON.stringify(nodes));
    const edgesCopy = JSON.parse(JSON.stringify(edges));
    promoteToSubgraph("g", nodes, edges, host);
    expect(nodes).toEqual(nodesCopy);
    expect(edges).toEqual(edgesCopy);
  });

  it("refuses a node that is not a container", () => {
    const { nodes, edges } = oneCrossingIn();
    expect(() => promoteToSubgraph("ext", nodes, edges, host)).toThrow(/not a group/);
  });

  it("refuses a node that is already a subgraph", () => {
    const { nodes, edges } = oneCrossingIn();
    const once = promoteToSubgraph("g", nodes, edges, host);
    expect(() => promoteToSubgraph("g", once.nodes, once.edges, host)).toThrow(/already a subgraph/);
  });

  it("refuses a node that does not exist", () => {
    const { nodes, edges } = oneCrossingIn();
    expect(() => promoteToSubgraph("nope", nodes, edges, host)).toThrow(/no node nope/);
  });

  describe("nesting", () => {
    // outer > inner-subgraph > leaf. An edge from the leaf has ALREADY crossed the inner
    // boundary, so by the time the outer container is promoted the only thing it should see
    // is its direct child — the inner subgraph — never the grandchild.
    const nested = () => {
      const base: N[] = [
        group("outer"),
        group("inner", "outer"),
        node("leaf", [pout("leaf", "O")], "inner"),
        node("ext", [pin("ext", "A")]),
      ];
      const promotedInner = promoteToSubgraph(
        "inner",
        base,
        [edge("e1", "leaf", "ext", "leaf:out:O", "ext:in:A")],
        host,
      );
      return promotedInner;
    };

    it("treats the inner subgraph as the direct child, not the grandchild", () => {
      const step1 = nested();
      const step2 = promoteToSubgraph("outer", step1.nodes, step1.edges, host);
      const rails = railsOf(step2.nodes, "outer");
      expect(rails.promotedOut).toHaveLength(1);
      const bp = rails.promotedOut[0] as BoundaryPort;
      expect(bp.childId).toBe("inner");
      expect(bp.childId).not.toBe("leaf");
      // Its label comes from the inner subgraph's own rail, not from the leaf's port.
      expect(bp.childPortId).toBe("inner::leaf:out:O");
    });

    it("gives nested boundary ids distinct prefixes so they cannot collide", () => {
      const step1 = nested();
      const step2 = promoteToSubgraph("outer", step1.nodes, step1.edges, host);
      const innerIds = railsOf(step2.nodes, "inner").promotedOut.map((p) => p.id);
      const outerIds = railsOf(step2.nodes, "outer").promotedOut.map((p) => p.id);
      expect(innerIds).toEqual(["inner::leaf:out:O"]);
      expect(outerIds).toEqual(["outer::inner::leaf:out:O"]);
      expect(new Set([...innerIds, ...outerIds]).size).toBe(2);
    });
  });
});

// ── dissolve ────────────────────────────────────────────────────────────────────────────

describe("dissolveSubgraph", () => {
  it("merges an outer/inner pair back into one direct edge", () => {
    const { nodes, edges } = oneCrossingIn();
    const up = promoteToSubgraph("g", nodes, edges, host);
    const down = dissolveSubgraph("g", up.nodes, up.edges);

    expect(down.nodes.find((n) => n.id === "g")?.type).toBe(GROUP_TYPE);
    expect(railsOf(down.nodes, "g").promotedIn).toHaveLength(0);

    const direct = down.edges.filter((e) => e.source === "ext" && e.target === "inner");
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({
      sourceHandle: "ext:out:OUT",
      targetHandle: "inner:in:A",
    });
    expect(down.edges.some((e) => e.source === "g" || e.target === "g")).toBe(false);
  });

  it("round-trips a fanned-out promoted output back to every direct edge", () => {
    const nodes: N[] = [
      group("g"),
      node("inner", [pout("inner", "OUT")], "g"),
      node("a", [pin("a", "A")]),
      node("b", [pin("b", "A")]),
    ];
    const edges = [
      edge("e1", "inner", "a", "inner:out:OUT", "a:in:A"),
      edge("e2", "inner", "b", "inner:out:OUT", "b:in:A"),
    ];
    const round = dissolveSubgraph("g", ...(() => {
      const up = promoteToSubgraph("g", nodes, edges, host);
      return [up.nodes, up.edges] as const;
    })());

    const pairs = round.edges
      .filter((e) => e.source === "inner")
      .map((e) => `${e.sourceHandle}->${e.target}:${e.targetHandle}`)
      .sort();
    expect(pairs).toEqual([
      "inner:out:OUT->a:a:in:A",
      "inner:out:OUT->b:b:in:A",
    ]);
  });

  it("keeps untouched edges and the container's own visual state", () => {
    const nodes: N[] = [
      { ...group("g"), data: { label: "g", promotedIn: [], promotedOut: [], color: "#abc", width: 640, collapsed: true } },
      node("inner", [pin("inner", "A")], "g"),
      node("ext", [pout("ext", "O")]),
      node("x", [pout("x", "O")]),
      node("y", [pin("y", "A")]),
    ];
    const edges = [
      edge("cross", "ext", "inner", "ext:out:O", "inner:in:A"),
      edge("outside", "x", "y", "x:out:O", "y:in:A"),
    ];
    const up = promoteToSubgraph("g", nodes, edges, host);
    const down = dissolveSubgraph("g", up.nodes, up.edges);
    const data = railsOf(down.nodes, "g");
    expect(data.color).toBe("#abc");
    expect(data.width).toBe(640);
    expect(data.collapsed).toBe(true);
    expect(down.edges.map((e) => e.id)).toContain("outside");
  });

  it("produces a STABLE merged edge id across repeated promote/dissolve cycles", () => {
    // The reason the merged id is endpoint-derived rather than suffixed: reconcile dissolves
    // and re-promotes on every parent change, so a suffix would chain without bound.
    const { nodes, edges } = oneCrossingIn();
    let n: N[] = nodes;
    let e: GraphEdge[] = edges;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const up = promoteToSubgraph("g", n, e, host);
      const down = dissolveSubgraph("g", up.nodes, up.edges);
      n = down.nodes;
      e = down.edges;
      ids.push(e.filter((x) => x.source === "ext").map((x) => x.id).join(","));
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toMatch(/__merged|__outer/);
  });

  it("produces a STABLE merged edge id for an OUTBOUND crossing too", () => {
    // The two merge directions are separate code paths. Testing only the inbound one leaves
    // the outbound `lg:` id free to regress into suffix-chaining unnoticed.
    const { nodes, edges } = oneCrossingOut();
    let n: N[] = nodes;
    let e: GraphEdge[] = edges;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const up = promoteToSubgraph("g", n, e, host);
      const down = dissolveSubgraph("g", up.nodes, up.edges);
      n = down.nodes;
      e = down.edges;
      ids.push(e.filter((x) => x.target === "ext").map((x) => x.id).join(","));
    }
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toMatch(/__merged|__outer/);
  });

  it("refuses a plain group", () => {
    const { nodes, edges } = oneCrossingIn();
    expect(() => dissolveSubgraph("g", nodes, edges)).toThrow(/not a subgraph/);
  });
});

// ── reconcile ───────────────────────────────────────────────────────────────────────────

describe("reconcileBoundary", () => {
  /** g holds `inner`; `ext` sits outside and feeds it. Promoted. */
  const promoted = () => {
    const { nodes, edges } = oneCrossingIn();
    return promoteToSubgraph("g", nodes, edges, host);
  };

  it("is a no-op on a plain group", () => {
    const { nodes, edges } = oneCrossingIn();
    const out = reconcileBoundary("g", nodes, edges, host);
    expect(out.nodes).toEqual(nodes);
    expect(out.edges).toEqual(edges);
  });

  it("drops the rail when the external node is dragged INSIDE", () => {
    const before = promoted();
    expect(railsOf(before.nodes, "g").promotedIn).toHaveLength(1);

    // ext joins the subgraph — its wire no longer crosses anything.
    const moved = before.nodes.map((n) => (n.id === "ext" ? { ...n, parentId: "g" } : n));
    const after = reconcileBoundary("g", moved, before.edges, host);

    expect(railsOf(after.nodes, "g").promotedIn).toHaveLength(0);
    const direct = after.edges.filter((e) => e.source === "ext" && e.target === "inner");
    expect(direct).toHaveLength(1);
  });

  it("creates a rail when a wired node is dragged OUT", () => {
    const nodes: N[] = [
      group("g"),
      node("inner", [pin("inner", "A")], "g"),
      node("ext", [pout("ext", "O")], "g"),
    ];
    const edges = [edge("e1", "ext", "inner", "ext:out:O", "inner:in:A")];
    const up = promoteToSubgraph("g", nodes, edges, host);
    expect(railsOf(up.nodes, "g").promotedIn).toHaveLength(0);

    const moved = up.nodes.map((n) => (n.id === "ext" ? { ...n, parentId: undefined } : n));
    const after = reconcileBoundary("g", moved, up.edges, host);
    expect(railsOf(after.nodes, "g").promotedIn).toHaveLength(1);
  });

  it("preserves a renamed rail label, matched by derived id", () => {
    const before = promoted();
    const renamed = before.nodes.map((n) =>
      n.id === "g"
        ? {
            ...n,
            data: {
              ...n.data,
              promotedIn: (n.data as ContainerNodeData).promotedIn.map((p) => ({
                ...p,
                label: "Hero close-up",
              })),
            },
          }
        : n,
    );
    const after = reconcileBoundary("g", renamed, before.edges, host);
    expect(railsOf(after.nodes, "g").promotedIn[0]?.label).toBe("Hero close-up");
  });

  it("preserves blueprint linkage", () => {
    const before = promoted();
    const tagged = before.nodes.map((n) =>
      n.id === "g" ? { ...n, data: { ...n.data, blueprintId: "bp-7", blueprintVersion: 3 } } : n,
    );
    const after = reconcileBoundary("g", tagged, before.edges, host);
    const rails = railsOf(after.nodes, "g");
    expect(rails.blueprintId).toBe("bp-7");
    expect(rails.blueprintVersion).toBe(3);
  });

  it("prunes a rail whose external wire was removed", () => {
    const before = promoted();
    const withoutOuter = before.edges.filter((e) => !e.id.endsWith("__outer"));
    const after = reconcileBoundary("g", before.nodes, withoutOuter, host);
    expect(railsOf(after.nodes, "g").promotedIn).toHaveLength(0);
  });

  it("KEEPS a pinned rail whose external wire was removed", () => {
    const before = promoted();
    const pinned = before.nodes.map((n) =>
      n.id === "g"
        ? {
            ...n,
            data: {
              ...n.data,
              promotedIn: (n.data as ContainerNodeData).promotedIn.map((p) => ({ ...p, forced: true })),
            },
          }
        : n,
    );
    const withoutOuter = before.edges.filter((e) => !e.id.endsWith("__outer"));
    const after = reconcileBoundary("g", pinned, withoutOuter, host);

    const rails = railsOf(after.nodes, "g");
    expect(rails.promotedIn).toHaveLength(1);
    expect(rails.promotedIn[0]?.forced).toBe(true);
    // Its inner relay is rebuilt, or the pinned rail would have nothing to connect to.
    expect(after.edges.some((e) => e.id === `${rails.promotedIn[0]?.id}__inneredge`)).toBe(true);
  });

  it("DROPS a pinned rail once its child leaves the subgraph", () => {
    // Membership, not mere existence. A rail pointing at a node that is no longer inside is a
    // stale contract, pinned or not.
    const before = promoted();
    const pinned = before.nodes.map((n) =>
      n.id === "g"
        ? {
            ...n,
            data: {
              ...n.data,
              promotedIn: (n.data as ContainerNodeData).promotedIn.map((p) => ({ ...p, forced: true })),
            },
          }
        : n,
    );
    const evicted = pinned.map((n) => (n.id === "inner" ? { ...n, parentId: undefined } : n));
    const after = reconcileBoundary("g", evicted, before.edges, host);
    expect(railsOf(after.nodes, "g").promotedIn).toHaveLength(0);
  });

  it("sorts a brand-new rail to the BOTTOM and leaves existing order alone", () => {
    const nodes: N[] = [
      group("g"),
      node("first", [pin("first", "A")], "g"),
      node("second", [pin("second", "B")], "g"),
      node("ext", [pout("ext", "O")]),
    ];
    const up = promoteToSubgraph(
      "g",
      nodes,
      [edge("e1", "ext", "second", "ext:out:O", "second:in:B")],
      host,
    );
    expect(railsOf(up.nodes, "g").promotedIn.map((p) => p.childId)).toEqual(["second"]);

    const withNew = [...up.edges, edge("e2", "ext", "first", "ext:out:O", "first:in:A")];
    const after = reconcileBoundary("g", up.nodes, withNew, host);
    // "second" existed already, so it stays first even though "first" scans earlier.
    expect(railsOf(after.nodes, "g").promotedIn.map((p) => p.childId)).toEqual(["second", "first"]);
  });

  it("is IDEMPOTENT — reconciling twice changes nothing", () => {
    // The property the derived-id design exists to provide. If this fails, rails churn on
    // every drag and user labels cannot survive.
    const before = promoted();
    const once = reconcileBoundary("g", before.nodes, before.edges, host);
    const twice = reconcileBoundary("g", once.nodes, once.edges, host);

    expect(railsOf(twice.nodes, "g")).toEqual(railsOf(once.nodes, "g"));
    const ids = (r: { edges: GraphEdge[] }) => r.edges.map((e) => e.id).sort();
    expect(ids(twice)).toEqual(ids(once));
  });
});

// ── handles ─────────────────────────────────────────────────────────────────────────────

describe("isRelayHandle / findPort", () => {
  it("tells an inner relay handle from an ordinary one", () => {
    expect(isRelayHandle("g::inner:in:A__inner")).toBe(true);
    expect(isRelayHandle("g::inner:in:A")).toBe(false);
    expect(isRelayHandle("inner:in:A")).toBe(false);
    expect(isRelayHandle(null)).toBe(false);
    expect(isRelayHandle(undefined)).toBe(false);
  });

  const resolverFor = (nodes: readonly N[]) => {
    const map = new Map<string, PortInfo>();
    for (const n of nodes) for (const p of n.data.ports ?? []) map.set(p.id, p);
    return map;
  };

  it("returns a real port straight from the resolver", () => {
    const { nodes } = oneCrossingIn();
    const got = findPort("inner:in:A", nodes, resolverFor(nodes));
    expect(got).toMatchObject({ isInput: true, isRelay: false });
    expect(got?.port?.id).toBe("inner:in:A");
  });

  it("resolves an OUTER promotedIn handle as an input, non-relay", () => {
    const up = promoted();
    const bp = railsOf(up.nodes, "g").promotedIn[0] as BoundaryPort;
    const got = findPort(bp.id, up.nodes, resolverFor(up.nodes));
    expect(got).toMatchObject({ isInput: true, isRelay: false });
    expect(got?.port?.id).toBe("inner:in:A");
  });

  it("resolves the INNER promotedIn handle to the same child port, but inverted and relay", () => {
    const up = promoted();
    const bp = railsOf(up.nodes, "g").promotedIn[0] as BoundaryPort;
    const got = findPort(innerHandleId(bp.id), up.nodes, resolverFor(up.nodes));
    expect(got).toMatchObject({ isInput: false, isRelay: true });
    expect(got?.port?.id).toBe("inner:in:A");
  });

  it("resolves promotedOut symmetrically — outer is a source, inner is a target", () => {
    const { nodes, edges } = oneCrossingOut();
    const up = promoteToSubgraph("g", nodes, edges, host);
    const bp = railsOf(up.nodes, "g").promotedOut[0] as BoundaryPort;
    const resolver = resolverFor(up.nodes);
    expect(findPort(bp.id, up.nodes, resolver)).toMatchObject({ isInput: false, isRelay: false });
    expect(findPort(innerHandleId(bp.id), up.nodes, resolver)).toMatchObject({
      isInput: true,
      isRelay: true,
    });
  });

  it("returns undefined for an unknown handle", () => {
    const { nodes } = oneCrossingIn();
    expect(findPort("nope", nodes, resolverFor(nodes))).toBeUndefined();
    expect(findPort(null, nodes, resolverFor(nodes))).toBeUndefined();
  });

  it("still reports the boundary when the child port has gone missing", () => {
    // The rail is real even if what it aliases is not — callers need the type and direction
    // to render it, and `port: undefined` is how they learn it is dangling.
    const up = promoted();
    const bp = railsOf(up.nodes, "g").promotedIn[0] as BoundaryPort;
    const got = findPort(bp.id, up.nodes, new Map());
    expect(got).toMatchObject({ isInput: true, isRelay: false });
    expect(got?.port).toBeUndefined();
  });

  function promoted() {
    const { nodes, edges } = oneCrossingIn();
    return promoteToSubgraph("g", nodes, edges, host);
  }
});

// ── labels ──────────────────────────────────────────────────────────────────────────────

describe("uniquifyLabel", () => {
  it("keeps a free label as-is", () => {
    expect(uniquifyLabel("Hero", new Set())).toBe("Hero");
  });
  it("finds the smallest free suffix", () => {
    expect(uniquifyLabel("Hero", new Set(["Hero", "Hero.0"]))).toBe("Hero.1");
  });
  it("renumbers from the base rather than stacking suffixes", () => {
    expect(uniquifyLabel("Hero.3", new Set(["Hero.3"]))).toBe("Hero.0");
  });
});
