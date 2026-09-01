import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@benjidirector/graph-core";
import type { SceneRow } from "@benjidirector/calliope-client";
import { diffForCalliope, verifyEcho } from "./calliope-sync.js";
import { beat, scene, type DirectorData } from "./model.js";

type N = GraphNode<DirectorData>;
const snap = (nodes: N[], edges: GraphEdge[] = []) => ({ nodes, edges });
const chain = (a: string, b: string): GraphEdge => ({ id: `lg:${a}:out:LAST FRAME->${b}:in:IN FRAME`, source: a, target: b, sourceHandle: `${a}:out:LAST FRAME`, targetHandle: `${b}:in:IN FRAME` });

describe("diffForCalliope", () => {
  const b1 = beat("cal-beat-1", "Beat 1", { x: 300, y: 40 });
  const b2 = beat("cal-beat-2", "Beat 2", { x: 900, y: 40 });
  const s1 = scene("cal-sc-1", "SC-01", { x: 40, y: 60 }, { durationSec: 6 }, "cal-beat-1");
  const s2 = scene("cal-sc-2", "SC-02", { x: 40, y: 220 }, { durationSec: 4 }, "cal-beat-1");

  it("reports nothing when nothing changed", () => {
    expect(diffForCalliope(snap([b1, b2, s1, s2]), snap([b1, b2, s1, s2]))).toEqual([]);
  });

  it("moving a scene writes its position under video_settings.director — rounded, since a sub-pixel drift is not an edit", () => {
    const moved = { ...s2, position: { x: 41.4, y: 225.6 } };
    expect(diffForCalliope(snap([b1, s1, s2]), snap([b1, s1, moved]))).toEqual([{ sceneId: 2, director: { position: { x: 41, y: 226 } } }]);
  });

  it("dragging a scene into another Beat writes beat_id — the native topology", () => {
    const reparented = { ...s2, parentId: "cal-beat-2" };
    const out = diffForCalliope(snap([b1, b2, s1, s2]), snap([b1, b2, s1, reparented]));
    expect(out).toEqual([{ sceneId: 2, beat_id: 2 }]);
  });

  it("dragging a scene out to the top level writes beat_id null", () => {
    const { parentId: _p, ...top } = s2;
    expect(diffForCalliope(snap([b1, s1, s2]), snap([b1, s1, top as N]))).toEqual([{ sceneId: 2, beat_id: null }]);
  });

  it("a new IN FRAME wire sets chain_from_prev; cutting it clears it", () => {
    const wired = snap([b1, s1, s2], [chain("cal-sc-1", "cal-sc-2")]);
    expect(diffForCalliope(snap([b1, s1, s2]), wired)).toEqual([{ sceneId: 2, chain_from_prev: true }]);
    expect(diffForCalliope(wired, snap([b1, s1, s2]))).toEqual([{ sceneId: 2, chain_from_prev: false }]);
  });

  it("a continuity wire from a scene that is not the one before in the cut does not set chain_from_prev", () => {
    const o1 = { ...s1, data: { ...s1.data, orderIndex: 0 } } as N;
    const o2 = { ...s2, data: { ...s2.data, orderIndex: 1 } } as N;
    const o3 = scene("cal-sc-3", "SC-03", { x: 40, y: 380 }, { durationSec: 4, orderIndex: 2 }, "cal-beat-1");
    // SC-01 → SC-03 skips SC-02: Calliope would still chain SC-03 from SC-02, so we do not claim it.
    const skip = snap([b1, o1, o2, o3], [chain("cal-sc-1", "cal-sc-3")]);
    expect(diffForCalliope(snap([b1, o1, o2, o3]), skip)).toEqual([]);
    // SC-02 → SC-03 is consecutive and does.
    const ok = snap([b1, o1, o2, o3], [chain("cal-sc-2", "cal-sc-3")]);
    expect(diffForCalliope(snap([b1, o1, o2, o3]), ok)).toEqual([{ sceneId: 3, chain_from_prev: true }]);
  });

  it("editing heading and duration on the collapsed face writes content fields", () => {
    const edited = { ...s1, data: { ...s1.data, heading: "SC-01 · Out", label: "SC-01 · Out", durationSec: 7 } } as N;
    expect(diffForCalliope(snap([b1, s1]), snap([b1, edited]))).toEqual([{ sceneId: 1, heading: "SC-01 · Out", duration_sec: 7 }]);
  });

  it("pinning writes promoted under director", () => {
    const pinned = { ...s1, data: { ...s1.data, promoted: true } } as N;
    expect(diffForCalliope(snap([b1, s1]), snap([b1, pinned]))).toEqual([{ sceneId: 1, director: { promoted: true } }]);
  });

  it("ignores nodes the editor invented — they have no row yet", () => {
    const local = scene("sc-mtj5v0c7", "New scene", { x: 0, y: 0 });
    const moved = { ...local, position: { x: 10, y: 10 } };
    expect(diffForCalliope(snap([local]), snap([moved]))).toEqual([]);
  });

  it("never emits an order_index — the timeline is not inferred from where things sit", () => {
    const moved = { ...s1, position: { x: 40, y: 999 } };
    const out = diffForCalliope(snap([b1, s1, s2]), snap([b1, moved, s2]));
    for (const it of out) expect(it).not.toHaveProperty("order_index");
  });
});

describe("verifyEcho — a 200 is not evidence the write landed", () => {
  const row = (over: Partial<SceneRow>): SceneRow => ({ id: 3, project_id: 1, beat_id: 2, order_index: 2, heading: "SC-03", action: null, dialog: null, duration_sec: 5, workflow_id: null, env_image_path: null, location_id: 1, video_path: null, chain_from_prev: 1, character_ids: [1], video_settings: null, ...over });

  it("catches Calliope 1.2.1 dropping beat_id=null — the row comes back still in its Beat", () => {
    const miss = verifyEcho({ sceneId: 3, beat_id: null }, row({ beat_id: 2 }));
    expect(miss?.field).toBe("beat_id");
    expect(miss?.error).toMatch(/did not apply beat_id=null/);
  });

  it("passes when the row echoes every requested field", () => {
    expect(verifyEcho({ sceneId: 3, beat_id: 1, chain_from_prev: false, heading: "X", duration_sec: 9 }, row({ beat_id: 1, chain_from_prev: 0, heading: "X", duration_sec: 9 }))).toBeNull();
  });

  it("does not judge fields the intent did not ask for", () => {
    expect(verifyEcho({ sceneId: 3, director: { promoted: true } }, row({ beat_id: 999, heading: "whatever" }))).toBeNull();
  });
});
