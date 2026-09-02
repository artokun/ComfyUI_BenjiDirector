import { describe, expect, it } from "vitest";
import { boundaryPortId, innerHandleId, type GraphEdge, type GraphNode } from "@benjidirector/graph-core";
import { CalliopeError, type CalliopeClient, type SceneRow } from "@benjidirector/calliope-client";
import {
  applyIntents,
  applyStoryIntents,
  createAssetRow,
  createBeatRow,
  createSceneRow,
  deleteRows,
  diffForCalliope,
  diffStoryForCalliope,
  feedChain,
  feedOf,
  reidNode,
  verifyEcho,
  withOrderIndexes,
  withoutDeadRows,
} from "./calliope-sync.js";
import { asset, beat, scene, type DirectorData, type SceneData } from "./model.js";

type N = GraphNode<DirectorData>;
const snap = (nodes: N[], edges: GraphEdge[] = []) => ({ nodes, edges });
const chain = (a: string, b: string): GraphEdge => ({ id: `lg:${a}:out:LAST FRAME->${b}:in:IN FRAME`, source: a, target: b, sourceHandle: `${a}:out:LAST FRAME`, targetHandle: `${b}:in:IN FRAME` });
const refWire = (from: string, to: string, port: "CHARACTER" | "LOCATION"): GraphEdge => ({ id: `lg:${from}:out:REF->${to}:in:${port}`, source: from, target: to, sourceHandle: `${from}:out:REF`, targetHandle: `${to}:in:${port}` });

/** A scene row as Calliope 1.2.1 returns it (shape observed on the wire, not read off the spec). */
const sceneRowFixture = (id: number, over: Partial<SceneRow> = {}): SceneRow => ({
  id,
  project_id: 1,
  beat_id: null,
  order_index: id - 1,
  heading: `SC-0${id}`,
  action: null,
  dialog: null,
  duration_sec: 5,
  workflow_id: null,
  env_image_path: null,
  location_id: 1,
  video_path: null,
  chain_from_prev: 0,
  character_ids: [1],
  video_settings: null,
  ...over,
});

/** A client that RECORDS what it was asked to do and answers with whatever the test hands it. */
function fakeClient(handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const call = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    const h = handlers[op];
    if (!h) throw new Error(`fake client: no handler for ${op}`);
    return Promise.resolve(h(...args));
  };
  const story = {
    beat: { create: call("beat.create"), patch: call("beat.patch"), delete: call("beat.delete") },
    character: { create: call("character.create"), patch: call("character.patch"), delete: call("character.delete") },
    location: { create: call("location.create"), patch: call("location.patch"), delete: call("location.delete") },
    item: { create: call("item.create"), patch: call("item.patch"), delete: call("item.delete") },
  };
  const scenes = { create: call("scenes.create"), patch: call("scenes.patch"), delete: call("scenes.delete"), reorder: call("scenes.reorder") };
  return { client: { story, scenes } as unknown as CalliopeClient, calls };
}

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

// ─────────────────────────────────────────────────────────────────────────────────────────
// [U13] wires, renames, rows created and deleted
// ─────────────────────────────────────────────────────────────────────────────────────────

