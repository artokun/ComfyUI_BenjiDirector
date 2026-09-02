import { describe, expect, it } from "vitest";
import type { JobRow, SceneRow, WorkflowRow } from "@benjidirector/calliope-client";
import type { DynamicInput } from "./dynamic-form/types.js";
import {
  batchTargets,
  clipSourceOptions,
  copyableValues,
  doneCount,
  draftOf,
  enabledVideoWorkflows,
  formatClock,
  formatTime,
  hydrateValues,
  isDraftStale,
  isLongError,
  jobHistory,
  latestVideoJob,
  mergeVideoSettings,
  payloadPrompt,
  parseTime,
  payloadRows,
  previewPath,
  proseFallback,
  resolveClipSource,
  seedSceneValues,
  settingsHash,
  statusOf,
  storedInputValues,
  thumbFor,
  totalSeconds,
  workflowFor,
} from "./render-state.js";

// Row shapes as Calliope 1.2.1 returned them (see calliope-bind.test.ts).
const scene = (id: number, extra: Partial<SceneRow> = {}): SceneRow => ({
  id,
  project_id: 1,
  beat_id: 1,
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
  ...extra,
});
const job = (id: number, scene_id: number, status: JobRow["status"], extra: Partial<JobRow> = {}): JobRow => ({
  id,
  project_id: 1,
  scene_id,
  kind: "video",
  workflow_id: 7,
  status,
  payload: {},
  output_paths: [],
  error: null,
  created_at: "2026-09-01T00:00:00Z",
  started_at: null,
  completed_at: null,
  retry_count: 0,
  ...extra,
});
const inp = (nodeId: string, role: string | null, kind: DynamicInput["kind"] = "text", defaultValue?: unknown): DynamicInput => ({ nodeId, label: nodeId, role, kind, required: true, defaultValue });

