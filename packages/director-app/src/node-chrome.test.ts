import { describe, expect, it, vi } from "vitest";
import type { Edge } from "@xyflow/react";
import { GROUP_TYPE, SUBGRAPH_TYPE } from "@benjidirector/graph-core";
import { resolveDrive, type DriveKit, type RFNode } from "./drive-registry.js";
import { asset, beat, scene, scenePorts, type AssetData, type SceneData } from "./model.js";
import {
  BYPASS_OPACITY,
  BYPASS_TITLE,
  bool,
  edgesTouching,
  headerHandleLayout,
  infoLinesOf,
  leafClassName,
  leafStyle,
  normalizeHex,
  patchLeaf,
  typeLabelOf,
} from "./node-chrome.js";
// Registers set_bypassed / set_node_color / set_node_collapsed on import, exactly as index.tsx does.
import "./node-chrome.drive.js";

const sc = (id: string, extra: Partial<SceneData> = {}) => scene(id, `Scene ${id}`, { x: 0, y: 0 }, extra) as unknown as RFNode;
const ch = (id: string) => asset(id, `Asset ${id}`, "character", { x: 0, y: 0 }) as unknown as RFNode;

describe("typeLabelOf", () => {
  it("names the kind, never the label", () => {
    expect(typeLabelOf(sc("a").data)).toBe("SCENE");
    expect(typeLabelOf(ch("c").data)).toBe("CHARACTER");
    expect(typeLabelOf(asset("l", "x", "location", { x: 0, y: 0 }).data)).toBe("LOCATION");
    expect(typeLabelOf(asset("i", "x", "item", { x: 0, y: 0 }).data)).toBe("ITEM");
    expect(typeLabelOf({ kind: "note", label: "n", text: "", ports: [] })).toBe("NOTE");
    expect(typeLabelOf(beat("b", "Beat", { x: 0, y: 0 }).data)).toBe("BEAT");
  });
});

describe("leafClassName / leafStyle — the bypass and colour rules", () => {
  it("adds one is-* class per flag, in a stable order", () => {
    expect(leafClassName("bd-scene", {})).toBe("bd-node bd-scene");
    expect(leafClassName("bd-asset", { selected: true, promoted: true, bypassed: true, collapsed: true })).toBe(
      "bd-node bd-asset is-selected is-promoted is-bypassed is-collapsed",
    );
  });
  it("a colour retints the header via --bd-kind", () => {
    expect(leafStyle({ color: "#60a5fa" })).toEqual({ "--bd-kind": "#60a5fa" });
    expect(leafStyle({})).toBeUndefined();
  });
  it("bypass fades the card to 35% and wins over a chosen colour", () => {
    const s = leafStyle({ bypassed: true, color: "#60a5fa" }) as Record<string, unknown>;
    expect(s.opacity).toBe(BYPASS_OPACITY);
    expect(BYPASS_OPACITY).toBeCloseTo(0.35);
    expect(s["--bd-kind"]).toBe("var(--bd-bypass)");
    expect(BYPASS_TITLE).toMatch(/skipped by render tools/);
  });
});

describe("headerHandleLayout — collapsed handles converge but keep their ids", () => {
  it("splits inputs left and outputs right without losing a port", () => {
    const ports = scenePorts("sc-01");
    const l = headerHandleLayout(ports);
    expect(l.ins.map((p) => p.id)).toEqual(ports.filter((p) => p.isInput).map((p) => p.id));
    expect(l.outs.map((p) => p.id)).toEqual(ports.filter((p) => !p.isInput).map((p) => p.id));
    expect(l.ins.length + l.outs.length).toBe(ports.length);
    expect(l.inTitle).toBe("in: PROMPT, CHARACTER, LOCATION, IN FRAME");
    expect(l.outTitle).toBe("out: VIDEO, LAST FRAME");
  });
  it("says so when a side is empty", () => {
    const l = headerHandleLayout((ch("c").data as AssetData).ports);
    expect(l.ins).toEqual([]);
    expect(l.inTitle).toBe("no inputs");
    expect(l.outs).toHaveLength(1);
  });
});

describe("infoLinesOf", () => {
  it("a scene shows action, dialog and duration", () => {
    const lines = infoLinesOf(sc("a", { action: "She climbs", dialog: "Careful", durationSec: 6 }).data);
    expect(lines).toEqual([
      { k: "action", v: "She climbs" },
      { k: "dialog", v: "Careful" },
      { k: "duration", v: "6s" },
    ]);
  });
  it("an asset shows its kind; a bypassed leaf says so", () => {
    expect(infoLinesOf(ch("c").data)[0]?.v).toMatch(/^Character/);
    expect(infoLinesOf(sc("a", { bypassed: true }).data).at(-1)).toEqual({ k: "state", v: BYPASS_TITLE });
  });
});

describe("normalizeHex", () => {
  it("accepts 3/4/6/8 hex digits with or without #, lower-cased", () => {
    expect(normalizeHex("abc")).toBe("#abc");
    expect(normalizeHex("#60A5FA")).toBe("#60a5fa");
    expect(normalizeHex(" #abcd ")).toBe("#abcd");
    expect(normalizeHex("#60a5fa80")).toBe("#60a5fa80");
  });
  it("refuses everything else", () => {
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });
});

describe("patchLeaf", () => {
  it("changes only the target and drops undefined keys", () => {
    const ns = [sc("a", { color: "#abc" }), sc("b")];
    const out = patchLeaf(ns, "a", { bypassed: true, color: undefined });
    expect(out[1]).toBe(ns[1]);
    expect(out[0]).not.toBe(ns[0]);
    expect((out[0]!.data as SceneData).bypassed).toBe(true);
    expect("color" in out[0]!.data).toBe(false);
    expect((ns[0]!.data as SceneData).color).toBe("#abc");
  });
});

