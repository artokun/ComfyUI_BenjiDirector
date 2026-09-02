import { describe, expect, it } from "vitest";
import type { JobRow, UploadRow, WorkflowRow } from "@benjidirector/calliope-client";
import {
  attachPayload,
  attachableProjects,
  defaultMiscName,
  defaultMode,
  deletePrompt,
  deleteSummary,
  fileName,
  formatBytes,
  isBusy,
  isVideoPath,
  mediaInputFor,
  mediaKindOf,
  pickWorkflow,
  readyCount,
  statusWord,
  targetsFor,
  toDynamicInputs,
  uploadOptions,
  workflowsFor,
} from "./attach.js";

const PATH = "C:/calliope/assets/playground/7/0a1b2c3d-fox_plush.png";

describe("attachPayload", () => {
  it("builds exactly the keys a character sheet needs", () => {
    const r = attachPayload("character_sheet", { project_id: 1, character_id: 1 }, PATH);
    expect(r).toEqual({ ok: true, payload: { path: PATH, project_id: 1, target: "character_sheet", character_id: 1 } });
  });

  it("a location carries location_id and nothing else", () => {
    const r = attachPayload("location", { project_id: 1, location_id: 4, character_id: 9 }, PATH);
    expect(r).toEqual({ ok: true, payload: { path: PATH, project_id: 1, target: "location", location_id: 4 } });
  });

  it("a scene carries scene_id", () => {
    const r = attachPayload("scene", { project_id: 2, scene_id: 11 }, "C:/x/clip.mp4");
    expect(r).toEqual({ ok: true, payload: { path: "C:/x/clip.mp4", project_id: 2, target: "scene", scene_id: 11 } });
  });

  it("an item takes a trimmed name and never an id", () => {
    expect(attachPayload("item", { project_id: 1, character_id: 1 }, PATH, "  Fox plush ")).toEqual({
      ok: true,
      payload: { path: PATH, project_id: 1, target: "item", name: "Fox plush" },
    });
    // A blank name is omitted so the server derives one from the file, as Calliope's UI does.
    expect(attachPayload("item", { project_id: 1 }, PATH, "   ")).toEqual({ ok: true, payload: { path: PATH, project_id: 1, target: "item" } });
    expect(attachPayload("item", { project_id: 1 }, PATH)).toEqual({ ok: true, payload: { path: PATH, project_id: 1, target: "item" } });
  });

  it("refuses without a project, a path, or the id the target needs", () => {
    expect(attachPayload("character_sheet", { project_id: null, character_id: 1 }, PATH)).toEqual({ ok: false, error: "Pick a project" });
    expect(attachPayload("character_sheet", { project_id: 1 }, "")).toEqual({ ok: false, error: "Nothing to attach" });
    expect(attachPayload("character_sheet", { project_id: 1 }, PATH)).toEqual({ ok: false, error: "Pick a character" });
    expect(attachPayload("location", { project_id: 1 }, PATH)).toEqual({ ok: false, error: "Pick a location" });
    expect(attachPayload("scene", { project_id: 1 }, PATH)).toEqual({ ok: false, error: "Pick a scene" });
    expect(attachPayload("bogus" as never, { project_id: 1 }, PATH).ok).toBe(false);
  });

  it("never sends item_id — the server ignores it and always inserts", () => {
    const r = attachPayload("item", { project_id: 1 }, PATH, "x");
    expect(r.ok && "item_id" in r.payload).toBe(false);
  });
});

describe("targets and media kind", () => {
  it("offers Scene for a clip and the three image targets otherwise", () => {
    expect(targetsFor(true).map((t) => t.id)).toEqual(["scene"]);
    expect(targetsFor(false).map((t) => t.id)).toEqual(["character_sheet", "location", "item"]);
  });

  it("reads video from the job kind or the extension", () => {
    expect(isVideoPath("a/b.png", "image")).toBe(false);
    expect(isVideoPath("a/b.png", "video")).toBe(true);
    expect(isVideoPath("a/b.MP4", null)).toBe(true);
    expect(isVideoPath("a/b.webm")).toBe(true);
    expect(mediaKindOf("a/b.mov")).toBe("video");
    expect(mediaKindOf("a/b.webp", "image")).toBe("image");
  });
});

describe("naming", () => {
  it("strips the upload prefix and separators for a misc. item name", () => {
    expect(defaultMiscName(PATH)).toBe("fox plush");
    expect(defaultMiscName("C:\\out\\deadbeef-red_car-v2.png")).toBe("red car v2");
    expect(defaultMiscName("/out/deadbeef-.png")).toBe("deadbeef");
    expect(defaultMiscName("")).toBe("New item");
  });

  it("fileName handles both slashes", () => {
    expect(fileName("C:\\a\\b\\c.png")).toBe("c.png");
    expect(fileName("/a/b/c.png")).toBe("c.png");
    expect(fileName("c.png")).toBe("c.png");
  });

  it("statusWord maps Calliope's statuses to the badge words", () => {
    expect(["done", "running", "pending", "failed", "weird"].map(statusWord)).toEqual(["Ready", "Running", "Queued", "Failed", "weird"]);
  });

  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatBytes(-1)).toBe("");
  });
});

