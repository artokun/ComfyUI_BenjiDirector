import { describe, expect, it } from "vitest";
import type { BeatRow, CharacterRow, SceneRow, WorkflowRow } from "@benjidirector/calliope-client";
import { verifyEcho } from "../calliope-sync.js";
import {
  CHARACTER_KEYS,
  PLACE_KEYS,
  SCENE_CLEARABLE,
  beatForm,
  beatPatch,
  chainWarning,
  echoMismatch,
  isFirstScene,
  parseDuration,
  promptDraftOf,
  remainingOrder,
  sceneForm,
  sceneIntent,
  scenePatch,
  textDiff,
  textForm,
  videoWorkflows,
} from "./forms.js";

// The row shape Calliope 1.2.1 returns (copied from calliope-bind.test.ts).
const sceneRow = (extra: Partial<SceneRow> = {}): SceneRow => ({
  id: 1,
  project_id: 1,
  beat_id: 1,
  order_index: 0,
  heading: "SC-01",
  action: "She climbs.",
  dialog: null,
  duration_sec: 5,
  workflow_id: 7,
  env_image_path: "/data/env.png",
  location_id: 1,
  video_path: null,
  chain_from_prev: 0,
  character_ids: [1, 2],
  video_settings: null,
  ...extra,
});

describe("scenePatch — the dirty diff", () => {
  it("a form seeded from the row is a no-op: no PATCH at all", () => {
    const row = sceneRow();
    expect(scenePatch(row, sceneForm(row))).toBeNull();
    // Same set of characters in another order is still the same set.
    expect(scenePatch(row, { ...sceneForm(row), character_ids: [2, 1] })).toBeNull();
  });

  it("sends only the fields that changed", () => {
    const row = sceneRow();
    expect(scenePatch(row, { ...sceneForm(row), action: "She climbs out.", duration_sec: "8" })).toEqual({ action: "She climbs out.", duration_sec: 8 });
  });

  it("an explicit null goes out ONLY for the clearable columns", () => {
    const row = sceneRow();
    const cleared = scenePatch(row, { ...sceneForm(row), action: "", beat_id: null, location_id: null, workflow_id: null, env_image_path: null });
    expect(cleared).toEqual({ action: null, beat_id: null, location_id: null, workflow_id: null, env_image_path: null });
    for (const k of Object.keys(cleared ?? {})) expect(SCENE_CLEARABLE).toContain(k);
    // A dialog emptied is a dialog cleared.
    expect(scenePatch(sceneRow({ dialog: "NADIA\nHello." }), { ...sceneForm(sceneRow({ dialog: "NADIA\nHello." })), dialog: "" })).toEqual({ dialog: null });
  });

  it("never nulls heading or duration — an empty duration is omitted, an empty heading is a string", () => {
    const row = sceneRow();
    expect(scenePatch(row, { ...sceneForm(row), duration_sec: "" })).toBeNull();
    expect(scenePatch(row, { ...sceneForm(row), duration_sec: "0" })).toBeNull();
    expect(scenePatch(row, { ...sceneForm(row), duration_sec: "abc" })).toBeNull();
    const p = scenePatch(row, { ...sceneForm(row), heading: "" });
    expect(p).toEqual({ heading: "" });
    expect(p && "heading" in p && p.heading).not.toBeNull();
  });

  it("character_ids is a set replace: the whole list, de-duplicated, when membership changes", () => {
    const row = sceneRow();
    expect(scenePatch(row, { ...sceneForm(row), character_ids: [2] })).toEqual({ character_ids: [2] });
    expect(scenePatch(row, { ...sceneForm(row), character_ids: [1, 2, 3, 3] })).toEqual({ character_ids: [1, 2, 3] });
    expect(scenePatch(row, { ...sceneForm(row), character_ids: [] })).toEqual({ character_ids: [] });
  });

  it("chain_from_prev compares as a boolean whatever the row stores", () => {
    expect(scenePatch(sceneRow({ chain_from_prev: 1 }), { ...sceneForm(sceneRow({ chain_from_prev: 1 })), chain_from_prev: true })).toBeNull();
    expect(scenePatch(sceneRow({ chain_from_prev: 0 }), { ...sceneForm(sceneRow()), chain_from_prev: true })).toEqual({ chain_from_prev: true });
  });

  it("the intent built from the body is what verifyEcho checks the returned row against", () => {
    const row = sceneRow();
    const body = scenePatch(row, { ...sceneForm(row), action: "", character_ids: [2], chain_from_prev: true })!;
    const it_ = sceneIntent(row.id, body);
    expect(it_).toEqual({ sceneId: 1, action: null, character_ids: [2], chain_from_prev: true });
    // A server that dropped the null (Calliope before the fork) is caught by the echo.
    expect(verifyEcho(it_, sceneRow({ character_ids: [2], chain_from_prev: 1 }))?.field).toBe("action");
    expect(verifyEcho(it_, sceneRow({ action: null, character_ids: [2], chain_from_prev: true }))).toBeNull();
  });

  it("parseDuration accepts integers ≥ 1 only", () => {
    expect(parseDuration(" 12 ")).toBe(12);
    expect(parseDuration("1")).toBe(1);
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("1.5")).toBeNull();
    expect(parseDuration("-3")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("scene helpers", () => {
  const scenes = [
    { id: 3, order_index: 2 },
    { id: 1, order_index: 0 },
    { id: 2, order_index: 1 },
  ];
  it("the first scene in the cut cannot chain", () => {
    expect(isFirstScene({ id: 1, order_index: 0 }, scenes)).toBe(true);
    expect(isFirstScene({ id: 2, order_index: 1 }, scenes)).toBe(false);
    expect(isFirstScene({ id: 9, order_index: 0 }, [])).toBe(true);
  });
  it("deleting a scene reorders the rest in cut order", () => {
    expect(remainingOrder(scenes, 2)).toEqual([1, 3]);
    expect(remainingOrder(scenes, 1)).toEqual([2, 3]);
  });
  const wf = (id: number, name: string, roles: Array<string | null>, extra: Partial<WorkflowRow> = {}): WorkflowRow => ({
    id,
    name,
    kind: "video",
    is_enabled: true,
    prompt_profile: "prose",
    description: null,
    input_schema: roles.map((role, i) => ({ nodeId: String(i), label: role ?? "x", role, kind: "text" })),
    output_schema: [],
    ...extra,
  });
  it("warns when the chosen workflow has no video input to chain into", () => {
    const wfs = [wf(7, "I2V", ["prompt", "video"]), wf(8, "T2V", ["prompt"])];
    expect(chainWarning({ chain_from_prev: true, workflow_id: 8 }, wfs)).toMatch(/T2V.*no video input/);
    expect(chainWarning({ chain_from_prev: true, workflow_id: 7 }, wfs)).toBeNull();
    expect(chainWarning({ chain_from_prev: false, workflow_id: 8 }, wfs)).toBeNull();
    expect(chainWarning({ chain_from_prev: true, workflow_id: null }, wfs)).toBeNull();
    expect(chainWarning({ chain_from_prev: true, workflow_id: 99 }, wfs)).toBeNull();
  });
  it("offers enabled video workflows only", () => {
    const wfs = [wf(7, "I2V", ["video"]), wf(8, "off", ["video"], { is_enabled: false }), wf(9, "img", [], { kind: "image" })];
    expect(videoWorkflows(wfs).map((w) => w.id)).toEqual([7]);
  });
  it("reads the prompt draft and its freshness hash out of video_settings", () => {
    expect(promptDraftOf({ video_settings: null })).toEqual({ text: "", basedOn: null, authoredBy: null, savedAt: null });
    expect(promptDraftOf({ video_settings: { prompt_draft: "A roof at night.", prompt_draft_meta: { based_on: "abcd", authored_by: "benjidirector" } } })).toEqual({ text: "A roof at night.", basedOn: "abcd", authoredBy: "benjidirector", savedAt: null });
  });
});

describe("beatPatch", () => {
  const row: BeatRow = { id: 1, order_index: 0, title: "Beat 1", description: null };
  it("no-op → null; changed fields only; a blank title is not sent", () => {
    expect(beatPatch(row, beatForm(row))).toBeNull();
    expect(beatPatch(row, { ...beatForm(row), description: "The approach." })).toEqual({ description: "The approach." });
    expect(beatPatch(row, { ...beatForm(row), title: "  " })).toBeNull();
    expect(beatPatch(row, { ...beatForm(row), title: "Beat 1 — The approach", order_index: "2" })).toEqual({ title: "Beat 1 — The approach", order_index: 2 });
    expect(beatPatch(row, { ...beatForm(row), order_index: "-1" })).toBeNull();
  });
});

describe("textDiff — characters, locations, items", () => {
  const row: CharacterRow = { id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" };
  it("seeds nulls as empty strings and diffs to strings, never null", () => {
    const form = textForm(row as unknown as Record<string, unknown>, CHARACTER_KEYS);
    expect(form).toEqual({ name: "Nadia", role: "", age: "", appearance: "", personality: "", consistency_prompt: "same woman" });
    expect(textDiff(form, form, CHARACTER_KEYS)).toBeNull();
    expect(textDiff(form, { ...form, role: "lead", consistency_prompt: "" }, CHARACTER_KEYS)).toEqual({ role: "lead", consistency_prompt: "" });
    // The server drops None, so a "" is the only way to empty a column; it must not become null.
    const d = textDiff(form, { ...form, appearance: "" }, CHARACTER_KEYS);
    expect(d).toBeNull(); // unchanged ("" → "")
  });
  it("refuses to blank a required name", () => {
    const form = textForm(row as unknown as Record<string, unknown>, CHARACTER_KEYS);
    expect(textDiff(form, { ...form, name: " " }, CHARACTER_KEYS)).toBeNull();
    const place = textForm({ id: 2, name: "Rooftop", description: null, consistency_prompt: null }, PLACE_KEYS);
    expect(textDiff(place, { ...place, name: "", description: "night" }, PLACE_KEYS)).toEqual({ description: "night" });
  });
  it("echoMismatch names the first field the row disagrees with", () => {
    expect(echoMismatch({ role: "lead" }, { ...row, role: "lead" })).toBeNull();
    expect(echoMismatch({ role: "lead", age: "30" }, { ...row, role: "lead" })).toMatch(/did not apply age="30"/);
  });
});
