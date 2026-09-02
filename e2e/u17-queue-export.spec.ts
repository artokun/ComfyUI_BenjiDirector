import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// U17 — the Queue tab and the film Export card, against a mocked Calliope: project 1 ("The
// Approach", the calliope-bind.test.ts fixture) with scene 1 rendered, three jobs (a done video
// for scene 1, a failed image for Nadia, a done export with an mp4), and the queue running.

const sqlite = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace("T", " ");

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
  chain_from_prev: 0,
  character_ids: [1],
  video_settings: null,
  ...extra,
});
const scenes = {
  scenes: [sceneRow(1, 0, 1, { video_path: "C:/calliope/assets/1/scenes/1.mp4" }), sceneRow(2, 1, 1, { chain_from_prev: 1 }), sceneRow(3, 2, 2, { chain_from_prev: 1 })],
  estimated_duration_sec: 15,
};

type Job = Record<string, unknown> & { id: number; status: string };
const makeJobs = (): Job[] => [
  {
    id: 11,
    project_id: 1,
    scene_id: 1,
    kind: "video",
    workflow_id: 2,
    status: "done",
    payload: {},
    output_paths: ["C:/calliope/assets/1/scenes/1.mp4"],
    error: null,
    created_at: sqlite(20 * 60_000),
    started_at: sqlite(19 * 60_000),
    completed_at: sqlite(12 * 60_000),
    retry_count: 0,
  },
  {
    id: 12,
    project_id: 1,
    scene_id: null,
    kind: "image",
    workflow_id: 1,
    status: "failed",
    payload: { input_values: {}, character_id: 1, location_id: null },
    output_paths: [],
    error: "ComfyUI: KSampler — CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 24.00 GiB total capacity). Lower the resolution or free VRAM and retry.",
    created_at: sqlite(9 * 60_000),
    started_at: sqlite(8 * 60_000),
    completed_at: sqlite(7 * 60_000),
    retry_count: 1,
  },
  {
    id: 13,
    project_id: 1,
    scene_id: null,
    kind: "export",
    workflow_id: null,
    status: "done",
    payload: {},
    output_paths: ["C:/calliope/assets/1/export/the-approach-job13.mp4"],
    error: null,
    created_at: sqlite(5 * 60_000),
    started_at: sqlite(4 * 60_000),
    completed_at: sqlite(3 * 60_000),
    retry_count: 0,
  },
];

interface Mock {
  posts: string[];
  jobs: Job[];
}

async function mockCalliope(page: Page): Promise<Mock> {
  const mock: Mock = { posts: [], jobs: makeJobs() };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "GET") {
      if (path === "/api/health") return json({ status: "ok", version: "1.2.1", dry_run: false });
      if (path === "/api/projects") return json([{ ...story.project, created_at: "2026-09-01 09:00:00" }]);
      if (path === "/api/projects/1") return json(story.project);
      if (path === "/api/projects/1/story") return json(story);
      if (path === "/api/projects/1/scenes") return json(scenes);
      if (path === "/api/jobs/queue-status") return json({ paused: false });
      if (path === "/api/jobs") {
        const pid = url.searchParams.get("project_id");
        return json(pid ? mock.jobs.filter((j) => String(j.project_id) === pid) : mock.jobs);
      }
      if (path === "/api/settings") return json({});
      if (path === "/api/workflows") return json([]);
      return json({ detail: `unmocked ${path}` }, 404);
    }
    mock.posts.push(`${method} ${path}`);
    let m = /^\/api\/jobs\/(\d+)\/retry$/.exec(path);
    if (m) {
      const j = mock.jobs.find((x) => x.id === Number(m![1]));
      if (j) Object.assign(j, { status: "pending", error: null, started_at: null, completed_at: null });
      return json(j ?? { detail: "Job not found" }, j ? 200 : 404);
    }
    m = /^\/api\/jobs\/(\d+)\/cancel$/.exec(path);
    if (m) {
      const j = mock.jobs.find((x) => x.id === Number(m![1]));
      if (j) Object.assign(j, { status: "failed", error: "cancelled", completed_at: sqlite(0) });
      return json({ ok: true });
    }
    if (path === "/api/jobs/projects/1/export") {
      const job: Job = { id: 14, project_id: 1, scene_id: null, kind: "export", workflow_id: null, status: "pending", payload: {}, output_paths: [], error: null, created_at: sqlite(0), started_at: null, completed_at: null, retry_count: 0 };
      mock.jobs.push(job);
      return json({ ok: true, job });
    }
    if (path === "/api/jobs/pause") return json({ ok: true, paused: true });
    if (path === "/api/jobs/resume") return json({ ok: true, paused: false });
    return json({ detail: `unmocked ${method} ${path}` }, 404);
  });
  return mock;
}

