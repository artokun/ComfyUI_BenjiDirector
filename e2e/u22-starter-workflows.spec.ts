import { expect, test, type Page } from "@playwright/test";
import { drive, shot, waitForDemo } from "./helpers.js";

// Installing the workflow the Director ships, and the one thing that has to be true about it:
// its model names are resolved against the ComfyUI it will actually run on. The names below
// are real — `Krea-2-Turbo.safetensors` is what Calliope's own example asks for and no box has.

const CORS = { "access-control-allow-origin": "*" };

/** ComfyUI's `/object_info`, cut down to the loaders a starter touches. */
const OBJECT_INFO = {
  UNETLoader: { input: { required: { unet_name: [["krea2_turbo_fp8_scaled.safetensors", "flux1-dev-fp8.safetensors"], {}], weight_dtype: [["default"], {}] } } },
  CLIPLoader: { input: { required: { clip_name: [["qwen3vl_4b_fp8_scaled.safetensors"], {}], type: [["krea2"], {}] } } },
  VAELoader: { input: { required: { vae_name: [["qwen_image_vae.safetensors"], {}] } } },
  KSampler: { input: { required: { seed: ["INT", {}], sampler_name: [["res_multistep", "euler"], {}], scheduler: [["beta", "simple"], {}] } } },
};

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

async function mockAll(page: Page, opts: { objectInfo?: unknown; workflows?: unknown[] } = {}) {
  const calls: Recorded[] = [];
  const workflows: Record<string, unknown>[] = [...((opts.workflows ?? []) as Record<string, unknown>[])];
  let nextId = 1;

  await page.route("**/object_info", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(opts.objectInfo ?? OBJECT_INFO) }),
  );

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    calls.push({ method, path, body });
    const json = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(data) });

    if (method === "GET" && path === "/api/health") return json({ status: "ok", version: "1.3.2", dry_run: false });
    if (method === "GET" && path === "/api/projects") return json([{ id: 1, title: "The Approach", status: "draft" }]);
    if (path === "/api/projects/1" && method === "GET") return json({ id: 1, title: "The Approach", status: "draft" });
    if (path === "/api/projects/1/story") return json({ project: { id: 1, title: "The Approach" }, beats: [], characters: [{ id: 1, name: "Nadia" }], locations: [], items: [] });
    if (path === "/api/projects/1/scenes") return json({ scenes: [], estimated_duration_sec: 0 });
    if (path === "/api/projects/1/assets") return json({ characters: [{ id: 1, name: "Nadia" }], locations: [], items: [] });
    if (path === "/api/workflows" && method === "GET") return json(workflows);
    if (path === "/api/workflows/analyze") {
      // What Calliope really reports for the starter: five roles in, one image out.
      return json({
        inputs: [
          { nodeId: "1", label: "Prompt", role: "prompt", kind: "textarea", required: true },
          { nodeId: "2", label: "Negative prompt", role: "negative", kind: "textarea", required: true },
          { nodeId: "3", label: "Width", role: "width", kind: "number", required: true },
          { nodeId: "4", label: "Height", role: "height", kind: "number", required: true },
          { nodeId: "5", label: "Seed", role: "seed", kind: "number", required: true },
        ],
        outputs: [{ nodeId: "25", label: "Image", role: "image", kind: "image" }],
      });
    }
    if (path === "/api/workflows" && method === "POST") {
      const b = (body ?? {}) as Record<string, unknown>;
      const row = {
        id: nextId++,
        name: b.name,
        kind: b.kind ?? "image",
        is_enabled: true,
        prompt_profile: "prose",
        description: b.description ?? null,
        workflow_json: b.workflow_json,
        // `defaultValue` is what Calliope's analyze really returns, and what the form seeds
        // from — without it this mock would not reproduce the bug the last assertion pins.
        input_schema: [
          { nodeId: "1", label: "Prompt", role: "prompt", kind: "textarea", required: true, defaultValue: "studio reference sheet, neutral grey background" },
          { nodeId: "3", label: "Width", role: "width", kind: "number", required: true, defaultValue: 1024 },
          { nodeId: "5", label: "Seed", role: "seed", kind: "number", required: true, defaultValue: 0 },
        ],
        output_schema: [{ nodeId: "25", label: "Image", role: "image", kind: "image" }],
      };
      workflows.push(row);
      return json(row);
    }
    if (path === "/api/projects/1/generate-assets") return json({ ok: true, jobs: [] });
    if (path === "/api/jobs" || path === "/api/jobs/queue-status") return json([]);
    return json({});
  });

  return { calls, workflows, bodiesFor: (m: string, p: string) => calls.filter((c) => c.method === m && c.path === p).map((c) => c.body) };
}

const openAssets = async (page: Page) => {
  await drive(page, "project_open", { project_id: 1 });
  await page.locator('.bd-tabs [role="tab"]', { hasText: "Assets" }).click();
  await expect(page.locator('[data-panel="assets"]')).toBeVisible();
};

