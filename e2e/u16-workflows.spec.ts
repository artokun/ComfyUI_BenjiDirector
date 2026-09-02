import { expect, test, type Page, type Route } from "@playwright/test";
import { shot, waitForDemo } from "./helpers.js";

// U16 — the Workflows tab against a mocked Calliope: library of two, paste an API-format JSON,
// see the LOCAL role preview before any round trip, Analyze (Calliope's answer replaces it),
// Register (assert the POST body), disable one (PATCH), delete one (confirm, DELETE).

type Row = Record<string, unknown> & { id: number; name: string; kind: string; is_enabled: boolean };

const row = (id: number, name: string, kind: "image" | "video", extra: Record<string, unknown> = {}): Row => ({
  id,
  name,
  kind,
  is_enabled: true,
  prompt_profile: "prose",
  description: null,
  input_schema: [{ nodeId: "6", label: "Prompt", role: "prompt", kind: "textarea", required: true }],
  output_schema: [{ nodeId: "8", label: "Out", role: kind, kind }],
  created_at: "2026-09-01T00:00:00Z",
  ...extra,
});

/** The JSON a test pastes: one `(Input:prompt)` titled node, one `(Output:image)`, one untagged. */
const PASTED = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux.safetensors" }, _meta: { title: "Load Checkpoint" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat on a roof", clip: ["4", 1] }, _meta: { title: "Positive Prompt (Input:prompt)" } },
  "8": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "out" }, _meta: { title: "Save (Output:image)" } },
};

/** What the mocked analyzer answers — deliberately MORE than the local preview finds (a Seed), so the swap is observable. */
const ANALYSIS = {
  inputs: [
    { nodeId: "6", label: "Positive Prompt", role: "prompt", kind: "textarea", defaultValue: "a cat on a roof", required: true },
    { nodeId: "9", label: "Seed", role: "seed", kind: "number", required: true },
  ],
  outputs: [{ nodeId: "8", label: "Save", role: "image", kind: "image" }],
  suggested_profile: "minimax_h3_ref",
};

async function mockCalliope(page: Page) {
  const db: Row[] = [
    row(2, "LTX Ref-to-Video", "video", { prompt_profile: "minimax_h3_ref", description: "Reference-to-video with the H3 six-section prompt." }),
    row(1, "Flux Keyframe", "image", { description: "Still keyframes from a prompt and a character sheet." }),
  ];
  const calls = { create: [] as unknown[], patch: [] as { id: number; body: unknown }[], deleted: [] as number[], analyze: [] as unknown[] };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "content-type" };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/health") return json(route, { status: "ok", version: "1.2.1", dry_run: false });
    if (path === "/api/projects") return json(route, []);
    if (path === "/api/workflows/analyze" && method === "POST") {
      calls.analyze.push(req.postDataJSON());
      return json(route, ANALYSIS);
    }
    if (path === "/api/workflows" && method === "GET") return json(route, db);
    if (path === "/api/workflows" && method === "POST") {
      const body = req.postDataJSON() as { name: string; kind: "image" | "video"; description?: string; prompt_profile?: string };
      calls.create.push(body);
      const created = row(3, body.name, body.kind, { description: body.description ?? null, prompt_profile: body.prompt_profile ?? "prose", input_schema: ANALYSIS.inputs, output_schema: ANALYSIS.outputs });
      db.unshift(created);
      return json(route, created);
    }
    const m = /^\/api\/workflows\/(\d+)$/.exec(path);
    if (m) {
      const id = Number(m[1]);
      const target = db.find((r) => r.id === id);
      if (!target) return json(route, { detail: "Workflow not found" }, 404);
      if (method === "PATCH") {
        const body = req.postDataJSON() as Record<string, unknown>;
        calls.patch.push({ id, body });
        Object.assign(target, body);
        return json(route, target);
      }
      if (method === "DELETE") {
        calls.deleted.push(id);
        db.splice(db.indexOf(target), 1);
        return json(route, { ok: true });
      }
      if (method === "GET") return json(route, target);
    }
    return json(route, { detail: `unmocked ${method} ${path}` }, 404);
  });
  return { db, calls };
}