describe("diffForCalliope — the ref wires", () => {
  const b1 = beat("cal-beat-1", "Beat 1", { x: 300, y: 40 });
  const s3 = scene("cal-sc-3", "SC-03", { x: 40, y: 60 }, { durationSec: 5, orderIndex: 2 }, "cal-beat-1");
  const nadia = asset("cal-char-1", "Nadia", "character", { x: 40, y: 60 });
  const boss = asset("cal-char-2", "The boss", "character", { x: 40, y: 190 });
  const roof = asset("cal-loc-1", "Rooftop, night", "location", { x: 40, y: 320 });
  const cast = [b1, nadia, boss, roof, s3];

  it("wiring a CHARACTER puts that character FIRST — the canvas draws character_ids[0]", () => {
    const wired = snap(cast, [refWire("cal-char-1", "cal-sc-3", "CHARACTER")]);
    expect(diffForCalliope(snap(cast), wired)).toEqual([{ sceneId: 3, character_ids: [1] }]);
  });

  it("cutting the CHARACTER wire removes THAT character and keeps the rest of the row's list", () => {
    const wired = snap(cast, [refWire("cal-char-1", "cal-sc-3", "CHARACTER")]);
    const rows = new Map([[3, sceneRowFixture(3, { character_ids: [1, 7, 9] })]]);
    // Without the row we could only guess the list was [1]; with it, 7 and 9 survive the cut.
    expect(diffForCalliope(wired, snap(cast), { rows })).toEqual([{ sceneId: 3, character_ids: [7, 9] }]);
    expect(diffForCalliope(wired, snap(cast))).toEqual([{ sceneId: 3, character_ids: [] }]);
  });

  it("re-wiring to another character swaps it to the front and drops only the one it replaced", () => {
    const was = snap(cast, [refWire("cal-char-1", "cal-sc-3", "CHARACTER")]);
    const now = snap(cast, [refWire("cal-char-2", "cal-sc-3", "CHARACTER")]);
    const rows = new Map([[3, sceneRowFixture(3, { character_ids: [1, 7] })]]);
    expect(diffForCalliope(was, now, { rows })).toEqual([{ sceneId: 3, character_ids: [2, 7] }]);
  });

  it("a character already deeper in the list is promoted to the front, not duplicated", () => {
    const now = snap(cast, [refWire("cal-char-2", "cal-sc-3", "CHARACTER")]);
    const rows = new Map([[3, sceneRowFixture(3, { character_ids: [1, 2] })]]);
    const out = diffForCalliope(snap(cast, [refWire("cal-char-1", "cal-sc-3", "CHARACTER")]), now, { rows });
    expect(out).toEqual([{ sceneId: 3, character_ids: [2] }]);
  });

  it("wiring and cutting a LOCATION writes location_id and then null", () => {
    const wired = snap(cast, [refWire("cal-loc-1", "cal-sc-3", "LOCATION")]);
    expect(diffForCalliope(snap(cast), wired)).toEqual([{ sceneId: 3, location_id: 1 }]);
    expect(diffForCalliope(wired, snap(cast))).toEqual([{ sceneId: 3, location_id: null }]);
  });

  it("a wire from a node the editor invented is not a row reference — nothing is written", () => {
    const local = asset("char-mtj5v0c7", "Someone new", "character", { x: 0, y: 0 });
    const wired = snap([...cast, local], [refWire("char-mtj5v0c7", "cal-sc-3", "CHARACTER")]);
    expect(diffForCalliope(snap([...cast, local]), wired)).toEqual([]);
  });

  it("sees a ref through a promoted Beat's rail — the wire that counts is the OUTER half", () => {
    // A scene inside a subgraph is fed by the Beat's inner relay; the real source is outside.
    const bp = boundaryPortId("cal-beat-1", "cal-sc-3:in:CHARACTER");
    const outer: GraphEdge = { id: "lg:outer", source: "cal-char-1", target: "cal-beat-1", sourceHandle: "cal-char-1:out:REF", targetHandle: bp };
    const inner: GraphEdge = { id: "lg:inner", source: "cal-beat-1", target: "cal-sc-3", sourceHandle: innerHandleId(bp), targetHandle: "cal-sc-3:in:CHARACTER" };
    const out = diffForCalliope(snap(cast), snap(cast, [outer, inner]));
    expect(out).toEqual([{ sceneId: 3, character_ids: [1] }]);
    expect(feedOf("cal-sc-3:in:CHARACTER", [outer, inner])?.source).toBe("cal-char-1");
    expect(feedChain("cal-sc-3:in:CHARACTER", [outer, inner]).map((e) => e.id)).toEqual(["lg:inner", "lg:outer"]);
  });
});