test("with no workflow the panel offers to install the one it ships, and does", async ({ page }) => {
  const mock = await mockAll(page);
  await waitForDemo(page);
  await openAssets(page);

  await expect(page.locator("[data-starter-prompt]")).toBeVisible();
  await expect(page.locator("[data-starter-prompt]")).toContainText("stock ComfyUI nodes");
  await page.locator("[data-install-starters]").click();

  await expect(page.locator("[data-install-note]")).toContainText("registered");
  const created = mock.bodiesFor("POST", "/api/workflows") as { name: string; kind: string; workflow_json: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> }[];
  expect(created).toHaveLength(1);
  expect(created[0]?.kind).toBe("image");

  // The load-bearing part: the graph that was REGISTERED names a model this ComfyUI has. The
  // shipped name is resolved against `/object_info`, so a starter cannot be registered with a
  // filename that only existed on the machine it was authored on.
  const graph = created[0]!.workflow_json;
  const unet = Object.values(graph).find((n) => n.class_type === "UNETLoader");
  expect(unet?.inputs?.unet_name).toBe("krea2_turbo_fp8_scaled.safetensors");
  const clip = Object.values(graph).find((n) => n.class_type === "CLIPLoader");
  expect(clip?.inputs?.clip_name).toBe("qwen3vl_4b_fp8_scaled.safetensors");
  // Calliope reads its inputs from node TITLES, so those have to survive the round trip.
  expect(Object.values(graph).some((n) => (n as { _meta?: { title?: string } })._meta?.title?.includes("(Input:prompt)"))).toBe(true);
  expect(Object.values(graph).some((n) => (n as { _meta?: { title?: string } })._meta?.title?.includes("(Output:image)"))).toBe(true);

  // …and once it is registered the prompt goes, the picker fills, and generating is possible.
  await expect(page.locator("[data-starter-prompt]")).toHaveCount(0);
  await expect(page.locator('[data-workflow-select="character"]')).toHaveValue("1");
  await shot(page, "u22-starter-installed");
});

test("generating does NOT send the workflow's own prompt, which would give every card the same picture", async ({ page }) => {
  const mock = await mockAll(page);
  await waitForDemo(page);
  await openAssets(page);
  await page.locator("[data-install-starters]").click();
  await expect(page.locator('[data-workflow-select="character"]')).toHaveValue("1");

  await page.getByRole("button", { name: "Generate all missing" }).click();
  await expect.poll(() => mock.bodiesFor("POST", "/api/projects/1/generate-assets").length).toBeGreaterThan(0);

  // The form seeds every input's default so its widgets have something to show, and it HIDES
  // the prompt because the card writes it. Sending that seeded default puts the workflow's own
  // prompt in `input_values`, which outranks the one Calliope derives per asset — measured on
  // the rig, a character and a location then rendered the same file.
  for (const body of mock.bodiesFor("POST", "/api/projects/1/generate-assets") as { input_values?: Record<string, unknown> }[]) {
    expect(Object.keys(body.input_values ?? {})).not.toContain("1");
  }
});

test("a model this ComfyUI does not have is reported, not registered with a name that will fail", async ({ page }) => {
  // The same box, minus the diffusion model the starter asks for.
  const withoutKrea = { ...OBJECT_INFO, UNETLoader: { input: { required: { unet_name: [["flux1-dev-fp8.safetensors"], {}], weight_dtype: [["default"], {}] } } } };
  const mock = await mockAll(page, { objectInfo: withoutKrea });
  await waitForDemo(page);
  await openAssets(page);
  await page.locator("[data-install-starters]").click();

  await expect(page.locator("[data-install-note]")).toContainText("this ComfyUI has no");
  await expect(page.locator("[data-install-note]")).toContainText("krea2_turbo_fp8_scaled.safetensors");
  expect(mock.bodiesFor("POST", "/api/workflows")).toHaveLength(0);
  // The prompt stays, because nothing was installed and saying otherwise would be a lie.
  await expect(page.locator("[data-starter-prompt]")).toBeVisible();
});

test("the agent installs and reports through the same path the button uses", async ({ page }) => {
  const mock = await mockAll(page);
  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });

  const before = await drive<{ image_ready: boolean; starters: { registered: boolean; missing_models: string[] | null }[] }>(page, "workflows_status");
  expect(before.image_ready).toBe(false);
  expect(before.starters[0]?.registered).toBe(false);
  expect(before.starters[0]?.missing_models).toEqual([]);

  const res = await drive<{ ready: boolean; summary: string; installed: { registered: boolean; substitutions: { from: string; to: string }[] }[] }>(page, "install_workflows");
  expect(res.ready).toBe(true);
  expect(res.installed[0]?.registered).toBe(true);
  expect(mock.bodiesFor("POST", "/api/workflows")).toHaveLength(1);

  // A second run is a no-op rather than a duplicate row.
  const again = await drive<{ installed: { skipped: boolean }[] }>(page, "install_workflows");
  expect(again.installed[0]?.skipped).toBe(true);
  expect(mock.bodiesFor("POST", "/api/workflows")).toHaveLength(1);

  const after = await drive<{ image_ready: boolean }>(page, "workflows_status");
  expect(after.image_ready).toBe(true);
});

test("a box that names the model differently gets the workflow anyway, and is told what was swapped", async ({ page }) => {
  // Same model, the naming a different build uses. Nobody should have to notice.
  const renamed = { ...OBJECT_INFO, UNETLoader: { input: { required: { unet_name: [["krea2-turbo-fp8-scaled-v2.safetensors"], {}], weight_dtype: [["default"], {}] } } } };
  const mock = await mockAll(page, { objectInfo: renamed });
  await waitForDemo(page);
  await drive(page, "project_open", { project_id: 1 });

  const res = await drive<{ ready: boolean; installed: { registered: boolean; substitutions: { from: string; to: string }[] }[] }>(page, "install_workflows");
  expect(res.installed[0]?.registered).toBe(true);
  expect(res.installed[0]?.substitutions).toContainEqual({ from: "krea2_turbo_fp8_scaled.safetensors", to: "krea2-turbo-fp8-scaled-v2.safetensors" });
  const created = mock.bodiesFor("POST", "/api/workflows") as { workflow_json: Record<string, { class_type?: string; inputs?: Record<string, unknown> }> }[];
  expect(Object.values(created[0]!.workflow_json).find((n) => n.class_type === "UNETLoader")?.inputs?.unet_name).toBe("krea2-turbo-fp8-scaled-v2.safetensors");
});
