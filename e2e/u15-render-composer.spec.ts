import { expect, test, type Route } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// The Render tab, driven through the real DOM against a mocked Calliope. Two things this
// spec exists to pin, because both are silent when they break:
//
//   * the autosave MERGES into `video_settings` — the PATCH it sends must still carry the
//     canvas position under `director` and the agent's `prompt_draft`, not just the form; and
//   * Generate goes through the prompt review gate and enqueues ONE scene with an explicit
//     `prompts` entry, so Calliope's own model never runs for it.

const project = { id: 1, title: "The Approach", idea: null, genre: "thriller", tone: "quiet, tense", target_duration: "2 min", cover_path: null, status: "draft", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };

const story = {
  project,
  beats: [
    { id: 1, order_index: 0, title: "Beat 1 — The approach", description: null },
    { id: 2, order_index: 1, title: "Beat 2 — The call", description: null },
  ],
  characters: [{ id: 1, name: "Nadia", role: null, age: null, appearance: null, personality: null, portrait_path: null, sheet_path: "/assets/nadia-sheet.png", consistency_prompt: "same woman" }],
  locations: [{ id: 1, name: "Rooftop, night", description: null, reference_image_path: "/assets/rooftop.png", consistency_prompt: null }],
  items: [],
};

/** The canvas position and the agent's prompt draft: what an autosave must not drop. */
const DIRECTOR = { position: { x: 40, y: 220 }, promoted: true };
const DRAFT = { prompt_draft: "Nadia steps to the ledge.", prompt_draft_meta: { based_on: "abcdef0123456789", authored_by: "benjidirector" } };

const scene = (id: number, order_index: number, beat_id: number, extra: Record<string, unknown> = {}) => ({
  id,
  project_id: 1,
  beat_id,
  order_index,
  heading: `SC-0${id} — INT. ROOFTOP`,
  action: "She waits for the door to open.",
  dialog: "NADIA\nNot yet.",
  duration_sec: 5,
  workflow_id: null,
  env_image_path: null,
  location_id: 1,
  video_path: null,
  chain_from_prev: 0,
  character_ids: [1],
  characters: [{ id: 1, name: "Nadia", role: null, portrait_path: null, sheet_path: "/assets/nadia-sheet.png" }],
  video_settings: null as Record<string, unknown> | null,
  ...extra,
});

const scenes = [
  scene(1, 0, 1, { video_path: "/out/sc1.mp4" }),
  scene(2, 1, 1, { chain_from_prev: 1, video_settings: { director: DIRECTOR, ...DRAFT } }),
  scene(3, 2, 2, { chain_from_prev: 1 }),
];

