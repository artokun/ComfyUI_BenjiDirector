import { beforeEach, describe, expect, it } from "vitest";
import {
  GROUP_TYPE,
  SUBGRAPH_TYPE,
  boundaryPortId,
  dissolveSubgraph,
  promoteToSubgraph,
  reconcileBoundary,
  type BoundaryPort,
  type GraphEdge,
  type GraphNode,
} from "@benjidirector/graph-core";
import {
  BLUEPRINTS_KEY,
  BUILTIN_BLUEPRINTS,
  blueprintIdFromName,
  blueprintVersion,
  deleteBlueprint,
  instantiateBlueprint,
  loadBlueprints,
  serializeSubtree,
  stampBlueprint,
  storeBlueprint,
  writeBlueprints,
  type Blueprint,
} from "./blueprints.js";
import { asset, beat, directorHost, scene, type BeatData, type DirectorData } from "./model.js";

type N = GraphNode<DirectorData> & { selected?: boolean };

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

const link = (a: string, ah: string, b: string, bh: string): GraphEdge => ({
  id: `lg:${a}:out:${ah}->${b}:in:${bh}`,
  source: a,
  target: b,
  sourceHandle: `${a}:out:${ah}`,
  targetHandle: `${b}:in:${bh}`,
});

/** The demo shape: a Beat of two chained scenes, fed from outside by a character and a location, feeding a scene outside. */
function demo(): { nodes: N[]; edges: GraphEdge[] } {
  const nodes: N[] = [
    asset("char-nadia", "Nadia", "character", { x: 40, y: 60 }),
    asset("loc-rooftop", "Rooftop", "location", { x: 40, y: 190 }),
    beat("beat-1", "Beat 1", { x: 340, y: 40 }),
    scene("sc-01", "SC-01", { x: 40, y: 60 }, {}, "beat-1"),
    scene("sc-02", "SC-02", { x: 40, y: 220 }, {}, "beat-1"),
    scene("sc-03", "SC-03", { x: 900, y: 300 }),
  ];
  const edges = [
    link("char-nadia", "REF", "sc-01", "CHARACTER"),
    link("loc-rooftop", "REF", "sc-01", "LOCATION"),
    link("char-nadia", "REF", "sc-02", "CHARACTER"),
    link("sc-01", "LAST FRAME", "sc-02", "IN FRAME"),
    link("sc-02", "LAST FRAME", "sc-03", "IN FRAME"),
  ];
  return { nodes, edges };
}

const railsOf = (ns: readonly N[], id: string) => ns.find((n) => n.id === id)!.data as BeatData;
const labels = (ports: BoundaryPort[]) => ports.map((p) => p.label);

/**
 * The authored interface: promote beat-1 (rails from its crossings), rename the LOCATION rail
 * "Lead", pin sc-02's VIDEO by hand (the `+` slot), reconcile as settle would, then dissolve
 * and serialise exactly the way `commitBlueprint` does.
 */
function authored() {
  const { nodes, edges } = demo();
  const p = promoteToSubgraph("beat-1", nodes, edges, directorHost);
  const pinned = (p.nodes as N[]).map((n) => {
    if (n.id !== "beat-1") return n;
    const d = n.data as BeatData;
    const pin: BoundaryPort = {
      id: boundaryPortId("beat-1", "sc-02:out:VIDEO"),
      childId: "sc-02",
      childPortId: "sc-02:out:VIDEO",
      type: "video",
      label: "VIDEO",
      forced: true,
    };
    return {
      ...n,
      data: {
        ...d,
        promotedIn: d.promotedIn.map((q) => (q.childPortId === "sc-01:in:LOCATION" ? { ...q, label: "Lead" } : q)),
        promotedOut: [...d.promotedOut, pin],
      },
    } as N;
  });
  const settled = reconcileBoundary("beat-1", pinned, p.edges, directorHost);
  const live = { nodes: settled.nodes as N[], edges: settled.edges };
  const logical = dissolveSubgraph("beat-1", live.nodes, live.edges);
  const body = serializeSubtree("beat-1", logical.nodes as N[], logical.edges, true, live.nodes);
  return { body, live };
}

const asBlueprint = (body: ReturnType<typeof authored>["body"], extra: Partial<Blueprint> = {}): Blueprint => ({
  id: "bp-approach",
  label: "Approach",
  savedAt: 1,
  version: 1,
  ...body,
  ...extra,
});