describe("diffStoryForCalliope — renaming a Beat or an asset", () => {
  const b1 = beat("cal-beat-1", "Beat 1", { x: 300, y: 40 });
  const nadia = asset("cal-char-1", "Nadia", "character", { x: 40, y: 60 });
  const loc = asset("cal-loc-1", "Rooftop", "location", { x: 40, y: 190 });

  it("a Beat's new title is a beat PATCH; an asset's is a name PATCH", () => {
    const renamed = [{ ...b1, data: { ...b1.data, label: "Beat 1 — The approach" } } as N, { ...nadia, data: { ...nadia.data, label: "Nadia Okoro" } } as N, loc];
    expect(diffStoryForCalliope(snap([b1, nadia, loc]), snap(renamed))).toEqual([
      { kind: "beat", id: 1, title: "Beat 1 — The approach" },
      { kind: "character", id: 1, name: "Nadia Okoro" },
    ]);
  });

  it("ignores scenes (their heading is a scene PATCH), unchanged labels, blanks and invented nodes", () => {
    const s1 = scene("cal-sc-1", "SC-01", { x: 0, y: 0 });
    const local = beat("beat-mtj5v0c7", "Beat 2", { x: 0, y: 0 });
    const next = [
      { ...s1, data: { ...s1.data, label: "SC-01 · Out", heading: "SC-01 · Out" } } as N,
      { ...b1, data: { ...b1.data, label: "   " } } as N,
      { ...local, data: { ...local.data, label: "Renamed" } } as N,
    ];
    expect(diffStoryForCalliope(snap([s1, b1, local]), snap(next))).toEqual([]);
  });
});

describe("applyIntents / applyStoryIntents — the echo rule", () => {
  it("keeps the returned row so the next character_ids diff edits what Calliope has NOW", async () => {
    const { client, calls } = fakeClient({ "scenes.patch": (_p, _id, body) => sceneRowFixture(3, { character_ids: (body as { character_ids: number[] }).character_ids }) });
    const rows = new Map<number, SceneRow>();
    const res = await applyIntents(client, 1, [{ sceneId: 3, character_ids: [2, 7] }], new Map(), rows);
    expect(res).toEqual({ applied: 1, failed: [] });
    expect(calls[0]?.op).toBe("scenes.patch");
    expect(rows.get(3)?.character_ids).toEqual([2, 7]);
  });

  it("reports a character_ids write the row does not echo — a 200 is not evidence", async () => {
    const { client } = fakeClient({ "scenes.patch": () => sceneRowFixture(3, { character_ids: [1] }) });
    const res = await applyIntents(client, 1, [{ sceneId: 3, character_ids: [2] }], new Map());
    expect(res.applied).toBe(0);
    expect(res.failed[0]?.field).toBe("character_ids");
    expect(res.failed[0]?.error).toMatch(/did not apply character_ids=\[2\]/);
  });

  it("reports a location_id Calliope dropped, and a network failure as one", async () => {
    const { client } = fakeClient({ "scenes.patch": () => sceneRowFixture(3, { location_id: 1 }) });
    expect((await applyIntents(client, 1, [{ sceneId: 3, location_id: null }], new Map())).failed[0]?.field).toBe("location_id");
    const dead = fakeClient({
      "scenes.patch": () => {
        throw new Error("fetch failed");
      },
    });
    const res = await applyIntents(dead.client, 1, [{ sceneId: 3, heading: "X" }], new Map());
    expect(res.failed[0]).toMatchObject({ field: "network", error: "fetch failed" });
  });

  it("patches a Beat title and an asset name, and catches a rename the row does not carry", async () => {
    const { client, calls } = fakeClient({
      "beat.patch": (_p, id, body) => ({ id, order_index: 0, title: (body as { title: string }).title, description: null }),
      "character.patch": () => ({ id: 1, name: "Nadia" }),
    });
    const ok = await applyStoryIntents(client, 1, [{ kind: "beat", id: 1, title: "Beat 1 — The approach" }]);
    expect(ok).toEqual({ applied: 1, failed: [] });
    expect(calls[0]).toEqual({ op: "beat.patch", args: [1, 1, { title: "Beat 1 — The approach" }] });
    const bad = await applyStoryIntents(client, 1, [{ kind: "character", id: 1, name: "Nadia Okoro" }]);
    expect(bad.failed[0]?.field).toBe("name");
    expect(bad.failed[0]?.error).toMatch(/did not apply name="Nadia Okoro"/);
  });
});