describe("edgesTouching / bool", () => {
  it("counts wires on either end", () => {
    const es: Edge[] = [
      { id: "1", source: "a", target: "b" },
      { id: "2", source: "c", target: "a" },
      { id: "3", source: "c", target: "b" },
    ];
    expect(edgesTouching(es, "a").map((e) => e.id)).toEqual(["1", "2"]);
    expect(edgesTouching(es, "zzz")).toEqual([]);
  });
  it("bool takes only a real boolean", () => {
    expect(bool(true, "x")).toBe(true);
    expect(() => bool("true", "bypassed")).toThrow(/bypassed must be true or false/);
  });
});

// ── the drive commands, through a kit that records what settle received ──

function fakeKit(ns: RFNode[], es: Edge[] = []) {
  const settle = vi.fn();
  const kit = {
    run: async <T,>(fn: (n: RFNode[], e: Edge[]) => T) => fn(ns, es),
    settle,
    find: (list: RFNode[], id: unknown) => {
      const n = list.find((x) => x.id === id);
      if (!n) throw new Error(`no node "${String(id)}"`);
      return n;
    },
    str: (v: unknown, what: string) => {
      if (typeof v !== "string" || !v) throw new Error(`${what} must be a non-empty string`);
      return v;
    },
    isContainer: (n: RFNode | undefined) => !!n && (n.type === GROUP_TYPE || n.type === SUBGRAPH_TYPE),
  } as unknown as DriveKit;
  return { kit, settle };
}

const settled = (settle: ReturnType<typeof vi.fn>): { ns: RFNode[]; es: Edge[]; opts: unknown } => {
  const call = settle.mock.calls[0];
  if (!call) throw new Error("settle was not called");
  return { ns: call[0] as RFNode[], es: call[1] as Edge[], opts: call[2] };
};

describe("drive: set_bypassed", () => {
  it("writes data.bypassed through settle with reparent:false", async () => {
    const { kit, settle } = fakeKit([sc("sc-01"), ch("char-1")]);
    const out = await resolveDrive("set_bypassed")!({ id: "sc-01", bypassed: true }, kit);
    expect(out).toEqual({ id: "sc-01", bypassed: true });
    const { ns, opts } = settled(settle);
    expect((ns.find((n) => n.id === "sc-01")!.data as SceneData).bypassed).toBe(true);
    expect((ns.find((n) => n.id === "char-1")!.data as AssetData).bypassed).toBeUndefined();
    expect(opts).toEqual({ reparent: false });
  });
  it("refuses a Beat, an unknown id and a non-boolean", async () => {
    const { kit, settle } = fakeKit([sc("sc-01"), beat("beat-1", "B", { x: 0, y: 0 }) as unknown as RFNode]);
    await expect(resolveDrive("set_bypassed")!({ id: "beat-1", bypassed: true }, kit)).rejects.toThrow(/is a Beat/);
    await expect(resolveDrive("set_bypassed")!({ id: "nope", bypassed: true }, kit)).rejects.toThrow(/no node/);
    await expect(resolveDrive("set_bypassed")!({ id: "sc-01", bypassed: "yes" }, kit)).rejects.toThrow(/bypassed must be true or false/);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("drive: set_node_color", () => {
  it("normalises a hex colour onto a scene or an asset", async () => {
    const { kit, settle } = fakeKit([sc("sc-01"), ch("char-1")]);
    expect(await resolveDrive("set_node_color")!({ id: "char-1", color: "60A5FA" }, kit)).toEqual({ id: "char-1", color: "#60a5fa" });
    expect((settled(settle).ns.find((n) => n.id === "char-1")!.data as AssetData).color).toBe("#60a5fa");
    expect(settled(settle).opts).toEqual({ reparent: false });
  });
  it("null clears the tint (the key goes away, so outline reports null)", async () => {
    const { kit, settle } = fakeKit([sc("sc-01", { color: "#abc" })]);
    expect(await resolveDrive("set_node_color")!({ id: "sc-01", color: null }, kit)).toEqual({ id: "sc-01", color: null });
    expect("color" in settled(settle).ns[0]!.data).toBe(false);
  });
  it("refuses a non-hex colour and a Beat", async () => {
    const { kit, settle } = fakeKit([sc("sc-01"), beat("beat-1", "B", { x: 0, y: 0 }) as unknown as RFNode]);
    await expect(resolveDrive("set_node_color")!({ id: "sc-01", color: "red" }, kit)).rejects.toThrow(/hex colour/);
    await expect(resolveDrive("set_node_color")!({ id: "beat-1", color: "#abc" }, kit)).rejects.toThrow(/set_color/);
    expect(settle).not.toHaveBeenCalled();
  });
});

describe("drive: set_node_collapsed", () => {
  it("writes data.collapsed on a leaf and refuses a Beat", async () => {
    const { kit, settle } = fakeKit([sc("sc-01"), beat("beat-1", "B", { x: 0, y: 0 }) as unknown as RFNode]);
    expect(await resolveDrive("set_node_collapsed")!({ id: "sc-01", collapsed: true }, kit)).toEqual({ id: "sc-01", collapsed: true });
    expect((settled(settle).ns[0]!.data as SceneData).collapsed).toBe(true);
    await expect(resolveDrive("set_node_collapsed")!({ id: "beat-1", collapsed: true }, kit)).rejects.toThrow(/set_collapsed/);
  });
});
