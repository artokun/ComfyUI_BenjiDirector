import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROUP_TYPE, SUBGRAPH_TYPE, boundaryPortId, promoteToSubgraph, reconcileBoundary, type BoundaryPort, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { asset, beat, demoProject, directorHost, scene, type BeatData, type DirectorData, type SceneData } from "./model.js";
import {
  GRAPH_KEY,
  SAVES_KEY,
  createAutosaver,
  deserializeGraph,
  exportFileName,
  loadAutosave,
  loadSaves,
  serializeGraph,
  writeAutosave,
  writeSaves,
} from "./persistence.js";

type N = GraphNode<DirectorData>;

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

const chain = (a: string, b: string): GraphEdge => ({
  id: `lg:${a}:out:LAST FRAME->${b}:in:IN FRAME`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:LAST FRAME`,
  targetHandle: `${b}:in:IN FRAME`,
});
const ref = (a: string, b: string): GraphEdge => ({
  id: `lg:${a}:out:REF->${b}:in:CHARACTER`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:REF`,
  targetHandle: `${b}:in:CHARACTER`,
});

/** A Beat promoted for real, with one rail renamed and one PINNED rail that no wire produced. */
function promotedFixture(): { nodes: N[]; edges: GraphEdge[]; renamedId: string; forcedId: string } {
  const nodes: N[] = [
    asset("char-nadia", "Nadia", "character", { x: 0, y: 0 }),
    beat("beat-1", "Beat 1", { x: 300, y: 40 }),
    scene("sc-01", "SC-01", { x: 40, y: 60 }, {}, "beat-1"),
    scene("sc-02", "SC-02", { x: 40, y: 220 }, {}, "beat-1"),
    scene("sc-03", "SC-03", { x: 900, y: 300 }),
  ];
  const edges = [ref("char-nadia", "sc-01"), chain("sc-01", "sc-02"), chain("sc-02", "sc-03")];
  const out = promoteToSubgraph("beat-1", nodes, edges, directorHost);
  let ns = out.nodes as N[];
  const rails = ns.find((n) => n.id === "beat-1")!.data as BeatData;
  const renamedId = rails.promotedOut[0]!.id;
  // A pinned rail authored from the `+` slot: it exists because a hand put it there, with no
  // crossing wire to re-derive it from. This is the one a round-trip must not lose.
  const forcedId = boundaryPortId("beat-1", "sc-02:out:VIDEO");
  const forced: BoundaryPort = { id: forcedId, childId: "sc-02", childPortId: "sc-02:out:VIDEO", type: "video", label: "the take", forced: true };
  ns = ns.map((n) =>
    n.id !== "beat-1"
      ? n
      : ({
          ...n,
          data: {
            ...n.data,
            promotedOut: [...rails.promotedOut.map((p) => (p.id === renamedId ? { ...p, label: "handoff" } : p)), forced],
          },
        } as N),
  );
  return { nodes: ns, edges: out.edges, renamedId, forcedId };
}