test("Workflows tab: library, local preview, analyze, register, disable, delete", async ({ page }) => {
  const { calls } = await mockCalliope(page);
  await waitForDemo(page);

  await page.getByRole("tab", { name: /Workflows/ }).click();
  const panel = page.locator('[data-u16="panel"]');
  await expect(panel).toBeVisible();

  // ── library from the mock ──
  await expect(panel.locator("[data-u16-card]")).toHaveCount(2);
  await expect(panel.locator('[data-u16="stats"]')).toContainText("2 saved");
  await expect(panel.locator('[data-u16="stats"]')).toContainText("1 image");
  await expect(panel.locator('[data-u16="stats"]')).toContainText("1 video");
  const ltx = panel.locator('[data-u16-card="2"]');
  await expect(ltx).toContainText("LTX Ref-to-Video");
  await expect(ltx).toContainText("H3-ref");
  await expect(ltx).toContainText("1 input / 1 output");
  await expect(ltx.locator(".u16-tile")).toHaveText("VID");
  await expect(panel.locator('[data-u16-card="1"] .u16-tile')).toHaveText("IMG");

  // ── paste: the local preview appears before any network call ──
  await panel.locator('[data-u16="json"]').fill(JSON.stringify(PASTED, null, 2));
  const shape = panel.locator('[data-u16="shape"]');
  await expect(shape).toContainText("Looks like API format");
  await expect(shape).toContainText("3 nodes");
  await expect(shape).toContainText("1 input");
  await expect(shape).toContainText("1 output");
  const localRow = panel.locator('[data-u16="inputs"] tr[data-u16-role="prompt"]');
  await expect(localRow).toContainText("Positive Prompt");
  await expect(localRow).toContainText("#6");
  await expect(panel.locator('[data-u16="outputs"] tr[data-u16-role="image"]')).toContainText("Save");
  expect(calls.analyze).toHaveLength(0);
  await expect(panel.locator('[data-u16="profile"]')).toHaveValue("prose");
  await expect(panel.locator('[data-u16="register"]')).toBeDisabled();

  // ── a UI-format export is refused with the fix named ──
  await panel.locator('[data-u16="json"]').fill(JSON.stringify({ last_node_id: 3, nodes: [{ id: 1, type: "KSampler" }], links: [], version: 0.4 }));
  await expect(shape).toContainText("Save (API Format)");
  await expect(panel.locator('[data-u16="analyze"]')).toBeDisabled();
  await panel.locator('[data-u16="json"]').fill(JSON.stringify(PASTED, null, 2));

  // ── Analyze: Calliope's answer replaces the preview, and pre-sets the prompt format ──
  await panel.locator('[data-u16="analyze"]').click();
  await expect(shape).toContainText("Analyzed by Calliope");
  await expect(panel.locator('[data-u16="inputs"] tr[data-u16-role="seed"]')).toContainText("Seed");
  await expect(panel.locator('[data-u16="profile"]')).toHaveValue("minimax_h3_ref");
  expect(calls.analyze).toHaveLength(1);
  expect((calls.analyze[0] as { workflow_json: unknown }).workflow_json).toEqual(PASTED);

  // ── Register ──
  await panel.locator('[data-u16="name"]').fill("Cat Keyframe");
  await panel.locator('[data-u16="kind"]').selectOption("image");
  await panel.locator('[data-u16="description"]').fill("Flux still from a prompt.");
  await expect(panel.locator('[data-u16="register"]')).toBeEnabled();
  await panel.locator('[data-u16="register"]').click();
  await expect.poll(() => calls.create.length).toBe(1);
  expect(calls.create[0]).toEqual({
    name: "Cat Keyframe",
    kind: "image",
    workflow_json: PASTED,
    description: "Flux still from a prompt.",
    prompt_profile: "minimax_h3_ref",
  });
  await expect(panel.locator("[data-u16-card]")).toHaveCount(3);
  await expect(panel.locator('[data-u16="stats"]')).toContainText("3 saved");
  await expect(panel.locator('[data-u16="stats"]')).toContainText("2 image");
  await expect(panel.locator('[data-u16-card="3"]')).toContainText("Cat Keyframe");
  await expect(panel.locator('[data-u16-card="3"]')).toContainText("2 inputs / 1 output");
  // The register card resets after a save.
  await expect(panel.locator('[data-u16="json"]')).toHaveValue("");
  await expect(page.locator(".bd-note")).toContainText("saved to library");

  // The tab scrolls as the form is driven; pin it to the top so the shot shows the header.
  await page.locator(".bd-panel-host").evaluate((el) => el.scrollTo(0, 0));
  await shot(page, "u16-workflows");

  // ── View I/O sheet ──
  await panel.locator('[data-u16-card="3"] [data-u16-action="view"]').click();
  const view = page.locator('[data-u16-sheet="view"]');
  await expect(view).toBeVisible();
  await expect(view).toContainText("Positive Prompt");
  await expect(view).toContainText("Seed");
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);

  // ── Edit sheet: name / description / prompt format, JSON locked ──
  await panel.locator('[data-u16-card="3"] [data-u16-action="edit"]').click();
  const edit = page.locator('[data-u16-sheet="edit"]');
  await expect(edit).toBeVisible();
  await expect(edit).toContainText("Workflow JSON is locked after registration");
  await edit.locator('[data-u16="edit-name"]').fill("Cat Keyframe v2");
  await edit.locator('[data-u16="edit-profile"]').selectOption("prose");
  await edit.locator('[data-u16="edit-save"]').click();
  await expect.poll(() => calls.patch.length).toBe(1);
  expect(calls.patch[0]).toEqual({ id: 3, body: { name: "Cat Keyframe v2", description: "Flux still from a prompt.", prompt_profile: "prose" } });
  await expect(edit).toHaveCount(0);
  await expect(panel.locator('[data-u16-card="3"]')).toContainText("Cat Keyframe v2");
  await expect(panel.locator('[data-u16-card="3"] .u16-badge.is-h3')).toHaveCount(0);

  // ── Disable ──
  await panel.locator('[data-u16-card="1"] [data-u16-action="toggle"]').click();
  await expect.poll(() => calls.patch.length).toBe(2);
  expect(calls.patch[1]).toEqual({ id: 1, body: { is_enabled: false } });
  await expect(panel.locator('[data-u16-card="1"] [data-u16="disabled"]')).toHaveText("Disabled");
  await expect(panel.locator('[data-u16-card="1"] [data-u16-action="toggle"]')).toContainText("Enable");

  // ── Delete: confirm modal, then DELETE ──
  await panel.locator('[data-u16-card="2"] [data-u16-action="delete"]').click();
  const confirm = page.locator(".bd-modal");
  await expect(confirm).toContainText("Delete workflow?");
  await expect(confirm).toContainText("LTX Ref-to-Video");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  expect(calls.deleted).toHaveLength(0);
  await expect(panel.locator("[data-u16-card]")).toHaveCount(3);
  await panel.locator('[data-u16-card="2"] [data-u16-action="delete"]').click();
  await page.locator(".bd-modal").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => calls.deleted).toEqual([2]);
  await expect(panel.locator("[data-u16-card]")).toHaveCount(2);
  await expect(panel.locator('[data-u16-card="2"]')).toHaveCount(0);
  await expect(panel.locator('[data-u16="stats"]')).toContainText("0 video");

  await shot(page, "u16-workflows-after");
});

test("Workflows tab says so when Calliope is down, and the hint block names the contract", async ({ page }) => {
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await waitForDemo(page);
  await page.getByRole("tab", { name: /Workflows/ }).click();
  const panel = page.locator('[data-u16="panel"]');
  await expect(panel).toContainText("Calliope is not answering");
  await expect(panel).toContainText("Display Name (Input:role)");
  // The hint DESCRIBES the capability; it does not print a tool name. The panel's vocabulary
  // gate scans the vendored bundle and only knows PUBLISHED names.
  await expect(panel).toContainText("register the canvas workflow");
  await expect(panel).not.toContainText("panel_director");
  for (const role of ["prompt", "negative", "character", "location", "image", "video", "audio", "seed", "width", "height", "duration"]) {
    await expect(panel.locator(".u16-role-row b", { hasText: new RegExp(`^${role}`) })).toHaveCount(1);
  }
  await expect(panel.locator(".u16-role-row", { hasText: "character" })).toContainText("aka char, portrait, sheet, face, ref");
});