describe("createSceneRow — the create-then-reorder dance Calliope's own script stage does", () => {
  const existing = [sceneRowFixture(1, { order_index: 0 }), sceneRowFixture(2, { order_index: 1 })];

  it("POSTs with order_index n+1, then reorders the FULL id list, and takes the echoed cut", async () => {
    const { client, calls } = fakeClient({
      "scenes.create": (_p, body) => sceneRowFixture(9, { ...(body as Partial<SceneRow>), id: 9 }),
      "scenes.reorder": (_p, body) => ({ scenes: (body as { scene_ids: number[] }).scene_ids.map((id, i) => sceneRowFixture(id, { order_index: i + 1 })) }),
    });
    const res = await createSceneRow(client, 1, { heading: "SC-09", beat_id: 1, duration_sec: 5 }, existing);
    expect(calls[0]?.op).toBe("scenes.create");
    expect(calls[0]?.args[1]).toMatchObject({ order_index: 3, heading: "SC-09", beat_id: 1, duration_sec: 5 });
    expect(calls[1]).toEqual({ op: "scenes.reorder", args: [1, { scene_ids: [1, 2, 9] }] });
    expect(res.failed).toEqual([]);
    expect(res.rows.map((r) => [r.id, r.order_index])).toEqual([
      [1, 1],
      [2, 2],
      [9, 3],
    ]);
    expect(res.row.id).toBe(9);
  });

  it("PATCHes chain_from_prev after the create — Calliope's create drops that column", async () => {
    const { client, calls } = fakeClient({
      "scenes.create": (_p, body) => sceneRowFixture(9, { ...(body as Partial<SceneRow>), id: 9, chain_from_prev: 0 }),
      "scenes.reorder": (_p, body) => ({ scenes: (body as { scene_ids: number[] }).scene_ids.map((id, i) => sceneRowFixture(id, { order_index: i + 1 })) }),
      "scenes.patch": () => sceneRowFixture(9, { chain_from_prev: 1 }),
    });
    const res = await createSceneRow(client, 1, { heading: "SC-09", beat_id: null, duration_sec: 5, chain_from_prev: true }, existing);
    expect(calls.map((c) => c.op)).toEqual(["scenes.create", "scenes.reorder", "scenes.patch"]);
    expect(calls[2]?.args[2]).toEqual({ chain_from_prev: true });
    expect(res.failed).toEqual([]);
    expect(res.rows.find((r) => r.id === 9)?.chain_from_prev).toBe(1);
  });

  it("echo-checks the create: a heading the row came back without is reported, and the row still exists", async () => {
    const { client } = fakeClient({
      "scenes.create": () => sceneRowFixture(9, { heading: "" }),
      "scenes.reorder": () => ({ scenes: [sceneRowFixture(9, { heading: "", order_index: 1 })] }),
    });
    const res = await createSceneRow(client, 1, { heading: "SC-09", beat_id: null, duration_sec: 5 }, []);
    expect(res.failed[0]?.field).toBe("heading");
    expect(res.failed[0]?.error).toMatch(/did not apply heading/);
    expect(res.row.id).toBe(9);
  });

  it("a reorder that fails leaves the created row and says the cut order did not close up", async () => {
    const { client } = fakeClient({
      "scenes.create": () => sceneRowFixture(9),
      "scenes.reorder": () => {
        throw new Error("500");
      },
    });
    const res = await createSceneRow(client, 1, { heading: "SC-09", beat_id: null, duration_sec: 5 }, existing);
    expect(res.row.id).toBe(9);
    expect(res.failed[0]?.error).toMatch(/reorder after it failed/);
    expect(res.rows.map((r) => r.id)).toEqual([1, 2, 9]);
  });

  it("creates assets and Beats by name, and catches a name the row came back without", async () => {
    const { client, calls } = fakeClient({
      "character.create": (_p, body) => ({ id: 4, name: (body as { name: string }).name }),
      "beat.create": () => ({ id: 5, order_index: 2, title: "not what we asked", description: null }),
    });
    expect(await createAssetRow(client, 1, "character", "Nadia")).toEqual({ id: 4, name: "Nadia", failed: null });
    expect(calls[0]).toEqual({ op: "character.create", args: [1, { name: "Nadia" }] });
    const b = await createBeatRow(client, 1, "Beat 3", 2);
    expect(b.id).toBe(5);
    expect(b.failed).toMatch(/came back titled/);
  });
});