/** What settle does to a freshly stamped instance. */
const settleLike = (rootId: string, ns: readonly N[], es: readonly GraphEdge[]) => {
  const r = reconcileBoundary(rootId, ns, es, directorHost);
  return { nodes: r.nodes as N[], edges: r.edges };
};

describe("blueprints", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  describe("the saved interface", () => {
    it("stores every rail keyed by CHILD port — pins, fan-in and the user's labels — and no rail wiring", () => {
      const { body } = authored();
      const root = body.nodes.find((n) => n.id === "beat-1")!;
      expect(root.wasSubgraph).toBe(true);
      expect(root.type).toBe(GROUP_TYPE);
      expect((root.data as BeatData).promotedIn).toEqual([]);
      expect((root.data as BeatData).promotedOut).toEqual([]);
      expect(root.forcedRails).toEqual([
        { side: "in", childPortId: "sc-01:in:CHARACTER", fanout: ["sc-02:in:CHARACTER"] },
        { side: "in", childPortId: "sc-01:in:LOCATION" },
        { side: "out", childPortId: "sc-02:out:LAST FRAME" },
        { side: "out", childPortId: "sc-02:out:VIDEO" },
      ]);
      expect(root.railLabels).toEqual({
        "sc-01:in:CHARACTER": "CHARACTER",
        "sc-01:in:LOCATION": "Lead",
        "sc-02:out:LAST FRAME": "LAST FRAME",
        "sc-02:out:VIDEO": "VIDEO",
      });
      // Only the wire wholly inside travels; nothing in relay form, nothing to the outside.
      expect(body.edges).toEqual([{ source: "sc-01", target: "sc-02", sourceHandle: "sc-01:out:LAST FRAME", targetHandle: "sc-02:in:IN FRAME" }]);
      // The blueprint linkage never travels — the template is the definition, not an instance.
      expect((root.data as BeatData).blueprintId).toBeUndefined();
    });

    it("saves with no interface when the pre-dissolve graph is not given (the v1 shape)", () => {
      const { live } = authored();
      const logical = dissolveSubgraph("beat-1", live.nodes, live.edges);
      const root = serializeSubtree("beat-1", logical.nodes as N[], logical.edges, true).nodes.find((n) => n.id === "beat-1")!;
      expect(root.forcedRails).toBeUndefined();
      expect(root.railLabels).toBeUndefined();
    });
  });

  describe("round trip", () => {
    it("instantiate re-keys the rails to the minted ids", () => {
      const bp = asBlueprint(authored().body);
      const inst = instantiateBlueprint(bp, { x: 900, y: 600 }, "z9");
      expect(inst.rootId).toBe("beat-1-z9");
      expect(inst.promote).toBe(true);
      const rails = inst.rails["beat-1-z9"]!;
      expect(rails.forcedRails).toEqual([
        { side: "in", childId: "sc-01-z9", childPortId: "sc-01-z9:in:CHARACTER", fanout: [{ childId: "sc-02-z9", childPortId: "sc-02-z9:in:CHARACTER" }] },
        { side: "in", childId: "sc-01-z9", childPortId: "sc-01-z9:in:LOCATION" },
        { side: "out", childId: "sc-02-z9", childPortId: "sc-02-z9:out:LAST FRAME" },
        { side: "out", childId: "sc-02-z9", childPortId: "sc-02-z9:out:VIDEO" },
      ]);
      expect(rails.railLabels["sc-01-z9:in:LOCATION"]).toBe("Lead");
      // Nothing stale: no old id survives anywhere in the instance.
      const text = JSON.stringify(inst);
      expect(text).not.toMatch(/"sc-01"|"sc-02"|"beat-1"/);
    });

    it("the instance is a subgraph with the same rails: pinned, labelled 'Lead', fanned-in and wired — with nothing outside to derive them from", () => {
      const bp = asBlueprint(authored().body);
      const stamped = stampBlueprint(bp, { x: 900, y: 600 }, [], [], "z9");
      const { nodes, edges } = settleLike(stamped.rootId, stamped.nodes, stamped.edges);
      const root = nodes.find((n) => n.id === stamped.rootId)!;
      expect(root.type).toBe(SUBGRAPH_TYPE);
      expect(root.position).toEqual({ x: 900, y: 600 });
      const d = root.data as BeatData;
      expect(labels(d.promotedIn)).toEqual(["CHARACTER", "Lead"]);
      expect(labels(d.promotedOut)).toEqual(["LAST FRAME", "VIDEO"]);
      for (const p of [...d.promotedIn, ...d.promotedOut]) expect(p.forced, p.label).toBe(true);
      expect(d.promotedIn[0]!.fanout).toEqual([{ childId: "sc-02-z9", childPortId: "sc-02-z9:in:CHARACTER" }]);
      // Reconcile rebuilt an inner relay for every pinned target: 4 rails + 1 fan-out member.
      const relays = edges.filter((e) => e.id.includes("__inneredge"));
      expect(relays).toHaveLength(5);
      expect(relays.some((e) => e.target === "sc-02-z9" && e.targetHandle === "sc-02-z9:in:CHARACTER")).toBe(true);
      // The internal wire came along, in logical form.
      expect(edges.some((e) => e.sourceHandle === "sc-01-z9:out:LAST FRAME" && e.targetHandle === "sc-02-z9:in:IN FRAME")).toBe(true);
      // Linked and selected.
      expect(d.blueprintId).toBe("bp-approach");
      expect(d.blueprintVersion).toBe(1);
      expect(root.selected).toBe(true);
      expect(nodes.filter((n) => n.parentId === stamped.rootId)).toHaveLength(2);
    });

    it("the pins SURVIVE the next settle, and a rename on the instance sticks", () => {
      const bp = asBlueprint(authored().body);
      const stamped = stampBlueprint(bp, { x: 0, y: 0 }, [], [], "z9");
      const once = settleLike(stamped.rootId, stamped.nodes, stamped.edges);
      const renamed = once.nodes.map((n) => {
        if (n.id !== stamped.rootId) return n;
        const d = n.data as BeatData;
        return { ...n, data: { ...d, promotedOut: d.promotedOut.map((p) => (p.label === "VIDEO" ? { ...p, label: "Cut" } : p)) } } as N;
      });
      const twice = settleLike(stamped.rootId, renamed, once.edges);
      const d = railsOf(twice.nodes, stamped.rootId);
      expect(labels(d.promotedIn)).toEqual(["CHARACTER", "Lead"]);
      expect(labels(d.promotedOut)).toEqual(["LAST FRAME", "Cut"]);
      expect(twice.edges.filter((e) => e.id.includes("__inneredge"))).toHaveLength(5);
    });

    it("placing deselects everything else and leaves the existing graph alone", () => {
      const bp = asBlueprint(authored().body);
      const { nodes, edges } = demo();
      const before = nodes.map((n) => ({ ...n, selected: true }));
      const stamped = stampBlueprint(bp, { x: 900, y: 600 }, before, edges, "z9");
      expect(stamped.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual([stamped.rootId]);
      expect(stamped.nodes.filter((n) => !n.id.endsWith("-z9")).map((n) => n.id)).toEqual(nodes.map((n) => n.id));
      expect(stamped.edges.filter((e) => !e.id.includes("-z9"))).toEqual(edges);
    });

    it("a Beat saved as a plain group places as a group — linked, selected, no rails", () => {
      const { nodes, edges } = demo();
      const body = serializeSubtree("beat-1", nodes, edges, false, nodes);
      const bp = asBlueprint(body, { id: "bp-group" });
      const stamped = stampBlueprint(bp, { x: 10, y: 20 }, [], [], "g1");
      const root = stamped.nodes.find((n) => n.id === stamped.rootId)!;
      expect(root.type).toBe(GROUP_TYPE);
      expect(root.selected).toBe(true);
      expect((root.data as BeatData).blueprintId).toBe("bp-group");
      expect((root.data as BeatData).promotedIn).toEqual([]);
    });

    it("a v1 blueprint (no rails, no version) still places", () => {
      const { live } = authored();
      const logical = dissolveSubgraph("beat-1", live.nodes, live.edges);
      const body = serializeSubtree("beat-1", logical.nodes as N[], logical.edges, true);
      const bp: Blueprint = { id: "bp-old", label: "Old", savedAt: 1, ...body };
      const stamped = stampBlueprint(bp, { x: 0, y: 0 }, [], [], "v1");
      const d = railsOf(settleLike(stamped.rootId, stamped.nodes, stamped.edges).nodes, stamped.rootId);
      expect(d.promotedIn).toEqual([]);
      expect(d.blueprintVersion).toBe(1);
    });
  });

  describe("the library", () => {
    it("storeBlueprint mints an id from the name, and updating into it increments the version", () => {
      const { body } = authored();
      const first = storeBlueprint(body, "Approach");
      expect(first).toMatchObject({ id: "bp-approach", label: "Approach", version: 1 });
      const second = storeBlueprint(body, "Approach (tighter)", "bp-approach");
      expect(second).toMatchObject({ id: "bp-approach", label: "Approach (tighter)", version: 2 });
      expect(blueprintVersion(loadBlueprints()["bp-approach"]!)).toBe(2);
      // A new save under the old name does not collide.
      expect(storeBlueprint(body, "Approach").id).toBe("bp-approach-1");
      // Instances carry the version they were stamped from.
      const stamped = stampBlueprint(loadBlueprints()["bp-approach"]!, { x: 0, y: 0 }, [], [], "s");
      expect((stamped.nodes.find((n) => n.id === stamped.rootId)!.data as BeatData).blueprintVersion).toBe(2);
      expect(() => storeBlueprint(body, "x", "bp-nope")).toThrow(/no blueprint/);
    });

    it("deleteBlueprint removes a user blueprint and reports what it did", () => {
      storeBlueprint(authored().body, "Approach");
      expect(loadBlueprints()["bp-approach"]).toBeDefined();
      expect(deleteBlueprint("bp-approach")).toBe(true);
      expect(loadBlueprints()["bp-approach"]).toBeUndefined();
      expect(deleteBlueprint("bp-approach")).toBe(false);
    });

    it("built-ins are listed with builtin: true, placeable, and neither deletable nor overwritable nor persisted", () => {
      expect(BUILTIN_BLUEPRINTS.map((b) => b.id)).toContain("bp-two-shot");
      const all = loadBlueprints();
      expect(all["bp-two-shot"]).toMatchObject({ label: "Two-shot Beat", builtin: true, version: 1 });
      expect(deleteBlueprint("bp-two-shot")).toBe(false);
      expect(loadBlueprints()["bp-two-shot"]).toBeDefined();
      expect(() => storeBlueprint(authored().body, "Two-shot Beat", "bp-two-shot")).toThrow(/ships with/);
      writeBlueprints(all);
      expect(JSON.parse(localStorage.getItem(BLUEPRINTS_KEY)!)).toEqual({});
      // A name that slugs onto a BUILT-IN id is uniquified even with an empty user library.
      expect(blueprintIdFromName("Two shot", {})).toBe("bp-two-shot-1");
      expect(blueprintIdFromName("Two-shot Beat", {})).toBe("bp-two-shot-beat");
      // A stored entry cannot impersonate a built-in.
      localStorage.setItem(BLUEPRINTS_KEY, JSON.stringify({ "bp-two-shot": { ...all["bp-two-shot"], label: "Hijacked", builtin: false } }));
      expect(loadBlueprints()["bp-two-shot"]!.label).toBe("Two-shot Beat");
    });

    it("the Two-shot Beat places as a subgraph with its authored rails", () => {
      const bp = loadBlueprints()["bp-two-shot"]!;
      const stamped = stampBlueprint(bp, { x: 100, y: 100 }, [], [], "t");
      const { nodes, edges } = settleLike(stamped.rootId, stamped.nodes, stamped.edges);
      const d = railsOf(nodes, stamped.rootId);
      expect(nodes.find((n) => n.id === stamped.rootId)!.type).toBe(SUBGRAPH_TYPE);
      expect(labels(d.promotedIn)).toEqual(["Lead-in"]);
      expect(labels(d.promotedOut)).toEqual(["Hand-off"]);
      expect(d.promotedIn[0]).toMatchObject({ childId: "tpl-shot-a-t", type: "image", forced: true });
      expect(nodes.filter((n) => n.parentId === stamped.rootId).map((n) => n.data.kind).sort()).toEqual(["asset", "scene", "scene"]);
      expect(edges.filter((e) => !e.id.includes("__inneredge"))).toHaveLength(3);
      expect(d.blueprintId).toBe("bp-two-shot");
    });
  });
});
