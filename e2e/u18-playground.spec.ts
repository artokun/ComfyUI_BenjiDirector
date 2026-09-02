import { expect, test, type Page, type Route } from "@playwright/test";
import { shot, waitForDemo } from "./helpers.js";

// The Playground against a MOCKED Calliope: two image/video workflows, two artifacts (one
// ready image, one failed clip), one upload. Fixtures for project 1 are the rows in
// packages/director-app/src/calliope-bind.test.ts ("The Approach", Nadia, Rooftop).

const ASSET_ROOT = "C:/calliope/assets";
const DONE_PATH = `${ASSET_ROOT}/playground/7/0a1b2c3d-fox_plush.png`;

const workflows = [
  {
    id: 1,
    name: "H3 video (ref)",
    kind: "video",
    is_enabled: true,
    prompt_profile: "minimax_h3_ref",
    description: "Reference-guided clip",
    input_schema: [
      { nodeId: "12", label: "Prompt", role: "prompt", kind: "textarea", required: true },
      { nodeId: "14", label: "Reference image", role: "image", kind: "image" },
    ],
    output_schema: [{ nodeId: "20", label: "Video", role: null, kind: "video" }],
  },
  {
    id: 2,
    name: "Plush portrait",
    kind: "image",
    is_enabled: true,
    prompt_profile: "prose",
    description: "Soft-toy character sheets",
    input_schema: [
      { nodeId: "6", label: "Prompt", role: "prompt", kind: "textarea", required: true },
      { nodeId: "3", label: "Seed", role: "seed", kind: "number", defaultValue: 42 },
    ],
    output_schema: [{ nodeId: "9", label: "Image", role: null, kind: "image" }],
  },
  { id: 3, name: "Disabled one", kind: "image", is_enabled: false, prompt_profile: "prose", description: null, input_schema: [], output_schema: [] },
];

const job = (id: number, kind: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: 99,
  scene_id: null,
  kind,
  workflow_id: kind === "image" ? 2 : 1,
  status,
  payload: { source: "playground", input_values: {} },
  output_paths: [],
  error: null,
  created_at: "2026-09-01T10:00:00Z",
  started_at: null,
  completed_at: null,
  retry_count: 0,
  ...extra,
});

const projects = [
  { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", cover_path: null, status: "draft", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
  { id: 99, title: "Playground Scratch", idea: null, genre: null, tone: null, target_duration: null, cover_path: null, status: "system", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" },
];

const assets = {
  characters: [{ id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: null, consistency_prompt: "same woman" }],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: null, consistency_prompt: null }],
  items: [],
};

const scenes = {
  scenes: [1, 2].map((id) => ({ id, project_id: 1, beat_id: 1, order_index: id - 1, heading: `SC-0${id}`, action: null, dialog: null, duration_sec: 5, workflow_id: null, env_image_path: null, location_id: 1, video_path: null, chain_from_prev: 0, character_ids: [1], video_settings: null })),
  estimated_duration_sec: 10,
};

// A portrait the <img> can render: an SVG plush silhouette on a soft gradient.
const PLUSH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1f3d"/><stop offset="1" stop-color="#0d0f1a"/></linearGradient></defs><rect width="400" height="500" fill="url(#g)"/><ellipse cx="200" cy="330" rx="120" ry="110" fill="#e8874a"/><circle cx="200" cy="200" r="95" fill="#f2a05f"/><circle cx="135" cy="120" r="38" fill="#f2a05f"/><circle cx="265" cy="120" r="38" fill="#f2a05f"/><circle cx="170" cy="190" r="10" fill="#1a1a1a"/><circle cx="230" cy="190" r="10" fill="#1a1a1a"/><ellipse cx="200" cy="225" rx="14" ry="9" fill="#1a1a1a"/><ellipse cx="200" cy="340" rx="60" ry="55" fill="#fbe3c9"/></svg>`;

interface Recorded {
  generate: unknown[];
  attach: unknown[];
  deleted: number[];
  retried: number[];
}