describe("deleteRows — rows first, then one reorder to close the gap", () => {
  const all = [sceneRowFixture(1, { order_index: 0 }), sceneRowFixture(2, { order_index: 1 }), sceneRowFixture(3, { order_index: 2 })];

  it("deletes the scene and reorders the survivors with the full remaining list", async () => {
    const { client, calls } = fakeClient({
      "scenes.delete": () => ({ ok: true }),
      "scenes.reorder": (_p, body) => ({ scenes: (body as { scene_ids: number[] }).scene_ids.map((id, i) => sceneRowFixture(id, { order_index: i + 1 })) }),
    });
    const rep = await deleteRows(client, 1, ["cal-sc-2"], all);
    expect(calls[0]).toEqual({ op: "scenes.delete", args: [1, 2] });
    expect(calls[1]).toEqual({ op: "scenes.reorder", args: [1, { scene_ids: [1, 3] }] });
    expect(rep.deleted).toEqual(["cal-sc-2"]);
    expect(rep.failed).toEqual([]);
    expect(rep.rows?.map((r) => [r.id, r.order_index])).toEqual([
      [1, 1],
      [3, 2],
    ]);
  });

  it("deletes scenes BEFORE the Beat that held them, and assets last", async () => {
    const { client, calls } = fakeClient({
      "scenes.delete": () => ({ ok: true }),
      "beat.delete": () => ({ ok: true }),
      "character.delete": () => ({ ok: true }),
      "scenes.reorder": () => ({ scenes: [sceneRowFixture(1, { order_index: 1 })] }),
    });
    await deleteRows(client, 1, ["cal-char-1", "cal-beat-1", "cal-sc-2", "cal-sc-3"], all);
    expect(calls.map((c) => c.op)).toEqual(["scenes.delete", "scenes.delete", "beat.delete", "character.delete", "scenes.reorder"]);
  });

  it("a row Calliope refuses to delete is NOT reported gone — its node has to stay", async () => {
    const { client } = fakeClient({
      "scenes.delete": (_p, id) => {
        if (id === 3) throw new Error("locked");
        return { ok: true };
      },
      "scenes.reorder": () => ({ scenes: [sceneRowFixture(1, { order_index: 1 })] }),
    });
    const rep = await deleteRows(client, 1, ["cal-sc-2", "cal-sc-3"], all);
    expect(rep.deleted).toEqual(["cal-sc-2"]);
    expect(rep.failed).toEqual([{ nodeId: "cal-sc-3", error: "locked" }]);
    // Only the row that actually went is dropped from the cut the reorder is given.
    expect(rep.rows?.map((r) => r.id)).toEqual([1]);
  });

  it("a row that is ALREADY gone (404) counts as deleted — the node has no row either way", async () => {
    const { client } = fakeClient({
      "scenes.delete": () => {
        throw new CalliopeError("Calliope DELETE → 404", 404, "sceneDelete", null);
      },
      "scenes.reorder": () => ({ scenes: [sceneRowFixture(1, { order_index: 1 }), sceneRowFixture(3, { order_index: 2 })] }),
    });
    const rep = await deleteRows(client, 1, ["cal-sc-2"], all);
    expect(rep.deleted).toEqual(["cal-sc-2"]);
    expect(rep.failed).toEqual([]);
  });

  it("deleting the LAST scene skips the reorder — an empty id list would renumber nothing", async () => {
    const { client, calls } = fakeClient({ "scenes.delete": () => ({ ok: true }) });
    const rep = await deleteRows(client, 1, ["cal-sc-1"], [sceneRowFixture(1, { order_index: 0 })]);
    expect(calls.map((c) => c.op)).toEqual(["scenes.delete"]);
    expect(rep.rows).toEqual([]);
  });

  it("a reorder that fails after the deletes is reported without losing the deletes", async () => {
    const { client } = fakeClient({
      "scenes.delete": () => ({ ok: true }),
      "scenes.reorder": () => {
        throw new Error("500");
      },
    });
    const rep = await deleteRows(client, 1, ["cal-sc-2"], all);
    expect(rep.deleted).toEqual(["cal-sc-2"]);
    expect(rep.reorderError).toBe("500");
  });

  it("ignores nodes the editor invented — they have no row to delete", async () => {
    const { client, calls } = fakeClient({});
    const rep = await deleteRows(client, 1, ["sc-mtj5v0c7", "note-abc"], all);
    expect(calls).toEqual([]);
    expect(rep).toEqual({ deleted: [], failed: [], rows: null, reorderError: null });
  });
});