const workflow = {
  id: 7,
  name: "MiniMax H3 · video",
  kind: "video",
  is_enabled: true,
  prompt_profile: "prose",
  description: null,
  input_schema: [
    { nodeId: "10", label: "Prompt", role: "prompt", kind: "textarea", required: true },
    { nodeId: "11", label: "Negative", role: "negative", kind: "textarea", required: false },
    { nodeId: "12", label: "Width", role: "width", kind: "number", defaultValue: 1280, required: false },
    { nodeId: "13", label: "Height", role: "height", kind: "number", defaultValue: 720, required: false },
    { nodeId: "14", label: "Duration", role: "duration", kind: "number", defaultValue: 5, required: false },
    { nodeId: "15", label: "Seed", role: "seed", kind: "number", defaultValue: 0, required: false },
    { nodeId: "16", label: "Character sheet", role: "character", kind: "image", required: false },
    { nodeId: "18", label: "Continue from", role: "video", kind: "video", required: false },
    { nodeId: "20", label: "Steps", role: "steps", kind: "number", defaultValue: 20, required: false },
  ],
  output_schema: [{ nodeId: "30", label: "Video", role: "video", kind: "video" }],
};

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("the Render tab renders a scene, autosaves a MERGED video_settings, and generates through the prompt gate", async ({ page }) => {
  const patches: Array<Record<string, unknown>> = [];
  const generates: Array<Record<string, unknown>> = [];

  await page.route("**/api/**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/api/health") return json({ status: "ok", version: "1.2.1", dry_run: false });
    if (path === "/api/projects") return json([project]);
    if (path === "/api/projects/1") return json(project);
    if (path === "/api/projects/1/story") return json(story);
    if (path === "/api/projects/1/scenes") return json({ scenes, estimated_duration_sec: 15 });
    if (path === "/api/workflows") return json([workflow]);
    if (path === "/api/jobs") return json([]);
    if (path === "/api/jobs/queue-status") return json({ paused: false });
    if (path === "/api/playground/uploads") return json([]);
    if (path === "/api/file") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    if (path === "/api/jobs/projects/1/preview-prompt") {
      return json({ prompt: "Rooftop at night. Nadia steps to the ledge; the city hums below.", profile: "prose", from_draft: false, based_on: "abcdef0123456789" });
    }
    if (path === "/api/jobs/projects/1/generate-videos") {
      generates.push(JSON.parse(req.postData() ?? "{}"));
      return json({ ok: true, jobs: [] });
    }
    const patched = /^\/api\/projects\/1\/scenes\/(\d+)$/.exec(path);
    if (patched && req.method() === "PATCH") {
      const id = Number(patched[1]);
      const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
      const row = scenes.find((s) => s.id === id);
      if (id === 2) patches.push(body);
      // Calliope echoes the row it stored; the composer trusts the echo over what it sent.
      if (row && body.video_settings !== undefined) row.video_settings = body.video_settings as Record<string, unknown>;
      return json({ ...(row ?? {}), ...body });
    }
    return json({});
  });

  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });

  // ── open the tab and land on scene 2 ──
  await page.getByRole("tab", { name: /Render/ }).click();
  await expect(page.locator(".bd-rc-head")).toContainText("1/3 clips done");
  await expect(page.locator(".bd-rc-head")).toContainText("0:15 total");
  await page.locator("#bd-rc-clip-2").click();
  await expect(page.locator(".bd-rc-slate-head")).toContainText("SC-02");
  // Scene 2 continues from the previous clip and this workflow HAS a video input, so the
  // source pill is offered rather than the "no video input" refusal.
  await expect(page.getByRole("button", { name: /Auto \(previous clip\)/ })).toBeVisible();
  await expect(page.locator(".bd-rc-warn")).toHaveCount(0);

  // ── type a prompt, step the duration; the autosave debounces and merges ──
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("A slow push-in as Nadia reaches the ledge.");
  await page.getByRole("button", { name: "Increase Duration" }).click();
  await expect(page.getByLabel("Duration", { exact: true })).toHaveValue("6");

  await expect.poll(() => patches.length, { timeout: 8000 }).toBeGreaterThan(0);
  const saved = patches[patches.length - 1]!.video_settings as Record<string, unknown>;
  expect(saved.director, "the canvas position survives a composer autosave").toEqual(DIRECTOR);
  expect(saved.prompt_draft, "the agent's prompt draft survives too").toBe(DRAFT.prompt_draft);
  expect(saved.prompt_draft_meta).toEqual(DRAFT.prompt_draft_meta);
  const values = saved.input_values as Record<string, unknown>;
  expect(values["10"]).toBe("A slow push-in as Nadia reaches the ledge.");
  expect(values["14"]).toBe(6);
  expect(values["12"], "workflow defaults ride along").toBe(1280);

  await shot(page, "u15-render-composer");

  // ── Generate goes through the review gate ──
  await page.getByRole("button", { name: "Generate clip" }).click();
  const modal = page.locator(".bd-rc-preview");
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel("Prompt text sent to the workflow")).toHaveValue(/Rooftop at night/);
  await shot(page, "u15-render-composer-preview");
  await modal.getByRole("button", { name: "Generate", exact: true }).click();

  await expect.poll(() => generates.length, { timeout: 8000 }).toBe(1);
  const body = generates[0]!;
  expect(body.scene_ids).toEqual([2]);
  expect(body.workflow_id).toBe(7);
  expect((body.prompts as Record<string, string>)["2"]).toContain("Rooftop at night");
  expect((body.input_values as Record<string, unknown>)["10"]).toBe("A slow push-in as Nadia reaches the ledge.");
});

test("render_scene selects the scene, and the composer refuses a chained scene without a video input", async ({ page }) => {
  await page.route("**/api/**", async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/health") return json({ status: "ok", version: "1.2.1" });
    if (path === "/api/projects") return json([project]);
    if (path === "/api/projects/1/story") return json(story);
    if (path === "/api/projects/1/scenes") return json({ scenes, estimated_duration_sec: 15 });
    // Same workflow WITHOUT the (Input:video) node — the case Calliope 400s on.
    if (path === "/api/workflows") return json([{ ...workflow, input_schema: workflow.input_schema.filter((i) => i.role !== "video") }]);
    if (path === "/api/jobs") return json([]);
    if (path === "/api/jobs/queue-status") return json({ paused: true });
    if (path === "/api/playground/uploads") return json([]);
    if (path === "/api/file") return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    return json({});
  });

  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });

  const result = await drive<{ scene_id: number; panel: string }>(page, "render_scene", { scene_id: 3 });
  expect(result).toEqual({ scene_id: 3, panel: "render" });
  await expect(page.locator(".bd-note")).toContainText("open the Render tab");

  await page.getByRole("tab", { name: /Render/ }).click();
  await expect(page.locator(".bd-rc-slate-head")).toContainText("SC-03");
  await expect(page.locator(".bd-rc-dock .bd-rc-warn")).toContainText("no video input");
  // The button stays, disabled and explaining itself — a vanished control reads as a bug.
  await expect(page.getByRole("button", { name: "Generate clip" })).toBeDisabled();
  await expect(page.locator(".bd-rc-banner")).toContainText("Queue paused");

  await expect(drive(page, "render_scene", { scene_id: 404 })).rejects.toThrow(/no scene 404/);
});