async function mockCalliope(page: Page): Promise<Recorded> {
  const rec: Recorded = { generate: [], attach: [], deleted: [], retried: [] };
  let jobs = [job(7, "image", "done", { output_paths: [DONE_PATH], completed_at: "2026-09-01T10:01:00Z" }), job(8, "video", "failed", { error: "ComfyUI: KSampler — CUDA out of memory" })];
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (p === "/api/health") return json(route, { status: "ok", version: "1.2.1", dry_run: true });
    if (p === "/api/events") return route.abort();
    if (p === "/api/projects" && m === "GET") return json(route, projects);
    if (p === "/api/projects/1/assets") return json(route, assets);
    if (p === "/api/projects/1/scenes") return json(route, scenes);
    if (p === "/api/projects/1/story") return json(route, { project: projects[0], beats: [], characters: assets.characters, locations: assets.locations, items: [] });
    if (p === "/api/workflows" && m === "GET") return json(route, workflows);
    if (p === "/api/playground/jobs" && m === "GET") return json(route, jobs);
    if (p === "/api/playground/uploads" && m === "GET") return json(route, [{ name: "nadia-ref.png", path: `${ASSET_ROOT}/uploads/deadbeef-nadia-ref.png`, kind: "image", size: 184_320, mtime: 1 }]);
    if (p === "/api/playground/generate" && m === "POST") {
      rec.generate.push(req.postDataJSON());
      const created = job(10, "image", "pending");
      jobs = [created, ...jobs];
      return json(route, { ok: true, job: created });
    }
    if (p === "/api/playground/attach" && m === "POST") {
      const body = req.postDataJSON() as { path: string; project_id: number; target: string };
      rec.attach.push(body);
      return json(route, { ok: true, path: body.path, target: body.target, project_id: body.project_id });
    }
    const del = /^\/api\/playground\/jobs\/(\d+)$/.exec(p);
    if (del && m === "DELETE") {
      const id = Number(del[1]);
      rec.deleted.push(id);
      const gone = jobs.find((j) => j.id === id);
      jobs = jobs.filter((j) => j.id !== id);
      return json(route, { ok: true, job_id: id, deleted_files: [], missing_files: gone?.output_paths ?? [] });
    }
    const retry = /^\/api\/jobs\/(\d+)\/retry$/.exec(p);
    if (retry && m === "POST") {
      rec.retried.push(Number(retry[1]));
      return json(route, { ...jobs.find((j) => j.id === Number(retry[1])), status: "pending", error: null });
    }
    if (p === "/api/file") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: PLUSH_SVG });
    return json(route, { detail: `unmocked ${m} ${p}` }, 404);
  });
  return rec;
}