describe("reidNode — a local id becomes the row's, everywhere it is written", () => {
  it("rewrites the node, its ports, its wires and the parent of its children", () => {
    const s = scene("sc-mtj5v0c7", "New scene", { x: 10, y: 20 });
    const nadia = asset("cal-char-1", "Nadia", "character", { x: 0, y: 0 });
    const edges: GraphEdge[] = [refWire("cal-char-1", "sc-mtj5v0c7", "CHARACTER")];
    const out = reidNode([nadia, s], edges, "sc-mtj5v0c7", "cal-sc-9");
    const moved = out.nodes.find((n) => n.id === "cal-sc-9");
    expect(moved).toBeDefined();
    expect((moved?.data as SceneData).ports.map((p) => p.id)).toContain("cal-sc-9:in:CHARACTER");
    expect((moved?.data as SceneData).ports.every((p) => p.id.startsWith("cal-sc-9:"))).toBe(true);
    expect(out.edges[0]).toMatchObject({ source: "cal-char-1", target: "cal-sc-9", targetHandle: "cal-sc-9:in:CHARACTER", id: "lg:cal-char-1:out:REF->cal-sc-9:in:CHARACTER" });
    // Nothing else is touched.
    expect(out.nodes.find((n) => n.id === "cal-char-1")).toBe(nadia);
  });

  it("does not rewrite a DIFFERENT node whose id merely starts the same way", () => {
    // `cal-sc-1` is a prefix of `cal-sc-12`: a plain substring replace would rename both, and
    // the edge between them would end up pointing at a node that does not exist.
    const one = scene("cal-sc-1", "SC-01", { x: 0, y: 0 });
    const twelve = scene("cal-sc-12", "SC-12", { x: 0, y: 0 });
    const edges: GraphEdge[] = [chain("cal-sc-1", "cal-sc-12"), chain("cal-sc-12", "cal-sc-1")];
    const out = reidNode([one, twelve], edges, "cal-sc-1", "cal-sc-99");
    expect(out.nodes.map((n) => n.id)).toEqual(["cal-sc-99", "cal-sc-12"]);
    expect(out.edges[0]).toMatchObject({ source: "cal-sc-99", target: "cal-sc-12", id: "lg:cal-sc-99:out:LAST FRAME->cal-sc-12:in:IN FRAME" });
    expect(out.edges[1]).toMatchObject({ source: "cal-sc-12", target: "cal-sc-99", id: "lg:cal-sc-12:out:LAST FRAME->cal-sc-99:in:IN FRAME" });
    expect((out.nodes[1]?.data as SceneData).ports.every((p) => p.id.startsWith("cal-sc-12:"))).toBe(true);
  });

  it("rewrites a container's boundary ports and its children's parentId", () => {
    const local = beat("beat-mtj5v0c7", "Beat 3", { x: 0, y: 0 });
    const bp = boundaryPortId("beat-mtj5v0c7", "cal-sc-3:in:CHARACTER");
    const container = {
      ...local,
      data: { ...local.data, promotedIn: [{ id: bp, childId: "cal-sc-3", childPortId: "cal-sc-3:in:CHARACTER", type: "ref", label: "CHARACTER" }], promotedOut: [] },
    } as N;
    const child = scene("cal-sc-3", "SC-03", { x: 10, y: 10 }, {}, "beat-mtj5v0c7");
    const edges: GraphEdge[] = [{ id: "lg:outer", source: "cal-char-1", target: "beat-mtj5v0c7", sourceHandle: "cal-char-1:out:REF", targetHandle: bp }];
    const out = reidNode([container, child], edges, "beat-mtj5v0c7", "cal-beat-7");
    expect(out.nodes.find((n) => n.id === "cal-beat-7")).toBeDefined();
    expect(out.nodes.find((n) => n.id === "cal-sc-3")?.parentId).toBe("cal-beat-7");
    const rails = out.nodes.find((n) => n.id === "cal-beat-7")?.data as { promotedIn: { id: string; childPortId: string }[] };
    expect(rails.promotedIn[0]?.id).toBe(boundaryPortId("cal-beat-7", "cal-sc-3:in:CHARACTER"));
    // The child half of the rail names a node that did NOT move: it must survive untouched.
    expect(rails.promotedIn[0]?.childPortId).toBe("cal-sc-3:in:CHARACTER");
    expect(out.edges[0]?.targetHandle).toBe(boundaryPortId("cal-beat-7", "cal-sc-3:in:CHARACTER"));
  });
});