const job = (id: number, status: string, extra: Partial<JobRow> = {}): JobRow => ({
  id,
  project_id: 99,
  scene_id: null,
  kind: "image",
  workflow_id: 2,
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

describe("jobs", () => {
  it("isBusy while anything is pending or running", () => {
    expect(isBusy([job(1, "done"), job(2, "failed")])).toBe(false);
    expect(isBusy([job(1, "done"), job(2, "pending")])).toBe(true);
    expect(isBusy([job(3, "running")])).toBe(true);
    expect(isBusy([])).toBe(false);
  });

  it("readyCount counts done jobs", () => {
    expect(readyCount([job(1, "done"), job(2, "failed"), job(3, "done")])).toBe(2);
  });

  it("deleteSummary reports deleted and already-missing files", () => {
    expect(deleteSummary(7, { deleted_files: ["a"], missing_files: [] })).toBe("Deleted #7 and 1 file");
    expect(deleteSummary(7, { deleted_files: ["a", "b"], missing_files: ["c"] })).toBe("Deleted #7 (2 files; 1 already missing)");
    expect(deleteSummary(7, { deleted_files: [], missing_files: ["c"] })).toBe("Deleted #7 (1 file already missing)");
    expect(deleteSummary(7, {})).toBe("Deleted #7");
  });

  it("deletePrompt names the file count", () => {
    expect(deletePrompt(job(7, "done", { output_paths: [PATH] }))).toBe("This removes the record and 1 file on disk.");
    expect(deletePrompt(job(8, "failed"))).toBe("This removes the record.");
  });
});

const wf = (id: number, kind: "image" | "video", is_enabled = true): WorkflowRow => ({
  id,
  name: `wf ${id}`,
  kind,
  is_enabled,
  prompt_profile: "prose",
  description: null,
  input_schema: [],
  output_schema: [],
});

describe("workflow picking", () => {
  const list = [wf(1, "video"), wf(2, "image"), wf(3, "image", false), wf(4, "video", false)];

  it("filters by mode and enabled", () => {
    expect(workflowsFor(list, "image").map((w) => w.id)).toEqual([2]);
    expect(workflowsFor(list, "video").map((w) => w.id)).toEqual([1]);
  });

  it("defaults to video when one exists, else image", () => {
    expect(defaultMode(list)).toBe("video");
    expect(defaultMode([wf(2, "image"), wf(4, "video", false)])).toBe("image");
    expect(defaultMode([])).toBe("image");
  });

  it("keeps a valid current pick, falls back to the first, null when empty", () => {
    const imgs = workflowsFor(list, "image");
    expect(pickWorkflow(imgs, 2)).toBe(2);
    expect(pickWorkflow(imgs, 1)).toBe(2);
    expect(pickWorkflow(imgs, null)).toBe(2);
    expect(pickWorkflow([], 2)).toBeNull();
  });
});

describe("inputs and uploads", () => {
  it("coerces unknown kinds to text and keeps defaults/required", () => {
    const out = toDynamicInputs([
      { nodeId: "6", label: "Prompt", role: "prompt", kind: "textarea", required: true },
      { nodeId: "9", label: "Ref", role: "image", kind: "image" },
      { nodeId: "3", label: "Seed", role: "seed", kind: "INT", defaultValue: 42 },
    ]);
    expect(out).toEqual([
      { nodeId: "6", label: "Prompt", role: "prompt", kind: "textarea", required: true },
      { nodeId: "9", label: "Ref", role: "image", kind: "image" },
      { nodeId: "3", label: "Seed", role: "seed", kind: "text", defaultValue: 42 },
    ]);
    expect(toDynamicInputs(undefined)).toEqual([]);
  });

  it("uploadOptions become kind upload with an image thumb", () => {
    const ups: UploadRow[] = [
      { name: "ref.png", path: "/u/aa-ref.png", kind: "image", size: 10, mtime: 1 },
      { name: "clip.mp4", path: "/u/bb-clip.mp4", kind: "video", size: 10, mtime: 2 },
    ];
    expect(uploadOptions(ups)).toEqual([
      { id: "upload:/u/aa-ref.png", label: "ref.png", path: "/u/aa-ref.png", kind: "upload", thumbPath: "/u/aa-ref.png" },
      { id: "upload:/u/bb-clip.mp4", label: "clip.mp4", path: "/u/bb-clip.mp4", kind: "upload" },
    ]);
  });

  it("mediaInputFor finds the first input an upload can fill", () => {
    const inputs = toDynamicInputs([
      { nodeId: "6", label: "Prompt", role: "prompt", kind: "textarea" },
      { nodeId: "9", label: "Ref", role: "image", kind: "image_url" },
      { nodeId: "10", label: "Clip", role: "video", kind: "video" },
    ]);
    expect(mediaInputFor(inputs, "image")?.nodeId).toBe("9");
    expect(mediaInputFor(inputs, "video")?.nodeId).toBe("10");
    expect(mediaInputFor(inputs, "audio")).toBeUndefined();
    expect(mediaInputFor(inputs, "other")).toBeUndefined();
  });

  it("attachableProjects hides the system scratch project", () => {
    expect(attachableProjects([{ id: 1, status: "draft" }, { id: 2, status: "system" }]).map((p) => p.id)).toEqual([1]);
  });
});