test("playground: generate, add a ready image to a project as a character sheet, delete the failed clip", async ({ page }) => {
  const rec = await mockCalliope(page);
  await waitForDemo(page);

  // The tab exists because the module registered a panel on import.
  await page.getByRole("tab", { name: "Playground" }).click();
  const pg = page.locator(".bd-pg");
  await expect(pg).toBeVisible();

  // Two artifacts from the scratch project, with their words.
  await expect(pg.locator(".bd-pg-card")).toHaveCount(2);
  const done = pg.locator('.bd-pg-card[data-job-id="7"]');
  const failed = pg.locator('.bd-pg-card[data-job-id="8"]');
  await expect(done.locator(".bd-pg-badge")).toHaveText("Ready");
  await expect(done.locator("img")).toBeVisible();
  await expect(failed.locator(".bd-pg-badge")).toHaveText("Failed");
  await expect(failed.locator(".bd-pg-err")).toContainText("CUDA out of memory");
  await expect(failed.getByRole("button", { name: "Retry" })).toBeVisible();
  // The upload strip lists the one upload.
  await expect(pg.locator(".bd-pg-upload-name")).toHaveText("nadia-ref.png");

  // Video is the default mode (a video workflow exists); Image mode narrows the pick.
  await expect(pg.getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
  await pg.getByRole("tab", { name: "Image" }).click();
  const wf = pg.getByLabel("Workflow");
  await expect(wf).toHaveValue("2");
  await expect(wf.locator("option")).toHaveCount(1);

  // Required prompt: an empty submit is refused, a filled one posts with the seeded default.
  await pg.getByRole("button", { name: "Generate" }).click();
  await expect(pg.locator(".bd-pg-form-error")).toContainText("Prompt");
  expect(rec.generate).toHaveLength(0);
  const prompt = pg.locator(".bd-pg-dock textarea, .bd-pg-dock input[type=text]").first();
  await prompt.fill("a red plush fox, studio light, product shot");
  await pg.getByRole("button", { name: "Generate" }).click();
  await expect.poll(() => rec.generate.length).toBe(1);
  expect(rec.generate[0]).toEqual({ workflow_id: 2, input_values: { "6": "a red plush fox, studio light, product shot", "3": 42 } });
  await expect(page.locator(".bd-note")).toContainText("Generation queued");
  // The new pending job shows up after the refetch.
  await expect(pg.locator('.bd-pg-card[data-job-id="10"] .bd-pg-badge')).toHaveText("Queued");

  // Lightbox on the ready image.
  await done.locator(".bd-pg-media-hit").click();
  await expect(pg.locator(".bd-pg-lightbox img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pg.locator(".bd-pg-lightbox")).toHaveCount(0);

  // Add to project → character sheet → Nadia.
  await done.getByRole("button", { name: "Add to project" }).click();
  const form = done.locator(".bd-pg-attach");
  await form.getByLabel("Project").selectOption("1");
  // The scratch project is hidden from the pick.
  await expect(form.getByLabel("Project").locator("option")).toHaveCount(2);
  await expect(form.getByLabel("Add as")).toHaveValue("character_sheet");
  await form.getByLabel("Character").selectOption({ label: "Nadia" });
  await form.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => rec.attach.length).toBe(1);
  expect(rec.attach[0]).toEqual({ path: DONE_PATH, project_id: 1, target: "character_sheet", character_id: 1 });
  await expect(done.locator(".bd-pg-attached")).toContainText("Added to The Approach");
  await expect(done.locator(".bd-pg-attach")).toHaveCount(0);

  await shot(page, "u18-playground");

  // Delete the failed clip through the confirm modal.
  await failed.getByRole("button", { name: "Delete" }).click();
  const modalEl = page.locator(".bd-modal");
  await expect(modalEl).toContainText("Delete artifact #8?");
  await modalEl.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => rec.deleted).toEqual([8]);
  await expect(pg.locator('.bd-pg-card[data-job-id="8"]')).toHaveCount(0);
  await expect(page.locator(".bd-note")).toContainText("Deleted #8");
});

test("playground: a clip attaches to a scene, an item takes a name, retry re-queues", async ({ page }) => {
  const rec = await mockCalliope(page);
  await waitForDemo(page);
  await page.getByRole("tab", { name: "Playground" }).click();
  const pg = page.locator(".bd-pg");

  // Misc. item — the name defaults from the file name, prefix stripped.
  const done = pg.locator('.bd-pg-card[data-job-id="7"]');
  await done.getByRole("button", { name: "Add to project" }).click();
  const form = done.locator(".bd-pg-attach");
  await form.getByLabel("Project").selectOption("1");
  await form.getByLabel("Add as").selectOption("item");
  await expect(form.getByLabel("Item name")).toHaveValue("fox plush");
  await form.getByLabel("Item name").fill("Fox plush (hero)");
  await form.getByRole("button", { name: "Add" }).click();
  await expect.poll(() => rec.attach.length).toBe(1);
  expect(rec.attach[0]).toEqual({ path: DONE_PATH, project_id: 1, target: "item", name: "Fox plush (hero)" });

  // Retry the failed clip.
  const failed = pg.locator('.bd-pg-card[data-job-id="8"]');
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => rec.retried).toEqual([8]);

  // A location target needs the location select.
  await done.locator(".bd-pg-attached .bd-btn.is-icon").click();
  await done.getByRole("button", { name: "Add to project" }).click();
  await done.locator(".bd-pg-attach").getByLabel("Project").selectOption("1");
  await done.locator(".bd-pg-attach").getByLabel("Add as").selectOption("location");
  await done.locator(".bd-pg-attach").getByLabel("Location").selectOption({ label: "Rooftop, night" });
  await done.locator(".bd-pg-attach").getByRole("button", { name: "Add" }).click();
  await expect.poll(() => rec.attach.length).toBe(2);
  expect(rec.attach[1]).toEqual({ path: DONE_PATH, project_id: 1, target: "location", location_id: 1 });
});