describe("persistence — the saved graph", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it("round-trips a promoted Beat with a renamed rail and a pinned one that no wire made", () => {
    const { nodes, edges, renamedId, forcedId } = promotedFixture();
    const back = deserializeGraph(JSON.stringify(serializeGraph(nodes, edges)));

    const sg = back.nodes.find((n) => n.id === "beat-1")!;
    expect(sg.type).toBe(SUBGRAPH_TYPE);
    const rails = sg.data as BeatData;
    expect(rails.promotedOut.find((p) => p.id === renamedId)?.label).toBe("handoff");
    const pinned = rails.promotedOut.find((p) => p.id === forcedId);
    expect(pinned).toMatchObject({ label: "the take", forced: true, childId: "sc-02", childPortId: "sc-02:out:VIDEO" });

    // The real test of a rail round-trip: settle reconciles every subgraph, so the restored
    // rails have to survive that too — a pin with no wire is exactly what reconcile would drop
    // if the `forced` flag had not come back.
    const settled = reconcileBoundary("beat-1", back.nodes, back.edges, directorHost);
    const after = settled.nodes.find((n) => n.id === "beat-1")!.data as BeatData;
    expect(after.promotedOut.find((p) => p.id === renamedId)?.label).toBe("handoff");
    expect(after.promotedOut.find((p) => p.id === forcedId)).toMatchObject({ label: "the take", forced: true });

    // Parenting and wiring survive whole.
    expect(back.nodes.filter((n) => n.parentId === "beat-1").map((n) => n.id).sort()).toEqual(["sc-01", "sc-02"]);
    expect(back.edges.length).toBe(edges.length);
  });

  it("keeps the demo graph identical across a round trip", () => {
    const p = demoProject();
    const once = serializeGraph(p.nodes, p.edges);
    const back = deserializeGraph(JSON.stringify(once));
    expect(serializeGraph(back.nodes, back.edges)).toEqual(once);
    expect(back.nodes.find((n) => n.id === "beat-1")!.type).toBe(GROUP_TYPE);
  });

  it("strips what settle derives, and rebuilds ports from the node's own id", () => {
    const decorated: N[] = [
      { ...scene("sc-01", "SC-01", { x: 0, y: 0 }), data: { ...(scene("sc-01", "SC-01", { x: 0, y: 0 }).data as SceneData), inSubgraph: true, renderStatus: "rendering" } } as N,
      { ...beat("beat-1", "Beat 1", { x: 0, y: 0 }), data: { ...(beat("beat-1", "Beat 1", { x: 0, y: 0 }).data as BeatData), faces: [{ id: "sc-01", kind: "scene", label: "SC-01" }] } } as N,
    ];
    const saved = serializeGraph(decorated, []);
    const sc = saved.nodes.find((n) => n.id === "sc-01")!;
    expect("inSubgraph" in sc.data).toBe(false);
    expect("renderStatus" in sc.data).toBe(false);
    expect("faces" in saved.nodes.find((n) => n.id === "beat-1")!.data).toBe(false);

    // A file whose ports name another node still deserialises into a WIRABLE node: the ports
    // come from the kind and the id, never from the bytes.
    const tampered = JSON.parse(JSON.stringify(saved)) as typeof saved;
    (tampered.nodes[0]!.data as SceneData).ports = [{ id: "somewhere-else:in:PROMPT", type: "text", isInput: true, label: "PROMPT" }];
    const back = deserializeGraph(tampered);
    expect((back.nodes[0]!.data as SceneData).ports.map((p) => p.id)).toContain("sc-01:in:PROMPT");
  });

  it("refuses bad JSON, and says which node or wire is wrong", () => {
    expect(() => deserializeGraph("{not json")).toThrow(/not JSON/);
    expect(() => deserializeGraph("[]")).toThrow(/a saved graph is an object/);
    expect(() => deserializeGraph(JSON.stringify({ nodes: [], edges: [] }))).toThrow(/unsupported save version/);
    expect(() => deserializeGraph(JSON.stringify({ version: 1, nodes: {} }))).toThrow(/nodes must be an array/);

    const ok = serializeGraph(demoProject().nodes, demoProject().edges);
    const bend = (fn: (g: typeof ok) => void) => {
      const g = JSON.parse(JSON.stringify(ok)) as typeof ok;
      fn(g);
      return () => deserializeGraph(g);
    };
    expect(bend((g) => (g.nodes[3]!.parentId = "beat-nope"))).toThrow(/parentId "beat-nope" does not resolve/);
    expect(bend((g) => ((g.nodes[3]!.data as SceneData).kind = "spaceship" as never))).toThrow(/data\.kind must be one of/);
    expect(bend((g) => (g.nodes[3]!.position = { x: 1, y: Number.NaN }))).toThrow(/position must be/);
    expect(bend((g) => (g.edges[0]!.target = "sc-99"))).toThrow(/is not a node in this graph/);
    // A handle that names a node other than its own endpoint would never attach.
    expect(bend((g) => (g.edges[0]!.sourceHandle = "char-nobody:out:REF"))).toThrow(/is not on node/);
    expect(bend((g) => (g.nodes[1] = { ...g.nodes[1]!, id: g.nodes[0]!.id }))).toThrow(/duplicate node id/);
  });

  it("refuses a BoundaryPort whose id is not a derived boundary id", () => {
    const { nodes, edges } = promotedFixture();
    const saved = JSON.parse(JSON.stringify(serializeGraph(nodes, edges))) as ReturnType<typeof serializeGraph>;
    const rails = saved.nodes.find((n) => n.id === "beat-1")!.data as BeatData;
    const bad = JSON.parse(JSON.stringify(saved)) as typeof saved;
    ((bad.nodes.find((n) => n.id === "beat-1")!.data as BeatData).promotedOut[0]!.id as string) = "sc-02:out:VIDEO";
    expect(() => deserializeGraph(bad)).toThrow(/no boundary id/);

    const stolen = JSON.parse(JSON.stringify(saved)) as typeof saved;
    (stolen.nodes.find((n) => n.id === "beat-1")!.data as BeatData).promotedOut[0]!.id = boundaryPortId("beat-2", "sc-02:out:VIDEO");
    expect(() => deserializeGraph(stolen)).toThrow(/belongs to another Beat/);
    expect(rails.promotedOut.length).toBeGreaterThan(0);
  });

  it("a cycle in the Beat nesting is refused rather than rendered", () => {
    const g = {
      version: 1,
      nodes: [
        { id: "b1", type: GROUP_TYPE, parentId: "b2", position: { x: 0, y: 0 }, data: { kind: "beat", label: "b1", promotedIn: [], promotedOut: [] } },
        { id: "b2", type: GROUP_TYPE, parentId: "b1", position: { x: 0, y: 0 }, data: { kind: "beat", label: "b2", promotedIn: [], promotedOut: [] } },
      ],
      edges: [],
    };
    expect(() => deserializeGraph(g)).toThrow(/cycle/);
  });

  it("named saves and the working graph live in their own keys, and a corrupt one is ignored", () => {
    const store = globalThis.localStorage as unknown as MemoryStorage;
    const g = serializeGraph(demoProject().nodes, demoProject().edges);
    writeSaves({ mine: { ...g, savedAt: 1 } });
    expect(Object.keys(loadSaves())).toEqual(["mine"]);
    expect(store.getItem(SAVES_KEY)).toBeTruthy();

    writeAutosave(JSON.stringify(g));
    expect(store.getItem(GRAPH_KEY)).toBeTruthy();
    expect(loadAutosave()?.nodes.length).toBe(g.nodes.length);

    store.setItem(GRAPH_KEY, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(loadAutosave()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    store.setItem(SAVES_KEY, "[]");
    expect(loadSaves()).toEqual({});
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(() => writeAutosave("{}")).not.toThrow();
    expect(loadAutosave()).toBeNull();
  });

  it("names an export file by the moment it was made", () => {
    expect(exportFileName(new Date("2026-09-01T12:34:56.000Z"))).toBe("benjidirector-graph-2026-09-01-12-34-56.json");
  });
});

describe("persistence — autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const rig = () => {
    const written: string[] = [];
    let n = 0;
    const ctl = createAutosaver({ read: () => Promise.resolve(`graph-${++n}`), write: (json) => written.push(json), debounceMs: 600 });
    return { ctl, written };
  };

  it("debounces: many changes, one write", async () => {
    const { ctl, written } = rig();
    ctl.setProject(null);
    ctl.arm();
    for (let i = 0; i < 5; i++) ctl.changed();
    await vi.advanceTimersByTimeAsync(500);
    expect(written).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(written).toEqual(["graph-1"]);
  });

  it("writes ONLY while no Calliope project is loaded", async () => {
    const { ctl, written } = rig();
    ctl.setProject(7);
    ctl.arm();
    ctl.changed();
    await vi.advanceTimersByTimeAsync(2000);
    ctl.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(written, "a loaded project round-trips through its rows, not the local slot").toEqual([]);

    // Closing the project makes the canvas local again — and the write resumes.
    ctl.setProject(null);
    ctl.arm();
    ctl.changed();
    await vi.advanceTimersByTimeAsync(700);
    expect(written).toEqual(["graph-1"]);
  });

  it("a project OPENING mid-flight cancels the pending write", async () => {
    const { ctl, written } = rig();
    ctl.setProject(null);
    ctl.arm();
    ctl.changed();
    await vi.advanceTimersByTimeAsync(300);
    ctl.setProject(12);
    await vi.advanceTimersByTimeAsync(2000);
    expect(written).toEqual([]);
  });

  it("ignores changes until armed — the load itself is not an edit", async () => {
    const { ctl, written } = rig();
    ctl.setProject(null);
    ctl.changed();
    await vi.advanceTimersByTimeAsync(2000);
    expect(written).toEqual([]);
    ctl.arm();
    ctl.changed();
    await vi.advanceTimersByTimeAsync(700);
    expect(written).toEqual(["graph-1"]);
  });

  it("flush writes what is pending now, and dispose drops it", async () => {
    const { ctl, written } = rig();
    ctl.setProject(null);
    ctl.arm();
    ctl.changed();
    ctl.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual(["graph-1"]);
    // Nothing pending: a second flush is a no-op, not a duplicate write.
    ctl.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual(["graph-1"]);

    ctl.changed();
    ctl.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    ctl.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(written).toEqual(["graph-1"]);
  });
});
