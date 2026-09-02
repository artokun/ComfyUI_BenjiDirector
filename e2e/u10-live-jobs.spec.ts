import { expect, test, type Route } from "@playwright/test";
import { shot, waitForDemo } from "./helpers.js";

// U10 — live events, the job strip and the scene render badge, against a mocked Calliope.
//
// The harness runs with no backend, so everything Calliope answers is faked here: health, the
// project list, the story/scenes rows (the fixtures from calliope-bind.test.ts), the jobs
// table, the queue status, and a real Server-Sent-Events body on /api/events.
//
// The interesting part is the handover. The strip and the badge must be right from the POLL
// alone (one running video job), then the stream's `job.progress` must move the bar, and
// `job.completed` must flip the badge to "rendered" — via the row the refetch brings back and
// the `video_path` the debounced project refresh lands on the canvas.

// ── the rows, as Calliope 1.2.1 returns them (copied from calliope-bind.test.ts) ──
const story = {
  project: { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", status: "draft" },
  beats: [
    { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
    { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
  ],
  characters: [{ id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" }],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
  items: [],
};
const sceneRow = (id: number, order_index: number, beat_id: number | null, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: 1,
  beat_id,
  order_index,
  heading: `SC-0${id}`,
  action: null,
  dialog: null,
  duration_sec: 5,
  workflow_id: null,
  env_image_path: null,
  location_id: 1,
  video_path: null,
  chain_from_prev: order_index === 0 ? 0 : 1,
  character_ids: [1],
  video_settings: null,
  ...extra,
});

const VIDEO_OUT = "/calliope/renders/sc1.mp4";
const jobRow = (extra: Record<string, unknown> = {}) => ({
  id: 101,
  project_id: 1,
  scene_id: 1,
  kind: "video",
  workflow_id: 7,
  status: "running",
  payload: {},
  output_paths: [],
  error: null,
  created_at: "2026-09-01T10:00:00Z",
  started_at: "2026-09-01T10:00:02Z",
  completed_at: null,
  retry_count: 0,
  ...extra,
});

/** One SSE frame exactly as `event_bus.format_sse` writes it. */
const sse = (type: string, data: Record<string, unknown>, ts: string) => `event: ${type}\ndata: ${JSON.stringify({ type, data, ts })}\n\n`;

// Every mocked answer is cross-origin (the client talks to 127.0.0.1:8247), so each one has to
// carry CORS or the browser drops it before the pane ever sees it.
const CORS = { "access-control-allow-origin": "*" };
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(body) });

test("the job strip and the scene badge follow a render from running to rendered", async ({ page }) => {
  let jobDone = false;
  let eventsHit = 0;
  let releaseCompletion: () => void = () => undefined;
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;

    if (p === "/api/health") return json(route, { status: "ok", version: "1.2.1", dry_run: false });
    if (p === "/api/projects") return json(route, [story.project]);
    if (p === "/api/projects/1") return json(route, story.project);
    if (p === "/api/projects/1/story") return json(route, story);
    if (p === "/api/projects/1/scenes") {
      // Once the render lands, the row carries the clip — this is what the debounced
      // refresh() puts on the canvas.
      const scenes = [sceneRow(1, 0, 1, jobDone ? { video_path: VIDEO_OUT } : {}), sceneRow(2, 1, 1), sceneRow(3, 2, 2)];
      return json(route, { scenes, estimated_duration_sec: 15 });
    }
    if (p === "/api/jobs/queue-status") return json(route, { paused: false });
    if (p === "/api/jobs") {
      return json(route, [jobDone ? jobRow({ status: "done", completed_at: "2026-09-01T10:00:40Z", output_paths: [VIDEO_OUT] }) : jobRow()]);
    }

    if (p === "/api/events") {
      eventsHit++;
      // #1: the job is running and ticking. `retry` shortens EventSource's own reconnect so
      // the second connection (which carries the completion) opens promptly.
      if (eventsHit === 1) {
        const body = `retry: 250\n\n${sse("job.progress", { job_id: 101, kind: "video", percent: 45, message: "Waiting on ComfyUI (a1b2c3d4…)" }, "2026-09-01T10:00:20+00:00")}`;
        return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { ...CORS, "cache-control": "no-cache" }, body });
      }
      // #2: held open until the test has asserted the running state, then the job lands.
      if (eventsHit === 2) {
        await completionGate;
        jobDone = true;
        const body = sse("job.completed", { job_id: 101, kind: "video", project_id: 1, outputs: [VIDEO_OUT], message: "Scene · SC-01 · 1 file(s)" }, "2026-09-01T10:00:40+00:00");
        return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { ...CORS, "cache-control": "no-cache" }, body });
      }
      // Afterwards: nothing more to say, and a long retry so the stream stops flapping.
      return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { ...CORS, "cache-control": "no-cache" }, body: "retry: 60000\n\n" });
    }
    return json(route, {});
  });

  await waitForDemo(page);

  // The demo graph has no queue, so the strip is not there yet.
  await expect(page.getByTestId("u10-jobstrip")).toHaveCount(0);

  // Calliope answers, so the project picker appears; loading the project starts the store.
  const picker = page.locator("select.bd-project");
  await expect(picker).toBeVisible();
  await picker.selectOption("1");

  // ── from the POLL alone: one running video job on scene 1 ──
  const strip = page.getByTestId("u10-jobstrip");
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("u10-counts")).toHaveText("1 running · 0 queued");
  await expect(page.getByTestId("u10-current")).toContainText("Scene · SC-01");

  const badge = page.locator('.react-flow__node[data-id="cal-sc-1"] .bd-badge');
  await expect(badge).toHaveText("rendering");
  await expect(badge).toHaveClass(/is-rendering/);

  // ── from the STREAM: the progress tick moves the bar off indeterminate ──
  await expect(page.getByTestId("u10-pct")).toHaveText("45%");
  await expect(page.locator(".bd-jobstrip-bar")).not.toHaveClass(/is-indeterminate/);
  await expect(strip).toContainText("Waiting on ComfyUI");
  await shot(page, "u10-live-jobs-running");

  // ── the completion lands: the row flips, and refresh() brings the clip to the canvas ──
  releaseCompletion();
  await expect(badge).toHaveText("rendered");
  await expect(badge).toHaveClass(/is-rendered/);
  await expect(page.getByTestId("u10-counts")).toHaveText("0 running · 0 queued");
  await expect(page.getByTestId("u10-current")).toHaveCount(0);

  // The badge alone does not prove the debounced refresh() fired — the finished job row would
  // light it either way. refreshProject() is the only thing that writes this note, so it is
  // the witness that the scene's `video_path` was actually re-read onto the canvas.
  await expect(page.locator(".bd-note")).toContainText("refreshed “The Approach”");

  await shot(page, "u10-live-jobs");
});

