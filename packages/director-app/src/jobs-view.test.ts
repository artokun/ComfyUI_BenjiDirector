import { describe, expect, it } from "vitest";
import type { JobRow, SceneRow, StoryBundle } from "@benjidirector/calliope-client";
import {
  clipsSummary,
  downloadName,
  exportState,
  filterJobs,
  formatClock,
  formatEvent,
  isStale,
  kindIcon,
  kindLabel,
  labelFor,
  latestExportJob,
  logEntries,
  parseTime,
  queueStats,
  relativeTime,
  sortJobs,
  statusChip,
} from "./jobs-view.js";

// Row shapes as Calliope 1.2.1 returns them (see calliope-bind.test.ts for the story/scene ones).
const story: StoryBundle = {
  project: { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", status: "draft" },
  beats: [{ id: 1, order_index: 0, title: "Beat 1", description: null }],
  characters: [{ id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: null }],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
  items: [{ id: 7, name: "The letter", description: null }],
};
const scene = (id: number, order_index: number, extra: Partial<SceneRow> = {}): SceneRow => ({
  id,
  project_id: 1,
  beat_id: 1,
  order_index,
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
const job = (id: number, extra: Partial<JobRow> = {}): JobRow => ({
  id,
  project_id: 1,
  scene_id: null,
  kind: "image",
  workflow_id: null,
  status: "done",
  payload: {},
  output_paths: [],
  error: null,
  created_at: "2026-09-01 10:00:00",
  started_at: null,
  completed_at: null,
  retry_count: 0,
  ...extra,
});

describe("labelFor", () => {
  const scenes = [scene(1, 0), scene(2, 1, { heading: "  " })];
  it("names the scene a video job renders", () => {
    expect(labelFor(job(1, { kind: "video", scene_id: 1 }), story, scenes)).toBe("SC-01");
  });
  it("falls back to the scene's cut position when its heading is blank", () => {
    expect(labelFor(job(1, { kind: "video", scene_id: 2 }), story, scenes)).toBe("Scene 2");
  });
  it("names the entity an image job draws, from the payload ids", () => {
    expect(labelFor(job(2, { payload: { character_id: 1 } }), story, scenes)).toBe("Nadia");
    expect(labelFor(job(3, { payload: { location_id: "1" } }), story, scenes)).toBe("Rooftop, night");
    expect(labelFor(job(4, { payload: { item_id: 7 } }), story, scenes)).toBe("The letter");
  });
  it("a null id in the payload (create_job writes them all) is not an entity", () => {
    expect(labelFor(job(5, { payload: { character_id: null, location_id: null } }), story, scenes)).toBe("Image #5");
  });
  it("an export is always Export film", () => {
    expect(labelFor(job(6, { kind: "export", scene_id: 1 }), story, scenes)).toBe("Export film");
  });
  it("a subject outside the loaded project (all-projects view) reads as Kind #id", () => {
    expect(labelFor(job(7, { kind: "video", scene_id: 99, project_id: 2 }), story, scenes)).toBe("Video #7");
    expect(labelFor(job(8, { payload: { character_id: 42 } }), null, [])).toBe("Image #8");
  });
  it("a foreign row is NOT named by an id that collides with this project's", () => {
    // Ids restart per project: project 2's scene 1 and character 1 are not "SC-01" and "Nadia".
    expect(labelFor(job(9, { kind: "video", scene_id: 1, project_id: 2 }), story, scenes)).toBe("Video #9");
    expect(labelFor(job(10, { payload: { character_id: 1 }, project_id: 2 }), story, scenes)).toBe("Image #10");
    // …but its own project's rows still resolve, and an export is an export anywhere.
    expect(labelFor(job(11, { kind: "video", scene_id: 1, project_id: 1 }), story, scenes)).toBe("SC-01");
    expect(labelFor(job(12, { kind: "export", project_id: 2 }), story, scenes)).toBe("Export film");
  });
  it("kind icon and label", () => {
    expect(kindIcon("image")).toBe("image");
    expect(kindIcon("video")).toBe("film");
    expect(kindIcon("export")).toBe("clapper");
    expect(kindIcon("weird")).toBe("clock");
    expect(kindLabel("video")).toBe("Video");
    expect(kindLabel("")).toBe("Job");
  });
});

describe("time", () => {
  it("reads a zoneless SQLite stamp as UTC, not local time", () => {
    expect(parseTime("2026-09-01 10:00:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T10:00:00.250")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0, 250));
  });
  it("still honours an explicit zone and rejects garbage", () => {
    expect(parseTime("2026-09-01T10:00:00Z")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("2026-09-01T12:00:00+02:00")).toBe(Date.UTC(2026, 8, 1, 10, 0, 0));
    expect(parseTime("not a time")).toBeNull();
    expect(parseTime(null)).toBeNull();
  });
  it("relative time in Calliope's compact style", () => {
    const now = Date.UTC(2026, 8, 1, 10, 30, 0);
    expect(relativeTime("2026-09-01 10:29:50", now)).toBe("just now");
    expect(relativeTime("2026-09-01 10:27:00", now)).toBe("3m ago");
    expect(relativeTime("2026-09-01 08:30:00", now)).toBe("2h ago");
    expect(relativeTime("2026-08-28 10:30:00", now)).toBe("4d ago");
    expect(relativeTime("2026-07-01 10:30:00", now)).toBe("2mo ago");
    expect(relativeTime("2024-09-01 10:30:00", now)).toBe("2y ago");
    expect(relativeTime(null, now)).toBe("");
  });
  it("formatClock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(599.6)).toBe("10:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });
});

describe("status", () => {
  it("chips: pending is quiet, running is info, done is ok, failed is err", () => {
    expect(statusChip(job(1, { status: "pending" }))).toEqual({ tone: "", label: "pending" });
    expect(statusChip(job(1, { status: "running" }))).toEqual({ tone: "info", label: "running" });
    expect(statusChip(job(1, { status: "done" }))).toEqual({ tone: "ok", label: "done" });
    expect(statusChip(job(1, { status: "failed", error: "ComfyUI: OOM" }))).toEqual({ tone: "err", label: "failed" });
  });
  it("the queue manager's own 'cancelled' and 'superseded' failures are warnings, not errors", () => {
    expect(statusChip(job(1, { status: "failed", error: "cancelled" }))).toEqual({ tone: "warn", label: "cancelled" });
    expect(statusChip(job(1, { status: "failed", error: "superseded by new export" }))).toEqual({ tone: "warn", label: "superseded" });
  });
  it("stats, filter and sort", () => {
    const rows = [job(1, { status: "done" }), job(2, { status: "pending" }), job(3, { status: "running" }), job(4, { status: "failed" }), job(5, { status: "pending" }), job(6, { status: "done" })];
    expect(queueStats(rows)).toEqual({ running: 1, queued: 2, done: 2, failed: 1 });
    expect(filterJobs(rows, "pending").map((j) => j.id)).toEqual([2, 5]);
    expect(filterJobs(rows, "all")).toHaveLength(6);
    // running, then queued (newest first), then the rest newest first
    expect(sortJobs(rows).map((j) => j.id)).toEqual([3, 5, 2, 6, 4, 1]);
  });
});

describe("export", () => {
  const scenes = [scene(1, 0, { video_path: "/a/1.mp4", duration_sec: 8 }), scene(2, 1, { duration_sec: 4 }), scene(3, 2, { video_path: "/a/3.mp4", duration_sec: null })];
  it("clipsSummary counts clips and the seconds they will run", () => {
    // duration null → Calliope's 5 s default; only clip-bearing scenes count toward the film.
    expect(clipsSummary(scenes)).toEqual({ ready: 2, missing: 1, clipSec: 13, totalSec: 17 });
    expect(clipsSummary([])).toEqual({ ready: 0, missing: 0, clipSec: 0, totalSec: 0 });
  });
  it("idle without an export job", () => {
    const v = exportState([job(1, { kind: "video", scene_id: 1 })], scenes);
    expect(v.state).toBe("idle");
    expect(v.job).toBeNull();
    expect(v.path).toBeNull();
    expect(v.stale).toBe(false);
  });
  it("active while the newest export is pending or running", () => {
    expect(exportState([job(9, { kind: "export", status: "pending" })], scenes).state).toBe("active");
    expect(exportState([job(9, { kind: "export", status: "running" })], scenes).state).toBe("active");
  });
  it("ready with the mp4 and its completion time", () => {
    const v = exportState([job(9, { kind: "export", status: "done", output_paths: ["/assets/1/export/the-approach-job9.mp4"], completed_at: "2026-09-01 10:05:00" })], scenes);
    expect(v.state).toBe("ready");
    expect(v.path).toBe("/assets/1/export/the-approach-job9.mp4");
    expect(v.exportedAt).toBe(Date.UTC(2026, 8, 1, 10, 5, 0));
    expect(v.stale).toBe(false);
  });
  it("the NEWEST export decides, not the newest row", () => {
    const v = exportState(
      [job(9, { kind: "export", status: "failed", error: "superseded by new export" }), job(10, { kind: "export", status: "done", output_paths: ["/x.mp4"] }), job(11, { kind: "video", status: "pending" })],
      scenes,
    );
    expect(v.state).toBe("ready");
    expect(v.job?.id).toBe(10);
  });
  it("failed carries the error, with a default when Calliope gave none", () => {
    expect(exportState([job(9, { kind: "export", status: "failed", error: "ffmpeg export failed (exit 1): …" })], scenes).error).toBe("ffmpeg export failed (exit 1): …");
    expect(exportState([job(9, { kind: "export", status: "failed", error: "" })], scenes).error).toBe("Export failed");
    expect(exportState([job(9, { kind: "export", status: "failed", error: "cancelled" })], scenes).state).toBe("failed");
  });
  it("latestExportJob picks the highest id", () => {
    expect(latestExportJob([job(3, { kind: "export" }), job(5, { kind: "export" }), job(9, { kind: "video" })])?.id).toBe(5);
    expect(latestExportJob([])).toBeNull();
  });
});

describe("isStale", () => {
  const exp = job(9, { kind: "export", status: "done", completed_at: "2026-09-01 10:05:00" });
  it("a clip that finished after the export makes the film stale", () => {
    expect(isStale(exp, [job(10, { kind: "video", status: "done", completed_at: "2026-09-01 10:06:00" })])).toBe(true);
  });
  it("a clip that finished before it does not", () => {
    expect(isStale(exp, [job(8, { kind: "video", status: "done", completed_at: "2026-09-01 10:04:00" })])).toBe(false);
  });
  it("a failed or unfinished later video job changes nothing on disk", () => {
    expect(isStale(exp, [job(10, { kind: "video", status: "failed", completed_at: "2026-09-01 10:06:00" })])).toBe(false);
    expect(isStale(exp, [job(10, { kind: "video", status: "running", completed_at: null })])).toBe(false);
  });
  it("only a DONE export can be stale, and only with a parsable completion", () => {
    expect(isStale(job(9, { kind: "export", status: "failed", completed_at: "2026-09-01 10:05:00" }), [job(10, { kind: "video", status: "done", completed_at: "2026-09-01 10:06:00" })])).toBe(false);
    expect(isStale(job(9, { kind: "export", status: "done", completed_at: null }), [job(10, { kind: "video", status: "done", completed_at: "2026-09-01 10:06:00" })])).toBe(false);
    expect(isStale(null, [])).toBe(false);
  });
  it("non-video rows are ignored even when passed in", () => {
    expect(isStale(exp, [job(10, { kind: "image", status: "done", completed_at: "2026-09-01 10:06:00" })])).toBe(false);
  });
  it("exportState wires it through against every job", () => {
    const v = exportState([exp, job(10, { kind: "video", status: "done", completed_at: "2026-09-01 10:06:00" })], []);
    expect(v.stale).toBe(true);
  });
});

describe("downloadName", () => {
  it("uses the project title, made filesystem-safe", () => {
    expect(downloadName(story, "/x/film-job9.mp4")).toBe("The Approach.mp4");
    expect(downloadName({ ...story, project: { ...story.project, title: 'A: "B" / C' } }, null)).toBe("A- -B- - C.mp4");
  });
  it("falls back to the export's own filename, then film.mp4", () => {
    expect(downloadName(null, "C:\\assets\\1\\export\\the-approach-job9.mp4")).toBe("the-approach-job9.mp4");
    expect(downloadName(null, null)).toBe("film.mp4");
  });
});

describe("event log", () => {
  it("formats the job lifecycle the way Calliope's activity panel does", () => {
    expect(formatEvent({ kind: "job.created", data: { job_id: 3, kind: "video" }, ts: "2026-09-01T10:00:01.000" }, 0)).toMatchObject({ title: "Queued", detail: "video #3", tone: "info", ts: "10:00:01" });
    expect(formatEvent({ kind: "job.started", data: { job_id: 3, message: "Rendering SC-01" } }, 0)).toMatchObject({ title: "Running", detail: "Rendering SC-01", tone: "work" });
    expect(formatEvent({ kind: "job.completed", data: { job_id: 3, kind: "video", outputs: ["a.mp4"] } }, 0)).toMatchObject({ title: "Finished", detail: "video · #3 · 1 file(s)", tone: "ok" });
    expect(formatEvent({ kind: "job.failed", data: { job_id: 3, error: "OOM" } }, 0)).toMatchObject({ title: "Failed", detail: "OOM", tone: "err" });
    expect(formatEvent({ kind: "asset.ready", data: { paths: ["a", "b"] } }, 0)).toMatchObject({ title: "Asset ready", detail: "2 file(s) saved" });
    expect(formatEvent({ kind: "job.deleted", data: { job_id: 4 } }, 0)).toMatchObject({ title: "Removed", detail: "#4", tone: "warn" });
    expect(formatEvent({ kind: "some.other", data: { message: "hi" } }, 0)).toMatchObject({ title: "some · other", detail: "hi" });
  });
  it("accepts the wire shape ({type, data, ts}) as well as the client's", () => {
    expect(formatEvent({ type: "job.started", data: { job_id: 1 } }, 0)?.title).toBe("Running");
  });
  it("drops progress ticks — they drive bars, not the log", () => {
    expect(formatEvent({ kind: "job.progress", data: { message: "12%" } }, 0)).toBeNull();
    expect(formatEvent({ data: {} }, 0)).toBeNull();
  });
  it("logEntries: newest first, progress out, consecutive duplicates collapsed, capped at 60", () => {
    const events = [
      { kind: "agent.thinking", data: { message: "Working…" }, at: 1 },
      { kind: "agent.thinking", data: { message: "Working…" }, at: 2 },
      { kind: "job.progress", data: { message: "1%" }, at: 3 },
      { kind: "job.completed", data: { job_id: 1 }, at: 4 },
    ];
    const out = logEntries(events);
    expect(out.map((e) => e.title)).toEqual(["Finished", "Agent"]);
    const many = Array.from({ length: 200 }, (_, i) => ({ kind: "job.created", data: { job_id: i }, at: i }));
    const capped = logEntries(many);
    expect(capped).toHaveLength(60);
    expect(capped[0]?.detail).toBe("#199");
  });
});