test("the Queue tab lists the project's jobs with resolved labels; retry and re-export reach Calliope", async ({ page }) => {
  const mock = await mockCalliope(page);
  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });
  await expect(page.locator(".bd-project")).toHaveValue("1");

  await page.getByRole("tab", { name: "Queue" }).click();
  const rows = page.locator(".bd-job");
  await expect(rows).toHaveCount(3);
  // Running/queued first, then newest first: export #13, image #12, video #11.
  await expect(rows.nth(0).locator(".bd-job-label")).toHaveText("Export film");
  await expect(rows.nth(1).locator(".bd-job-label")).toHaveText("Nadia");
  await expect(rows.nth(2).locator(".bd-job-label")).toHaveText("SC-01");
  await expect(rows.nth(1).locator(".bd-chip-state")).toHaveText("failed");
  await expect(rows.nth(1).locator(".bd-job-error-text")).toContainText("CUDA out of memory");
  await expect(page.locator(".bd-queue-stats")).toContainText("1 failed");

  // The export card reads the done export: ready, downloadable, not stale (the clip landed first).
  const card = page.locator(".bd-queue-side .bd-export");
  await expect(card).toHaveAttribute("data-state", "ready");
  await expect(card).toContainText("Exported 3m ago");
  const dl = card.getByRole("link", { name: "Download film" });
  await expect(dl).toHaveAttribute("href", /\/api\/file\?path=.*the-approach-job13\.mp4/);
  await expect(dl).toHaveAttribute("download", "The Approach.mp4");
  await expect(card.locator(".bd-export-stale")).toHaveCount(0);

  await shot(page, "u17-queue-export");

  // Retry the failed image job: one POST, then the row comes back as pending.
  await rows.nth(1).getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => mock.posts).toContain("POST /api/jobs/12/retry");
  await expect(page.locator('.bd-job[data-job-id="12"] .bd-chip-state')).toHaveText("pending");
  // …and it is now sorted to the top, ahead of the finished rows.
  await expect(rows.nth(0)).toHaveAttribute("data-job-id", "12");

  // Re-export queues a new export job and the card flips to exporting.
  await card.getByRole("button", { name: "Re-export" }).click();
  await expect.poll(() => mock.posts).toContain("POST /api/jobs/projects/1/export");
  await expect(card).toHaveAttribute("data-state", "active");
  await expect(card).toContainText("Exporting your film");
  await expect(rows).toHaveCount(4);
  await shot(page, "u17-queue-export-active");
});

test("cancelling a ComfyUI job asks first and says it interrupts ComfyUI for everyone", async ({ page }) => {
  const mock = await mockCalliope(page);
  mock.jobs.push({ id: 15, project_id: 1, scene_id: 2, kind: "video", workflow_id: 2, status: "running", payload: {}, output_paths: [], error: null, created_at: sqlite(60_000), started_at: sqlite(30_000), completed_at: null, retry_count: 0 });
  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });
  await page.getByRole("tab", { name: "Queue" }).click();
  const running = page.locator('.bd-job[data-job-id="15"]');
  await expect(running.locator(".bd-job-label")).toHaveText("SC-02");
  await expect(running.locator(".bd-progress")).toHaveClass(/is-indeterminate/);
  await expect(page.getByRole("tab", { name: "Queue" }).locator(".bd-tab-badge")).toHaveText("1");

  await running.getByRole("button", { name: "Cancel job" }).click();
  const dialog = page.locator(".bd-modal");
  await expect(dialog).toContainText("interrupt");
  await expect(dialog).toContainText("everyone");
  await dialog.getByRole("button", { name: "Keep going" }).click();
  expect(mock.posts).not.toContain("POST /api/jobs/15/cancel");

  await running.getByRole("button", { name: "Cancel job" }).click();
  await page.locator(".bd-modal").getByRole("button", { name: "Cancel job" }).click();
  await expect.poll(() => mock.posts).toContain("POST /api/jobs/15/cancel");
  await expect(running.locator(".bd-chip-state")).toHaveText("cancelled");
});

test("the toolbar Export button opens the film card as a popover", async ({ page }) => {
  await mockCalliope(page);
  await waitForDemo(page);
  const btn = page.locator(".bd-export-btn");
  await expect(btn).toBeDisabled();
  await drive(page, "project_open", { project_id: 1 });
  await expect(btn).toBeEnabled();
  await btn.click();
  const pop = page.locator(".bd-export-pop .bd-export");
  await expect(pop).toHaveAttribute("data-state", "ready");
  await expect(pop.getByRole("link", { name: "Download film" })).toBeVisible();
  await shot(page, "u17-export-popover");
  await page.keyboard.press("Escape");
  await expect(page.locator(".bd-export-pop")).toHaveCount(0);
});