test("a paused queue offers Resume, and a failed job offers Retry", async ({ page }) => {
  let paused = true;
  let resumeCalls = 0;
  let retryCalls = 0;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === "/api/health") return json(route, { status: "ok", version: "1.2.1" });
    if (p === "/api/projects") return json(route, [story.project]);
    if (p === "/api/projects/1/story") return json(route, story);
    if (p === "/api/projects/1/scenes") return json(route, { scenes: [sceneRow(1, 0, 1), sceneRow(2, 1, 1), sceneRow(3, 2, 2)], estimated_duration_sec: 15 });
    if (p === "/api/jobs/queue-status") return json(route, { paused });
    if (p === "/api/jobs/pause") return json(route, { ok: true, paused: true });
    if (p === "/api/jobs/resume") {
      resumeCalls++;
      paused = false;
      return json(route, { ok: true, paused: false });
    }
    if (p === "/api/jobs/101/retry") {
      retryCalls++;
      return json(route, jobRow({ status: "pending", error: null }));
    }
    if (p === "/api/jobs") {
      return json(route, [jobRow({ status: "failed", error: "CUDA out of memory", completed_at: "2026-09-01T10:00:40Z" })]);
    }
    // No event stream in this one: the strip has to be right from the poll alone.
    if (p === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", headers: { ...CORS, "cache-control": "no-cache" }, body: "retry: 60000\n\n" });
    return json(route, {});
  });

  await waitForDemo(page);
  await page.locator("select.bd-project").selectOption("1");

  // The failure is reported with the job's own label and Calliope's error text.
  const err = page.getByTestId("u10-error");
  await expect(err).toBeVisible();
  await expect(err).toContainText("Scene · SC-01");
  await expect(err).toContainText("CUDA out of memory");

  // A failed video job lights the scene badge red.
  const badge = page.locator('.react-flow__node[data-id="cal-sc-1"] .bd-badge');
  await expect(badge).toHaveText("failed");
  await expect(badge).toHaveClass(/is-failed/);

  // The paused chip is there and Resume reaches Calliope.
  const chip = page.getByTestId("u10-paused");
  await expect(chip).toBeVisible();
  await shot(page, "u10-live-jobs-paused");
  await chip.getByRole("button", { name: "Resume" }).click();
  await expect.poll(() => resumeCalls).toBe(1);
  await expect(chip).toHaveCount(0);

  // Retry posts to the job's retry route.
  await err.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => retryCalls).toBe(1);
});
