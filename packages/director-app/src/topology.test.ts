import { beforeEach, describe, expect, it } from "vitest";
import { GROUP_TYPE, SUBGRAPH_TYPE, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { applyTopology, captureTopology, loadTopology, saveTopology, topologyKey } from "./topology.js";
import { beat, directorHost, scene, type BeatData, type DirectorData } from "./model.js";

type N = GraphNode<DirectorData>;
const chain = (a: string, b: string): GraphEdge => ({ id: `lg:${a}:out:LAST FRAME->${b}:in:IN FRAME`, source: a, target: b, sourceHandle: `${a}:out:LAST FRAME`, targetHandle: `${b}:in:IN FRAME` });

class MemoryStorage {
  private m = new Map<string, string>();
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

describe("topology sidecar", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  const b1: N = beat("cal-beat-1", "Beat 1", { x: 300, y: 40 });
  const b2: N = beat("cal-beat-2", "Beat 2", { x: 900, y: 40 });
  const s1: N = scene("cal-sc-1", "SC-01", { x: 40, y: 60 }, {}, "cal-beat-1");
  const s2: N = scene("cal-sc-2", "SC-02", { x: 40, y: 60 }, {}, "cal-beat-2");
  const edges = [chain("cal-sc-1", "cal-sc-2")];

  it("captures only Calliope-backed Beats — a local Beat has no row to be keyed on", () => {
    const local = beat("beat-x1", "Scratch", { x: 0, y: 0 });
    const topo = captureTopology([b1, local, s1]);
    expect(Object.keys(topo.beats)).toEqual(["cal-beat-1"]);
    expect(topo.beats["cal-beat-1"]).toMatchObject({ subgraph: false, position: { x: 300, y: 40 }, railLabels: {} });
  });

  it("round-trips a promoted, coloured, collapsed Beat with a renamed rail through the algebra", () => {
    // Promote beat 2 for real, then rename the rail the continuity wire produced.
    const promoted = applyTopology([b1, b2, s1, s2], edges, { version: 1, beats: { "cal-beat-2": { subgraph: true, position: { x: 900, y: 40 }, railLabels: {} } } }, directorHost);
    const sg = promoted.nodes.find((n) => n.id === "cal-beat-2")!;
    expect(sg.type).toBe(SUBGRAPH_TYPE);
    const rail = (sg.data as BeatData).promotedIn[0]!;
    expect(rail).toBeDefined();
    const renamed = promoted.nodes.map((n) => (n.id === "cal-beat-2" ? ({ ...n, data: { ...n.data, color: "#3b82f6", collapsed: true, promotedIn: [{ ...rail, label: "handoff" }] } } as N) : n));

    const topo = captureTopology(renamed);
    expect(topo.beats["cal-beat-2"]).toMatchObject({ subgraph: true, color: "#3b82f6", collapsed: true, railLabels: { [rail.id]: "handoff" } });

    // Apply it to a FRESH projection (plain groups again) and get the same shape back.
    const again = applyTopology([b1, b2, s1, s2], edges, topo, directorHost);
    const sg2 = again.nodes.find((n) => n.id === "cal-beat-2")!;
    expect(sg2.type).toBe(SUBGRAPH_TYPE);
    expect((sg2.data as BeatData).color).toBe("#3b82f6");
    expect((sg2.data as BeatData).collapsed).toBe(true);
    expect(again.railLabels).toEqual({ "cal-beat-2": { [rail.id]: "handoff" } });
    expect(again.nodes.find((n) => n.id === "cal-beat-1")!.type).toBe(GROUP_TYPE);
  });

  it("a collapsed Beat is stored by its EXPANDED box and comes back sizing its own card", () => {
    // Collapsed on the canvas: node size is the card's (auto → none), expanded box stashed in data.
    const collapsed = { ...b1, width: undefined, height: undefined, data: { ...b1.data, collapsed: true, expandedWidth: 559, expandedHeight: 358 } } as N;
    const topo = captureTopology([collapsed]);
    expect(topo.beats["cal-beat-1"]).toMatchObject({ collapsed: true, width: 559, height: 358 });

    const fresh = beat("cal-beat-1", "Beat 1", { x: 0, y: 0 }, { width: 460, height: 280 }); // projectToGraph's default box
    const out = applyTopology([fresh], [], topo, directorHost).nodes[0]!;
    expect(out.width).toBeUndefined();
    expect(out.height).toBeUndefined();
    expect((out.data as BeatData).collapsed).toBe(true);
    expect((out.data as BeatData).expandedWidth).toBe(559);
    expect((out.data as BeatData).expandedHeight).toBe(358);

    // Resized while collapsed: that size is the card's and is applied as the node size.
    const resized = { ...collapsed, width: 300, height: 120, data: { ...collapsed.data, collapsedWidth: 300, collapsedHeight: 120 } } as N;
    const topo2 = captureTopology([resized]);
    const out2 = applyTopology([fresh], [], topo2, directorHost).nodes[0]!;
    expect([out2.width, out2.height]).toEqual([300, 120]);
  });

  it("a sidecar naming a Beat that no longer exists is ignored, not applied to thin air", () => {
    const out = applyTopology([b1, s1], [], { version: 1, beats: { "cal-beat-9": { subgraph: true, position: { x: 1, y: 1 }, railLabels: {} } } }, directorHost);
    expect(out.nodes.map((n) => n.id)).toEqual(["cal-beat-1", "cal-sc-1"]);
    expect(out.railLabels).toEqual({});
  });

  it("stores per project and survives a bad store", () => {
    saveTopology(1, { version: 1, beats: { "cal-beat-1": { subgraph: false, position: { x: 1, y: 2 }, railLabels: {} } } });
    expect(loadTopology(1)?.beats["cal-beat-1"]?.position).toEqual({ x: 1, y: 2 });
    expect(loadTopology(2)).toBeNull();
    (globalThis.localStorage as unknown as MemoryStorage).setItem(topologyKey(3), "{not json");
    expect(loadTopology(3)).toBeNull();
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
    expect(() => saveTopology(1, { version: 1, beats: {} })).not.toThrow();
    expect(loadTopology(1)).toBeNull();
  });
});
