import { describe, expect, it } from "vitest";
import { SUBGRAPH_TYPE, promoteToSubgraph, reconcileBoundary, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { clipAnchor, copySelection, duplicateNodes, pasteClip, remapHandle } from "./clipboard.js";
import { demoProject, directorHost, scene, type BeatData, type DirectorData, type SceneData } from "./model.js";

type N = GraphNode<DirectorData> & { selected?: boolean };

/** The demo with beat-1 promoted — sc-01/sc-02 inside, rails for Nadia's REF, the rooftop, and LAST FRAME → sc-03. */
function promotedDemo(): { nodes: N[]; edges: GraphEdge[] } {
  const p = demoProject();
  const out = promoteToSubgraph("beat-1", p.nodes, p.edges, directorHost);
  return { nodes: out.nodes as N[], edges: out.edges };
}

const select = (nodes: N[], ...ids: string[]): N[] => nodes.map((n) => ({ ...n, selected: ids.includes(n.id) }));
const byId = <T extends { id: string }>(list: readonly T[], id: string): T => {
  const x = list.find((n) => n.id === id);
  if (!x) throw new Error(`no ${id}`);
  return x;
};

describe("remapHandle", () => {
  const map = new Map([
    ["sc-01", "sc-A"],
    ["beat-1", "beat-B"],
    ["beat-2", "beat-C"],
  ]);
  it("maps a port, a boundary id, a nested boundary id and an inner relay", () => {
    expect(remapHandle("sc-01:in:PROMPT", map)).toBe("sc-A:in:PROMPT");
    expect(remapHandle("beat-1::sc-01:in:PROMPT", map)).toBe("beat-B::sc-A:in:PROMPT");
    expect(remapHandle("beat-2::beat-1::sc-01:out:VIDEO", map)).toBe("beat-C::beat-B::sc-A:out:VIDEO");
    expect(remapHandle("beat-1::sc-01:in:PROMPT__inner", map)).toBe("beat-B::sc-A:in:PROMPT__inner");
  });
  it("does not mis-hit a longer id that starts the same way, and leaves the + slot's tail alone", () => {
    expect(remapHandle("sc-010:in:PROMPT", map)).toBe("sc-010:in:PROMPT");
    expect(remapHandle("beat-1::+in__inner", map)).toBe("beat-B::+in__inner");
  });
});

describe("copySelection", () => {
  it("takes the selected nodes and only the edges with BOTH ends inside", () => {
    const p = demoProject();
    const clip = copySelection(select(p.nodes as N[], "sc-01", "sc-02"), p.edges);
    expect(clip.nodes.map((n) => n.id)).toEqual(["sc-01", "sc-02"]);
    // sc-01 → sc-02 stays; Nadia → sc-01 and sc-02 → sc-03 have an end outside and go.
    expect(clip.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["sc-01>sc-02"]);
  });
  it("brings a container's descendants, keeps its rails, and roots lose their parent", () => {
    const g = promotedDemo();
    const clip = copySelection(select(g.nodes, "beat-1"), g.edges);
    expect(clip.nodes.map((n) => n.id).sort()).toEqual(["beat-1", "sc-01", "sc-02"]);
    const root = byId(clip.nodes, "beat-1");
    expect(root.parentId).toBeUndefined();
    expect((root.data as BeatData).promotedIn.length).toBeGreaterThan(0);
    expect(byId(clip.nodes, "sc-01").parentId).toBe("beat-1");
    // Inner relays (container ↔ child) are inside; outer halves to Nadia / sc-03 are not.
    expect(clip.edges.some((e) => e.sourceHandle.endsWith("__inner") || e.targetHandle.endsWith("__inner"))).toBe(true);
    expect(clip.edges.some((e) => e.source === "char-nadia" || e.target === "sc-03")).toBe(false);
  });
  it("a selected child of an unselected Beat becomes a root at its ABSOLUTE position", () => {
    const p = demoProject();
    const clip = copySelection(select(p.nodes as N[], "sc-02"), p.edges);
    const beat = byId(p.nodes, "beat-1");
    const sc = byId(p.nodes, "sc-02");
    expect(byId(clip.nodes, "sc-02").parentId).toBeUndefined();
    expect(byId(clip.nodes, "sc-02").position).toEqual({ x: beat.position.x + sc.position.x, y: beat.position.y + sc.position.y });
  });
  it("explicit roots override the selected flags; unknown ids are ignored", () => {
    const p = demoProject();
    const clip = copySelection(select(p.nodes as N[], "sc-01"), p.edges, ["sc-03", "nope"]);
    expect(clip.nodes.map((n) => n.id)).toEqual(["sc-03"]);
  });
  it("strips derived and row-owned fields but keeps content", () => {
    const nodes: N[] = [
      scene("cal-sc-12", "Twelve", { x: 0, y: 0 }, { orderIndex: 3, renderStatus: "rendered", inSubgraph: true, action: "she runs", durationSec: 9 }),
    ];
    const clip = copySelection(select(nodes, "cal-sc-12"), []);
    const d = clip.nodes[0]!.data as SceneData;
    expect(d.orderIndex).toBeUndefined();
    expect(d.renderStatus).toBeUndefined();
    expect(d.inSubgraph).toBeUndefined();
    expect(d.action).toBe("she runs");
    expect(d.durationSec).toBe(9);
  });
});

describe("pasteClip", () => {
  it("mints fresh non-Calliope ids, rebuilds ports and remaps edges; nothing dangles", () => {
    const p = demoProject();
    const nodes = p.nodes as N[];
    const withCal = [...nodes, scene("cal-sc-12", "Twelve", { x: 500, y: 500 }, { orderIndex: 2 })];
    const clip = copySelection(select(withCal, "sc-01", "sc-02", "cal-sc-12"), p.edges);
    const out = pasteClip(clip, { x: 1000, y: 1000 }, withCal.map((n) => n.id));
    expect(out.ids).toHaveLength(3);
    for (const id of out.ids) expect(withCal.some((n) => n.id === id)).toBe(false);
    expect(new Set(out.ids).size).toBe(3);
    expect(out.ids.every((id) => id.startsWith("sc-"))).toBe(true);
    for (const n of out.nodes) {
      expect(n.parentId).toBeUndefined();
      for (const port of (n.data as SceneData).ports) expect(port.id.startsWith(`${n.id}:`)).toBe(true);
    }
    expect(out.edges).toHaveLength(1);
    const e = out.edges[0]!;
    const ids = new Set(out.ids);
    expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
    expect(e.sourceHandle).toBe(`${e.source}:out:LAST FRAME`);
    expect(e.targetHandle).toBe(`${e.target}:in:IN FRAME`);
    expect(e.id).toBe(`lg:${e.sourceHandle}->${e.targetHandle}`);
  });
  it("anchors the roots' top-left at `at` and keeps their relative layout", () => {
    const p = demoProject();
    const clip = copySelection(select(p.nodes as N[], "char-nadia", "loc-rooftop"), p.edges);
    expect(clipAnchor(clip)).toEqual({ x: 40, y: 60 });
    const out = pasteClip(clip, { x: 700, y: 900 }, []);
    const [a, b] = out.nodes;
    expect(a!.position).toEqual({ x: 700, y: 900 });
    expect(b!.position).toEqual({ x: 700, y: 900 + 130 });
  });
  it("with no `at`, lands 40px down-right of the original", () => {
    const p = demoProject();
    const clip = copySelection(select(p.nodes as N[], "sc-03"), p.edges);
    const out = pasteClip(clip, null, []);
    expect(out.nodes[0]!.position).toEqual({ x: 940, y: 340 });
  });
  it("keeps the asset kind in the id prefix and the beat prefix for containers", () => {
    const g = promotedDemo();
    const clip = copySelection(select(g.nodes, "char-nadia", "beat-1"), g.edges);
    const out = pasteClip(clip, { x: 0, y: 0 }, []);
    expect(out.ids.some((id) => id.startsWith("character-"))).toBe(true);
    expect(out.ids.some((id) => id.startsWith("beat-"))).toBe(true);
  });

  it("subgraph round trip: children re-parent, rails and boundary ids remap, and reconcile keeps it coherent", () => {
    const g = promotedDemo();
    // Pin the LOCATION rail so there is a user-authored rail to survive.
    const beat = byId(g.nodes, "beat-1");
    const rails = beat.data as BeatData;
    const loc = rails.promotedIn.find((p) => p.childPortId === "sc-01:in:LOCATION")!;
    loc.forced = true;
    loc.label = "WHERE";

    const clip = copySelection(select(g.nodes, "beat-1"), g.edges);
    const out = pasteClip(clip, { x: 2000, y: 2000 }, g.nodes.map((n) => n.id));
    const newBeat = out.nodes.find((n) => n.type === SUBGRAPH_TYPE)!;
    const map = new Map(clip.nodes.map((n, i) => [n.id, out.ids[i]!] as const));
    const newSc01 = map.get("sc-01")!;
    const newSc02 = map.get("sc-02")!;

    // parentId remapped; nothing points at an id outside the paste.
    const ids = new Set(out.ids);
    for (const n of out.nodes) if (n.parentId) expect(ids.has(n.parentId)).toBe(true);
    expect(byId(out.nodes, newSc01).parentId).toBe(newBeat.id);

    // Rails: derived ids under the NEW container and child, childId/fanout remapped.
    const d = newBeat.data as BeatData;
    const charRail = d.promotedIn.find((p) => p.childPortId === `${newSc01}:in:CHARACTER`)!;
    expect(charRail.id).toBe(`${newBeat.id}::${newSc01}:in:CHARACTER`);
    expect(charRail.childId).toBe(newSc01);
    expect(charRail.fanout?.[0]).toEqual({ childId: newSc02, childPortId: `${newSc02}:in:CHARACTER` });
    expect(d.promotedOut[0]!.id).toBe(`${newBeat.id}::${newSc02}:out:LAST FRAME`);

    // Every edge handle names a pasted node; none names an original.
    for (const e of out.edges) {
      expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
      expect(e.sourceHandle?.includes("sc-01") || e.targetHandle?.includes("sc-01")).toBe(false);
    }

    // Now what settle does: reconcile the pasted subgraph inside the merged graph.
    const merged = [...g.nodes, ...out.nodes];
    const mergedEdges = [...g.edges, ...out.edges];
    const rec = reconcileBoundary(newBeat.id, merged, mergedEdges, directorHost);
    const rd = byId(rec.nodes, newBeat.id).data as BeatData;
    // The pinned rail survives with its label and a fresh inner relay…
    const kept = rd.promotedIn.find((p) => p.forced)!;
    expect(kept.label).toBe("WHERE");
    expect(kept.childPortId).toBe(`${newSc01}:in:LOCATION`);
    expect(rec.edges.some((e) => e.sourceHandle === `${kept.id}__inner` && e.target === newSc01)).toBe(true);
    // …while rails whose crossing stayed behind (Nadia, sc-03) are pruned.
    expect(rd.promotedIn.some((p) => p.childPortId === `${newSc01}:in:CHARACTER`)).toBe(false);
    expect(rd.promotedOut).toHaveLength(0);
    // The wire between the two pasted scenes is intact and the originals are untouched.
    expect(rec.edges.some((e) => e.sourceHandle === `${newSc01}:out:LAST FRAME` && e.targetHandle === `${newSc02}:in:IN FRAME`)).toBe(true);
    const orig = byId(rec.nodes, "beat-1").data as BeatData;
    expect(orig.promotedIn.map((p) => p.id)).toEqual(rails.promotedIn.map((p) => p.id));
    // No relay from the paste survived under a stale name.
    expect(rec.edges.filter((e) => e.source === newBeat.id || e.target === newBeat.id).every((e) => e.id.includes("__inneredge"))).toBe(true);
  });

  it("a crossing that came along gets its rail back under the same derived id (label kept)", () => {
    const g = promotedDemo();
    const beat = byId(g.nodes, "beat-1");
    const out0 = (beat.data as BeatData).promotedOut[0]!;
    out0.label = "HANDOFF";
    const clip = copySelection(select(g.nodes, "beat-1", "sc-03"), g.edges);
    const out = pasteClip(clip, { x: 0, y: 3000 }, g.nodes.map((n) => n.id));
    const newBeat = out.nodes.find((n) => n.type === SUBGRAPH_TYPE)!;
    const rec = reconcileBoundary(newBeat.id, [...g.nodes, ...out.nodes], [...g.edges, ...out.edges], directorHost);
    const rd = byId(rec.nodes, newBeat.id).data as BeatData;
    expect(rd.promotedOut).toHaveLength(1);
    expect(rd.promotedOut[0]!.label).toBe("HANDOFF");
    expect(rd.promotedOut[0]!.id).toBe(`${newBeat.id}::${rd.promotedOut[0]!.childPortId}`);
  });
});

describe("duplicateNodes", () => {
  it("copies with descendants at +40/+40 and leaves the originals alone", () => {
    const g = promotedDemo();
    const out = duplicateNodes(g.nodes, g.edges, ["beat-1"]);
    expect(out.ids).toHaveLength(3);
    const root = out.nodes.find((n) => !n.parentId)!;
    expect(root.position).toEqual({ x: 340 + 40, y: 40 + 40 });
    expect(g.nodes.some((n) => out.ids.includes(n.id))).toBe(false);
  });
  it("is empty for ids that do not exist", () => {
    const p = demoProject();
    expect(duplicateNodes(p.nodes as N[], p.edges, ["ghost"]).ids).toEqual([]);
  });
});