describe("latestVideoJob / statusOf", () => {
  const jobs = [job(1, 2, "failed"), job(3, 2, "done", { output_paths: ["/out/a.mp4"] }), job(2, 3, "running"), job(4, 3, "pending"), job(5, 2, "done", { kind: "image" })];
  it("takes the highest-id VIDEO job of the scene", () => {
    expect(latestVideoJob(jobs, 2)?.id).toBe(3);
    expect(latestVideoJob(jobs, 3)?.id).toBe(4);
    expect(latestVideoJob(jobs, 9)).toBeUndefined();
  });
  it("status is the latest job's, else done when a clip exists, else idle", () => {
    expect(statusOf(scene(2), jobs)).toBe("done");
    expect(statusOf(scene(3), jobs)).toBe("pending");
    expect(statusOf(scene(4, { video_path: "/out/b.mp4" }), jobs)).toBe("done");
    expect(statusOf(scene(4), jobs)).toBe("idle");
    expect(statusOf(scene(2), [job(9, 2, "cancelled")])).toBe("idle");
  });
  it("counts finished clips and the cut's total length", () => {
    expect(doneCount([scene(2), scene(3), scene(4, { video_path: "/b.mp4" })], jobs)).toBe(2);
    expect(totalSeconds([scene(1, { duration_sec: 8 }), scene(2, { duration_sec: null }), scene(3, { duration_sec: 0 })])).toBe(18);
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(599.6)).toBe("10:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("previewPath", () => {
  it("hides the old clip while a new job is queued or running", () => {
    const s = scene(2, { video_path: "/old.mp4" });
    expect(previewPath(s, [job(1, 2, "pending")])).toBeNull();
    expect(previewPath(s, [job(1, 2, "running")])).toBeNull();
  });
  it("a finished job's own mp4/webm wins over the row", () => {
    const s = scene(2, { video_path: "/old.mp4" });
    expect(previewPath(s, [job(1, 2, "done", { output_paths: ["/x.png", "/new.webm"] })])).toBe("/new.webm");
    // A done job with no playable output falls back to the row.
    expect(previewPath(s, [job(1, 2, "done", { output_paths: ["/frames.png"] })])).toBe("/old.mp4");
  });
  it("only browser-playable containers are previewed", () => {
    expect(previewPath(scene(2, { video_path: "/clip.mov" }), [])).toBeNull();
    expect(previewPath(scene(2, { video_path: "/clip.MP4" }), [])).toBe("/clip.MP4");
    expect(previewPath(scene(2), [])).toBeNull();
    expect(previewPath(scene(2, { video_path: "/old.mp4" }), [job(1, 2, "failed")])).toBe("/old.mp4");
  });
});

describe("thumbFor", () => {
  it("environment still first, then the clip, then a slate", () => {
    expect(thumbFor(scene(1, { env_image_path: "/env.png", video_path: "/c.mp4" }), [])).toEqual({ kind: "image", path: "/env.png" });
    expect(thumbFor(scene(1, { video_path: "/c.mp4" }), [])).toEqual({ kind: "video", path: "/c.mp4" });
    expect(thumbFor(scene(1, { video_path: "/c.mp4" }), [job(1, 1, "running")])).toBeNull();
    expect(thumbFor(scene(1), [])).toBeNull();
  });
});

describe("mergeVideoSettings", () => {
  const existing = {
    director: { position: { x: 40, y: 60 }, promoted: true },
    prompt_draft: "A quiet rooftop at night.",
    prompt_draft_meta: { based_on: "abc123", authored_by: "benjidirector" },
    input_values: { "10": "old prompt", "14": 5 },
    clip_source: "3",
    form_workflow_id: 7,
  };
  it("keeps director and the prompt draft while replacing input_values", () => {
    const out = mergeVideoSettings(existing, { input_values: { "10": "new prompt", "14": 8, "11": "" } });
    expect(out.director).toEqual(existing.director);
    expect(out.prompt_draft).toBe(existing.prompt_draft);
    expect(out.prompt_draft_meta).toEqual(existing.prompt_draft_meta);
    expect(out.input_values).toEqual({ "10": "new prompt", "14": 8 });
    // Keys not mentioned are untouched.
    expect(out.clip_source).toBe("3");
    expect(out.form_workflow_id).toBe(7);
  });
  it("auto clip source and a null workflow REMOVE their key; a real value sets it", () => {
    expect(mergeVideoSettings(existing, { input_values: {}, clip_source: "auto", form_workflow_id: null })).not.toHaveProperty("clip_source");
    expect(mergeVideoSettings(existing, { input_values: {}, clip_source: null })).not.toHaveProperty("form_workflow_id", null);
    expect(mergeVideoSettings(existing, { input_values: {}, clip_source: "upload", form_workflow_id: 9 })).toMatchObject({ clip_source: "upload", form_workflow_id: 9 });
  });
  it("starts from an empty object when the row has none", () => {
    expect(mergeVideoSettings(null, { input_values: { a: 1 } })).toEqual({ input_values: { a: 1 } });
    expect(mergeVideoSettings(undefined, { input_values: {} })).toEqual({ input_values: {} });
  });
  it("does not mutate the input", () => {
    const copy = JSON.parse(JSON.stringify(existing));
    mergeVideoSettings(existing, { input_values: { z: 1 }, clip_source: "auto" });
    expect(existing).toEqual(copy);
  });
});

describe("settingsHash", () => {
  it("is order-independent so a refetch never looks like a change", () => {
    expect(settingsHash({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(settingsHash({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }));
    expect(settingsHash({ a: 1 })).not.toBe(settingsHash({ a: 2 }));
  });
});

describe("hydrating the form", () => {
  const inputs = [inp("10", "prompt", "textarea", "example"), inp("14", "seconds", "number", 3), inp("15", "seed", "number", 0), inp("12", "width", "number", 1280)];
  it("seeds every duration-role input from the scene's duration_sec (aliases too)", () => {
    expect(seedSceneValues(scene(1, { duration_sec: 8 }), inputs)).toEqual({ "14": 8 });
    expect(seedSceneValues(scene(1, { duration_sec: null }), inputs)).toEqual({});
  });
  it("stored values beat the seed, the seed beats the workflow default, blanks are dropped", () => {
    const stored = { input_values: { "10": "the real prompt", "15": "", "12": 1920 } };
    expect(hydrateValues(scene(1, { duration_sec: 8 }), inputs, stored)).toEqual({ "10": "the real prompt", "14": 8, "15": 0, "12": 1920 });
    expect(hydrateValues(scene(1, { duration_sec: 8 }), inputs, { input_values: { "14": 12 } })).toEqual({ "10": "example", "14": 12, "15": 0, "12": 1280 });
    expect(hydrateValues(scene(1), inputs, null)).toEqual({ "10": "example", "14": 5, "15": 0, "12": 1280 });
  });
  it("ignores malformed stored values", () => {
    expect(storedInputValues({ input_values: "nope" })).toEqual({});
    expect(storedInputValues({ input_values: [1, 2] })).toEqual({});
    expect(storedInputValues(null)).toEqual({});
  });
});

describe("workflowFor", () => {
  const wf = (id: number, kind: WorkflowRow["kind"] = "video", is_enabled = true): WorkflowRow => ({ id, name: `wf${id}`, kind, is_enabled, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] });
  const enabled = [wf(1), wf(2), wf(3)];
  it("session pick → saved form pick → row → first enabled", () => {
    expect(workflowFor(scene(1, { workflow_id: 3 }), enabled, 2, { form_workflow_id: 3 })?.id).toBe(2);
    expect(workflowFor(scene(1, { workflow_id: 3 }), enabled, null, { form_workflow_id: 2 })?.id).toBe(2);
    expect(workflowFor(scene(1, { workflow_id: 3 }), enabled, null, null)?.id).toBe(3);
    expect(workflowFor(scene(1), enabled, null, null)?.id).toBe(1);
    expect(workflowFor(scene(1), [], null, null)).toBeUndefined();
  });
  it("an id that is no longer enabled falls through", () => {
    expect(workflowFor(scene(1, { workflow_id: 99 }), enabled, 98, { form_workflow_id: 97 })?.id).toBe(1);
  });
  it("prefers video workflows, and falls back to any enabled one", () => {
    expect(enabledVideoWorkflows([wf(1, "image"), wf(2, "video", false), wf(3)]).map((w) => w.id)).toEqual([3]);
    expect(enabledVideoWorkflows([wf(1, "image"), wf(2, "video", false)]).map((w) => w.id)).toEqual([1]);
  });
});

describe("continue-from-previous clip source", () => {
  const scenes = [scene(3, { video_path: "/c3.mp4" }), scene(1, { video_path: "/c1.mp4" }), scene(2), scene(4, { video_path: "/c4.mp4" })];
  it("offers the other scenes that have a clip, in cut order", () => {
    expect(clipSourceOptions(scene(3), scenes).map((s) => s.id)).toEqual([1, 4]);
  });
  it("a stored source that names a vanished clip falls back to auto", () => {
    const opts = clipSourceOptions(scene(3), scenes);
    expect(resolveClipSource("4", opts)).toBe("4");
    expect(resolveClipSource("2", opts)).toBe("auto");
    expect(resolveClipSource("upload", opts)).toBe("upload");
    expect(resolveClipSource(null, opts)).toBe("auto");
  });
});

describe("prompts", () => {
  it("a draft is stale only when Calliope resolved it against a different hash", () => {
    expect(isDraftStale(true, "aaa", "bbb")).toBe(true);
    expect(isDraftStale(true, "aaa", "aaa")).toBe(false);
    expect(isDraftStale(false, "aaa", "bbb")).toBe(false);
    expect(isDraftStale(true, null, "bbb")).toBe(false);
    expect(isDraftStale(true, "aaa", "")).toBe(false);
  });
  it("reads the saved draft and its hash", () => {
    expect(draftOf({ prompt_draft: "x", prompt_draft_meta: { based_on: "h" } })).toEqual({ prompt: "x", based_on: "h" });
    expect(draftOf({ prompt_draft: "x" })).toEqual({ prompt: "x", based_on: null });
    expect(draftOf({ prompt_draft: "  " })).toBeNull();
    expect(draftOf(null)).toBeNull();
  });
  it("the prose fallback is the scene's own text", () => {
    expect(proseFallback(scene(1, { heading: "INT. ROOF", action: " She waits. ", dialog: null }))).toBe("INT. ROOF\n\nShe waits.");
    expect(proseFallback(scene(1, { heading: "" }))).toBe("");
  });
  it("a long error hides behind Show details", () => {
    expect(isLongError("short")).toBe(false);
    expect(isLongError("x".repeat(141))).toBe(true);
    expect(isLongError("a\nb\nc\nd")).toBe(true);
    expect(isLongError(null)).toBe(false);
  });
});

describe("batchTargets", () => {
  const scenes = [scene(3), scene(1, { video_path: "/c1.mp4" }), scene(2)];
  it("generates the missing ones in cut order, skipping anything queued", () => {
    const r = batchTargets(scenes, [job(1, 2, "pending")]);
    expect(r.mode).toBe("missing");
    expect(r.targets.map((s) => s.id)).toEqual([3]);
  });
  it("a failed scene counts as missing", () => {
    const r = batchTargets(scenes, [job(1, 2, "failed")]);
    expect(r.targets.map((s) => s.id)).toEqual([2, 3]);
  });
  it("when every scene has a clip it becomes Regenerate all, still skipping in-flight ones", () => {
    const all = [scene(2, { video_path: "/2.mp4" }), scene(1, { video_path: "/1.mp4" }), scene(3, { video_path: "/3.mp4" })];
    const r = batchTargets(all, [job(1, 3, "running")]);
    expect(r.mode).toBe("redo-all");
    expect(r.targets.map((s) => s.id)).toEqual([1, 2]);
  });
});

describe("job history + payloads", () => {
  const inputs = [inp("10", "prompt", "textarea"), inp("16", "character", "image"), inp("14", "duration", "number")];
  const j = job(5, 2, "done", { payload: { prompt: "  the prompt ", input_values: { "10": "the prompt", "16": "/sheets/nadia.png", "14": 6, "99": "", "77": null } } });
  it("lists the newest 20 video jobs with a payload", () => {
    const many = Array.from({ length: 25 }, (_, i) => job(i + 1, 2, "done"));
    const h = jobHistory([...many, job(99, 3, "done"), job(100, 2, "done", { kind: "image" })], 2);
    expect(h).toHaveLength(20);
    expect(h[0]?.id).toBe(25);
    expect(h[19]?.id).toBe(6);
  });
  it("labels payload values by the schema and drops empties", () => {
    // Integer-like keys enumerate in ascending order — payload order is the node id order.
    expect(payloadRows(j, inputs)).toEqual([
      { nodeId: "10", label: "10", role: "prompt", value: "the prompt" },
      { nodeId: "14", label: "14", role: "duration", value: "6" },
      { nodeId: "16", label: "16", role: "character", value: "/sheets/nadia.png" },
    ]);
    expect(payloadRows(job(1, 1, "done"), inputs)).toEqual([]);
  });
  it("copies only strings and numbers back to the form", () => {
    expect(copyableValues(j)).toEqual({ "10": "the prompt", "16": "/sheets/nadia.png", "14": 6, "99": "" });
    expect(copyableValues(null)).toEqual({});
  });
  it("reads the prompt the job actually sent", () => {
    expect(payloadPrompt(j)).toBe("  the prompt ");
    expect(payloadPrompt(job(1, 1, "done", { payload: { prompt: "  " } }))).toBeNull();
  });
});

describe("parseTime", () => {
  it("reads Calliope's ZONELESS SQLite timestamps as UTC, not local", () => {
    // "2026-09-01 10:00:00" is what CURRENT_TIMESTAMP writes, and it is UTC.
    expect(parseTime("2026-09-01 10:00:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T10:00:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T10:00:00.500")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0, 500));
  });
  it("leaves a stamp that already carries a zone alone", () => {
    expect(parseTime("2026-09-01T10:00:00Z")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T12:00:00+02:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T05:00:00-05:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
  });
  it("is NaN for nothing, and formatTime shows nothing rather than “Invalid Date”", () => {
    expect(parseTime(null)).toBeNaN();
    expect(parseTime("  ")).toBeNaN();
    expect(formatTime(null)).toBe("");
    expect(formatTime("not a date")).toBe("");
    expect(formatTime("2026-09-01 10:00:00")).toBe(new Date(Date.UTC(2026, 8, 1, 10, 0, 0)).toLocaleString());
  });
});