describe("withOrderIndexes / withoutDeadRows", () => {
  it("restamps every Calliope scene from the cut a reorder echoed", () => {
    const s1 = scene("cal-sc-1", "SC-01", { x: 0, y: 0 }, { orderIndex: 0 });
    const local = scene("sc-mtj5v0c7", "New scene", { x: 0, y: 0 }, { orderIndex: 0 });
    const out = withOrderIndexes([s1, local], [sceneRowFixture(1, { order_index: 1 })]);
    expect((out[0]?.data as SceneData).orderIndex).toBe(1);
    // A node with no row keeps whatever it had; there is nothing to say about it.
    expect(out[1]).toBe(local);
  });

  it("keeps a node whose row is gone OUT of an undo, together with its children", () => {
    const b = beat("cal-beat-1", "Beat 1", { x: 0, y: 0 });
    const inside = scene("cal-sc-1", "SC-01", { x: 0, y: 0 }, {}, "cal-beat-1");
    const other = scene("cal-sc-2", "SC-02", { x: 0, y: 0 });
    const edges = [chain("cal-sc-1", "cal-sc-2")];
    const out = withoutDeadRows({ nodes: [b, inside, other], edges }, new Set(["cal-beat-1"]));
    expect(out.nodes.map((n) => n.id)).toEqual(["cal-sc-2"]);
    expect(out.edges).toEqual([]);
    expect([...out.stripped].sort()).toEqual(["cal-beat-1", "cal-sc-1"]);
  });

  it("leaves a snapshot alone when nothing died", () => {
    const s1 = scene("cal-sc-1", "SC-01", { x: 0, y: 0 });
    const out = withoutDeadRows({ nodes: [s1], edges: [] }, new Set());
    expect(out.nodes).toEqual([s1]);
    expect(out.stripped).toEqual([]);
  });
});
